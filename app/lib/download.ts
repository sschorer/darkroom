/**
 * The download-manager IPC surface: the `invoke`/`listen` wrappers over the
 * types generated from Rust (`downloads.rs`, ADR-018), plus the one piece of
 * display maths — the ETA — kept pure so it can be tested without an engine.
 *
 * The manager installs a *model*: a manifest names several files (a diffusion
 * model, a text encoder, a VAE), and #21's job is to get all of them onto disk,
 * verified, resumably, from a clean state without a terminal. The payload shapes
 * ({@link DownloadProgress}, {@link ModelStatus}, {@link DownloadOutcome}) are
 * generated; this file keeps only the command names, the event name, and the
 * thin bindings — the same split `engine.ts` makes.
 */
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

import type { DownloadOutcome } from "./generated/DownloadOutcome";
import type { DownloadProgress } from "./generated/DownloadProgress";
import type { FileState } from "./generated/FileState";
import type { FileStatus } from "./generated/FileStatus";
import type { ModelStatus } from "./generated/ModelStatus";
import type { Manifest } from "./registry.schema";

/** A model's install state, a file's, and how a download ended. */
export type { DownloadProgress, DownloadOutcome, ModelStatus, FileStatus, FileState };

/**
 * The download instruction for one file. The canonical definition is the zod
 * schema (`registry.schema.ts`), so this is derived from it rather than
 * redeclared — a manifest's `files` entry is exactly what the Rust command
 * deserialises.
 */
export type FileSpec = Manifest["files"][number];

/**
 * Reports whether a model's files are on disk, partway (resumable), or absent.
 * A pure filesystem read — no network — so the manager can render the right
 * affordance on mount and refresh it after a download settles.
 */
export const modelStatus = (files: FileSpec[]): Promise<ModelStatus> =>
  invoke<ModelStatus>("model_status", { files });

/**
 * Installs a model: downloads every file, verified against its sha256, resuming
 * any `.part` already on disk. Resolves to {@link DownloadOutcome} — `completed`
 * when all files are verified and in place, `cancelled` when the user stopped it
 * (the partial is kept). Rejects only on a real failure (a checksum mismatch, a
 * full disk, a moved file), with the actionable message the Rust side built.
 *
 * Progress arrives out-of-band on {@link onDownloadProgress}; subscribe before
 * invoking, because the events fire throughout a call that resolves only at the
 * end. Only one install runs at a time — a second call while one is in flight
 * rejects rather than queueing.
 */
export const downloadModel = (files: FileSpec[]): Promise<DownloadOutcome> =>
  invoke<DownloadOutcome>("download_model", { files });

/**
 * Cancels the running install, if any. The download stops at the next chunk
 * boundary and leaves its `.part` to resume; {@link downloadModel} then resolves
 * `cancelled`. Harmless when nothing is running.
 */
export const cancelDownload = (): Promise<void> => invoke("cancel_download");

/**
 * Subscribes to install progress. Resolves to an unlisten function — call it
 * when the install settles (or the listener outlives the run and reacts to a
 * later download it never started). Because the event is app-global, a manager
 * should listen only while its own download is in flight.
 */
export const onDownloadProgress = (cb: (p: DownloadProgress) => void): Promise<UnlistenFn> =>
  listen<DownloadProgress>("download://progress", (e) => cb(e.payload));

/**
 * Seconds remaining for a transfer at the current rate, or `null` when it can't
 * be known — no rate sampled yet (a fresh or stalled download), or nothing left
 * to fetch. Kept pure and apart from the component so its division-by-zero and
 * already-done edges are pinned by tests, not discovered in the UI.
 *
 * The batch numbers are the right inputs, not a single file's: the user waits
 * for the whole model, so the ETA is over every remaining byte across all its
 * files at the speed the file in flight is currently moving.
 */
export function etaSeconds(received: number, total: number, bytesPerSec: number): number | null {
  if (bytesPerSec <= 0) return null;
  const remaining = total - received;
  if (remaining <= 0) return null;
  return remaining / bytesPerSec;
}
