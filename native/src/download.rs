//! Resumable, SHA-256-verified weight downloads (#17, §8.4).
//!
//! Model weights are 12–16GB each, and a fetch that has to restart from zero on
//! every dropped connection is a fetch a user on a home connection can never
//! finish. So the download streams into a sidecar `<dest>.part`, and the `.part`
//! is the resume point: a later attempt re-opens it, re-hashes what is already
//! there, and asks the server for the rest with a `Range` header. Only once the
//! whole file is present *and* its digest matches does it get renamed onto
//! `dest` — the rename is atomic and same-directory, so **the presence of `dest`
//! means a verified file** and nothing else ever has to re-check it (§8.4).
//!
//! Three things here are subtle enough that CLAUDE.md calls them out as traps,
//! and each has a home in the code below:
//!
//! - **`.part` is formed by *appending*, never `with_extension`.** Two models
//!   sharing a stem (`model.safetensors`, `model.gguf`) would both collapse to
//!   `model.part` and race each other. See [`part_path`].
//! - **A `Range` request answered with `200`, not `206`, restarts at byte 0.**
//!   HF redirects to a CDN that may ignore `Range`; when it does, the body we are
//!   about to receive begins at zero, so the file offset *and* the running hasher
//!   both have to be reset or the digest is computed over a seam. See
//!   [`resume_action`] and [`PartFile::reset`].
//! - **You cannot resume a SHA-256.** The digest is a running state over every
//!   byte in order, so resuming means re-reading the existing `.part` back
//!   through a fresh hasher first. See [`PartFile::open`].
//!
//! The module is deliberately free of Tauri: progress is reported through a
//! caller-supplied closure, not an `Emitter`, so the whole thing is exercisable
//! against a temp directory and (in #18) a local server. Wiring it to a Tauri
//! event and the manifest belongs to the command layer and the download manager
//! (#21).

use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use reqwest::header::RANGE;
use reqwest::StatusCode;
use sha2::{Digest, Sha256};

/// Appended to the destination file name for the in-progress download.
///
/// A plain suffix on the *whole* name, which is the entire point: see
/// [`part_path`] for why this is not an extension replacement.
const PART_SUFFIX: &str = ".part";

/// Emit progress at most this often. Per-chunk emits (a chunk is a few dozen KB)
/// would flood the IPC channel and the React re-render on a multi-gigabyte file;
/// a quarter-second is smooth to the eye and cheap on the wire (#17).
const PROGRESS_INTERVAL: Duration = Duration::from_millis(250);

/// How long a single read may stall before the attempt is abandoned and resumed.
///
/// Deliberately *not* a total-request timeout — these downloads legitimately run
/// for an hour (#17), so a wall-clock cap would kill healthy transfers. This
/// bounds only silence: a network drop where the peer never sends a FIN leaves a
/// half-open socket that would otherwise hang until the OS gives up (minutes),
/// stalling the resume machinery below. Capping the read turns that into an
/// error the retry loop can act on.
const READ_TIMEOUT: Duration = Duration::from_secs(60);

/// How long to wait for the initial connection.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(30);

/// Consecutive attempts that make *no* forward progress before giving up.
///
/// The loop retries indefinitely as long as bytes keep arriving — an hour-long
/// download over a flaky link is expected to survive many drops. What must not
/// spin forever is a download that has genuinely stopped moving: a server that
/// ignores `Range` and drops every time, or a machine that is simply offline.
/// Each such attempt resets to zero progress, and this bounds how many in a row
/// are tolerated before the fetch fails and hands control back to the caller
/// (whose `.part` is left intact to resume later).
const MAX_STALLS: u32 = 8;

/// Everything a download can fail at, each carrying the actionable text §8.6
/// asks for — what happened, whether the partial survives, and what to do.
#[derive(Debug, thiserror::Error)]
pub enum DownloadError {
    #[error("could not prepare {path}: {source}")]
    Io {
        path: String,
        #[source]
        source: std::io::Error,
    },

