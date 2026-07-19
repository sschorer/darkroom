/**
 * The Studio left rail (#53): a 184px column with the output Library, the live
 * generation Queue block, and the pinned Settings button — reproduced from
 * `docs/Darkroom Studio.dc.html` down to the padding and hex.
 *
 * The Queue block is now **live** (#27): it reads the generation queue's {@link
 * QueueSummary} and shows the running job's step bar and what's waiting behind
 * it, or nothing when the queue is idle. The Library counts stay static
 * placeholder content until the gallery gives them something to count (#28).
 */
import type { QueueSummary } from "./lib/queue";

/** One Library row. Presentational for now — clicking a category to filter the
 * gallery arrives with the gallery itself (#28), so these are not buttons. */
function LibraryRow({
  glyph,
  label,
  count,
  active,
}: {
  glyph: string;
  label: string;
  count: number;
  active?: boolean;
}) {
  return (
    <div
      className={`flex items-center gap-[9px] rounded-[7px] px-[10px] py-2 text-[13.5px] ${
        active ? "bg-panel-3 text-ink" : "text-ink-4"
      }`}
    >
      <span aria-hidden className={active ? "text-safelight" : undefined}>
        {glyph}
      </span>
      {label}
      <span className={`mono ml-auto text-[11px] ${active ? "text-muted-2" : "text-muted-3"}`}>
        {count}
      </span>
    </div>
  );
}

/** The mono section eyebrow shared by Library and Queue. */
function RailLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="mono mb-2 pl-2 text-[10.5px] uppercase tracking-[0.2em] text-muted-3">
      {children}
    </div>
  );
}

/**
 * The live Queue block: the running job's step bar and a line for what's queued
 * behind it. Renders nothing when the queue is idle — an empty block would be
 * noise, and the mockup's populated state is what a *busy* rail looks like.
 */
function QueueBlock({ summary }: { summary: QueueSummary }) {
  if (summary.active === 0) return null;

  const { generating, queued } = summary;
  const progress = generating?.progress ?? null;
  // The step fraction, and the bar width it drives. Before the first step (a
  // window that includes the cold engine start) there is no fraction to show, so
  // the label falls back to a bare "generating" and the bar sits empty.
  const stepLabel = progress ? `${progress.value}/${progress.max}` : "";
  const pct = progress && progress.max > 0 ? (progress.value / progress.max) * 100 : 0;

  return (
    <>
      <RailLabel>Queue · {summary.active}</RailLabel>
      {generating && (
        <div className="rounded-[7px] border border-queue-line bg-queue-bg px-[10px] py-[9px]">
          <div className="mono flex justify-between text-[11.5px] text-queue-ink">
            <span>generating</span>
            <span>{stepLabel}</span>
          </div>
          <div className="mt-[7px] h-[3px] overflow-hidden rounded-[2px] bg-queue-track">
            <div
              className="h-full bg-safelight transition-[width] duration-200"
              style={{ width: `${pct}%` }}
            />
          </div>
        </div>
      )}
      {queued.count > 0 && (
        <div className="mono truncate px-[10px] py-[9px] text-[11.5px] text-muted-2">
          {queued.count} queued{queued.nextPrompt ? ` · ${queued.nextPrompt}…` : ""}
        </div>
      )}
    </>
  );
}

export function Rail({
  onOpenSettings,
  queue,
}: {
  onOpenSettings: () => void;
  queue: QueueSummary;
}) {
  return (
    <div className="flex w-[184px] shrink-0 flex-col border-r border-line">
      <div className="flex flex-1 flex-col gap-1.5 overflow-hidden px-[14px] py-[18px]">
        <RailLabel>Library</RailLabel>
        <LibraryRow glyph="▦" label="All outputs" count={128} active />
        <LibraryRow glyph="▣" label="Images" count={104} />
        <LibraryRow glyph="▶" label="Video" count={24} />
        <LibraryRow glyph="★" label="Kept" count={17} />

        {queue.active > 0 && <div className="mx-2 my-3 h-px bg-line" />}
        <QueueBlock summary={queue} />
      </div>

      {/* Pinned bottom: the one wired control — opens Settings. */}
      <div className="border-t border-line p-[10px]">
        <button
          type="button"
          onClick={onOpenSettings}
          className="flex w-full items-center gap-[10px] rounded-lg px-[10px] py-[9px] text-[13.5px] text-ink-4 transition-colors hover:bg-panel-3 hover:text-ink"
        >
          <span aria-hidden className="text-[15px]">
            ⚙
          </span>{" "}
          Settings
        </button>
      </div>
    </div>
  );
}
