use std::io::Write;

pub mod commands;
pub mod engine;
pub mod paths;

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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .manage(commands::Bootstrapping::default())
        .invoke_handler(tauri::generate_handler![
            commands::engine_status,
            commands::bootstrap_engine
        ]);

    // No `.expect()`: this is a desktop app, and a panic here is a window that
    // never appears with nothing to explain it (CLAUDE.md). Say what broke.
    if let Err(err) = app.run(tauri::generate_context!()) {
        report_startup_failure(&err);
        std::process::exit(1);
    }
}
