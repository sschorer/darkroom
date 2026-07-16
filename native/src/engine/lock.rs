//! Reads and validates `engine/comfy.lock` — the engine pin (§8.2, ADR-014).
//!
//! The lock is compiled into the binary with `include_str!` rather than shipped
//! as a bundle resource. Two reasons, both about it being a *pin*:
//!
//! - It is versioned with the app, not with the user's data. §8.2 makes the app
//!   and engine tracks independent, and the lock is the app track's statement of
//!   which engine it needs. Reading it from disk at runtime would let the two
//!   drift, which is the version skew §8.2 exists to prevent.
//! - A missing or malformed resource is a runtime failure on a user's machine.
//!   A missing or malformed `include_str!` is a compile error on ours.
//!
//! Cargo tracks `include_str!` targets, so editing the lock rebuilds the crate.

use std::sync::OnceLock;

use serde::Deserialize;
use sha2::{Digest, Sha256};

/// The pin itself, verbatim. Also the input to [`Lock::digest`].
const LOCK_SOURCE: &str = include_str!("../../../engine/comfy.lock");

/// Where the tarball comes from. Not configurable from the lock: the lock names
/// a repo, and we build the URL. A lock that could name a full URL would be a
/// lock that could point the bootstrap anywhere.
const CODELOAD_HOST: &str = "https://codeload.github.com";

#[derive(Debug, thiserror::Error)]
pub enum LockError {
    #[error("engine/comfy.lock is not valid JSON: {0}")]
    Malformed(#[from] serde_json::Error),

    #[error("engine/comfy.lock has an invalid `{field}`: {reason}\n  value: {value}")]
    Invalid {
        field: &'static str,
        value: String,
        reason: &'static str,
    },
}

/// A pinned ComfyUI revision and the Python environment it wants.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Lock {
    /// Prose for whoever opens the file. Carried so `deny_unknown_fields` —
    /// which is here to catch a misspelled key rather than silently defaulting
    /// it — doesn't reject the file's own explanation of itself.
    #[serde(rename = "_comment", default)]
    _comment: String,

    /// `owner/name` on GitHub. Note this is `Comfy-Org/ComfyUI`: the old
    /// `comfyanonymous/ComfyUI` still resolves, but only by HTTP redirect, and
    /// a redirect is not a pin.
    pub repo: String,

    /// The human-facing name of `sha` (a tag). Never used to fetch — a tag is
    /// mutable and this one is a label for the maintainer's benefit.
    #[serde(rename = "ref")]
    pub git_ref: String,

    /// The commit. This is the pin (RISK-1).
    pub sha: String,

    /// Passed to `uv venv --python`. uv downloads this interpreter if the
    /// machine has none — ADR-004's promise that we never need a system Python.
    pub python: String,

    pub torch: Torch,
}

/// How torch gets installed, which is the whole reason this file has more in it
/// than a SHA.
///
/// ComfyUI's `requirements.txt` lists `torch` unpinned. On Linux that resolves
/// to a PyPI wheel with CUDA bundled and everything works. On Windows the PyPI
/// wheel is **CPU-only**, so a plain `-r requirements.txt` yields a ComfyUI that
/// starts, renders, and takes twenty minutes per image with no error anywhere to
/// explain it. Installing torch from PyTorch's own index first is what makes the
/// Windows install real.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Torch {
    /// Installed ahead of `requirements.txt`. The later resolve sees them
    /// already satisfied and leaves them alone.
    pub packages: Vec<String>,

    pub index_url: IndexUrl,
}

/// The PyTorch wheel index per OS, or `None` to use PyPI.
///
/// Per-OS because CUDA is per-OS. macOS has had no CUDA build for years, and
/// PyTorch's cu* indexes carry no macOS wheels at all, so pointing a Mac at one
/// resolves to nothing. There, PyPI's default wheel is the MPS-capable one and
/// is the right answer (TD-2 — Apple Silicon is not a supported path regardless).
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct IndexUrl {
    pub linux: Option<String>,
    pub windows: Option<String>,
    pub macos: Option<String>,
}

