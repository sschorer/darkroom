/**
 * The minimal ComfyUI client (#10).
 *
 * ADR-008 puts the HTTP/WS conversation with the engine in the frontend, not
 * behind an IPC bridge: the WebView speaks both protocols natively, and progress
 * events are too frequent to proxy through Rust. This module is that
 * conversation, reduced to the four moves the walking skeleton needs:
 *
 *   1. `POST /prompt` a workflow, tagged with our `client_id`.
 *   2. Open a WebSocket and watch `progress` / `executing` / `execution_error`.
 *   3. Once the queue goes idle, `GET /history/{id}` for the outputs.
 *   4. Build a `/view` URL per output so an <img> can load the pixels.
 *
 * **The one trap this design exists to defeat** is the `client_id` mismatch. The
 * socket carries it as a `clientId` query param; `/prompt` carries it as a
 * `client_id` body field — different case, different place, trivially typoed
 * apart. Get them out of sync and zero progress events arrive while nothing
 * errors (CLAUDE.md; the issue budgets an afternoon for exactly this). So a
 * `ComfyClient` owns *one* id and both call sites read it from there — the
 * asymmetry is in the wire names below and nowhere a caller can reach.
 *
 * What's deliberately not here: workflow construction (ADR-005's `buildWorkflow`,
 * later) and cancellation and sequential queueing (#25). Video outputs, which
 * come back under `gifs` rather than `images`, are flattened alongside images
 * (#15) — the ref shape is identical, only the key differs.
 */

/**
 * A workflow in ComfyUI's **API format** — the node graph keyed by id, not the
 * UI export. The normal "Save" carries canvas layout that `/prompt` rejects;
 * only "Save (API Format)" produces this (CLAUDE.md). Typed loosely on purpose:
 * building and validating one is `buildWorkflow`'s job, not the client's.
 */
export type Workflow = Record<string, { class_type: string; inputs: Record<string, unknown> }>;

/**
 * Names one file the engine wrote, as `/history` reports it and `/view` wants it
 * back. All three fields ride the query string verbatim; `subfolder` is often
 * `""` and `type` is usually `"output"` (vs. `"temp"` for previews).
 */
export interface OutputRef {
  filename: string;
  subfolder: string;
  type: string;
}

/**
 * What `execution_error` carries when a node throws in Python. The engine fails
 * deep in a graph and the useful part is *which* node and *why* — §8.6 says the
 * user gets that, never a bare status — so `nodeType` and `message` (ComfyUI's
 * `exception_message`) are surfaced, with the `traceback` lines kept for the log.
 */
export interface ExecutionError {
  nodeId: string;
  nodeType: string;
  message: string;
  traceback: string[];
}

/**
 * A parsed WebSocket event, narrowed to the three the skeleton acts on. Tagged
 * by `kind` so callers `switch` on it; everything else on the socket (status
 * heartbeats, `executed`, cache notices, and the binary preview frames) is
 * dropped by {@link parseMessage} before it reaches here.
 *
 * `executing` with `node: null` is the engine saying the queue went idle — for a
 * single in-flight prompt, that is completion, and the caller's cue to fetch
 * history. `promptId` rides along where the engine sends it so #25 can filter a
 * shared socket by prompt; today's single-prompt flow needn't.
 */
export type EngineEvent =
  | { kind: "progress"; promptId: string | null; node: string | null; value: number; max: number }
  | { kind: "executing"; promptId: string | null; node: string | null }
  | { kind: "error"; promptId: string | null; error: ExecutionError };

/** Callbacks a {@link ComfyClient.connect} socket drives. */
export interface EngineHandlers {
  /** One parsed, modelled event. High-frequency during sampling. */
  onEvent(event: EngineEvent): void;
  /** The socket closed — cleanly or not. The engine dying shows up here. */
  onClose?(): void;
  /** A transport-level socket error (not an engine `execution_error`). */
  onSocketError?(err: Event): void;
}

