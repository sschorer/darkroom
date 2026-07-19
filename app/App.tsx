/**
 * The Studio shell (#53): the app is a three-screen surface — Setup, Studio,
 * Settings — inside the custom window chrome (#52).
 *
 * Routing is deliberately not a library. **Setup is not a place you navigate
 * to** — it is what the app *is* until the engine is ready, so it is derived
 * from the engine state rather than stored: you cannot open the Studio without
 * an engine to run it. The only user-driven navigation is Studio ⇄ Settings,
 * held in `nav`. This keeps "am I set up?" a single source of truth (the engine
 * status) instead of a screen flag that can disagree with it.
 *
 * The Studio's compose bar (#25) and gallery (#28) replace the walking-skeleton
 * generator that fills its main today; the Settings content (#30) and the
 * first-run onboarding that will supersede this bare Setup (#31) are later. This
 * issue owns the frame: the rail, the routing, and the way back.
 */
import { useCallback, useEffect, useState } from "react";

import { ComposeBar } from "./ComposeBar";
import { DownloadManager } from "./DownloadManager";
import { Rail } from "./Rail";
import { Settings } from "./Settings";
import { TitleBar } from "./TitleBar";
import {
  bootstrapEngine,
  engineStatus,
  onEngineProgress,
  openLogs,
  type Accelerator,
  type EngineProgress,
  type EngineStatus,
} from "./lib/engine";
import { formatBytes } from "./lib/format";
import { generate, type GenerateProgress } from "./lib/generate";
import { applyGate, readVram, resolveInstalled, type ModelChoice } from "./lib/models";
import { availableModels } from "./lib/registry";
import type { ModelStatus } from "./lib/download";

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
  // Studio ⇄ Settings only. Setup is derived below, never stored — it is the
  // absence of a ready engine, not a screen you toggle to.
  const [nav, setNav] = useState<"studio" | "settings">("studio");

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

  // The one source of truth for "which screen": a ready engine unlocks the
  // Studio (and, from there, Settings); anything short of ready is still Setup.
  const ready = view.phase === "idle" && view.status.state === "ready" ? view.status : null;
  const screen: "setup" | "studio" | "settings" = !ready ? "setup" : nav;

  // The mono titlebar subline is per-screen content (#52 left it empty pending
  // this issue). "128 outputs" mirrors the rail's static All-outputs count and
  // becomes a live total with the library (#28).
  const subtitle =
    screen === "settings" ? "settings" : screen === "setup" ? "first run" : "128 outputs";

  return (
    // The window shell (#52): the custom titlebar owns the top 44px; the active
    // screen fills the `bg-window` surface below it.
    <div className="flex h-full flex-col bg-window">
      <TitleBar subtitle={subtitle} />
      {screen === "setup" && <Setup view={view} onInstall={() => void install()} />}
      {screen === "studio" && ready && (
        <div className="flex min-h-0 flex-1">
          <Rail onOpenSettings={() => setNav("settings")} />
          <StudioMain accelerator={ready.installed.accelerator} />
        </div>
      )}
      {screen === "settings" && <Settings onBack={() => setNav("studio")} />}
    </div>
  );
}

/**
 * The Setup screen: the engine bootstrap made legible (#4, #5). Shown until the
 * engine is ready — the first-run onboarding that will supersede it (#31) is a
 * later, richer flow. Centred on the window surface, no rail.
 */
function Setup({ view, onInstall }: { view: View; onInstall: () => void }) {
  return (
    <main className="mx-auto flex w-full max-w-2xl flex-1 flex-col items-center justify-center gap-4 overflow-auto p-8">
      <h1 className="text-2xl font-semibold tracking-tight">Darkroom</h1>
      <p className="text-sm text-muted">Generate images and video on your own GPU.</p>
      <Engine view={view} onInstall={onInstall} />
    </main>
  );
}

