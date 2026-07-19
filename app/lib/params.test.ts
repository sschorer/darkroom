import { describe, expect, it } from "vitest";

import {
  aspectOptionsFor,
  clampToParam,
  fieldsFor,
  resolveNumber,
  resolveValues,
  type ParamState,
} from "./params";
import type { Manifest } from "./registry.schema";
import { buildWorkflow } from "./workflow";

/** A manifest with just enough of a params map for the form logic to read. The
 *  rest is filler so the value type-checks as a real Manifest. */
function manifest(over: Partial<Manifest> = {}): Manifest {
  return {
    id: "model",
    name: "Model",
    kind: "image",
    enabled: true,
    license: "Apache-2.0",
    requires: { vram_gb: 13, disk_gb: 14 },
    files: [
      {
        url: "https://huggingface.co/org/model/resolve/main/model.safetensors",
        dest: "models/checkpoints/model.safetensors",
        sha256: "a".repeat(64),
        size: 123,
      },
    ],
    workflow: "workflow.json",
    params: { prompt: { node: "6", field: "text" } },
    output_node: "9",
    tested_on: [{ gpu: "RTX 4090", vram_gb: 24, seconds: 3.5, comfy_sha: "abc1234" }],
    ...over,
  };
}

/** The klein-shaped image manifest: prompt, seed, steps, width, height. */
const klein = manifest({
  kind: "image",
  params: {
    prompt: { node: "6", field: "text" },
    seed: { node: "22", field: "noise_seed", default: 42 },
    steps: { node: "20", field: "steps", default: 4, min: 1, max: 8 },
    width: { node: "5", field: "width", default: 1024, min: 256, max: 2048 },
    height: { node: "5", field: "height", default: 1024, min: 256, max: 2048 },
  },
});

/** The LTX-shaped video manifest: adds a frame count, no aspect chip. */
const ltx = manifest({
  kind: "video",
  params: {
    prompt: { node: "6", field: "text" },
    seed: { node: "71", field: "noise_seed", default: 42 },
    steps: { node: "72", field: "steps", default: 30, min: 8, max: 50 },
    width: { node: "70", field: "width", default: 768, min: 256, max: 1280 },
    height: { node: "70", field: "height", default: 512, min: 256, max: 720 },
    length: { node: "70", field: "length", default: 97, min: 9, max: 257 },
  },
});

const state = (over: Partial<ParamState> = {}): ParamState => ({ seed: 42, edits: {}, ...over });

describe("fieldsFor", () => {
  it("gives an image model seed, steps, and an aspect picker", () => {
    const fields = fieldsFor(klein, state({ seed: 184203771 }));
    expect(fields.map((f) => f.kind)).toEqual(["seed", "number", "aspect"]);

    const [seed, steps, aspect] = fields;
    expect(seed).toMatchObject({ kind: "seed", value: 184203771 });
    expect(steps).toMatchObject({ kind: "number", label: "steps", value: 4, min: 1, max: 8 });
    // A square default selects the 1:1 preset.
    expect(aspect).toMatchObject({ kind: "aspect", selected: "1:1" });
  });

  it("swaps the aspect picker for a frame count on a video model", () => {
    const fields = fieldsFor(ltx, state());
    expect(fields.map((f) => f.kind)).toEqual(["seed", "number", "number"]);
    expect(fields[2]).toMatchObject({
      kind: "number",
      label: "frames",
      value: 97,
      min: 9,
      max: 257,
    });
    // No aspect chip for video.
    expect(fields.some((f) => f.kind === "aspect")).toBe(false);
  });

  it("shows only the chips the manifest declares", () => {
    // A bare manifest (prompt only) yields no chips — nothing invented.
    expect(fieldsFor(manifest(), state())).toEqual([]);
  });

  it("reflects an edited value and its selected aspect", () => {
    const fields = fieldsFor(klein, state({ edits: { steps: 6, width: 1024, height: 576 } }));
    expect(fields[1]).toMatchObject({ value: 6 });
    expect(fields[2]).toMatchObject({ kind: "aspect", selected: "16:9" });
  });
});

describe("aspectOptionsFor", () => {
  it("resolves presets to concrete sizes on the model's grid", () => {
    const byLabel = Object.fromEntries(aspectOptionsFor(klein).map((o) => [o.label, o]));
    expect(byLabel["1:1"]).toMatchObject({ width: 1024, height: 1024 });
    expect(byLabel["16:9"]).toMatchObject({ width: 1024, height: 576 });
    expect(byLabel["9:16"]).toMatchObject({ width: 576, height: 1024 });
    expect(byLabel["3:2"]).toMatchObject({ width: 1024, height: 704 });
    // Every side lands on the /64 grid the engine wants.
    for (const o of Object.values(byLabel)) {
      expect(o.width % 64).toBe(0);
      expect(o.height % 64).toBe(0);
    }
  });

  it("is empty for a model that declares no size", () => {
    expect(aspectOptionsFor(manifest())).toEqual([]);
  });
});

describe("resolveNumber / clampToParam", () => {
  it("prefers an edit over the default", () => {
    expect(resolveNumber(klein, state({ edits: { steps: 7 } }), "steps")).toBe(7);
    expect(resolveNumber(klein, state(), "steps")).toBe(4);
  });

  it("clamps to the manifest bounds", () => {
    expect(resolveNumber(klein, state({ edits: { steps: 99 } }), "steps")).toBe(8);
    expect(resolveNumber(klein, state({ edits: { steps: 0 } }), "steps")).toBe(1);
    expect(clampToParam(klein, "steps", 99)).toBe(8);
    expect(clampToParam(klein, "steps", -5)).toBe(1);
  });
});

describe("resolveValues → buildWorkflow", () => {
  // A minimal workflow with the nodes klein/ltx point at. Only the fields the
  // params patch need to exist; buildWorkflow throws otherwise.
  const kleinWorkflow = {
    "6": { class_type: "CLIPTextEncode", inputs: { text: "" } },
    "22": { class_type: "RandomNoise", inputs: { noise_seed: 0 } },
    "20": { class_type: "BasicScheduler", inputs: { steps: 0 } },
    "5": { class_type: "EmptyLatentImage", inputs: { width: 0, height: 0 } },
  };

  it("feeds a klein image's prompt, seed, steps, and size into the workflow", () => {
    const values = resolveValues(
      klein,
      state({ seed: 184203771, edits: { steps: 6, width: 1024, height: 576 } }),
      "a cat",
    );
    expect(values).toEqual({
      prompt: "a cat",
      seed: 184203771,
      steps: 6,
      width: 1024,
      height: 576,
    });

    const wf = buildWorkflow(klein, kleinWorkflow, values);
    expect(wf["6"].inputs.text).toBe("a cat");
    expect(wf["22"].inputs.noise_seed).toBe(184203771);
    expect(wf["20"].inputs.steps).toBe(6);
    expect(wf["5"].inputs).toMatchObject({ width: 1024, height: 576 });
  });

  it("carries a video model's frame count", () => {
    const values = resolveValues(ltx, state({ edits: { length: 121 } }), "a wave");
    expect(values).toMatchObject({ length: 121, width: 768, height: 512 });
  });

  it("throws through buildWorkflow when the manifest is stale against its workflow", () => {
    // The workflow is missing node "22" (seed) that the manifest still targets.
    const stale = { "6": { class_type: "CLIPTextEncode", inputs: { text: "" } } };
    expect(() => buildWorkflow(klein, stale, resolveValues(klein, state(), "hi"))).toThrow(
      /node "22"/,
    );
  });
});
