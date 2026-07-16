//! Runs the provisioned engine: a free loopback port, then ComfyUI on it.
//!
//! Where `engine::` stops at "an interpreter exists that can import torch", this
//! is the next step — turning that interpreter into a running server the
//! frontend can talk to directly (ADR-008).
//!
//! Two things here are load-bearing and easy to get subtly wrong:
//!
//! - **The port is ours, not 8188.** Our users are precisely the population
//!   most likely to already run their own ComfyUI on the default port (ADR-007),
//!   so we bind `127.0.0.1:0`, let the OS hand us a free port, drop the listener,
//!   and pass that port on. Theoretically racy — the window between drop and
//!   ComfyUI's own bind — and fine in practice.
//! - **Loopback only.** `--listen 127.0.0.1`, never `0.0.0.0`. This is a local
//!   generation engine with no auth in front of it; binding a public interface
//!   would put an unauthenticated `/prompt` on the network.
//!
//! Spawn ([`spawn`]), health polling ([`wait_until_healthy`]), and the log pump
//! ([`pump`]) all build on the [`Engine`] handle; teardown (#9) is still to come.

use std::fs::{File, OpenOptions};
use std::io::Write;
use std::net::{Ipv4Addr, TcpListener};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::async_runtime::Receiver;
use tauri::{AppHandle, Emitter, Runtime};
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

use crate::paths::Paths;

/// The one interface we ever bind. Passed to `--listen` and used to reserve the
/// port; anything else would be a mistake, so it lives in one place.
const LOOPBACK: &str = "127.0.0.1";

/// The route ComfyUI serves once its HTTP server is up. Any response here is
/// proof of life; the frontend re-reads it for VRAM (ADR-008, §6.2).
const HEALTH_PATH: &str = "/system_stats";

/// How often to re-probe while the engine is starting.
const POLL_INTERVAL: Duration = Duration::from_millis(500);

/// The whole startup budget. ComfyUI's first boot imports torch and every
/// custom node, which is slow; 120s is generous for that yet short enough that a
/// genuinely dead engine surfaces as an error rather than an app that hangs
/// forever (§6.2).
const STARTUP_TIMEOUT: Duration = Duration::from_secs(120);

/// The Tauri event each captured log line is emitted on, so a running UI can
/// show the engine's output live. Mirrored by `app/lib/engine.ts`.
pub const LOG_EVENT: &str = "engine://log";

/// Roll the engine log once appending the next line would push it past this.
/// Five megabytes is hundreds of thousands of lines — well beyond one boot's
/// chatter, yet small enough to open instantly in whatever handles a `.log`.
const LOG_MAX_BYTES: u64 = 5 * 1024 * 1024;

/// How many rolled backups to keep beside the live file. Three of them plus the
/// live one spans several runs of history without letting a chatty engine grow
/// the logs directory without bound.
const LOG_KEEP: usize = 3;

#[derive(Debug, thiserror::Error)]
pub enum SpawnError {
    #[error(
        "could not reserve a local port for the engine: {0}\n  \
         Something is preventing loopback connections — a firewall or VPN filter \
         is the usual cause."
    )]
    Port(#[source] std::io::Error),

    #[error(
        "could not start the engine process: {source}\n  \
         The venv's Python is missing or was not permitted to execute; \
         reinstalling the engine should fix it."
    )]
    Spawn {
        #[source]
        source: tauri_plugin_shell::Error,
    },
}

#[derive(Debug, thiserror::Error)]
pub enum HealthError {
    #[error("could not initialise the HTTP client used to probe the engine: {0}")]
    Client(#[source] reqwest::Error),

    #[error(
        "the engine started but never answered on {LOOPBACK}:{port} within {}s.\n  \
         It is running yet not ready — check the engine log for a Python \
         traceback; a failing node import is the usual cause.",
        STARTUP_TIMEOUT.as_secs()
    )]
    Timeout { port: u16 },
}

