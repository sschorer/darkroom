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
//! This module is deliberately just the spawn. Health polling (#7), the log pump
//! (#8), and teardown (#9) build on the [`Engine`] handle it returns.

use std::net::{Ipv4Addr, TcpListener};
use std::path::Path;
use std::time::{Duration, Instant};

use tauri::async_runtime::Receiver;
use tauri::{AppHandle, Runtime};
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
/// Ownership of the process lives here from spawn until teardown. The three
/// tickets that follow each take one piece: [`wait_until_healthy`] polls
/// [`port`](Self::port) until the server answers, #8 drains
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
    /// — a hang with no error. #8 turns this into the log pump; until then a
    /// caller that spawns an engine is on the hook for consuming it.
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

    // Built once per engine start, not per probe. The per-request timeout is the
    // poll interval: a probe stuck on a half-open socket must not bleed into the
    // next attempt, or one wedged connection would burn the whole budget on a
    // single try.
    let client = reqwest::Client::builder()
        .timeout(interval)
        .build()
        .map_err(HealthError::Client)?;

    let deadline = Instant::now() + timeout;
    loop {
        // Any successful response means the server is up. Before it binds we get
        // connection-refused (an `Err`), which is not an outcome to propagate —
        // it is the expected state on every probe until the last one.
        if let Ok(res) = client.get(&url).send().await {
            if res.status().is_success() {
                return Ok(());
            }
        }

        if Instant::now() >= deadline {
            return Err(HealthError::Timeout { port });
        }
        tokio::time::sleep(interval).await;
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
}
