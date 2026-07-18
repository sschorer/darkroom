/**
 * Walking skeleton. Deliberately almost nothing — #11 is the first issue that
 * makes this window generate anything, and #31 is the visual pass.
 *
 * The setup button exists because #4's done-criterion is "cold machine to
 * working ComfyUI", and nothing can demonstrate that if nothing invokes it. It
 * is not the onboarding flow (#29) — that's out of scope here — but the
 * ten-minute wait now shows what it's doing (#5), which is the difference
 * between "working" and "hung" (Q2).
 */
import { useCallback, useEffect, useState } from "react";

import {
  bootstrapEngine,
  engineStatus,
  onEngineProgress,
  type EngineProgress,
  type EngineStatus,
} from "./lib/engine";
import { formatBytes } from "./lib/format";
import { generate, type GenerateProgress } from "./lib/generate";

type View =
  | { phase: "checking" }
  | { phase: "idle"; status: EngineStatus }
  // `progress` is null until the first event arrives — the download's opening
  // moments, where "Setting up…" is all there is to say.
  | { phase: "installing"; progress: EngineProgress | null }
  // `retry` carries the action that failed, so "Try again" re-runs *that* — a
  // status-check failure re-checks; an install failure re-installs. Without it
  // a failed boot check would offer a button that starts a ten-minute install.
  | { phase: "failed"; error: string; retry: () => void };

export default function App() {
  const [view, setView] = useState<View>({ phase: "checking" });

  const check = useCallback(async () => {
    try {
      setView({ phase: "idle", status: await engineStatus() });
    } catch (e) {
      setView({ phase: "failed", error: String(e), retry: () => void check() });
    }
  }, []);

  // §8.2: the engine track is checked at boot, and version skew blocks
  // generation until it's resolved.
  useEffect(() => {
    void check();
  }, [check]);

  const install = useCallback(async () => {
    setView({ phase: "installing", progress: null });

    try {
      // Subscribe before invoking: the events fire during the command, which
      // resolves only at the very end. Inside the try so a `listen()` that
      // itself rejects lands on the failed view like any other setup error —
      // outside it, that rejection would throw past the caller's `void
      // install()` and leave "installing" on screen forever, the exact hang
      // this feature exists to kill. The functional update ignores events that
      // arrive after we've left the installing phase (a late one racing a
      // failure).
      const unlisten = await onEngineProgress((p) =>
        setView((v) => (v.phase === "installing" ? { phase: "installing", progress: p } : v)),
      );
      try {
        await bootstrapEngine();
        await check();
      } finally {
        unlisten();
      }
    } catch (e) {
      // Already actionable: the Rust side puts the uv log tail in the message
      // (§8.6). Rendering it verbatim is the point, so it stays pre-wrapped.
      setView({ phase: "failed", error: String(e), retry: () => void install() });
    }
  }, [check]);

  return (
    <main className="mx-auto flex h-full max-w-2xl flex-col items-center justify-center gap-4 p-8">
      <h1 className="text-2xl font-semibold tracking-tight">Darkroom</h1>
      <p className="text-sm text-neutral-400">Generate images and video on your own GPU.</p>

      <Engine view={view} onInstall={() => void install()} />

      {/* The gate (#11): once the engine is installed, one prompt, one image.
          Deliberately spare — #31 is the visual pass, M1 makes models data.
          Gated on CUDA: the Engine note above says non-CUDA generation is
          unusably slow and unsupported (Q5, TD-2), so offering the button there
          would contradict it and hand the user a 20-minute render. */}
      {view.phase === "idle" &&
        view.status.state === "ready" &&
        view.status.installed.accelerator === "cuda" && <Generate />}
    </main>
  );
}

/**
 * The walking-skeleton generator: a prompt, a button, an image (#11). No model
 * choice, no history, no cancel — those are later. It exists to prove the
 * engine→client→pixels path end to end on the developer's own GPU, which is the
 * milestone gate this whole M0 leads to.
 */
type GenState =
  | { phase: "idle" }
  // `progress` is null from the click until the first sampling event — a window
  // that includes a cold engine start (up to 120s), so the label must not imply
  // sampling has begun.
  | { phase: "generating"; progress: GenerateProgress | null }
  | { phase: "done"; imageUrl: string }
  | { phase: "failed"; error: string };

function Generate() {
  const [prompt, setPrompt] = useState("a photo of a cat wearing a tiny hat, studio lighting");
  const [state, setState] = useState<GenState>({ phase: "idle" });

  // The image is a blob: URL the browser holds until revoked; leaving old ones
  // unrevoked leaks memory across generations. Revoke on replacement and unmount.
  const imageUrl = state.phase === "done" ? state.imageUrl : null;
  useEffect(() => {
    return () => {
      if (imageUrl) URL.revokeObjectURL(imageUrl);
    };
  }, [imageUrl]);

  const run = useCallback(() => {
    setState({ phase: "generating", progress: null });
    void (async () => {
      try {
        const url = await generate(prompt, (p) =>
          // Ignore progress that arrives after we've left the generating phase.
          setState((s) => (s.phase === "generating" ? { phase: "generating", progress: p } : s)),
        );
        setState({ phase: "done", imageUrl: url });
      } catch (e) {
        setState({ phase: "failed", error: String(e) });
      }
    })();
  }, [prompt]);

  const busy = state.phase === "generating";

  return (
    <section className="mt-6 flex w-full max-w-md flex-col items-center gap-3">
      <textarea
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        disabled={busy}
        rows={3}
        className="w-full resize-none rounded bg-neutral-900 p-3 text-sm text-neutral-100 disabled:opacity-50"
      />
      <Button onClick={run} disabled={busy || prompt.trim() === ""}>
        {busy ? "Generating…" : "Generate"}
      </Button>

      {state.phase === "generating" && <GenProgress progress={state.progress} />}

      {state.phase === "failed" && (
        <pre className="max-h-60 w-full overflow-auto whitespace-pre-wrap rounded bg-neutral-900 p-3 text-left text-xs text-red-300">
          {state.error}
        </pre>
      )}

      {state.phase === "done" && (
        <img src={state.imageUrl} alt={prompt} className="w-full rounded" />
      )}
    </section>
  );
}

