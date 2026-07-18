//! The download *manager*: installing a whole model, over `download::fetch`.
//!
//! [`download`](crate::download) is one file at a time — resumable, verified,
//! Tauri-free by design (its own doc says wiring "belongs to the command layer
//! and the download manager"). This module is that manager. A model's manifest
//! names several files (a diffusion model, a text encoder, a VAE), and #21's
//! done-criterion is *install a model from a clean state without a terminal*, so
//! the unit the user acts on is the model, not the file. [`install`] fetches a
//! model's files in turn, and reports across the batch: which file is in flight,
//! its bytes and speed, and the running total over *all* the files so a single
//! bar can track the whole install.
//!
//! Three things this layer owns that a single fetch cannot:
//!
//! - **The batch total.** [`fetch`](crate::download::fetch)'s progress is one
//!   file's `received`/`total`; the aggregate bar needs the sum across files and
//!   how far the completed ones already carried it. [`install`] keeps that and
//!   folds it into every [`DownloadProgress`], so the frontend stays dumb.
//! - **Speed.** A byte count is not a rate. The manager samples the deltas
//!   `fetch` hands it (throttled to ~4/s, §8.4) into a bytes-per-second figure —
//!   the input to the ETA the UI shows.
//! - **The verifying state.** A resumed `.part` is re-hashed on open before a
//!   single new byte is asked for (you cannot resume a SHA-256 — `download`'s
//!   module doc). For a 14GB partial that is tens of seconds during which a
//!   naive bar sits frozen, the exact "is it hung?" failure QS-2 forbids. So
//!   when a `.part` is present the manager announces [`Phase::Verifying`] before
//!   handing off, and the first byte-progress from `fetch` flips it to
//!   [`Phase::Downloading`]. It is a *state*, not a sub-bar: granular re-hash
//!   progress would mean threading a callback through `download`'s hot, tested,
//!   trap-laden open path, and a clean install — the actual done-criterion —
//!   never re-hashes at all, so the cost is not worth the seam.
//!
//! Like `download`, this stays free of Tauri: [`install`] reports through a
//! caller-supplied closure and cancels through a [`watch`] channel, so the whole
//! orchestration is exercisable against a temp dir and a local server (below).
//! The command layer binds the closure to `app.emit` and the channel to a
//! `cancel_download` command.

use std::path::{Component, Path, PathBuf};
use std::time::Instant;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Runtime};
use tokio::sync::watch;

use crate::download;

/// The Tauri event carrying [`DownloadProgress`] to the frontend. The payload
/// *type* is generated for `app/lib/download.ts` by ts-rs (ADR-018); this event
/// *name* is the one string still matched by hand on the TS side, exactly as
/// `engine://progress` is.
pub const EVENT: &str = "download://progress";

/// One file of a model's manifest, as the frontend hands it across `invoke`.
///
/// The canonical definition is the zod schema (`registry.schema.ts`, `FileSpec`)
/// — the CI gate and the app's runtime contract in one (ADR-005) — so this is
/// deliberately *not* ts-exported: it is the receiving mirror of a type that
/// already has a single home, and generating a second would fork it. The fields
/// that matter to a download are all that are read; the rest of a manifest stays
/// on the TS side.
#[derive(Debug, Clone, Deserialize)]
pub struct FileSpec {
    pub url: String,
    /// Manifest-relative, `models/…` (schema-enforced). [`resolve_dest`]
    /// re-checks the confinement here rather than trusting the renderer — the
    /// IPC boundary is a surface (§8.4), and a path escaping `models/` is the
    /// one thing a bad `dest` could do that a wrong `url` cannot.
    pub dest: String,
    pub sha256: String,
    pub size: u64,
}

/// Which part of a file's lifecycle a [`DownloadProgress`] describes.
///
/// Two states, because they are the two things that take real time and read
/// differently to a waiting user: re-hashing an existing partial, and streaming
/// bytes. Serialised lowercase so the frontend narrows on `phase` the same way
/// it does the engine bootstrap's.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, export_to = "./"))]
#[serde(rename_all = "lowercase")]
pub enum Phase {
    /// Re-hashing a resumed `.part` before asking for more (or re-verifying a
    /// partial that is already whole). `bytes_per_sec` is 0 here — nothing is
    /// arriving — and `received` is what is already on disk.
    Verifying,
    /// Streaming bytes into the `.part`.
    Downloading,
}

