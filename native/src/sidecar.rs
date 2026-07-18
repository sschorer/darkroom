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
//! ([`pump`]) all build on the [`Engine`] handle.
//!
//! Teardown is [`reclaim_stale`]: the engine holds several GB of VRAM, so a
//! process left behind by a crash makes the next launch fail with an OOM the
//! user can't explain (§8.3, ADR-016). Rather than track a live child handle,
//! [`spawn`] writes the engine's identity to a PID file and `reclaim_stale`
//! reads it — at boot to clear a leak from a hard-killed session, and at
//! `RunEvent::ExitRequested` to stop the engine this session started. One file
//! drives both, and the identity check keeps a recycled PID from costing an
//! innocent process its life.

use std::collections::VecDeque;
use std::fs::{File, OpenOptions};
use std::io::Write;
use std::net::{Ipv4Addr, TcpListener};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, System, UpdateKind};
use tauri::async_runtime::Receiver;
use tauri::{AppHandle, Emitter, Runtime};
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;
use tokio::sync::oneshot;

use crate::paths::Paths;

/// The one interface we ever bind. Passed to `--listen` and used to reserve the
/// port; anything else would be a mistake, so it lives in one place.
const LOOPBACK: &str = "127.0.0.1";

/// The route ComfyUI serves once its HTTP server is up. Any response here is
/// proof of life; the frontend re-reads it for VRAM (ADR-008, §6.2).
const HEALTH_PATH: &str = "/system_stats";

/// How often to re-probe while the engine is starting.
const POLL_INTERVAL: Duration = Duration::from_millis(500);

/// How many trailing engine-output lines a startup-exit error carries (§8.6).
/// Enough to hold a Python traceback, bounded so a chatty boot can't grow the
/// error without limit — the same budget `bootstrap.rs` gives its uv tail.
const EXIT_TAIL_LINES: usize = 40;

/// Per-line byte cap for that tail, so a single newline-less blob can't ride in
/// whole. The engine's output is line-split by the plugin already; this is the
/// belt-and-suspenders against a pathological line.
const EXIT_TAIL_LINE_BYTES: usize = 2 * 1024;

/// The whole startup budget. ComfyUI's first boot imports torch and every
/// custom node, which is slow; 120s is generous for that yet short enough that a
/// genuinely dead engine surfaces as an error rather than an app that hangs
/// forever (§6.2).
const STARTUP_TIMEOUT: Duration = Duration::from_secs(120);

/// The Tauri event each captured log line is emitted on, so a running UI can
/// show the engine's output live. The payload type is generated for
/// `app/lib/engine.ts` by ts-rs (ADR-018); this event *name* is matched by hand
/// on the TS side.
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

    #[error(
        "the engine started but its identity could not be recorded, so a crash \
         would strand it holding the GPU: {source}\n  \
         The engine was stopped. This usually means the app data directory is \
         not writable."
    )]
    Pid {
        #[source]
        source: PidError,
    },
}

/// Why the engine's identity could not be persisted for later reclaim.
///
/// Either failure leaves us unable to find and kill the engine after a crash,
/// so [`spawn`] treats both as fatal rather than starting an engine it could
/// never reclaim.
#[derive(Debug, thiserror::Error)]
pub enum PidError {
    #[error("the just-spawned engine process (pid {pid}) was not visible to read its start time")]
    NotVisible { pid: u32 },

    #[error("could not write the engine pid file: {0}")]
    Write(#[source] std::io::Error),
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

    #[error(
        "the engine exited during startup (code {code:?}, signal {signal:?}) before \
         it answered on {LOOPBACK}:{port}.\n  \
         A failing node import is the usual cause; the full log is at Help → Open \
         Logs. Recent engine output:\n\n{tail}"
    )]
    Exited {
        port: u16,
        code: Option<i32>,
        signal: Option<i32>,
        /// The engine's last lines before it died — the traceback, usually. Kept
        /// on the error so the message is actionable on its own (§8.6), not a
        /// bare exit code pointing elsewhere.
        tail: String,
    },
}