    #[error(
        "could not fetch {url}: {source}\n  \
         The download can be resumed — nothing already downloaded was lost. \
         Check the connection and try again."
    )]
    Request {
        url: String,
        #[source]
        source: reqwest::Error,
    },

    #[error(
        "{url} returned {status}.\n  \
         The model may have been moved or withdrawn at its source. \
         The manifest that names this file needs updating."
    )]
    Status { url: String, status: u16 },

    #[error(
        "the download of {url} stopped making progress and was given up.\n  \
         Whatever arrived is kept and can be resumed. This is usually a network \
         problem, not a problem with the file."
    )]
    Stalled { url: String },

    #[error(
        "{url} sent more than the {limit} bytes the manifest declared and was \
         stopped.\n  A response larger than the file it claims to be points at a \
         broken or hostile mirror. Nothing was written into place."
    )]
    TooLarge { url: String, limit: u64 },

    #[error(
        "the downloaded file did not match its checksum and was discarded.\n  \
         expected sha256 {expected}\n  got      sha256 {actual}\n  \
         The download completed but the bytes are wrong — a corrupted transfer or \
         a file that changed at its source. Try again."
    )]
    Checksum {
        dest: PathBuf,
        expected: String,
        actual: String,
    },

    /// A destination with no file component (e.g. a path ending in `..`). Not
    /// reachable from a schema-valid manifest — `dest` is confined under
    /// `models/` — but a bare `.part` join on such a path would be nonsense, so
    /// it is refused rather than guessed at.
    #[error("the download destination {dest} has no file name")]
    BadDest { dest: PathBuf },

    /// A panic or cancellation inside a blocking hash/rename task. Not reachable
    /// by anything a user does, but an `unwrap()` on a join handle is the panic
    /// CLAUDE.md forbids, so it gets a name.
    #[error("the download task did not finish: {0}")]
    Task(String),
}

impl DownloadError {
    /// Whether the retry loop should resume after this error rather than fail.
    ///
    /// Only a transport error is transient. A bad HTTP status, a checksum
    /// mismatch, a full disk (an `Io` error), or an oversized response will
    /// recur identically on the next attempt, so retrying them just burns the
    /// stall budget to reach the same wall.
    fn retryable(&self) -> bool {
        matches!(self, DownloadError::Request { .. })
    }
}

/// A single progress update: bytes on disk out of the manifest's declared total.
///
/// `total` is the manifest `size`, so it is stable across a resume — unlike a
/// per-response `Content-Length`, which on a `206` is only the remaining bytes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Progress {
    pub received: u64,
    pub total: u64,
}

/// Builds the HTTP client for weight downloads.
///
/// The timeouts are the whole reason this is not `reqwest::get`: a per-read and
/// connect timeout so a dead connection surfaces as an error the resume loop can
/// act on, and — pointedly — *no* `.timeout()`, because a total-request cap would
/// kill a legitimate hour-long transfer (#17). One client can (and should) be
/// reused across a batch of files so connections are pooled.
pub fn client() -> reqwest::Result<reqwest::Client> {
    reqwest::Client::builder()
        .connect_timeout(CONNECT_TIMEOUT)
        .read_timeout(READ_TIMEOUT)
        .build()
}

