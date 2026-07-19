import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ComfyClient,
  outputsFromHistory,
  parseMessage,
  PromptRejected,
  vramTotalFromStats,
  type EngineEvent,
} from "./comfy";

/** A text frame as the engine sends it: the JSON string, not an object. */
const frame = (type: string, data: unknown) => JSON.stringify({ type, data });

describe("parseMessage", () => {
  it("skips binary preview frames before ever reaching JSON.parse", () => {
    // A preview image arrives as an ArrayBuffer with binaryType='arraybuffer'.
    // Feeding it to JSON.parse is the crash the skip exists to prevent.
    expect(parseMessage(new ArrayBuffer(8))).toBeNull();
    expect(parseMessage(new Uint8Array([0xff, 0xd8]).buffer)).toBeNull();
  });

  it("swallows a malformed text frame rather than throwing", () => {
    expect(parseMessage("{ not json")).toBeNull();
    expect(parseMessage("")).toBeNull();
  });

  it("reads a progress event with its value, max, and node", () => {
    const event = parseMessage(
      frame("progress", { value: 3, max: 20, node: "10", prompt_id: "abc" }),
    );
    expect(event).toEqual<EngineEvent>({
      kind: "progress",
      promptId: "abc",
      node: "10",
      value: 3,
      max: 20,
    });
  });

  it("drops a progress event missing its numbers", () => {
    expect(parseMessage(frame("progress", { node: "10" }))).toBeNull();
  });

  it("keeps an executing event whose node is null — that is completion", () => {
    expect(parseMessage(frame("executing", { node: null, prompt_id: "abc" }))).toEqual<EngineEvent>(
      {
        kind: "executing",
        promptId: "abc",
        node: null,
      },
    );
  });

  it("carries the node while one is running", () => {
    expect(parseMessage(frame("executing", { node: "6", prompt_id: "abc" }))).toEqual<EngineEvent>({
      kind: "executing",
      promptId: "abc",
      node: "6",
    });
  });

  it("rejects a malformed executing.node rather than forging a completion", () => {
    // A missing/numeric/boolean node must not be coerced to null — that null is
    // the "queue drained" signal, so coercion would fake a finish the engine
    // never sent.
    expect(parseMessage(frame("executing", { prompt_id: "abc" }))).toBeNull();
    expect(parseMessage(frame("executing", { node: 6, prompt_id: "abc" }))).toBeNull();
    expect(parseMessage(frame("executing", { node: false, prompt_id: "abc" }))).toBeNull();
  });

  it("surfaces the failing node and message from execution_error", () => {
    const event = parseMessage(
      frame("execution_error", {
        prompt_id: "abc",
        node_id: "6",
        node_type: "KSampler",
        exception_message: "OOM: not enough VRAM",
        traceback: ["Traceback:", "  line 1"],
      }),
    );
    expect(event).toEqual<EngineEvent>({
      kind: "error",
      promptId: "abc",
      error: {
        nodeId: "6",
        nodeType: "KSampler",
        message: "OOM: not enough VRAM",
        traceback: ["Traceback:", "  line 1"],
      },
    });
  });

  it("ignores the frames the skeleton does not act on", () => {
    expect(parseMessage(frame("status", { status: { exec_info: {} } }))).toBeNull();
    expect(parseMessage(frame("executed", { node: "9", output: {} }))).toBeNull();
    expect(parseMessage(frame("execution_cached", { nodes: ["1"] }))).toBeNull();
  });
});

describe("outputsFromHistory", () => {
  it("flattens image refs across every node of the prompt", () => {
    const history = {
      abc: {
        outputs: {
          "9": {
            images: [
              { filename: "ComfyUI_00001_.png", subfolder: "", type: "output" },
              { filename: "ComfyUI_00002_.png", subfolder: "batch", type: "output" },
            ],
          },
        },
      },
    };
    expect(outputsFromHistory(history, "abc")).toEqual([
      { filename: "ComfyUI_00001_.png", subfolder: "", type: "output" },
      { filename: "ComfyUI_00002_.png", subfolder: "batch", type: "output" },
    ]);
  });

  it("returns nothing for a prompt still running (no history entry yet)", () => {
    expect(outputsFromHistory({}, "abc")).toEqual([]);
    expect(outputsFromHistory({ other: { outputs: {} } }, "abc")).toEqual([]);
  });

  it("defaults a missing subfolder to empty and skips malformed entries", () => {
    const history = {
      abc: {
        outputs: {
          "9": { images: [{ filename: "a.png", type: "output" }, { nope: true }] },
          "10": { images: "not an array" },
        },
      },
    };
    expect(outputsFromHistory(history, "abc")).toEqual([
      { filename: "a.png", subfolder: "", type: "output" },
    ]);
  });

  it("flattens video refs reported under `gifs`, not just `images`", () => {
    // Video nodes (SaveAnimatedWEBP, VHS_VideoCombine) report the identical ref
    // shape under `gifs` — the ltx-video registry path depends on this (#15).
    const history = {
      abc: {
        outputs: {
          "41": { gifs: [{ filename: "darkroom_00001_.webp", subfolder: "", type: "output" }] },
        },
      },
    };
    expect(outputsFromHistory(history, "abc")).toEqual([
      { filename: "darkroom_00001_.webp", subfolder: "", type: "output" },
    ]);
  });

  it("collects both `images` and `gifs` when a history carries each", () => {
    const history = {
      abc: {
        outputs: {
          "9": { images: [{ filename: "still.png", subfolder: "", type: "output" }] },
          "41": { gifs: [{ filename: "clip.webp", subfolder: "", type: "output" }] },
        },
      },
    };
    expect(outputsFromHistory(history, "abc")).toEqual([
      { filename: "still.png", subfolder: "", type: "output" },
      { filename: "clip.webp", subfolder: "", type: "output" },
    ]);
  });
});

