/**
 * The Studio gallery (#28): the **selected preview** column beside the output
 * **grid**, reproduced from `docs/Darkroom Studio.dc.html`.
 *
 * The grid is a `repeat(4, 1fr)` of square tiles, one per job in the state
 * {@link useQueue} reports — its live-generating tile (#27) leading, queued
 * tiles behind it, finished outputs newest-first. Clicking a finished tile
 * selects it into the 452px preview on the left, which shows the output large
 * with its recipe (seed, steps, size, elapsed) and the two acts you take on a
 * frame you like: **keep** it (★) and **download** it (⤓), plus **reuse recipe**
 * (↻) to send its exact settings back to the compose bar.
 *
 * Both media kinds render: an image model's output is an `<img>`, a video
 * model's is a `<video>` — the queue already fetches either as a `blob:` URL
 * (ADR-008), and the job's `manifest.kind` says which element to hang it on. A
 * video tile in the grid carries a `▶ m:ss` badge once its metadata loads.
 *
 * This grid still holds only the current session's jobs; the persisted library
 * behind the rail's counts is later. The failed tile is deliberately minimal —
 * the node-error banner and retry the mockup shows are #29's error-surfacing
 * work; here a failed run is at least visible and dismissable.
 */
import { useState } from "react";

import type { Job } from "./lib/queue";

/** The tile's warm fill and its travelling sweep — hand-tuned gradients the
 *  mockup leans on, kept inline like the compose-bar swatch rather than forced
 *  into flat tokens. The sweep animates the `shimmer` keyframe (theme.css). */
const LIVE_FILL =
  "radial-gradient(120% 100% at 40% 30%, rgba(217,79,61,.2), transparent 60%), " +
  "linear-gradient(160deg,#241813,#0d0908)";
const LIVE_SWEEP = "linear-gradient(90deg,transparent,rgba(217,79,61,.16),transparent)";
const LIVE_BAR = "linear-gradient(90deg,#a83a2c,#d94f3d)";
const LIVE_OVERLAY = "linear-gradient(0deg,rgba(8,6,6,.85),transparent)";

/** The empty preview's tonal fill — the cool slate the mockup's placeholder
 *  frame uses, so the column reads as "a frame goes here" before one is picked. */
const PREVIEW_EMPTY_FILL =
  "radial-gradient(120% 100% at 40% 25%, rgba(120,150,190,.10), transparent 55%), " +
  "linear-gradient(155deg,#191c22,#0d0f13)";

/** The extension for a downloaded output, from the blob's MIME type. Falls back
 *  to the subtype (`image/webp` → `webp`) and finally `bin`, so an unexpected
 *  type still saves with *a* name rather than none. */
function extFromMime(mime: string): string {
  const map: Record<string, string> = {
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/webp": "webp",
    "image/gif": "gif",
    "video/webm": "webm",
    "video/mp4": "mp4",
  };
  return map[mime] ?? mime.split("/")[1]?.split(";")[0] ?? "bin";
}

/** Saves a finished output to disk. Reads the blob back from its own `blob:` URL
 *  to learn the real type (the queue only kept the URL), names it from the seed,
 *  and triggers the browser's download — a plain, user-initiated file save, no
 *  network. Best-effort: a fetch that fails leaves nothing downloaded rather
 *  than throwing into a click handler. */
async function downloadOutput(url: string, baseName: string): Promise<void> {
  try {
    const blob = await fetch(url).then((r) => r.blob());
    const a = document.createElement("a");
    a.href = url;
    a.download = `${baseName}.${extFromMime(blob.type)}`;
    document.body.appendChild(a);
    a.click();
    a.remove();
  } catch {
    // Nothing actionable to surface for a local save that couldn't read its own
    // blob; the output is still on screen.
  }
}

/** The base filename a downloaded output saves under — `darkroom-<seed>`, the
 *  seed being the one value that names *this* frame among a prompt's variations.
 *  Falls back to `output` when the model declared no seed. */
function downloadName(job: Job): string {
  const seed = (job.values as Record<string, unknown>).seed;
  return `darkroom-${typeof seed === "number" ? seed : "output"}`;
}

