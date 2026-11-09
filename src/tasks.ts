import path from "node:path";
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import {
  askCline, ClineRunError, formatErrorAsText, requireSelection,
  type AskClineInput, type ClineInvocationOptions, type ClineResponse
} from "./runner.js";
import { askClineWorkspace } from "./workspace.js";
import { applyClineEdits } from "./edits.js";
import { resolveTraceBase, type TraceInfo, type TraceRecorder, type TraceStatus } from "./trace.js";

export type TaskMode = "ask" | "workspace" | "edits";
export type TaskState = "running" | "done" | "failed" | "cancelled";

export interface StartTaskInput {
  mode: TaskMode;
  prompt: string;
  provider: string;
  model: string;
  cwd?: string;
  thinking?: AskClineInput["thinking"];
  timeoutSeconds?: number;
}

/** Async tasks may run longer than the sync tools' 300 s. */
export const MAX_TASK_TIMEOUT_SECONDS = 1800;
export const DEFAULT_TASK_TIMEOUT_SECONDS = 600;
export const MAX_RUNNING_TASKS = 2;
/** Settled tasks whose result was never collected are dropped after this long (their trace stays until its TTL). */
export const UNCOLLECTED_TTL_MS = 60 * 60 * 1000;
export const MAX_SETTLED_TASKS = 20;
export const MAX_WAIT_SECONDS = 60;

type Runner = (input: any, signal: AbortSignal, options: Partial<ClineInvocationOptions>) => Promise<ClineResponse & Record<string, unknown>>;

export interface TaskManagerDeps {
  runners?: Partial<Record<TaskMode, Runner>>;
  wallNow?: () => number;
  traceBase?: string;
  /** Extra runner options (tests inject runner deps here). */
  runOptions?: Partial<ClineInvocationOptions>;
}

interface Task {
  id: string;
  mode: TaskMode;
  state: TaskState;
  startedAt: number;
  endedAt?: number;
  controller: AbortController;
  recorder?: TraceRecorder;
  trace: TraceInfo;
  result?: ClineResponse & Record<string, unknown>;
  error?: unknown;
  settled: Promise<void>;
  /** The question last returned to a status call, so a long poll returns again only for a new one. */
  reportedQuestion?: string;
}

/** What model-picker's log_run needs; null when the run must not be logged (cancelled by the caller). */
export interface LogRunHint { ok: boolean; error_kind?: "timeout" | "quota" | "crash"; retry_after_s?: number; error_text?: string; duration_s: number; }

export interface TaskStatusView {
  taskId: string;
  mode: TaskMode;
  state: TaskState;
  elapsedMs: number;
  /** Live progress from the trace: attempt, step, current tool, last complete reasoning, files, question. */
  progress?: Omit<TraceStatus, "runId" | "pid" | "state" | "startedAt" | "updatedAt" | "elapsedMs">;
  error?: string;
  resultReady: boolean;
  trace: TraceInfo;
}

const runnerDefaults: Record<TaskMode, Runner> = {
  ask: (input, signal, options) => askCline(input, signal, options) as any,
  workspace: (input, signal, options) => askClineWorkspace(input, signal, options) as any,
  edits: (input, signal, options) => applyClineEdits(input, signal, options) as any
};

/**
 * Failures that happen before Cline talks to the model, or in the bridge around the run (bad cwd, Git setup,
 * settings lock, launch, cleanup): model-picker must not count them against the model.
 */
const LOCAL_FAILURE_KINDS = new Set([
  "workspace_not_git", "workspace_setup_failed", "workspace_cleanup_failed", "settings_lock_timeout",
  "settings_restore_failed", "launch_failed", "catalog_unavailable", "edits_inspection_failed", "cline_updating",
  "task_limit", "task_not_found", "task_running"
]);

function noteFor(task: Task): string | undefined {
  if (task.state === "cancelled") return "Cancelled by the caller: do not log.";
  if (task.error instanceof ClineRunError && LOCAL_FAILURE_KINDS.has(task.error.kind)) {
    return `Local failure (${task.error.kind}), not a model run: do not log.`;
  }
  return undefined;
}

/** The error as text without its trace line (the task view carries the trace); notes after it are kept. */
function errorText(error: unknown): string {
  return formatErrorAsText(error, "The task failed.").replace(/\n\nTrace: [^\n]*/g, "");
}

