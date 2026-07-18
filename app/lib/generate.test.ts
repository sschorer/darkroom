/**
 * Integration tests for {@link generate}, against a mock engine (no ComfyUI, no
 * GPU — ADR-010). They drive the real {@link ComfyClient} over a fake WebSocket
 * and a fake `fetch`, exercising the paths the coding guidelines name: progress
 * events, the prompt-specific `executing {node: null}` completion, a socket that
 * closes mid-run, and a `/prompt` 400 carrying `node_errors`. The subtle one is
 * events that arrive *before* `submit()` resolves — the buffering that keeps a
 * fast run's completion from being lost.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// startEngine crosses IPC to Rust; here it just hands back a port.
vi.mock("./engine", () => ({ startEngine: vi.fn(async () => 8188) }));

import { generate } from "./generate";

/** A WebSocket stand-in the test drives by hand. */
class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  binaryType = "";
  private listeners: Record<string, ((ev: unknown) => void)[]> = {};

  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this);
  }
  addEventListener(type: string, cb: (ev: unknown) => void) {
    (this.listeners[type] ??= []).push(cb);
  }
  close() {
    this.fire("close", {});
  }
  private fire(type: string, ev: unknown) {
    for (const cb of this.listeners[type] ?? []) cb(ev);
  }

  // --- test drivers ---
  open() {
    this.fire("open", {});
  }
  send(msg: unknown) {
    this.fire("message", { data: JSON.stringify(msg) });
  }
  die() {
    this.fire("close", {});
  }
  error() {
    // The event the WebSocket raises when it can't connect — ComfyClient's
    // `opened` promise rejects on this.
    this.fire("error", new Event("error"));
  }
}

const flush = () => new Promise((r) => setTimeout(r, 0));
const socket = () => FakeWebSocket.instances.at(-1)!;

/** A minimal `Response` supporting the methods ComfyClient/fetchAsBlobUrl use. */
function jsonRes(body: unknown, ok = true, status = 200) {
  const text = JSON.stringify(body);
  return { ok, status, json: async () => body, text: async () => text } as Response;
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  FakeWebSocket.instances = [];
  vi.stubGlobal("WebSocket", FakeWebSocket);
  vi.stubGlobal("URL", Object.assign(URL, { createObjectURL: vi.fn(() => "blob:mock-url") }));

  // Default: a well-behaved engine. Individual tests override.
  fetchMock = vi.fn(async (input: string | URL) => {
    const url = String(input);
    if (url.includes("/prompt")) return jsonRes({ prompt_id: "P1" });
    if (url.includes("/history/")) {
      return jsonRes({
        P1: { outputs: { "9": { images: [{ filename: "darkroom_1_.png", subfolder: "", type: "output" }] } } },
      });
    }
    if (url.includes("/view")) return { ok: true, status: 200, blob: async () => new Blob(["x"]) } as Response;
    throw new Error(`unexpected fetch: ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("generate", () => {
  it("returns a blob URL and reports progress, with events arriving before submit resolves", async () => {
    const onProgress = vi.fn();
    const p = generate("a cat", onProgress);

    await flush(); // startEngine + connect: the socket now exists
    socket().open();
    // These land while submit()'s POST is in flight — they must be buffered,
    // then replayed once the prompt id is known, not dropped.
    socket().send({ type: "progress", data: { value: 2, max: 4, prompt_id: "P1" } });
    socket().send({ type: "executing", data: { node: null, prompt_id: "P1" } });

    await expect(p).resolves.toBe("blob:mock-url");
    expect(onProgress).toHaveBeenCalledWith({ value: 2, max: 4 });
    // The /prompt body carried our client id (the trap ComfyClient guards).
    const promptCall = fetchMock.mock.calls.find(([u]) => String(u).includes("/prompt"));
    expect(JSON.parse((promptCall![1] as RequestInit).body as string).client_id).toBeTypeOf("string");
  });

  it("ignores an idle-queue notice that arrives before our prompt runs", async () => {
    const p = generate("a cat", vi.fn());
    await flush();
    socket().open();
    // A null-node executing with *no* prior evidence of our prompt must not
    // forge completion; only after a real progress/executing does the next one.
    socket().send({ type: "executing", data: { node: null, prompt_id: "P1" } });
    socket().send({ type: "progress", data: { value: 1, max: 4, prompt_id: "P1" } });
    socket().send({ type: "executing", data: { node: null, prompt_id: "P1" } });

    await expect(p).resolves.toBe("blob:mock-url");
  });

  it("rejects with node diagnostics when /prompt returns 400 + node_errors", async () => {
    fetchMock.mockImplementation(async (input: string | URL) => {
      if (String(input).includes("/prompt")) {
        return jsonRes(
          { error: { message: "validation failed" }, node_errors: { "10": { class_type: "UNETLoader", errors: [{ message: "Value not in list" }] } } },
          false,
          400,
        );
      }
      throw new Error("should not reach history/view on a rejected prompt");
    });

    const p = generate("a cat", vi.fn());
    await flush();
    socket().open();

    await expect(p).rejects.toThrow(/UNETLoader|Value not in list|validation failed/);
  });

  it("rejects when the engine closes the socket before finishing", async () => {
    const p = generate("a cat", vi.fn());
    await flush();
    socket().open();
    socket().send({ type: "progress", data: { value: 1, max: 4, prompt_id: "P1" } });
    socket().die(); // engine crashes mid-sample

    await expect(p).rejects.toThrow(/closed the connection/);
  });

  it("rejects with a readable message when the socket never opens", async () => {
    const p = generate("a cat", vi.fn());
    await flush();
    socket().error(); // the WebSocket raised its error event instead of opening

    await expect(p).rejects.toThrow(/could not open the progress socket/);
  });
});
