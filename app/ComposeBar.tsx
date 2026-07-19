/**
 * The floating compose bar (#25): the one place you say what to make and press
 * Generate. Reproduced from `docs/Darkroom Studio.dc.html` — a bar pinned to the
 * bottom of the Studio (`left/right 22px, bottom 22px`), left→right: the model
 * selector pill, the prompt, the param chips, and Generate.
 *
 * The chips are the **manifest-driven params form** (#26): each is derived from
 * the selected model's `params` (`params.ts`) and is editable in place — click a
 * chip and a popover opens above it with the control and its bounds. Seed and
 * steps are numbers clamped to the manifest's `min`/`max`; image size is chosen
 * from aspect presets that resolve to concrete width/height; a video model swaps
 * that for a frame count. No per-model UI code — whatever `params` a manifest
 * declares is what shows, the ADR-005 promise. Seed is model-agnostic and the
 * one value the bar shuffles, so it survives a model switch; the numeric edits
 * are dropped when the model changes because the new bounds make them
 * meaningless.
 *
 * The values these chips hold feed `buildWorkflow()` at submit time: Generate
 * resolves the live params to a {@link resolveValues} map and hands it up, and
 * the parent enqueues it as a job (#27) that `buildWorkflow` patches per model,
 * per param. The bar owns the form; the queue owns the run.
 */
import { useEffect, useRef, useState } from "react";

import type { Accelerator } from "./lib/engine";
import type { ModelChoice } from "./lib/models";
import {
  fieldsFor,
  resolveValues,
  type AspectOption,
  type Field,
  type ParamState,
} from "./lib/params";
import type { Manifest } from "./lib/registry.schema";
import type { ParamValues } from "./lib/workflow";

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

/** A field's stable key: its name for numbers, or the kind for the singletons
 *  (there is only ever one seed chip and one aspect chip). Used both as the
 *  React key and as the "which popover is open" identity. */
function fieldKey(field: Field): string {
  return field.kind === "number" ? field.name : field.kind;
}

/** The shared popover shell floated above a chip — same glass as the model menu
 *  so the bar reads as one surface. */
function Popover({ children }: { children: React.ReactNode }) {
  return (
    <div className="absolute bottom-[calc(100%+10px)] left-0 z-10 w-max min-w-[172px] rounded-[12px] border border-line-5 bg-panel-2/95 p-3 shadow-[0_20px_50px_rgba(0,0,0,.5)] backdrop-blur-xl">
      {children}
    </div>
  );
}

/** The collapsed chip body: a mono label, an optional emphasised value, and any
 *  trailing content (the seed's ⇄, the ▾ hint). Matches the mockup's chip. */
function chipClass(open: boolean): string {
  return `mono flex items-center gap-1.5 rounded-lg px-[11px] py-2 text-[12px] text-ink-4 transition-colors ${
    open ? "bg-panel-3 ring-1 ring-line-5" : "bg-panel-3 hover:text-ink-3"
  }`;
}

/** A number editor constrained to `[min, max]`, committing a clamped integer on
 *  every change. A fully bounded param (steps, frames) gets a slider — dragging
 *  is the natural way to feel its range; an unbounded one (seed) falls back to a
 *  typed input, since a slider has no end to travel to. The value is clamped by
 *  the parent, so what shows here is always in range. */
function NumberEditor({
  label,
  value,
  min,
  max,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  onChange: (value: number) => void;
}) {
  const bounded = Number.isFinite(min) && Number.isFinite(max);

  if (bounded) {
    return (
      <label className="flex w-[196px] flex-col gap-2">
        <span className="mono flex items-center justify-between text-[11px] text-ink-4">
          {label} <span className="text-ink-2">{value}</span>
        </span>
        <input
          type="range"
          autoFocus
          value={value}
          min={min}
          max={max}
          step={1}
          onChange={(e) => onChange(Number(e.target.value))}
          className="w-full accent-safelight"
        />
        <span className="mono flex items-center justify-between text-[10.5px] text-muted-2">
          <span>{min}</span>
          <span>{max}</span>
        </span>
      </label>
    );
  }

  const hasMin = Number.isFinite(min);
  return (
    <label className="flex flex-col gap-2">
      <span className="mono text-[11px] text-ink-4">{label}</span>
      <input
        type="number"
        autoFocus
        value={value}
        min={hasMin ? min : undefined}
        onChange={(e) => {
          const next = Number(e.target.value);
          if (Number.isFinite(next)) onChange(next);
        }}
        className="mono w-full rounded-lg border border-line-4 bg-inset px-2.5 py-1.5 text-[13px] text-ink-2 focus:border-tint-line-hover focus:outline-none"
      />
      {hasMin && <span className="mono text-[10.5px] text-muted-2">min {min}</span>}
    </label>
  );
}

/** The aspect picker: the model's preset sizes as a wrapping grid of ratios, the
 *  current one lit. Selecting one commits its concrete width/height and closes. */
