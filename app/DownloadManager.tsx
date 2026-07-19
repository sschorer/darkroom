/**
 * The download manager (#21): install a model's weights from a clean state,
 * without a terminal. One model, several files (a diffusion model, a text
 * encoder, a VAE); this shows the whole install as a single aggregate bar plus
 * the file in flight, with a live rate and ETA, and the resume/cancel the long
 * multi-gigabyte transfer needs.
 *
 * It leans entirely on the Rust manager (`downloads.rs`): the resumable verified
 * fetch, the per-file and batch progress, the cancel, and the on-disk state are
 * all its. This component is the view — it subscribes to progress only while its
 * own download runs (the event is app-global), reads install state from
 * {@link modelStatus} on mount and after every settle, and renders the current
 * phase. The visual pass is #31; this is legible, not yet styled.
 */
import { useCallback, useEffect, useState } from "react";

import {
  cancelDownload,
  downloadModel,
  modelStatus,
  onDownloadProgress,
  type DownloadProgress,
  type ModelStatus,
  etaSeconds,
} from "./lib/download";
import { formatBytes, formatDuration, formatRate } from "./lib/format";
import type { Manifest } from "./lib/registry.schema";

type State =
  | { phase: "checking" }
  | { phase: "idle"; status: ModelStatus }
  // `progress` is null from the click until the first event — a window that can
  // include the re-hash of a resumed `.part`, so the label must not imply bytes
  // are already moving. `cancelError` holds an inline message if a Cancel
  // request itself failed, while the download keeps running.
  | { phase: "downloading"; progress: DownloadProgress | null; cancelError?: string }
  // `status` is what we last knew, so a failed install can still show how far it
  // got; `null` only if the very first status read is what failed.
  | { phase: "failed"; status: ModelStatus | null; error: string };