/// A running engine and the port it was told to serve on.
///
/// Ownership of the process lives here from spawn until teardown, and each half
/// of the lifecycle takes one piece: [`wait_until_healthy`] polls
/// [`port`](Self::port) until the server answers, [`pump`] drains
/// [`events`](Self::events) into the log, and #9 calls [`CommandChild::kill`] on
/// [`child`](Self::child).
pub struct Engine {
    /// The loopback port ComfyUI was told to bind. The frontend builds its
    /// engine URL from this (ADR-008).
    pub port: u16,

    /// The live process. `kill` consumes it, which is why teardown moves it out
    /// of the handle rather than borrowing.
    pub child: CommandChild,

    /// Line-buffered stdout/stderr from the engine.
    ///
    /// **Must be drained.** The plugin's channel is bounded, so an undrained
    /// receiver back-pressures the OS pipe and ComfyUI blocks on its next write
    /// — a hang with no error. [`pump`] is the drain: hand it this receiver and
    /// it runs until the process closes the channel.
    pub events: Receiver<CommandEvent>,
}

/// Reserves a free loopback port and starts ComfyUI on it.
///
/// Returns as soon as the process is spawned — it does *not* wait for the server
/// to answer. A ComfyUI that fails to import a node exits seconds later, and
/// distinguishing "starting" from "up" is #7's job via [`Engine::port`].
pub fn spawn<R: Runtime>(app: &AppHandle<R>, paths: &Paths) -> Result<Engine, SpawnError> {
    let port = free_port().map_err(SpawnError::Port)?;

    let (events, child) = app
        .shell()
        .command(paths.python())
        // ComfyUI resolves its base directory from the script's own location, so
        // this is belt-and-suspenders — but a relative path elsewhere in its
        // startup shouldn't depend on wherever the app was launched from.
        .current_dir(paths.comfy())
        // Python block-buffers stdout when it's a pipe rather than a tty, so
        // without this a traceback sits in the buffer until the process dies and
        // the log pump (#8) shows nothing while the engine is starting.
        .env("PYTHONUNBUFFERED", "1")
        .args(engine_args(&paths.comfy_main(), port))
        .spawn()
        .map_err(|source| SpawnError::Spawn { source })?;

    Ok(Engine {
        port,
        child,
        events,
    })
}

/// Waits until the engine on `port` answers, or gives up after [`STARTUP_TIMEOUT`].
///
/// [`spawn`] returns the instant the process exists; this is the other half —
/// the caller turns a spawned handle into a *ready* one by awaiting this before
/// handing the port to the frontend (§6.2). ComfyUI binds its HTTP server late
/// in boot, so a response to `/system_stats` is the first moment the port is
/// worth anything.
///
/// Note this watches the socket, not the process: a ComfyUI that dies during
/// startup simply stops answering and this reports a [`HealthError::Timeout`]
/// once the budget runs out. The engine log (#8) is where the actual traceback
/// lands, which is why the error points there.
pub async fn wait_until_healthy(port: u16) -> Result<(), HealthError> {
    poll_until_healthy(port, POLL_INTERVAL, STARTUP_TIMEOUT).await
}

/// The health loop with its cadence and budget injected, so tests can drive it
/// in milliseconds instead of the two-minute production timeout.
async fn poll_until_healthy(
    port: u16,
    interval: Duration,
    timeout: Duration,
) -> Result<(), HealthError> {
    let url = format!("http://{LOOPBACK}:{port}{HEALTH_PATH}");

    // Built once per engine start, not per probe. Each request carries its own
    // timeout below rather than a client-wide one, so a probe stuck on a
    // half-open socket can never outlive the budget that is left.
    let client = reqwest::Client::builder()
        .build()
        .map_err(HealthError::Client)?;

    let deadline = Instant::now() + timeout;
    loop {
        // Everything left in the budget bounds this iteration: no probe or sleep
        // may run past the deadline, so the total wall time is `timeout`, not
        // `timeout` plus a trailing probe. When nothing is left, we are done.
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Err(HealthError::Timeout { port });
        }

        // A wedged socket must not swallow the remaining budget in one try, so
        // the probe is capped at the poll interval; near the deadline it is
        // capped tighter still by whatever time is left.
        let probe = remaining.min(interval);

        // Any successful response means the server is up. Before it binds we get
        // connection-refused (an `Err`), which is not an outcome to propagate —
        // it is the expected state on every probe until the last one.
        if let Ok(res) = client.get(&url).timeout(probe).send().await {
            if res.status().is_success() {
                return Ok(());
            }
        }

        // Clamp the wait to what remains so we never sleep past the deadline; the
        // next iteration's check then reports the timeout immediately.
        let left = deadline.saturating_duration_since(Instant::now());
        tokio::time::sleep(interval.min(left)).await;
    }
}

