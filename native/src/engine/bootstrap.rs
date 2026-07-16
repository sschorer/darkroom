//! Provisions the engine: ComfyUI at the pinned SHA, in a uv-built venv.
//!
//! This is ADR-004 made real, and the ~10 minute first run it predicted. The
//! shape is fixed by two things:
//!
//! - **`.version` is written last.** Every step before it is re-runnable and
//!   leaves nothing that looks finished. The file's presence is the only claim
//!   that an install is whole, so nothing may write it early (§8.2).
//! - **A mismatch wipes rather than patches.** There is no upgrade path from one
//!   engine pin to another; `uv pip install` into a venv built for a different
//!   torch is how you get an install that imports but doesn't run. Wiping costs
//!   time, which RISK-8 accepts, and the wheel cache lives outside `engine/`
//!   precisely so the cost is minutes rather than another 6GB.
//!
//! Progress reporting is #5. This runs silently for ten minutes, which is the
//! known and temporary state of things — the errors are already actionable
//! (§8.6), the byte counts are not yet anywhere a user can see.

use std::path::Path;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Runtime};
use tauri_plugin_shell::ShellExt;

use crate::engine::archive::{self, ArchiveError};
use crate::engine::lock::{Lock, LockError};
use crate::paths::Paths;

/// How much engine log to carry into an error message.
///
/// §8.6: a spawn failure must surface the tail of the log, not a status code. A
/// pip resolution failure prints its useful part last and its banner first, so
/// the tail is the half worth keeping — but a torch build log can be megabytes,
/// and pasting all of it into an IPC payload helps nobody.
const ERROR_TAIL_LINES: usize = 40;

#[derive(Debug, thiserror::Error)]
pub enum BootstrapError {
    #[error(transparent)]
    Lock(#[from] LockError),

    #[error(transparent)]
    Archive(#[from] ArchiveError),

    #[error("could not prepare {path}: {source}")]
    Io {
        path: String,
        #[source]
        source: std::io::Error,
    },

    #[error(
        "could not download ComfyUI from {url}: {source}\n  \
         Setup needs the network once. Check the connection and try again — \
         nothing has been installed."
    )]
    Download {
        url: String,
        #[source]
        source: reqwest::Error,
    },

    #[error("{url} returned {status}.\n  The pinned engine revision may have been withdrawn; this is a bug in Darkroom, not a problem with your machine.")]
    DownloadStatus { url: String, status: u16 },

    #[error("could not run the bundled uv: {source}\n  The sidecar is missing or was not permitted to execute.")]
    Sidecar {
        #[source]
        source: tauri_plugin_shell::Error,
    },

    /// Distinct from `Sidecar`: the probe spawns the venv interpreter, not uv,
    /// so blaming the sidecar here sends a broken-venv report down the wrong
    /// path (§8.6).
    #[error("could not run the engine's Python: {source}\n  The venv may be corrupt; reinstalling the engine should fix it.")]
    Python {
        #[source]
        source: tauri_plugin_shell::Error,
    },

    /// The one users actually hit: uv ran and said no.
    #[error("{step} failed (exit {code}).\n\n{tail}")]
    Uv {
        step: &'static str,
        code: String,
        tail: String,
    },

    #[error(
        "the engine installed but torch could not be imported.\n\n{tail}\n\n  \
         The install completed, so suspect the GPU driver or a missing system library."
    )]
    TorchImport { tail: String },

    #[error("torch reported something this build does not understand: {0}")]
    TorchProbe(String),

    /// A panic or a cancellation inside the blocking unpack task. Not reachable
    /// by anything a user does, but `unwrap()` on a JoinHandle is exactly the
    /// panic CLAUDE.md forbids, so it gets a name.
    #[error("the engine unpack task did not finish: {0}")]
    TaskFailed(String),
}

