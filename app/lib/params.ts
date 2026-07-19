/**
 * The compose bar's manifest-driven params form (#26). Whatever numeric `params`
 * a manifest declares — with their `min`/`max`/`default` — is what the bar lets
 * you edit: no per-model UI code, the ADR-005 promise made interactive. A model
 * switch swaps the fields (image aspect ↔ video frames) because they are read
 * straight off the new manifest.
 *
 * This is the pure half, kept out of the component so it is testable without
 * rendering: it turns a manifest plus the live edit {@link ParamState} into the
 * {@link Field}s the bar draws, and — the point of the issue — into the
 * {@link ParamValues} that feed `buildWorkflow()` (`workflow.ts`). The component
 * (`ComposeBar.tsx`) owns only the popovers and the keystrokes; the meaning of a
 * value, its bounds, and how an aspect maps to width/height all live here.
 */
import type { Manifest, ParamSpec } from "./registry.schema";
import type { ParamValues } from "./workflow";

/**
 * The live, user-editable state of the form. `seed` is model-agnostic and the
 * one value the bar mutates on its own (shuffle), so it survives a model switch;
 * `edits` are numeric overrides keyed by param name, dropped when the model
 * changes because a different model's bounds make them meaningless. A param
 * absent from `edits` shows — and submits — its manifest `default`.
 */
export interface ParamState {
  seed: number;
  edits: Record<string, number>;
}

/** The prompt param name and the seed param name get bespoke handling (the big
 *  input; the shuffle) rather than a numeric chip, so the generic field/value
 *  code skips them by name. */
const PROMPT = "prompt";
const SEED = "seed";

/** A fresh 31-bit seed. ComfyUI seeds are non-negative integers; 2³¹ keeps them
 *  well inside a JS-safe range and matches the mockup's ~9-digit value. Lives
 *  here, with the rest of the param semantics, so both the compose bar's initial
 *  state and a reused recipe draw their seed from one place. */
export function randomSeed(): number {
  return Math.floor(Math.random() * 0x80000000);
}

/**
 * The {@link ParamState} that reproduces a finished job's recipe (#28's "reuse
 * recipe"). The seed comes back verbatim; every other numeric value becomes an
 * `edit`, so the compose bar shows — and re-submits — exactly what made the
 * output. The prompt is threaded separately (it isn't part of {@link
 * ParamState}); a value that isn't a number is ignored, leaving that param at
 * its manifest default.
 */
export function recipeState(values: ParamValues): ParamState {
  const edits: Record<string, number> = {};
  for (const [name, value] of Object.entries(values)) {
    if (name === PROMPT || name === SEED) continue;
    if (typeof value === "number") edits[name] = value;
  }
  const seed = values[SEED];
  return { seed: typeof seed === "number" ? seed : randomSeed(), edits };
}

/** One editable chip in the bar. A discriminated union so the component renders
 *  the right popover: a seed (value + shuffle), a plain clamped number (steps /
 *  frames), or an aspect picker (image size, chosen from presets). */
export type Field =
  | { kind: "seed"; value: number }
  | { kind: "number"; name: string; label: string; value: number; min: number; max: number }
  | { kind: "aspect"; options: AspectOption[]; selected: string | null };

/** A concrete size a preset ratio resolves to for this model, within its
 *  width/height bounds. `label` is the reduced ratio ("16:9") shown collapsed. */
export interface AspectOption {
  label: string;
  width: number;
  height: number;
}

/** The aspect ratios the size picker offers, as `[w, h]`. Portrait and landscape
 *  of each are listed separately so the collapsed chip can show the exact one. */
const ASPECT_PRESETS: ReadonlyArray<readonly [number, number]> = [
  [1, 1],
  [3, 2],
  [2, 3],
  [4, 3],
  [3, 4],
  [16, 9],
  [9, 16],
];

/** Diffusion latents downscale by 8 and both shipped models want their sides on
 *  a coarser grid than that (klein /64, LTX /64); 64 is the safe common step, so
 *  every preset resolves to a size the engine will accept. */
const SIZE_STEP = 64;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** The bounds of a numeric param, with open ends where the manifest omits them —
 *  a param may declare only a `default` (e.g. a seed) and still be clamped
 *  harmlessly against ±∞. */
function bounds(spec: ParamSpec): { min: number; max: number } {
  return { min: spec.min ?? -Infinity, max: spec.max ?? Infinity };
}

/** The `default` of a param as a number, or `null` when it has none or a
 *  non-numeric one — those params are left to whatever the workflow bakes in. */
function numericDefault(spec: ParamSpec | undefined): number | null {
  return typeof spec?.default === "number" ? spec.default : null;
}