describe("ComfyClient", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("uses the same id on the socket query and the prompt body", () => {
    const client = new ComfyClient(51234, "fixed-id");
    // The whole point of a single owner: the value the socket would send and the
    // value submit sends are one string, so they can't drift.
    expect(client.clientId).toBe("fixed-id");
  });

  it("sends the workflow and client_id to /prompt and returns the prompt_id", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ prompt_id: "p-1", number: 1, node_errors: {} }), {
        status: 200,
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const client = new ComfyClient(51234, "fixed-id");
    const promptId = await client.submit({ "3": { class_type: "KSampler", inputs: {} } });

    expect(promptId).toBe("p-1");
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("http://127.0.0.1:51234/prompt");
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.client_id).toBe("fixed-id");
    expect(body.prompt).toEqual({ "3": { class_type: "KSampler", inputs: {} } });
  });

  it("throws PromptRejected naming the failing node on a 400", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          error: { message: "Prompt has no properly connected outputs" },
          node_errors: {
            "6": {
              class_type: "KSampler",
              errors: [{ message: "Required input is missing: model" }],
            },
          },
        }),
        { status: 400 },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const client = new ComfyClient(51234);
    const err = await client.submit({}).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(PromptRejected);
    const rejected = err as PromptRejected;
    expect(rejected.nodeErrors).toHaveProperty("6");
    expect(rejected.message).toContain("node 6");
    expect(rejected.message).toContain("KSampler");
    expect(rejected.message).toContain("Required input is missing: model");
  });

  it("keeps the response body when the error is not the expected JSON, not just the status", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response("Internal Server Error: CUDA out of memory", { status: 500 }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const client = new ComfyClient(51234);
    const err = (await client.submit({}).catch((e: unknown) => e)) as PromptRejected;

    expect(err).toBeInstanceOf(PromptRejected);
    expect(err.message).toContain("500");
    // The body carried the real reason; a bare status would have thrown it away.
    expect(err.message).toContain("CUDA out of memory");
    expect(err.nodeErrors).toEqual({});
  });

  it("reads outputs back from /history", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          "p-1": {
            outputs: { "9": { images: [{ filename: "out.png", subfolder: "", type: "output" }] } },
          },
        }),
        { status: 200 },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const client = new ComfyClient(51234);
    const outputs = await client.history("p-1");

    expect(fetchMock.mock.calls[0][0]).toBe("http://127.0.0.1:51234/history/p-1");
    expect(outputs).toEqual([{ filename: "out.png", subfolder: "", type: "output" }]);
  });

  it("builds a /view URL that survives spaces and ampersands in the filename", () => {
    const client = new ComfyClient(51234);
    const url = client.viewUrl({ filename: "a b&c.png", subfolder: "sub dir", type: "output" });

    const parsed = new URL(url);
    expect(parsed.origin).toBe("http://127.0.0.1:51234");
    expect(parsed.pathname).toBe("/view");
    expect(parsed.searchParams.get("filename")).toBe("a b&c.png");
    expect(parsed.searchParams.get("subfolder")).toBe("sub dir");
    expect(parsed.searchParams.get("type")).toBe("output");
  });

  it("reads VRAM back from /system_stats", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          devices: [{ name: "cuda:0", type: "cuda", vram_total: 25_757_220_864 }],
        }),
        { status: 200 },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const client = new ComfyClient(51234);
    const vram = await client.systemStats();

    expect(fetchMock.mock.calls[0][0]).toBe("http://127.0.0.1:51234/system_stats");
    expect(vram).toBe(25_757_220_864);
  });

  it("throws an actionable error when /system_stats is not ok", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("", { status: 500 })));

    const client = new ComfyClient(51234);
    await expect(client.systemStats()).rejects.toThrow(/HTTP 500/);
  });

  it("POSTs /interrupt to cancel the running prompt", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const client = new ComfyClient(51234);
    await client.interrupt();

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("http://127.0.0.1:51234/interrupt");
    expect((init as RequestInit).method).toBe("POST");
  });

  it("throws when /interrupt is not ok, so a failed cancel is not silent", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("", { status: 500 })));

    const client = new ComfyClient(51234);
    await expect(client.interrupt()).rejects.toThrow(/HTTP 500/);
  });
});

