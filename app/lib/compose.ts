/**
 * The compose bar's param chips (#25), derived from a model's manifest.
 *
 * Kept out of the component so it's pure and testable without rendering — that a
 * model switch swaps the chips (image aspect ↔ video frames) is this issue's
 * acceptance criterion. Whatever `params` a manifest declares is what shows: no
 * per-model UI code, the ADR-005 promise. The chips *reflect* the manifest here;
 * making them editable is the manifest-driven params form (#26).
 */
import type { Manifest } from "./registry.schema";

/** One param chip: a mono label with an optional emphasised value and action. */
export interface Chip {
  label: string;
  value?: string;
  /** When set, the chip is a button (the seed's shuffle) with this glyph. */
  action?: { glyph: string; onClick: () => void; title: string };
}

/** Greatest common divisor, for reducing a pixel size to an aspect ratio. */
function gcd(a: number, b: number): number {
  return b === 0 ? a : gcd(b, a % b);
}

/** The `default` of a manifest param as a number, or `null` if it has none / a
 *  non-numeric one. The compose chips only show numeric params. */
function numericDefault(manifest: Manifest, key: string): number | null {
  const value = manifest.params[key]?.default;
  return typeof value === "number" ? value : null;
}

/**
 * The chips for a model: image models get seed / steps / aspect; video models
 * swap the aspect chip for a frame count (the mockup's "duration/frames"). The
 * live `seed` and its `onShuffle` are passed in because the seed is the one
 * value the bar mutates — everything else reads straight off the manifest.
 */
export function chipsFor(manifest: Manifest, seed: number, onShuffle: () => void): Chip[] {
  const chips: Chip[] = [];

  if (manifest.params.seed) {
    chips.push({
      label: "seed",
      value: String(seed),
      action: { glyph: "⇄", onClick: onShuffle, title: "New random seed" },
    });
  }

  const steps = numericDefault(manifest, "steps");
  if (steps !== null) chips.push({ label: "steps", value: String(steps) });

  const width = numericDefault(manifest, "width");
  const height = numericDefault(manifest, "height");
  if (manifest.kind === "video") {
    const length = numericDefault(manifest, "length");
    if (length !== null) chips.push({ label: "frames", value: String(length) });
  } else if (width !== null && height !== null) {
    const d = gcd(width, height) || 1;
    chips.push({ label: `${width / d}:${height / d}` });
  }

  return chips;
}
