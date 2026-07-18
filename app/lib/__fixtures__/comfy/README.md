# Recorded ComfyUI sessions

Fixtures the mock engine (`app/lib/comfy.mock.ts`) replays to test the engine
boundary with **no GPU** — ADR-010's "test everything except the GPU". Each file
is one captured session: the HTTP responses the client reads (`/prompt`,
`/history`, `/system_stats`) and the ordered WebSocket frames a generation
produced.

## Why recorded, not hand-written

ComfyUI has no API contract (RISK-1) and its WebSocket message shapes are
undocumented. A frame you invent encodes your *assumption* of the engine's
behaviour; a recorded one is the behaviour. So these are captured from a running
engine with `scripts/record-comfy.mjs`, and the `comfyuiSha` in each `meta`
records which engine they came from — a sha bump can change the shapes (RISK-1),
and that's what the "Bump the engine" runbook re-checks.

No GPU is needed to *record* them either: the frame shapes are identical whether
the sampler ran on a 4090 in two seconds or a CPU in twenty minutes. Only the
pixels differ, and the fixtures hold no pixels.

## The scenarios

| File                     | Covers                                                             |
| ------------------------ | ----------------------------------------------------------------- |
| `session-success.json`   | progress frames and the `executing:{node:null}` completion signal |
| `session-rejected.json`  | `POST /prompt` → `400` carrying `node_errors` (named failing node) |
| `session-error.json`     | a node throwing mid-run → `execution_error` (type + reason)       |

The first three rows are exactly the Done criterion of
[#22](https://github.com/sschorer/darkroom/issues/22).

## Storage format

- **Text frames** are stored parsed — `{"message": {"type", "data"}}` — not as
  raw wire strings. The client `JSON.parse`s before acting and is
  whitespace-insensitive, so this preserves every key and value (what matters)
  while keeping the fixture diff-able in review.
- **Binary preview frames** are stored as their byte length only —
  `{"binary": N}`. The client's only question of a binary frame is whether it's a
  string (no — it's dropped before `JSON.parse`), so the bytes carry no test
  signal and a base64 JPEG would just bloat the fixture.

## Refreshing a fixture

Run a live engine, then:

```bash
node scripts/record-comfy.mjs \
  --engine http://127.0.0.1:8188 \
  --workflow path/to/workflow.api.json \
  --scenario success
```

Use an **API-format** workflow export (CLAUDE.md). For `rejected`, feed a
workflow the engine will refuse (e.g. a model name it doesn't have); for `error`,
one that throws mid-run (e.g. a VRAM-busting resolution). Review the shape diff
before committing — a changed shape is a real signal, not churn.

## A shape worth knowing

At the pinned sha the engine emits **two** progress messages per step: a legacy
`progress {value, max, node}` (from `main.py`'s `hijack_progress`) and a newer
`progress_state {nodes: {…}}` (from `comfy_execution/progress.py`). The client
reads the legacy one and ignores `progress_state`. `session-success.json` carries
both, so the replay tests prove the client still hears progress and doesn't trip
over the message it doesn't model — the kind of thing a hand-written fixture
would have quietly omitted.
