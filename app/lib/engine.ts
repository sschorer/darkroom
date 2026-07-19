/**
 * The engine IPC surface: the `invoke`/`listen` wrappers, over types generated
 * from Rust.
 *
 * The payload *shapes* — `Installed`, `Status`, `Progress`, `LogLine` — are no
 * longer hand-copied from `native/src`. ts-rs generates them into
 * `./generated/` from the same structs Tauri serialises, and CI regenerates and
 * diffs them, so a renamed field or a changed serde tag fails the build instead
 * of silently emptying a view at runtime (ADR-018). This file keeps only what
 * can't be generated: the command names, the event names, and the thin wrappers
 * that bind them.
 *
 * The app's older names are preserved as aliases (`EngineStatus`,
 * `EngineProgress`, `EngineLog`) so callers didn't have to churn when the source
 * of truth moved.
 */
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

import type { Accelerator } from "./generated/Accelerator";
import type { Installed } from "./generated/Installed";
import type { LogLine } from "./generated/LogLine";
import type { Progress } from "./generated/Progress";
import type { Status } from "./generated/Status";

/** What torch found. `cuda` is the only supported generation path (TD-2). */
export type { Accelerator };
/** `engine/.version`. Its presence on disk means the install is whole. */
export type { Installed };

/** The engine's install state, as `engine_status` reports it. */
export type EngineStatus = Status;

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
 * Starts ComfyUI and resolves to the loopback port it answers on (§6.2). Build
 * a {@link import("./comfy").ComfyClient} from that port to talk to it.
 *
 * Idempotent on the Rust side: calling it while an engine is already up returns
 * the same port rather than spawning a second one, so a "Generate" button can
 * call it unconditionally. Resolves only once the engine really answers
 * `/system_stats` (up to 120s on a cold start), or rejects with the actionable
 * message the sidecar built — which points at the engine log on a failed boot,
 * and fails fast if the engine exits during startup rather than after the
 * timeout.
 */
export const startEngine = () => invoke<number>("start_engine");

/**
 * A bootstrap progress update. Tagged by `phase` so it reads as a discriminated
 * union — narrow on `phase`. Generated from `engine::progress::Progress`.
 */
export type EngineProgress = Progress;

/**
 * Subscribes to bootstrap progress. Resolves to an unlisten function — call it
 * when the install settles (see `App.tsx`), or the listener outlives the run.
 */
export const onEngineProgress = (cb: (p: EngineProgress) => void): Promise<UnlistenFn> =>
  listen<EngineProgress>("engine://progress", (e) => cb(e.payload));

/**
 * One captured line of engine output. `stream` distinguishes ComfyUI's stdout
 * from the stderr its tracebacks print to, so the UI can tell an error line from
 * ordinary chatter. Generated from `sidecar::LogLine`.
 */
export type EngineLog = LogLine;

/**
 * Subscribes to the engine's live log. The same lines are also written to a
 * rotating file on disk (revealed by {@link openLogs}), so a traceback survives
 * even with no listener; this is only for showing it as it happens. Resolves to
 * an unlisten function — call it when the view that shows logs goes away.
 */
export const onEngineLog = (cb: (l: EngineLog) => void): Promise<UnlistenFn> =>
  listen<EngineLog>("engine://log", (e) => cb(e.payload));

/**
 * Reveals the engine-log directory in the OS file manager (ADR-015). The real
 * Python error lives in that log, several layers from anything the UI shows
 * (§8.6), so the failure views offer this as a one-click route to it. It's the
 * frontend replacement for Help → Open Logs, which the M2 chrome hides on
 * Windows/Linux (ADR-019).
 */
export const openLogs = () => invoke<void>("open_logs");