/**
 * A live progress socket. {@link opened} resolves when the WebSocket is ready to
 * carry events and rejects if it fails before opening — a prompt must not be
 * submitted until it resolves, or the opening progress events are broadcast to
 * no one and lost.
 */
export interface ComfySocket {
  readonly opened: Promise<void>;
  close(): void;
}

/**
 * Thrown when `/prompt` returns 4xx — the engine refused the graph before
 * running it (a missing input, an unknown node, a bad connection). `nodeErrors`
 * is ComfyUI's `node_errors`, which names the offending node; the message folds
 * in a short summary of it so a caller that only logs `.message` still says
 * something actionable (§8.6).
 */
export class PromptRejected extends Error {
  constructor(
    readonly nodeErrors: Record<string, unknown>,
    detail: string,
  ) {
    super(detail);
    this.name = "PromptRejected";
  }
}

/**
 * Talks to one running engine. Construct it with the port the sidecar reported
 * and, optionally, a fixed `clientId` (a fresh UUID otherwise). Every request
 * and the socket read that same id — the mismatch trap can't be reached from
 * outside this object.
 */
export class ComfyClient {
  /** The id sent on both the socket (`clientId`) and `/prompt` (`client_id`). */
  readonly clientId: string;

  /** `http://127.0.0.1:<port>` — the CSP allows exactly this origin. */
  private readonly httpBase: string;
  /** `ws://127.0.0.1:<port>` — likewise whitelisted in `connect-src`. */
  private readonly wsBase: string;

  constructor(port: number, clientId: string = crypto.randomUUID()) {
    this.clientId = clientId;
    this.httpBase = `http://127.0.0.1:${port}`;
    this.wsBase = `ws://127.0.0.1:${port}`;
  }

