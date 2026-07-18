/**
 * A mock ComfyUI engine that **replays a recorded session** (#22).
 *
 * ADR-010: the engine boundary can only ever be tested against a mock — CI has
 * no GPU, and self-hosted GPU runners would execute fork code on our hardware.
 * So the boundary's tests can't drive a real engine; they drive this. The one
 * rule ADR-010 sets for that mock is that it must be built from *recorded*
 * traffic, not hand-written frames: ComfyUI has no API contract (RISK-1) and its
 * WebSocket message shapes are undocumented, so a frame you invent encodes your
 * assumption of its behaviour rather than the behaviour. Fixtures under
 * `__fixtures__/comfy/` carry the real shapes (see that dir's README for how
 * they're captured with `scripts/record-comfy.mjs`); this module replays one.
 *
 * It replaces the two globals the real client reaches for — `fetch` (the
 * HTTP half: `/prompt`, `/history`, `/system_stats`, `/view`) and `WebSocket`
 * (the progress stream) — with stand-ins fed entirely from the fixture. The
 * real {@link ComfyClient} and {@link generate} then run against it unchanged,
 * exactly as they would against a live engine, minus the pixels.
 *
 * What this is *not*: a re-implementation of ComfyUI. It answers only the four
 * routes the client calls and streams only the frames the recording captured,
 * in the order it captured them. A scenario the fixture didn't record is a
 * scenario this can't serve — by design, so a test can't pass against traffic no
 * engine ever produced.
 */

/** One WebSocket frame as the recorder stored it: a text message or a binary blob. */
export type RecordedFrame =
  /**
   * A JSON text frame, stored parsed for readability. ComfyUI frames the wire as
   * `{"type", "data"}` and the client is whitespace-insensitive (it `JSON.parse`s
   * before acting), so storing the object and re-stringifying on replay preserves
   * every key and value — the part that matters — while keeping the fixture
   * diff-able. The `type`/`data` split is ComfyUI's own (`server.py` send_json).
   */
  | { message: { type: string; data?: unknown }; binary?: undefined }
  /**
   * A binary preview frame, stored as its byte length only. The client's sole
   * question of a binary frame is "is it a string?" (no — it's dropped before
   * `JSON.parse`, {@link parseMessage}), so the bytes themselves carry no test
   * signal; the length round-trips a faithful `ArrayBuffer` without bloating the
   * fixture with a base64 JPEG.
   */
  | { binary: number; message?: undefined };

/** One recorded HTTP response: the status and the JSON body the engine returned. */
export interface RecordedResponse {
  status: number;
  body: unknown;
}

/** A recorded session: the HTTP responses and the ordered WebSocket frames. */
export interface Fixture {
  meta: {
    scenario: string;
    clientId: string;
    promptId: string | null;
    [key: string]: unknown;
  };
  http: {
    prompt: RecordedResponse;
    history: RecordedResponse;
    systemStats: RecordedResponse;
  };
  frames: RecordedFrame[];
}

/** The globals this mock replaces, saved so {@link MockEngine.restore} can undo it. */
interface Saved {
  fetch: typeof globalThis.fetch;
  WebSocket: typeof globalThis.WebSocket;
}

/**
 * A WebSocket stand-in that replays a fixture's frames. Constructed by the real
 * {@link ComfyClient.connect}, it schedules `open` and then the recorded frames
 * onto a single macrotask so every `addEventListener` the client registers
 * synchronously is in place before the first event fires — the same guarantee a
 * real socket gives (events can't arrive before you've finished subscribing).
 *
 * Frames replay in one burst rather than spread over timers: the client buffers
 * events that arrive before `submit()` resolves ({@link generate}), so a burst
 * genuinely exercises that buffering, and it stays deterministic without fake
 * timers. `close()` fires `close`, which is how the client learns the engine
 * dropped the connection.
 */
class ReplaySocket {
  binaryType = "";
  private readonly listeners: Record<string, ((ev: unknown) => void)[]> = {};
  private closed = false;

  constructor(
    readonly url: string,
    private readonly frames: RecordedFrame[],
  ) {
    setTimeout(() => this.play(), 0);
  }

  addEventListener(type: string, cb: (ev: unknown) => void) {
    (this.listeners[type] ??= []).push(cb);
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.emit("close", {});
  }

  private play() {
    if (this.closed) return;
    this.emit("open", {});
    for (const frame of this.frames) {
      if (this.closed) return; // a handler closed us mid-stream — stop, as a real socket would.
      this.emit("message", { data: frameData(frame) });
    }
  }

  private emit(type: string, ev: unknown) {
    for (const cb of this.listeners[type] ?? []) cb(ev);
  }
}

/** Turns a recorded frame into the `MessageEvent.data` the client parses. */
function frameData(frame: RecordedFrame): string | ArrayBuffer {
  return frame.message !== undefined
    ? JSON.stringify(frame.message)
    : new ArrayBuffer(frame.binary);
}

/**
 * Installs a fixture as the engine the real client talks to. `install()` swaps
 * in the stub `fetch`/`WebSocket`; `restore()` puts the originals back (call it
 * in `afterEach`). One instance serves one recorded session.
 *
 * The fetch stub routes by the path the client builds, and serves `/view` as an
 * opaque blob (the recording holds no pixels; the client only needs bytes to
 * wrap in a `blob:` URL). Anything the fixture didn't record throws, so a test
 * can't accidentally lean on a route no recording covers.
 */
export class MockEngine {
  private saved: Saved | null = null;

  constructor(private readonly fixture: Fixture) {}

  /** Replaces `globalThis.fetch` and `globalThis.WebSocket` with fixture-backed stubs. */
  install(): this {
    this.saved = { fetch: globalThis.fetch, WebSocket: globalThis.WebSocket };
    globalThis.fetch = this.fetch as typeof globalThis.fetch;
    // The stub isn't the full WebSocket type; the client uses only the surface
    // ReplaySocket implements, so the cast is the honest description of that.
    globalThis.WebSocket = ReplaySocketFor(
      this.fixture.frames,
    ) as unknown as typeof globalThis.WebSocket;
    return this;
  }

  /** Restores the globals `install()` replaced. Safe to call if never installed. */
  restore() {
    if (!this.saved) return;
    globalThis.fetch = this.saved.fetch;
    globalThis.WebSocket = this.saved.WebSocket;
    this.saved = null;
  }

  /**
   * The recorded frames as the client would see them on the wire — text frames as
   * JSON strings, binary as `ArrayBuffer`. Exported for tests that drive
   * {@link parseMessage} over the raw stream directly, without a socket.
   */
  wireFrames(): (string | ArrayBuffer)[] {
    return this.fixture.frames.map(frameData);
  }

  private readonly fetch = async (input: string | URL | Request): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const { prompt, history, systemStats } = this.fixture.http;

    if (url.includes("/prompt")) return jsonResponse(prompt);
    if (url.includes("/history/")) return jsonResponse(history);
    if (url.includes("/system_stats")) return jsonResponse(systemStats);
    // No pixels in the recording — the client only wraps these bytes in a blob.
    if (url.includes("/view")) return new Response(new Blob(["PNG-mock"]), { status: 200 });

    throw new Error(`mock engine: no recorded response for ${url}`);
  };
}

/** A `WebSocket`-shaped constructor bound to one fixture's frames. */
function ReplaySocketFor(frames: RecordedFrame[]) {
  return class extends ReplaySocket {
    constructor(url: string) {
      super(url, frames);
    }
  };
}

/** Builds the `Response` for a recorded HTTP exchange. */
function jsonResponse({ status, body }: RecordedResponse): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