/// How the engine process ended, as the log pump ([`pump`]) saw it.
///
/// Handed from the pump to the health wait so a boot that dies importing a node
/// fails in the seconds it actually took — carrying the exit code *and* the tail
/// of what the engine printed before dying — rather than making the frontend
/// wait out the whole [`STARTUP_TIMEOUT`] for a timeout the process had already
/// decided. The pump watches the *process* (and holds its recent output); the
/// health poll watches the *socket*; racing the two is what turns a fast failure
/// into a fast, actionable error (§6.2, §8.6).
#[derive(Debug, Clone)]
pub struct EngineExit {
    pub code: Option<i32>,
    pub signal: Option<i32>,
    /// The last [`EXIT_TAIL_LINES`] the engine emitted before it terminated.
    pub tail: String,
}

/// A running engine and the port it was told to serve on.
///
/// Ownership of the process lives here from spawn onward, and each half of the
/// lifecycle takes one piece: [`wait_until_healthy`] polls [`port`](Self::port)
/// until the server answers, and [`pump`] drains [`events`](Self::events) into
/// the log. Teardown does *not* go through this handle — [`spawn`] records the
/// process's identity to a PID file and [`reclaim_stale`] kills it from there,
/// so the child can be reclaimed even after a crash that dropped this handle.
pub struct Engine {
    /// The loopback port ComfyUI was told to bind. The frontend builds its
    /// engine URL from this (ADR-008).
    pub port: u16,

    /// The live process. Held so the plugin keeps its pipes open for the log
    /// pump; teardown kills by PID (see [`reclaim_stale`]), not through here.
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

    // Record who to kill before returning: after a crash this file is the only
    // pointer to the leaked engine. If we can't write it, teardown has nothing
    // to work from — better to stop the engine now and say so than to run one
    // that a crash would strand holding the GPU (RISK-7).
    if let Err(source) = write_pid_file(&paths.engine_pid(), child.pid()) {
        let _ = child.kill();
        return Err(SpawnError::Pid { source });
    }

    Ok(Engine {
        port,
        child,
        events,
    })
}

/// Waits until the engine on `port` answers, the process dies, or the
/// [`STARTUP_TIMEOUT`] budget runs out — whichever comes first.
///
/// [`spawn`] returns the instant the process exists; this is the other half —
/// the caller turns a spawned handle into a *ready* one by awaiting this before
/// handing the port to the frontend (§6.2). ComfyUI binds its HTTP server late
/// in boot, so a response to `/system_stats` is the first moment the port is
/// worth anything.
///
/// The health *poll* watches the socket, not the process, so on its own a
/// ComfyUI that dies importing a node would only surface after the full budget
/// elapsed — two minutes of "Starting…" for a failure the process decided in
/// three seconds. `exited` closes that gap: the log pump ([`pump`]) fires it the
/// moment it sees the process terminate, and this races it against the poll, so
/// a boot that fails fast fails fast (with the exit code, via
/// [`HealthError::Exited`]). The engine log (#8) is where the actual traceback
/// lands, which is why every arm's error points there.
pub async fn wait_until_healthy(
    port: u16,
    exited: oneshot::Receiver<EngineExit>,
) -> Result<(), HealthError> {
    race_until_healthy(port, POLL_INTERVAL, STARTUP_TIMEOUT, exited).await
}