/// Downloads `url` to `dest`, verified against `sha256`, resuming an existing
/// `<dest>.part` if one is there.
///
/// `size` is the manifest's declared byte count: it is the progress denominator
/// and the ceiling past which a runaway response is cut off. Integrity, though,
/// rests on `sha256` alone (§8.4) — the file is accepted iff its digest matches,
/// and `dest` is created only then, by an atomic same-directory rename.
///
/// `on_progress` is called at most every [`PROGRESS_INTERVAL`], plus once at the
/// start and once at the end so the bar begins and lands exactly.
///
/// Resumability spans *calls*, not just retries: an interrupted fetch leaves the
/// `.part` on disk, and a later call re-hashes and continues it. Dropping this
/// future (a cancel) is safe for the same reason — the `.part` is only ever
/// removed on a checksum mismatch or replaced by the verified rename.
pub async fn fetch(
    client: &reqwest::Client,
    url: &str,
    dest: &Path,
    sha256: &str,
    size: u64,
    mut on_progress: impl FnMut(Progress),
) -> Result<(), DownloadError> {
    let part = part_path(dest)?;

    // Open and re-hash on the blocking pool: a resumed `.part` can be 14GB, and
    // reading all of it back through a fresh hasher would stall the async
    // reactor for tens of seconds if done inline (the same reasoning archive.rs
    // spawn_blocks its unpack).
    let mut sink = {
        let dest = dest.to_owned();
        let part_for_task = part.clone();
        let opened =
            tauri::async_runtime::spawn_blocking(move || PartFile::open(dest, part_for_task)).await;
        match opened {
            Ok(result) => result.map_err(|source| DownloadError::Io {
                path: part.display().to_string(),
                source,
            })?,
            Err(join) => return Err(DownloadError::Task(join.to_string())),
        }
    };

    on_progress(Progress {
        received: sink.written,
        total: size,
    });

    // Retry as long as bytes keep arriving; a consecutive run of no-progress
    // attempts is the only thing that ends the loop unsuccessfully.
    let mut throttle = ProgressThrottle::new();
    let mut stalls: u32 = 0;
    while sink.written < size {
        let before = sink.written;

        match stream_once(
            client,
            url,
            &mut sink,
            size,
            &mut on_progress,
            &mut throttle,
        )
        .await
        {
            // 416: the server says we are already past the end. Stop asking for
            // more and let verification decide whether what we have is whole.
            Ok(Fetched::Complete) => break,
            // The body ended. If it ended short (a clean early EOF), the loop
            // condition sends us round again to ask for the rest.
            Ok(Fetched::Streamed) => {}
            // A dropped connection mid-stream: resume from what landed.
            Err(e) if e.retryable() => {}
            // A bad status, a full disk, an oversized response: identical next
            // time, so fail now. The `.part` stays for a later, deliberate retry.
            Err(e) => return Err(e),
        }

        if sink.written > before {
            stalls = 0;
        } else {
            stalls += 1;
            if stalls >= MAX_STALLS {
                return Err(DownloadError::Stalled {
                    url: url.to_owned(),
                });
            }
        }

        if sink.written < size {
            tokio::time::sleep(backoff(stalls)).await;
        }
    }

    // Land the bar on the true final count before the (possibly slow) verify.
    on_progress(Progress {
        received: sink.written,
        total: size,
    });

    // Verify and rename on the blocking pool: finalizing the digest is the tail
    // of a 14GB hash, and the rename is trivial but keeps the two together.
    let expected = sha256.to_owned();
    match tauri::async_runtime::spawn_blocking(move || sink.finish(&expected)).await {
        Ok(result) => result,
        Err(join) => Err(DownloadError::Task(join.to_string())),
    }
}

/// Derives `<dest>.part` by appending to the whole file name.
///
/// This is the CLAUDE.md trap spelled out: `dest.with_extension("part")` on
/// `model.safetensors` yields `model.part`, and so does it on `model.gguf` — two
/// different weights for one model would fight over a single scratch file. A
/// suffix on the entire name keeps them distinct (`model.safetensors.part`,
/// `model.gguf.part`).
fn part_path(dest: &Path) -> Result<PathBuf, DownloadError> {
    let name = dest.file_name().ok_or_else(|| DownloadError::BadDest {
        dest: dest.to_owned(),
    })?;
    let mut name = name.to_os_string();
    name.push(PART_SUFFIX);
    Ok(dest.with_file_name(name))
}

/// The outcome of one streaming attempt.
enum Fetched {
    /// The response body was read to its end (which may still be short of the
    /// full file if the server closed early).
    Streamed,
    /// The server reported the requested range is unsatisfiable (`416`): we hold
    /// at least the whole file already, so there is nothing more to stream.
    Complete,
}

