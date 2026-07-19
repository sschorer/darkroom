import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { Manifest, Workflow, crossCheck } from "../app/lib/registry.schema";

/** This suite lives in the directory it validates (ADR-012). Non-directory
 *  entries here — this file, README.md — are skipped by modelDirs(). */
const ROOT = __dirname;

/** Every model dir, shipped and staged. Staged models are tested too —
 *  otherwise `enabled: true` is a leap of faith rather than a one-line diff. */
function modelDirs(): { id: string; dir: string; staged: boolean }[] {
  const out: { id: string; dir: string; staged: boolean }[] = [];
  for (const entry of readdirSync(ROOT)) {
    if (entry === "_staged") {
      for (const s of readdirSync(join(ROOT, "_staged"))) {
        out.push({ id: `_staged/${s}`, dir: join(ROOT, "_staged", s), staged: true });
      }
      continue;
    }
    if (statSync(join(ROOT, entry)).isDirectory()) {
      out.push({ id: entry, dir: join(ROOT, entry), staged: false });
    }
  }
  return out;
}

const models = modelDirs();

describe("registry", () => {
  it("is not empty", () => {
    expect(models.length).toBeGreaterThan(0);
  });

  it("ships exactly one enabled image model and one enabled video model", () => {
    // ADR-006. If this fails, someone enabled a staged model without
    // reading the decision — which is the point of the test.
    const enabled = models
      .filter((m) => !m.staged)
      .map((m) => Manifest.parse(JSON.parse(readFileSync(join(m.dir, "manifest.json"), "utf8"))))
      .filter((m) => m.enabled);

    expect(enabled.filter((m) => m.kind === "image")).toHaveLength(1);
    expect(enabled.filter((m) => m.kind === "video")).toHaveLength(1);
  });

  it("keeps staged models disabled", () => {
    for (const m of models.filter((m) => m.staged)) {
      const manifest = Manifest.parse(
        JSON.parse(readFileSync(join(m.dir, "manifest.json"), "utf8")),
      );
      expect(manifest.enabled, `${m.id} is staged but enabled`).toBe(false);
    }
  });

  it("has no duplicate ids", () => {
    const ids = models.map(
      (m) => Manifest.parse(JSON.parse(readFileSync(join(m.dir, "manifest.json"), "utf8"))).id,
    );
    expect(new Set(ids).size).toBe(ids.length);
  });
});

/**
 * The unit half of the suite. The per-model block above runs crossCheck against
 * real manifests, but it can only ever assert the *absence* of issues — and
 * until #14/#15 land there are no manifests for it to run against at all. That
 * leaves crossCheck's whole reason for existing (catching a manifest and a
 * workflow that are each valid alone but broken together — ADR-005) untested.
 *
 * These fixtures are the Done criterion for this issue: a deliberately broken
 * manifest is caught, here, in milliseconds, with no GPU and no real weights.
 * Each case mutates one thing away from a known-good pair so the assertion
 * pins the specific failure crossCheck is meant to name, not just "something
 * went wrong".
 */