/// What hardware torch found once it was installed.
///
/// Recorded rather than enforced. Refusing to finish a bootstrap on a CPU-only
/// machine would be a ten-minute wait ending in a wall; recording it lets the UI
/// say so plainly, and lets VRAM gating (#20) make the real decision with the
/// real numbers.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Accelerator {
    /// What every supported configuration should report (§7.2).
    Cuda,
    /// macOS. Bootstraps and imports; not a supported generation path (TD-2).
    Mps,
    /// Installed correctly, will render at unusable speed.
    Cpu,
}

/// The contents of `engine/.version`. Presence means the install is whole.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Installed {
    /// The commit. For humans and for the log — the comparison uses `lock_digest`.
    pub comfy_sha: String,

    /// The pin this install came from, as a whole. See [`Lock::digest`] for why
    /// this and not the SHA is what gets compared.
    pub lock_digest: String,

    pub accelerator: Accelerator,

    /// e.g. `2.13.0+cu129`. Purely diagnostic, and the fastest way to answer
    /// "why is this machine slow" — a bare `2.13.0` here is a CPU wheel.
    pub torch: String,
}

/// Whether the engine on disk can be used.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "state", rename_all = "lowercase")]
pub enum Status {
    /// Never provisioned, or provisioned and since broken. Both need the same
    /// work, so they are not worth distinguishing to a caller.
    Missing,

    /// Provisioned against a different pin. §8.2: generation stays blocked until
    /// this is resolved, because an app update can ship a workflow needing nodes
    /// the installed engine doesn't have.
    Stale {
        installed: Installed,
        pinned: String,
    },

    Ready {
        installed: Installed,
    },
}

/// Reads `engine/.version` and decides what it means.
///
/// Cheap and side-effect free — safe to call on every boot, which is exactly
/// what §8.2 asks for.
pub fn status(paths: &Paths) -> Result<Status, BootstrapError> {
    let lock = Lock::pinned()?;

    let Ok(raw) = std::fs::read_to_string(paths.engine_version()) else {
        return Ok(Status::Missing);
    };

    // A `.version` we can't parse is a `.version` from a build that wrote a
    // different shape. Treat it as absent rather than guessing: reprovisioning
    // is slow but correct, and there is nothing here worth salvaging.
    let Ok(installed) = serde_json::from_str::<Installed>(&raw) else {
        return Ok(Status::Missing);
    };

    // `.version` is written last, so it should never outlive the things it
    // describes — but a user can delete a directory, and an antivirus can eat an
    // interpreter. Trusting the stamp over the filesystem here would mean
    // spawning an engine that isn't there and reporting it as a spawn failure.
    if !paths.python().is_file() || !paths.comfy_main().is_file() {
        return Ok(Status::Missing);
    }

    if installed.lock_digest != lock.digest() {
        return Ok(Status::Stale {
            installed,
            pinned: lock.sha.clone(),
        });
    }

    Ok(Status::Ready { installed })
}

/// Brings the engine to the pinned revision, doing nothing if it is already there.
///
/// Idempotent, and safe to call again after a failure: everything it writes is
/// either scratch or replaced wholesale on the next attempt.
pub async fn provision<R: Runtime>(
    app: &AppHandle<R>,
    paths: &Paths,
) -> Result<Installed, BootstrapError> {
    let lock = Lock::pinned()?;

    if let Status::Ready { installed } = status(paths)? {
        return Ok(installed);
    }

    paths.create_dirs().map_err(|source| BootstrapError::Io {
        path: paths.root().display().to_string(),
        source,
    })?;

    // Remove the claim before invalidating the thing it describes. If the
    // machine dies anywhere in the middle of what follows, the engine must not
    // still be advertising itself as healthy.
    remove_file(&paths.engine_version())?;

    fetch_comfy(paths, lock).await?;
    create_venv(app, paths, lock).await?;
    install_torch(app, paths, lock).await?;
    install_requirements(app, paths).await?;

    let installed = probe(app, paths, lock).await?;

    // Last, and only now. Everything above is proven.
    let json = serde_json::to_string_pretty(&installed)
        .map_err(|e| BootstrapError::TaskFailed(e.to_string()))?;
    std::fs::write(paths.engine_version(), json).map_err(|source| BootstrapError::Io {
        path: paths.engine_version().display().to_string(),
        source,
    })?;

    Ok(installed)
}

