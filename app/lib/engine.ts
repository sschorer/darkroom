/**
 * The engine IPC surface, mirroring `native/src/engine/bootstrap.rs`.
 *
 * Hand-written and therefore capable of drifting from the Rust that produces it.
 * That's tolerable at two commands and is not a pattern to grow: once the engine
 * has a real API (#10 onwards), this wants generating or schema-checking, the
 * way the registry's one definition is shared rather than copied.
 */
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

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
 * The await is silent by design — progress arrives out-of-band on
 * {@link onEngineProgress}, because the events are high-frequency and the
 * command resolves only once, at the end. Subscribe before invoking.
 */
export const bootstrapEngine = () => invoke<Installed>("bootstrap_engine");

/**
 * A bootstrap progress update, mirroring `engine::progress::Progress`. Tagged
 * by `phase` so it reads as a discriminated union — narrow on `phase`.
 */
export type EngineProgress =
  /** Fetching the ComfyUI tarball. `total` is null when the server sent no Content-Length. */
  | { phase: "downloading"; received: number; total: number | null }
  /** Expanding the tarball into the checkout. */
  | { phase: "unpacking" }
  /** A uv step is running; `line` is uv's latest output line. */
  | { phase: "installing"; step: string; line: string }
  /** Importing torch to see what hardware it found. */
  | { phase: "verifying" };

/**
 * Subscribes to bootstrap progress. Resolves to an unlisten function — call it
 * when the install settles (see `App.tsx`), or the listener outlives the run.
 */
export const onEngineProgress = (cb: (p: EngineProgress) => void): Promise<UnlistenFn> =>
  listen<EngineProgress>("engine://progress", (e) => cb(e.payload));