/// A single progress update for a model install.
///
/// Carries both the in-flight file's numbers *and* the batch's, so one event is
/// everything the UI needs for both the per-file line and the aggregate bar — no
/// state accumulated on the frontend, nothing to get out of sync. The `u64`
/// fields are `number` on the wire, not `bigint`: Tauri's IPC serialises them as
/// JSON numbers and an 8GB weight is far below `2^53` (ADR-018).
#[derive(Debug, Clone, Serialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, export_to = "./"))]
pub struct DownloadProgress {
    /// The manifest `dest` of the file in flight, so the UI can name it.
    pub file: String,
    /// 0-based position of that file among the model's files.
    pub file_index: usize,
    /// How many files the model has in total.
    pub file_count: usize,
    pub phase: Phase,
    /// Bytes on disk for *this* file.
    #[cfg_attr(feature = "ts", ts(type = "number"))]
    pub received: u64,
    /// This file's declared size.
    #[cfg_attr(feature = "ts", ts(type = "number"))]
    pub total: u64,
    /// Instantaneous rate, 0 while verifying or before a second sample exists.
    #[cfg_attr(feature = "ts", ts(type = "number"))]
    pub bytes_per_sec: u64,
    /// Bytes on disk across *every* file (completed ones in full plus this
    /// one's `received`) — the numerator of the aggregate bar.
    #[cfg_attr(feature = "ts", ts(type = "number"))]
    pub batch_received: u64,
    /// The sum of every file's declared size — the aggregate denominator.
    #[cfg_attr(feature = "ts", ts(type = "number"))]
    pub batch_total: u64,
}

/// How an [`install`] ended, when it did not error.
///
/// A cancel is a user action, not a failure, so it is an `Ok` value the UI reads
/// rather than an error string it has to pattern-match out of the failure path:
/// `Completed` lands on "installed", `Cancelled` returns to a resumable idle
/// with the `.part` intact.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, export_to = "./"))]
#[serde(rename_all = "lowercase")]
pub enum DownloadOutcome {
    Completed,
    Cancelled,
}

/// Whether one file of a model is on disk, partway, or absent.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, export_to = "./"))]
#[serde(rename_all = "lowercase")]
pub enum FileState {
    /// `dest` exists — and by §8.4 that means verified, nothing re-checks it.
    Present,
    /// A `.part` exists but `dest` does not: an interrupted download to resume.
    Partial,
    /// Neither — nothing downloaded yet.
    Missing,
}

/// One file's install state, for [`status`].
#[derive(Debug, Clone, Serialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, export_to = "./"))]
pub struct FileStatus {
    pub dest: String,
    #[cfg_attr(feature = "ts", ts(type = "number"))]
    pub size: u64,
    /// Bytes already on disk: the full `size` when `Present`, the `.part` length
    /// when `Partial`, 0 when `Missing`.
    #[cfg_attr(feature = "ts", ts(type = "number"))]
    pub downloaded: u64,
    pub state: FileState,
}

/// A model's install state as a whole, for the manager to render before (and
/// after) a download — the difference between offering "Download", "Resume", or
/// "Installed", and showing how much a resume already has.
#[derive(Debug, Clone, Serialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, export_to = "./"))]
pub struct ModelStatus {
    /// True iff every file is `Present` — the model is ready to generate with.
    pub installed: bool,
    #[cfg_attr(feature = "ts", ts(type = "number"))]
    pub downloaded: u64,
    #[cfg_attr(feature = "ts", ts(type = "number"))]
    pub total: u64,
    pub files: Vec<FileStatus>,
}

/// Emits a progress event, best-effort — a dropped update must never fail an
/// install, exactly as `engine::progress::emit` documents. The window can close
/// mid-download; the `.part` on disk is the truth, not who is listening.
pub fn emit<R: Runtime>(app: &AppHandle<R>, progress: DownloadProgress) {
    let _ = app.emit(EVENT, progress);
}