  /**
   * Queues a workflow and returns its `prompt_id`. Carries this client's id in
   * the `client_id` body field — the snake_case half of the pair the socket
   * sends as `clientId`.
   *
   * A 4xx becomes a {@link PromptRejected} carrying `node_errors`; any other
   * non-2xx throws with the status. The returned id is what the socket's events
   * and {@link history} key on.
   */
  async submit(workflow: Workflow): Promise<string> {
    const res = await fetch(`${this.httpBase}/prompt`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: workflow, client_id: this.clientId }),
    });

    if (!res.ok) {
      throw await promptError(res);
    }

    const body: unknown = await res.json();
    const promptId =
      body && typeof body === "object" ? (body as { prompt_id?: unknown }).prompt_id : undefined;
    if (typeof promptId !== "string") {
      throw new Error(
        `the engine accepted the prompt but returned no prompt_id (got ${typeof promptId})`,
      );
    }
    return promptId;
  }

  /**
   * Interrupts whatever prompt is running right now: `POST /interrupt`, no body.
   * ComfyUI cancels the in-flight sampling and emits `execution_interrupted`,
   * then drains the queue — so the caller's socket sees the run stop of its own
   * accord (the `executing {node:null}` idle) rather than a hang.
   *
   * The endpoint targets the *engine's* current job, not a `prompt_id`: on our
   * loopback engine (ADR-007) the sequential queue (#27) only ever has one
   * prompt in flight, so "the running one" is unambiguous. A non-2xx throws —
   * cancel that silently fails leaves a tile stuck generating with no way out.
   */
  async interrupt(): Promise<void> {
    const res = await fetch(`${this.httpBase}/interrupt`, { method: "POST" });
    if (!res.ok) {
      throw new Error(`could not interrupt the engine: HTTP ${res.status}`);
    }
  }

  /**
   * Opens the progress socket, reading this client's id as the `clientId` query
   * param. Parsed events go to `handlers.onEvent`; binary preview frames and
   * unmodelled messages never reach it (see {@link parseMessage}).
   *
   * `binaryType` is set to `arraybuffer` so a preview frame arrives as an
   * `ArrayBuffer` — a non-string `data`, which the parser skips before it would
   * ever hand a JPEG to `JSON.parse`.
   */
  connect(handlers: EngineHandlers): ComfySocket {
    const ws = new WebSocket(`${this.wsBase}/ws?clientId=${encodeURIComponent(this.clientId)}`);
    ws.binaryType = "arraybuffer";

    const opened = new Promise<void>((resolve, reject) => {
      // `once` so a later error (after a clean open) can't reject an already
      // settled promise; those go to onSocketError below instead.
      ws.addEventListener("open", () => resolve(), { once: true });
      ws.addEventListener("error", (err) => reject(err), { once: true });
    });

    ws.addEventListener("message", (ev: MessageEvent) => {
      const event = parseMessage(ev.data);
      if (event) {
        handlers.onEvent(event);
      }
    });
    ws.addEventListener("close", () => handlers.onClose?.());
    ws.addEventListener("error", (err) => handlers.onSocketError?.(err));

    return { opened, close: () => ws.close() };
  }

  /**
   * Fetches the outputs of a finished prompt: `GET /history/{id}`, flattened to
   * the image refs across every node. Empty until the prompt completes, so call
   * it after the socket reports `executing` with `node: null`.
   */
  async history(promptId: string): Promise<OutputRef[]> {
    const res = await fetch(`${this.httpBase}/history/${encodeURIComponent(promptId)}`);
    if (!res.ok) {
      throw new Error(`could not read history for ${promptId}: HTTP ${res.status}`);
    }
    return outputsFromHistory(await res.json(), promptId);
  }

  /**
   * The URL that serves one output's pixels. Bare-string interpolation would
   * break on a filename with a space or an `&`, so the three fields go through
   * `URLSearchParams`. The result is same-origin with the socket, so the CSP
   * already permits an <img> to load it.
   */
  viewUrl(ref: OutputRef): string {
    const query = new URLSearchParams({
      filename: ref.filename,
      subfolder: ref.subfolder,
      type: ref.type,
    });
    return `${this.httpBase}/view?${query}`;
  }

  /**
   * Reads the engine's `/system_stats` and returns the total VRAM in bytes of
   * the largest GPU it sees, or `null` when it sees none. This is the number
   * VRAM gating compares each model's `requires.vram_gb` against (§8.5, Q5,
   * `gate.ts`).
   *
   * ADR-008 puts this read in the frontend: the sidecar hits the same endpoint
   * at boot, but only as proof of life — the VRAM figure it carries is ours to
   * re-read here (sidecar.rs, §6.2). `null` is not an error — a CPU-only engine
   * has no VRAM to gate on, and the UI's accelerator warning already tells that
   * user their setup is unsupported (TD-2).
   */
  async systemStats(): Promise<number | null> {
    const res = await fetch(`${this.httpBase}/system_stats`);
    if (!res.ok) {
      throw new Error(`could not read system stats from the engine: HTTP ${res.status}`);
    }
    return vramTotalFromStats(await res.json());
  }
}

/**
 * The total VRAM in bytes of the largest GPU the engine reports, or `null` when
 * it reports none. Exported for its own tests: `/system_stats`' shape is
 * ComfyUI's own and undocumented, and the device selection is where a wrong
 * guess would silently gate every model or none.
 *
 * A `cpu` device is skipped — ComfyUI reports the machine's *system RAM* as its
 * `vram_total`, which would wave every model through on a GPU-less box, the
 * exact OOM VRAM gating exists to prevent (§8.5). Across the remaining GPUs the
 * largest wins: that is the one generation will land on.
 */
export function vramTotalFromStats(raw: unknown): number | null {
  const devices = (raw as { devices?: unknown } | null)?.devices;
  if (!Array.isArray(devices)) {
    return null;
  }
  let best: number | null = null;
  for (const device of devices) {
    const d = device as { type?: unknown; vram_total?: unknown } | null;
    if (!d || d.type === "cpu") {
      continue;
    }
    if (typeof d.vram_total === "number" && d.vram_total > 0) {
      best = best === null ? d.vram_total : Math.max(best, d.vram_total);
    }
  }
  return best;
}