impl IndexUrl {
    /// The index for the OS this binary was built for.
    pub fn host(&self) -> Option<&str> {
        #[cfg(target_os = "windows")]
        let url = &self.windows;
        #[cfg(target_os = "macos")]
        let url = &self.macos;
        #[cfg(not(any(target_os = "windows", target_os = "macos")))]
        let url = &self.linux;

        url.as_deref()
    }
}

impl Lock {
    /// The pin compiled into this build.
    ///
    /// `Result` rather than a panic even though the input is a compile-time
    /// constant: CLAUDE.md's no-panic rule is not conditional, and a window that
    /// vanishes is a worse outcome than an error we can print. The lock being
    /// well-formed is asserted by a test in this module, so a bad edit fails in
    /// CI rather than reaching a user at all.
    pub fn pinned() -> Result<&'static Lock, LockError> {
        static PINNED: OnceLock<Result<Lock, String>> = OnceLock::new();

        // LockError isn't Clone (serde_json::Error isn't), and a cached error
        // still has to be returnable more than once — so the cache holds the
        // rendered message and reconstitutes it.
        PINNED
            .get_or_init(|| Lock::parse(LOCK_SOURCE).map_err(|e| e.to_string()))
            .as_ref()
            .map_err(|msg| LockError::Invalid {
                field: "comfy.lock",
                value: msg.clone(),
                reason: "the compiled-in pin did not parse; see the value",
            })
    }

    fn parse(source: &str) -> Result<Lock, LockError> {
        let lock: Lock = serde_json::from_str(source)?;
        lock.validate()?;
        Ok(lock)
    }

    /// Identifies the pin as a whole, not just the commit.
    ///
    /// `.version` records this. A SHA alone would be the obvious thing to
    /// compare and would be wrong: changing `torch.index_url` from cu129 to
    /// cu130 leaves `sha` untouched while making every existing venv wrong, and
    /// a SHA comparison would call those installs healthy forever. Digesting the
    /// whole file means any edit to the pin is a reprovision.
    pub fn digest(&self) -> String {
        format!("sha256:{:x}", Sha256::digest(LOCK_SOURCE.as_bytes()))
    }

    /// `https://codeload.github.com/<repo>/tar.gz/<sha>`.
    ///
    /// Codeload rather than `git clone`: ADR-004 keeps the bundle to one
    /// sidecar, and requiring git on the user's machine would fail Q2 on a
    /// clean Windows box.
    ///
    /// Note what is *not* here: an expected digest for the tarball. GitHub does
    /// not promise its archives are byte-stable — the compression is generated,
    /// not stored — so pinning one would fail on GitHub's schedule rather than
    /// ours. The commit SHA in the path is the integrity claim, and TLS is what
    /// makes it worth anything. This is the one artifact in the system whose
    /// bytes we do not check against a pinned hash (§8.4).
    pub fn tarball_url(&self) -> String {
        format!("{CODELOAD_HOST}/{}/tar.gz/{}", self.repo, self.sha)
    }

    /// The directory GitHub puts inside its tarball: `<name>-<sha>`.
    pub fn tarball_root(&self) -> String {
        let name = self.repo.rsplit('/').next().unwrap_or(&self.repo);
        format!("{name}-{}", self.sha)
    }

    /// Everything here is interpolated into a URL or an argv, so none of it is
    /// taken on trust — even though the lock is ours and ships signed inside the
    /// bundle. The cost is one function; the failure it prevents is a typo in a
    /// pin turning into a fetch from somewhere we didn't mean.
    fn validate(&self) -> Result<(), LockError> {
        let bad = |field, value: &str, reason| LockError::Invalid {
            field,
            value: value.to_owned(),
            reason,
        };

        if self.sha.len() != 40 || !self.sha.bytes().all(|b| b.is_ascii_hexdigit()) {
            return Err(bad("sha", &self.sha, "expected a 40-character commit hash"));
        }
        // Uppercase is a valid hash and an invalid pin: `.version` compares the
        // recorded SHA verbatim, and two spellings of one commit would look
        // like two engines.
        if self.sha.bytes().any(|b| b.is_ascii_uppercase()) {
            return Err(bad("sha", &self.sha, "must be lowercase"));
        }

        // Guards the URL path. `..` or a slash smuggled in here is the whole
        // reason the lock names a repo instead of a URL.
        let segments: Vec<&str> = self.repo.split('/').collect();
        let plausible = |s: &&str| {
            !s.is_empty()
                && *s != "."
                && *s != ".."
                && s.bytes()
                    .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.'))
        };
        if segments.len() != 2 || !segments.iter().all(plausible) {
            return Err(bad("repo", &self.repo, "expected owner/name"));
        }

        // `uv venv --python <this>`. A charset check ("digits and dots") is not
        // enough: it accepts ".", "3.", and "3..12", which reach uv as a version
        // it can't resolve and fail the provision after the download. Require
        // dot-separated numeric components, at least major.minor, none empty.
        let components: Vec<&str> = self.python.split('.').collect();
        let numeric = |s: &&str| !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit());
        if components.len() < 2 || !components.iter().all(numeric) {
            return Err(bad(
                "python",
                &self.python,
                "expected a version like 3.12 — numeric major.minor",
            ));
        }

        if self.torch.packages.is_empty() {
            return Err(bad("torch.packages", "[]", "must name at least torch"));
        }
        for pkg in &self.torch.packages {
            // A package spec is an argv entry. Anything that isn't a plain name
            // — a `--flag`, a URL, a path — is a way to make uv install
            // something the lock doesn't appear to say.
            //
            // The leading-character check is the half that matters and the half
            // that is easy to leave out: `-` is legal *inside* a name, so a
            // charset test alone happily accepts `--index-url` as a package.
            let bare = |b: u8| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.');
            let starts_plainly = pkg
                .bytes()
                .next()
                .is_some_and(|b| b.is_ascii_alphanumeric());
            if !starts_plainly || !pkg.bytes().all(bare) {
                return Err(bad(
                    "torch.packages",
                    pkg,
                    "expected a bare package name; version pins and flags belong in code",
                ));
            }
        }

        for (os, url) in [
            ("linux", &self.torch.index_url.linux),
            ("windows", &self.torch.index_url.windows),
            ("macos", &self.torch.index_url.macos),
        ] {
            if let Some(url) = url {
                // `starts_with("https://")` accepts "https://" with no host, which
                // reaches uv as an unusable index. Parse it, and require both the
                // scheme and a nonempty host — the wheels it serves get executed.
                let parsed = reqwest::Url::parse(url).ok();
                let ok = parsed.as_ref().is_some_and(|u| {
                    u.scheme() == "https" && u.host_str().is_some_and(|h| !h.is_empty())
                });
                if !ok {
                    return Err(bad(
                        "torch.index_url",
                        &format!("{os}: {url}"),
                        "must be an https URL with a host — the wheels it serves get executed",
                    ));
                }
            }
        }

        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The point of `pinned()` returning `Result` instead of panicking: this
    /// test is what turns a bad lock into a red CI run rather than a user's
    /// first run failing.
    #[test]
    fn the_shipped_lock_parses_and_validates() {
        let lock = Lock::pinned().expect("engine/comfy.lock must be valid — fix the file");

        assert_eq!(lock.repo, "Comfy-Org/ComfyUI");
        assert_eq!(lock.python, "3.12");
        assert!(lock.torch.packages.contains(&"torch".to_owned()));
    }

    #[test]
    fn tarball_url_is_codeload_at_the_sha() {
        let lock = Lock::pinned().expect("valid lock");

        assert_eq!(
            lock.tarball_url(),
            format!(
                "https://codeload.github.com/Comfy-Org/ComfyUI/tar.gz/{}",
                lock.sha
            )
        );
        assert_eq!(lock.tarball_root(), format!("ComfyUI-{}", lock.sha));
    }

    /// macOS resolves against PyPI, and that is not an oversight to be tidied
    /// up later by someone who notices the `null`.
    #[test]
    fn macos_has_no_cuda_index() {
        let lock = Lock::pinned().expect("valid lock");

        assert!(lock.torch.index_url.macos.is_none());
        assert!(lock.torch.index_url.linux.is_some());
        assert!(lock.torch.index_url.windows.is_some());
    }

    fn lock_json(sha: &str, repo: &str, python: &str, index: &str) -> String {
        format!(
            r#"{{
              "repo": "{repo}",
              "ref": "v0.28.0",
              "sha": "{sha}",
              "python": "{python}",
              "torch": {{
                "packages": ["torch"],
                "index_url": {{ "linux": {index}, "windows": null, "macos": null }}
              }}
            }}"#
        )
    }

    const GOOD_SHA: &str = "700821e1364eaab0e8f21c538a2131719fec57bf";

    #[test]
    fn a_valid_lock_round_trips() {
        let json = lock_json(
            GOOD_SHA,
            "Comfy-Org/ComfyUI",
            "3.12",
            "\"https://example.com/w\"",
        );
        assert!(Lock::parse(&json).is_ok());
    }

    #[test]
    fn rejects_a_sha_that_is_not_a_full_lowercase_hash() {
        for sha in [
            "700821e",                                  // abbreviated
            "700821E1364EAAB0E8F21C538A2131719FEC57BF", // uppercase
            "master",
            "",
        ] {
            let json = lock_json(sha, "Comfy-Org/ComfyUI", "3.12", "null");
            assert!(
                Lock::parse(&json).is_err(),
                "sha {sha:?} should have been rejected"
            );
        }
    }

    /// `repo` is interpolated straight into the codeload URL.
    #[test]
    fn rejects_a_repo_that_could_escape_the_url_path() {
        for repo in [
            "Comfy-Org/../../evil",
            "Comfy-Org/ComfyUI/extra",
            "ComfyUI",
            "Comfy-Org/Comfy UI",
            "/ComfyUI",
        ] {
            let json = lock_json(GOOD_SHA, repo, "3.12", "null");
            assert!(
                Lock::parse(&json).is_err(),
                "repo {repo:?} should have been rejected"
            );
        }
    }

    /// Every entry becomes an argv element handed to uv.
    #[test]
    fn rejects_a_package_that_is_not_a_bare_name() {
        for pkg in [
            // Legal characters, entirely, and still a flag rather than a name —
            // the case a charset-only check waves through.
            "--index-url",
            "-e",
            "--find-links=https://evil/",
            "torch @ https://evil/x.whl",
            "../../x.whl",
            ".",
            "",
        ] {
            let json = format!(
                r#"{{
                  "repo": "Comfy-Org/ComfyUI",
                  "ref": "v0.28.0",
                  "sha": "{GOOD_SHA}",
                  "python": "3.12",
                  "torch": {{
                    "packages": [{}],
                    "index_url": {{ "linux": null, "windows": null, "macos": null }}
                  }}
                }}"#,
                serde_json::to_string(pkg).expect("string encodes")
            );
            assert!(
                Lock::parse(&json).is_err(),
                "package {pkg:?} should have been rejected"
            );
        }
    }

    #[test]
    fn rejects_an_index_url_that_is_not_https_with_a_host() {
        for index in [
            "\"http://example.com/w\"",     // plaintext
            "\"https://\"",                 // scheme but no host — reaches uv unusable
            "\"download.pytorch.org/whl\"", // no scheme
            "\"ftp://example.com/w\"",
        ] {
            let json = lock_json(GOOD_SHA, "Comfy-Org/ComfyUI", "3.12", index);
            assert!(
                Lock::parse(&json).is_err(),
                "index {index} should have been rejected"
            );
        }
    }

    #[test]
    fn rejects_a_bogus_python_version() {
        for python in [
            "3.12; rm -rf /",
            "system",
            "",
            ".",     // charset-only checks let this through
            "3..12", // empty middle component
            "3.",    // empty minor
            "3",     // no minor
        ] {
            let json = lock_json(GOOD_SHA, "Comfy-Org/ComfyUI", python, "null");
            assert!(
                Lock::parse(&json).is_err(),
                "python {python:?} should have been rejected"
            );
        }
    }

    /// A misspelled key that silently defaults is a pin that doesn't pin.
    #[test]
    fn rejects_an_unknown_field() {
        let json = format!(
            r#"{{
              "repo": "Comfy-Org/ComfyUI",
              "ref": "v0.28.0",
              "sha": "{GOOD_SHA}",
              "python": "3.12",
              "shaa": "typo",
              "torch": {{
                "packages": ["torch"],
                "index_url": {{ "linux": null, "windows": null, "macos": null }}
              }}
            }}"#
        );
        assert!(Lock::parse(&json).is_err());
    }
}
