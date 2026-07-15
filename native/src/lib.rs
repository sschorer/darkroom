#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // No `.expect()`: this is a desktop app, and a panic here is a window that
    // never appears with nothing to explain it (CLAUDE.md). Say what broke.
    if let Err(err) = tauri::Builder::default().run(tauri::generate_context!()) {
        eprintln!("darkroom: failed to start: {err}");
        std::process::exit(1);
    }
}