function AspectEditor({
  options,
  selected,
  onSelect,
}: {
  options: AspectOption[];
  selected: string | null;
  onSelect: (option: AspectOption) => void;
}) {
  return (
    <div className="flex flex-col gap-2">
      <span className="mono text-[11px] text-ink-4">aspect</span>
      <div className="grid grid-cols-3 gap-1.5">
        {options.map((option) => {
          const active = option.label === selected;
          return (
            <button
              key={option.label}
              type="button"
              onClick={() => onSelect(option)}
              title={`${option.width} × ${option.height}`}
              className={`mono rounded-lg px-2 py-1.5 text-[12px] transition-colors ${
                active
                  ? "bg-tint text-safelight ring-1 ring-tint-line-hover"
                  : "bg-inset text-ink-4 hover:text-ink-3"
              }`}
            >
              {option.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/** One param chip: the collapsed mono chip plus, when open, its editing popover.
 *  The chip button toggles the popover; the seed's ⇄ shuffles without opening. */
function ParamChip({
  field,
  open,
  onToggle,
  onNumber,
  onAspect,
  onShuffle,
}: {
  field: Field;
  open: boolean;
  onToggle: () => void;
  onNumber: (name: string, value: number) => void;
  onAspect: (option: AspectOption) => void;
  onShuffle: () => void;
}) {
  return (
    <div className="relative">
      {open && (
        <Popover>
          {field.kind === "number" && (
            <NumberEditor
              label={field.label}
              value={field.value}
              min={field.min}
              max={field.max}
              onChange={(value) => onNumber(field.name, value)}
            />
          )}
          {field.kind === "seed" && (
            <NumberEditor
              label="seed"
              value={field.value}
              min={0}
              max={Number.POSITIVE_INFINITY}
              onChange={(value) => onNumber("seed", value)}
            />
          )}
          {field.kind === "aspect" && (
            <AspectEditor options={field.options} selected={field.selected} onSelect={onAspect} />
          )}
        </Popover>
      )}

      {field.kind === "seed" ? (
        <span className={chipClass(open)}>
          <button type="button" onClick={onToggle} className="flex items-center gap-1.5">
            seed <span className="text-ink-3">{field.value}</span>
          </button>
          <button
            type="button"
            onClick={onShuffle}
            title="New random seed"
            className="text-ink-4 transition-colors hover:text-safelight"
          >
            ⇄
          </button>
        </span>
      ) : (
        <button type="button" onClick={onToggle} className={chipClass(open)}>
          {field.kind === "number" ? (
            <>
              {field.label} <span className="text-ink-3">{field.value}</span>
            </>
          ) : (
            <>{field.selected ?? "aspect"}</>
          )}
        </button>
      )}
    </div>
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
  /** Submit: the bar resolves the live params to the {@link ParamValues} map
   *  `buildWorkflow` patches in (`resolveValues`, the #26 seam) and hands them
   *  up, so the queue (#27) owns the run while the bar owns the form. */
  onGenerate: (values: ParamValues) => void;
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
  // The live params form (#26). Seed lives here because it's the one param the
  // bar mutates (shuffle) and it's model-agnostic, so it survives a model
  // switch; `edits` are the numeric overrides, dropped below when the model
  // changes because the new manifest's bounds make them meaningless.
  const [params, setParams] = useState<ParamState>(() => ({ seed: randomSeed(), edits: {} }));
  // Which chip's editing popover is open, by field key, or null for none.
  const [openChip, setOpenChip] = useState<string | null>(null);
  const chipsRef = useRef<HTMLDivElement>(null);

  // A model switch keeps the seed but clears the per-model edits and any open
  // editor — the previous model's steps/size mean nothing under new bounds.
  const selectedId = selected?.id ?? null;
  useEffect(() => {
    setParams((p) => ({ seed: p.seed, edits: {} }));
    setOpenChip(null);
  }, [selectedId]);

  // Click-away closes the open chip editor. Pointerdown (not click) so a press
  // that starts outside dismisses before it can steal focus from the input.
  useEffect(() => {
    if (openChip === null) return;
    const onDown = (e: PointerEvent) => {
      if (!chipsRef.current?.contains(e.target as Node)) setOpenChip(null);
    };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, [openChip]);

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

  const shuffleSeed = () => setParams((p) => ({ ...p, seed: randomSeed() }));
  const setNumber = (name: string, value: number) => {
    if (name === "seed") {
      setParams((p) => ({ ...p, seed: Math.max(0, Math.round(value)) }));
    } else {
      setParams((p) => ({ ...p, edits: { ...p.edits, [name]: value } }));
    }
  };
  const setAspect = (option: AspectOption) => {
    setParams((p) => ({ ...p, edits: { ...p.edits, width: option.width, height: option.height } }));
    setOpenChip(null);
  };

  const fields = selected ? fieldsFor(selected, params) : [];
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
          if (!generateDisabled && selected) onGenerate(resolveValues(selected, params, prompt));
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

        {/* Param chips — the manifest-driven params form (#26): editable in
            place, feeding buildWorkflow() through `resolveValues`. */}
        {fields.length > 0 && (
          <div ref={chipsRef} className="flex gap-[7px]">
            {fields.map((field) => {
              const key = fieldKey(field);
              return (
                <ParamChip
                  key={key}
                  field={field}
                  open={openChip === key}
                  onToggle={() => setOpenChip((cur) => (cur === key ? null : key))}
                  onNumber={setNumber}
                  onAspect={setAspect}
                  onShuffle={shuffleSeed}
                />
              );
            })}
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