export function DownloadManager({
  manifest,
  onStatusChange,
}: {
  manifest: Manifest;
  /** Called with each fresh {@link ModelStatus} read (mount and after every
   *  settle). The compose bar (#25) uses it to notice a model becoming installed
   *  without re-walking the disk itself. */
  onStatusChange?: (status: ModelStatus) => void;
}) {
  const [state, setState] = useState<State>({ phase: "checking" });
  const files = manifest.files;

  const refresh = useCallback(async () => {
    try {
      const status = await modelStatus(files);
      setState({ phase: "idle", status });
      onStatusChange?.(status);
    } catch (e) {
      setState({ phase: "failed", status: null, error: String(e) });
    }
  }, [files, onStatusChange]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const start = useCallback(() => {
    setState({ phase: "downloading", progress: null });
    void (async () => {
      // Subscribe before invoking: the opening events fire during the command,
      // which resolves only at the end. The functional update drops events that
      // arrive after we've left the downloading phase (a late one racing a
      // settle). Inside the try so a rejecting `listen()` lands on the failed
      // view like any other error rather than throwing past this caller.
      try {
        const unlisten = await onDownloadProgress((p) =>
          // Preserve any cancelError across updates so a failed-cancel notice
          // isn't wiped by the next progress tick before it can be read.
          setState((s) => (s.phase === "downloading" ? { ...s, progress: p } : s)),
        );
        try {
          // Both a completed install and a cancel resolve here; either way the
          // truth is now on disk, so re-read it rather than guess from the
          // outcome. A cancel leaves a resumable partial; a completion, an
          // installed model.
          await downloadModel(files);
          await refresh();
        } finally {
          unlisten();
        }
      } catch (e) {
        // Already actionable — the Rust side carries the §8.6 text (a checksum
        // mismatch, a full disk). Retry re-runs the install, which resumes.
        setState({ phase: "failed", status: null, error: String(e) });
      }
    })();
  }, [files, refresh]);

  const cancel = useCallback(() => {
    // The running `downloadModel` promise resolves `cancelled` and `refresh`
    // flips us back to a resumable idle, so the happy path needs no state change
    // here — the bar keeps moving until the download actually stops. But the
    // request itself can reject (the IPC failing), and swallowing that with a
    // bare `void` would leave the download running behind an unhandled rejection
    // and no sign the stop didn't take. Surface it inline, keeping the
    // downloading view: the retry is simply clicking Cancel again.
    void cancelDownload().catch((e) => {
      setState((s) =>
        s.phase === "downloading"
          ? { ...s, cancelError: `Couldn't stop the download: ${String(e)}. Try again.` }
          : s,
      );
    });
  }, []);

  return (
    <div className="w-full rounded border border-neutral-800 p-4">
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-sm font-medium text-neutral-100">{manifest.id}</span>
        <span className="text-xs text-neutral-500">
          {manifest.kind} · {manifest.license} · {formatBytes(totalBytes(manifest))}
        </span>
      </div>

      <div className="mt-3">
        <Body state={state} onStart={start} onCancel={cancel} onRetry={start} />
      </div>
    </div>
  );
}

function Body({
  state,
  onStart,
  onCancel,
  onRetry,
}: {
  state: State;
  onStart: () => void;
  onCancel: () => void;
  onRetry: () => void;
}) {
  switch (state.phase) {
    case "checking":
      return <p className="text-xs text-neutral-500">Checking what's downloaded…</p>;

    case "downloading":
      return (
        <Downloading
          progress={state.progress}
          cancelError={state.cancelError}
          onCancel={onCancel}
        />
      );

    case "failed":
      return (
        <div className="flex flex-col gap-2">
          <pre className="max-h-48 w-full overflow-auto whitespace-pre-wrap rounded bg-neutral-900 p-3 text-left text-xs text-red-300">
            {state.error}
          </pre>
          <Button onClick={onRetry}>Try again</Button>
        </div>
      );

    case "idle": {
      const { status } = state;
      if (status.installed) {
        return (
          <div className="flex items-center gap-2 text-sm text-neutral-300">
            <span className="h-2 w-2 rounded-full bg-[var(--color-safelight)]" />
            Installed
          </div>
        );
      }
      const resuming = status.downloaded > 0;
      return (
        <div className="flex flex-col gap-2">
          {resuming && (
            <p className="text-xs text-neutral-500">
              {formatBytes(status.downloaded)} of {formatBytes(status.total)} already downloaded.
            </p>
          )}
          <Button onClick={onStart}>{resuming ? "Resume download" : "Download"}</Button>
        </div>
      );
    }
  }
}

/** The live install: an aggregate bar, the file in flight, rate and ETA. */
function Downloading({
  progress,
  cancelError,
  onCancel,
}: {
  progress: DownloadProgress | null;
  cancelError?: string;
  onCancel: () => void;
}) {
  if (!progress) {
    return (
      <div className="flex flex-col gap-3">
        <p className="text-xs text-neutral-500">Starting the download…</p>
        {cancelError && <p className="text-xs text-amber-400">{cancelError}</p>}
        <Button onClick={onCancel} tone="ghost">
          Cancel
        </Button>
      </div>
    );
  }

  const eta = etaSeconds(progress.batch_received, progress.batch_total, progress.bytes_per_sec);
  const verifying = progress.phase === "verifying";

  return (
    <div className="flex flex-col gap-3">
      {/* Aggregate: the whole model, one bar. */}
      <div className="flex flex-col gap-1">
        <Bar
          received={progress.batch_received}
          total={progress.batch_total}
          label="Overall download progress"
        />
        <div className="flex justify-between text-xs tabular-nums text-neutral-500">
          <span>
            {formatBytes(progress.batch_received)} of {formatBytes(progress.batch_total)}
          </span>
          <span>
            {verifying
              ? "Verifying…"
              : `${formatRate(progress.bytes_per_sec)} · ${formatDuration(eta ?? NaN)} left`}
          </span>
        </div>
      </div>

      {/* The file in flight. `aria-live` announces the step that actually
          matters to a screen reader — which file, and the switch to verifying —
          rather than the rate, which ticks 4×/s and would flood the queue. The
          bars carry the numeric progress via their progressbar role. */}
      <div className="flex flex-col gap-1">
        <div className="flex justify-between text-xs text-neutral-400" aria-live="polite">
          <span className="truncate">
            File {progress.file_index + 1} of {progress.file_count}: {baseName(progress.file)}
          </span>
          {verifying && <span className="text-amber-400">re-checking</span>}
        </div>
        <Bar
          received={progress.received}
          total={progress.total}
          label={`Downloading ${baseName(progress.file)}`}
        />
      </div>

      {cancelError && <p className="text-xs text-amber-400">{cancelError}</p>}

      <Button onClick={onCancel} tone="ghost">
        Cancel
      </Button>
    </div>
  );
}

/** The last path segment of a manifest `dest`, for a readable file name. */
function baseName(dest: string): string {
  const parts = dest.split("/");
  return parts[parts.length - 1] || dest;
}

/** Sum of every file's declared size. */
function totalBytes(manifest: Manifest): number {
  return manifest.files.reduce((sum, f) => sum + f.size, 0);
}

/**
 * A determinate bar when the total is known, an indeterminate shimmer when not.
 * `role="progressbar"` with the value attributes exposes the progress to
 * assistive technology; when indeterminate the value attributes are omitted, the
 * ARIA convention for "unknown progress".
 */
function Bar({ received, total, label }: { received: number; total: number; label: string }) {
  const pct = total > 0 ? Math.min(100, (received / total) * 100) : null;
  return (
    <div
      className="h-1.5 w-full overflow-hidden rounded-full bg-neutral-800"
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={pct == null ? undefined : total}
      aria-valuenow={pct == null ? undefined : Math.round(received)}
      aria-valuetext={pct == null ? undefined : `${Math.round(pct)}%`}
    >
      <div
        className={`h-full bg-neutral-100 transition-[width] duration-200 ${pct == null ? "w-1/3 animate-pulse" : ""}`}
        style={pct == null ? undefined : { width: `${pct}%` }}
      />
    </div>
  );
}

function Button({
  children,
  onClick,
  tone,
}: {
  children: React.ReactNode;
  onClick: () => void;
  tone?: "ghost";
}) {
  const styles =
    tone === "ghost"
      ? "border border-neutral-700 text-neutral-300 hover:bg-neutral-800"
      : "bg-neutral-100 text-neutral-900 hover:bg-white";
  return (
    <button
      onClick={onClick}
      className={`self-start rounded px-3 py-1.5 text-sm font-medium ${styles}`}
    >
      {children}
    </button>
  );
}