describe("crossCheck", () => {
  /** A minimal manifest crossCheck accepts. Only `params` and `output_node`
   *  are read by crossCheck; the rest is present so the value type-checks as a
   *  real Manifest rather than a cast, keeping the fixtures honest. */
  function manifest(over: Partial<Manifest> = {}): Manifest {
    return {
      id: "fixture",
      name: "Fixture",
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

  /** An API-format workflow the good manifest resolves cleanly against. */
  function workflow(over: Workflow = {}): Workflow {
    return {
      "6": { class_type: "CLIPTextEncode", inputs: { text: "" } },
      "9": { class_type: "SaveImage", inputs: { images: [] } },
      ...over,
    };
  }

  it("passes a manifest whose params and output all resolve", () => {
    expect(crossCheck(manifest(), workflow())).toEqual([]);
  });

  it("flags a param pointing at a node the workflow does not contain", () => {
    const issues = crossCheck(
      manifest({ params: { prompt: { node: "404", field: "text" } } }),
      workflow(),
    );
    expect(issues).toEqual([{ path: "params.prompt.node", message: 'node "404" not in workflow' }]);
  });

  it("flags a param pointing at a field the node does not have", () => {
    const issues = crossCheck(
      manifest({ params: { prompt: { node: "6", field: "nope" } } }),
      workflow(),
    );
    expect(issues).toEqual([
      { path: "params.prompt.field", message: 'node "6" (CLIPTextEncode) has no input "nope"' },
    ]);
  });

  it("flags an output_node absent from the workflow", () => {
    const issues = crossCheck(manifest({ output_node: "99" }), workflow());
    expect(issues).toEqual([{ path: "output_node", message: 'node "99" not in workflow' }]);
  });

  it("flags a manifest with no prompt param — a UI with no prompt box", () => {
    const issues = crossCheck(
      manifest({ params: { seed: { node: "6", field: "text" } } }),
      workflow(),
    );
    expect(issues).toEqual([{ path: "params", message: 'must define a "prompt" param' }]);
  });

  it("flags a UI export (carries `nodes`/`links`) rather than API format", () => {
    // The standard ComfyUI export; /prompt rejects it. Its top-level shape is
    // nothing like the API format — `nodes`/`links` are arrays of layout, not a
    // node map — so it is not a valid Workflow, hence the boundary cast. That is
    // exactly the file crossCheck's presence check exists to catch when one
    // slips past the schema. (A recorded export would be truer still, but needs
    // a running ComfyUI, which CI has no way to provide — ADR-010.)
    const uiExport = {
      last_node_id: 10,
      last_link_id: 9,
      nodes: [{ id: 6, type: "CLIPTextEncode" }],
      links: [[1, 6, 0, 9, 0, "CONDITIONING"]],
      version: 0.4,
    } as unknown as Workflow;
    const issues = crossCheck(manifest(), uiExport);
    expect(issues).toContainEqual({
      path: "workflow",
      message: "looks like a UI export — re-export with Save (API Format)",
    });
  });

  it("reports every problem at once, not just the first", () => {
    // A contributor fixing a broken manifest should see the whole list in one
    // run, not peel them off one CI failure at a time.
    const issues = crossCheck(
      manifest({ params: { prompt: { node: "404", field: "text" } }, output_node: "99" }),
      workflow(),
    );
    expect(issues.map((i) => i.path)).toEqual(["params.prompt.node", "output_node"]);
  });
});

describe.each(models)("registry/$id", ({ id, dir }) => {
  const raw = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));

  it("manifest matches the schema", () => {
    const r = Manifest.safeParse(raw);
    if (!r.success) throw new Error(JSON.stringify(r.error.format(), null, 2));
  });

  const manifest = Manifest.parse(raw);

  it("directory name matches manifest id", () => {
    // The staged dir keeps its own name; compare the leaf.
    expect(id.split("/").pop()).toBe(manifest.id);
  });

  it("workflow file exists and is API format", () => {
    const p = join(dir, manifest.workflow);
    expect(existsSync(p), `${p} missing`).toBe(true);
    const r = Workflow.safeParse(JSON.parse(readFileSync(p, "utf8")));
    if (!r.success) throw new Error(JSON.stringify(r.error.format(), null, 2));
  });

  it("manifest params resolve against the workflow", () => {
    const wf = Workflow.parse(JSON.parse(readFileSync(join(dir, manifest.workflow), "utf8")));
    const issues = crossCheck(manifest, wf);
    expect(issues.map((i) => `${i.path}: ${i.message}`)).toEqual([]);
  });

  it("declares disk that covers its files", () => {
    const bytes = manifest.files.reduce((a, f) => a + f.size, 0);
    const gb = bytes / 1024 ** 3;
    expect(
      manifest.requires.disk_gb,
      `declares ${manifest.requires.disk_gb}GB, files are ${gb.toFixed(1)}GB`,
    ).toBeGreaterThanOrEqual(gb);
  });

  it("has no duplicate destinations", () => {
    const dests = manifest.files.map((f) => f.dest);
    expect(new Set(dests).size).toBe(dests.length);
  });

  it("was tested on hardware meeting its own stated requirement", () => {
    // CI has no GPU. This attestation is the only evidence the model runs
    // at all, so at minimum it has to be self-consistent.
    for (const t of manifest.tested_on) {
      expect(
        t.vram_gb,
        `${t.gpu} has ${t.vram_gb}GB, manifest requires ${manifest.requires.vram_gb}GB`,
      ).toBeGreaterThanOrEqual(manifest.requires.vram_gb);
    }
  });
});
