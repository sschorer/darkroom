/**
 * The Studio left rail (#53): a 184px column with the output Library, a live
 * generation Queue block, and the pinned Settings button — reproduced from
 * `docs/Darkroom Studio.dc.html` down to the padding and hex.
 *
 * The Library counts and the Queue block are **static placeholder content** at
 * this stage: there is no gallery, database, or running queue to read from yet.
 * The library filter lands with the gallery (#28) and the live queue with the
 * generation queue (#27); until then these mirror the mockup exactly, which is
 * this issue's acceptance criterion. Only the Settings button is wired — it is
 * the one interactive control the shell owns.
 */

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

export function Rail({ onOpenSettings }: { onOpenSettings: () => void }) {
  return (
    <div className="flex w-[184px] shrink-0 flex-col border-r border-line">
      <div className="flex flex-1 flex-col gap-1.5 overflow-hidden px-[14px] py-[18px]">
        <RailLabel>Library</RailLabel>
        <LibraryRow glyph="▦" label="All outputs" count={128} active />
        <LibraryRow glyph="▣" label="Images" count={104} />
        <LibraryRow glyph="▶" label="Video" count={24} />
        <LibraryRow glyph="★" label="Kept" count={17} />

        <div className="mx-2 my-3 h-px bg-line" />

        <RailLabel>Queue · 2</RailLabel>
        {/* Live generation summary — static until the queue is wired (#27). */}
        <div className="rounded-[7px] border border-queue-line bg-queue-bg px-[10px] py-[9px]">
          <div className="mono flex justify-between text-[11.5px] text-queue-ink">
            <span>generating</span>
            <span>3/4</span>
          </div>
          <div className="mt-[7px] h-[3px] overflow-hidden rounded-[2px] bg-queue-track">
            <div className="h-full bg-safelight" style={{ width: "74%" }} />
          </div>
        </div>
        <div className="mono px-[10px] py-[9px] text-[11.5px] text-muted-2">
          1 queued · lighthouse…
        </div>
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
