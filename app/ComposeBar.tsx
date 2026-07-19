/**
 * The floating compose bar (#25): the one place you say what to make and press
 * Generate. Reproduced from `docs/Darkroom Studio.dc.html` — a bar pinned to the
 * bottom of the Studio (`left/right 22px, bottom 22px`), left→right: the model
 * selector pill, the prompt, the param chips, and Generate.
 *
 * **What this issue owns is the surface, not the submit.** Selection, the pill,
 * the model menu (with license and VRAM gating reasons, §8.5 / OC-2), and the
 * param chips that redraw when the model changes are all here. The actual queued
 * generation — sequential submit, cancel, `client_id` matching — is the queue
 * (#27); until then the parent wires Generate to the walking-skeleton path (#11)
 * so the bar still makes pixels. So the chips *reflect* the selected model's
 * params (that "switching updates the params" is the acceptance) but are not yet
 * editable — the manifest-driven params form is #26. Seed is the exception: its
 * `⇄` shuffles, because a fixed seed makes every generation identical, which is
 * a worse first impression than an unfilled steps field.
 */
import { useState } from "react";

import { chipsFor, type Chip } from "./lib/compose";
import type { Accelerator } from "./lib/engine";
import type { ModelChoice } from "./lib/models";
import type { Manifest } from "./lib/registry.schema";

/** The swatch gradient — a warm red radial over near-black, the model's stand-in
 *  glyph until real thumbnails exist. Inline because it's a gradient the mockup
 *  hand-tunes, not a flat token; the red is the safelight (`#d94f3d`). */
const SWATCH =
  "radial-gradient(120% 120% at 30% 20%, rgba(217,79,61,.4), transparent 60%), " +
  "linear-gradient(150deg,#2a1b17,#140d0b)";

/** A fresh 31-bit seed. ComfyUI seeds are non-negative integers; 2³¹ keeps them
 *  well inside a JS-safe range and matches the mockup's ~9-digit value. */
function randomSeed(): number {
  return Math.floor(Math.random() * 0x80000000);
}

function ChipView({ chip }: { chip: Chip }) {
  return (
    <span className="mono flex items-center gap-1.5 rounded-lg bg-panel-3 px-[11px] py-2 text-[12px] text-ink-4">
      {chip.label}
      {chip.value !== undefined && <span className="text-ink-3">{chip.value}</span>}
      {chip.action && (
        <button
          type="button"
          onClick={chip.action.onClick}
          title={chip.action.title}
          className="text-ink-4 transition-colors hover:text-safelight"
        >
          {chip.action.glyph}
        </button>
      )}
    </span>
  );
}

/** One row in the model menu. Selectable only when installed and it fits;
 *  otherwise it's shown, disabled, with the reason — gating teaches, it doesn't
 *  hide (§8.5). */
function MenuRow({
  choice,
  selected,
  onSelect,
}: {
  choice: ModelChoice;
  selected: boolean;
  onSelect: () => void;
}) {
  const { manifest, installed, gate } = choice;
  const fits = gate ? gate.fits : true;
  const selectable = installed && fits;

  // The status line under the name, most-actionable state first.
  let status: { text: string; className: string };
  if (!fits && gate?.reason) {
    status = { text: gate.reason, className: "text-safelight" };
  } else if (installed) {
    status = { text: "● installed", className: "text-success" };
  } else {
    status = { text: "not installed", className: "text-muted" };
  }

  return (
    <button
      type="button"
      disabled={!selectable}
      onClick={onSelect}
      className={`flex w-full items-start gap-[11px] rounded-lg px-[11px] py-[9px] text-left transition-colors ${
        selectable ? "hover:bg-panel-3" : "cursor-not-allowed opacity-60"
      } ${selected ? "bg-panel-3" : ""}`}
    >
      <span
        aria-hidden
        className="mt-[2px] h-[26px] w-[26px] shrink-0 rounded-[7px]"
        style={{ background: SWATCH }}
      />
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-2">
          <span className="text-[13.5px] text-ink">{manifest.name}</span>
          {selected && <span className="text-safelight text-[11px]">✓</span>}
        </span>
        <span className="mono mt-[3px] block text-[11px] leading-[1.5] text-muted">
          {manifest.kind} · {manifest.license}
        </span>
        <span className={`mono mt-[1px] block text-[11px] leading-[1.5] ${status.className}`}>
          {status.text}
        </span>
      </span>
    </button>
  );
}