describe("vramTotalFromStats", () => {
  it("returns the GPU's vram_total in bytes", () => {
    expect(vramTotalFromStats({ devices: [{ type: "cuda", vram_total: 25_757_220_864 }] })).toBe(
      25_757_220_864,
    );
  });

  it("skips the cpu device, whose vram_total is really system RAM", () => {
    // A GPU-less box reports a single cpu device carrying the machine's RAM as
    // vram_total; counting it would wave every model through — the OOM gating
    // exists to prevent.
    expect(
      vramTotalFromStats({ devices: [{ type: "cpu", vram_total: 64_000_000_000 }] }),
    ).toBeNull();
  });

  it("takes the largest GPU when several are present", () => {
    expect(
      vramTotalFromStats({
        devices: [
          { type: "cuda", vram_total: 8_000_000_000 },
          { type: "cuda", vram_total: 24_000_000_000 },
        ],
      }),
    ).toBe(24_000_000_000);
  });

  it("returns null for a stats body with no devices array", () => {
    expect(vramTotalFromStats({})).toBeNull();
    expect(vramTotalFromStats(null)).toBeNull();
    expect(vramTotalFromStats({ devices: "nope" })).toBeNull();
  });

  it("ignores a device missing or misreporting vram_total", () => {
    expect(
      vramTotalFromStats({ devices: [{ type: "cuda" }, { type: "cuda", vram_total: "lots" }] }),
    ).toBeNull();
  });
});

/**
 * The socket half of the mismatch trap: it is not enough that `clientId` is the
 * right *value* — `connect()` must put it on the wire as `clientId`, the exact
 * query param ComfyUI reads. A mock WebSocket captures the URL and lets us drive
 * frames through the real message handler. (Replaying *recorded* engine traffic
 * is #22's mock-engine job; these hand-written frames only pin the wiring.)
 */
describe("ComfyClient.connect", () => {
  class MockWebSocket {
    static last: MockWebSocket | undefined;
    url: string;
    binaryType = "";
    readonly listeners: Record<string, ((ev: unknown) => void)[]> = {};
    closed = false;

    constructor(url: string) {
      this.url = url;
      MockWebSocket.last = this;
    }
    addEventListener(type: string, cb: (ev: unknown) => void) {
      (this.listeners[type] ??= []).push(cb);
    }
    close() {
      this.closed = true;
      this.emit("close", {});
    }
    emit(type: string, ev: unknown) {
      for (const cb of this.listeners[type] ?? []) cb(ev);
    }
  }

  afterEach(() => {
    vi.unstubAllGlobals();
    MockWebSocket.last = undefined;
  });

  it("sends the client id as the clientId query param and reads binary as ArrayBuffer", () => {
    vi.stubGlobal("WebSocket", MockWebSocket);

    new ComfyClient(51234, "fixed-id").connect({ onEvent: () => {} });

    const ws = MockWebSocket.last!;
    // The socket's clientId must equal what submit() sends as client_id.
    expect(ws.url).toBe("ws://127.0.0.1:51234/ws?clientId=fixed-id");
    // arraybuffer is what makes a preview frame a non-string parseMessage skips.
    expect(ws.binaryType).toBe("arraybuffer");
  });

  it("routes parsed frames to onEvent and drops binary and unmodelled ones", () => {
    vi.stubGlobal("WebSocket", MockWebSocket);
    const events: EngineEvent[] = [];
    new ComfyClient(51234, "fixed-id").connect({ onEvent: (e) => events.push(e) });

    const ws = MockWebSocket.last!;
    ws.emit("message", {
      data: frame("progress", { value: 1, max: 4, node: "3", prompt_id: "p" }),
    });
    ws.emit("message", { data: new ArrayBuffer(8) }); // preview — dropped
    ws.emit("message", { data: frame("status", { status: {} }) }); // unmodelled — dropped
    ws.emit("message", { data: frame("executing", { node: null, prompt_id: "p" }) });

    expect(events).toEqual<EngineEvent[]>([
      { kind: "progress", promptId: "p", node: "3", value: 1, max: 4 },
      { kind: "executing", promptId: "p", node: null },
    ]);
  });

  it("resolves opened on open and reports close through the handler", async () => {
    vi.stubGlobal("WebSocket", MockWebSocket);
    let closed = false;
    const socket = new ComfyClient(51234, "fixed-id").connect({
      onEvent: () => {},
      onClose: () => (closed = true),
    });

    const ws = MockWebSocket.last!;
    ws.emit("open", {});
    await expect(socket.opened).resolves.toBeUndefined();

    socket.close();
    expect(ws.closed).toBe(true);
    expect(closed).toBe(true);
  });
});
