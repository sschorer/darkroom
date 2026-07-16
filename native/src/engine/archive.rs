//! Unpacks the ComfyUI tarball.
//!
//! GitHub's archive wraps everything in a single `<name>-<sha>/` directory, so
//! the job is: expand it somewhere scratch, then move that one directory into
//! place under the name we want.
//!
//! It expands into staging and *renames* rather than unpacking straight into
//! `ComfyUI/` because an unpack is not atomic. A network drop or a kill halfway
//! through a direct unpack leaves a `ComfyUI/` directory holding some fraction
//! of the files, which is indistinguishable from a real one to anything that
//! only checks whether the path exists. The rename is the same trick `.part`
//! plays for weights (§8.4): the destination appears at once or not at all.

use std::fs::File;
use std::io;
use std::path::Path;

use flate2::read::GzDecoder;

#[derive(Debug, thiserror::Error)]
pub enum ArchiveError {
    #[error("could not unpack the engine archive: {0}\n  {1}")]
    Io(#[source] io::Error, String),

    #[error(
        "the engine archive did not contain {expected}/.\n  \
         Either the download was truncated, or GitHub changed its archive layout \
         and the bootstrap needs updating."
    )]
    MissingRoot { expected: String },
}

fn io(context: impl Into<String>) -> impl FnOnce(io::Error) -> ArchiveError {
    let context = context.into();
    move |e| ArchiveError::Io(e, context)
}

/// Expands `tarball`, strips its single top-level `expected_root/` directory,
/// and leaves the contents at `dest`.
///
/// `staging` must be on the same filesystem as `dest` — see [`Paths::engine_staging`].
/// Both are removed and recreated, so a previous interrupted attempt is not
/// something the caller has to think about.
///
/// [`Paths::engine_staging`]: crate::paths::Paths::engine_staging
pub fn unpack_stripped(
    tarball: &Path,
    staging: &Path,
    dest: &Path,
    expected_root: &str,
) -> Result<(), ArchiveError> {
    // Whatever a previous attempt left here is worthless, and reusing it would
    // merge two half-unpacked trees into one that looks whole.
    reset_dir(staging)?;

    let file = File::open(tarball).map_err(io(format!("reading {}", tarball.display())))?;

    // `unpack` is what does the security work here, and using it is the reason
    // this function doesn't walk entries itself. It refuses absolute paths and
    // `..` components, so a hostile tar can't write outside `staging` — the
    // classic tar traversal. Hand-rolling the strip would mean hand-rolling
    // that check too, and getting it subtly wrong.
    tar::Archive::new(GzDecoder::new(file))
        .unpack(staging)
        .map_err(io(format!("expanding into {}", staging.display())))?;

    let root = staging.join(expected_root);
    if !root.is_dir() {
        return Err(ArchiveError::MissingRoot {
            expected: expected_root.to_owned(),
        });
    }

    // The destination must be gone for the rename to land on Windows, where
    // renaming onto an existing directory fails rather than replacing it.
    remove_dir(dest)?;
    std::fs::rename(&root, dest).map_err(io(format!(
        "moving {} into place at {}",
        root.display(),
        dest.display()
    )))?;

    // Best-effort: the engine is already correct at this point, and failing the
    // whole bootstrap over leftover scratch would be a worse outcome than the
    // leftover scratch.
    let _ = std::fs::remove_dir_all(staging);

    Ok(())
}

fn reset_dir(dir: &Path) -> Result<(), ArchiveError> {
    remove_dir(dir)?;
    std::fs::create_dir_all(dir).map_err(io(format!("creating {}", dir.display())))
}

