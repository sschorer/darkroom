import { z } from "zod";

/**
 * The manifest schema is the app's runtime contract AND the CI gate.
 * One definition, both jobs — otherwise they drift and the test starts
 * validating something the app doesn't actually enforce.
 */

const SHA256 = /^[a-f0-9]{64}$/;

/** Weights only come from hosts we've decided to trust. A manifest is a
 *  download instruction; an open `url` field is an arbitrary-fetch primitive
 *  in a file that looks like harmless config. */
const ALLOWED_HOSTS = ["huggingface.co", "cdn-lfs.huggingface.co", "cdn-lfs-us-1.hf.co"];

export const FileSpec = z.object({
  url: z
    .string()
    .url()
    .refine((u) => new URL(u).protocol === "https:", "must be https")
    .refine((u) => ALLOWED_HOSTS.includes(new URL(u).hostname), {
      message: `host must be one of: ${ALLOWED_HOSTS.join(", ")}`,
    }),
  /** Relative, and must stay under models/. Guards against a manifest writing
   *  into engine/ or, on a bad day, anywhere at all. */
  dest: z
    .string()
    .refine((p) => !p.startsWith("/") && !/^[a-zA-Z]:/.test(p), "must be relative")
    .refine((p) => !p.split(/[\\/]/).includes(".."), "must not traverse upward")
    .refine((p) => p.startsWith("models/"), "must live under models/"),
  sha256: z.string().regex(SHA256, "must be a lowercase hex sha256"),
  size: z.number().int().positive(),
});

export const ParamSpec = z.object({
  node: z.string().min(1),
  field: z.string().min(1),
  default: z.unknown().optional(),
  min: z.number().optional(),
  max: z.number().optional(),
});

export const Manifest = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/, "lowercase, digits and hyphens only"),
  /** The human name shown in the UI — the compose-bar model pill (#25) and the
   *  Settings model manager (#30). Distinct from `id`: `id` is the stable
   *  slug (filenames, workflow lookup), `name` is what a person reads
   *  ("FLUX.2 klein"), and one is not derivable from the other. */
  name: z.string().min(1),
  kind: z.enum(["image", "video"]),
  enabled: z.boolean(),
  /** Free text, but it must be present. A model without a stated license is
   *  a liability we hand to the user. */
  license: z.string().min(1),
  requires: z.object({
    vram_gb: z.number().positive(),
    disk_gb: z.number().positive(),
  }),
  files: z.array(FileSpec).min(1),
  workflow: z.string().endsWith(".json"),
  params: z.record(z.string(), ParamSpec),
  output_node: z.string().min(1),
  /** Filled in by whoever packaged the model. See CONTRIBUTING.md — CI has
   *  no GPU, so this attestation is the only evidence the model runs. */
  tested_on: z
    .array(
      z.object({
        gpu: z.string().min(1),
        vram_gb: z.number().positive(),
        seconds: z.number().positive(),
        comfy_sha: z.string().min(7),
      }),
    )
    .min(1),
});

export type Manifest = z.infer<typeof Manifest>;

/** ComfyUI API-format export: a flat map of nodeId -> { inputs, class_type }. */
export const Workflow = z.record(
  z.string(),
  z.object({
    inputs: z.record(z.string(), z.unknown()),
    class_type: z.string(),
    _meta: z.unknown().optional(),
  }),
);

export type Workflow = z.infer<typeof Workflow>;

export type CrossCheckIssue = { path: string; message: string };

/**
 * The check that actually matters. A manifest and a workflow can each be
 * individually valid and still be broken together — this is the failure
 * ADR-005 warns about, and the only place it can be caught cheaply.
 */
export function crossCheck(m: Manifest, wf: Workflow): CrossCheckIssue[] {
  const issues: CrossCheckIssue[] = [];

  for (const [key, spec] of Object.entries(m.params)) {
    const node = wf[spec.node];
    if (!node) {
      issues.push({ path: `params.${key}.node`, message: `node "${spec.node}" not in workflow` });
      continue;
    }
    if (!(spec.field in node.inputs)) {
      issues.push({
        path: `params.${key}.field`,
        message: `node "${spec.node}" (${node.class_type}) has no input "${spec.field}"`,
      });
    }
  }

  if (!wf[m.output_node]) {
    issues.push({ path: "output_node", message: `node "${m.output_node}" not in workflow` });
  }

  // A UI with no prompt box is not a model we can ship.
  if (!("prompt" in m.params)) {
    issues.push({ path: "params", message: `must define a "prompt" param` });
  }

  // The standard ComfyUI export carries UI layout; /prompt rejects it.
  // Catching it here saves a contributor an afternoon.
  if ("nodes" in wf || "links" in wf) {
    issues.push({
      path: "workflow",
      message: "looks like a UI export — re-export with Save (API Format)",
    });
  }

  return issues;
}
