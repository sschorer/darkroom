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

use tauri::async_runtime::Receiver;
use tauri::{AppHandle, Runtime};
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

use crate::paths::Paths;

/// The one interface we ever bind. Passed to `--listen` and used to reserve the
/// port; anything else would be a mistake, so it lives in one place.
const LOOPBACK: &str = "127.0.0.1";

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

/// A running engine and the port it was told to serve on.
///
/// Ownership of the process lives here from spawn until teardown. The three
/// tickets that follow each take one piece: #7 polls [`port`](Self::port) until
/// the server answers, #8 drains [`events`](Self::events) into the log, and #9
/// calls [`CommandChild::kill`] on [`child`](Self::child).
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
}
