import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ComfyClient,
  outputsFromHistory,
  parseMessage,
  PromptRejected,
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

  it("degrades to the bare status when the error body is not the expected JSON", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response("<html>502 Bad Gateway</html>", { status: 502 }));
    vi.stubGlobal("fetch", fetchMock);

    const client = new ComfyClient(51234);
    const err = (await client.submit({}).catch((e: unknown) => e)) as PromptRejected;

    expect(err).toBeInstanceOf(PromptRejected);
    expect(err.message).toContain("502");
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
});