async fn fetch_comfy(paths: &Paths, lock: &Lock) -> Result<(), BootstrapError> {
    let url = lock.tarball_url();

    let res = reqwest::get(&url)
        .await
        .map_err(|source| BootstrapError::Download {
            url: url.clone(),
            source,
        })?;

    if !res.status().is_success() {
        return Err(BootstrapError::DownloadStatus {
            url,
            status: res.status().as_u16(),
        });
    }

    // Held in memory rather than streamed: the archive is ~12MB. #17's weight
    // downloads are 14GB and stream to a `.part`; this one does not need that
    // machinery, and pretending it does would be the wrong kind of symmetry.
    let bytes = res
        .bytes()
        .await
        .map_err(|source| BootstrapError::Download { url, source })?;

    let staging = paths.engine_staging();
    let tarball = paths.engine_tarball();
    std::fs::write(&tarball, &bytes).map_err(|source| BootstrapError::Io {
        path: tarball.display().to_string(),
        source,
    })?;

    let comfy = paths.comfy();
    let root = lock.tarball_root();

    // flate2 and tar are synchronous and this is ~700MB of writes. On the async
    // runtime's thread it would stall every other task for the duration.
    let unpacked = tauri::async_runtime::spawn_blocking({
        let tarball = tarball.clone();
        move || archive::unpack_stripped(&tarball, &staging, &comfy, &root)
    })
    .await;

    let _ = std::fs::remove_file(&tarball);

    match unpacked {
        Ok(result) => result?,
        Err(join) => return Err(BootstrapError::TaskFailed(join.to_string())),
    }

    Ok(())
}

async fn create_venv<R: Runtime>(
    app: &AppHandle<R>,
    paths: &Paths,
    lock: &Lock,
) -> Result<(), BootstrapError> {
    // Wiped rather than reused: `uv venv` would happily build over the old one,
    // and a venv holding a previous pin's torch is the failure this whole
    // function exists to avoid.
    remove_dir(&paths.venv())?;

    uv(
        app,
        paths,
        "creating the Python environment",
        &[
            "venv".into(),
            "--python".into(),
            lock.python.clone(),
            paths.venv().display().to_string(),
        ],
    )
    .await
}

/// Installs torch *before* `requirements.txt`, from PyTorch's own index.
///
/// This is the step that makes the Windows install real — see [`Torch`] for why
/// `-r requirements.txt` alone yields a CPU-only torch there. The later
/// requirements install sees torch already satisfied (ComfyUI pins no version)
/// and leaves it alone.
///
/// [`Torch`]: crate::engine::lock::Torch
async fn install_torch<R: Runtime>(
    app: &AppHandle<R>,
    paths: &Paths,
    lock: &Lock,
) -> Result<(), BootstrapError> {
    let Some(index) = lock.torch.index_url.host() else {
        // macOS: PyPI's own wheel is the MPS one. `requirements.txt` will fetch it.
        return Ok(());
    };

    let mut args = vec![
        "pip".into(),
        "install".into(),
        "--python".into(),
        paths.python().display().to_string(),
        // Replaces PyPI rather than adding to it (`--extra-index-url`). That is
        // deliberate and it works because the cu* index self-hosts torch's whole
        // dependency tree. With an extra index, uv is free to prefer PyPI's
        // same-versioned CPU `torch` and we would be back where we started.
        "--index-url".into(),
        index.to_owned(),
    ];
    args.extend(lock.torch.packages.iter().cloned());

    uv(app, paths, "installing PyTorch", &args).await
}