/// Which pipe a captured line came from. `stderr` is where ComfyUI prints its
/// tracebacks, so the frontend can colour it — hence carrying the distinction
/// on the wire even though the file keeps the lines verbatim.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
enum Stream {
    Stdout,
    Stderr,
}

/// One captured line of engine output, as it crosses to the frontend.
///
/// `{ "stream": "stderr", "line": "…" }`. Mirrored by `app/lib/engine.ts`; the
/// serialize tests below pin the shape so a rename can't silently break the log
/// view, the same guard `progress.rs` gives its enum.
#[derive(Debug, PartialEq, Eq, Serialize)]
struct LogLine {
    stream: Stream,
    line: String,
}

impl LogLine {
    fn stdout(line: String) -> Self {
        Self {
            stream: Stream::Stdout,
            line,
        }
    }

    fn stderr(line: String) -> Self {
        Self {
            stream: Stream::Stderr,
            line,
        }
    }
}

/// Turns one plugin event into the line to record, or `None` for events that
/// carry nothing to log.
///
/// The process ending and a pipe error both become `stderr` lines rather than
/// being dropped: a ComfyUI that dies importing a node exits non-zero, and that
/// exit is frequently the whole diagnosis — a log that simply stopped would hide
/// it (§8.6).
fn log_entry(event: CommandEvent) -> Option<LogLine> {
    match event {
        CommandEvent::Stdout(bytes) => Some(LogLine::stdout(decode(&bytes))),
        CommandEvent::Stderr(bytes) => Some(LogLine::stderr(decode(&bytes))),
        CommandEvent::Terminated(payload) => Some(LogLine::stderr(format!(
            "engine process exited (code {:?}, signal {:?})",
            payload.code, payload.signal
        ))),
        CommandEvent::Error(err) => Some(LogLine::stderr(format!("engine pipe error: {err}"))),
        // `CommandEvent` is `#[non_exhaustive]`; a variant we don't recognise is
        // nothing to log.
        _ => None,
    }
}

/// ComfyUI's output is UTF-8, but a stray byte in a path or a redrawn progress
/// bar must not cost us the line that carried the traceback, so decode lossily.
/// The trailing newline goes because the plugin already split on it and both
/// sinks re-add their own.
fn decode(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes)
        .trim_end_matches(['\n', '\r'])
        .to_owned()
}

/// Drains the engine's stdout/stderr into the rotating log and the frontend.
///
/// This is the sole consumer of [`Engine::events`], and draining it is not
/// optional: the plugin's channel is bounded, so a receiver left unread back-
/// pressures the OS pipe until ComfyUI blocks on its next write. The loop runs
/// until the process closes the channel, so a caller spawns it and forgets it.
///
/// Every line lands twice — in the rotating file at [`Paths::engine_log`] so a
/// traceback survives the window closing, and on [`LOG_EVENT`] so a running UI
/// can show it live (§8.6). The emit is best-effort for the reason progress is:
/// nothing about keeping the pipe drained may depend on anyone listening.
pub async fn pump<R: Runtime>(
    app: AppHandle<R>,
    mut events: Receiver<CommandEvent>,
    log_path: PathBuf,
) {
    let mut log = RotatingLog::open(log_path, LOG_MAX_BYTES, LOG_KEEP);

    while let Some(event) = events.recv().await {
        if let Some(entry) = log_entry(event) {
            // The file gets the line verbatim so a multi-line Python traceback
            // reads as one; the stream tag rides along only to the frontend.
            log.write_line(&entry.line);
            let _ = app.emit(LOG_EVENT, &entry);
        }
    }
}

