//! Single source of truth for the appdata layout (ARCHITECTURE §7.2, ADR-013).
//!
//! ```text
//! <app_data_dir>/
//! ├── .uv/                # uv's own state — survives a reprovision
//! │   ├── cache/          # wheel cache; same filesystem as .venv on purpose
//! │   └── python/         # interpreters uv downloaded
//! ├── engine/
//! │   ├── .venv/          # uv-managed
//! │   ├── ComfyUI/        # pinned SHA, tarball
//! │   └── .version        # matches comfy.lock when healthy
//! ├── logs/               # engine stdout/stderr, rotated (#8)
//! ├── models/
//! ├── outputs/
//! ├── engine.pid          # running engine's identity; reclaimed at boot (#9)
//! └── darkroom.db
//! ```
//!
//! Every path in the app comes from here. Nothing else joins a literal like
//! `"engine"` or `".venv"` onto a directory: the layout differs per OS in one
//! place only (the venv's interpreter), and duplicating the joins is how that
//! difference leaks into modules that never think about Windows.

use std::path::{Path, PathBuf};

use tauri::{Manager, Runtime};

/// The venv subdirectory holding the interpreter, and the interpreter's name.
///
/// This is PEP 405's layout, not a uv convention — uv, `python -m venv`, and
/// virtualenv all produce it, so it stays true no matter who builds the venv.
#[cfg(windows)]
const VENV_BIN: (&str, &str) = ("Scripts", "python.exe");
#[cfg(not(windows))]
const VENV_BIN: (&str, &str) = ("bin", "python");

/// A resolved appdata layout, rooted at the per-user data directory.
///
/// Cheap to clone and holds no handle, so it can cross threads into the engine
/// bootstrap and the sidecar supervisor without dragging Tauri along.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Paths {
    root: PathBuf,
}

impl Paths {
    /// Builds a layout under an explicit root.
    ///
    /// `resolve` is what the app calls. This exists so tests can exercise the
    /// layout against a temp dir, and so a future `--data-dir` override has a
    /// way in that doesn't fork the layout.
    pub fn new(root: impl Into<PathBuf>) -> Self {
        Self { root: root.into() }
    }

    /// Resolves the layout from Tauri's per-user data directory.
    ///
    /// The root is `app_data_dir()` itself — Tauri already qualifies it with
    /// the bundle identifier (`live.darkroom.app`), so appending another
    /// `darkroom/` segment would nest the app inside itself.
    pub fn resolve<R: Runtime, M: Manager<R>>(app: &M) -> tauri::Result<Self> {
        Ok(Self::new(app.path().app_data_dir()?))
    }

    /// The appdata root. Everything below is under it.
    pub fn root(&self) -> &Path {
        &self.root
    }

    /// The venv and the ComfyUI checkout. ~6 GB once provisioned.
    pub fn engine(&self) -> PathBuf {
        self.root.join("engine")
    }

    /// The uv-managed virtualenv.
    pub fn venv(&self) -> PathBuf {
        self.engine().join(".venv")
    }

    /// The venv's interpreter: `.venv/bin/python`, or `.venv/Scripts/python.exe`
    /// on Windows.
    pub fn python(&self) -> PathBuf {
        let (bin, exe) = VENV_BIN;
        self.venv().join(bin).join(exe)
    }

    /// The ComfyUI checkout, unpacked from the tarball at the pinned SHA.
    pub fn comfy(&self) -> PathBuf {
        self.engine().join("ComfyUI")
    }

    /// ComfyUI's entrypoint. Its presence is what distinguishes a real checkout
    /// from a directory an interrupted unpack left behind.
    pub fn comfy_main(&self) -> PathBuf {
        self.comfy().join("main.py")
    }

    /// The dependency list the bootstrap installs. Ships inside the tarball, so
    /// it is pinned by the SHA like everything else in the checkout.
    pub fn comfy_requirements(&self) -> PathBuf {
        self.comfy().join("requirements.txt")
    }

    /// Scratch space for the unpack: the tarball lands here and is expanded
    /// here, then the result is renamed into `ComfyUI`.
    ///
    /// Under `engine/` rather than the OS temp dir so the rename that finishes
    /// the unpack stays on one filesystem — across filesystems it degrades to a
    /// copy of ~700MB, and stops being atomic, which is the property that makes
    /// a `ComfyUI/` directory's presence mean it is whole.
    pub fn engine_staging(&self) -> PathBuf {
        self.engine().join(".staging")
    }

