/**
 * The one generation flow the walking-skeleton gate needs (#11): a prompt in,
 * an image out. Deliberately hardcoded — no registry, no `buildWorkflow`, no
 * queue. Those are M1+; this exists to prove ARCHITECTURE.md's engine/client
 * design carries real pixels end to end, and to surface what hurts doing it.
 *
 * It stitches together the three pieces built before it: `start_engine` for the
 * port (§6.2), the {@link ComfyClient} conversation (§6.3), and one hardcoded
 * FLUX.2 klein workflow. The only thing that varies at runtime is the positive
 * prompt, patched into a single node.
 */
import { ComfyClient, type EngineEvent, type Workflow } from "./comfy";
import { startEngine } from "./engine";
import baseWorkflow from "./flux2-klein.workflow.json";

/**
 * The node whose `text` carries the positive prompt. Hardcoded to match
 * `flux2-klein.workflow.json`; the real by-role patching is `buildWorkflow`'s
 * job (#16), and a manifest will name this node rather than a constant here.
 */
const PROMPT_NODE = "6";

/** How far along the current sampling run is, straight off the engine's `progress`. */
export interface GenerateProgress {
  value: number;
  max: number;
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
 * socket rather than a hang.
 */
export async function generate(
  prompt: string,
  onProgress: (p: GenerateProgress) => void,
): Promise<string> {
  const port = await startEngine();
  const client = new ComfyClient(port);
  const workflow = withPrompt(prompt);

  // Our prompt's id, known only after submit. Until then it gates the
  // completion signal so a stray `executing {node: null}` can't end the run
  // before it has begun.
  let submittedId: string | null = null;

  const resolvers = deferred();

  // Subscribe before submitting: the opening progress events fire during the
  // POST, and a socket opened after would miss them (ComfyClient.connect).
  const socket = client.connect({
    onEvent(event: EngineEvent) {
      // On a shared engine (the user's own, ADR-007) the socket can carry
      // another queue item's events; once we know our id, ignore the rest.
      if (submittedId && event.promptId && event.promptId !== submittedId) {
        return;
      }
      switch (event.kind) {
        case "progress":
          onProgress({ value: event.value, max: event.max });
          break;
        case "executing":
          // `node: null` is the queue going idle — completion for our single
          // in-flight prompt. Gated on submittedId so it only counts after we
          // have actually queued something.
          if (event.node === null && submittedId) {
            resolvers.resolve();
          }
          break;
        case "error":
          resolvers.reject(
            new Error(`${event.error.nodeType || "the engine"}: ${event.error.message}`),
          );
          break;
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

  try {
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
    await resolvers.promise;

    const outputs = await client.history(submittedId);
    if (outputs.length === 0) {
      throw new Error("the engine finished but produced no image.");
    }
    return await fetchAsBlobUrl(client.viewUrl(outputs[0]));
  } finally {
    socket.close();
  }
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

/** Fetches an engine output and hands back a `blob:` URL the CSP will render. */
async function fetchAsBlobUrl(url: string): Promise<string> {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`could not fetch the generated image: HTTP ${res.status}.`);
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