/// An append-only log that rolls itself over once it grows past a size cap,
/// keeping a bounded number of backups beside it.
///
/// Every operation is best-effort and swallows its errors: this sits on the
/// engine's output path, and a full disk or a locked file must never be the
/// thing that takes the engine down. A run where the log can't be written is
/// strictly worse than one where it can, never fatal.
struct RotatingLog {
    /// The live file. Backups are this path with `.1`, `.2`, … appended.
    path: PathBuf,
    /// Roll over before a write would carry the file past this many bytes.
    max_bytes: u64,
    /// How many rolled backups to retain; older ones are dropped.
    keep: usize,
    /// The open handle, or `None` if opening failed — the pump keeps draining
    /// the pipe either way.
    file: Option<File>,
    /// Bytes in the live file, tracked rather than `stat`-ed on every line.
    written: u64,
}

impl RotatingLog {
    fn open(path: PathBuf, max_bytes: u64, keep: usize) -> Self {
        let mut log = Self {
            path,
            max_bytes,
            keep,
            file: None,
            written: 0,
        };
        log.reopen();
        log
    }

    /// (Re)opens the live file in append mode, seeding `written` from its
    /// current length so the cap holds across app restarts instead of resetting
    /// to zero each run.
    fn reopen(&mut self) {
        if let Some(parent) = self.path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        match OpenOptions::new()
            .create(true)
            .append(true)
            .open(&self.path)
        {
            Ok(file) => {
                self.written = file.metadata().map(|m| m.len()).unwrap_or(0);
                self.file = Some(file);
            }
            Err(_) => self.file = None,
        }
    }

    fn write_line(&mut self, line: &str) {
        let incoming = line.len() as u64 + 1;

        // Roll before writing a line that would breach the cap — but never roll
        // an empty file, so a single line longer than the whole budget writes
        // once and oversizes the file rather than rotating forever.
        if self.written > 0 && self.written + incoming > self.max_bytes {
            self.rotate();
        }

        if let Some(file) = self.file.as_mut() {
            // Count the line only once it has fully landed; a short write must
            // not desync the byte tally from the file.
            if writeln!(file, "{line}").is_ok() {
                self.written += incoming;
            }
        }
    }

    /// Shifts `engine.log` → `.1` → `.2` …, dropping the `keep`-th backup, then
    /// opens a fresh live file.
    fn rotate(&mut self) {
        // Drop the handle before renaming the path out from under it: Windows
        // refuses to move a file that is still open.
        self.file = None;

        // Walk from the oldest surviving backup down so each rename lands on a
        // slot the previous step just vacated: `.{keep-1}`→`.{keep}`, …,
        // `.1`→`.2`, and finally the live file → `.1`. `rename` replaces an
        // existing target on every platform, so the old `.{keep}` is dropped.
        for i in (1..self.keep).rev() {
            let _ = std::fs::rename(self.backup(i), self.backup(i + 1));
        }
        if self.keep > 0 {
            let _ = std::fs::rename(&self.path, self.backup(1));
        }

        self.reopen();
    }

    /// The `n`-th backup path: `engine.log.n`.
    ///
    /// Built by appending to the whole path — never `with_extension`, which on
    /// `engine.log` would yield `engine.n` and drop the real name (the trap
    /// `download.rs` calls out).
    fn backup(&self, n: usize) -> PathBuf {
        let mut name = self.path.clone().into_os_string();
        name.push(format!(".{n}"));
        PathBuf::from(name)
    }
}