/// Resolves a manifest `dest` to an absolute path under `models_dir`, refusing
/// anything that would escape it.
///
/// The zod schema already confines `dest` to `models/…` with no `..`, but this
/// is the IPC boundary (§8.4) and a compromised renderer is exactly what a
/// server-side check exists for: a `dest` of `models/../engine/main.py` would,
/// unchecked, let a "download" overwrite the engine. So the `models/` prefix is
/// stripped and the remainder is required to be a plain relative path — no root,
/// no prefix, no parent component — before it is joined under the models dir.
fn resolve_dest(models_dir: &Path, dest: &str) -> Result<PathBuf, String> {
    let rel = dest
        .strip_prefix("models/")
        .ok_or_else(|| format!("refusing to download {dest}: it must live under models/"))?;

    let rel = Path::new(rel);
    let safe = rel.components().all(|c| matches!(c, Component::Normal(_)));
    if !safe || rel.as_os_str().is_empty() {
        return Err(format!(
            "refusing to download {dest}: it is not a valid model path"
        ));
    }

    Ok(models_dir.join(rel))
}

/// The current install state of the model whose files these are.
///
/// A pure read of the filesystem — no network — so the manager can render the
/// right affordance on mount and refresh it after a download settles. `dest`
/// present is verified-and-whole (§8.4); a `.part` beside an absent `dest` is a
/// resume; neither is a clean slate.
pub fn status(models_dir: &Path, files: &[FileSpec]) -> Result<ModelStatus, String> {
    let mut out = Vec::with_capacity(files.len());
    let mut downloaded = 0u64;
    let mut total = 0u64;
    let mut installed = true;

    for file in files {
        let dest = resolve_dest(models_dir, &file.dest)?;
        total = total.saturating_add(file.size);

        let (state, got) = if dest.exists() {
            (FileState::Present, file.size)
        } else if let Some(part_len) = part_len(&dest) {
            installed = false;
            // Cap at the declared size: a `.part` can momentarily read longer
            // than `size` (a mirror over-sending) and a bar past 100% is a bug
            // the user sees. `fetch` stops such a stream, but `status` only
            // observes, so it clamps.
            (FileState::Partial, part_len.min(file.size))
        } else {
            installed = false;
            (FileState::Missing, 0)
        };

        downloaded = downloaded.saturating_add(got);
        out.push(FileStatus {
            dest: file.dest.clone(),
            size: file.size,
            downloaded: got,
            state,
        });
    }

    Ok(ModelStatus {
        installed,
        downloaded,
        total,
        files: out,
    })
}

/// The byte length of a `dest`'s `.part`, or `None` if there is no partial.
fn part_len(dest: &Path) -> Option<u64> {
    let part = download::part_path(dest).ok()?;
    std::fs::metadata(part).ok().map(|m| m.len())
}