/// Issues one request — ranged if resuming — and streams its body into `sink`.
async fn stream_once(
    client: &reqwest::Client,
    url: &str,
    sink: &mut PartFile,
    size: u64,
    on_progress: &mut impl FnMut(Progress),
    throttle: &mut ProgressThrottle,
) -> Result<Fetched, DownloadError> {
    let offset = sink.written;

    let mut request = client.get(url);
    if offset > 0 {
        // Ask for everything from where the `.part` ends. Whether the server
        // honours it is decided by the status, below — a CDN that ignores it
        // answers 200 with the whole file.
        request = request.header(RANGE, format!("bytes={offset}-"));
    }

    let mut response = request
        .send()
        .await
        .map_err(|source| DownloadError::Request {
            url: url.to_owned(),
            source,
        })?;

    match resume_action(url, response.status(), offset)? {
        Action::AlreadyComplete => return Ok(Fetched::Complete),
        // The trap: the server sent a fresh full body despite our Range, so the
        // bytes we already have are about to be overwritten from zero. Drop them
        // and reset the hasher, or the digest spans a seam of stale + fresh.
        Action::StartFresh => {
            if sink.written > 0 {
                sink.reset().map_err(|source| DownloadError::Io {
                    path: sink.part.display().to_string(),
                    source,
                })?;
            }
        }
        Action::Continue => {}
    }

    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|source| DownloadError::Request {
            url: url.to_owned(),
            source,
        })?
    {
        sink.write_chunk(&chunk)
            .map_err(|source| DownloadError::Io {
                path: sink.part.display().to_string(),
                source,
            })?;

        // `size` is the manifest's own number, so a body that streams past it is
        // not the file we asked for. Stop before it fills the disk — the digest
        // would reject it anyway, but not until gigabytes too late.
        if sink.written > size {
            return Err(DownloadError::TooLarge {
                url: url.to_owned(),
                limit: size,
            });
        }

        if throttle.ready() {
            on_progress(Progress {
                received: sink.written,
                total: size,
            });
        }
    }

    Ok(Fetched::Streamed)
}

/// What a response status means for a resume, given the offset we asked from.
enum Action {
    /// Keep the existing bytes and append (the server honoured our `Range`).
    Continue,
    /// Discard whatever we have and take the body from byte 0.
    StartFresh,
    /// The requested range is unsatisfiable; we already hold the whole file.
    AlreadyComplete,
}

/// Maps an HTTP status to a resume action.
///
/// Split out as a pure function precisely because the 206-vs-200 distinction is
/// the trap: a `200` answer to a ranged request restarts at zero, and that has
/// to be unmissable and directly testable rather than buried in the stream loop.
fn resume_action(url: &str, status: StatusCode, offset: u64) -> Result<Action, DownloadError> {
    // The range we asked for lies at or past the end of the resource. This is
    // how a server answers a resume of an already-complete `.part`.
    if status == StatusCode::RANGE_NOT_SATISFIABLE {
        return Ok(Action::AlreadyComplete);
    }

    if !status.is_success() {
        return Err(DownloadError::Status {
            url: url.to_owned(),
            status: status.as_u16(),
        });
    }

    // A 206 in answer to our Range means the body picks up where we left off —
    // but only if we actually asked from a non-zero offset. Anything else is a
    // full body from zero, which for a resumed `.part` means the offset was
    // ignored and the existing bytes must go.
    if status == StatusCode::PARTIAL_CONTENT && offset > 0 {
        Ok(Action::Continue)
    } else {
        Ok(Action::StartFresh)
    }
}

/// The in-progress `<dest>.part`, its running SHA-256, and where it lands.
///
/// The hasher advances in lockstep with the file: it is seeded by re-reading any
/// existing `.part` on [`open`](Self::open), fed each written chunk, and thrown
/// away and restarted by [`reset`](Self::reset). So at [`finish`](Self::finish)
/// the digest is already complete without a second pass over the bytes.
struct PartFile {
    dest: PathBuf,
    part: PathBuf,
    file: std::fs::File,
    hasher: Sha256,
    /// Bytes on disk, which is also the offset the next resume asks from.
    written: u64,
}

