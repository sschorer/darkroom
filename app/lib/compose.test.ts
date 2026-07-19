import { describe, expect, it, vi } from "vitest";

import { chipsFor } from "./compose";
import type { Manifest } from "./registry.schema";

/** A manifest with just enough of a params map for the chip logic to read. The
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

const noop = () => {};

describe("chipsFor", () => {
  it("gives an image model seed, steps, and an aspect ratio", () => {
    const chips = chipsFor(
      manifest({
        kind: "image",
        params: {
          prompt: { node: "6", field: "text" },
          seed: { node: "22", field: "noise_seed", default: 42 },
          steps: { node: "20", field: "steps", default: 4 },
          width: { node: "5", field: "width", default: 1024 },
          height: { node: "5", field: "height", default: 1024 },
        },
      }),
      184203771,
      noop,
    );

    expect(chips.map((c) => c.label)).toEqual(["seed", "steps", "1:1"]);
    // The seed carries the live value and its shuffle action; steps its default.
    expect(chips[0]).toMatchObject({ value: "184203771" });
    expect(chips[0].action?.glyph).toBe("⇄");
    expect(chips[1]).toMatchObject({ value: "4" });
  });

  it("reduces a non-square size to its simplest ratio", () => {
    const chips = chipsFor(
      manifest({
        params: {
          prompt: { node: "6", field: "text" },
          width: { node: "5", field: "width", default: 1280 },
          height: { node: "5", field: "height", default: 720 },
        },
      }),
      1,
      noop,
    );
    expect(chips.map((c) => c.label)).toContain("16:9");
  });

  it("swaps the aspect chip for a frame count on a video model", () => {
    const chips = chipsFor(
      manifest({
        kind: "video",
        params: {
          prompt: { node: "6", field: "text" },
          seed: { node: "71", field: "noise_seed", default: 42 },
          steps: { node: "72", field: "steps", default: 30 },
          width: { node: "70", field: "width", default: 768 },
          height: { node: "70", field: "height", default: 512 },
          length: { node: "70", field: "length", default: 97 },
        },
      }),
      1,
      noop,
    );

    const labels = chips.map((c) => c.label);
    expect(labels).toEqual(["seed", "steps", "frames"]);
    // No aspect ratio for video — frames replace it.
    expect(labels).not.toContain("3:2");
    expect(chips[2]).toMatchObject({ value: "97" });
  });

  it("shuffles via the seed chip's action", () => {
    const onShuffle = vi.fn();
    const chips = chipsFor(
      manifest({
        params: { prompt: { node: "6", field: "text" }, seed: { node: "22", field: "s" } },
      }),
      1,
      onShuffle,
    );
    chips[0].action?.onClick();
    expect(onShuffle).toHaveBeenCalledOnce();
  });

  it("shows only the chips the manifest declares", () => {
    // A bare manifest (prompt only) yields no chips — nothing invented.
    expect(chipsFor(manifest(), 1, noop)).toEqual([]);
  });
});