/**
 * The current value of a numeric param: the user's edit if present, else the
 * manifest default, clamped either way so a stale edit or an out-of-range
 * default can never escape the bounds the form promises.
 */
export function resolveNumber(manifest: Manifest, state: ParamState, name: string): number {
  const spec = manifest.params[name];
  const fallback = numericDefault(spec) ?? 0;
  const raw = name in state.edits ? state.edits[name] : fallback;
  const { min, max } = bounds(spec);
  return clamp(raw, min, max);
}

/**
 * Clamps a raw input for a numeric param to its manifest bounds. The component
 * calls this when committing a typed value, so an edit stored in {@link
 * ParamState} is already in range and every other reader can trust it.
 */
export function clampToParam(manifest: Manifest, name: string, value: number): number {
  const { min, max } = bounds(manifest.params[name]);
  return clamp(value, min, max);
}

/**
 * The sizes the aspect presets resolve to for this model. The long edge is the
 * model's larger default dimension; the short edge follows the ratio, snapped to
 * the {@link SIZE_STEP} grid and clamped into the width/height bounds. Returns
 * empty when the model has no numeric width/height — a model that doesn't expose
 * size simply shows no aspect chip.
 */
export function aspectOptionsFor(manifest: Manifest): AspectOption[] {
  const w = manifest.params.width;
  const h = manifest.params.height;
  const dw = numericDefault(w);
  const dh = numericDefault(h);
  if (dw === null || dh === null) return [];

  const wb = bounds(w);
  const hb = bounds(h);
  const long = Math.max(dw, dh);

  return ASPECT_PRESETS.map(([rw, rh]) => {
    const short = Math.round((long * Math.min(rw, rh)) / Math.max(rw, rh) / SIZE_STEP) * SIZE_STEP;
    const landscape = rw >= rh;
    return {
      label: `${rw}:${rh}`,
      width: clamp(landscape ? long : short, wb.min, wb.max),
      height: clamp(landscape ? short : long, hb.min, hb.max),
    };
  });
}

/** Which preset the current width/height match, or `null` if they match none
 *  (a size the presets don't cover — the chip then shows the raw ratio). */
function selectedAspect(
  manifest: Manifest,
  state: ParamState,
  options: AspectOption[],
): string | null {
  const width = resolveNumber(manifest, state, "width");
  const height = resolveNumber(manifest, state, "height");
  return options.find((o) => o.width === width && o.height === height)?.label ?? null;
}

/**
 * The editable chips for a model: seed, steps, then aspect for an image model or
 * a frame count for a video one — exactly the params the manifest declares, in
 * the mockup's order. Whatever a manifest omits simply produces no chip.
 */
export function fieldsFor(manifest: Manifest, state: ParamState): Field[] {
  const fields: Field[] = [];

  if (manifest.params[SEED]) {
    fields.push({ kind: "seed", value: state.seed });
  }

  if (numericDefault(manifest.params.steps) !== null) {
    fields.push(numberField(manifest, state, "steps", "steps"));
  }

  if (manifest.kind === "video") {
    if (numericDefault(manifest.params.length) !== null) {
      fields.push(numberField(manifest, state, "length", "frames"));
    }
  } else {
    const options = aspectOptionsFor(manifest);
    if (options.length > 0) {
      fields.push({ kind: "aspect", options, selected: selectedAspect(manifest, state, options) });
    }
  }

  return fields;
}

function numberField(manifest: Manifest, state: ParamState, name: string, label: string): Field {
  const { min, max } = bounds(manifest.params[name]);
  return { kind: "number", name, label, value: resolveNumber(manifest, state, name), min, max };
}

/**
 * The user's choices as the value map `buildWorkflow()` patches into the
 * workflow — the whole reason the form exists. Every numeric param resolves to
 * its edited-or-default value (width/height included, so an aspect choice lands
 * as concrete pixels); the prompt and seed are threaded through by name.
 *
 * `buildWorkflow` fills any param left out here from its manifest default and
 * throws on a node the workflow lacks, so the two together are the ADR-005
 * contract: the manifest names the fields, this resolves their values, and a
 * manifest gone stale against its workflow fails loudly rather than at the
 * pixels.
 */
export function resolveValues(manifest: Manifest, state: ParamState, prompt: string): ParamValues {
  const values: ParamValues = {};

  if (manifest.params[PROMPT]) values[PROMPT] = prompt;
  if (manifest.params[SEED]) values[SEED] = state.seed;

  for (const name of Object.keys(manifest.params)) {
    if (name === PROMPT || name === SEED) continue;
    if (numericDefault(manifest.params[name]) === null) continue;
    values[name] = resolveNumber(manifest, state, name);
  }

  return values;
}