/// Downloads every file of a model, in order, reporting batch progress.
///
/// Files already `Present` are skipped (their bytes still count toward the batch
/// total, so a partial install's bar starts where it left off, not at zero). For
/// each remaining file the space is pre-checked as a batch up front — §8.5's
/// `sum(size) * 1.1`, refused before the first byte rather than at 12 of 14GB —
/// and then [`fetch`](crate::download::fetch) runs, its per-file byte progress
/// wrapped into [`DownloadProgress`] with the batch numbers and a sampled rate.
///
/// **Cancellation** is a [`watch`] flag the command layer flips. It is checked
/// before each file and *raced against the in-flight fetch* with `select!`, so a
/// cancel mid-download drops the fetch future — which `download` documents as
/// safe: the `.part` is left intact for a later resume, and nothing half-written
/// is renamed into place. A cancel returns `Ok(Cancelled)`, not an error.
pub async fn install(
    client: &reqwest::Client,
    models_dir: &Path,
    files: &[FileSpec],
    mut cancel: watch::Receiver<bool>,
    mut on_progress: impl FnMut(DownloadProgress),
) -> Result<DownloadOutcome, String> {
    // Resolve every dest first: a bad path should fail the whole install before
    // any byte lands, not halfway through when three files are already down.
    let dests: Vec<PathBuf> = files
        .iter()
        .map(|f| resolve_dest(models_dir, &f.dest))
        .collect::<Result<_, _>>()?;

    let batch_total: u64 = files.iter().fold(0u64, |acc, f| acc.saturating_add(f.size));

    // Space for the files not already on disk, as one batch (§8.5).
    let missing_sizes = files
        .iter()
        .zip(&dests)
        .filter(|(_, dest)| !dest.exists())
        .map(|(f, _)| f.size);
    download::ensure_space(models_dir, missing_sizes).map_err(|e| e.to_string())?;

    // Bytes carried by files already fully on disk, plus each one as it finishes
    // — the base the in-flight file's `received` is added to for the batch bar.
    let mut batch_base: u64 = 0;

    for (index, (file, dest)) in files.iter().zip(&dests).enumerate() {
        if dest.exists() {
            batch_base = batch_base.saturating_add(file.size);
            continue;
        }

        // A cancel that arrived between files: honour it before opening the next.
        // `borrow_and_update` marks this value seen so the `changed()` below only
        // fires on a *later* flip, not on this same already-observed state.
        if *cancel.borrow_and_update() {
            return Ok(DownloadOutcome::Cancelled);
        }

        // A resumed `.part` is about to be re-hashed on open (you cannot resume a
        // SHA-256): announce the verifying state before the fetch so the bar
        // doesn't sit frozen through it. The fetch's first byte-progress — which
        // fires right after open — flips this to Downloading.
        if let Some(part_len) = part_len(dest) {
            let received = part_len.min(file.size);
            on_progress(DownloadProgress {
                file: file.dest.clone(),
                file_index: index,
                file_count: files.len(),
                phase: Phase::Verifying,
                received,
                total: file.size,
                bytes_per_sec: 0,
                batch_received: batch_base.saturating_add(received),
                batch_total,
            });
        }

        // Per-file rate sampler: the deltas between `fetch`'s throttled callbacks
        // turned into bytes/sec. Fresh per file so one file's speed never bleeds
        // into the next's opening reading.
        let mut prev: Option<(Instant, u64)> = None;
        let file_dest = file.dest.clone();
        let file_size = file.size;
        let file_count = files.len();
        let on_file = |p: download::Progress| {
            let now = Instant::now();
            let bytes_per_sec = match prev {
                Some((then, bytes)) if p.received >= bytes => {
                    let dt = now.duration_since(then).as_secs_f64();
                    if dt > 0.0 {
                        ((p.received - bytes) as f64 / dt) as u64
                    } else {
                        0
                    }
                }
                _ => 0,
            };
            prev = Some((now, p.received));

            on_progress(DownloadProgress {
                file: file_dest.clone(),
                file_index: index,
                file_count,
                phase: Phase::Downloading,
                received: p.received,
                total: file_size,
                bytes_per_sec,
                batch_received: batch_base.saturating_add(p.received),
                batch_total,
            });
        };

        let fetching = download::fetch(client, &file.url, dest, &file.sha256, file.size, on_file);
        tokio::select! {
            result = fetching => result.map_err(|e| e.to_string())?,
            // A cancel while this file streams. Selecting drops `fetching`, which
            // `download` guarantees is safe — the `.part` survives to resume.
            _ = wait_for_cancel(&mut cancel) => return Ok(DownloadOutcome::Cancelled),
        }

        batch_base = batch_base.saturating_add(file.size);
    }

    Ok(DownloadOutcome::Completed)
}

