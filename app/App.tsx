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
import { Gallery } from "./Gallery";
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
import { recipeState, type ParamState } from "./lib/params";
import { useQueue, type Job, type Queue } from "./lib/queue";
import type { ParamValues } from "./lib/workflow";
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
        <Studio
          accelerator={ready.installed.accelerator}
          onOpenSettings={() => setNav("settings")}
        />
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
 * The Studio screen: the rail and the main region, sharing one generation
 * {@link useQueue}. The queue lives here (not in the main) because the rail's
 * summary and the grid's live tile are two views of the same jobs — the rail
 * counts what the grid draws. Leaving the Studio unmounts this, ending any run
 * in flight (the queue's own cleanup); persisting across that is the library's
 * job (#28).
 */
function Studio({
  accelerator,
  onOpenSettings,
}: {
  accelerator: Accelerator;
  onOpenSettings: () => void;
}) {
  const queue = useQueue();
  return (
    <div className="flex min-h-0 flex-1">
      <Rail onOpenSettings={onOpenSettings} queue={queue.summary} />
      <StudioMain accelerator={accelerator} queue={queue} />
    </div>
  );
}

/**
 * The Studio's main region: everything to the right of the rail — the output
 * grid ({@link Gallery}, #27) with the {@link ComposeBar} (#25) floating over
 * it, plus the install list that keeps a model reachable until the Settings
 * model manager (#30). The selected-preview panel and the persisted library are
 * #28's; this holds the current session's grid.
 *
 * This component is the orchestrator the bar reports to: it owns the resolved
 * model list and the selection, and turns a Generate into a queued job.
 * Selection lives here (not in the bar) because a job needs the chosen model;
 * the bar is the surface.
 */
function StudioMain({ accelerator, queue }: { accelerator: Accelerator; queue: Queue }) {
  // The offered models with their install state and — once the menu has been
  // opened — their VRAM verdict. `null` while the first resolve is in flight.
  const [choices, setChoices] = useState<ModelChoice[] | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // The VRAM total, read lazily the first time the model menu opens. `null` =
  // not yet read; `{ bytes }` = read (bytes may itself be null for no GPU).
  const [vram, setVram] = useState<{ bytes: number | null } | null>(null);
  const [prompt, setPrompt] = useState("a photo of a cat wearing a tiny hat, studio lighting");

  // The gallery's preview selection and the "kept" set (#28). Selection is a job
  // id, resolved to a done job by the {@link Gallery}; `kept` is a visual mark
  // for now (persistence is the library's, later). `recipe` is the param state
  // the compose bar opens on when a recipe is reused — applied by bumping
  // `recipeKey`, which remounts the bar so the model, prompt, and params all land
  // together (see {@link ComposeBar} `initialParams`).
  const [selectedOutputId, setSelectedOutputId] = useState<string | null>(null);
  const [kept, setKept] = useState<ReadonlySet<string>>(() => new Set());
  const [recipe, setRecipe] = useState<ParamState | null>(null);
  const [recipeKey, setRecipeKey] = useState(0);

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

  // A stable handler for the install list: an inline arrow would change identity
  // every render (prompt keystrokes and progress ticks re-render StudioMain),
  // and DownloadManager's refresh effect keys on it — so an unstable one re-walks
  // every model's status on disk on every render. `loadChoices` already ignores
  // the passed status; we just re-resolve.
  const refreshChoices = useCallback(() => void loadChoices(), [loadChoices]);

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

  // Keep the preview pointed at the newest finished output, unless the user has
  // one still-valid tile selected — a new completion never steals a manual pick.
  // Runs on every queue change: a completion, or a cancel that removes the
  // previewed job, re-resolves the selection.
  const jobs = queue.jobs;
  useEffect(() => {
    setSelectedOutputId((current) => {
      const done = jobs.filter((job) => job.status.phase === "done");
      if (current && done.some((job) => job.id === current)) return current;
      return done.at(-1)?.id ?? null;
    });
  }, [jobs]);

  const toggleKeep = useCallback((id: string) => {
    setKept((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  // Reuse recipe (#28): send a finished job's model, prompt, and exact params
  // back to the compose bar. Selecting the model and setting the prompt is
  // parent state; the params reach the bar as its `initialParams`, applied by
  // bumping `recipeKey` so the bar remounts on the whole recipe at once rather
  // than racing its own per-model reset.
  const reuse = useCallback((job: Job) => {
    setSelectedId(job.manifest.id);
    setPrompt(job.prompt);
    setRecipe(recipeState(job.values));
    setRecipeKey((key) => key + 1);
  }, []);

  const selected = choices?.find((c) => c.manifest.id === selectedId) ?? null;

  // Generate enqueues a job from the selected model, the prompt, and the bar's
  // resolved params (`resolveValues`, #26). The queue (#27) owns everything from
  // here — locating the workflow, patching it through buildWorkflow, sampling,
  // the live tile, and revoking the image — so the bar stays a pure submit and
  // can keep queuing while a job runs. Blob-URL lifetime moved into the queue
  // with it, so there is no per-image cleanup left here.
  const enqueue = useCallback(
    (values: ParamValues) => {
      if (!selected) return;
      queue.enqueue({ manifest: selected.manifest, prompt, values });
    },
    [queue, selected, prompt],
  );

  // Real per-model, per-param submission (buildWorkflow, not the skeleton), so
  // any installed model on CUDA can generate — image or video, now that the grid
  // renders a clip (#28). Non-CUDA is unusably slow (Q5, TD-2). The bar never
  // blocks on a run — sequencing is the queue's job, so it can keep queuing
  // (`busy` stays false); the rail and grid show the activity.
  const canGenerate = accelerator === "cuda" && !!selected?.installed;

  return (
    <main className="relative flex min-w-0 flex-1 flex-col overflow-hidden">
      {/* The gallery region (#28): the selected-preview column beside the output
          grid, laid out to the mockup's padding with the compose bar floating
          over its bottom. The install list (#21) is the grid's empty state —
          how a model's weights get onto disk until the Settings model manager
          (#30) owns it. */}
      <div className="flex min-h-0 flex-1 overflow-hidden pt-[20px] pb-[132px] px-[22px]">
        <Gallery
          jobs={queue.jobs}
          selectedId={selectedOutputId}
          onSelect={setSelectedOutputId}
          onCancel={queue.cancel}
          onReuse={reuse}
          kept={kept}
          onToggleKeep={toggleKeep}
          emptyState={<Models onStatusChange={refreshChoices} />}
        />
      </div>

      <ComposeBar
        key={recipeKey}
        choices={choices ?? []}
        selected={selected?.manifest ?? null}
        onSelect={(manifest) => setSelectedId(manifest.id)}
        onMenuOpen={onMenuOpen}
        accelerator={accelerator}
        prompt={prompt}
        onPromptChange={setPrompt}
        onGenerate={enqueue}
        busy={false}
        canGenerate={canGenerate}
        initialParams={recipe ?? undefined}
      />
    </main>
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