/** `4` → `0:04`. The engine reports no duration, so this reads it off the loaded
 *  `<video>` element's own metadata (see {@link VideoThumb}). */
function formatDuration(seconds: number): string {
  const total = Math.round(seconds);
  const m = Math.floor(total / 60);
  return `${m}:${String(total % 60).padStart(2, "0")}`;
}

/** The recipe chips under the preview: the values that made this output, mono,
 *  in the mockup's order. Every field is read off the job's resolved `values`
 *  (or the run's measured time), so a missing one simply drops its chip rather
 *  than showing a placeholder. */
function recipeChips(job: Job): string[] {
  const chips: string[] = [];
  const { seed, steps, width, height } = job.values as Record<string, unknown>;
  if (typeof seed === "number") chips.push(`seed ${seed}`);
  if (typeof steps === "number") chips.push(`${steps} steps`);
  if (typeof width === "number" && typeof height === "number") {
    chips.push(width === height ? `${width}²` : `${width}×${height}`);
  }
  if (job.status.phase === "done") {
    chips.push(`${(job.status.elapsedMs / 1000).toFixed(1)}s`);
  }
  return chips;
}

/** The cancel ✕ pinned to a tile's top-right (live + queued). 22×22, its idle
 *  fill a dark scrim so it reads over the tile, hovering to the close-red the
 *  window's close button uses — cancel is the same "stop this" gesture. */
function TileCancel({ onClick, title }: { onClick: () => void; title: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-label={title}
      className="absolute right-[6px] top-[6px] flex h-[22px] w-[22px] items-center justify-center rounded-[6px] bg-live-cancel text-[11px] text-[#e6ddd6] transition-colors hover:bg-control-close-hover hover:text-white"
    >
      ✕
    </button>
  );
}

/** The live-generating tile: the running job before its pixels land. A warm
 *  fill under a shimmer sweep says "working" even before the first step; the
 *  bottom overlay shows the step count over a safelight bar once sampling
 *  reports. Cancel interrupts the engine (see {@link useQueue}). */
function LiveTile({ job, onCancel }: { job: Job; onCancel: () => void }) {
  const progress = job.status.phase === "generating" ? job.status.progress : null;
  const pct = progress && progress.max > 0 ? (progress.value / progress.max) * 100 : 0;

  return (
    <div className="relative aspect-square overflow-hidden rounded-[6px] border border-live-line">
      <div className="absolute inset-0" style={{ background: LIVE_FILL }} />
      <div className="absolute inset-0 overflow-hidden">
        <div
          className="absolute inset-0"
          style={{ background: LIVE_SWEEP, animation: "shimmer 1.5s linear infinite" }}
        />
      </div>

      <TileCancel onClick={onCancel} title="Cancel this generation" />

      <div className="absolute inset-x-0 bottom-0 p-[9px]" style={{ background: LIVE_OVERLAY }}>
        <div className="mono text-[10px] text-[#e6ddd6]">
          {progress ? `step ${progress.value} / ${progress.max}` : "starting…"}
        </div>
        <div className="mt-[6px] h-[3px] overflow-hidden rounded-[2px] bg-live-track">
          <div
            className="h-full transition-[width] duration-200"
            style={{ width: `${pct}%`, background: LIVE_BAR }}
          />
        </div>
      </div>
    </div>
  );
}

/** A job waiting its turn: a dim placeholder that reserves the cell and can be
 *  cancelled before it ever runs. */
function QueuedTile({ job, onCancel }: { job: Job; onCancel: () => void }) {
  return (
    <div className="relative flex aspect-square items-center justify-center overflow-hidden rounded-[6px] border border-line-2 bg-inset">
      <span className="mono text-[10px] uppercase tracking-[0.15em] text-muted-3">queued</span>
      <TileCancel onClick={onCancel} title={`Remove "${job.prompt}" from the queue`} />
    </div>
  );
}

/** A finished video, thumbnailed. Muted and controls-free in the grid — it is a
 *  thumbnail, not a player — with a `▶ m:ss` badge that appears once the browser
 *  has read the clip's duration from its metadata. */
