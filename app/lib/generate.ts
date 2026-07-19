/**
 * One generation, end to end: a workflow in, an image out. {@link runGeneration}
 * is the reusable core — it drives ARCHITECTURE.md's engine/client conversation
 * (§6.2 `start_engine` for the port, §6.3 the {@link ComfyClient}) for *any*
 * API-format workflow and reports progress as it samples. The generation queue
 * (#27) calls it once per job with a `buildWorkflow`-patched graph; {@link
 * generate} is the thin walking-skeleton wrapper (#11) that feeds it one
 * hardcoded FLUX.2 klein workflow, kept because the recorded-traffic suites
 * (ADR-010) drive the whole socket dance through it.
 *
 * Cancellation is an {@link https://developer.mozilla.org/docs/Web/API/AbortSignal
 * AbortSignal}: aborting it `POST /interrupt`s the engine and settles the run as
 * {@link GenerationCancelled}, distinct from a failure so the queue can drop the
 * job rather than mark it errored.
 */
import {
  ComfyClient,
  firstNodeError,
  PromptRejected,
  type EngineEvent,
  type Workflow,
} from "./comfy";
import { startEngine } from "./engine";
import baseWorkflow from "./flux2-klein.workflow.json";

/**
 * The node whose `text` carries the positive prompt. Hardcoded to match
 * `flux2-klein.workflow.json`; the real by-role patching is `buildWorkflow`'s
 * job (#16), used by the queue rather than this walking-skeleton wrapper.
 */
const PROMPT_NODE = "6";

/** How far along the current sampling run is, straight off the engine's `progress`. */
export interface GenerateProgress {
  value: number;
  max: number;
}

/**
 * Settled onto by {@link runGeneration} when its {@link AbortSignal} fires. A
 * *distinct* type, not a plain `Error`, so the caller (#27's queue) can tell a
 * user-requested cancel apart from a real failure: a cancel drops the tile, a
 * failure keeps it with its reason. The message is deliberately terse — a cancel
 * is not something the user needs told back to them.
 */
export class GenerationCancelled extends Error {
  constructor() {
    super("the generation was cancelled.");
    this.name = "GenerationCancelled";
  }
}

/**
 * A run that failed, decomposed for the error surface (#29). §8.6 says the user
 * gets *which* node and *why*, never a bare status — so a node throw carries its
 * `nodeType` ("CLIPTextEncode"), `nodeId` (the "#6"), and `message`, while a
 * transport failure (the engine dying, a socket that won't open, a workflow that
 * won't build) leaves the node fields null and keeps just the reason. `promptId`
 * rides along when the engine had assigned one, for the banner's "prompt_id 7b2f…"
 * line. `message` is always present — it is the error's own `.message`.
 */
export interface GenerationFailure {
  nodeType: string | null;
  nodeId: string | null;
  promptId: string | null;
  message: string;
}

/**
 * Settled onto by {@link runGeneration} for any non-cancel failure. Distinct from
 * {@link GenerationCancelled} (which the queue drops) so a real failure keeps its
 * tile with a structured {@link GenerationFailure} the banner and failed tile
 * render from, rather than a flat string the UI would have to re-parse.
 */
export class GenerationFailed extends Error {
  constructor(readonly failure: GenerationFailure) {
    super(failure.message);
    this.name = "GenerationFailed";
  }
}

/**
 * Normalises whatever a run threw into a {@link GenerationFailure}. A
 * {@link PromptRejected} is unpacked to its first `node_errors` entry (the node
 * §8.6 wants named); a node's `execution_error` already arrives structured (see
 * {@link GenerationFailed}); anything else — a dead socket, a failed engine
 * spawn, a workflow that wouldn't build — is a transport failure with no node to
 * blame, so its `.message` is kept as-is. `promptId` is threaded through because
 * the throw site rarely carries it but the run always knows it.
 */
function asFailure(error: unknown, promptId: string | null): GenerationFailure {
  if (error instanceof GenerationFailed) {
    return error.failure;
  }
  if (error instanceof PromptRejected) {
    const node = firstNodeError(error.nodeErrors);
    return {
      nodeType: node?.nodeType ?? null,
      nodeId: node?.nodeId ?? null,
      promptId,
      message: node?.message ?? error.message,
    };
  }
  return {
    nodeType: null,
    nodeId: null,
    promptId,
    message: error instanceof Error ? error.message : String(error),
  };
}

/** What {@link runGeneration} needs beyond the workflow: where to report steps,
 *  and an optional signal that cancels the run when aborted. */
