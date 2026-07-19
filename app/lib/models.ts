/**
 * The Studio's model list, resolved for the compose-bar selector (#25).
 *
 * The pill and its menu need three facts about every model the bundle offers,
 * from three different owners:
 *   - **what it is** — the validated {@link Manifest} ({@link availableModels},
 *     ADR-005);
 *   - **is it installed** — every weight file present on disk ({@link modelStatus},
 *     a cheap filesystem read on the Rust side, no engine needed);
 *   - **does it fit** — the GPU's real VRAM against `requires.vram_gb`
 *     ({@link gateModel}, §8.5, Q5).
 *
 * Only the last needs the engine: the VRAM total comes from `/system_stats`,
 * which means a running engine. So the read is split — {@link resolveInstalled}
 * runs on mount with no engine cost and tells the bar which models are
 * selectable, and {@link readVram} is called lazily (when the menu first opens)
 * to fill in the gating reasons. A model you already installed always fits, so
 * the bar is fully usable before the VRAM read ever happens; the gate only
 * changes what a *not-yet-installed* row says.
 */
import { ComfyClient } from "./comfy";
import { modelStatus } from "./download";
import { startEngine } from "./engine";
import { gateModel, type GatedModel } from "./gate";
import { availableModels } from "./registry";
import type { Manifest } from "./registry.schema";

/** A model as the compose bar shows it: the manifest, whether its weights are on
 *  disk, and — once VRAM is known — whether the hardware can run it. */
export interface ModelChoice {
  manifest: Manifest;
  /** Every weight file present: the model can be selected and generated with. */
  installed: boolean;
  /** VRAM verdict. `null` until {@link readVram} has run — the fit is unknown,
   *  not "fits", so the UI can tell "not yet checked" from "checked, fits". */
  gate: GatedModel | null;
}

/**
 * Every offered model paired with its install state, with the VRAM verdict left
 * unresolved (`gate: null`). No engine is touched — {@link modelStatus} is a
 * filesystem check — so this can run the instant the Studio mounts and give the
 * bar a selectable list without waiting on (or spawning) the engine.
 */
export async function resolveInstalled(): Promise<ModelChoice[]> {
  const manifests = availableModels();
  return Promise.all(
    manifests.map(async (manifest) => ({
      manifest,
      installed: (await modelStatus(manifest.files)).installed,
      gate: null,
    })),
  );
}

/**
 * The total VRAM in bytes the engine reports, or `null` when it sees no GPU
 * (the CPU/unsupported story is the accelerator warning's, TD-2 — not a
 * fabricated per-model reason). Spawns the engine if it isn't already up:
 * reading VRAM is the first thing that genuinely needs it, and generation would
 * spawn it a moment later anyway.
 */
export async function readVram(): Promise<number | null> {
  const port = await startEngine();
  return new ComfyClient(port).systemStats();
}

/**
 * Re-gates a resolved list against a known VRAM total, preserving order. Pure —
 * the caller does the {@link readVram} read once the menu opens and folds the
 * result back in, so the gating reasons appear without a second disk walk.
 */
export function applyGate(choices: ModelChoice[], vramTotalBytes: number | null): ModelChoice[] {
  return choices.map((choice) => ({ ...choice, gate: gateModel(vramTotalBytes, choice.manifest) }));
}