export interface ComposeBarProps {
  choices: ModelChoice[];
  /** The currently selected model, or `null` when nothing is installed yet. */
  selected: Manifest | null;
  onSelect: (manifest: Manifest) => void;
  /** Fired when the menu opens, so the parent can lazily read VRAM and fill in
   *  the gating reasons (see `models.ts`). */
  onMenuOpen: () => void;
  accelerator: Accelerator;
  prompt: string;
  onPromptChange: (prompt: string) => void;
  onGenerate: () => void;
  /** True while a generation is in flight — Generate becomes "Generating…". */
  busy: boolean;
  /** Whether the selected model can be generated right now (installed, and a
   *  path exists for it). Drives Generate's enabled state alongside `busy` and a
   *  non-empty prompt. */
  canGenerate: boolean;
}

export function ComposeBar({
  choices,
  selected,
  onSelect,
  onMenuOpen,
  accelerator,
  prompt,
  onPromptChange,
  onGenerate,
  busy,
  canGenerate,
}: ComposeBarProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  // Seed lives here, not in the manifest: it's the one param the bar mutates
  // (shuffle) and it's model-agnostic, so it survives a model switch.
  const [seed, setSeed] = useState(randomSeed);

  const toggleMenu = () => {
    setMenuOpen((open) => {
      if (!open) onMenuOpen();
      return !open;
    });
  };

  const select = (manifest: Manifest) => {
    onSelect(manifest);
    setMenuOpen(false);
  };

  const chips = selected ? chipsFor(selected, seed, () => setSeed(randomSeed())) : [];
  const generateDisabled = busy || !canGenerate || prompt.trim() === "";

  return (
    <div className="absolute inset-x-[22px] bottom-[22px]">
      {/* The installed-model menu, floated above the pill. */}
      {menuOpen && (
        <div className="absolute bottom-[calc(100%+8px)] left-0 w-[320px] rounded-[14px] border border-line-5 bg-panel-2/95 p-1.5 shadow-[0_20px_50px_rgba(0,0,0,.5)] backdrop-blur-xl">
          {choices.length === 0 ? (
            <p className="px-[11px] py-3 text-[13px] text-muted">
              No models installed yet — add one in Settings.
            </p>
          ) : (
            choices.map((choice) => (
              <MenuRow
                key={choice.manifest.id}
                choice={choice}
                selected={choice.manifest.id === selected?.id}
                onSelect={() => select(choice.manifest)}
              />
            ))
          )}
        </div>
      )}

      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (!generateDisabled) onGenerate();
        }}
        className="flex items-center gap-[10px] rounded-[14px] border border-line-5 bg-[rgba(20,20,24,.9)] p-[11px_12px] shadow-[0_20px_50px_rgba(0,0,0,.5)] backdrop-blur-xl"
      >
        {/* Model selector pill. */}
        <button
          type="button"
          onClick={toggleMenu}
          className="flex items-center gap-[9px] rounded-[10px] border border-tint-line bg-tint px-3 py-[9px] transition-colors hover:border-tint-line-hover hover:bg-tint-hover"
        >
          <span
            aria-hidden
            className="h-[22px] w-[22px] shrink-0 rounded-md"
            style={{ background: SWATCH }}
          />
          <span className="text-left leading-[1.15]">
            <span className="block text-[13px] text-ink">
              {selected ? selected.name : "Select a model"}
            </span>
            <span className="mono block text-[10.5px] text-tint-sub">
              {selected ? `${selected.kind} · ${accelerator.toUpperCase()}` : "none installed"}
            </span>
          </span>
          <span aria-hidden className="ml-0.5 text-[11px] text-muted-2">
            ▾
          </span>
        </button>

        {/* Prompt. The native caret is the safelight; the animated caret in the
            mockup was a static-page stand-in for exactly this. */}
        <input
          type="text"
          value={prompt}
          onChange={(e) => onPromptChange(e.target.value)}
          placeholder="Describe the next frame…"
          className="min-w-0 flex-1 bg-transparent pl-1 text-[15px] text-ink-2 caret-safelight placeholder:text-muted focus:outline-none"
        />

        {/* Param chips — reflect the selected model (#26 makes them editable). */}
        {chips.length > 0 && (
          <div className="flex gap-[7px]">
            {chips.map((chip) => (
              <ChipView key={chip.label} chip={chip} />
            ))}
          </div>
        )}

        {/* Generate — ⏎ submits (the form's submit). */}
        <button
          type="submit"
          disabled={generateDisabled}
          className="rounded-[9px] bg-gradient-to-b from-primary-from to-primary-to px-6 py-[11px] text-[14.5px] font-bold text-primary-ink transition-opacity disabled:cursor-not-allowed disabled:opacity-50"
        >
          {busy ? "Generating…" : "Generate"}
        </button>
      </form>
    </div>
  );
}
