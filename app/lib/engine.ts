/**
 * The engine IPC surface, mirroring `native/src/engine/bootstrap.rs`.
 *
 * Hand-written and therefore capable of drifting from the Rust that produces it.
 * That's tolerable at two commands and is not a pattern to grow: once the engine
 * has a real API (#10 onwards), this wants generating or schema-checking, the
 * way the registry's one definition is shared rather than copied.
 */
import { invoke } from "@tauri-apps/api/core";

/** What torch found. `cuda` is the only supported generation path (TD-2). */
export type Accelerator = "cuda" | "mps" | "cpu";

/** `engine/.version`. Its presence on disk means the install is whole. */
export interface Installed {
  comfy_sha: string;
  lock_digest: string;
  accelerator: Accelerator;
  /** e.g. `2.13.0+cu129`. A bare `2.13.0` is a CPU wheel — see #4. */
  torch: string;
}

export type EngineStatus =
  | { state: "missing" }
  | { state: "stale"; installed: Installed; pinned: string }
  | { state: "ready"; installed: Installed };

export const engineStatus = () => invoke<EngineStatus>("engine_status");

/**
 * Provisions the engine. Resolves after ~10 minutes on a cold machine, or
 * immediately when it is already at the pinned revision.
 *
 * There is no progress here — that's #5, and it is the missing half of ADR-004's
 * accepted cost. Until it lands, this is a ten-minute await with nothing to show.
 */
export const bootstrapEngine = () => invoke<Installed>("bootstrap_engine");