function VideoThumb({ src, alt }: { src: string; alt: string }) {
  const [duration, setDuration] = useState<number | null>(null);
  return (
    <>
      <video
        src={src}
        muted
        playsInline
        preload="metadata"
        aria-label={alt}
        onLoadedMetadata={(e) => setDuration(e.currentTarget.duration)}
        className="h-full w-full object-cover"
      />
      {duration != null && Number.isFinite(duration) && (
        <span className="mono absolute bottom-[6px] left-[6px] flex items-center gap-1 rounded-[5px] bg-[rgba(12,12,15,.65)] px-[6px] py-[2px] text-[9.5px] text-ink">
          <span aria-hidden>▶</span>
          {formatDuration(duration)}
        </span>
      )}
    </>
  );
}

/** A finished output in the grid: the generated image or video filling its cell,
 *  selectable into the preview. The selected tile carries a safelight ring so
 *  the eye ties it to what the preview shows. */
function DoneTile({
  job,
  selected,
  onSelect,
}: {
  job: Job;
  selected: boolean;
  onSelect: () => void;
}) {
  if (job.status.phase !== "done") return null;
  const isVideo = job.manifest.kind === "video";
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      className={`relative aspect-square overflow-hidden rounded-[6px] border border-line transition-shadow ${
        selected ? "ring-2 ring-inset ring-safelight" : ""
      }`}
    >
      {isVideo ? (
        <VideoThumb src={job.status.imageUrl} alt={job.prompt} />
      ) : (
        <img src={job.status.imageUrl} alt={job.prompt} className="h-full w-full object-cover" />
      )}
    </button>
  );
}

/** A run that errored. Minimal on purpose: the node-error banner and the retry
 *  affordance the mockup shows are #29's error-surfacing work; here a failed run
 *  is at least visible and dismissable, its reason on the tile's title, rather
 *  than vanishing. */
function FailedTile({ job, onCancel }: { job: Job; onCancel: () => void }) {
  const error = job.status.phase === "failed" ? job.status.error : "";
  return (
    <div
      title={error}
      className="relative flex aspect-square flex-col items-center justify-center gap-[7px] overflow-hidden rounded-[6px] border border-error-line bg-inset"
    >
      <span className="text-[19px] text-error-glyph">⚠</span>
      <span className="mono text-[11px] text-queue-ink">failed</span>
      <TileCancel onClick={onCancel} title="Dismiss" />
    </div>
  );
}

/** A 30×30 glass button over the preview (keep / download). Its idle fill is the
 *  same dark scrim as the tile cancel, so both overlay controls read as one. */
function PreviewAction({
  glyph,
  title,
  active,
  onClick,
}: {
  glyph: string;
  title: string;
  active?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-label={title}
      aria-pressed={active}
      className={`flex h-[30px] w-[30px] items-center justify-center rounded-[7px] bg-[rgba(12,12,15,.6)] text-[14px] transition-colors hover:text-white ${
        active ? "text-safelight" : "text-ink"
      }`}
    >
      {glyph}
    </button>
  );
}

/** The 452px selected-preview column: the chosen output large, its keep/download
 *  overlay, and its recipe below with "reuse recipe". Shows a tonal placeholder
 *  until an output is selected. */
