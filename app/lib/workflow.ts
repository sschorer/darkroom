/**
 * `buildWorkflow()` — the submit-time half of ADR-005's "a model is data" idea
 * (#16). A `workflow.json` is ComfyUI's own API-format export, shipped
 * *unmodified*; a manifest's `params` map names, per UI field, the node and
 * input that field drives. This function is where the two meet: it takes the
 * untouched export plus the user's values and produces the concrete graph to
 * POST at `/prompt`.
 *
 * Two invariants carry the design, both straight from ADR-005:
 *
 *   1. **Never mutate the caller's workflow.** The export is loaded once and
 *      reused for every generation; patching it in place would let one run's
 *      seed leak into the next. So we deep-clone before touching anything.
 *
 *   2. **Throw on a node ID that isn't in the workflow.** A manifest can drift
 *      out of sync with its workflow — a node renumbered on re-export, a param
 *      pointing at a node that no longer exists. Silently skipping the patch
 *      lets a stale manifest generate garbage (ADR-005's named failure mode):
 *      the prompt goes unset, the seed stays frozen, and nothing says why. The
 *      cross-check in `registry.schema.ts` catches this at CI time; this throw
 *      is the runtime backstop for the same fault, so a manifest that slips
 *      through fails loudly at submit rather than quietly at the pixels.
 */
import type { Workflow } from "./comfy";
import type { Manifest } from "./registry.schema";

/**
 * User-supplied values keyed by param name — the same keys as `manifest.params`
 * (`prompt`, `seed`, `steps`, …). A partial map is fine: a param absent here
 * falls back to its manifest `default`, and a param with neither a value nor a
 * default is left as the export already has it.
 */
export type ParamValues = Record<string, unknown>;

/**
 * Deep-clones `workflow` and patches each manifest param into it, returning the
 * graph ready for `/prompt`. The input `workflow` is never mutated.
 *
 * For every entry in `manifest.params`, the value patched in is `values[name]`
 * when supplied, otherwise the param's `default`. When a param has neither, it
 * is skipped — the export keeps whatever the model's author baked in. Any param
 * that *does* resolve to a value must have its node present in the workflow;
 * a missing node throws rather than being ignored (see the module docs).
 */
export function buildWorkflow(
  manifest: Manifest,
  workflow: Workflow,
  values: ParamValues,
): Workflow {
  const patched = structuredClone(workflow);

  for (const [name, spec] of Object.entries(manifest.params)) {
    const value = name in values ? values[name] : spec.default;
    if (value === undefined) {
      continue; // nothing to set — leave the author's baked-in value alone.
    }

    const node = patched[spec.node];
    if (!node) {
      throw new Error(
        `manifest param "${name}" targets node "${spec.node}", which is not in the ` +
          `workflow — the manifest is stale against its workflow.json (ADR-005).`,
      );
    }

    node.inputs[spec.field] = value;
  }

  return patched;
}
