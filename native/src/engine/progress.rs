//! What the ten-minute bootstrap says about itself while it runs (#5).
//!
//! ADR-004 accepted a ~10 minute, ~6GB first run; §5 Q2 (QS-2) makes "setup
//! shows bytes" the difference between a working first-run and one the user
//! kills because it looks hung. The bootstrap is a sequence of long, silent
//! subprocesses, so the reporting is push, not poll: [`bootstrap`] emits a
//! [`Progress`] on [`EVENT`] as each phase advances, and the frontend renders
//! the latest one.
//!
//! One event type tagged by phase, not one Tauri event name per step: the UI is
//! a single progress view, and switching on `phase` in one listener beats
//! wiring five `listen` calls whose only difference is a label.
//!
//! [`bootstrap`]: crate::engine::bootstrap

use serde::Serialize;
use tauri::{AppHandle, Emitter, Runtime};

/// The Tauri event the frontend listens on. Mirrored by `app/lib/engine.ts`.
pub const EVENT: &str = "engine://progress";

/// A single bootstrap progress update.
///
/// `serde(tag = "phase")` so the payload is a discriminated union the frontend
/// can `switch` on — `{ "phase": "downloading", "received": N, "total": M }`.
/// The variants are the phases a user waits through, in order.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "phase", rename_all = "kebab-case")]
pub enum Progress {
    /// Fetching the ComfyUI tarball. `total` is `None` when the server sent no
    /// `Content-Length` — a bar with no denominator, so the UI shows the count
    /// alone rather than an ETA it can't compute.
    Downloading { received: u64, total: Option<u64> },

    /// Expanding the tarball into the checkout. No byte count: `tar` offers none
    /// worth the plumbing and this is the fast part next to the wheel installs.
    Unpacking,

    /// A `uv` step is running. `step` is the same human label its errors carry
    /// (§8.6); `line` is uv's most recent output line — the only liveness uv
    /// gives once its progress bars are off (they're unreadable on a pipe).
    Installing { step: &'static str, line: String },

    /// Importing torch to see what hardware it found — the last, quick step.
    Verifying,
}

/// Emits a progress event, best-effort.
///
/// A dropped update must never fail a bootstrap: the window can close mid-
/// install, and the only thing to do about a send error is keep provisioning.
/// The install's success is defined by `.version` on disk, not by anyone
/// listening.
pub fn emit<R: Runtime>(app: &AppHandle<R>, progress: Progress) {
    let _ = app.emit(EVENT, progress);
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    // `EngineProgress` in app/lib/engine.ts is a hand-kept mirror of this enum
    // (that file says as much). These pin the wire shape so a serde tag change,
    // a `rename_all` slip, or a renamed field fails a test here rather than
    // silently breaking the progress UI at runtime — the same guard
    // `the_probe_output_shape_is_the_one_we_parse` gives the probe.

    #[test]
    fn downloading_carries_phase_and_byte_fields() {
        assert_eq!(
            serde_json::to_value(Progress::Downloading {
                received: 12,
                total: Some(48),
            })
            .expect("serialize"),
            json!({ "phase": "downloading", "received": 12, "total": 48 }),
        );
    }

    #[test]
    fn a_missing_content_length_serializes_total_as_null() {
        assert_eq!(
            serde_json::to_value(Progress::Downloading {
                received: 12,
                total: None,
            })
            .expect("serialize"),
            json!({ "phase": "downloading", "received": 12, "total": null }),
        );
    }

    #[test]
    fn the_byteless_phases_are_bare_tags() {
        assert_eq!(
            serde_json::to_value(Progress::Unpacking).expect("serialize"),
            json!({ "phase": "unpacking" }),
        );
        assert_eq!(
            serde_json::to_value(Progress::Verifying).expect("serialize"),
            json!({ "phase": "verifying" }),
        );
    }

    #[test]
    fn installing_carries_step_and_line() {
        assert_eq!(
            serde_json::to_value(Progress::Installing {
                step: "installing PyTorch",
                line: "Resolved 33 packages".to_owned(),
            })
            .expect("serialize"),
            json!({
                "phase": "installing",
                "step": "installing PyTorch",
                "line": "Resolved 33 packages",
            }),
        );
    }
}
