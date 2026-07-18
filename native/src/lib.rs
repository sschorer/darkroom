use std::io::Write;

use tauri::menu::{Menu, MenuItem, MenuItemKind, HELP_SUBMENU_ID};
use tauri::{AppHandle, Manager, RunEvent, Runtime};

use crate::paths::Paths;

pub mod commands;
pub mod engine;
pub mod paths;
pub mod sidecar;

/// The Help-menu item that reveals the engine logs (#8).
const OPEN_LOGS_MENU_ID: &str = "open-logs";

/// Where a startup failure gets recorded when there is no console to print to.
///
/// `main.rs` sets `windows_subsystem = "windows"` in release, so on Windows
/// `eprintln!` goes nowhere and the app would vanish with no explanation —
/// the exact failure CLAUDE.md forbids.
///
/// Deliberately not `paths::Paths` even though appdata would be the tidier
/// home: this runs when `Builder::run` failed, so there is no `AppHandle` to
/// resolve appdata from. Temp needs nothing to work, which is the property
/// that matters for the log that explains why nothing works.
fn startup_log_path() -> std::path::PathBuf {
    std::env::temp_dir().join("darkroom-startup-error.log")
}

fn report_startup_failure(err: &tauri::Error) {
    let msg = format!("darkroom: failed to start: {err}");

    // Works on Linux, macOS, and Windows debug builds.
    eprintln!("{msg}");

    // The only channel that survives a release Windows build. Best-effort: if
    // even this fails there is nothing left to try, and panicking here would
    // replace a readable error with a silent crash.
    if let Ok(mut f) = std::fs::File::create(startup_log_path()) {
        let _ = writeln!(f, "{msg}");
    }
}

/// Builds the app menu: the platform default, with an "Open Logs" item added to
/// its Help submenu (#8).
///
/// Built on top of [`Menu::default`] rather than from scratch so the standard
/// entries — Quit, copy/paste, the macOS application menu — all survive;
/// replacing the menu wholesale to add one item is how those quietly vanish.
///
/// A Help submenu we can't locate is tolerated — the `if let` leaves the default
/// menu intact rather than failing the launch over a log shortcut. An `append`
/// that *does* fail, though, is a broken menu subsystem, no different from the
/// `Menu::default` and `MenuItem::with_id` calls above it: propagate it so a
/// half-built menu surfaces via `report_startup_failure` instead of launching
/// with a silently missing item and no diagnostic.
fn build_menu<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Menu<R>> {
    let menu = Menu::default(app)?;

    if let Some(MenuItemKind::Submenu(help)) = menu.get(HELP_SUBMENU_ID) {
        let open_logs = MenuItem::with_id(app, OPEN_LOGS_MENU_ID, "Open Logs", true, None::<&str>)?;
        help.append(&open_logs)?;
    }

    Ok(menu)
}

/// Reveals the logs directory in the OS file manager when "Open Logs" is chosen.
///
/// The directory, not the file: it holds the rotated backups too, and it exists
/// (we create it) even when the engine has never run to write `engine.log` — so
/// the menu item is never a dead click. All best-effort; a desktop app must not
/// panic because a file manager wouldn't open.
fn handle_menu_event<R: Runtime>(app: &AppHandle<R>, event: tauri::menu::MenuEvent) {
    if event.id() != OPEN_LOGS_MENU_ID {
        return;
    }

    if let Ok(paths) = Paths::resolve(app) {
        let logs = paths.logs();
        let _ = std::fs::create_dir_all(&logs);
        let _ = open::that_detached(&logs);
    }
}

/// Kills a leaked engine (§8.3). Called at boot and again at exit; both go
/// through the PID file, so neither needs a live handle to the child.
fn reclaim_engine<R: Runtime, M: Manager<R>>(manager: &M) {
    if let Ok(paths) = Paths::resolve(manager) {
        sidecar::reclaim_stale(&paths);
    }
}

/// Brings the running window forward when a second launch is turned away.
///
/// The single-instance plugin (ADR-017) fires this in the *primary* instance
/// with the rejected launch's args; the secondary process has already exited by
/// then. Args and cwd are unused today — Darkroom takes none — so the only thing
/// to do is surface the window the user already has, best-effort.
fn on_second_instance<R: Runtime>(app: &AppHandle<R>, _args: Vec<String>, _cwd: String) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.set_focus();
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        // First, before any other plugin or our own setup: a second launch must
        // be turned away inside this plugin's setup, before ours could run the
        // engine reclaim and kill the primary's engine (ADR-016, ADR-017).
        .plugin(tauri_plugin_single_instance::init(on_second_instance))
        .plugin(tauri_plugin_shell::init())
        .menu(build_menu)
        .on_menu_event(handle_menu_event)
        .manage(commands::Bootstrapping::default())
        .manage(commands::RunningEngine::default())
        .setup(|app| {
            // Before this session can spawn its own engine, clear one a
            // hard-killed previous run left holding the GPU (§8.3).
            reclaim_engine(app.handle());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::engine_status,
            commands::bootstrap_engine,
            commands::start_engine
        ])
        .build(tauri::generate_context!());

    // No `.expect()`: this is a desktop app, and a panic here is a window that
    // never appears with nothing to explain it (CLAUDE.md). Say what broke.
    let app = match app {
        Ok(app) => app,
        Err(err) => {
            report_startup_failure(&err);
            std::process::exit(1);
        }
    };

    // `.run` rather than letting the builder run so `ExitRequested` — normal
    // quit — can stop the engine before the process leaves. The stale-PID check
    // above covers the exits that never reach here (SIGKILL, a hard crash).
    app.run(|app, event| {
        if let RunEvent::ExitRequested { .. } = event {
            reclaim_engine(app);
        }
    });
}