/**
 * The Studio's main region: everything to the right of the rail. Its real
 * content is the gallery + selected preview (#28); until that lands, the
 * install list and the last generated image keep the engine→client→pixels path
 * visible inside the shell. The {@link ComposeBar} (#25) floats over it.
 *
 * This component is the orchestrator the bar reports to: it owns the resolved
 * model list, the selection, and the generation run. Selection lives here (not
 * in the bar) because generation needs the chosen model; the bar is the surface.
 */
function StudioMain({ accelerator }: { accelerator: Accelerator }) {
  // The offered models with their install state and — once the menu has been
  // opened — their VRAM verdict. `null` while the first resolve is in flight.
  const [choices, setChoices] = useState<ModelChoice[] | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // The VRAM total, read lazily the first time the model menu opens. `null` =
  // not yet read; `{ bytes }` = read (bytes may itself be null for no GPU).
  const [vram, setVram] = useState<{ bytes: number | null } | null>(null);
  const [prompt, setPrompt] = useState("a photo of a cat wearing a tiny hat, studio lighting");
  const [gen, setGen] = useState<GenState>({ phase: "idle" });

  // Re-resolve the offered models' install state (mount, and whenever a download
  // settles). Re-applies the VRAM gate if it's already known, so a model that
  // finished installing keeps its verdict. The default selection is the first
  // installed model, else the first offered — and a selection the user has since
  // made is preserved across refreshes.
  const loadChoices = useCallback(async () => {
    const installed = await resolveInstalled();
    const resolved = vram ? applyGate(installed, vram.bytes) : installed;
    setChoices(resolved);
    setSelectedId((current) => {
      if (current && resolved.some((c) => c.manifest.id === current)) return current;
      return (resolved.find((c) => c.installed) ?? resolved[0])?.manifest.id ?? null;
    });
  }, [vram]);

  useEffect(() => {
    void loadChoices();
  }, [loadChoices]);

  // Opening the menu is the first thing that genuinely needs the engine (for the
  // VRAM read behind the gating reasons), so it's deferred to here rather than
  // spawned on mount. Best-effort: if the read fails the models stay selectable
  // by their install state, just without a fit reason.
  const onMenuOpen = useCallback(() => {
    if (vram !== null) return;
    void (async () => {
      try {
        const bytes = await readVram();
        setVram({ bytes });
        setChoices((prev) => (prev ? applyGate(prev, bytes) : prev));
      } catch {
        // Leave the gate unresolved; installed models still generate.
      }
    })();
  }, [vram]);

  const selected = choices?.find((c) => c.manifest.id === selectedId) ?? null;

  // The image is a blob: URL the browser holds until revoked; leaving old ones
  // unrevoked leaks memory across generations. Revoke on replacement and unmount.
  const imageUrl = gen.phase === "done" ? gen.imageUrl : null;
  useEffect(() => {
    return () => {
      if (imageUrl) URL.revokeObjectURL(imageUrl);
    };
  }, [imageUrl]);

  const runGenerate = useCallback(() => {
    setGen({ phase: "generating", progress: null });
    void (async () => {
      try {
        const url = await generate(prompt, (p) =>
          // Ignore progress that arrives after we've left the generating phase.
          setGen((s) => (s.phase === "generating" ? { phase: "generating", progress: p } : s)),
        );
        setGen({ phase: "done", imageUrl: url });
      } catch (e) {
        setGen({ phase: "failed", error: String(e) });
      }
    })();
  }, [prompt]);

  // The bar's Generate is wired to the walking-skeleton path (#11), which is
  // hardcoded to FLUX.2 klein and ignores the params. So it's offered only for
  // an installed *image* model on CUDA — non-CUDA is unusably slow (Q5, TD-2)
  // and the skeleton can't render video. Per-model, per-param submission through
  // `buildWorkflow` is the queue (#27).
  const busy = gen.phase === "generating";
  const canGenerate =
    accelerator === "cuda" && !!selected?.installed && selected.manifest.kind === "image";

  return (
    <main className="relative flex min-w-0 flex-1 flex-col overflow-hidden">
      <div className="flex flex-1 flex-col items-center gap-4 overflow-auto p-8 pb-[120px]">
        {/* The install list (#21): until the Settings model manager (#30), this
            is how a model's weights get onto disk. The compose bar selects among
            what's installed here. */}
        <Models onStatusChange={() => void loadChoices()} />

        {gen.phase === "generating" && <GenProgress progress={gen.progress} />}

        {gen.phase === "failed" && (
          <div className="flex w-full max-w-md flex-col items-center gap-3">
            <pre className="max-h-60 w-full overflow-auto whitespace-pre-wrap rounded bg-neutral-900 p-3 text-left text-xs text-red-300">
              {gen.error}
            </pre>
            <OpenLogsButton />
          </div>
        )}

        {gen.phase === "done" && (
          <img src={gen.imageUrl} alt={prompt} className="w-full max-w-md rounded" />
        )}
      </div>

      <ComposeBar
        choices={choices ?? []}
        selected={selected?.manifest ?? null}
        onSelect={(manifest) => setSelectedId(manifest.id)}
        onMenuOpen={onMenuOpen}
        accelerator={accelerator}
        prompt={prompt}
        onPromptChange={setPrompt}
        onGenerate={runGenerate}
        busy={busy}
        canGenerate={canGenerate}
      />
    </main>
  );
}