/**
 * Turns one raw WebSocket payload into an {@link EngineEvent}, or `null` for
 * anything the skeleton ignores.
 *
 * Exported for its own tests: this is where the binary-frame skip and the shape
 * of ComfyUI's (undocumented) messages live, and #22's recorded-traffic suite
 * will lean on it.
 *
 * Order matters. A preview image arrives as an `ArrayBuffer`/`Blob`, not a
 * string, so the non-string guard comes *first* — handing those bytes to
 * `JSON.parse` is the crash the "skip binary frames" checkbox is about. Then a
 * malformed text frame is swallowed rather than thrown: the socket is a firehose
 * and one bad line must not take down the run.
 */
export function parseMessage(data: unknown): EngineEvent | null {
  if (typeof data !== "string") {
    return null; // a binary preview frame — never JSON.
  }

  let msg: { type?: unknown; data?: unknown };
  try {
    msg = JSON.parse(data) as typeof msg;
  } catch {
    return null;
  }
  if (!msg || typeof msg !== "object") {
    return null;
  }

  const d = (msg.data ?? {}) as Record<string, unknown>;
  const promptId = typeof d.prompt_id === "string" ? d.prompt_id : null;

  switch (msg.type) {
    case "progress":
      if (typeof d.value === "number" && typeof d.max === "number") {
        return {
          kind: "progress",
          promptId,
          node: typeof d.node === "string" ? d.node : null,
          value: d.value,
          max: d.max,
        };
      }
      return null;

    case "executing":
      // `node` is a string while a node runs and literal null when the queue
      // drains — that null is the completion signal, so it is a value, not a
      // reason to drop the event. Anything else (missing, numeric, boolean) is a
      // malformed frame: reject it rather than coerce it to null, which would
      // otherwise forge a completion the engine never sent.
      if (d.node !== null && typeof d.node !== "string") {
        return null;
      }
      return {
        kind: "executing",
        promptId,
        node: d.node,
      };

    case "execution_error":
      return {
        kind: "error",
        promptId,
        error: {
          nodeId: typeof d.node_id === "string" ? d.node_id : "",
          nodeType: typeof d.node_type === "string" ? d.node_type : "",
          message:
            typeof d.exception_message === "string"
              ? d.exception_message
              : "the engine reported an error",
          traceback: Array.isArray(d.traceback)
            ? d.traceback.filter((l): l is string => typeof l === "string")
            : [],
        },
      };

    default:
      return null; // status, executed, execution_cached, … — not ours to act on.
  }
}

/**
 * Flattens a `/history` response to its output refs. Exported for tests because
 * the response shape (`{ [promptId]: { outputs: { [nodeId]: { images: [...] } } } }`)
 * is deep and undocumented, and the flattening is where a wrong guess hides.
 *
 * Image nodes report under `images`; video nodes (`SaveAnimatedWEBP`,
 * `VHS_VideoCombine`) report the identical ref shape under `gifs` (#15). Both
 * keys are flattened so a clip from the registry path surfaces the same way a
 * still does. Anything malformed is skipped rather than thrown: a partial
 * history should yield the outputs it does have.
 */
