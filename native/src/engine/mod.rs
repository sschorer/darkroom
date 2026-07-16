//! The ComfyUI engine: pinning it, installing it, and reporting on it.
//!
//! ```text
//! comfy.lock  ──►  lock.rs      the pin, compiled in
//!                     │
//!                     ▼
//!                  bootstrap.rs ──► archive.rs   tarball ──► engine/ComfyUI
//!                     │
//!                     ▼
//!             engine/.version   written last; presence means healthy
//! ```
//!
//! Spawning the engine and talking to it are #6 onwards. This module stops at
//! "an interpreter exists that can import torch".

pub mod archive;
pub mod bootstrap;
pub mod lock;
pub mod progress;

pub use bootstrap::{provision, status, Accelerator, BootstrapError, Installed, Status};
pub use lock::Lock;
pub use progress::Progress;
