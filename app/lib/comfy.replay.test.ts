/**
 * The recorded-traffic suite ADR-010 (and #22) calls for: the real client and
 * the real {@link generate} flow, driven against a {@link MockEngine} that
 * replays sessions captured from a live ComfyUI — not hand-written frames.
 *
 * The sibling `comfy.test.ts`/`generate.test.ts` pin *wiring* with invented
 * frames (the client-id trap, the buffering window); this pins *behaviour*
 * against ComfyUI's actual message shapes. The three the Done criterion names —
 * progress, the `executing:{node:null}` completion, and a `400 + node_errors`
 * rejection — each come straight off a recording, so a shape ComfyUI changed out
 * from under us fails here rather than in a user's window.
 *
 * A note the fixtures encode: at the pinned sha the engine sends *both* a legacy
 * `progress {value,max,node}` and a newer `progress_state {nodes:{…}}`. The
 * client reads the former and ignores the latter — the success recording carries
 * both, so this proves the client still hears progress and doesn't trip over the
 * message it doesn't model.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { ComfyClient, parseMessage, PromptRejected, type EngineEvent } from "./comfy";
import { MockEngine, type Fixture } from "./comfy.mock";

// startEngine crosses IPC to Rust; here it just hands back a port.
vi.mock("./engine", () => ({ startEngine: vi.fn(async () => 8188) }));

import { generate } from "./generate";

import successFixture from "./__fixtures__/comfy/session-success.json";
import rejectedFixture from "./__fixtures__/comfy/session-rejected.json";
import errorFixture from "./__fixtures__/comfy/session-error.json";

const success = successFixture as Fixture;
const rejected = rejectedFixture as Fixture;
const errored = errorFixture as Fixture;

const flush = () => new Promise((r) => setTimeout(r, 0));

let engine: MockEngine | undefined;

afterEach(() => {
  engine?.restore();
  engine = undefined;
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

/** Installs a fixture as the live engine the real globals now reach. */
function replay(fixture: Fixture): MockEngine {
  engine = new MockEngine(fixture).install();
  return engine;
}

/** generate() also wraps `/view` bytes in a blob: URL — stub the one call it makes. */
function stubObjectUrl() {
  const TestURL = class extends URL {};
  Object.defineProperty(TestURL, "createObjectURL", { value: vi.fn(() => "blob:mock-url") });
  vi.stubGlobal("URL", TestURL);
}

describe("replaying a recorded session through ComfyClient", () => {
  it("surfaces every progress frame and the executing:{node:null} completion", async () => {
    replay(success);
    const events: EngineEvent[] = [];
    const client = new ComfyClient(8188, success.meta.clientId);
    const socket = client.connect({ onEvent: (e) => events.push(e) });

    await socket.opened;
    await flush(); // let the recorded frames replay

    // The legacy progress stream the client reads, in order, off the recording.
    const progress = events.filter((e) => e.kind === "progress");
    expect(progress.map((e) => (e.kind === "progress" ? e.value : -1))).toEqual([1, 2, 3, 4]);
    expect(progress.every((e) => e.kind === "progress" && e.max === 4)).toBe(true);

    // Completion is the terminal executing with a null node — the run's last event.
    expect(events.at(-1)).toEqual<EngineEvent>({
      kind: "executing",
      promptId: "rec-success-0001",
      node: null,
    });
    // A clean run carries no error event, and every frame was tagged with our id.
    expect(events.some((e) => e.kind === "error")).toBe(false);
    expect(events.every((e) => e.promptId === "rec-success-0001")).toBe(true);
  });

  it("drops the frames the client doesn't model — progress_state, previews, status", () => {
    // Straight over the raw recorded stream: the newer progress_state, the binary
    // preview frames, and the status/execution_* housekeeping all parse to null,
    // while the frames the client acts on don't.
    const modelled = replay(success)
      .wireFrames()
      .map(parseMessage)
      .filter((e): e is EngineEvent => e !== null);

    const kinds = new Set(modelled.map((e) => e.kind));
    expect(kinds).toEqual(new Set(["executing", "progress"]));
    // The recording genuinely contained the unmodelled traffic we just proved is dropped.
    expect(success.frames.some((f) => f.message?.type === "progress_state")).toBe(true);
    expect(success.frames.some((f) => f.binary !== undefined)).toBe(true);
  });

  it("reads VRAM back from the recorded /system_stats", async () => {
    replay(success);
    const vram = await new ComfyClient(8188, success.meta.clientId).systemStats();
    expect(vram).toBe(25_757_220_864);
  });
});

describe("replaying a recorded session end to end through generate", () => {
  it("carries a full generation to a blob URL, reporting progress", async () => {
    replay(success);
    stubObjectUrl();

    const onProgress = vi.fn();
    await expect(generate("a darkroom", onProgress)).resolves.toBe("blob:mock-url");

    // Progress reached the caller straight off the recording's progress frames.
    expect(onProgress).toHaveBeenCalledWith({ value: 1, max: 4 });
    expect(onProgress).toHaveBeenLastCalledWith({ value: 4, max: 4 });
  });

  it("rejects with the failing node's name on a recorded 400 + node_errors", async () => {
    replay(rejected);
    stubObjectUrl();

    const err = (await generate("a darkroom", vi.fn()).catch((e: unknown) => e)) as Error;
    // §8.6: the user gets the node and the reason, never a bare status.
    expect(err.message).toMatch(/UNETLoader/);
    expect(err.message).toMatch(/Value not in list/);
  });

  it("rejects with the node type and reason on a recorded execution_error", async () => {
    replay(errored);
    stubObjectUrl();

    const err = (await generate("a darkroom", vi.fn()).catch((e: unknown) => e)) as Error;
    expect(err.message).toMatch(/KSampler/);
    expect(err.message).toMatch(/out of memory/i);
  });
});

describe("ComfyClient.submit against a recorded rejection", () => {
  it("throws PromptRejected carrying node_errors from the recorded 400", async () => {
    replay(rejected);
    const err = (await new ComfyClient(8188).submit({}).catch((e: unknown) => e)) as PromptRejected;

    expect(err).toBeInstanceOf(PromptRejected);
    expect(err.nodeErrors).toHaveProperty("10");
    expect(err.message).toContain("node 10");
    expect(err.message).toContain("UNETLoader");
  });
});
