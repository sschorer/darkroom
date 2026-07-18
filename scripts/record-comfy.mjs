#!/usr/bin/env node
// Record a real ComfyUI session into a mock-engine fixture (#22, ADR-010).
//
// The engine boundary can only ever be tested against a mock, and ADR-010's one
// rule for that mock is that its frames be *recorded*, not hand-written:
// ComfyUI has no API contract (RISK-1) and its WebSocket shapes are undocumented,
// so an invented frame encodes your assumption of its behaviour rather than the
// behaviour. This is the recorder. Point it at a running engine, hand it a
// workflow, and it captures the exact HTTP responses and WebSocket frames that
// one generation produces into `app/lib/__fixtures__/comfy/<scenario>.json`,
// which `comfy.mock.ts` replays.
//
// It needs no GPU-quality output — the *shapes* are what matter, and they're
// identical whether the sampler ran on a 4090 or a CPU in 20 minutes. A tiny
// workflow (few steps, small model) on any accelerator produces the same frames.
//
// ## Usage
//
//   node scripts/record-comfy.mjs \
//     --engine http://127.0.0.1:8188 \
//     --workflow path/to/workflow.api.json \
//     --scenario success
//
// The workflow must be an **API-format export** (Settings → dev mode → Save
// (API Format)); the normal export carries UI layout and /prompt rejects it
// (CLAUDE.md). To capture the `rejected` scenario, feed a workflow the engine
// will refuse (e.g. a model name it doesn't have); the 400 body is recorded and
// no run is awaited. For `error`, feed one that throws mid-run (e.g. a VRAM-
// busting resolution) and the execution_error frame is captured.
//
// ## What it stores
//
// Text frames are stored parsed (`{"message": {type, data}}`) rather than as raw
// strings: the client is whitespace-insensitive, so this preserves every key and
// value — the part that matters — while keeping the fixture diff-able. Binary
// preview frames are stored as their byte length only (`{"binary": N}`); the
// client's sole question of a binary frame is whether it's a string, so the bytes
// carry no test signal and a base64 JPEG would only bloat the fixture.
//
// Node stdlib only (global fetch + WebSocket, Node 18+), matching fetch-uv.mjs —
// no npm dependency, so it runs without an install step.

import { writeFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

const FIXTURE_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "app",
  "lib",
  "__fixtures__",
  "comfy",
);

/** The engine's completion signal: executing with a literal null node (main.py). */
const isCompletion = (m) => m.type === "executing" && m.data?.node === null;
/** A node threw in Python — a terminal frame too. */
const isError = (m) => m.type === "execution_error";

function parseArgs(argv) {
  const args = { engine: "http://127.0.0.1:8188", scenario: "success", timeoutMs: 600_000 };
  for (let i = 0; i < argv.length; i++) {
    const next = () => argv[++i];
    switch (argv[i]) {
      case "--engine":
        args.engine = next();
        break;
      case "--workflow":
        args.workflow = next();
        break;
      case "--scenario":
        args.scenario = next();
        break;
      case "--timeout":
        args.timeoutMs = Number(next()) * 1000;
        break;
      case "-h":
      case "--help":
        args.help = true;
        break;
      default:
        throw new Error(`unknown flag: ${argv[i]}`);
    }
  }
  return args;
}

const USAGE = `record-comfy — capture a ComfyUI session into a mock-engine fixture

  node scripts/record-comfy.mjs --workflow wf.api.json [options]

  --engine <url>      engine base URL (default http://127.0.0.1:8188)
  --workflow <path>   API-format workflow to submit (required)
  --scenario <name>   success | rejected | error (default success) — the fixture name
  --timeout <secs>    give up waiting for completion after this (default 600)
`;

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.workflow) {
    process.stdout.write(USAGE);
    process.exit(args.help ? 0 : 1);
  }

  const clientId = randomUUID();
  const httpBase = args.engine.replace(/\/$/, "");
  const wsBase = httpBase.replace(/^http/, "ws");
  const workflow = JSON.parse(await readWorkflow(args.workflow));

  const frames = [];
  const ws = new WebSocket(`${wsBase}/ws?clientId=${encodeURIComponent(clientId)}`);
  ws.binaryType = "arraybuffer";

  const finished = new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("timed out waiting for completion")),
      args.timeoutMs,
    );
    ws.addEventListener("error", (e) => reject(new Error(`websocket error: ${e.message ?? e}`)));
    ws.addEventListener("message", (ev) => {
      if (typeof ev.data !== "string") {
        // Binary preview frame — store its length, not its bytes.
        const bytes = ev.data.byteLength ?? ev.data.length ?? 0;
        frames.push({ binary: bytes });
        return;
      }
      const message = JSON.parse(ev.data);
      frames.push({ message });
      if (isCompletion(message) || isError(message)) {
        clearTimeout(timer);
        resolve();
      }
    });
  });

  await new Promise((r) => ws.addEventListener("open", r, { once: true }));

  // Submit only after the socket is open, or the opening frames are lost — the
  // same ordering the client enforces (comfy.ts connect).
  const promptRes = await fetch(`${httpBase}/prompt`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt: workflow, client_id: clientId }),
  });
  const prompt = { status: promptRes.status, body: await promptRes.json().catch(() => ({})) };
  const promptId = prompt.body?.prompt_id ?? null;

  let history = { status: 200, body: {} };
  if (promptRes.ok) {
    await finished; // wait for the run (or its error) to land
    const historyRes = await fetch(`${httpBase}/history/${encodeURIComponent(promptId)}`);
    history = { status: historyRes.status, body: await historyRes.json().catch(() => ({})) };
  }
  ws.close();

  const statsRes = await fetch(`${httpBase}/system_stats`);
  const systemStats = { status: statsRes.status, body: await statsRes.json().catch(() => ({})) };

  const fixture = {
    meta: {
      scenario: args.scenario,
      recordedAt: new Date().toISOString(),
      recordedWith: "scripts/record-comfy.mjs",
      comfyuiVersion: systemStats.body?.system?.comfyui_version ?? null,
      clientId,
      promptId,
    },
    http: { prompt, history, systemStats },
    frames,
  };

  await mkdir(FIXTURE_DIR, { recursive: true });
  const out = join(FIXTURE_DIR, `session-${args.scenario}.json`);
  await writeFile(out, JSON.stringify(fixture, null, 2) + "\n");
  process.stdout.write(`recorded ${frames.length} frames → ${out}\n`);
}

async function readWorkflow(path) {
  const { readFile } = await import("node:fs/promises");
  return readFile(path, "utf8");
}

main().catch((err) => {
  process.stderr.write(`record-comfy failed: ${err.message}\n`);
  process.exit(1);
});