export interface RunGenerationOptions {
  onProgress: (p: GenerateProgress) => void;
  signal?: AbortSignal;
}

/**
 * Runs one generation and resolves to a `blob:` URL for the first image.
 *
 * A `blob:` URL, not the engine's `/view` URL directly: the app is served from
 * `tauri://localhost`, so `http://127.0.0.1:<port>/view` is cross-origin, and
 * the CSP's `img-src` does not list it (only `connect-src` does). Fetching the
 * bytes is a `connect-src` request the CSP allows; wrapping them in a `blob:`
 * URL is an `img-src` the CSP allows. So the pixels reach an `<img>` without
 * weakening the CSP to make it work (the wrong fix, per CLAUDE.md). The caller
 * owns the returned URL and must `URL.revokeObjectURL` it when done.
 *
 * Rejects with an actionable message: a node that throws in Python surfaces its
 * node type and reason (§8.6), and the engine dying mid-run surfaces as a closed
 * socket rather than a hang. An aborted `signal` settles it as {@link
 * GenerationCancelled} instead — the engine is interrupted and the run unwinds.
 */
export async function runGeneration(
  workflow: Workflow,
  { onProgress, signal }: RunGenerationOptions,
): Promise<string> {
  const port = await startEngine();
  const client = new ComfyClient(port);

  // Our prompt's id, known only once `submit` resolves. The engine can already
  // be emitting events by then (they fire during the POST), so events that
  // arrive before we know our id are *buffered*, not processed or dropped —
  // otherwise a fast run's completion could land before `submit` returns and be
  // lost, hanging forever. Once the id is known the buffer is replayed and
  // subsequent events flow straight through.
  let submittedId: string | null = null;
  const pending: EngineEvent[] = [];

  // Whether we have seen this prompt actually run. `executing {node: null}` is
  // the queue going idle, which is completion *only after* our prompt has been
  // seen executing — otherwise an idle-queue notice that arrives before ours
  // starts would forge a completion the engine never gave for us.
  let sawExecuting = false;

  const resolvers = deferred();
  // A socket callback can reject this on a path where we never await it — the
  // socket failing to open (we throw at `await socket.opened` first), or the
  // finally's `close` firing `onClose` again after the run already settled. A
  // benign catch keeps that from surfacing as an unhandled rejection; the
  // `await resolvers.promise` below still observes the real rejection.
  void resolvers.promise.catch(() => {});

  const handle = (event: EngineEvent) => {
    // On a shared engine (the user's own, ADR-007) the socket can carry another
    // queue item's events; once we know our id, ignore anything not ours.
    if (event.promptId && submittedId && event.promptId !== submittedId) {
      return;
    }
    switch (event.kind) {
      case "progress":
        sawExecuting = true;
        onProgress({ value: event.value, max: event.max });
        break;
      case "executing":
        if (event.node !== null) {
          sawExecuting = true;
        } else if (sawExecuting) {
          resolvers.resolve();
        }
        break;
      case "error":
        // A node threw in Python: keep the node type and id structured (the
        // banner and failed tile render them, §8.6) rather than flattening them
        // into a string the UI would re-parse. The error event carries our
        // prompt id; fall back to the one we submitted with.
        resolvers.reject(
          new GenerationFailed({
            nodeType: event.error.nodeType || null,
            nodeId: event.error.nodeId || null,
            promptId: event.promptId ?? submittedId,
            message: event.error.message,
          }),
        );
        break;
    }
  };

  // Subscribe before submitting: the opening progress events fire during the
  // POST, and a socket opened after would miss them (ComfyClient.connect).
  const socket = client.connect({
    onEvent(event: EngineEvent) {
      if (submittedId === null) {
        pending.push(event);
      } else {
        handle(event);
      }
    },
    onClose() {
      // Harmless once the run has already settled; the decisive case is the
      // engine dying mid-sample, which arrives here and nowhere else.
      resolvers.reject(new Error("the engine closed the connection before finishing."));
    },
    onSocketError() {
      resolvers.reject(new Error("lost the connection to the engine."));
    },
  });

  // Cancellation: interrupt the engine (it stops sampling and drains its queue)
  // and settle the run as cancelled. Registered once the client exists; the
  // already-aborted case is caught by the guard at the top of the try, since
  // `addEventListener` never fires for an abort that happened before it. The
  // interrupt is best-effort — a cancel the engine can't hear still unwinds the
  // client, and the socket closing in `finally` is the backstop.
  const onAbort = () => {
    void client.interrupt().catch(() => {});
    resolvers.reject(new GenerationCancelled());
  };
  signal?.addEventListener("abort", onAbort, { once: true });

  try {
    if (signal?.aborted) {
      throw new GenerationCancelled();
    }

    // `opened` rejects with the WebSocket's raw error Event, which carries no
    // readable detail (browsers hide it) and stringifies to "[object Event]".
    // Translate it to something actionable: the engine answered HTTP health or
    // we would not be here, so a socket that still won't open points at the
    // engine log (§8.6). The browser devtools console shows the underlying
    // reason — a CSP block or a refused upgrade — verbatim.
    try {
      await socket.opened;
    } catch {
      throw new Error(
        "could not open the progress socket to the engine.\n  " +
          "It answered on HTTP but refused the WebSocket. Check Help → Open Logs " +
          "for a traceback — the engine may have exited right after starting.",
      );
    }

    submittedId = await client.submit(workflow);
    // An abort that raced the /prompt POST fired its interrupt (in `onAbort`)
    // before the engine had our prompt to interrupt — a no-op that would leave
    // the engine sampling a run we've abandoned. Now that the prompt is queued,
    // interrupt it for real and unwind as cancelled, before replaying events or
    // awaiting a completion we'd only discard. Best-effort interrupt, so a cancel
    // still settles as GenerationCancelled (the queue's drop-the-tile signal)
    // rather than as a failure if the interrupt POST itself fails.
    if (signal?.aborted) {
      await client.interrupt().catch(() => {});
      throw new GenerationCancelled();
    }
    // Replay whatever arrived while the id was unknown, in order. Synchronous,
    // so no live event can interleave between assigning the id and draining.
    for (const event of pending) {
      handle(event);
    }
    pending.length = 0;

    await resolvers.promise;

    const outputs = await client.history(submittedId);
    if (outputs.length === 0) {
      throw new Error("the engine finished but produced no image.");
    }
    return await fetchAsBlobUrl(client.viewUrl(outputs[0]));
  } catch (error) {
    // A cancel is the queue's drop-the-tile signal — pass it through untouched.
    // Everything else settles as a structured GenerationFailed: a node throw
    // keeps its node fields, a socket death or a rejected prompt folds into one
    // (asFailure), so the caller reads a single failure shape (§8.6).
    if (error instanceof GenerationCancelled) {
      throw error;
    }
    throw new GenerationFailed(asFailure(error, submittedId));
  } finally {
    signal?.removeEventListener("abort", onAbort);
    socket.close();
  }
}

