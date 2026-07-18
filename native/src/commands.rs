//! The IPC surface.
//!
//! App-defined commands need no capability entry — Tauri's capability system
//! gates *plugin* commands, so `capabilities/default.json` stays at
//! `core:default` (§8.4's "never `"*"`" is about that file, and it is untouched).
//!
//! Errors cross as strings. `BootstrapError`'s `Display` is the whole message,
//! newlines and engine log tail included, because §8.6 says the user gets the
//! actionable text and not a code. A structured error type would be the tidier
//! shape and would buy the frontend nothing it can act on today; #28 is where
//! error surfacing gets designed, and it can revisit this.

use tauri::{AppHandle, Runtime, State};
use tauri_plugin_shell::process::CommandChild;

use crate::engine::{self, Installed, Status};
use crate::paths::Paths;
use crate::sidecar;

/// Serialises bootstraps.
///
/// The button in the UI can be clicked twice, and two `provision` calls racing
/// each other would have one deleting `.venv` while the other installs into it.
/// `try_lock` rather than `lock`: the second caller should be told it is already
/// running, not silently queued behind ten minutes of work.
#[derive(Default)]
pub struct Bootstrapping(tauri::async_runtime::Mutex<()>);

#[tauri::command]
pub async fn engine_status<R: Runtime>(app: AppHandle<R>) -> Result<Status, String> {
    let paths = Paths::resolve(&app).map_err(|e| e.to_string())?;
    engine::status(&paths).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn bootstrap_engine<R: Runtime>(
    app: AppHandle<R>,
    lock: State<'_, Bootstrapping>,
) -> Result<Installed, String> {
    let _guard = lock
        .0
        .try_lock()
        .map_err(|_| "Setup is already running.".to_owned())?;

    let paths = Paths::resolve(&app).map_err(|e| e.to_string())?;
    engine::provision(&app, &paths)
        .await
        .map_err(|e| e.to_string())
}

/// The engine this session spawned, once it is up.
///
/// Holds the [`CommandChild`] for the one reason `sidecar::Engine` documents:
/// keeping it alive keeps the plugin's pipes open so the log pump keeps
/// draining. Teardown does *not* go through this handle — `reclaim_stale` kills
/// by the PID file `spawn` wrote, at `ExitRequested` and at the next boot — so
/// dropping it never strands the process (§8.3, ADR-016). The port is kept so a
/// second `start_engine` is idempotent rather than spawning a rival engine.
#[derive(Default)]
pub struct RunningEngine(tauri::async_runtime::Mutex<Option<Running>>);

struct Running {
    port: u16,
    #[allow(dead_code)] // held only so the pipes stay open; never read.
    child: CommandChild,
}

/// Starts ComfyUI and returns the loopback port it answers on (§6.2, ADR-007).
///
/// Idempotent: called again while an engine is already up, it returns that
/// engine's port rather than spawning a second one. The lock is held across the
/// health wait so two racing calls can't both spawn — the second blocks, then
/// sees the first's engine and returns its port.
///
/// The order is load-bearing. The log pump is spawned *before* the health wait,
/// because ComfyUI's boot output — including the traceback of a failed node
/// import — arrives during that wait, and an undrained pipe would back-pressure
/// the engine into a hang (`sidecar::pump`). The pump also carries the exit
/// signal the health wait races against, so a ComfyUI that dies importing a node
/// fails in seconds rather than making the user wait out the startup budget. If
/// the engine never answers (or exits), the just-spawned child is killed here
/// rather than left holding the GPU until teardown; the port and error come from
/// `sidecar`, whose `Display` already points at the engine log (§8.6).
#[tauri::command]
pub async fn start_engine<R: Runtime>(
    app: AppHandle<R>,
    engine: State<'_, RunningEngine>,
) -> Result<u16, String> {
    let mut slot = engine.0.lock().await;
    if let Some(running) = slot.as_ref() {
        // Only reuse a retained engine that still answers. ComfyUI can exit
        // after becoming healthy (an OOM, a crash), and the retained handle
        // does not notice — returning its dead port would fail every retry with
        // no respawn. A quick probe turns "cached" back into "cached *and
        // live*"; a dead one is dropped and falls through to a fresh spawn.
        if sidecar::is_responding(running.port).await {
            return Ok(running.port);
        }
        *slot = None;
    }

    let paths = Paths::resolve(&app).map_err(|e| e.to_string())?;
    let sidecar::Engine {
        port,
        child,
        events,
    } = sidecar::spawn(&app, &paths).map_err(|e| e.to_string())?;

    // Drain the pipe from the moment the process exists — before the health
    // wait, not after (see the fn doc). The pump reports the process's exit down
    // this channel; the health wait races that against the socket poll so a boot
    // that dies fails at once instead of after the whole startup budget.
    let (exit_tx, exit_rx) = tokio::sync::oneshot::channel();
    tauri::async_runtime::spawn(sidecar::pump(
        app.clone(),
        events,
        paths.engine_log(),
        exit_tx,
    ));

    if let Err(e) = sidecar::wait_until_healthy(port, exit_rx).await {
        let _ = child.kill();
        return Err(e.to_string());
    }

    *slot = Some(Running { port, child });
    Ok(port)
}
