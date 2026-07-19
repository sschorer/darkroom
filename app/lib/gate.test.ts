import { describe, expect, it } from "vitest";

import { gateModel, gateModels } from "./gate";
import type { Manifest } from "./registry.schema";

/** A minimal manifest the schema accepts, with an overridable VRAM requirement. */
function manifest(over: Partial<Manifest> = {}): Manifest {
  return {
    id: "flux2-klein",
    name: "FLUX.2 klein",
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

const GB = 1024 ** 3;

describe("gateModel", () => {
  it("disables a model that needs more VRAM than the GPU has, with a reason", () => {
    // The Q5 scenario: an 8GB card (reports a sliver under 8 GiB) meets a 13GB
    // model, and must be told, not left to OOM.
    const gated = gateModel(8_589_410_304, manifest({ requires: { vram_gb: 13, disk_gb: 14 } }));
    expect(gated.fits).toBe(false);
    expect(gated.reason).toBe("Needs 13 GB of VRAM; this GPU has 8 GB.");
  });

  it("offers a model the GPU comfortably fits", () => {
    const gated = gateModel(24 * GB, manifest({ requires: { vram_gb: 13, disk_gb: 14 } }));
    expect(gated).toEqual({ manifest: expect.any(Object), fits: true, reason: null });
  });

  it("does not gate a model off the very card it was tested on", () => {
    // A "24GB" RTX 4090 reports ~23.99 GiB, not a full 24 * 2^30 — the driver
    // and torch reserve a sliver. A strict byte comparison would gate a
    // vram_gb: 24 model off its own tested card; rounding to the nominal GiB is
    // what prevents that false negative.
    const reported = 25_757_220_864; // real /system_stats figure for a 4090
    const gated = gateModel(reported, manifest({ requires: { vram_gb: 24, disk_gb: 14 } }));
    expect(gated.fits).toBe(true);
    expect(gated.reason).toBeNull();
  });

  it("treats meeting the requirement exactly as fitting", () => {
    const gated = gateModel(12 * GB, manifest({ requires: { vram_gb: 12, disk_gb: 14 } }));
    expect(gated.fits).toBe(true);
  });

  it("passes every model when VRAM is unknown (no GPU reported)", () => {
    // null is "cannot gate", not "gate everything out": the unsupported-hardware
    // story is the accelerator warning's (TD-2), not a fabricated VRAM reason.
    const gated = gateModel(null, manifest({ requires: { vram_gb: 48, disk_gb: 14 } }));
    expect(gated.fits).toBe(true);
    expect(gated.reason).toBeNull();
  });
});

describe("gateModels", () => {
  it("gates a list against one total, preserving order", () => {
    const small = manifest({ id: "small", requires: { vram_gb: 8, disk_gb: 10 } });
    const large = manifest({ id: "large", requires: { vram_gb: 24, disk_gb: 30 } });
    const gated = gateModels(12 * GB, [small, large]);
    expect(gated.map((g) => [g.manifest.id, g.fits])).toEqual([
      ["small", true],
      ["large", false],
    ]);
  });
});