function hintFor(task: Task): LogRunHint | null {
  const duration_s = Math.round(((task.endedAt ?? Date.now()) - task.startedAt) / 100) / 10;
  if (task.state === "done") return { ok: true, duration_s };
  if (noteFor(task)) return null;
  const err = task.error;
  if (err instanceof ClineRunError) {
    const text = err.message.split(/\r?\n/)[0].slice(0, 300);
    if (err.kind === "quota_exhausted" || err.providerState === "rate_limited" || err.providerState === "quota_exhausted") {
      return { ok: false, error_kind: "quota", ...(err.retryAfterSeconds ? { retry_after_s: err.retryAfterSeconds } : {}), error_text: text, duration_s };
    }
    if (err.kind === "timeout") return { ok: false, error_kind: "timeout", error_text: text, duration_s };
    return { ok: false, error_kind: "crash", error_text: text, duration_s };
  }
  return { ok: false, error_kind: "crash", error_text: String((err as Error)?.message ?? err).slice(0, 300), duration_s };
}

/**
 * In-process async Cline tasks. Each task is one run with a live trace (task id = trace run id), no
 * automatic retry, and a longer timeout cap than the sync tools. At most MAX_RUNNING_TASKS run at once.
 */
export class TaskManager {
  private readonly tasks = new Map<string, Task>();
  private closing = false;
  private readonly runners: Record<TaskMode, Runner>;
  private readonly wallNow: () => number;

  constructor(private readonly deps: TaskManagerDeps = {}) {
    this.runners = { ...runnerDefaults, ...deps.runners };
    this.wallNow = deps.wallNow ?? Date.now;
  }

  private running(): Task[] { return [...this.tasks.values()].filter(t => t.state === "running"); }

  /** Drops settled, uncollected tasks that are too old or beyond the retention count. */
  private prune(): void {
    const now = this.wallNow();
    const settled = [...this.tasks.values()].filter(t => t.state !== "running").sort((a, b) => (a.endedAt ?? 0) - (b.endedAt ?? 0));
    for (const t of settled) if (now - (t.endedAt ?? now) > UNCOLLECTED_TTL_MS) this.tasks.delete(t.id);
    const rest = settled.filter(t => this.tasks.has(t.id));
    for (const t of rest.slice(0, Math.max(0, rest.length - MAX_SETTLED_TASKS))) this.tasks.delete(t.id);
  }

  start(input: StartTaskInput): TaskStatusView {
    if (this.closing) throw new ClineRunError("cancelled", "The bridge is shutting down; no new tasks start.", { attempts: 0 });
    requireSelection(input);
    if ((input.mode === "workspace" || input.mode === "edits") && !input.cwd) {
      throw new ClineRunError("launch_failed", `mode "${input.mode}" requires cwd (a Git repository path).`, { attempts: 0 });
    }
    this.prune();
    if (this.running().length >= MAX_RUNNING_TASKS) {
      throw new ClineRunError("task_limit", `At most ${MAX_RUNNING_TASKS} Cline tasks run at once; ` +
        `wait for one to finish (cline_status) or cancel one (cline_cancel).`, { attempts: 0 });
    }
    const id = randomUUID();
    const dir = path.join(resolveTraceBase(this.deps.traceBase), id);
    const task: Task = {
      id, mode: input.mode, state: "running", startedAt: this.wallNow(), controller: new AbortController(),
      trace: { runId: id, dir, events: path.join(dir, "events.ndjson"), status: path.join(dir, "status.json") },
      settled: Promise.resolve()
    };
    const { mode, ...runInput } = input;
    const options: Partial<ClineInvocationOptions> = {
      ...this.deps.runOptions,
      trace: true, traceRunId: id, maxAttempts: 1, maxTimeoutSeconds: MAX_TASK_TIMEOUT_SECONDS,
      onTraceStart: recorder => { task.recorder = recorder; }
    };
    if (this.deps.traceBase) options.deps = { ...options.deps, traceBase: this.deps.traceBase };
    let run: Promise<ClineResponse & Record<string, unknown>>;
    try {
      run = this.runners[mode]({ ...runInput, timeoutSeconds: input.timeoutSeconds ?? DEFAULT_TASK_TIMEOUT_SECONDS },
        task.controller.signal, options);
    } catch (err) {
      run = Promise.reject(err);
    }
    // Every rejection is handled here; the background promise can never become unhandled.
    task.settled = run.then(
      result => { task.result = result; task.state = "done"; },
      err => {
        task.error = err;
        task.state = err instanceof ClineRunError && err.kind === "cancelled" ? "cancelled" : "failed";
      }
    ).finally(() => { task.endedAt = this.wallNow(); });
    this.tasks.set(id, task);
    return this.view(task);
  }

