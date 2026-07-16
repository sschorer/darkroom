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

use crate::engine::{self, Installed, Status};
use crate::paths::Paths;

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
