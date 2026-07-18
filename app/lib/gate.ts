/**
 * VRAM gating (#20): decide which models the hardware can actually run, and say
 * why for the ones it can't.
 *
 * Quality goal Q5 is "never offer what the hardware can't run" — an 8GB card
 * must never be handed a 13GB model and left to discover the mismatch as an OOM
 * mid-generation. §8.5 is the concept: read the real VRAM total from the engine
 * ({@link import("./comfy").ComfyClient.systemStats}) and compare it against each
 * manifest's `requires.vram_gb`. This module is that comparison, kept pure and
 * apart from the read so the decision is testable without an engine (ADR-010) —
 * the model picker (#27) does the read, calls in here, and renders each
 * {@link GatedModel} as enabled or **disabled with its reason shown**. Disabled,
 * not hidden: a greyed-out model with an explanation teaches; a missing one
 * looks like a bug.
 *
 * **Units.** The engine reports `vram_total` in bytes; a manifest's
 * `requires.vram_gb` is the nominal card size the model was authored against
 * (`tested_on` records the same figure). A card sold as "24GB" reports a hair
 * *under* 24 GiB — torch and the driver reserve a sliver — so 25757220864 bytes
 * is ~23.99 GiB, and a strict `>= 24 * 2^30` would gate a model out of the exact
 * card it was tested on. Rounding the reported bytes to the nearest whole GiB
 * recovers that nominal size (24), which is also what the user believes their
 * card to be, so the comparison and the message both read in the numbers a
 * human recognises.
 */
import type { Manifest } from "./registry.schema";

/** Bytes per GiB. VRAM is quoted and compared in binary GB, matching how GPUs
 *  are marketed and how {@link import("./comfy").vramTotalFromStats} reports. */
const BYTES_PER_GB = 1024 ** 3;

/** A model paired with whether this machine can run it, and why not if it can't. */
export interface GatedModel {
  manifest: Manifest;
  /** True when the GPU meets `requires.vram_gb` — or when VRAM is unknown. */
  fits: boolean;
  /** A user-facing reason when `fits` is false; `null` otherwise. */
  reason: string | null;
}

/**
 * Gates one model against a VRAM total in bytes (as `/system_stats` reports it).
 *
 * `vramTotalBytes` of `null` means the engine reported no GPU: there is nothing
 * to gate against, so the model passes (`fits: true`) and the CPU/unsupported
 * story is told elsewhere (the accelerator warning, TD-2) rather than as a
 * per-model VRAM reason that would be a guess. A real total is rounded to the
 * nearest whole GiB — the nominal card size — before the comparison, so a model
 * tested on a "24GB" card is not gated off that same card by a sub-GiB reserve.
 */
export function gateModel(vramTotalBytes: number | null, manifest: Manifest): GatedModel {
  if (vramTotalBytes === null) {
    return { manifest, fits: true, reason: null };
  }
  const haveGb = Math.round(vramTotalBytes / BYTES_PER_GB);
  const needGb = manifest.requires.vram_gb;
  if (haveGb >= needGb) {
    return { manifest, fits: true, reason: null };
  }
  return {
    manifest,
    fits: false,
    reason: `Needs ${needGb} GB of VRAM; this GPU has ${haveGb} GB.`,
  };
}

/** Gates a list of models against one VRAM total, preserving order. The picker
 *  feeds this {@link import("./registry").availableModels} and renders the
 *  result (#27). */
export function gateModels(vramTotalBytes: number | null, manifests: Manifest[]): GatedModel[] {
  return manifests.map((manifest) => gateModel(vramTotalBytes, manifest));
}