impl PartFile {
    /// Opens `part`, re-hashing whatever is already in it.
    ///
    /// The re-hash is the unavoidable cost of resuming a SHA-256: the digest is a
    /// running state over the bytes in order, so the only way to continue it is
    /// to feed the existing prefix through a fresh hasher first. The file cursor
    /// is left at the end, ready to append.
    fn open(dest: PathBuf, part: PathBuf) -> std::io::Result<PartFile> {
        if let Some(parent) = part.parent() {
            std::fs::create_dir_all(parent)?;
        }

        let mut file = std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(&part)?;

        let mut hasher = Sha256::new();
        let mut written = 0u64;
        let mut buf = [0u8; 128 * 1024];
        loop {
            let n = file.read(&mut buf)?;
            if n == 0 {
                break;
            }
            hasher.update(&buf[..n]);
            written += n as u64;
        }
        // The read left the cursor at EOF, which is where appends must go.

        Ok(PartFile {
            dest,
            part,
            file,
            hasher,
            written,
        })
    }

    /// Discards the accumulated bytes and hash, back to an empty file.
    ///
    /// Called when a ranged request is answered with a full body (see
    /// [`resume_action`]): the incoming stream starts at byte 0, so the file has
    /// to be truncated *and* the hasher restarted, or the digest is taken over a
    /// stale prefix joined to the fresh bytes.
    fn reset(&mut self) -> std::io::Result<()> {
        self.file.set_len(0)?;
        self.file.seek(SeekFrom::Start(0))?;
        self.hasher = Sha256::new();
        self.written = 0;
        Ok(())
    }

    /// Appends a chunk, advancing the file and the hash together.
    fn write_chunk(&mut self, bytes: &[u8]) -> std::io::Result<()> {
        self.file.write_all(bytes)?;
        self.hasher.update(bytes);
        self.written += bytes.len() as u64;
        Ok(())
    }

    /// Verifies the digest and, only if it matches, renames `.part` onto `dest`.
    ///
    /// A mismatch removes the `.part`: the accumulated bytes are wrong, and
    /// keeping them would poison every future resume into re-verifying the same
    /// corruption forever (#18). `dest` is never created on a mismatch — its
    /// presence is the guarantee of a verified file (§8.4).
    fn finish(mut self, expected_sha: &str) -> Result<(), DownloadError> {
        self.file.flush().map_err(|source| DownloadError::Io {
            path: self.part.display().to_string(),
            source,
        })?;
        // Push the bytes to the platter before the rename claims they are whole.
        self.file.sync_all().map_err(|source| DownloadError::Io {
            path: self.part.display().to_string(),
            source,
        })?;

        let actual = format!("{:x}", self.hasher.finalize());
        if actual != expected_sha {
            // Best-effort: the download already failed, and a leftover corrupt
            // `.part` is a smaller problem than reporting a different error.
            let _ = std::fs::remove_file(&self.part);
            return Err(DownloadError::Checksum {
                dest: self.dest.clone(),
                expected: expected_sha.to_owned(),
                actual,
            });
        }

        if let Some(parent) = self.dest.parent() {
            std::fs::create_dir_all(parent).map_err(|source| DownloadError::Io {
                path: parent.display().to_string(),
                source,
            })?;
        }
        // The `.part` sits beside `dest`, so this rename stays on one filesystem
        // and is atomic. Windows refuses to rename onto an existing file, so a
        // prior copy is cleared first — only ever reached after verification, and
        // a verified file is byte-identical to whatever it replaces.
        let _ = std::fs::remove_file(&self.dest);
        std::fs::rename(&self.part, &self.dest).map_err(|source| DownloadError::Io {
            path: self.dest.display().to_string(),
            source,
        })?;

        Ok(())
    }
}

/// Rate-limits progress emission to one every [`PROGRESS_INTERVAL`].
struct ProgressThrottle {
    last: Instant,
}

impl ProgressThrottle {
    fn new() -> Self {
        Self {
            last: Instant::now(),
        }
    }

    /// True at most once per interval; resets its clock when it says yes.
    fn ready(&mut self) -> bool {
        if self.last.elapsed() >= PROGRESS_INTERVAL {
            self.last = Instant::now();
            true
        } else {
            false
        }
    }
}