/**
 * The walking-skeleton entry (#11): one hardcoded FLUX.2 klein workflow with the
 * prompt patched in, run through {@link runGeneration}. The app generates through
 * the queue (#27) now, so this is exercised only by the recorded-traffic suites
 * (ADR-010) — the cheapest place the whole socket dance stays under test.
 */
export async function generate(
  prompt: string,
  onProgress: (p: GenerateProgress) => void,
): Promise<string> {
  return runGeneration(withPrompt(prompt), { onProgress });
}

/** Deep-clones the base workflow and patches the prompt into its one text node. */
function withPrompt(prompt: string): Workflow {
  const workflow = structuredClone(baseWorkflow) as Workflow;
  const node = workflow[PROMPT_NODE];
  // The hardcoded workflow and this constant must agree; a mismatch is a bug
  // here, not a runtime input, so it throws loudly (the spirit of ADR-005).
  if (!node) {
    throw new Error(`the hardcoded workflow is missing its prompt node "${PROMPT_NODE}".`);
  }
  node.inputs.text = prompt;
  return workflow;
}

/**
 * Fetches an engine output and hands back a `blob:` URL the CSP will render.
 *
 * A failure here is post-generation (the image exists; serving it faltered), so
 * there is no `node_errors` to surface — but a bare status is still too little
 * (§8.6), so the engine's response body is folded in when it sent one. The
 * engine *log tail*, the other half of the error contract, lives on the Rust
 * side and is #28's to wire through; a client fetch can't reach it.
 */
async function fetchAsBlobUrl(url: string): Promise<string> {
  const res = await fetch(url);
  if (!res.ok) {
    const body = (await res.text().catch(() => "")).trim();
    const detail = body ? `: ${body.slice(0, 300)}` : ".";
    throw new Error(`could not fetch the generated image: HTTP ${res.status}${detail}`);
  }
  return URL.createObjectURL(await res.blob());
}

/** A promise split from its resolvers, so socket callbacks can settle it. */
function deferred(): {
  promise: Promise<void>;
  resolve: () => void;
  reject: (e: Error) => void;
} {
  let resolve!: () => void;
  let reject!: (e: Error) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