export function outputsFromHistory(history: unknown, promptId: string): OutputRef[] {
  const entry = (history as Record<string, unknown> | null)?.[promptId];
  const outputs = (entry as { outputs?: unknown } | undefined)?.outputs;
  if (!outputs || typeof outputs !== "object") {
    return [];
  }

  const refs: OutputRef[] = [];
  for (const node of Object.values(outputs as Record<string, unknown>)) {
    const media = node as { images?: unknown; gifs?: unknown } | null;
    for (const list of [media?.images, media?.gifs]) {
      if (!Array.isArray(list)) {
        continue;
      }
      for (const item of list) {
        if (
          item &&
          typeof item === "object" &&
          typeof (item as OutputRef).filename === "string" &&
          typeof (item as OutputRef).type === "string"
        ) {
          const ref = item as { filename: string; subfolder?: unknown; type: string };
          refs.push({
            filename: ref.filename,
            subfolder: typeof ref.subfolder === "string" ? ref.subfolder : "",
            type: ref.type,
          });
        }
      }
    }
  }
  return refs;
}

/** A body snippet longer than this is truncated into the rejection detail. */
const BODY_TAIL_LIMIT = 500;

/**
 * Builds the {@link PromptRejected} for a non-2xx `/prompt`. Pulls
 * `node_errors` and the top-level `error.message` from the body when it is the
 * JSON ComfyUI sends on a 400 — that is the actionable part §8.6 wants, naming
 * the failing node. When the body is *not* that JSON (a 5xx trace, a truncated
 * response), the raw text is folded into the detail rather than discarded, so
 * the reason never collapses to a bare status code.
 *
 * The body is read as text *once* and parsed from there: a `Response` body is a
 * single-use stream, so reading `.json()` and `.text()` off the same response is
 * not an option. The engine *log tail* — the other half of §8.6 — lives on the
 * Rust side (`engine.log`, unreachable from this fetch layer); wiring it into a
 * client-side rejection is #28's error-surfacing work, not this minimal client's.
 */
async function promptError(res: Response): Promise<PromptRejected> {
  let nodeErrors: Record<string, unknown> = {};
  const status = `the engine rejected the prompt: HTTP ${res.status}`;

  const raw = await res.text().catch(() => "");

  type ErrorBody = { error?: { message?: unknown }; node_errors?: unknown };
  let parsed: ErrorBody | null = null;
  try {
    parsed = raw ? (JSON.parse(raw) as ErrorBody) : null;
  } catch {
    parsed = null; // not the JSON we expected; fall through to the text tail.
  }

  if (parsed && parsed.node_errors && typeof parsed.node_errors === "object") {
    nodeErrors = parsed.node_errors as Record<string, unknown>;
  }
  const summary = summariseNodeErrors(nodeErrors);
  const top = typeof parsed?.error?.message === "string" ? parsed.error.message : null;

  // Prefer the structured diagnostics; otherwise keep whatever the server said,
  // trimmed to a sane length. Only when there is nothing at all do we fall back
  // to the status line alone.
  const structured = [top, summary].filter(Boolean).join(" — ");
  const tail = !structured && raw ? tailOf(raw) : "";
  const detail = [status, structured || tail].filter(Boolean).join("\n  ");

  return new PromptRejected(nodeErrors, detail);
}

/** The trailing, collapsed snippet of a response body, capped for readability. */
function tailOf(body: string): string {
  const text = body.trim().replace(/\s+/g, " ");
  return text.length > BODY_TAIL_LIMIT ? `…${text.slice(-BODY_TAIL_LIMIT)}` : text;
}

/**
 * A one-line "node 6 (KSampler): <first error>" summary of `node_errors`, so the
 * failing node's name reaches the user even from a caller that only reads
 * `.message`. Best-effort over an undocumented shape; an unrecognised entry is
 * simply left out.
 */
function summariseNodeErrors(nodeErrors: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [nodeId, value] of Object.entries(nodeErrors)) {
    const v = value as { class_type?: unknown; errors?: unknown };
    const classType = typeof v.class_type === "string" ? ` (${v.class_type})` : "";
    const first = Array.isArray(v.errors)
      ? (v.errors[0] as { message?: unknown } | undefined)
      : undefined;
    const message = typeof first?.message === "string" ? first.message : "invalid";
    parts.push(`node ${nodeId}${classType}: ${message}`);
  }
  return parts.join("; ");
}