/** Sampling progress: a byte-less bar once the engine reports steps, a plain
 * line before that (which spans the cold engine start). */
function GenProgress({ progress }: { progress: GenerateProgress | null }) {
  if (!progress) {
    return <Note>Starting the engine and queuing the prompt…</Note>;
  }
  return (
    <div className="flex w-full flex-col items-center gap-1">
      <Bar received={progress.value} total={progress.max} />
      <p className="text-xs tabular-nums text-neutral-500">
        step {progress.value} of {progress.max}
      </p>
    </div>
  );
}

function Engine({ view, onInstall }: { view: View; onInstall: () => void }) {
  if (view.phase === "checking") {
    return <Note>Checking the engine…</Note>;
  }

  if (view.phase === "installing") {
    return <Progress progress={view.progress} />;
  }

  if (view.phase === "failed") {
    return (
      <>
        <pre className="max-h-80 w-full overflow-auto whitespace-pre-wrap rounded bg-neutral-900 p-3 text-left text-xs text-red-300">
          {view.error}
        </pre>
        <Button onClick={view.retry}>Try again</Button>
      </>
    );
  }

  const { status } = view;

  if (status.state === "ready") {
    const { accelerator, torch, comfy_sha } = status.installed;
    return (
      <>
        <Note>
          Engine ready — ComfyUI {comfy_sha.slice(0, 7)}, torch {torch}, running on{" "}
          {accelerator.toUpperCase()}.
        </Note>
        {/* Q5: never pretend the hardware is something it isn't. A CPU install
            is correct and unusable, and saying so beats a 20-minute render. */}
        {accelerator !== "cuda" && (
          <Note tone="warn">
            No CUDA device found, so generation would fall back to {accelerator.toUpperCase()} and
            be unusably slow. Only NVIDIA GPUs are supported (TD-2).
          </Note>
        )}
        <span className="mt-2 h-2 w-2 rounded-full bg-[var(--color-safelight)]" />
      </>
    );
  }

  return (
    <>
      <Note>
        {status.state === "stale"
          ? `The installed engine is from an older version of Darkroom. It needs reinstalling before anything can generate.`
          : `The engine isn't installed yet. Setup downloads ComfyUI and PyTorch — about 6GB, roughly ten minutes.`}
      </Note>
      <Button onClick={onInstall}>
        {status.state === "stale" ? "Update engine" : "Set up engine"}
      </Button>
    </>
  );
}

/**
 * The ten-minute wait, made legible (#5). Three signals, in order of how much
 * the user needs them: a plain-language phase line, a byte bar while the
 * tarball downloads, and uv's own latest line so the long install phase reads
 * as motion rather than a freeze.
 */
function Progress({ progress }: { progress: EngineProgress | null }) {
  return (
    <div className="flex w-full max-w-md flex-col items-center gap-3">
      <Note>{phaseLabel(progress)}</Note>

      {progress?.phase === "downloading" && (
        <>
          <Bar received={progress.received} total={progress.total} />
          <p className="text-xs tabular-nums text-neutral-500">
            {formatBytes(progress.received)}
            {progress.total != null && ` of ${formatBytes(progress.total)}`}
          </p>
        </>
      )}

      {progress?.phase === "installing" && progress.line && (
        // The raw uv line. Monospace and single-line so a torch-wheel path
        // that runs long clips rather than reflowing the layout on every event.
        // Skipped while empty — the phase is announced the instant uv spawns,
        // before it has said anything, and an empty line would just add a gap.
        <p className="w-full truncate text-center font-mono text-xs text-neutral-500">
          {progress.line}
        </p>
      )}
    </div>
  );
}

/** A determinate bar when the total is known, an indeterminate shimmer when not. */
function Bar({ received, total }: { received: number; total: number | null }) {
  const pct = total != null && total > 0 ? Math.min(100, (received / total) * 100) : null;
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-neutral-800">
      <div
        className={`h-full bg-neutral-100 transition-[width] duration-200 ${pct == null ? "w-1/3 animate-pulse" : ""}`}
        style={pct == null ? undefined : { width: `${pct}%` }}
      />
    </div>
  );
}

/** The one line that always shows, whether or not an event has arrived yet. */
function phaseLabel(progress: EngineProgress | null): string {
  switch (progress?.phase) {
    case undefined:
      // Before the first event: the command is invoked, the download not yet open.
      return "Setting up the engine — about 6GB, roughly ten minutes.";
    case "downloading":
      return "Downloading ComfyUI…";
    case "unpacking":
      return "Unpacking ComfyUI…";
    case "installing":
      return `${capitalize(progress.step)}…`;
    case "verifying":
      return "Verifying the install…";
  }
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function Note({ children, tone }: { children: React.ReactNode; tone?: "warn" }) {
  return (
    <p className={`text-center text-sm ${tone === "warn" ? "text-amber-400" : "text-neutral-400"}`}>
      {children}
    </p>
  );
}

function Button({
  children,
  onClick,
  disabled,
}: {
  children: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className="rounded bg-neutral-100 px-4 py-2 text-sm font-medium text-neutral-900 hover:bg-white disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-neutral-100"
    >
      {children}
    </button>
  );
}
