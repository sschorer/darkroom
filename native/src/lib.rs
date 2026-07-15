use std::io::Write;

/// Where a startup failure gets recorded when there is no console to print to.
///
/// `main.rs` sets `windows_subsystem = "windows"` in release, so on Windows
/// `eprintln!` goes nowhere and the app would vanish with no explanation —
/// the exact failure CLAUDE.md forbids. appdata is the right home for this and
/// arrives with paths.rs (#3); until then temp is somewhere a user can be
/// pointed at.
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
    // No `.expect()`: this is a desktop app, and a panic here is a window that
    // never appears with nothing to explain it (CLAUDE.md). Say what broke.
    if let Err(err) = tauri::Builder::default().run(tauri::generate_context!()) {
        report_startup_failure(&err);
        std::process::exit(1);
    }
}