/// The argument vector for ComfyUI, factored out so the flags are a tested
/// contract rather than a literal buried in a builder chain.
///
/// `--disable-auto-launch` keeps ComfyUI from opening the system browser at its
/// own URL; the WebView is the only frontend.
fn engine_args(comfy_main: &Path, port: u16) -> Vec<String> {
    vec![
        comfy_main.display().to_string(),
        "--listen".into(),
        LOOPBACK.into(),
        "--port".into(),
        port.to_string(),
        "--disable-auto-launch".into(),
    ]
}

/// Asks the OS for a free port on loopback, then releases it.
///
/// Bind `:0`, read back the port the kernel chose, and drop the listener at the
/// end of scope so ComfyUI can claim it. The gap between the drop and ComfyUI's
/// bind is the race ADR-007 accepts; nothing on a desktop machine is fast enough
/// to lose it in practice.
fn free_port() -> std::io::Result<u16> {
    let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0))?;
    let port = listener.local_addr()?.port();
    Ok(port)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_reserved_port_is_real_and_free_to_bind() {
        let port = free_port().expect("a free port");
        assert_ne!(port, 0, "0 means the kernel never assigned one");

        // The listener must be dropped by the time we get the port back —
        // otherwise ComfyUI could never bind it. Prove it by binding it here.
        TcpListener::bind((Ipv4Addr::LOCALHOST, port)).expect("the port was released");
    }

    /// The reason this ticket exists: a user already running ComfyUI on 8188
    /// must not collide with ours. Binding `:0` can't hand back a port that's
    /// held, so an occupied 8188 is simply never chosen.
    #[test]
    fn a_held_port_is_never_handed_out() {
        let held =
            TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).expect("stand-in for user's ComfyUI");
        let taken = held.local_addr().expect("addr").port();

        for _ in 0..64 {
            assert_ne!(
                free_port().expect("a free port"),
                taken,
                "a port already in use must never be reserved"
            );
        }
    }

    #[test]
    fn the_engine_binds_loopback_never_all_interfaces() {
        let args = engine_args(Path::new("/engine/ComfyUI/main.py"), 49876);

        // `--listen 127.0.0.1`, as a pair, in order.
        let listen = args.iter().position(|a| a == "--listen").expect("--listen");
        assert_eq!(args.get(listen + 1).map(String::as_str), Some("127.0.0.1"));
        assert!(
            !args.iter().any(|a| a == "0.0.0.0"),
            "the engine must never be exposed on all interfaces"
        );
    }

    #[test]
    fn the_engine_is_told_the_reserved_port() {
        let args = engine_args(Path::new("/engine/ComfyUI/main.py"), 49876);
        let port = args.iter().position(|a| a == "--port").expect("--port");
        assert_eq!(args.get(port + 1).map(String::as_str), Some("49876"));
    }

    #[test]
    fn the_browser_auto_launch_is_disabled() {
        let args = engine_args(Path::new("/engine/ComfyUI/main.py"), 49876);
        assert!(args.iter().any(|a| a == "--disable-auto-launch"));
    }

    #[test]
    fn main_py_leads_so_python_runs_the_script() {
        let args = engine_args(Path::new("/engine/ComfyUI/main.py"), 49876);
        assert_eq!(
            args.first().map(String::as_str),
            Some("/engine/ComfyUI/main.py")
        );
    }

    /// Answers one request with a 200, then returns. One reply is all a probe
    /// needs; `Connection: close` keeps reqwest from holding the socket open and
    /// waiting on a thread that has already gone home.
    fn serve_one_ok() -> u16 {
        use std::io::{Read, Write};

        let listener =
            TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).expect("stand-in for ComfyUI's server");
        let port = listener.local_addr().expect("addr").port();

        std::thread::spawn(move || {
            if let Ok((mut stream, _)) = listener.accept() {
                let _ = stream.read(&mut [0u8; 1024]);
                let body = b"{}";
                let head = format!(
                    "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                    body.len()
                );
                let _ = stream.write_all(head.as_bytes());
                let _ = stream.write_all(body);
            }
        });

        port
    }

    #[test]
    fn healthy_the_moment_the_endpoint_answers() {
        let port = serve_one_ok();
        let result = tauri::async_runtime::block_on(poll_until_healthy(
            port,
            Duration::from_millis(20),
            Duration::from_secs(5),
        ));
        assert!(result.is_ok(), "a 200 on /system_stats means ready");
    }

    /// Accepts connections and holds them open forever without a reply. This is
    /// the case connection-refused can't reach: the socket is live, so only the
    /// per-probe timeout keeps a probe from blocking indefinitely.
    fn serve_silence() -> u16 {
        let listener =
            TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).expect("stand-in for a wedged engine");
        let port = listener.local_addr().expect("addr").port();

        std::thread::spawn(move || {
            // Hold every accepted socket so it stays open and unanswered.
            let mut held = Vec::new();
            for stream in listener.incoming() {
                match stream {
                    Ok(s) => held.push(s),
                    Err(_) => break,
                }
            }
        });

        port
    }

    #[test]
    fn times_out_when_the_socket_answers_but_the_server_never_does() {
        let port = serve_silence();

        let result = tauri::async_runtime::block_on(poll_until_healthy(
            port,
            Duration::from_millis(20),
            Duration::from_millis(120),
        ));

        assert!(
            matches!(result, Err(HealthError::Timeout { port: p }) if p == port),
            "a live-but-silent engine must time out, not hang, got {result:?}"
        );
    }

    #[test]
    fn times_out_when_nothing_ever_answers() {
        // A reserved-then-released port: connections are refused, standing in for
        // an engine that never finishes binding. The budget is milliseconds so
        // the test times out on purpose without the production two minutes.
        let dead = free_port().expect("a free port");

        let result = tauri::async_runtime::block_on(poll_until_healthy(
            dead,
            Duration::from_millis(5),
            Duration::from_millis(40),
        ));

        assert!(
            matches!(result, Err(HealthError::Timeout { port }) if port == dead),
            "an engine that never answers must time out on its own port, got {result:?}"
        );
    }

    // --- The log pump ---------------------------------------------------------

    use std::fs;

    /// `LogLine` is the wire contract `app/lib/engine.ts` mirrors by hand. These
    /// pin `stream` to lowercase tags and the two-field shape so a rename fails
    /// here rather than silently emptying the log view — the same guard
    /// `progress.rs` gives its enum.
    #[test]
    fn a_log_line_serializes_with_stream_and_line() {
        assert_eq!(
            serde_json::to_value(LogLine::stderr(
                "Traceback (most recent call last):".to_owned()
            ))
            .expect("serialize"),
            serde_json::json!({
                "stream": "stderr",
                "line": "Traceback (most recent call last):",
            }),
        );
        assert_eq!(
            serde_json::to_value(LogLine::stdout("got prompt".to_owned())).expect("serialize"),
            serde_json::json!({ "stream": "stdout", "line": "got prompt" }),
        );
    }

    #[test]
    fn stdout_and_stderr_keep_their_stream() {
        assert_eq!(
            log_entry(CommandEvent::Stdout(b"got prompt\n".to_vec())),
            Some(LogLine::stdout("got prompt".to_owned())),
        );
        assert_eq!(
            log_entry(CommandEvent::Stderr(b"ImportError\n".to_vec())),
            Some(LogLine::stderr("ImportError".to_owned())),
        );
    }

    #[test]
    fn the_trailing_newline_is_stripped_so_sinks_add_their_own() {
        assert_eq!(
            log_entry(CommandEvent::Stdout(b"a line\r\n".to_vec())),
            Some(LogLine::stdout("a line".to_owned())),
        );
    }

    /// A ComfyUI that dies importing a node exits non-zero and says nothing else;
    /// that exit is the diagnosis, so it must reach the log as a line, not vanish.
    #[test]
    fn a_process_exit_becomes_a_stderr_line() {
        let entry = log_entry(CommandEvent::Terminated(
            tauri_plugin_shell::process::TerminatedPayload {
                code: Some(1),
                signal: None,
            },
        ))
        .expect("termination is logged");

        assert_eq!(entry.stream, Stream::Stderr);
        assert!(
            entry.line.contains("exited") && entry.line.contains('1'),
            "the exit line should name the code, got {:?}",
            entry.line
        );
    }

    /// The reason this feature exists: a multi-line Python traceback written
    /// while the engine ran must be readable, verbatim, from the file afterward.
    #[test]
    fn a_traceback_is_readable_from_the_file_verbatim() {
        let dir = tempfile::tempdir().expect("temp dir");
        let path = dir.path().join("logs").join("engine.log");

        let mut log = RotatingLog::open(path.clone(), LOG_MAX_BYTES, LOG_KEEP);
        for line in [
            "Traceback (most recent call last):",
            "  File \"nodes.py\", line 42, in load",
            "ModuleNotFoundError: No module named 'foo'",
        ] {
            log.write_line(line);
        }
        drop(log);

        let contents = fs::read_to_string(&path).expect("the log exists");
        assert_eq!(
            contents,
            "Traceback (most recent call last):\n  File \"nodes.py\", line 42, in load\nModuleNotFoundError: No module named 'foo'\n",
        );
    }

    #[test]
    fn the_pump_creates_the_logs_directory_if_it_is_missing() {
        let dir = tempfile::tempdir().expect("temp dir");
        // A nested path whose parent does not exist yet — "Open Logs" before any
        // engine ever ran still needs a directory to reveal.
        let path = dir.path().join("logs").join("engine.log");
        assert!(!path.parent().expect("parent").exists());

        RotatingLog::open(path.clone(), LOG_MAX_BYTES, LOG_KEEP).write_line("hello");

        assert!(path.exists(), "the pump made its own log directory");
    }

    #[test]
    fn the_log_rolls_over_once_it_passes_the_cap() {
        let dir = tempfile::tempdir().expect("temp dir");
        let path = dir.path().join("engine.log");

        // A tiny cap so a handful of lines forces a roll. Each "line" is 4 bytes
        // plus a newline, so the third write breaches a 12-byte budget.
        let mut log = RotatingLog::open(path.clone(), 12, 3);
        for _ in 0..3 {
            log.write_line("line");
        }
        drop(log);

        let first_backup = PathBuf::from({
            let mut n = path.clone().into_os_string();
            n.push(".1");
            n
        });
        assert!(first_backup.exists(), "a full log rolls to engine.log.1");
        assert!(
            fs::metadata(&path).expect("live log").len() <= 12,
            "the live file starts fresh after a roll",
        );
    }

    #[test]
    fn rotation_keeps_only_the_configured_number_of_backups() {
        let dir = tempfile::tempdir().expect("temp dir");
        let path = dir.path().join("engine.log");

        // keep = 2, cap = 5 bytes: every "line" (5 bytes with its newline) rolls
        // the one before it. Ten writes is far more rolls than backups kept.
        let mut log = RotatingLog::open(path.clone(), 5, 2);
        for _ in 0..10 {
            log.write_line("line");
        }
        drop(log);

        let backup = |n: usize| {
            let mut name = path.clone().into_os_string();
            name.push(format!(".{n}"));
            PathBuf::from(name)
        };
        assert!(backup(1).exists(), ".1 is kept");
        assert!(backup(2).exists(), ".2 is kept");
        assert!(
            !backup(3).exists(),
            "a third backup must never accumulate when keep = 2",
        );
    }

    /// The `download.rs` trap, guarded here too: appending `.1` must not eat the
    /// `.log` the way `with_extension` would.
    #[test]
    fn a_backup_path_appends_and_never_replaces_the_extension() {
        let log = RotatingLog::open(PathBuf::from("/logs/engine.log"), LOG_MAX_BYTES, LOG_KEEP);
        assert_eq!(log.backup(1), PathBuf::from("/logs/engine.log.1"));
        assert_eq!(log.backup(2), PathBuf::from("/logs/engine.log.2"));
    }
}
