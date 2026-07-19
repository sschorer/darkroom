/**
 * The generation queue (#27): the Studio's list of jobs, run **one at a time**
 * against the single loopback engine (ADR-007). A submit appends a job; a pump
 * picks the oldest queued one, builds its workflow, and runs it to pixels;
 * cancel either drops a not-yet-started job or interrupts the running one.
 *
 * Sequential, not parallel, and deliberately so: one user, one GPU: two prompts
 * sampling at once would each run at half speed and risk an OOM the VRAM gate
 * (§8.5) sized for one model. So the queue is a FIFO with a single in-flight
 * slot, and the compose bar can keep queuing while one runs.
 *
 * This is a React hook, not a pure controller, because its whole job is to hold
 * state the Studio renders — the grid's live tile and the rail's summary both
 * read {@link Queue.jobs}. The *engine* conversation it drives is the tested,
 * headless {@link runGeneration}; this owns only the list, the ordering, and the
 * one-at-a-time discipline. The seam the bar feeds it is a {@link QueueRequest}
 * built from `resolveValues()` — the manifest-driven params (#26) made concrete.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  GenerationCancelled,
  GenerationFailed,
  runGeneration,
  type GenerateProgress,
  type GenerationFailure,
} from "./generate";
import type { Manifest } from "./registry.schema";
import { workflowFor } from "./registry";
import { buildWorkflow, type ParamValues } from "./workflow";

/** A job's lifecycle. `queued` waits its turn; `generating` is the one in-flight
 *  slot (its `progress` null until the first sampling step); `done` holds the
 *  finished image's `blob:` URL and how long the run took (the preview's `6.2s`
 *  recipe chip, #28); `failed` keeps the run's structured reason — the node that
 *  threw and why — which the error banner and failed tile render (#29). A
 *  cancelled job leaves the list entirely rather than reaching a state here. */
export type JobStatus =
  | { phase: "queued" }
  | { phase: "generating"; progress: GenerateProgress | null }
  | { phase: "done"; imageUrl: string; elapsedMs: number }
  | { phase: "failed"; error: GenerationFailure };

/** One entry in the queue: the model, the prompt, the resolved param `values`,
 *  and its live status. The model's untouched workflow is loaded and patched
 *  (`workflowFor` × `buildWorkflow`) at run time, not at submit, so a stale
 *  manifest or a missing workflow fails loudly then, as a failed tile (ADR-005). */
export interface Job {
  id: string;
  manifest: Manifest;
  prompt: string;
  values: ParamValues;
  status: JobStatus;
}

/** What the compose bar hands to {@link Queue.enqueue}: a model, the prompt, and
 *  the resolved param values. The queue assigns the id and the initial `queued`
 *  status, and locates the model's workflow itself when the job runs. */
export interface QueueRequest {
  manifest: Manifest;
  prompt: string;
  values: ParamValues;
}

/** The rail's live read of the queue (#53): how many jobs are active, the
 *  running one's prompt and progress, and what's waiting behind it. Derived, so
 *  the rail renders it without knowing the job model. */
export interface QueueSummary {
  /** Queued + the one generating — what the rail's `Queue · N` counts. */
  active: number;
  /** The in-flight job, or null when nothing is running. */
  generating: { prompt: string; progress: GenerateProgress | null } | null;
  /** Everything still waiting: the count and the next one's prompt. */
  queued: { count: number; nextPrompt: string | null };
}

/** The hook's surface: the job list (submission order, oldest first), the two
 *  commands, and the derived rail summary. */
export interface Queue {
  jobs: Job[];
  enqueue: (request: QueueRequest) => void;
  cancel: (id: string) => void;
  /** Re-runs a failed job: drops its failed tile and queues the same request
   *  afresh. The "↻ retry" on the failed tile and the banner's "generate again"
   *  (#29). A no-op on a job that isn't failed. */
  retry: (id: string) => void;
  summary: QueueSummary;
}

/** Frees the `blob:` URL a done job holds. The browser keeps the bytes alive
 *  until this is called, so a removed or unmounted done tile leaks without it. */
function revoke(job: Job): void {
  if (job.status.phase === "done") {
    URL.revokeObjectURL(job.status.imageUrl);
  }
}

/**
 * The generation queue for one Studio session. Jobs live only as long as the
 * Studio is mounted (persistence to the library is #28); leaving the screen
 * cancels the run and frees its images.
 */
