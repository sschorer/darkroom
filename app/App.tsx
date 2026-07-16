/**
 * Walking skeleton. Deliberately almost nothing — #11 is the first issue that
 * makes this window generate anything, and #31 is the visual pass.
 *
 * The setup button exists because #4's done-criterion is "cold machine to
 * working ComfyUI", and nothing can demonstrate that if nothing invokes it. It
 * is not the onboarding flow (#29) and the ten-minute wait has no progress
 * behind it (#5) — both are deliberately out of scope here.
 */
import { useCallback, useEffect, useState } from "react";

import { bootstrapEngine, engineStatus, type EngineStatus } from "./lib/engine";

type View =
  | { phase: "checking" }
  | { phase: "idle"; status: EngineStatus }
  | { phase: "installing" }
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
    setView({ phase: "installing" });
    try {
      await bootstrapEngine();
      await check();
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
    return (
      <Note>
        Setting up the engine. This downloads about 6GB and takes roughly ten minutes — it will look
        frozen until it finishes (#5).
      </Note>
    );
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
