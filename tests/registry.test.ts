import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { Manifest, Workflow, crossCheck } from "../src/lib/registry.schema";

const ROOT = join(__dirname, "..", "registry");

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
      const manifest = Manifest.parse(JSON.parse(readFileSync(join(m.dir, "manifest.json"), "utf8")));
      expect(manifest.enabled, `${m.id} is staged but enabled`).toBe(false);
    }
  });

  it("has no duplicate ids", () => {
    const ids = models.map((m) =>
      Manifest.parse(JSON.parse(readFileSync(join(m.dir, "manifest.json"), "utf8"))).id,
    );
    expect(new Set(ids).size).toBe(ids.length);
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
    expect(manifest.requires.disk_gb, `declares ${manifest.requires.disk_gb}GB, files are ${gb.toFixed(1)}GB`)
      .toBeGreaterThanOrEqual(gb);
  });

  it("has no duplicate destinations", () => {
    const dests = manifest.files.map((f) => f.dest);
    expect(new Set(dests).size).toBe(dests.length);
  });

  it("was tested on hardware meeting its own stated requirement", () => {
    // CI has no GPU. This attestation is the only evidence the model runs
    // at all, so at minimum it has to be self-consistent.
    for (const t of manifest.tested_on) {
      expect(t.vram_gb, `${t.gpu} has ${t.vram_gb}GB, manifest requires ${manifest.requires.vram_gb}GB`)
        .toBeGreaterThanOrEqual(manifest.requires.vram_gb);
    }
  });
});