/// Backoff before the next attempt, growing with the number of consecutive
/// stalls and capped so a persistent outage does not stretch to minutes.
///
/// A run that is making progress passes `0` here (its stall count was reset), so
/// the clean-resume case waits only a beat.
fn backoff(stalls: u32) -> Duration {
    let ms = 250u64.saturating_mul(1 << stalls.min(5));
    Duration::from_millis(ms.min(8_000))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The trap in one assertion: two weights sharing a stem must not collide,
    /// which `with_extension` would let them do.
    #[test]
    fn part_path_appends_rather_than_replacing_the_extension() {
        let safetensors = Path::new("/models/flux/model.safetensors");
        let gguf = Path::new("/models/flux/model.gguf");

        let sp = part_path(safetensors).expect("has a file name");
        let gp = part_path(gguf).expect("has a file name");

        assert_eq!(sp, Path::new("/models/flux/model.safetensors.part"));
        assert_eq!(gp, Path::new("/models/flux/model.gguf.part"));
        // The collision `with_extension("part")` would have caused.
        assert_ne!(sp, gp);
        assert_ne!(sp, safetensors.with_extension("part"));
    }

    #[test]
    fn a_destination_without_a_file_name_is_refused() {
        assert!(matches!(
            part_path(Path::new("/models/..")),
            Err(DownloadError::BadDest { .. })
        ));
    }

    /// The 206-vs-200 decision, which is the whole reason `resume_action` is a
    /// separate function.
    const URL: &str = "https://example.com/model.bin";

    #[test]
    fn a_ranged_request_answered_with_206_continues() {
        assert!(matches!(
            resume_action(URL, StatusCode::PARTIAL_CONTENT, 1000).expect("206"),
            Action::Continue
        ));
    }

    #[test]
    fn a_ranged_request_answered_with_200_restarts_from_zero() {
        // The CDN ignored our Range: a full body from byte 0, so we must discard.
        assert!(matches!(
            resume_action(URL, StatusCode::OK, 1000).expect("200"),
            Action::StartFresh
        ));
    }

    #[test]
    fn a_206_with_no_offset_is_still_a_fresh_body() {
        // We asked for nothing ranged, so a 206 (some CDNs always partial) is the
        // whole file and there is nothing to append to.
        assert!(matches!(
            resume_action(URL, StatusCode::PARTIAL_CONTENT, 0).expect("206"),
            Action::StartFresh
        ));
    }

    #[test]
    fn a_416_means_we_already_have_it_all() {
        assert!(matches!(
            resume_action(URL, StatusCode::RANGE_NOT_SATISFIABLE, 5000).expect("416"),
            Action::AlreadyComplete
        ));
    }

    #[test]
    fn a_non_success_status_is_an_error() {
        assert!(matches!(
            resume_action(URL, StatusCode::NOT_FOUND, 0),
            Err(DownloadError::Status { status: 404, .. })
        ));
        assert!(matches!(
            resume_action(URL, StatusCode::FORBIDDEN, 100),
            Err(DownloadError::Status { status: 403, .. })
        ));
    }

    fn sha256_hex(bytes: &[u8]) -> String {
        format!("{:x}", Sha256::digest(bytes))
    }

    /// The happy path at the `PartFile` seam: write the whole file, verify, and
    /// land it at `dest` with the `.part` gone.
    #[test]
    fn a_verified_file_is_renamed_into_place_and_the_part_removed() {
        let tmp = tempfile::tempdir().expect("temp dir");
        let dest = tmp.path().join("sub/model.bin");
        let part = part_path(&dest).expect("part path");
        let payload = b"the quick brown fox";

        let mut sink = PartFile::open(dest.clone(), part.clone()).expect("open");
        sink.write_chunk(payload).expect("write");
        sink.finish(&sha256_hex(payload)).expect("verify");

        assert_eq!(std::fs::read(&dest).expect("dest"), payload);
        assert!(
            !part.exists(),
            "the .part must be gone after a successful rename"
        );
    }

    /// A completed-but-corrupt download: the `.part` is removed and `dest` is
    /// never created (#18's checksum case, at the unit seam).
    #[test]
    fn a_checksum_mismatch_removes_the_part_and_never_creates_dest() {
        let tmp = tempfile::tempdir().expect("temp dir");
        let dest = tmp.path().join("model.bin");
        let part = part_path(&dest).expect("part path");

        let mut sink = PartFile::open(dest.clone(), part.clone()).expect("open");
        sink.write_chunk(b"corrupt bytes").expect("write");

        let err = sink
            .finish(&sha256_hex(b"the bytes we expected"))
            .expect_err("mismatch must fail");

        assert!(matches!(err, DownloadError::Checksum { .. }));
        assert!(
            !part.exists(),
            "a corrupt .part must not survive to poison a resume"
        );
        assert!(
            !dest.exists(),
            "dest must never appear for an unverified download"
        );
    }

    /// Re-opening an existing `.part` continues its hash — the proof that resume
    /// re-hashes rather than starting the digest over the tail only.
    #[test]
    fn reopening_a_part_rehashes_the_existing_bytes() {
        let tmp = tempfile::tempdir().expect("temp dir");
        let dest = tmp.path().join("model.bin");
        let part = part_path(&dest).expect("part path");
        let whole = b"first half. second half.";
        let (head, tail) = whole.split_at(11);

        // First attempt lands the head, then is "interrupted" (dropped).
        {
            let mut sink = PartFile::open(dest.clone(), part.clone()).expect("open");
            sink.write_chunk(head).expect("write head");
            assert_eq!(sink.written, head.len() as u64);
        }

        // Resume: the head is re-hashed on open, the tail appended, and the
        // digest over the whole file matches — which it only can if open fed the
        // existing bytes back through the hasher.
        let mut sink = PartFile::open(dest.clone(), part.clone()).expect("reopen");
        assert_eq!(sink.written, head.len() as u64, "resume must see the head");
        sink.write_chunk(tail).expect("write tail");
        sink.finish(&sha256_hex(whole))
            .expect("resumed hash must match");

        assert_eq!(std::fs::read(&dest).expect("dest"), whole);
    }

    /// `reset` is what the ignored-`Range` path calls: it must clear both the
    /// bytes and the hash so a full re-send verifies against itself, not against
    /// a stale prefix.
    #[test]
    fn reset_clears_the_bytes_and_the_hash_together() {
        let tmp = tempfile::tempdir().expect("temp dir");
        let dest = tmp.path().join("model.bin");
        let part = part_path(&dest).expect("part path");
        let whole = b"the real, complete file";

        let mut sink = PartFile::open(dest.clone(), part.clone()).expect("open");
        // Bytes from a half-finished prior attempt.
        sink.write_chunk(b"stale partial data")
            .expect("write stale");

        // The server ignored our Range and is re-sending from zero.
        sink.reset().expect("reset");
        assert_eq!(sink.written, 0);

        sink.write_chunk(whole).expect("write fresh");
        sink.finish(&sha256_hex(whole))
            .expect("hash must be of the fresh bytes only");

        assert_eq!(std::fs::read(&dest).expect("dest"), whole);
    }

    #[test]
    fn the_progress_throttle_fires_once_per_interval() {
        let mut throttle = ProgressThrottle::new();
        // Immediately after construction the interval has not elapsed.
        assert!(!throttle.ready());
        // Backdate the clock past the interval and it fires exactly once.
        throttle.last = Instant::now() - PROGRESS_INTERVAL - Duration::from_millis(10);
        assert!(throttle.ready());
        assert!(
            !throttle.ready(),
            "a second read in the same window must not fire"
        );
    }

    /// Backoff grows with consecutive stalls but never runs away — a resuming
    /// download waits a beat, a persistent outage tops out in seconds.
    #[test]
    fn backoff_grows_and_is_capped() {
        assert_eq!(backoff(0), Duration::from_millis(250));
        assert_eq!(backoff(1), Duration::from_millis(500));
        assert!(backoff(3) < backoff(5) || backoff(5) == Duration::from_millis(8_000));
        assert_eq!(
            backoff(50),
            Duration::from_millis(8_000),
            "must stay capped"
        );
    }
}
