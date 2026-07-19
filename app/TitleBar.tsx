/**
 * The custom window chrome (#52). Tauri runs the window with
 * `decorations: false` (see tauri.conf.json), so the OS draws no titlebar and
 * this 44px bar is it: the safelight status dot, the wordmark, an optional mono
 * subline, and the minimize / maximize / close controls — reproduced from
 * `docs/Darkroom Studio.dc.html` down to the hover colours.
 *
 * The bar itself is the drag region (`data-tauri-drag-region`, a Tauri-native
 * attribute that needs `core:window:allow-start-dragging`); the controls sit
 * outside it so a click on a button never also drags the window.
 *
 * `subtitle` is the mono subline. It's content — "128 outputs", "settings",
 * "first run" in the mockup — and arrives with screen routing (#2); until then
 * the slot is simply empty, which is a truthful foundation rather than a faked
 * count.
 */
import { getCurrentWindow } from "@tauri-apps/api/window";

const appWindow = getCurrentWindow();

/** Fire a window action, swallowing IPC errors. A desktop app must not crash a
 * frame deep because a window call rejected — and a failed minimize is a
 * no-op the user can just retry, not something to surface. */
function windowAction(action: () => Promise<unknown>): void {
  void action().catch(() => {});
}

export function TitleBar({ subtitle }: { subtitle?: string }) {
  return (
    <div
      data-tauri-drag-region
      className="flex h-11 shrink-0 items-center justify-between border-b border-line bg-titlebar pr-2 pl-[18px]"
    >
      {/* Left: status dot + wordmark + subline. All draggable — the whole left
          side is chrome, not controls. */}
      <div data-tauri-drag-region className="flex items-center gap-[11px]">
        <span
          data-tauri-drag-region
          aria-hidden
          className="h-[7px] w-[7px] rounded-full bg-safelight"
          style={{
            boxShadow: "0 0 8px var(--color-safelight)",
            animation: "safelight-pulse 3s ease-in-out infinite",
          }}
        />
        <span data-tauri-drag-region className="text-[14px] font-semibold tracking-[0.01em]">
          Darkroom
        </span>
        {subtitle && (
          <span data-tauri-drag-region className="mono ml-1 text-[12px] text-titlebar-sub">
            {subtitle}
          </span>
        )}
      </div>

      {/* Right: window controls. Not a drag region. */}
      <div className="flex items-center gap-0.5">
        <WindowButton label="Minimize" onClick={() => windowAction(() => appWindow.minimize())}>
          <span className="block h-[1.5px] w-[11px] bg-current" />
        </WindowButton>
        <WindowButton
          label="Maximize"
          onClick={() => windowAction(() => appWindow.toggleMaximize())}
        >
          <span className="block h-[10px] w-[10px] rounded-[2px] border-[1.5px] border-current" />
        </WindowButton>
        <WindowButton label="Close" danger onClick={() => windowAction(() => appWindow.close())}>
          <span className="text-[15px] leading-none">✕</span>
        </WindowButton>
      </div>
    </div>
  );
}

/** A single 42×30 control. `danger` is the close button's red hover; the other
 * two share the neutral hover. All three colours are chrome tokens in
 * theme.css so the palette stays single-sourced. */
function WindowButton({
  label,
  onClick,
  danger,
  children,
}: {
  label: string;
  onClick: () => void;
  danger?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={onClick}
      className={`inline-flex h-[30px] w-[42px] items-center justify-center rounded-[7px] text-control-ink transition-colors ${
        danger
          ? "hover:bg-control-close-hover hover:text-white"
          : "hover:bg-control-hover hover:text-ink"
      }`}
    >
      {children}
    </button>
  );
}