/// The socket poll and the process-exit signal, raced with their cadence and
/// budget injected so tests drive it in milliseconds rather than the two-minute
/// production timeout.
async fn race_until_healthy(
    port: u16,
    interval: Duration,
    timeout: Duration,
    exited: oneshot::Receiver<EngineExit>,
) -> Result<(), HealthError> {
    // A dropped sender — the pump ended without ever seeing a `Terminated`
    // event, which shouldn't happen but the type permits — must not read as an
    // exit and forge a failure. Fall back to never firing, leaving the poll to
    // reach its own verdict (a healthy answer, or the timeout).
    let on_exit = async {
        match exited.await {
            Ok(info) => info,
            Err(_) => std::future::pending::<EngineExit>().await,
        }
    };

    tokio::select! {
        res = poll_until_healthy(port, interval, timeout) => res,
        info = on_exit => Err(HealthError::Exited {
            port,
            code: info.code,
            signal: info.signal,
            tail: info.tail,
        }),
    }
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

/// A single, quick health probe — for checking a *retained* engine is still
/// answering before its port is reused, not for the long startup wait.
///
/// `wait_until_healthy` loops for up to two minutes because it races a process
/// that is still booting; this asks once, with a short timeout, of a process we
/// already saw become healthy. Any failure (refused, timed out, non-2xx) means
/// "not usable now" — the caller should discard the retained engine and respawn
/// rather than hand back a dead port (ADR-016's leak is reclaimed elsewhere).
pub async fn is_responding(port: u16) -> bool {
    let url = format!("http://{LOOPBACK}:{port}{HEALTH_PATH}");
    let Ok(client) = reqwest::Client::builder().build() else {
        return false;
    };
    matches!(
        client.get(&url).timeout(Duration::from_secs(2)).send().await,
        Ok(res) if res.status().is_success()
    )
}

/// Which pipe a captured line came from. `stderr` is where ComfyUI prints its
/// tracebacks, so the frontend can colour it — hence carrying the distinction
/// on the wire even though the file keeps the lines verbatim.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, export_to = "./"))]
#[serde(rename_all = "lowercase")]
enum Stream {
    Stdout,
    Stderr,
}

/// One captured line of engine output, as it crosses to the frontend.
///
/// `{ "stream": "stderr", "line": "…" }`. Its TS type is generated by ts-rs
/// (ADR-018); the serialize tests below pin the actual serde JSON — the lowercase
/// `stream` tags, the two fields — the half ts-rs can't see, the same guard
/// `progress.rs` gives its enum.
#[derive(Debug, PartialEq, Eq, Serialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, export_to = "./"))]
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
///
/// The pump also owns the one place that sees the process end: on the
/// `Terminated` event it fires `on_exit` so a health wait racing this can fail
/// the instant the engine dies (see [`wait_until_healthy`]). It carries the
/// engine's recent output along, so a startup death is an actionable error with
/// the traceback in it, not a bare code pointing at a log (§8.6). Firing is
/// best-effort too — once the engine is healthy the receiver is long dropped,
/// and a send to a dropped receiver is the ordinary, ignorable case.
pub async fn pump<R: Runtime>(
    app: AppHandle<R>,
    mut events: Receiver<CommandEvent>,
    log_path: PathBuf,
    on_exit: oneshot::Sender<EngineExit>,
) {
    let mut log = RotatingLog::open(log_path, LOG_MAX_BYTES, LOG_KEEP);
    // Taken on the first `Terminated`; a `oneshot::Sender` can only send once,
    // and the process terminates once.
    let mut on_exit = Some(on_exit);
    // A bounded window of the engine's most recent lines, so the exit can carry
    // the traceback that preceded it. The lines arrive in order, so by the time
    // `Terminated` lands this already holds the death's cause.
    let mut recent: VecDeque<String> = VecDeque::with_capacity(EXIT_TAIL_LINES + 1);

    while let Some(event) = events.recv().await {
        // Signal the exit *before* logging it, so the health wait is released as
        // early as possible; the same event still becomes a log line below. The
        // tail is what preceded this terminate — the exit line itself is
        // redundant with the code already in the error.
        if let CommandEvent::Terminated(payload) = &event {
            if let Some(tx) = on_exit.take() {
                let _ = tx.send(EngineExit {
                    code: payload.code,
                    signal: payload.signal,
                    tail: Vec::from(std::mem::take(&mut recent)).join("\n"),
                });
            }
        }
        if let Some(entry) = log_entry(event) {
            // The file gets the line verbatim so a multi-line Python traceback
            // reads as one; the stream tag rides along only to the frontend.
            log.write_line(&entry.line);
            push_tail(&mut recent, &entry.line);
            let _ = app.emit(LOG_EVENT, &entry);
        }
    }
}

/// Pushes a line onto the exit-tail ring, evicting the oldest past the cap and
/// clipping any single line to [`EXIT_TAIL_LINE_BYTES`] so a runaway line can't
/// grow the tail unbounded.
fn push_tail(recent: &mut VecDeque<String>, line: &str) {
    recent.push_back(clip_line(line, EXIT_TAIL_LINE_BYTES));
    if recent.len() > EXIT_TAIL_LINES {
        recent.pop_front();
    }
}

/// Truncates a line to `max` bytes on a char boundary, marking a cut with an
/// ellipsis. Runs on lossily-decoded subprocess output, so it must never split a
/// codepoint. Short lines pass through untouched.
fn clip_line(line: &str, max: usize) -> String {
    if line.len() <= max {
        return line.to_owned();
    }
    let mut end = max;
    while end > 0 && !line.is_char_boundary(end) {
        end -= 1;
    }
    let mut clipped = String::with_capacity(end + '…'.len_utf8());
    clipped.push_str(&line[..end]);
    clipped.push('…');
    clipped
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
///
/// `--enable-cors-header` is load-bearing and invisible from our code. By
/// default ComfyUI installs an `origin_only_middleware` that 403s any request
/// carrying `Sec-Fetch-Site: cross-site` or an `Origin` whose host differs from
/// the request's (its anti-DNS-rebinding guard, `server.py`). The WebView is a
/// *different* origin from the engine — `tauri://localhost` (or the dev server)
/// talking to `127.0.0.1:<port>` — so every `fetch`/WebSocket it makes is
/// cross-site and gets 403'd, while our Rust health probe (`reqwest`, no such
/// headers) sails through: the engine looks healthy yet refuses the frontend.
/// Passing this flag swaps that middleware for a permissive CORS one, which is
/// what makes ADR-008 (frontend talks to the engine directly) actually work.
/// Safe here because the engine is loopback-only on a random port (ADR-007);
/// the origin gate was defending a *fixed* public port we don't expose.
fn engine_args(comfy_main: &Path, port: u16) -> Vec<String> {
    vec![
        comfy_main.display().to_string(),
        "--listen".into(),
        LOOPBACK.into(),
        "--port".into(),
        port.to_string(),
        "--disable-auto-launch".into(),
        "--enable-cors-header".into(),
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

// --- Teardown: the PID file and stale-engine reclaim (§8.3) -------------------

/// The identity of a running engine, persisted so a later boot can find it.
///
/// A bare PID is not enough. PIDs are recycled, and an engine that died leaves
/// its number free for the OS to hand to some unrelated process; killing that
/// number blindly would take down whatever now holds it. A process's start time
/// is what a recycled PID does *not* carry over — the reused number belongs to a
/// process that started later — so the pair `(pid, start_time)` names one
/// specific process across the whole reuse.
#[derive(Debug, Serialize, Deserialize, PartialEq, Eq)]
struct EnginePid {
    pid: u32,
    /// Seconds since the Unix epoch, as the OS reports the process's start.
    start_time: u64,
}

/// Records the running engine's identity so [`reclaim_stale`] can kill it after
/// a crash or `SIGKILL` that skipped every teardown hook.
///
/// **Not** best-effort, unlike the log pump: teardown on *every* path — clean
/// exit included — reads this file and nothing else, so a record we failed to
/// write is an engine that can never be reclaimed. That is the exact leak this
/// ticket exists to prevent (RISK-7), so both failures are fatal and [`spawn`]
/// stops the engine rather than run one it can't account for. A start time we
/// can't read is as disqualifying as a file we can't write: a record without it
/// would match no live process, i.e. reclaim would silently never fire.
fn write_pid_file(path: &Path, pid: u32) -> Result<(), PidError> {
    let handle = Pid::from_u32(pid);
    let mut sys = System::new();
    sys.refresh_processes_specifics(
        ProcessesToUpdate::Some(&[handle]),
        true,
        ProcessRefreshKind::nothing(),
    );
    let start_time = sys
        .process(handle)
        .map(|p| p.start_time())
        .ok_or(PidError::NotVisible { pid })?;

    let record = EnginePid { pid, start_time };
    // Serializing this two-field struct cannot realistically fail; if serde ever
    // surprises us it folds into the same `Write` path rather than a panic.
    let json = serde_json::to_string(&record).map_err(|e| PidError::Write(e.into()))?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(PidError::Write)?;
    }
    std::fs::write(path, json).map_err(PidError::Write)
}

/// Kills an engine a previous session left running, if the PID file still names
/// a live one, and clears the file.
///
/// This is the teardown of §8.3, wired into two places that share it through the
/// file rather than a live handle: boot (before this session might spawn its
/// own engine) reclaims a leak from a hard-killed run, and
/// `RunEvent::ExitRequested` stops the engine this session started. The updater
/// path (`on_before_exit`) joins them in #40.
///
/// The record is cleared only once it has done its job: the engine is gone —
/// killed, already dead, or the PID now belongs to a stranger. If a kill we
/// attempted *fails*, the orphan is still holding the GPU and the file is the
/// only way the next boot can retry, so it is deliberately kept. All I/O is
/// best-effort: a teardown that can't read or delete the file must still let the
/// app exit.
///
/// Requires one running instance, now enforced rather than assumed (ADR-017):
/// the single-instance plugin turns a second launch away before it could reach
/// this. That enforcement is load-bearing here — without it, a second Darkroom's
/// boot reclaim would find the first's PID file, confirm the identity (same
/// `main.py`, same start time), and `SIGKILL` a live engine mid-generation.
pub fn reclaim_stale(paths: &Paths) {
    let path = paths.engine_pid();

    // No file is the common case — nothing ran, or the last run exited cleanly
    // and cleared it. Nothing to reclaim.
    let Ok(raw) = std::fs::read_to_string(&path) else {
        return;
    };
    let record: EnginePid = match serde_json::from_str(&raw) {
        Ok(record) => record,
        // A truncated or garbled file names nothing safe to act on; drop it
        // rather than carry an unreadable record forward.
        Err(_) => {
            let _ = std::fs::remove_file(&path);
            return;
        }
    };

    let handle = Pid::from_u32(record.pid);
    let mut sys = System::new();
    sys.refresh_processes_specifics(
        ProcessesToUpdate::Some(&[handle]),
        true,
        ProcessRefreshKind::nothing().with_cmd(UpdateKind::Always),
    );

    match sys.process(handle) {
        // The engine we recorded is still alive at that PID.
        Some(process) => {
            let cmd: Vec<&Path> = process.cmd().iter().map(Path::new).collect();
            if is_recorded_engine(&record, process.start_time(), &cmd, &paths.comfy_main()) {
                // SIGKILL on Unix, TerminateProcess on Windows. The orphan is
                // past a graceful shutdown, and a hard kill is what frees the
                // GPU now. Keep the record if the kill did not take, so the next
                // boot can try again rather than lose its only pointer to a
                // process still holding the GPU.
                if process.kill() {
                    let _ = std::fs::remove_file(&path);
                }
            } else {
                // A stranger holds the PID now (reused number, or a different
                // process). Nothing of ours to kill; the record is spent.
                let _ = std::fs::remove_file(&path);
            }
        }
        // Nothing at that PID — the engine already died. The record is spent.
        None => {
            let _ = std::fs::remove_file(&path);
        }
    }
}

/// Whether the live process at the recorded PID is really the engine we wrote
/// down, and so safe to kill.
///
/// Two guards, both required. The start time defeats PID reuse: a recycled PID
/// belongs to a later process with a different start, so a match means the very
/// process we recorded. The command line confirms identity directly — our
/// engine always runs `main.py`, whose absolute appdata path appears in no
/// unrelated process — and it is not optional: a process we cannot confirm is
/// running our engine is one we must not kill, so a hidden or empty command
/// line rejects the reclaim rather than falling back to the start time alone. In
/// practice a live engine we spawned is always our own process, whose command
/// line the OS lets us read; an unreadable one is not the engine.
fn is_recorded_engine(
    record: &EnginePid,
    start_time: u64,
    cmd: &[&Path],
    comfy_main: &Path,
) -> bool {
    record.start_time == start_time && cmd.contains(&comfy_main)
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

    /// Without this the WebView — a different origin from the engine — is 403'd
    /// on every request by ComfyUI's default origin guard, while our reqwest
    /// health probe (which sends no `Origin`/`Sec-Fetch-Site`) still passes: the
    /// engine reports healthy yet refuses the frontend. It is the flag that
    /// makes ADR-008 real, so it is a tested contract, not an incidental arg.
    #[test]
    fn the_cross_origin_gate_is_disabled_for_the_webview() {
        let args = engine_args(Path::new("/engine/ComfyUI/main.py"), 49876);
        assert!(
            args.iter().any(|a| a == "--enable-cors-header"),
            "the WebView is cross-origin to the engine and is 403'd without this"
        );
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

    /// The reason the exit race exists: a ComfyUI that dies importing a node
    /// must surface as an `Exited` error in the seconds it took, not after the
    /// full startup budget. A dead port would otherwise burn the whole timeout;
    /// firing the exit signal must beat it and carry the code.
    #[test]
    fn exits_at_once_when_the_process_dies_before_answering() {
        // A refused port stands in for an engine that never binds; without the
        // exit signal this would run to the (here, long) timeout.
        let dead = free_port().expect("a free port");
        let (tx, rx) = oneshot::channel();
        tx.send(EngineExit {
            code: Some(1),
            signal: None,
            tail: String::new(),
        })
        .expect("the receiver is still live");

        let result = tauri::async_runtime::block_on(race_until_healthy(
            dead,
            Duration::from_millis(20),
            Duration::from_secs(30),
            rx,
        ));

        assert!(
            matches!(result, Err(HealthError::Exited { port, code: Some(1), signal: None, .. }) if port == dead),
            "a process that exits must fail fast as Exited with its code, got {result:?}"
        );
    }

    /// §8.6: the fast-fail error must be actionable on its own. The tail the pump
    /// carried — the traceback that preceded the exit — has to reach the message
    /// the user sees, not just an exit code pointing at a log.
    #[test]
    fn the_exit_error_carries_the_engine_output_tail() {
        let dead = free_port().expect("a free port");
        let (tx, rx) = oneshot::channel();
        tx.send(EngineExit {
            code: Some(1),
            signal: None,
            tail: "ModuleNotFoundError: No module named 'foo'".to_owned(),
        })
        .expect("the receiver is still live");

        let result = tauri::async_runtime::block_on(race_until_healthy(
            dead,
            Duration::from_millis(20),
            Duration::from_secs(30),
            rx,
        ));

        let message = match result {
            Err(err @ HealthError::Exited { .. }) => err.to_string(),
            other => panic!("expected an Exited error, got {other:?}"),
        };
        assert!(
            message.contains("ModuleNotFoundError: No module named 'foo'"),
            "the engine's traceback tail must reach the user, got: {message}"
        );
    }

    /// The pump's tail ring keeps the last lines (a traceback ends at the bottom,
    /// which is the half worth keeping) and clips a pathological single line so a
    /// newline-less blob can't grow the exit payload without bound.
    #[test]
    fn the_exit_tail_keeps_the_last_lines_and_clips_long_ones() {
        let mut recent = VecDeque::new();
        for i in 0..(EXIT_TAIL_LINES + 20) {
            push_tail(&mut recent, &format!("line {i}"));
        }
        assert_eq!(recent.len(), EXIT_TAIL_LINES, "the ring stays bounded");
        assert_eq!(
            recent.back().map(String::as_str),
            Some(format!("line {}", EXIT_TAIL_LINES + 19).as_str()),
            "the newest line — where a traceback's cause sits — is kept",
        );

        let mut big = VecDeque::new();
        push_tail(&mut big, &"x".repeat(10 * EXIT_TAIL_LINE_BYTES));
        assert!(big[0].ends_with('…'), "an oversized line is clipped");
        assert!(big[0].len() <= EXIT_TAIL_LINE_BYTES + '…'.len_utf8());
    }

    /// A health answer must win even when an exit could arrive: an engine that
    /// comes up cleanly is `Ok`, and the retained sender (never fired) must not
    /// turn that into a failure.
    #[test]
    fn a_healthy_answer_wins_over_a_pending_exit() {
        let port = serve_one_ok();
        let (_tx, rx) = oneshot::channel();

        let result = tauri::async_runtime::block_on(race_until_healthy(
            port,
            Duration::from_millis(20),
            Duration::from_secs(5),
            rx,
        ));

        assert!(result.is_ok(), "a live engine must be Ok, got {result:?}");
    }

    /// A dropped sender — the pump gone without ever seeing a `Terminated` —
    /// must not read as an exit. The poll runs to its own verdict, here a
    /// timeout, rather than a forged `Exited`.
    #[test]
    fn a_dropped_exit_sender_falls_back_to_the_poll() {
        let dead = free_port().expect("a free port");
        let (tx, rx) = oneshot::channel::<EngineExit>();
        drop(tx);

        let result = tauri::async_runtime::block_on(race_until_healthy(
            dead,
            Duration::from_millis(5),
            Duration::from_millis(40),
            rx,
        ));

        assert!(
            matches!(result, Err(HealthError::Timeout { port }) if port == dead),
            "a dropped sender must leave the poll to time out, not forge an exit, got {result:?}"
        );
    }

    // --- The log pump ---------------------------------------------------------

    use std::fs;

    /// `LogLine`'s TS type is generated by ts-rs (ADR-018), which checks the
    /// type structure. These pin the complementary half — the actual serde JSON:
    /// `stream` as lowercase tags and the two-field shape — so a serde change
    /// ts-rs can't see still fails here rather than silently emptying the log
    /// view, the same guard `progress.rs` gives its enum.
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

    // --- Teardown: the PID file and stale-engine reclaim ----------------------

    /// The start time the OS reports for this test process, so a record built
    /// with it names *us* — the safest live victim for proving the reclaim
    /// leaves the wrong process alone.
    fn our_start_time() -> u64 {
        let me = Pid::from_u32(std::process::id());
        let mut sys = System::new();
        sys.refresh_processes_specifics(
            ProcessesToUpdate::Some(&[me]),
            true,
            ProcessRefreshKind::nothing(),
        );
        sys.process(me)
            .expect("this process is in the table")
            .start_time()
    }

    #[test]
    fn a_pid_record_round_trips_through_the_file() {
        let dir = tempfile::tempdir().expect("temp dir");
        let path = dir.path().join("engine.pid");

        write_pid_file(&path, std::process::id()).expect("our own pid is recordable");

        let raw = fs::read_to_string(&path).expect("the pid file was written");
        let record: EnginePid = serde_json::from_str(&raw).expect("valid json");
        assert_eq!(record.pid, std::process::id());
        assert_ne!(record.start_time, 0, "a live process has a real start time");
    }

    /// A PID no live process holds cannot yield a start time, so its identity is
    /// unrecordable — `spawn` turns this into a fatal `SpawnError::Pid` rather
    /// than run an engine it could never reclaim.
    #[test]
    fn recording_an_absent_pid_fails() {
        let dir = tempfile::tempdir().expect("temp dir");
        let path = dir.path().join("engine.pid");

        // A PID far above the OS maximum names no process, so its start time is
        // unreadable.
        let result = write_pid_file(&path, u32::MAX);

        assert!(
            matches!(result, Err(PidError::NotVisible { pid }) if pid == u32::MAX),
            "an unrecordable identity must be an error, got {result:?}",
        );
        assert!(!path.exists(), "no half-written record is left behind");
    }

    /// The reuse guard in isolation: a recycled PID belongs to a process with a
    /// different start time, and that difference alone must veto the kill.
    #[test]
    fn identity_requires_a_matching_start_time() {
        let main = Path::new("/appdata/engine/ComfyUI/main.py");
        let cmd = [Path::new("/appdata/engine/.venv/bin/python"), main];
        let record = EnginePid {
            pid: 42,
            start_time: 1000,
        };

        assert!(is_recorded_engine(&record, 1000, &cmd, main));
        assert!(
            !is_recorded_engine(&record, 2000, &cmd, main),
            "a recycled pid carries a different start time and must not be killed",
        );
    }

    /// The identity guard in isolation: a matching start second is not enough if
    /// the command line proves the process is something other than our engine.
    #[test]
    fn identity_requires_our_main_py() {
        let main = Path::new("/appdata/engine/ComfyUI/main.py");
        let record = EnginePid {
            pid: 42,
            start_time: 1000,
        };

        let ours = [Path::new("/appdata/engine/.venv/bin/python"), main];
        assert!(is_recorded_engine(&record, 1000, &ours, main));

        let stranger = [Path::new("/usr/bin/vlc"), Path::new("movie.mkv")];
        assert!(
            !is_recorded_engine(&record, 1000, &stranger, main),
            "same start second but not our engine — leave it alone",
        );

        // A hidden or empty command line cannot confirm the process is our
        // engine, so it must reject the reclaim, not fall back to start time.
        assert!(
            !is_recorded_engine(&record, 1000, &[], main),
            "an unconfirmable process must never be killed",
        );
    }

    #[test]
    fn reclaim_with_no_pid_file_is_a_no_op() {
        let dir = tempfile::tempdir().expect("temp dir");
        let paths = Paths::new(dir.path());

        reclaim_stale(&paths);

        assert!(
            !paths.engine_pid().exists(),
            "reclaim must not conjure a file it never found",
        );
    }

    #[test]
    fn reclaim_drops_a_corrupt_pid_file() {
        let dir = tempfile::tempdir().expect("temp dir");
        let paths = Paths::new(dir.path());
        fs::write(paths.engine_pid(), "{ not json").expect("seed a corrupt file");

        reclaim_stale(&paths);

        assert!(
            !paths.engine_pid().exists(),
            "an unreadable record is cleared, not carried forward",
        );
    }

    /// The guard that matters most, against a live process: a record whose start
    /// time no longer matches the process at its PID must not get that process
    /// killed. Aiming the reclaim at this very test process with a wrong start
    /// time proves it — a broken guard would `SIGKILL` the test runner.
    #[test]
    fn reclaim_spares_a_live_process_whose_start_time_disagrees() {
        let dir = tempfile::tempdir().expect("temp dir");
        let paths = Paths::new(dir.path());

        let record = EnginePid {
            pid: std::process::id(),
            start_time: our_start_time() + 1,
        };
        fs::write(
            paths.engine_pid(),
            serde_json::to_string(&record).expect("json"),
        )
        .expect("seed the pid file");

        reclaim_stale(&paths);

        // Reaching this line at all is the assertion: we were not killed.
        assert!(
            !paths.engine_pid().exists(),
            "the spent record is cleared whatever the outcome",
        );
    }

    /// The identity guard against the same live victim: even a start time that
    /// matches must not kill a process that isn't running our `main.py`. The
    /// test binary is exactly such a process, so a correct reclaim leaves it
    /// running and only clears the file.
    #[test]
    fn reclaim_spares_a_live_process_that_is_not_the_engine() {
        let dir = tempfile::tempdir().expect("temp dir");
        let paths = Paths::new(dir.path());

        let record = EnginePid {
            pid: std::process::id(),
            start_time: our_start_time(),
        };
        fs::write(
            paths.engine_pid(),
            serde_json::to_string(&record).expect("json"),
        )
        .expect("seed the pid file");

        reclaim_stale(&paths);

        assert!(!paths.engine_pid().exists());
    }

    /// The positive path against a real, disposable process: an engine that
    /// matches its record must actually be killed and the record cleared. Unix
    /// only — it stands a small script up *at* `main.py`'s path so the process's
    /// argv carries exactly the path identity checks, which needs a shebang. The
    /// CI matrix runs this on Linux and macOS; Windows leans on the identity and
    /// no-op tests above plus `sysinfo`'s own `kill`.
    #[cfg(unix)]
    #[test]
    fn reclaim_kills_a_matching_engine_and_clears_the_record() {
        use std::os::unix::fs::PermissionsExt;
        use std::time::{Duration, Instant};

        let dir = tempfile::tempdir().expect("temp dir");
        let paths = Paths::new(dir.path());
        let main = paths.comfy_main();
        fs::create_dir_all(main.parent().expect("comfy dir")).expect("mkdir");

        // A stand-in for the engine: an executable sitting at main.py's path
        // that just idles. Launched directly, the kernel runs it as
        // `sh <main.py>`, so `main.py` is the process's own argv — exactly what
        // `is_recorded_engine` matches on.
        fs::write(&main, "#!/bin/sh\nwhile true; do sleep 1; done\n").expect("write stand-in");
        fs::set_permissions(&main, fs::Permissions::from_mode(0o755)).expect("chmod");

        let mut child = std::process::Command::new(&main)
            .spawn()
            .expect("spawn the engine stand-in");

        // Record its identity exactly as spawn would, then reclaim it.
        write_pid_file(&paths.engine_pid(), child.id()).expect("record the stand-in");
        reclaim_stale(&paths);

        // The process must actually die. Poll rather than assume an instant
        // reap; SIGKILL is prompt but not synchronous.
        let deadline = Instant::now() + Duration::from_secs(5);
        let killed = loop {
            match child.try_wait() {
                Ok(Some(_)) => break true,
                Ok(None) if Instant::now() < deadline => {
                    std::thread::sleep(Duration::from_millis(20))
                }
                _ => break false,
            }
        };
        if !killed {
            let _ = child.kill();
            let _ = child.wait();
        }

        assert!(killed, "reclaim must actually kill a matching engine");
        assert!(
            !paths.engine_pid().exists(),
            "a reclaimed engine's record is cleared",
        );
    }
}
