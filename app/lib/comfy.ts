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
 * later), cancellation and sequential queueing (#25), and video outputs, which
 * come back under `gifs` rather than `images` (#24). This handles images.
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
      // `node` is a string while a node runs and null when the queue drains —
      // that null is the completion signal, so it is a value, not a reason to
      // drop the event.
      return {
        kind: "executing",
        promptId,
        node: typeof d.node === "string" ? d.node : null,
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
 * Flattens a `/history` response to its image refs. Exported for tests because
 * the response shape (`{ [promptId]: { outputs: { [nodeId]: { images: [...] } } } }`)
 * is deep and undocumented, and the flattening is where a wrong guess hides.
 *
 * Only `images` — video comes back under `gifs` and is #24's problem, called out
 * so the omission reads as scoped, not forgotten. Anything malformed is skipped
 * rather than thrown: a partial history should yield the outputs it does have.
 */
export function outputsFromHistory(history: unknown, promptId: string): OutputRef[] {
  const entry = (history as Record<string, unknown> | null)?.[promptId];
  const outputs = (entry as { outputs?: unknown } | undefined)?.outputs;
  if (!outputs || typeof outputs !== "object") {
    return [];
  }

  const refs: OutputRef[] = [];
  for (const node of Object.values(outputs as Record<string, unknown>)) {
    const images = (node as { images?: unknown } | null)?.images;
    if (!Array.isArray(images)) {
      continue;
    }
    for (const image of images) {
      if (
        image &&
        typeof image === "object" &&
        typeof (image as OutputRef).filename === "string" &&
        typeof (image as OutputRef).type === "string"
      ) {
        const ref = image as { filename: string; subfolder?: unknown; type: string };
        refs.push({
          filename: ref.filename,
          subfolder: typeof ref.subfolder === "string" ? ref.subfolder : "",
          type: ref.type,
        });
      }
    }
  }
  return refs;
}

/**
 * Builds the {@link PromptRejected} for a non-2xx `/prompt`. Pulls
 * `node_errors` and the top-level `error.message` from the body when it is the
 * JSON ComfyUI sends on a 400, and degrades to the bare status when it is not
 * (a proxy error page, a truncated body) — the point is to never lose the
 * response by assuming a shape it might not have.
 */
async function promptError(res: Response): Promise<PromptRejected> {
  let nodeErrors: Record<string, unknown> = {};
  let detail = `the engine rejected the prompt: HTTP ${res.status}`;

  try {
    const body = (await res.json()) as {
      error?: { message?: unknown };
      node_errors?: unknown;
    };
    if (body.node_errors && typeof body.node_errors === "object") {
      nodeErrors = body.node_errors as Record<string, unknown>;
    }
    const summary = summariseNodeErrors(nodeErrors);
    const top = typeof body.error?.message === "string" ? body.error.message : null;
    if (top || summary) {
      detail = [top, summary].filter(Boolean).join(" — ");
    }
  } catch {
    // Not the JSON we expected; the status-only detail above stands.
  }

  return new PromptRejected(nodeErrors, detail);
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
