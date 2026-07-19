/**
 * Loads the bundled model registry into the app, through the *same* schema the
 * CI gate validates against ({@link Manifest} in `registry.schema.ts`). This is
 * the "app and tests share one definition" half of ADR-005: the registry test
 * (`registry/registry.test.ts`) parses manifests off disk with this schema, and
 * the running app parses them out of the bundle with it too — one contract, so
 * a manifest CI accepts is a manifest the app can read, and neither can drift
 * from the other.
 *
 * VRAM gating is deliberately *not* here — it lives in `gate.ts` (#20), which
 * compares this registry's models against the engine's real `/system_stats`
 * VRAM (§8.5, Q5). Locating and patching a model's workflow *is* split: this
 * module loads the untouched `workflow.json` off the bundle ({@link
 * workflowFor}), and `buildWorkflow` (#16) patches the user's params into it.
 * This module does the one thing #12 asks for: turn the bundled manifests — and
 * their sibling workflows — into validated values the rest of the app builds on.
 */
import { Manifest, Workflow } from "./registry.schema";

/**
 * Every `manifest.json` under `registry/`, inlined into the bundle at build
 * time. `eager` so this is a plain map rather than a set of import thunks — the
 * registry is small, ships inside the app (so the minisign signature already
 * covers it, §8.4), and every consumer wants all of it. The glob matches both
 * shipped models and `_staged/` ones; the two are told apart by their bundle
 * path (`_staged/`), so both are parsed here and staged ones are held back by
 * {@link availableModels} rather than being invisible to {@link loadRegistry}.
 */
const manifestModules = import.meta.glob<{ default: unknown }>("../../registry/**/manifest.json", {
  eager: true,
});

/**
 * Every non-manifest `.json` under `registry/`, inlined alongside the manifests
 * so a model's `workflow.json` ships in the bundle (and under the same minisign
 * signature, §8.4) rather than being fetched at runtime. Keyed by bundle path,
 * the same keys {@link RegistryEntry.path} uses, so {@link workflowFor} can find
 * a manifest's sibling workflow by swapping the filename. `manifest.json` itself
 * is loaded through {@link manifestModules} above; matching only the workflow by
 * its manifest-declared filename keeps the two from crossing.
 */
const workflowModules = import.meta.glob<{ default: unknown }>(
  ["../../registry/**/*.json", "!../../registry/**/manifest.json"],
  { eager: true },
);

/** A parsed manifest and the bundle path it came from. The path is the
 *  structural staging signal (`_staged/`) — kept alongside the manifest so the
 *  picker can exclude staged models independently of their `enabled` flag. */
export interface RegistryEntry {
  path: string;
  manifest: Manifest;
}

/** True for a manifest that lives under a `_staged/` directory in the bundle. */
function isStaged(path: string): boolean {
  return path.split("/").includes("_staged");
}

/**
 * Parses a set of bundled manifest modules through the schema, in a stable
 * order, keeping each module's path. Split from {@link loadRegistry} so it can
 * be exercised without the bundle — the real registry has no fixtures to lean
 * on until #14/#15 land the first manifests, and "does the app agree with the
 * schema" is worth a test before then.
 *
 * A parse failure throws, naming the offending file. In a released build this
 * cannot happen: the registry is bundled, signed, and gated by
 * `pnpm test:registry` (ADR-010), so an invalid manifest here means that gate
 * was bypassed — a developer error we want loud, not a silent empty picker.
 */
export function parseRegistry(modules: Record<string, { default: unknown }>): RegistryEntry[] {
  const out: RegistryEntry[] = [];
  for (const path of Object.keys(modules).sort()) {
    const result = Manifest.safeParse(modules[path].default);
    if (!result.success) {
      throw new Error(
        `registry manifest ${path} does not match the schema — this should have been ` +
          `caught by \`pnpm test:registry\` before it shipped:\n` +
          JSON.stringify(result.error.format(), null, 2),
      );
    }
    out.push({ path, manifest: result.data });
  }
  return out;
}

/**
 * The models the picker may offer, from a set of parsed entries. Pure, so the
 * staging exclusion is testable without the bundle.
 *
 * A model is offered only if it is `enabled` *and* not under `_staged/`. The two
 * conditions agree in a healthy tree (`registry.test.ts` enforces staged ⟹
 * disabled), but the path is the structural truth: promoting a staged model is a
 * deliberate ADR-006 amendment, not a flipped boolean, so a staged manifest that
 * somehow reads `enabled: true` must still stay out of the picker.
 */
export function selectAvailable(entries: RegistryEntry[]): Manifest[] {
  return entries.filter((e) => e.manifest.enabled && !isStaged(e.path)).map((e) => e.manifest);
}

/** Every model in the bundle, shipped and staged, validated against the schema. */
export function loadRegistry(): Manifest[] {
  return parseRegistry(manifestModules).map((e) => e.manifest);
}

/**
 * The models the app offers — enabled, non-staged ones. Staged models (ADR-006)
 * are built and tested but not a default we've chosen, so they never reach the
 * picker.
 */
export function availableModels(): Manifest[] {
  return selectAvailable(parseRegistry(manifestModules));
}

/**
 * The untouched API-format workflow for a model, validated against the same
 * {@link Workflow} schema CI cross-checks the manifest against. `buildWorkflow`
 * clones and patches this per generation (#16, #27); it is never mutated here.
 *
 * The lookup joins on the *bundle directory*, not the manifest `id`: manifest
 * and workflow are siblings (`registry/<model>/manifest.json` +
 * `<model>/<manifest.workflow>`), so the manifest's own path plus its declared
 * `workflow` filename names the file. Two failure modes throw loudly rather than
 * generating garbage (ADR-005): a manifest whose id we can't find an entry for,
 * and a `workflow` filename absent from the bundle. In a released build neither
 * can happen — the registry is bundled and gated by `pnpm test:registry` — so a
 * throw here is a developer error we want surfaced, not swallowed into an empty
 * generation.
 */
export function workflowFor(manifest: Manifest): Workflow {
  const entry = parseRegistry(manifestModules).find((e) => e.manifest.id === manifest.id);
  if (!entry) {
    throw new Error(`no registry entry found for model "${manifest.id}".`);
  }
  const dir = entry.path.slice(0, entry.path.lastIndexOf("/"));
  const workflowPath = `${dir}/${manifest.workflow}`;
  const module = workflowModules[workflowPath];
  if (!module) {
    throw new Error(
      `workflow "${manifest.workflow}" for model "${manifest.id}" is not in the bundle ` +
        `(expected it at ${workflowPath}).`,
    );
  }
  const result = Workflow.safeParse(module.default);
  if (!result.success) {
    throw new Error(
      `workflow ${workflowPath} does not match the schema — this should have been caught ` +
        `by \`pnpm test:registry\` before it shipped:\n` +
        JSON.stringify(result.error.format(), null, 2),
    );
  }
  return result.data;
}