/// Resolves only when the cancel flag actually becomes `true`.
///
/// The subtlety is the *closed* channel: when the command drops the sender (or a
/// test uses a receiver whose sender is gone), `watch::Receiver::changed`
/// resolves immediately with `Err`. Feeding that straight into a `select!`
/// against the fetch would let the ready-Err branch win on every poll and starve
/// the download — nothing would ever transfer. A closed channel means *no cancel
/// can ever arrive*, so this parks forever there, leaving the fetch to run. Only
/// a live `true` returns.
async fn wait_for_cancel(cancel: &mut watch::Receiver<bool>) {
    loop {
        if *cancel.borrow_and_update() {
            return;
        }
        if cancel.changed().await.is_err() {
            std::future::pending::<()>().await;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use sha2::{Digest, Sha256};
    use std::io::{Read, Write};
    use std::net::{Ipv4Addr, TcpListener, TcpStream};
    use std::sync::Arc;

    fn sha256_hex(bytes: &[u8]) -> String {
        format!("{:x}", Sha256::digest(bytes))
    }

    // ------------------------------------------------------------------
    // resolve_dest: the confinement check, the one thing a bad `dest` from a
    // compromised renderer could exploit (§8.4).
    // ------------------------------------------------------------------

    #[test]
    fn a_dest_under_models_resolves_beneath_the_models_dir() {
        let dir = Path::new("/data/models");
        let p = resolve_dest(dir, "models/vae/flux.safetensors").expect("valid");
        assert_eq!(p, Path::new("/data/models/vae/flux.safetensors"));
    }

    #[test]
    fn a_dest_that_escapes_models_is_refused() {
        let dir = Path::new("/data/models");
        assert!(resolve_dest(dir, "models/../engine/main.py").is_err());
        assert!(resolve_dest(dir, "engine/main.py").is_err());
        assert!(resolve_dest(dir, "models/").is_err());
    }

    // ------------------------------------------------------------------
    // status: the three file states and the aggregate.
    // ------------------------------------------------------------------

    fn spec(dest: &str, size: u64) -> FileSpec {
        FileSpec {
            url: format!("https://huggingface.co/x/resolve/main/{dest}"),
            dest: dest.to_owned(),
            sha256: "a".repeat(64),
            size,
        }
    }

    #[test]
    fn status_reports_present_partial_and_missing() {
        let tmp = tempfile::tempdir().expect("temp dir");
        let models = tmp.path();

        // Present: dest on disk.
        let present = models.join("vae/done.safetensors");
        std::fs::create_dir_all(present.parent().unwrap()).unwrap();
        std::fs::write(&present, vec![0u8; 100]).unwrap();

        // Partial: a .part beside an absent dest.
        let partial_dest = models.join("unet/half.safetensors");
        std::fs::create_dir_all(partial_dest.parent().unwrap()).unwrap();
        let part = download::part_path(&partial_dest).unwrap();
        std::fs::write(&part, vec![0u8; 40]).unwrap();

        let files = vec![
            spec("models/vae/done.safetensors", 100),
            spec("models/unet/half.safetensors", 200),
            spec("models/clip/none.safetensors", 300),
        ];
        let st = status(models, &files).expect("status");

        assert!(
            !st.installed,
            "a partial and a missing file make it not installed"
        );
        assert_eq!(st.total, 600);
        assert_eq!(st.downloaded, 140, "100 present + 40 partial + 0 missing");
        assert_eq!(st.files[0].state, FileState::Present);
        assert_eq!(st.files[1].state, FileState::Partial);
        assert_eq!(st.files[1].downloaded, 40);
        assert_eq!(st.files[2].state, FileState::Missing);
    }

    #[test]
    fn status_is_installed_only_when_every_file_is_present() {
        let tmp = tempfile::tempdir().expect("temp dir");
        let models = tmp.path();
        let files = vec![spec("models/a.bin", 10), spec("models/b.bin", 20)];
        for f in &files {
            let dest = resolve_dest(models, &f.dest).unwrap();
            std::fs::write(&dest, vec![0u8; f.size as usize]).unwrap();
        }
        let st = status(models, &files).expect("status");
        assert!(st.installed);
        assert_eq!(st.downloaded, st.total);
    }

    // ------------------------------------------------------------------
    // The serde JSON, pinned the way progress.rs and sidecar.rs pin theirs:
    // ts-rs checks the type structure, these pin the wire bytes ts-rs can't see
    // (the field names, the lowercase tags).
    // ------------------------------------------------------------------

    #[test]
    fn download_progress_serialises_with_a_lowercase_phase() {
        let value = serde_json::to_value(DownloadProgress {
            file: "models/vae/x.safetensors".to_owned(),
            file_index: 1,
            file_count: 3,
            phase: Phase::Downloading,
            received: 10,
            total: 100,
            bytes_per_sec: 5,
            batch_received: 60,
            batch_total: 300,
        })
        .expect("serialize");
        assert_eq!(
            value,
            json!({
                "file": "models/vae/x.safetensors",
                "file_index": 1,
                "file_count": 3,
                "phase": "downloading",
                "received": 10,
                "total": 100,
                "bytes_per_sec": 5,
                "batch_received": 60,
                "batch_total": 300,
            })
        );
    }

    #[test]
    fn outcome_and_file_state_are_bare_lowercase_strings() {
        assert_eq!(
            serde_json::to_value(DownloadOutcome::Cancelled).unwrap(),
            json!("cancelled")
        );
        assert_eq!(
            serde_json::to_value(FileState::Partial).unwrap(),
            json!("partial")
        );
    }

    // ------------------------------------------------------------------
    // install, end to end against a local server — the seam that proves the
    // manager wires fetch across several files, not one. The server mirrors
    // download.rs's: a raw TcpListener in a thread, honouring Range so a resume
    // works. Keyed by request path so one server can serve a model's files.
    // ------------------------------------------------------------------

    /// Spawns an HTTP/1.1 server that serves `payloads` keyed by URL path, each
    /// on its own connection thread, honouring `Range`. Returns its base URL.
    fn spawn_http(payloads: Vec<(String, Vec<u8>)>) -> String {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).expect("bind loopback");
        let port = listener.local_addr().expect("addr").port();
        let payloads = Arc::new(payloads);

        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(mut stream) = stream else { break };
                let payloads = Arc::clone(&payloads);
                std::thread::spawn(move || {
                    let (path, offset) = read_request(&mut stream);
                    let Some((_, body)) = payloads.iter().find(|(p, _)| path.ends_with(p.as_str()))
                    else {
                        let _ = stream.write_all(
                            b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
                        );
                        return;
                    };
                    serve(&mut stream, body, offset);
                });
            }
        });

        format!("http://{}:{}", Ipv4Addr::LOCALHOST, port)
    }

    /// Reads the request line + headers, returning the request path and any
    /// `Range: bytes=<n>-` start offset.
    fn read_request(stream: &mut TcpStream) -> (String, Option<u64>) {
        let mut buf = Vec::new();
        let mut byte = [0u8; 1];
        while stream.read(&mut byte).unwrap_or(0) == 1 {
            buf.push(byte[0]);
            if buf.ends_with(b"\r\n\r\n") {
                break;
            }
        }
        let text = String::from_utf8_lossy(&buf);
        let path = text
            .lines()
            .next()
            .and_then(|l| l.split_whitespace().nth(1))
            .unwrap_or("/")
            .to_owned();
        let offset = text.lines().find_map(|line| {
            line.to_ascii_lowercase()
                .strip_prefix("range: bytes=")
                .and_then(|r| r.split('-').next()?.trim().parse().ok())
        });
        (path, offset)
    }

    /// Serves `body`, honouring a `Range` offset with a 206 (or 416 past the end).
    fn serve(stream: &mut TcpStream, body: &[u8], offset: Option<u64>) {
        match offset {
            Some(o) if (o as usize) >= body.len() => {
                let _ = stream
                    .write_all(b"HTTP/1.1 416 Range Not Satisfiable\r\nConnection: close\r\n\r\n");
            }
            Some(o) => {
                let tail = &body[o as usize..];
                let head = format!(
                    "HTTP/1.1 206 Partial Content\r\nContent-Length: {}\r\nContent-Range: bytes {}-{}/{}\r\nConnection: close\r\n\r\n",
                    tail.len(),
                    o,
                    body.len() - 1,
                    body.len()
                );
                let _ = stream.write_all(head.as_bytes());
                let _ = stream.write_all(tail);
            }
            None => {
                let head = format!(
                    "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nAccept-Ranges: bytes\r\nConnection: close\r\n\r\n",
                    body.len()
                );
                let _ = stream.write_all(head.as_bytes());
                let _ = stream.write_all(body);
            }
        }
    }

    fn never_cancel() -> watch::Receiver<bool> {
        watch::channel(false).1
    }

    #[test]
    fn install_downloads_every_file_and_tracks_the_batch() {
        let tmp = tempfile::tempdir().expect("temp dir");
        let models = tmp.path();

        let vae = vec![0xA1u8; 20 * 1024];
        let unet = vec![0xB2u8; 48 * 1024];
        let base = spawn_http(vec![
            ("/vae.safetensors".to_owned(), vae.clone()),
            ("/unet.safetensors".to_owned(), unet.clone()),
        ]);

        let files = vec![
            FileSpec {
                url: format!("{base}/vae.safetensors"),
                dest: "models/vae/vae.safetensors".to_owned(),
                sha256: sha256_hex(&vae),
                size: vae.len() as u64,
            },
            FileSpec {
                url: format!("{base}/unet.safetensors"),
                dest: "models/unet/unet.safetensors".to_owned(),
                sha256: sha256_hex(&unet),
                size: unet.len() as u64,
            },
        ];

        let client = download::client().expect("client");
        let mut events = Vec::new();
        let outcome =
            tauri::async_runtime::block_on(install(&client, models, &files, never_cancel(), |p| {
                events.push(p)
            }))
            .expect("install");

        assert_eq!(outcome, DownloadOutcome::Completed);
        assert_eq!(
            std::fs::read(models.join("vae/vae.safetensors")).unwrap(),
            vae
        );
        assert_eq!(
            std::fs::read(models.join("unet/unet.safetensors")).unwrap(),
            unet
        );

        // Every event carried the whole-batch denominator, and both files were
        // seen in flight.
        let batch_total = (vae.len() + unet.len()) as u64;
        assert!(events.iter().all(|e| e.batch_total == batch_total));
        assert!(events.iter().all(|e| e.file_count == 2));
        assert!(events.iter().any(|e| e.file_index == 0));
        assert!(events.iter().any(|e| e.file_index == 1));

        // The last event lands the aggregate bar exactly on the total.
        let last = events.last().expect("at least one event");
        assert_eq!(last.batch_received, batch_total);

        // And status now reports it installed.
        let st = status(models, &files).expect("status");
        assert!(st.installed);
    }

    #[test]
    fn install_announces_verifying_when_a_part_is_resumed() {
        let tmp = tempfile::tempdir().expect("temp dir");
        let models = tmp.path();

        let payload = vec![0xC3u8; 32 * 1024];
        let base = spawn_http(vec![("/w.safetensors".to_owned(), payload.clone())]);
        let files = vec![FileSpec {
            url: format!("{base}/w.safetensors"),
            dest: "models/x/w.safetensors".to_owned(),
            sha256: sha256_hex(&payload),
            size: payload.len() as u64,
        }];

        // Seed a real prefix as a .part so the resume re-hashes it on open.
        let dest = models.join("x/w.safetensors");
        std::fs::create_dir_all(dest.parent().unwrap()).unwrap();
        let part = download::part_path(&dest).unwrap();
        std::fs::write(&part, &payload[..8 * 1024]).unwrap();

        let client = download::client().expect("client");
        let mut events = Vec::new();
        let outcome =
            tauri::async_runtime::block_on(install(&client, models, &files, never_cancel(), |p| {
                events.push(p)
            }))
            .expect("install");

        assert_eq!(outcome, DownloadOutcome::Completed);
        assert!(
            events.first().map(|e| e.phase) == Some(Phase::Verifying),
            "a resumed .part is announced as verifying before any byte"
        );
        assert!(
            events.iter().any(|e| e.phase == Phase::Downloading),
            "then it flips to downloading"
        );
        assert_eq!(std::fs::read(&dest).unwrap(), payload);
    }

    #[test]
    fn install_already_cancelled_downloads_nothing() {
        let tmp = tempfile::tempdir().expect("temp dir");
        let models = tmp.path();

        // A server that would serve if asked — the point is that it is not.
        let payload = vec![0xD4u8; 4096];
        let base = spawn_http(vec![("/w.bin".to_owned(), payload.clone())]);
        let files = vec![FileSpec {
            url: format!("{base}/w.bin"),
            dest: "models/w.bin".to_owned(),
            sha256: sha256_hex(&payload),
            size: payload.len() as u64,
        }];

        // Cancel before the loop even starts.
        let (tx, rx) = watch::channel(false);
        tx.send(true).unwrap();

        let client = download::client().expect("client");
        let outcome = tauri::async_runtime::block_on(install(&client, models, &files, rx, |_p| {}))
            .expect("install");

        assert_eq!(outcome, DownloadOutcome::Cancelled);
        assert!(!models.join("w.bin").exists(), "a cancel downloads nothing");
    }

    /// A server that stalls forever after sending a prefix, so the *caller* does
    /// the cancelling rather than an early EOF. The prefix lets the test wait for
    /// a real `.part` to exist before it cancels.
    fn spawn_stalling_http(path: &str, payload: Vec<u8>, prefix: usize) -> String {
        let path = path.to_owned();
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).expect("bind loopback");
        let port = listener.local_addr().expect("addr").port();
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(mut stream) = stream else { break };
                let payload = payload.clone();
                let path = path.clone();
                std::thread::spawn(move || {
                    let (req_path, offset) = read_request(&mut stream);
                    if !req_path.ends_with(&path) {
                        return;
                    }
                    match offset {
                        // The resume: honour the Range and deliver the tail.
                        Some(o) => serve(&mut stream, &payload, Some(o)),
                        // The first attempt: a prefix, then hold the socket open.
                        None => {
                            let head = format!(
                                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nAccept-Ranges: bytes\r\nConnection: close\r\n\r\n",
                                payload.len()
                            );
                            let _ = stream.write_all(head.as_bytes());
                            let _ = stream.write_all(&payload[..prefix]);
                            let _ = stream.flush();
                            std::thread::sleep(std::time::Duration::from_secs(10));
                        }
                    }
                });
            }
        });
        format!("http://{}:{}", Ipv4Addr::LOCALHOST, port)
    }

    #[test]
    fn a_cancel_mid_download_leaves_a_part_the_next_install_resumes() {
        let tmp = tempfile::tempdir().expect("temp dir");
        let models = tmp.path();

        let payload = vec![0x77u8; 32 * 1024];
        let prefix = 8 * 1024usize;
        let base = spawn_stalling_http("/w.bin", payload.clone(), prefix);
        let files = vec![FileSpec {
            url: format!("{base}/w.bin"),
            dest: "models/w.bin".to_owned(),
            sha256: sha256_hex(&payload),
            size: payload.len() as u64,
        }];
        let dest = models.join("w.bin");
        let part = download::part_path(&dest).unwrap();

        let client = download::client().expect("client");
        let (tx, rx) = watch::channel(false);

        // Run the install as a task and cancel it the moment the prefix lands —
        // not on a wall-clock guess, which a slow runner could beat either way.
        let task = {
            let client = client.clone();
            let files = files.clone();
            let models = models.to_owned();
            tauri::async_runtime::spawn(async move {
                install(&client, &models, &files, rx, |_p| {}).await
            })
        };

        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
        while std::fs::metadata(&part).map(|m| m.len()).unwrap_or(0) < prefix as u64 {
            assert!(
                std::time::Instant::now() < deadline,
                "the prefix never arrived"
            );
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        tx.send(true).expect("cancel");

        let outcome = tauri::async_runtime::block_on(task)
            .expect("join")
            .expect("install returns, not errors, on cancel");
        assert_eq!(outcome, DownloadOutcome::Cancelled);
        assert!(part.exists(), "a cancel leaves the .part to resume");
        assert!(
            !dest.exists(),
            "nothing lands at dest for an unfinished download"
        );

        // The resume completes and verifies.
        let outcome = tauri::async_runtime::block_on(install(
            &client,
            models,
            &files,
            never_cancel(),
            |_p| {},
        ))
        .expect("resume");
        assert_eq!(outcome, DownloadOutcome::Completed);
        assert_eq!(std::fs::read(&dest).unwrap(), payload);
    }

    #[test]
    fn install_skips_files_already_on_disk_but_still_counts_them() {
        let tmp = tempfile::tempdir().expect("temp dir");
        let models = tmp.path();

        // File 0 already present; file 1 to fetch.
        let done = vec![0xE5u8; 10 * 1024];
        let done_dest = models.join("a/done.bin");
        std::fs::create_dir_all(done_dest.parent().unwrap()).unwrap();
        std::fs::write(&done_dest, &done).unwrap();

        let todo = vec![0xF6u8; 16 * 1024];
        let base = spawn_http(vec![("/todo.bin".to_owned(), todo.clone())]);

        let files = vec![
            FileSpec {
                url: format!("{base}/done.bin"),
                dest: "models/a/done.bin".to_owned(),
                sha256: sha256_hex(&done),
                size: done.len() as u64,
            },
            FileSpec {
                url: format!("{base}/todo.bin"),
                dest: "models/b/todo.bin".to_owned(),
                sha256: sha256_hex(&todo),
                size: todo.len() as u64,
            },
        ];

        let client = download::client().expect("client");
        let mut events = Vec::new();
        let outcome =
            tauri::async_runtime::block_on(install(&client, models, &files, never_cancel(), |p| {
                events.push(p)
            }))
            .expect("install");

        assert_eq!(outcome, DownloadOutcome::Completed);
        // No event ever describes the already-present file 0 — it was skipped.
        assert!(events.iter().all(|e| e.file_index == 1));
        // But the batch received still ends at the full total, so the aggregate
        // bar accounts for the skipped file's bytes.
        let batch_total = (done.len() + todo.len()) as u64;
        assert_eq!(events.last().unwrap().batch_received, batch_total);
    }
}