    /// Where the downloaded tarball lands before it is unpacked. Under `engine/`
    /// so it shares a filesystem with `.staging`, and removed once unpacked.
    pub fn engine_tarball(&self) -> PathBuf {
        self.engine().join(".comfy.tar.gz")
    }

    /// uv's own state, deliberately a sibling of `engine/` rather than a child.
    ///
    /// A reprovision wipes `engine/`. If the wheel cache lived in there it would
    /// go too, and every engine bump would re-download ~6GB of torch (RISK-8)
    /// instead of relinking it from disk. Keeping it under the appdata root and
    /// not in `~/.cache` also means it shares a filesystem with `.venv`, which
    /// is what lets uv hardlink wheels into the venv rather than copying them.
    pub fn uv_home(&self) -> PathBuf {
        self.root.join(".uv")
    }

    /// `UV_CACHE_DIR` — downloaded and unpacked wheels.
    pub fn uv_cache(&self) -> PathBuf {
        self.uv_home().join("cache")
    }

    /// `UV_PYTHON_INSTALL_DIR` — interpreters uv fetched.
    ///
    /// ADR-004 promises we never require a system Python; the flip side is that
    /// uv downloads one, and it belongs under our root where uninstalling the
    /// app removes it, not in uv's own machine-wide default.
    pub fn uv_python(&self) -> PathBuf {
        self.uv_home().join("python")
    }

    /// Records the SHA the engine was provisioned at. Compared against
    /// `engine/comfy.lock` on boot; absent or stale means reprovision.
    pub fn engine_version(&self) -> PathBuf {
        self.engine().join(".version")
    }

    /// Where the engine's stdout/stderr lands (#8).
    ///
    /// A sibling of `engine/`, not a child: a reprovision wipes `engine/`, and
    /// the log of *why* the last run failed is the one thing that must outlive
    /// the reinstall it prompted. It is also the directory "Help → Open Logs"
    /// reveals, so it holds the rotated backups alongside the live file.
    pub fn logs(&self) -> PathBuf {
        self.root.join("logs")
    }

    /// The engine's log file. The log pump appends here and rotates it in place;
    /// its backups are `engine.log.1`, `.2`, … beside it.
    pub fn engine_log(&self) -> PathBuf {
        self.logs().join("engine.log")
    }

    /// Downloaded weights. 12–16 GB per model, and never in the repo.
    pub fn models(&self) -> PathBuf {
        self.root.join("models")
    }

    /// Generated images and video.
    pub fn outputs(&self) -> PathBuf {
        self.root.join("outputs")
    }

    /// Prompt history (SQLite).
    pub fn db(&self) -> PathBuf {
        self.root.join("darkroom.db")
    }

    /// Records the running engine's identity (PID + start time) so a later boot
    /// can find and kill an engine a crash or `SIGKILL` left holding the GPU
    /// (§8.3, ADR-016). Written when the engine spawns, removed at teardown.
    ///
    /// A sibling of `engine/`, not a child: a reprovision wipes `engine/`, and
    /// the pointer to a still-running process must survive that so the reclaim
    /// can still reach it. It is runtime state like `darkroom.db`, not part of
    /// the install, so it lives at the root.
    pub fn engine_pid(&self) -> PathBuf {
        self.root.join("engine.pid")
    }

