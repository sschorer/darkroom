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