async fn install_requirements<R: Runtime>(
    app: &AppHandle<R>,
    paths: &Paths,
) -> Result<(), BootstrapError> {
    uv(
        app,
        paths,
        "installing ComfyUI's dependencies",
        &[
            "pip".into(),
            "install".into(),
            "--python".into(),
            paths.python().display().to_string(),
            "-r".into(),
            paths.comfy_requirements().display().to_string(),
        ],
    )
    .await
}

/// What torch says about itself, asked in torch's own language.
const PROBE: &str = "\
import json, torch
if torch.cuda.is_available():
    accel = 'cuda'
elif getattr(torch.backends, 'mps', None) is not None and torch.backends.mps.is_available():
    accel = 'mps'
else:
    accel = 'cpu'
print(json.dumps({'torch': torch.__version__, 'accelerator': accel}))
";

#[derive(Deserialize)]
struct Probe {
    torch: String,
    accelerator: Accelerator,
}

/// Imports torch and asks what it found.
///
/// This is the step that decides whether the ten minutes were worth anything.
/// Everything before it can succeed on a machine where torch cannot load a CUDA
/// library at all — `uv pip install` only proves the wheels unpacked.
async fn probe<R: Runtime>(
    app: &AppHandle<R>,
    paths: &Paths,
    lock: &Lock,
) -> Result<Installed, BootstrapError> {
    let out = app
        .shell()
        .command(paths.python())
        .args(["-c", PROBE])
        .output()
        .await
        .map_err(|source| BootstrapError::Python { source })?;

    if !out.status.success() {
        return Err(BootstrapError::TorchImport {
            tail: tail(&combined(&out.stdout, &out.stderr)),
        });
    }

    let stdout = String::from_utf8_lossy(&out.stdout);
    let probe: Probe = serde_json::from_str(stdout.trim())
        .map_err(|e| BootstrapError::TorchProbe(format!("{e}\n  output: {stdout}")))?;

    Ok(Installed {
        comfy_sha: lock.sha.clone(),
        lock_digest: lock.digest(),
        accelerator: probe.accelerator,
        torch: probe.torch,
    })
}

/// Runs the bundled uv.
///
/// The environment is the interesting part. Both variables point uv's state at
/// appdata: without them uv writes its cache to `~/.cache/uv` and its
/// interpreters to a machine-wide directory, which means uninstalling Darkroom
/// leaves several GB behind, and — the part that actually costs the user time —
/// the cache may land on a different filesystem than the venv, downgrading uv's
/// hardlinks into copies of ~6GB of wheels.
async fn uv<R: Runtime>(
    app: &AppHandle<R>,
    paths: &Paths,
    step: &'static str,
    args: &[String],
) -> Result<(), BootstrapError> {
    let out = app
        .shell()
        .sidecar("uv")
        .map_err(|source| BootstrapError::Sidecar { source })?
        .env("UV_CACHE_DIR", paths.uv_cache())
        .env("UV_PYTHON_INSTALL_DIR", paths.uv_python())
        // uv's default is to fetch an interpreter when none matches, which is
        // ADR-004's whole promise. Stated rather than inherited: a default that
        // load-bearing should not be able to change out from under us on a uv
        // bump.
        .env("UV_PYTHON_DOWNLOADS", "automatic")
        // Progress bars redraw with carriage returns; captured to a pipe they
        // become one unreadable line. #5 replaces this with real reporting.
        .env("UV_NO_PROGRESS", "1")
        .args(args)
        .output()
        .await
        .map_err(|source| BootstrapError::Sidecar { source })?;

    if !out.status.success() {
        return Err(BootstrapError::Uv {
            step,
            code: out
                .status
                .code()
                .map(|c| c.to_string())
                // No code means a signal killed it; "unknown" is honest, and 0
                // would be a lie that reads as success.
                .unwrap_or_else(|| "unknown".to_owned()),
            tail: tail(&combined(&out.stdout, &out.stderr)),
        });
    }

    Ok(())
}