export function useQueue(): Queue {
  const [jobs, setJobs] = useState<Job[]>([]);

  // The single in-flight slot. `runningId` is which job holds it (so cancel can
  // tell the running job from a queued one); `abort` cancels it. Refs, not
  // state: the pump reads them synchronously to stay one-at-a-time, and they
  // must not themselves trigger a render.
  const runningId = useRef<string | null>(null);
  const abort = useRef<AbortController | null>(null);

  // A mirror of `jobs` the unmount cleanup can read without re-subscribing on
  // every change — assigned during render, which is safe for a ref.
  const jobsRef = useRef(jobs);
  jobsRef.current = jobs;

  const setStatus = useCallback((id: string, status: JobStatus) => {
    setJobs((js) => js.map((job) => (job.id === id ? { ...job, status } : job)));
  }, []);

  // The pump. Runs on every `jobs` change: if the in-flight slot is free and a
  // job is waiting, it takes the slot and runs. A `jobs` change is also what
  // *frees* the slot (a done/failed status write, or a cancel's removal), so
  // settling one job re-runs this and starts the next — no explicit "next" call.
  // The `runningId` guard makes the frequent progress-driven re-runs no-ops.
  useEffect(() => {
    if (runningId.current !== null) return;
    const next = jobs.find((job) => job.status.phase === "queued");
    if (!next) return;

    runningId.current = next.id;
    const controller = new AbortController();
    abort.current = controller;
    setStatus(next.id, { phase: "generating", progress: null });

    // When sampling began, so the finished job can report its wall-clock time as
    // the preview's `6.2s` recipe chip (#28). Started here, when the slot is
    // taken, so it measures the run the user waited on — not the queue wait.
    const started = Date.now();

    void (async () => {
      try {
        // Manifest × workflow meet here, not at submit: a missing workflow or a
        // manifest gone stale against its nodes throws now (ADR-005) — a failed
        // tile — rather than at the pixels.
        const workflow = buildWorkflow(next.manifest, workflowFor(next.manifest), next.values);
        const imageUrl = await runGeneration(workflow, {
          signal: controller.signal,
          onProgress: (progress) =>
            // Only patch progress onto a job still generating — a late tick
            // racing a cancel or completion must not resurrect its tile.
            setJobs((js) =>
              js.map((job) =>
                job.id === next.id && job.status.phase === "generating"
                  ? { ...job, status: { phase: "generating", progress } }
                  : job,
              ),
            ),
        });
        setStatus(next.id, { phase: "done", imageUrl, elapsedMs: Date.now() - started });
      } catch (error) {
        if (error instanceof GenerationCancelled) {
          // A cancel drops the tile entirely — there is nothing to show for a
          // run the user called off.
          setJobs((js) => js.filter((job) => job.id !== next.id));
        } else {
          // runGeneration settles a real failure as a structured GenerationFailed;
          // anything else reaching here (a buildWorkflow throw before the run, an
          // engine that never spawned) has no node to blame, so it becomes a
          // transport-level failure carrying just its message (§8.6).
          const failure: GenerationFailure =
            error instanceof GenerationFailed
              ? error.failure
              : {
                  nodeType: null,
                  nodeId: null,
                  promptId: null,
                  message: error instanceof Error ? error.message : String(error),
                };
          setStatus(next.id, { phase: "failed", error: failure });
        }
      } finally {
        // Free the slot *after* the settling setJobs above: that state change is
        // what re-runs the pump, which then finds the slot free and takes the
        // next job.
        if (runningId.current === next.id) {
          runningId.current = null;
          abort.current = null;
        }
      }
    })();
  }, [jobs, setStatus]);

  // Cancel the running job on unmount (leaving the Studio ends its run) and free
  // every finished image. Empty deps so it runs only at unmount; the latest jobs
  // come from `jobsRef` rather than re-subscribing this effect on every change.
  useEffect(() => {
    return () => {
      abort.current?.abort();
      jobsRef.current.forEach(revoke);
    };
  }, []);

  const enqueue = useCallback((request: QueueRequest) => {
    setJobs((js) => [...js, { id: crypto.randomUUID(), status: { phase: "queued" }, ...request }]);
  }, []);

  const retry = useCallback((id: string) => {
    // Replace the failed tile with a fresh queued job (a new id, so the pump and
    // the preview treat it as the new run it is) built from the same request. The
    // pump picks it up on the next `jobs` change like any enqueue.
    setJobs((js) => {
      const job = js.find((j) => j.id === id);
      if (!job || job.status.phase !== "failed") return js;
      const fresh: Job = {
        id: crypto.randomUUID(),
        manifest: job.manifest,
        prompt: job.prompt,
        values: job.values,
        status: { phase: "queued" },
      };
      return [...js.filter((j) => j.id !== id), fresh];
    });
  }, []);

  const cancel = useCallback((id: string) => {
    // The running job is interrupted through its signal; its own catch removes
    // the tile once the engine has actually stopped. A queued or settled job is
    // just dropped here (revoking a done image on the way out).
    if (runningId.current === id) {
      abort.current?.abort();
      return;
    }
    setJobs((js) => {
      const job = js.find((j) => j.id === id);
      if (job) revoke(job);
      return js.filter((j) => j.id !== id);
    });
  }, []);

  const summary = useMemo<QueueSummary>(() => {
    const generating = jobs.find((job) => job.status.phase === "generating");
    const queued = jobs.filter((job) => job.status.phase === "queued");
    return {
      active: (generating ? 1 : 0) + queued.length,
      generating:
        generating && generating.status.phase === "generating"
          ? { prompt: generating.prompt, progress: generating.status.progress }
          : null,
      queued: { count: queued.length, nextPrompt: queued[0]?.prompt ?? null },
    };
  }, [jobs]);

  return { jobs, enqueue, cancel, retry, summary };
}
