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
    </main>
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

      {progress?.phase === "installing" && (
        // The raw uv line. Monospace and single-line so a torch-wheel path
        // that runs long clips rather than reflowing the layout on every event.
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

function Button({ children, onClick }: { children: React.ReactNode; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="rounded bg-neutral-100 px-4 py-2 text-sm font-medium text-neutral-900 hover:bg-white"
    >
      {children}
    </button>
  );
}
