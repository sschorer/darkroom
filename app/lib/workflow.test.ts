/**
 * Unit tests for {@link buildWorkflow} — the two ADR-005 invariants first: it
 * never mutates the caller's workflow, and it throws (rather than silently
 * skipping) on a manifest param whose node isn't in the workflow. The rest cover
 * the value-resolution rules: supplied value wins, default fills in, and a param
 * with neither is left as the export had it.
 *
 * `buildWorkflow` reads only `manifest.params`, so the fixtures carry just that
 * slice of a manifest rather than a full valid one.
 */
import { describe, expect, it } from "vitest";

import type { Workflow } from "./comfy";
import type { Manifest } from "./registry.schema";
import { buildWorkflow } from "./workflow";

/** A manifest with only the field `buildWorkflow` touches. */
function manifest(params: Manifest["params"]): Manifest {
  return { params } as Manifest;
}

/** A small two-node graph mirroring the flux2-klein shape (a prompt + a sampler). */
function workflow(): Workflow {
  return {
    "6": { class_type: "CLIPTextEncode", inputs: { text: "placeholder" } },
    "20": { class_type: "KSampler", inputs: { steps: 4, seed: 0 } },
  };
}

describe("buildWorkflow", () => {
  it("patches supplied values into the node and field each param names", () => {
    const m = manifest({
      prompt: { node: "6", field: "text" },
      steps: { node: "20", field: "steps" },
    });

    const out = buildWorkflow(m, workflow(), { prompt: "a cat", steps: 8 });

    expect(out["6"].inputs.text).toBe("a cat");
    expect(out["20"].inputs.steps).toBe(8);
  });

  it("does not mutate the caller's workflow", () => {
    const m = manifest({ prompt: { node: "6", field: "text" } });
    const original = workflow();

    buildWorkflow(m, original, { prompt: "a cat" });

    // The input graph is untouched; the patch happened on the clone.
    expect(original["6"].inputs.text).toBe("placeholder");
  });

  it("throws when a param targets a node absent from the workflow", () => {
    // A stale manifest: node "99" was renumbered away on re-export.
    const m = manifest({ prompt: { node: "99", field: "text" } });

    expect(() => buildWorkflow(m, workflow(), { prompt: "a cat" })).toThrow(/node "99"/);
  });

  it("throws on a stale node even when the value comes from a default", () => {
    // No value supplied, but the default still forces the patch — and the
    // missing node must surface, not be quietly skipped.
    const m = manifest({ steps: { node: "99", field: "steps", default: 8 } });

    expect(() => buildWorkflow(m, workflow(), {})).toThrow(/node "99"/);
  });

  it("falls back to a param's default when no value is supplied", () => {
    const m = manifest({ steps: { node: "20", field: "steps", default: 8 } });

    const out = buildWorkflow(m, workflow(), {});

    expect(out["20"].inputs.steps).toBe(8);
  });

  it("prefers a supplied value over the default", () => {
    const m = manifest({ steps: { node: "20", field: "steps", default: 8 } });

    const out = buildWorkflow(m, workflow(), { steps: 2 });

    expect(out["20"].inputs.steps).toBe(2);
  });

  it("leaves the export's value when a param has neither a value nor a default", () => {
    const m = manifest({ steps: { node: "20", field: "steps" } });

    const out = buildWorkflow(m, workflow(), {});

    expect(out["20"].inputs.steps).toBe(4); // the author's baked-in value
  });
});
