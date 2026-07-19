import { describe, expect, it } from "vitest";
import { availableModels, parseRegistry, selectAvailable, workflowFor } from "./registry";
import type { Manifest } from "./registry.schema";

/** A minimal manifest the schema accepts, spread-overridable per case. */
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

/** Shapes an object the way `import.meta.glob(..., { eager: true })` does. */
function modules(entries: Record<string, unknown>): Record<string, { default: unknown }> {
  return Object.fromEntries(Object.entries(entries).map(([k, v]) => [k, { default: v }]));
}

describe("parseRegistry", () => {
  it("validates every manifest against the shared schema", () => {
    const parsed = parseRegistry(
      modules({
        "../../registry/flux2-klein/manifest.json": manifest({ id: "flux2-klein" }),
        "../../registry/_staged/wan22/manifest.json": manifest({
          id: "wan22",
          kind: "video",
          enabled: false,
        }),
      }),
    );
    expect(parsed.map((e) => e.manifest.id)).toEqual(["wan22", "flux2-klein"]); // sorted by path
  });

  it("returns manifests in a stable, path-sorted order", () => {
    const parsed = parseRegistry(
      modules({
        "../../registry/zebra/manifest.json": manifest({ id: "zebra" }),
        "../../registry/alpha/manifest.json": manifest({ id: "alpha" }),
      }),
    );
    expect(parsed.map((e) => e.manifest.id)).toEqual(["alpha", "zebra"]);
  });

  it("throws, naming the file, when a bundled manifest breaks the schema", () => {
    const bad = { ...manifest(), tested_on: [] }; // schema requires at least one
    expect(() => parseRegistry(modules({ "../../registry/broken/manifest.json": bad }))).toThrow(
      /registry\/broken\/manifest\.json/,
    );
  });

  it("rejects a file url from a non-allowlisted host", () => {
    const bad = manifest({
      files: [
        {
          url: "https://evil.example.com/model.safetensors",
          dest: "models/checkpoints/model.safetensors",
          sha256: "a".repeat(64),
          size: 123,
        },
      ],
    });
    expect(() => parseRegistry(modules({ "../../registry/sketchy/manifest.json": bad }))).toThrow(
      /sketchy/,
    );
  });

  it("is empty for an empty bundle", () => {
    expect(parseRegistry(modules({}))).toEqual([]);
  });
});

describe("selectAvailable", () => {
  it("offers enabled, non-staged models", () => {
    const available = selectAvailable(
      parseRegistry(
        modules({
          "../../registry/flux2-klein/manifest.json": manifest({ id: "flux2-klein" }),
          "../../registry/_staged/wan22/manifest.json": manifest({
            id: "wan22",
            enabled: false,
          }),
        }),
      ),
    );
    expect(available.map((m) => m.id)).toEqual(["flux2-klein"]);
  });

  it("holds back a staged model even if it reads enabled", () => {
    // The path is the structural truth: promoting a staged model is an ADR-006
    // amendment, not a flipped boolean, so a mislabelled _staged/ manifest must
    // never reach the picker.
    const available = selectAvailable(
      parseRegistry(
        modules({
          "../../registry/_staged/wan22/manifest.json": manifest({ id: "wan22", enabled: true }),
        }),
      ),
    );
    expect(available).toEqual([]);
  });

  it("excludes a disabled shipped model", () => {
    const available = selectAvailable(
      parseRegistry(
        modules({
          "../../registry/flux2-klein/manifest.json": manifest({
            id: "flux2-klein",
            enabled: false,
          }),
        }),
      ),
    );
    expect(available).toEqual([]);
  });
});

// Unlike the pure functions above, workflowFor reads the *real* bundle globs, so
// these run against the shipped registry — the same join `buildWorkflow` relies
// on, proving a manifest and its sibling workflow.json actually meet.
describe("workflowFor", () => {
  it("loads a shipped model's sibling workflow, with every param node present", () => {
    const [model] = availableModels();
    const workflow = workflowFor(model);

    // A real API-format graph: node ids mapping to { class_type, inputs }.
    expect(Object.keys(workflow).length).toBeGreaterThan(0);
    // The ADR-005 join: each param targets a node the loaded workflow has.
    for (const spec of Object.values(model.params)) {
      expect(workflow[spec.node]).toBeDefined();
    }
    expect(workflow[model.output_node]).toBeDefined();
  });

  it("throws for a manifest the bundle has no entry for", () => {
    expect(() => workflowFor(manifest({ id: "not-a-real-model" }))).toThrow(/no registry entry/);
  });
});