    /// Creates the directories the app writes into.
    ///
    /// Not `.venv` or `ComfyUI` — those are uv's and the tarball's to make, and
    /// creating them empty would make a half-provisioned engine look present.
    pub fn create_dirs(&self) -> std::io::Result<()> {
        for dir in [self.engine(), self.logs(), self.models(), self.outputs()] {
            std::fs::create_dir_all(dir)?;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn paths() -> Paths {
        Paths::new(PathBuf::from("/tmp/darkroom-test-root"))
    }

    #[test]
    fn everything_lives_under_the_root() {
        let p = paths();
        for path in [
            p.engine(),
            p.venv(),
            p.python(),
            p.comfy(),
            p.comfy_main(),
            p.comfy_requirements(),
            p.engine_staging(),
            p.engine_tarball(),
            p.engine_version(),
            p.logs(),
            p.engine_log(),
            p.uv_home(),
            p.uv_cache(),
            p.uv_python(),
            p.models(),
            p.outputs(),
            p.engine_pid(),
            p.db(),
        ] {
            assert!(
                path.starts_with(p.root()),
                "{} escaped the appdata root",
                path.display()
            );
        }
    }

    #[test]
    fn layout_matches_architecture_7_2() {
        let p = paths();
        let rel = |path: PathBuf| {
            path.strip_prefix(p.root())
                .expect("under root")
                .components()
                .map(|c| c.as_os_str().to_string_lossy().into_owned())
                .collect::<Vec<_>>()
                .join("/")
        };

        assert_eq!(rel(p.engine()), "engine");
        assert_eq!(rel(p.venv()), "engine/.venv");
        assert_eq!(rel(p.comfy()), "engine/ComfyUI");
        assert_eq!(rel(p.comfy_main()), "engine/ComfyUI/main.py");
        assert_eq!(
            rel(p.comfy_requirements()),
            "engine/ComfyUI/requirements.txt"
        );
        assert_eq!(rel(p.engine_staging()), "engine/.staging");
        assert_eq!(rel(p.engine_tarball()), "engine/.comfy.tar.gz");
        assert_eq!(rel(p.engine_version()), "engine/.version");
        assert_eq!(rel(p.logs()), "logs");
        assert_eq!(rel(p.engine_log()), "logs/engine.log");
        assert_eq!(rel(p.uv_home()), ".uv");
        assert_eq!(rel(p.uv_cache()), ".uv/cache");
        assert_eq!(rel(p.uv_python()), ".uv/python");
        assert_eq!(rel(p.models()), "models");
        assert_eq!(rel(p.outputs()), "outputs");
        assert_eq!(rel(p.engine_pid()), "engine.pid");
        assert_eq!(rel(p.db()), "darkroom.db");
    }

    // The pid file must outlive an engine wipe: a reprovision deletes engine/,
    // but a process it left running is still holding the GPU and the pointer to
    // it must survive to be reclaimed. So it sits at the root, not under
    // engine/, the same reasoning as .uv above.
    #[test]
    fn the_pid_file_survives_an_engine_wipe() {
        let p = paths();
        assert!(!p.engine_pid().starts_with(p.engine()));
        assert!(p.engine_pid().starts_with(p.root()));
    }

    // The reason uv_home() is not under engine(): a reprovision deletes the
    // engine tree, and a wheel cache in there would be deleted with it —
    // turning every engine bump into a fresh ~6GB torch download (RISK-8).
    // Nothing else in the code enforces this, so the layout test does.
    #[test]
    fn uv_state_survives_an_engine_wipe() {
        let p = paths();

        assert!(!p.uv_home().starts_with(p.engine()));

        // The other half of the bargain: both under one root means one
        // filesystem, which is what lets uv hardlink cached wheels into the
        // venv instead of copying ~6GB of them.
        assert!(p.uv_cache().starts_with(p.root()));
        assert!(p.venv().starts_with(p.root()));
    }

    // The reason the Rust CI matrix isn't Linux-only: this assertion is the
    // one that differs per OS, and it's wrong on Windows if written by hand
    // on Linux.
    #[test]
    fn python_is_in_the_venv_and_named_for_this_os() {
        let p = paths();
        let python = p.python();

        assert!(python.starts_with(p.venv()));

        let tail: Vec<_> = python
            .strip_prefix(p.venv())
            .expect("under the venv")
            .components()
            .map(|c| c.as_os_str().to_string_lossy().into_owned())
            .collect();

        #[cfg(windows)]
        assert_eq!(tail, ["Scripts", "python.exe"]);
        #[cfg(not(windows))]
        assert_eq!(tail, ["bin", "python"]);
    }

    #[test]
    fn create_dirs_makes_the_writable_dirs_and_repeats_cleanly() {
        let tmp = tempfile::tempdir().expect("temp dir");
        let p = Paths::new(tmp.path());

        p.create_dirs().expect("first create");
        p.create_dirs().expect("create_dirs must be idempotent");

        assert!(p.engine().is_dir());
        assert!(p.logs().is_dir());
        assert!(p.models().is_dir());
        assert!(p.outputs().is_dir());

        // A provisioned-looking engine with nothing in it would make the
        // bootstrap skip work it hasn't done.
        assert!(!p.venv().exists());
        assert!(!p.comfy().exists());
    }

    #[test]
    fn create_dirs_builds_missing_parents() {
        let tmp = tempfile::tempdir().expect("temp dir");
        let p = Paths::new(tmp.path().join("does").join("not").join("exist"));

        p.create_dirs().expect("nested root");

        assert!(p.outputs().is_dir());
    }
}