fn remove_dir(dir: &Path) -> Result<(), ArchiveError> {
    match std::fs::remove_dir_all(dir) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(ArchiveError::Io(e, format!("removing {}", dir.display()))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    use std::io::Write;
    use std::path::PathBuf;

    /// Builds a tarball shaped like GitHub's: everything under one root dir.
    fn tarball(dir: &Path, root: &str, files: &[(&str, &str)]) -> PathBuf {
        let path = dir.join("archive.tar.gz");
        let out = File::create(&path).expect("create tarball");
        let enc = flate2::write::GzEncoder::new(out, flate2::Compression::fast());
        let mut builder = tar::Builder::new(enc);

        for (name, contents) in files {
            let mut header = tar::Header::new_gnu();
            header.set_size(contents.len() as u64);
            header.set_mode(0o644);
            header.set_cksum();
            builder
                .append_data(&mut header, format!("{root}/{name}"), contents.as_bytes())
                .expect("append");
        }

        builder
            .into_inner()
            .expect("finish tar")
            .finish()
            .expect("finish gz");
        path
    }

    fn targets(tmp: &Path) -> (PathBuf, PathBuf) {
        (tmp.join("engine/.staging"), tmp.join("engine/ComfyUI"))
    }

    #[test]
    fn strips_the_root_directory_and_lands_the_contents_at_dest() {
        let tmp = tempfile::tempdir().expect("temp dir");
        let (staging, dest) = targets(tmp.path());
        std::fs::create_dir_all(tmp.path().join("engine")).expect("engine dir");

        let tar = tarball(
            tmp.path(),
            "ComfyUI-abc123",
            &[("main.py", "print('hi')"), ("requirements.txt", "torch\n")],
        );

        unpack_stripped(&tar, &staging, &dest, "ComfyUI-abc123").expect("unpack");

        // The sha-suffixed directory must not survive into the destination.
        assert!(!dest.join("ComfyUI-abc123").exists());
        assert_eq!(
            std::fs::read_to_string(dest.join("main.py")).expect("main.py"),
            "print('hi')"
        );
        assert!(dest.join("requirements.txt").is_file());
    }

    #[test]
    fn removes_its_staging_when_it_is_done() {
        let tmp = tempfile::tempdir().expect("temp dir");
        let (staging, dest) = targets(tmp.path());
        std::fs::create_dir_all(tmp.path().join("engine")).expect("engine dir");

        let tar = tarball(tmp.path(), "ComfyUI-abc123", &[("main.py", "x")]);
        unpack_stripped(&tar, &staging, &dest, "ComfyUI-abc123").expect("unpack");

        assert!(!staging.exists(), "staging leaked ~700MB of scratch");
    }

    /// The reprovision path: an old engine is already sitting at `dest`.
    #[test]
    fn replaces_an_existing_checkout_without_merging_into_it() {
        let tmp = tempfile::tempdir().expect("temp dir");
        let (staging, dest) = targets(tmp.path());
        std::fs::create_dir_all(&dest).expect("old checkout");
        std::fs::write(dest.join("stale.py"), "old").expect("stale file");

        let tar = tarball(tmp.path(), "ComfyUI-new", &[("main.py", "new")]);
        unpack_stripped(&tar, &staging, &dest, "ComfyUI-new").expect("unpack");

        assert!(
            !dest.join("stale.py").exists(),
            "a file from the previous engine survived the reprovision"
        );
        assert_eq!(
            std::fs::read_to_string(dest.join("main.py")).expect("main.py"),
            "new"
        );
    }

    /// A half-finished previous attempt must not contribute files.
    #[test]
    fn discards_whatever_a_previous_attempt_left_in_staging() {
        let tmp = tempfile::tempdir().expect("temp dir");
        let (staging, dest) = targets(tmp.path());
        std::fs::create_dir_all(staging.join("ComfyUI-abc123")).expect("partial staging");
        std::fs::write(staging.join("ComfyUI-abc123/junk.py"), "junk").expect("junk");

        let tar = tarball(tmp.path(), "ComfyUI-abc123", &[("main.py", "real")]);
        unpack_stripped(&tar, &staging, &dest, "ComfyUI-abc123").expect("unpack");

        assert!(!dest.join("junk.py").exists());
    }

    #[test]
    fn reports_a_root_that_is_not_the_pinned_one() {
        let tmp = tempfile::tempdir().expect("temp dir");
        let (staging, dest) = targets(tmp.path());

        let tar = tarball(tmp.path(), "ComfyUI-somethingelse", &[("main.py", "x")]);
        let err = unpack_stripped(&tar, &staging, &dest, "ComfyUI-abc123")
            .expect_err("wrong root must fail");

        assert!(matches!(err, ArchiveError::MissingRoot { .. }));
        assert!(!dest.exists(), "dest was created despite the failure");
    }

    /// `unpack`'s traversal guard is the reason this module doesn't walk entries
    /// itself, which makes it load-bearing — so it gets asserted rather than
    /// taken from the docs.
    ///
    /// Note the header is filled in by hand: `append_data` validates the path
    /// and refuses to *write* `..`, so the builder cannot produce the archive
    /// this test needs. A hostile server is under no such constraint.
    #[test]
    fn a_traversing_entry_cannot_escape_staging() {
        let tmp = tempfile::tempdir().expect("temp dir");
        let (staging, dest) = targets(tmp.path());
        let outside = tmp.path().join("pwned.txt");

        let path = tmp.path().join("evil.tar.gz");
        let enc = flate2::write::GzEncoder::new(
            File::create(&path).expect("create"),
            flate2::Compression::fast(),
        );
        let mut builder = tar::Builder::new(enc);

        let payload = b"pwned";
        let escaping = b"ComfyUI-abc123/../../pwned.txt";
        let mut header = tar::Header::new_gnu();
        header.set_size(payload.len() as u64);
        header.set_mode(0o644);
        header.as_gnu_mut().expect("gnu header").name[..escaping.len()].copy_from_slice(escaping);
        header.set_cksum();
        builder.append(&header, &payload[..]).expect("append");
        builder.into_inner().expect("tar").finish().expect("gz");

        // Whether it errors or skips the entry is the tar crate's call. What
        // matters is only that the file does not appear.
        let _ = unpack_stripped(&path, &staging, &dest, "ComfyUI-abc123");

        assert!(
            !outside.exists(),
            "tar entry escaped the staging directory: {}",
            outside.display()
        );
    }

    #[test]
    fn reports_a_truncated_download_rather_than_half_unpacking_it() {
        let tmp = tempfile::tempdir().expect("temp dir");
        let (staging, dest) = targets(tmp.path());

        let tar = tmp.path().join("truncated.tar.gz");
        let mut f = File::create(&tar).expect("create");
        f.write_all(b"\x1f\x8b\x08\x00garbage").expect("write");
        drop(f);

        assert!(unpack_stripped(&tar, &staging, &dest, "ComfyUI-abc123").is_err());
        assert!(!dest.exists());
    }
}
