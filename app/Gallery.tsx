/**
 * The Studio output grid (#27): a `repeat(4, 1fr)` grid of square tiles, one per
 * queued job. Its reason to exist *now* is the **live-generating tile** — the
 * first cell while a job samples, showing its step bar and a cancel ✕, which the
 * finished image then replaces in place. Reproduced from
 * `docs/Darkroom Studio.dc.html` down to the shimmer and the hex.
 *
 * The richer gallery around it — a persisted library, the 452px selected preview
 * with its recipe chips (#28), and the full failed-tile + node-error surfacing
 * (#29) — is later. This grid holds only the current session's jobs (there is no
 * library to read yet) and renders each in the state {@link useQueue} reports.
 * Ordering is the point: the one generating tile leads, the queued tiles wait
 * behind it, and finished outputs follow newest-first, so the live tile is
 * always the first cell the eye lands on.
 */
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

/** A finished output: the generated image filling its cell. This is what
 *  replaces the live tile when a run completes. */
function DoneTile({ job }: { job: Job }) {
  if (job.status.phase !== "done") return null;
  return (
    <div className="relative aspect-square overflow-hidden rounded-[6px] border border-line">
      <img src={job.status.imageUrl} alt={job.prompt} className="h-full w-full object-cover" />
    </div>
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

export function Gallery({ jobs, onCancel }: { jobs: Job[]; onCancel: (id: string) => void }) {
  if (jobs.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <p className="text-sm text-muted">Your generations will appear here.</p>
      </div>
    );
  }

  return (
    <div className="grid w-full grid-cols-4 content-start gap-[10px]">
      {displayOrder(jobs).map((job) => {
        switch (job.status.phase) {
          case "generating":
            return <LiveTile key={job.id} job={job} onCancel={() => onCancel(job.id)} />;
          case "queued":
            return <QueuedTile key={job.id} job={job} onCancel={() => onCancel(job.id)} />;
          case "done":
            return <DoneTile key={job.id} job={job} />;
          case "failed":
            return <FailedTile key={job.id} job={job} onCancel={() => onCancel(job.id)} />;
        }
      })}
    </div>
  );
}