  private get(taskId: string): Task {
    const task = this.tasks.get(taskId);
    if (!task) throw new ClineRunError("task_not_found", `No task ${taskId}: it never existed, its result was already collected, or it expired.`, { attempts: 0 });
    return task;
  }

  private view(task: Task): TaskStatusView {
    const snap = task.recorder?.snapshot();
    let progress: TaskStatusView["progress"];
    if (snap) {
      const { runId: _r, pid: _p, state: _s, startedAt: _a, updatedAt: _u, elapsedMs: _e, ...rest } = snap;
      progress = rest;
    }
    return {
      taskId: task.id, mode: task.mode, state: task.state,
      elapsedMs: (task.endedAt ?? this.wallNow()) - task.startedAt,
      ...(progress ? { progress } : {}),
      ...(task.state === "failed" || task.state === "cancelled" ? { error: errorText(task.error).slice(0, 2000) } : {}),
      resultReady: task.state !== "running",
      trace: task.trace
    };
  }

  /**
   * Long poll: returns as soon as the task settles or Cline asks a question not yet reported, otherwise
   * after waitSeconds (max 60). waitSeconds 0 returns immediately.
   */
  async status(taskId: string, waitSeconds = 0, pollMs = 250): Promise<TaskStatusView> {
    const task = this.get(taskId);
    const deadline = Date.now() + Math.min(Math.max(0, waitSeconds), MAX_WAIT_SECONDS) * 1000;
    const newQuestion = () => {
      const q = task.recorder?.snapshot().question?.question;
      return q !== undefined && q !== task.reportedQuestion ? q : undefined;
    };
    while (task.state === "running" && !newQuestion() && Date.now() < deadline) {
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([task.settled, new Promise<void>(resolve => { timer = setTimeout(resolve, Math.min(pollMs, Math.max(1, deadline - Date.now()))); })]);
      if (timer) clearTimeout(timer);
    }
    const q = newQuestion();
    if (q !== undefined) task.reportedQuestion = q;
    return this.view(task);
  }

  /** Stops the task's Cline process and waits briefly for it to settle. */
  async cancel(taskId: string, waitMs = 5000): Promise<TaskStatusView> {
    const task = this.get(taskId);
    if (task.state === "running") {
      task.controller.abort();
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([task.settled, new Promise<void>(resolve => { timer = setTimeout(resolve, waitMs); })]);
      if (timer) clearTimeout(timer);
    }
    return this.view(task);
  }

  /** Final result of a settled task. Removes the task and, unless keepTrace, its trace folder. */
  async result(taskId: string, keepTrace = false): Promise<{ state: TaskState; result?: Record<string, unknown>; error?: string;
    log_run_hint: LogRunHint | null; log_run_note?: string; trace?: TraceInfo }> {
    const task = this.get(taskId);
    if (task.state === "running") {
      throw new ClineRunError("task_running", `Task ${taskId} is still running; use cline_status (it can wait up to ${MAX_WAIT_SECONDS} s).`, { attempts: 0 });
    }
    const hint = hintFor(task);
    const out = {
      state: task.state,
      ...(task.result ? { result: { ...task.result, trace: undefined } } : {}),
      ...(task.error !== undefined ? { error: errorText(task.error) } : {}),
      log_run_hint: hint,
      ...(noteFor(task) ? { log_run_note: noteFor(task) } : {}),
      ...(keepTrace ? { trace: task.trace } : {})
    };
    this.tasks.delete(taskId);
    if (!keepTrace) {
      // Stop queued writes, then let one in progress land, so nothing recreates the folder after removal.
      task.recorder?.close();
      await task.recorder?.idle();
      await rm(task.trace.dir, { recursive: true, force: true, maxRetries: 3 }).catch(() => {});
    }
    return out;
  }

  /** Cancels every running task (bridge shutdown) and waits up to waitMs for them to settle. */
  async shutdown(waitMs = 3000): Promise<void> {
    this.closing = true;
    const running = this.running();
    for (const t of running) t.controller.abort();
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([Promise.allSettled(running.map(t => t.settled)), new Promise<void>(resolve => { timer = setTimeout(resolve, waitMs); })]);
    if (timer) clearTimeout(timer);
  }
}
