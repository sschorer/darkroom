/**
 * Loads the bundled model registry into the app, through the *same* schema the
 * CI gate validates against ({@link Manifest} in `registry.schema.ts`). This is
 * the "app and tests share one definition" half of ADR-005: the registry test
 * (`registry/registry.test.ts`) parses manifests off disk with this schema, and
 * the running app parses them out of the bundle with it too — one contract, so
 * a manifest CI accepts is a manifest the app can read, and neither can drift
 * from the other.
 *
 * VRAM gating and workflow resolution are deliberately *not* here yet — gating
 * is #20 (it needs real `/system_stats`, ADR-004/Q5), and locating each model's
 * `workflow.json` is `buildWorkflow`'s job (#16). This module does the one thing
 * #12 asks for: turn the bundled manifests into validated {@link Manifest}
 * values the rest of the app can build on.
 */
import { Manifest } from "./registry.schema";

/**
 * Every `manifest.json` under `registry/`, inlined into the bundle at build
 * time. `eager` so this is a plain map rather than a set of import thunks — the
 * registry is small, ships inside the app (so the minisign signature already
 * covers it, §8.4), and every consumer wants all of it. The glob matches both
 * shipped models and `_staged/` ones; staging is a `manifest.enabled` flag, not
 * a separate load path, so staged models are parsed here and filtered out by
 * {@link availableModels} rather than being invisible.
 */
const manifestModules = import.meta.glob<{ default: unknown }>("../../registry/**/manifest.json", {
  eager: true,
});

/**
 * Parses a set of bundled manifest modules through the schema, in a stable
 * order. Split from {@link loadRegistry} so it can be exercised without the
 * bundle — the real registry has no fixtures to lean on until #14/#15 land the
 * first manifests, and "does the app agree with the schema" is worth a test
 * before then.
 *
 * A parse failure throws, naming the offending file. In a released build this
 * cannot happen: the registry is bundled, signed, and gated by
 * `pnpm test:registry` (ADR-010), so an invalid manifest here means that gate
 * was bypassed — a developer error we want loud, not a silent empty picker.
 */
export function parseRegistry(modules: Record<string, { default: unknown }>): Manifest[] {
  const out: Manifest[] = [];
  for (const path of Object.keys(modules).sort()) {
    const result = Manifest.safeParse(modules[path].default);
    if (!result.success) {
      throw new Error(
        `registry manifest ${path} does not match the schema — this should have been ` +
          `caught by \`pnpm test:registry\` before it shipped:\n` +
          JSON.stringify(result.error.format(), null, 2),
      );
    }
    out.push(result.data);
  }
  return out;
}

/** Every model in the bundle, shipped and staged, validated against the schema. */
export function loadRegistry(): Manifest[] {
  return parseRegistry(manifestModules);
}

/**
 * The models the app offers — enabled ones only. Staged models (`enabled:
 * false`, ADR-006) are built and tested but not a choice we've made a default,
 * so they never reach the picker; promoting one is an ADR-006 amendment, not a
 * runtime toggle.
 */
export function availableModels(): Manifest[] {
  return loadRegistry().filter((m) => m.enabled);
}