/** The generation run state: idle, sampling, a finished image, or a failure. */
type GenState =
  | { phase: "idle" }
  // `progress` is null from the click until the first sampling event — a window
  // that includes a cold engine start (up to 120s), so the label must not imply
  // sampling has begun.
  | { phase: "generating"; progress: GenerateProgress | null }
  | { phase: "done"; imageUrl: string }
  | { phase: "failed"; error: string };

/** Sampling progress: a byte-less bar once the engine reports steps, a plain
 * line before that (which spans the cold engine start). */
function GenProgress({ progress }: { progress: GenerateProgress | null }) {
  if (!progress) {
    return <Note>Starting the engine and queuing the prompt…</Note>;
  }
  return (
    <div className="flex w-full max-w-md flex-col items-center gap-1">
      <Bar received={progress.value} total={progress.max} />
      <p className="text-xs tabular-nums text-neutral-500">
        step {progress.value} of {progress.max}
      </p>
    </div>
  );
}

/**
 * The installable models (#21). Lists what the bundle offers and hands each to a
 * {@link DownloadManager}. Deliberately flat — VRAM gating and the license gate
 * are the compose-bar menu's (#25) and the Settings model manager's (#30) job.
 * This exists so a model can be installed at all until that manager lands.
 */
function Models({ onStatusChange }: { onStatusChange?: (status: ModelStatus) => void }) {
  const models = availableModels();
  if (models.length === 0) return null;
  return (
    <section className="mt-6 flex w-full max-w-md flex-col gap-3">
      <h2 className="text-sm font-semibold text-neutral-300">Models</h2>
      {models.map((manifest) => (
        <DownloadManager key={manifest.id} manifest={manifest} onStatusChange={onStatusChange} />
      ))}
    </section>
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
        <div className="flex items-center gap-4">
          <Button onClick={view.retry}>Try again</Button>
          <OpenLogsButton />
        </div>
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

/**
 * Reveals the engine log — where the real Python error actually is (§8.6).
 * Offered in the failure views because the native Help → Open Logs menu is
 * hidden on Windows/Linux (ADR-019), and "Generation failed" without the log is
 * unactionable. Best-effort: a file manager that won't open isn't worth
 * surfacing over the error the user is already reading.
 */
function OpenLogsButton() {
  // The button is itself an error-recovery affordance, so its own failure can't
  // be silent: if opening the folder fails, show the reason (which names the
  // path, from the Rust side) and let the click retry — a success clears it.
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="flex flex-col items-center gap-1">
      <button
        type="button"
        onClick={() =>
          void openLogs().then(
            () => setError(null),
            (e) => setError(String(e)),
          )
        }
        className="text-sm text-neutral-400 underline underline-offset-2 hover:text-neutral-200"
      >
        Open engine log
      </button>
      {error && <span className="text-center text-xs text-amber-400">{error}</span>}
    </div>
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
