//! Single source of truth for the appdata layout (ARCHITECTURE §7.2).
//!
//! ```text
//! <app_data_dir>/
//! ├── engine/
//! │   ├── .venv/          # uv-managed
//! │   ├── ComfyUI/        # pinned SHA, tarball
//! │   └── .version        # matches comfy.lock when healthy
//! ├── models/
//! ├── outputs/
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

    /// Records the SHA the engine was provisioned at. Compared against
    /// `engine/comfy.lock` on boot; absent or stale means reprovision.
    pub fn engine_version(&self) -> PathBuf {
        self.engine().join(".version")
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

    /// Creates the directories the app writes into.
    ///
    /// Not `.venv` or `ComfyUI` — those are uv's and the tarball's to make, and
    /// creating them empty would make a half-provisioned engine look present.
    pub fn create_dirs(&self) -> std::io::Result<()> {
        for dir in [self.engine(), self.models(), self.outputs()] {
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
            p.engine_version(),
            p.models(),
            p.outputs(),
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
        assert_eq!(rel(p.engine_version()), "engine/.version");
        assert_eq!(rel(p.models()), "models");
        assert_eq!(rel(p.outputs()), "outputs");
        assert_eq!(rel(p.db()), "darkroom.db");
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