function SelectedPreview({
  job,
  kept,
  onToggleKeep,
  onReuse,
}: {
  job: Job | null;
  kept: boolean;
  onToggleKeep: () => void;
  onReuse: () => void;
}) {
  const done = job?.status.phase === "done" ? job.status : null;
  const isVideo = job?.manifest.kind === "video";

  return (
    <div className="flex w-[452px] shrink-0 flex-col overflow-y-auto">
      <div className="relative aspect-square shrink-0 overflow-hidden rounded-[8px] border border-line-4">
        {done && job ? (
          isVideo ? (
            <video
              src={done.imageUrl}
              controls
              playsInline
              aria-label={job.prompt}
              className="h-full w-full object-cover"
            />
          ) : (
            <img src={done.imageUrl} alt={job.prompt} className="h-full w-full object-cover" />
          )
        ) : (
          <div
            className="flex h-full items-center justify-center"
            style={{ background: PREVIEW_EMPTY_FILL }}
          >
            <p className="text-[13px] text-muted">Select an output to preview.</p>
          </div>
        )}

        {done && job && (
          <div className="absolute right-[12px] top-[12px] flex gap-[7px]">
            <PreviewAction
              glyph="★"
              title={kept ? "Kept" : "Keep this output"}
              active={kept}
              onClick={onToggleKeep}
            />
            <PreviewAction
              glyph="⤓"
              title="Download this output"
              onClick={() => void downloadOutput(done.imageUrl, downloadName(job))}
            />
          </div>
        )}
      </div>

      {job && done && (
        <div className="mt-[14px] flex flex-col gap-[12px]">
          <p className="text-[14.5px] leading-[1.5] text-ink-2">{job.prompt}</p>
          <div className="mono flex flex-wrap gap-[7px] text-[11.5px]">
            {recipeChips(job).map((chip) => (
              <span key={chip} className="rounded-[6px] bg-panel-3 px-[9px] py-[4px] text-ink-4">
                {chip}
              </span>
            ))}
            <button
              type="button"
              onClick={onReuse}
              className="rounded-[6px] bg-[#1a1214] px-[9px] py-[4px] text-[#d97a6d] transition-colors hover:text-[#ec8a7c]"
            >
              ↻ reuse recipe
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/** Orders the jobs for the grid: the one generating tile first, then the queued
 *  tiles in submission order, then finished/failed outputs newest-first. Keeps
 *  the live tile as the first cell regardless of what is queued behind it. */
function displayOrder(jobs: Job[]): Job[] {
  const generating = jobs.filter((j) => j.status.phase === "generating");
  const queued = jobs.filter((j) => j.status.phase === "queued");
  const finished = jobs
    .filter((j) => j.status.phase === "done" || j.status.phase === "failed")
    .reverse();
  return [...generating, ...queued, ...finished];
}

export function Gallery({
  jobs,
  selectedId,
  onSelect,
  onCancel,
  onReuse,
  kept,
  onToggleKeep,
  emptyState,
}: {
  jobs: Job[];
  /** The previewed output's job id, or null. Only a `done` job is previewable. */
  selectedId: string | null;
  onSelect: (id: string) => void;
  onCancel: (id: string) => void;
  onReuse: (job: Job) => void;
  kept: ReadonlySet<string>;
  onToggleKeep: (id: string) => void;
  /** Shown in the grid column while there are no jobs — the install scaffolding
   *  lives here until Settings owns it (#30). */
  emptyState?: React.ReactNode;
}) {
  const selectedJob = jobs.find((j) => j.id === selectedId && j.status.phase === "done") ?? null;

  return (
    <div className="flex min-h-0 flex-1 gap-[20px]">
      <SelectedPreview
        job={selectedJob}
        kept={selectedJob ? kept.has(selectedJob.id) : false}
        onToggleKeep={() => selectedJob && onToggleKeep(selectedJob.id)}
        onReuse={() => selectedJob && onReuse(selectedJob)}
      />

      <div className="min-w-0 flex-1 overflow-y-auto">
        {jobs.length === 0 ? (
          <div className="flex h-full items-center justify-center">
            {emptyState ?? <p className="text-sm text-muted">Your generations will appear here.</p>}
          </div>
        ) : (
          <div
            className="grid content-start gap-[10px]"
            style={{ gridTemplateColumns: "repeat(auto-fill, 176px)" }}
          >
            {displayOrder(jobs).map((job) => {
              switch (job.status.phase) {
                case "generating":
                  return <LiveTile key={job.id} job={job} onCancel={() => onCancel(job.id)} />;
                case "queued":
                  return <QueuedTile key={job.id} job={job} onCancel={() => onCancel(job.id)} />;
                case "done":
                  return (
                    <DoneTile
                      key={job.id}
                      job={job}
                      selected={job.id === selectedId}
                      onSelect={() => onSelect(job.id)}
                    />
                  );
                case "failed":
                  return <FailedTile key={job.id} job={job} onCancel={() => onCancel(job.id)} />;
              }
            })}
          </div>
        )}
      </div>
    </div>
  );
}
