/**
 * The Settings screen shell (#53). This issue owns the *routing* to Settings and
 * the way back — the model manager, storage meter, engine block, and privacy
 * toggle that fill the content area are a later, larger issue (#30). So the
 * 212px nav is reproduced from `docs/Darkroom Studio.dc.html` (it is where the
 * "← Back to studio" affordance lives) while the content is a placeholder.
 *
 * The nav categories are presentational: each is its own sub-page in #30, not
 * yet built, so they are not buttons. `Back to studio` is the one wired control.
 */

/** A settings nav category. Static until #30 gives each one a panel. */
function NavItem({ glyph, label, active }: { glyph: string; label: string; active?: boolean }) {
  return (
    <div
      className={`flex items-center gap-[10px] rounded-lg px-[11px] py-[9px] text-[13.5px] ${
        active ? "bg-panel-3 text-ink" : "text-ink-4"
      }`}
    >
      <span aria-hidden className={active ? "text-safelight" : undefined}>
        {glyph}
      </span>
      {label}
    </div>
  );
}

export function Settings({ onBack }: { onBack: () => void }) {
  return (
    <div className="flex min-h-0 flex-1">
      {/* Settings nav (212px) — wider than the studio rail, per the mockup. */}
      <div className="flex w-[212px] shrink-0 flex-col border-r border-line">
        <div className="flex flex-1 flex-col gap-1 px-[14px] py-[18px]">
          <div className="mono mb-[10px] ml-2 mt-1 text-[10.5px] uppercase tracking-[0.2em] text-muted-3">
            Settings
          </div>
          <NavItem glyph="◆" label="Models" active />
          <NavItem glyph="⚙" label="Engine" />
          <NavItem glyph="▤" label="Storage" />
          <NavItem glyph="◇" label="Privacy" />
          <NavItem glyph="ⓘ" label="About" />
        </div>
        <div className="border-t border-line p-[10px]">
          <button
            type="button"
            onClick={onBack}
            className="flex w-full items-center gap-[10px] rounded-lg px-[10px] py-[9px] text-[13.5px] text-ink-4 transition-colors hover:bg-panel-3 hover:text-ink"
          >
            <span aria-hidden className="text-[15px]">
              ←
            </span>{" "}
            Back to studio
          </button>
        </div>
      </div>

      {/* Content placeholder: the model manager and the rest land in #30. */}
      <div className="min-w-0 flex-1 overflow-auto px-10 py-[30px]">
        <div className="flex max-w-[820px] flex-col gap-1.5">
          <h2 className="text-2xl font-semibold">Models</h2>
          <p className="text-sm text-muted">
            Install, remove, and promote staged models here — with the storage meter, engine info,
            and privacy controls. This panel arrives in a later step.
          </p>
        </div>
      </div>
    </div>
  );
}