/// uv reports diagnostics on stderr and results on stdout, and a failure can
/// have its explanation in either.
///
/// Takes the streams rather than the `Output` so it is testable: the plugin's
/// `ExitStatus` can't be constructed outside the crate, so a test that wanted an
/// `Output` couldn't build one.
fn combined(stdout: &[u8], stderr: &[u8]) -> String {
    let mut s = String::from_utf8_lossy(stdout).into_owned();
    if !stderr.is_empty() {
        if !s.is_empty() && !s.ends_with('\n') {
            s.push('\n');
        }
        s.push_str(&String::from_utf8_lossy(stderr));
    }
    s
}

fn tail(s: &str) -> String {
    let lines: Vec<&str> = s.lines().collect();
    let start = lines.len().saturating_sub(ERROR_TAIL_LINES);
    lines[start..].join("\n")
}

fn remove_file(path: &Path) -> Result<(), BootstrapError> {
    match std::fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(source) => Err(BootstrapError::Io {
            path: path.display().to_string(),
            source,
        }),
    }
}

fn remove_dir(path: &Path) -> Result<(), BootstrapError> {
    match std::fs::remove_dir_all(path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(source) => Err(BootstrapError::Io {
            path: path.display().to_string(),
            source,
        }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Builds an engine tree that looks provisioned, so `status` has something
    /// to read. Everything here is what `provision` would have left behind.
    fn provisioned(paths: &Paths, installed: &Installed) {
        std::fs::create_dir_all(paths.comfy()).expect("comfy dir");
        std::fs::write(paths.comfy_main(), "# main").expect("main.py");

        let python = paths.python();
        std::fs::create_dir_all(python.parent().expect("venv bin")).expect("venv bin");
        std::fs::write(&python, "#!").expect("python");

        std::fs::write(
            paths.engine_version(),
            serde_json::to_string(installed).expect("encode"),
        )
        .expect(".version");
    }

    fn installed_at_the_pin() -> Installed {
        let lock = Lock::pinned().expect("valid lock");
        Installed {
            comfy_sha: lock.sha.clone(),
            lock_digest: lock.digest(),
            accelerator: Accelerator::Cuda,
            torch: "2.13.0+cu129".to_owned(),
        }
    }

    #[test]
    fn a_fresh_machine_is_missing() {
        let tmp = tempfile::tempdir().expect("temp dir");
        let paths = Paths::new(tmp.path());

        assert_eq!(status(&paths).expect("status"), Status::Missing);
    }

    #[test]
    fn a_matching_install_is_ready() {
        let tmp = tempfile::tempdir().expect("temp dir");
        let paths = Paths::new(tmp.path());
        let installed = installed_at_the_pin();
        provisioned(&paths, &installed);

        assert_eq!(status(&paths).expect("status"), Status::Ready { installed });
    }

    /// §8.2's engine track: a bumped pin must be detected at boot.
    #[test]
    fn an_install_from_another_pin_is_stale() {
        let tmp = tempfile::tempdir().expect("temp dir");
        let paths = Paths::new(tmp.path());
        let mut installed = installed_at_the_pin();
        installed.lock_digest =
            "sha256:0000000000000000000000000000000000000000000000000000000000000000".to_owned();
        provisioned(&paths, &installed);

        assert!(matches!(
            status(&paths).expect("status"),
            Status::Stale { .. }
        ));
    }

    /// The reason `.version` records a digest of the whole lock and not the SHA.
    /// Changing the torch index invalidates every venv while leaving `sha`
    /// alone; a SHA comparison would call these installs healthy forever.
    #[test]
    fn changing_the_pin_without_changing_the_sha_is_still_stale() {
        let tmp = tempfile::tempdir().expect("temp dir");
        let paths = Paths::new(tmp.path());
        let lock = Lock::pinned().expect("valid lock");

        let mut installed = installed_at_the_pin();
        assert_eq!(installed.comfy_sha, lock.sha);
        installed.lock_digest = "sha256:deadbeef".to_owned(); // e.g. cu128 -> cu129
        provisioned(&paths, &installed);

        assert!(
            matches!(status(&paths).expect("status"), Status::Stale { .. }),
            "a lock edit that leaves the sha alone must still force a reprovision"
        );
    }

    /// The stamp is written last, so it should never outlive what it describes —
    /// but users delete directories and antivirus eats interpreters.
    #[test]
    fn a_version_stamp_without_an_interpreter_is_missing_not_ready() {
        let tmp = tempfile::tempdir().expect("temp dir");
        let paths = Paths::new(tmp.path());
        provisioned(&paths, &installed_at_the_pin());
        std::fs::remove_file(paths.python()).expect("remove python");

        assert_eq!(status(&paths).expect("status"), Status::Missing);
    }

    #[test]
    fn a_version_stamp_without_comfyui_is_missing_not_ready() {
        let tmp = tempfile::tempdir().expect("temp dir");
        let paths = Paths::new(tmp.path());
        provisioned(&paths, &installed_at_the_pin());
        std::fs::remove_dir_all(paths.comfy()).expect("remove comfy");

        assert_eq!(status(&paths).expect("status"), Status::Missing);
    }

    /// A `.version` from a build that wrote a different shape.
    #[test]
    fn an_unreadable_version_stamp_is_missing_not_an_error() {
        let tmp = tempfile::tempdir().expect("temp dir");
        let paths = Paths::new(tmp.path());
        provisioned(&paths, &installed_at_the_pin());
        std::fs::write(paths.engine_version(), "{ not json").expect("clobber");

        assert_eq!(status(&paths).expect("status"), Status::Missing);
    }

    #[test]
    fn the_probe_output_shape_is_the_one_we_parse() {
        let probe: Probe = serde_json::from_str(r#"{"torch":"2.13.0+cu129","accelerator":"cuda"}"#)
            .expect("probe output must parse");

        assert_eq!(probe.torch, "2.13.0+cu129");
        assert_eq!(probe.accelerator, Accelerator::Cuda);
    }

    #[test]
    fn every_accelerator_the_probe_can_print_is_one_we_understand() {
        for (json, expected) in [
            ("cuda", Accelerator::Cuda),
            ("mps", Accelerator::Mps),
            ("cpu", Accelerator::Cpu),
        ] {
            let parsed: Accelerator =
                serde_json::from_str(&format!("\"{json}\"")).expect("known accelerator");
            assert_eq!(parsed, expected);
        }
    }

    /// §8.6: the tail is the half of a pip failure that says what went wrong.
    #[test]
    fn error_tails_keep_the_end_and_stay_bounded() {
        let long: String = (0..500).map(|i| format!("line {i}\n")).collect();
        let tail = tail(&long);

        assert_eq!(tail.lines().count(), ERROR_TAIL_LINES);
        assert!(tail.ends_with("line 499"));
        assert!(!tail.contains("line 0\n"));
    }

    #[test]
    fn short_output_is_not_truncated() {
        assert_eq!(tail("only line"), "only line");
        assert_eq!(tail(""), "");
    }

    /// uv puts a resolution failure on stderr and progress on stdout, and which
    /// stream carries the explanation depends on the failure. Reading only one
    /// is how an error message comes back empty.
    #[test]
    fn combined_output_carries_both_streams() {
        let both = combined(b"resolved 40 packages", b"error: no solution found");
        assert!(both.contains("resolved 40 packages"));
        assert!(both.contains("error: no solution found"));

        // The join must not run the last stdout line into the first stderr one.
        assert!(both.contains("packages\nerror"));

        assert_eq!(
            combined(b"", b"error: no solution found"),
            "error: no solution found"
        );
        assert_eq!(combined(b"done\n", b""), "done\n");
    }
}
