import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { rm } from "node:fs/promises";
import {
  askCline, ClineRunError, defaultKillTree, formatErrorAsText, redactSecrets, requireSelection,
  resolveClineEntry, windowsCommandLineLength, WINDOWS_COMMAND_LINE_LIMIT, NO_TOOLS_PREAMBLE,
  MAX_SYSTEM_PROMPT_CHARACTERS, MAX_TOTAL_TEXT_CHARACTERS,
  type AskClineInput, type ClineInvocationOptions, type ClineResponse
} from "./runner.js";
import { formatReportSummary, type GuardOptions, type GuardReport } from "./guard.js";
import { askClineWorkspace, buildWorkspaceSystemPrompt, WORKTREE_BASE } from "./workspace.js";
import { applyClineEdits, buildEditSystemPrompt, editsCheckoutRoot, runClineEditStep } from "./edits.js";
import { acquire, type CheckoutRelease } from "./checkoutlock.js";
import { resolveTraceBase, type TraceInfo, type TraceRecorder, type TraceStatus } from "./trace.js";
import { takeSnapshot, restoreSnapshot, discardSnapshot, headAndIndexIdentity, type SnapshotOptions } from "./snapshot.js";
import { runVerification } from "./verify.js";
import { buildStepPrompt, startTaskSchema, sumUsage, type StepDefinition, type PlanView, type PlanOutcome,
  type StepAction, type StepExecution, type WaitReason } from "./steps.js";

export type TaskMode = "ask" | "workspace" | "edits";
export type TaskState = "running" | "resuming" | "done" | "failed" | "cancelled" | "input_required";

export interface StartTaskInput {
  mode: TaskMode;
  prompt: string;
  provider: string;
  model: string;
  cwd?: string;
  thinking?: AskClineInput["thinking"];
  timeoutSeconds?: number;
  guard?: GuardOptions;
  codeMap?: boolean;
  steps?: StepDefinition[];
}

/** Async tasks may run longer than the sync tools' 300 s. */
export const MAX_TASK_TIMEOUT_SECONDS = 1800;
export const DEFAULT_TASK_TIMEOUT_SECONDS = 600;
export const MAX_RUNNING_TASKS = 2;
/** Settled tasks whose result was never collected are dropped after this long (their trace stays until its TTL). */
export const UNCOLLECTED_TTL_MS = 60 * 60 * 1000;
export const MAX_SETTLED_TASKS = 20;
export const MAX_WAIT_SECONDS = 60;

export const TASK_QUESTION_PREAMBLE =
  "[Bridge note: never use the ask_question tool. If you need information from the user to continue, " +
  "stop and end your final answer with a line QUESTION: <one question> and optionally a following line " +
  "OPTIONS: a | b | c.]\n\n";

export function getEffectivePreamble(mode: TaskMode, customPreamble = ""): string {
  const base = customPreamble + TASK_QUESTION_PREAMBLE;
  return mode === "ask" ? base + NO_TOOLS_PREAMBLE : base;
}

export interface TaskQA {
  question: string;
  answer: string;
  options?: string[];
}

type Runner = (input: any, signal: AbortSignal, options: Partial<ClineInvocationOptions>) => Promise<ClineResponse & Record<string, unknown>>;

export interface TaskManagerDeps {
  runners?: Partial<Record<TaskMode, Runner>>;
  wallNow?: () => number;
  traceBase?: string;
  /** Extra runner options (tests inject runner deps here). */
  runOptions?: Partial<ClineInvocationOptions>;
  gitDiffStat?: (cwd: string, signal?: AbortSignal) => Promise<string | undefined>;
  platform?: NodeJS.Platform;
  snapshotOptions?: SnapshotOptions;
  runVerification?: typeof runVerification;
}

export function parseQuestionFromText(text: string): { question: string; options?: string[] } | undefined {
  if (!text) return undefined;
  const lines = text.split(/\r?\n/);
  const nonEmpty = lines.filter(l => l.trim().length > 0);
  if (nonEmpty.length === 0) return undefined;

  const last = nonEmpty[nonEmpty.length - 1];
  const secondLast = nonEmpty.length >= 2 ? nonEmpty[nonEmpty.length - 2] : undefined;

  // Case A: Trailing non-empty lines are QUESTION then OPTIONS (at most 3 leading spaces, no tabs)
  if (/^ {0,3}OPTIONS:\s*(.+)$/i.test(last)) {
    if (secondLast && /^ {0,3}QUESTION:\s*(.+)$/i.test(secondLast)) {
      const qMatch = secondLast.match(/^ {0,3}QUESTION:\s*(.+)$/i);
      const optMatch = last.match(/^ {0,3}OPTIONS:\s*(.+)$/i);
      const question = qMatch?.[1]?.trim();
      if (!question) return undefined;

      const rawOptions = optMatch?.[1]
        ?.split("|")
        .map(s => s.trim())
        .filter(s => s.length > 0)
        .slice(0, 5);
      const options = rawOptions && rawOptions.length > 0 ? rawOptions : undefined;
      return { question, ...(options ? { options } : {}) };
    }
    return undefined;
  }

  // Case B: Trailing non-empty line is QUESTION (no OPTIONS) (at most 3 leading spaces, no tabs)
  if (/^ {0,3}QUESTION:\s*(.+)$/i.test(last)) {
    const qMatch = last.match(/^ {0,3}QUESTION:\s*(.+)$/i);
    const question = qMatch?.[1]?.trim();
    if (!question) return undefined;
    return { question };
  }

  // Any other trailing non-empty content (prose, closing fence, indented code, etc.) means no question
  return undefined;
}

export function minimumPrompt(latestQA: TaskQA, guardNotice?: string): string {
  const parts: string[] = [];
  if (guardNotice) {
    parts.push(guardNotice);
  }
  if (latestQA.question.trim()) parts.push(`Cline question:\n${latestQA.question.trim()}`);
  if (latestQA.options && latestQA.options.length > 0) {
    parts.push(`Options: ${latestQA.options.join(" | ")}`);
  }
  parts.push(`Caller answer:\n${latestQA.answer.trim()}`);
  return parts.join("\n\n");
}

export function formatGuardContext(params: {
  summary?: string;
  report?: GuardReport;
  compact?: boolean;
  maxErrors?: number;
  maxErrorLen?: number;
  includeAssistantText?: boolean;
  includeDetails?: boolean;
}): string | undefined {
  const summary = params.summary ?? (params.report ? formatReportSummary(params.report) : undefined);
  if (!summary && !params.report) return undefined;

  const sumText = summary || "loop or budget exceeded";
  const mainNotice = `Previous run was stopped by the bridge: ${sumText}; do not repeat the same failing action.`;

  if (params.compact || params.includeDetails === false || !params.report) {
    return mainNotice;
  }

  const r = params.report;
  const details: string[] = [];
  if (r.tool || r.target) {
    const parts = [r.tool ? `tool: ${r.tool}` : "", r.target ? `target: ${r.target}` : ""].filter(Boolean);
    details.push(`- Tool & target: ${parts.join(", ")}`);
  }
  if (r.lastErrors && r.lastErrors.length > 0) {
    const maxErrors = params.maxErrors ?? 3;
    const maxLen = params.maxErrorLen ?? 200;
    const errList = r.lastErrors.slice(-maxErrors).map(e => {
      const red = redactSecrets(e).trim();
      const truncated = red.length > maxLen ? red.slice(0, maxLen) + "..." : red;
      return `  * ${truncated}`;
    });
    details.push(`- Last errors:\n${errList.join("\n")}`);
  }
  if (r.filesTouched && r.filesTouched.length > 0) {
    details.push(`- Files touched: ${r.filesTouched.map(f => redactSecrets(f)).join(", ")}`);
  }
  if (params.includeAssistantText !== false && r.lastAssistantText) {
    const textRed = redactSecrets(r.lastAssistantText).trim();
    const excerpt = textRed.length > 400 ? textRed.slice(-400) : textRed;
    details.push(`- Last assistant text excerpt:\n${excerpt}`);
  }

  if (details.length > 0) {
    return `${mainNotice}\n\nGuard report:\n${details.join("\n")}`;
  }

  return mainNotice;
}

export function isPromptTooLarge(
  prompt: string,
  task: Task,
  preamble: string,
  platform: NodeJS.Platform = process.platform,
  deps?: { entryPath?: string },
  codeMap = ""
): boolean {
  if (prompt.length > 20_000) return true;
  // Workspace setup chooses a fresh path later; reserve a conservative worktree name for resume sizing.
  const effectiveCwd = task.mode === "workspace"
    ? path.join(WORKTREE_BASE, "w".repeat(64))
    : task.cwd ? path.resolve(task.cwd) : process.cwd();
  const sysPrompt = task.mode === "workspace" ? buildWorkspaceSystemPrompt(effectiveCwd, platform)
    : task.mode === "edits" ? buildEditSystemPrompt(effectiveCwd, platform) : undefined;
  if ((sysPrompt?.length ?? 0) > MAX_SYSTEM_PROMPT_CHARACTERS ||
      prompt.length + (sysPrompt?.length ?? 0) > MAX_TOTAL_TEXT_CHARACTERS) return true;
  if (platform === "win32") {
    const windowsEntry = resolveClineEntry(deps?.entryPath) ??
      (process.env.APPDATA ? path.join(process.env.APPDATA, "npm", "node_modules", "cline", "bin", "cline") : "C:\\npm\\node_modules\\cline\\bin\\cline");

    const args = [
      "--json",
      "--auto-approve", String(task.mode !== "ask"),
      "--thinking", task.thinking ?? "none",
      "--timeout", String(task.timeoutSeconds ?? 1800)
    ];
    if (task.provider) args.push("-P", task.provider);
    if (task.model) args.push("-m", task.model);
    if (sysPrompt) args.push("--system", sysPrompt);
    if (effectiveCwd) args.push("--cwd", effectiveCwd);
    // Maps are normally built after resume context is sized; callers with an existing map must count it too.
    args.push(codeMap + preamble + prompt);

    const spawnArgs = [windowsEntry, ...args];
    const len = windowsCommandLineLength(process.execPath, spawnArgs);
    if (len > WINDOWS_COMMAND_LINE_LIMIT) {
      return true;
    }
  }
  return false;
}

export function buildResumedPrompt(params: {
  originalPrompt: string;
  previousAnswer: string;
  diffStat?: string;
  qaHistory: TaskQA[];
  task: Task;
  preamble: string;
  guardReportSummary?: string;
  guardReport?: GuardReport;
  platform?: NodeJS.Platform;
  deps?: { entryPath?: string };
  /** Additional room required by an enclosing step prompt; mandatory Q&A still cannot be truncated. */
  fits?: (prompt: string) => boolean;
}): string {
  const platform = params.platform ?? process.platform;
  const tooLarge = (prompt: string) => isPromptTooLarge(prompt, params.task, params.preamble, platform, params.deps) || params.fits?.(prompt) === false;
  const history = params.qaHistory;
  if (history.length === 0) {
    throw new ClineRunError("launch_failed", "No question/answer history to resume from.", { attempts: 0 });
  }

  const latestQA = history[history.length - 1];
  let priorQAs = history.slice(0, -1);

  const guardReport = params.guardReport ?? params.task.guardReport;
  const guardSummary = params.guardReportSummary ?? params.task.guardReportSummary ?? (guardReport ? formatReportSummary(guardReport) : undefined);
  const minGuardNotice = (guardSummary || guardReport)
    ? "Previous run was stopped by the bridge: loop or budget exceeded; do not repeat the same failing action."
    : undefined;

  // Reserve room for mandatory guard notice before checking the minimum
  if (tooLarge(minimumPrompt(latestQA, minGuardNotice))) {
    throw new ClineRunError("launch_failed", "The question and caller answer together exceed the prompt or command line limit.", { attempts: 0 });
  }

  let prev = params.previousAnswer.trim();
  let diff = params.diffStat?.trim();
  let orig = params.originalPrompt.trim();

  const formatQA = (priors: TaskQA[], latest: TaskQA): string => {
    const parts: string[] = [];
    for (const item of priors) {
      const q = item.question.trim();
      const a = item.answer.trim();
      if (q) parts.push(`Previous question:\n${q}`);
      if (item.options && item.options.length > 0) {
        parts.push(`Options: ${item.options.join(" | ")}`);
      }
      parts.push(`Previous answer:\n${a}`);
    }
    if (latest.question.trim()) parts.push(`Cline question:\n${latest.question.trim()}`);
    if (latest.options && latest.options.length > 0) {
      parts.push(`Options: ${latest.options.join(" | ")}`);
    }
    parts.push(`Caller answer:\n${latest.answer.trim()}`);
    return parts.join("\n\n");
  };

  let guardBlock = formatGuardContext({ summary: guardSummary, report: guardReport });

  const assemble = (o: string, p: string, d: string | undefined, priors: TaskQA[], gBlock: string | undefined): string => {
    const parts: string[] = [];
    if (o) parts.push(`Original task:\n${o}`);
    if (p) parts.push(`Previous answer (what was done so far):\n${p}`);
    if (d) parts.push(`Working directory diff stat:\n${d}`);
    if (gBlock) parts.push(gBlock);
    parts.push(formatQA(priors, latestQA));
    return parts.join("\n\n");
  };

  let candidate = assemble(orig, prev, diff, priorQAs, guardBlock);
  if (!tooLarge(candidate)) {
    return candidate;
  }

  // Step 1: Trim diffStat and previousAnswer first (keep tail of previous answer)
  if (diff && tooLarge(candidate)) {
    diff = diff.slice(0, 500);
    candidate = assemble(orig, prev, diff, priorQAs, guardBlock);
    if (tooLarge(candidate)) {
      diff = undefined;
      candidate = assemble(orig, prev, diff, priorQAs, guardBlock);
    }
  }

  let prevLen = prev.length;
  while (prevLen > 0 && tooLarge(candidate)) {
    prevLen = Math.floor(prevLen * 0.7);
    if (prevLen < 100) {
      prev = "";
    } else {
      prev = `[...]\n${params.previousAnswer.trim().slice(-prevLen)}`;
    }
    candidate = assemble(orig, prev, diff, priorQAs, guardBlock);
  }

  if (!tooLarge(candidate)) {
    return candidate;
  }

  // Step 2: Trim older Q&A pairs (newest kept in full, oldest dropped first)
  while (priorQAs.length > 0 && tooLarge(candidate)) {
    priorQAs = priorQAs.slice(1);
    candidate = assemble(orig, prev, diff, priorQAs, guardBlock);
  }

  if (!tooLarge(candidate)) {
    return candidate;
  }

  // Step 3: Trim original prompt if still oversized (keep head)
  let origLen = orig.length;
  while (origLen > 0 && tooLarge(candidate)) {
    origLen = Math.floor(origLen * 0.7);
    if (origLen < 100) {
      orig = "";
    } else {
      orig = `${params.originalPrompt.trim().slice(0, origLen)}\n[...]`;
    }
    candidate = assemble(orig, prev, diff, priorQAs, guardBlock);
  }

  if (!tooLarge(candidate)) {
    return candidate;
  }

  // Step 4: Compact the guard context if still oversized (never fail a resume that fit before)
  if (guardBlock) {
    // 4a. Drop assistant text excerpt
    guardBlock = formatGuardContext({ summary: guardSummary, report: guardReport, includeAssistantText: false });
    candidate = assemble(orig, prev, diff, priorQAs, guardBlock);
    if (!tooLarge(candidate)) {
      return candidate;
    }

    // 4b. Compact to single error (<= 100 chars) without files touched
    guardBlock = formatGuardContext({ summary: guardSummary, report: guardReport, maxErrors: 1, maxErrorLen: 100, includeAssistantText: false });
    candidate = assemble(orig, prev, diff, priorQAs, guardBlock);
    if (!tooLarge(candidate)) {
      return candidate;
    }

    // 4c. Compact to single-line notice
    guardBlock = formatGuardContext({ summary: guardSummary, compact: true });
    candidate = assemble(orig, prev, diff, priorQAs, guardBlock);
    if (!tooLarge(candidate)) {
      return candidate;
    }

    // 4d. Compact notice summary to minimal notice
    guardBlock = minGuardNotice;
    candidate = assemble(orig, prev, diff, priorQAs, guardBlock);
    if (!isPromptTooLarge(candidate, params.task, params.preamble, platform, params.deps)) {
      return candidate;
    }
  }

  if (tooLarge(candidate)) {
    throw new ClineRunError("launch_failed", "The prompt exceeds the maximum allowed length or Windows command line limit.", { attempts: 0 });
  }

  return candidate;
}

export interface TaskRunHistoryItem {
  run: number;
  trace: TraceInfo;
  guard?: GuardReport;
  error?: string;
}

export interface Task {
  plan?: PlanView;
  stepExecution?: StepExecution;
  waitReason?: WaitReason;
  evidence?: Record<string, unknown>;
  outcome?: PlanOutcome;
  checkoutLock?: CheckoutRelease;
  id: string;
  mode: TaskMode;
  state: TaskState;
  startedAt: number;
  endedAt?: number;
  activeMs: number;
  run: number;
  runs: TraceInfo[];
  controller: AbortController;
  recorder?: TraceRecorder;
  trace: TraceInfo;
  result?: ClineResponse & Record<string, unknown>;
  previousRunAnswer?: string;
  error?: unknown;
  settled: Promise<void>;
  resolveSettled?: () => void;
  /** The question last returned to a status call, so a long poll returns again only for a new one. */
  reportedQuestion?: string;
  question?: { question: string; options?: string[] };
  autoAnswered?: { question: string; answer: string };
  provider: string;
  model: string;
  cwd?: string;
  thinking?: AskClineInput["thinking"];
  timeoutSeconds?: number;
  originalPrompt: string;
  qaHistory: TaskQA[];
  codeMap?: boolean;
  guard?: GuardOptions;
  guardReport?: GuardReport;
  guardReportSummary?: string;
  runHistory?: TaskRunHistoryItem[];
}

/** What model-picker's log_run needs; null when the run must not be logged (cancelled by the caller). */
export interface LogRunHint { ok: boolean; error_kind?: "timeout" | "quota" | "crash"; retry_after_s?: number; error_text?: string; duration_s: number; }

export interface TaskStatusView {
  plan?: PlanView;
  waitReason?: WaitReason;
  evidence?: Record<string, unknown>;
  outcome?: PlanOutcome;
  taskId: string;
  mode: TaskMode;
  state: TaskState;
  elapsedMs: number;
  run: number;
  runs: TraceInfo[];
  runHistory?: TaskRunHistoryItem[];
  guard?: GuardReport;
  /** Live progress from the trace: attempt, step, current tool, last complete reasoning, files, question. */
  progress?: Omit<TraceStatus, "runId" | "pid" | "state" | "startedAt" | "updatedAt" | "elapsedMs">;
  question?: { question: string; options?: string[] };
  autoAnswered?: { question: string; answer: string };
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
  "task_limit", "task_not_found", "task_running", "task_not_waiting", "checkout_busy"
]);

function noteFor(task: Task): string | undefined {
  if (task.state === "cancelled") return "Cancelled by the caller: do not log.";
  if (task.state === "input_required" || task.state === "resuming") return "Task requires caller input: do not log.";
  if (task.error instanceof ClineRunError && LOCAL_FAILURE_KINDS.has(task.error.kind)) {
    return `Local failure (${task.error.kind}), not a model run: do not log.`;
  }
  return undefined;
}

/** The error as text without its trace line (the task view carries the trace); notes after it are kept. */
function errorText(error: unknown): string {
  return formatErrorAsText(error, "The task failed.").replace(/\n\nTrace: [^\n]*/g, "");
}

export function hintFor(task: Task): LogRunHint | null {
  const activeDuration = task.activeMs || ((task.endedAt ?? Date.now()) - task.startedAt);
  const duration_s = Math.round(activeDuration / 100) / 10;
  if (task.state === "done") return task.plan && task.outcome !== "completed"
    ? { ok: false, error_kind: "crash", error_text: `Plan ${task.outcome}.`, duration_s }
    : { ok: true, duration_s };
  if (noteFor(task)) return null;
  const err = task.error;
  if (err instanceof ClineRunError) {
    const text = err.message.split(/\r?\n/)[0].slice(0, 300);
    if (err.kind === "quota_exhausted" || err.providerState === "rate_limited" || err.providerState === "quota_exhausted") {
      return { ok: false, error_kind: "quota", ...(err.retryAfterSeconds ? { retry_after_s: err.retryAfterSeconds } : {}), error_text: text, duration_s };
    }
    if (err.kind === "timeout") return { ok: false, error_kind: "timeout", error_text: text, duration_s };
    if (err.kind === "loop_detected" || err.kind === "budget_exceeded") {
      return { ok: false, error_kind: "crash", error_text: text, duration_s };
    }
    return { ok: false, error_kind: "crash", error_text: text, duration_s };
  }
  return { ok: false, error_kind: "crash", error_text: String((err as Error)?.message ?? err).slice(0, 300), duration_s };
}

function gitExecutable(): string {
  return process.platform === "win32" ? "git.exe" : "git";
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

  private running(): Task[] {
    return [...this.tasks.values()].filter(t => t.state === "running" || t.state === "resuming");
  }

  /** Drops settled, uncollected tasks that are too old or beyond the retention count. */
  private prune(excludeId?: string): void {
    const now = this.wallNow();
    for (const t of [...this.tasks.values()].filter(t => t.state !== "running" && t.state !== "resuming" && t.state !== "input_required" && t.id !== excludeId)) {
      if (now - (t.endedAt ?? now) > UNCOLLECTED_TTL_MS) this.tasks.delete(t.id);
    }
    const settled = [...this.tasks.values()]
      .filter(t => t.state !== "running" && t.state !== "resuming" && t.state !== "input_required" && t.id !== excludeId)
      .sort((a, b) => (a.endedAt ?? 0) - (b.endedAt ?? 0));
    for (const t of settled.slice(0, Math.max(0, settled.length - MAX_SETTLED_TASKS))) {
      this.tasks.delete(t.id);
    }
  }

  private async getGitDiffStat(cwd: string, signal?: AbortSignal): Promise<string | undefined> {
    if (this.deps.gitDiffStat) return this.deps.gitDiffStat(cwd, signal);
    return new Promise<string | undefined>((resolve) => {
      let stdout = "";
      const child = spawn(gitExecutable(), ["-C", cwd, "diff", "--stat"], {
        shell: false,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"]
      });
      let finished = false;

      const stop = () => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        try {
          if (process.platform === "win32" && typeof child.pid === "number") {
            defaultKillTree(child.pid, "SIGKILL", "win32");
          } else {
            child.kill();
          }
        } catch { /* already gone */ }
        const giveUp = setTimeout(() => resolve(undefined), 5000);
        giveUp.unref?.();
        child.once("close", () => {
          clearTimeout(giveUp);
          resolve(undefined);
        });
      };

      const timer = setTimeout(stop, 5000);
      timer.unref?.();

      const onAbort = () => stop();
      if (signal?.aborted) onAbort();
      else signal?.addEventListener("abort", onAbort, { once: true });

      const settle = (fn: () => void) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        fn();
      };

      child.stdout.on("data", (chunk: Buffer) => {
        stdout += chunk.toString("utf8");
        if (stdout.length > 5000) {
          stop();
        }
      });
      child.stderr.resume();
      child.on("error", () => settle(() => resolve(undefined)));
      child.on("close", (code) => settle(() => {
        if (code === 0 && stdout.trim()) {
          resolve(stdout.trim().slice(0, 4000));
        } else {
          resolve(undefined);
        }
      }));
    });
  }

  private executeRun(task: Task, prompt: string, trace: TraceInfo): void {
    if (!this.tasks.has(task.id) || task.state === "cancelled") {
      task.resolveSettled?.();
      task.resolveSettled = undefined;
      return;
    }
    const thisRunResolveSettled = task.resolveSettled;
    const runStartedAt = this.wallNow();
    task.state = "running";
    task.endedAt = undefined;
    task.trace = trace;

    // Clear per-run fields (Defect 4 & 6)
    task.result = undefined;
    task.error = undefined;
    task.question = undefined;
    task.autoAnswered = undefined;
    task.reportedQuestion = undefined;

    const options: Partial<ClineInvocationOptions> = {
      ...this.deps.runOptions,
      promptPreamble: (this.deps.runOptions?.promptPreamble ?? "") + TASK_QUESTION_PREAMBLE,
      trace: true,
      traceRunId: trace.runId,
      maxAttempts: 1,
      maxTimeoutSeconds: MAX_TASK_TIMEOUT_SECONDS,
      onTraceStart: recorder => { task.recorder = recorder; }
    };
    if (this.deps.traceBase) options.deps = { ...options.deps, traceBase: this.deps.traceBase };
    if (task.guard) options.guard = task.guard;

    const runInput: AskClineInput & { codeMap?: boolean } = {
      prompt,
      provider: task.provider,
      model: task.model,
      cwd: task.cwd,
      thinking: task.thinking,
      timeoutSeconds: task.timeoutSeconds ?? DEFAULT_TASK_TIMEOUT_SECONDS,
      guard: task.guard,
      codeMap: task.codeMap
    };

    let run: Promise<ClineResponse & Record<string, unknown>>;
    try {
      if (task.mode === "edits" && !task.checkoutLock) {
        run = (async () => {
          if (!task.checkoutLock) {
            const root = await editsCheckoutRoot(task.cwd!, task.controller.signal);
            if (task.controller.signal.aborted) throw new ClineRunError("cancelled", "The task was cancelled.", { attempts: 0 });
            task.checkoutLock = acquire(root, { lockDirectory: options.checkoutLockDirectory });
          }
          return this.runners.edits(runInput, task.controller.signal, { ...options, checkoutLock: task.checkoutLock });
        })();
      } else run = this.runners[task.mode](runInput, task.controller.signal,
        task.mode === "edits" ? { ...options, checkoutLock: task.checkoutLock } : options);
    } catch (err) {
      run = Promise.reject(err);
    }

    // Every rejection is handled here; the background promise can never become unhandled.
    const onSettled = run.then(
      result => {
        task.result = result;
        task.previousRunAnswer = result.text ?? "";
        task.runHistory = task.runHistory ?? [];
        task.runHistory.push({ run: task.run, trace });
        const q = parseQuestionFromText(result.text ?? "");
        if (q) {
          task.state = "input_required";
          task.question = q;
        } else {
          task.state = "done";
          task.question = undefined;
        }
      },
      err => {
        task.error = err;
        task.runHistory = task.runHistory ?? [];
        if (err instanceof ClineRunError && (err.kind === "loop_detected" || err.kind === "budget_exceeded")) {
          task.state = "input_required";
          task.guardReport = err.guard;
          task.guardReportSummary = formatReportSummary(err.guard, err.message);
          const detail = err.message.replace(/^Stopped by the bridge:\s*/i, "").replace(/\.\s*$/, "");
          task.question = err.kind === "loop_detected"
            ? {
                question: `QUESTION: Stopped by the bridge: ${detail}. How should it continue (a different approach, skip this target, or stop)?`,
                options: ["a different approach", "skip this target", "stop"]
              }
            : {
                question: `QUESTION: Stopped by the bridge: ${detail}. How should it continue (a narrower scope, or stop)?`,
                options: ["a narrower scope", "stop"]
              };
          task.runHistory.push({
            run: task.run,
            trace,
            guard: err.guard,
            error: err.message
          });
        } else {
          task.state = err instanceof ClineRunError && err.kind === "cancelled" ? "cancelled" : "failed";
          task.runHistory.push({
            run: task.run,
            trace,
            error: err instanceof Error ? err.message : String(err)
          });
        }
      }
    ).finally(() => {
      if (task.state !== "input_required") this.releaseCheckout(task);
      const now = this.wallNow();
      task.endedAt = now;
      task.activeMs += (now - runStartedAt);
      const snap = task.recorder?.snapshot();
      if (snap?.question?.autoAnswer && snap.question.question) {
        task.autoAnswered = { question: snap.question.question, answer: snap.question.autoAnswer };
      }
      if (task.resolveSettled === thisRunResolveSettled) {
        task.resolveSettled = undefined;
      }
      thisRunResolveSettled?.();
    });

    task.settled = onSettled;
  }

  private releaseCheckout(task: Task): void {
    task.checkoutLock?.();
    task.checkoutLock = undefined;
  }

  private checkCancelled(task: Task): void {
    if (task.controller.signal.aborted) throw new ClineRunError("cancelled", "The task was cancelled.", { attempts: 0 });
  }

  private waitPlan(task: Task, reason: WaitReason, evidence: Record<string, unknown>, question?: Task["question"]): void {
    const plan = task.plan!;
    plan.phase = "waiting";
    plan.steps[plan.currentIndex].state = reason === "cline_question" ? "running" : "failed";
    task.waitReason = reason;
    task.evidence = evidence;
    task.question = question ?? { question: reason === "budget" ? `Step ${plan.currentId}: launch budget exhausted. Skip or stop?`
      : reason === "head_changed" ? `Step ${plan.currentId}: HEAD/index changed. Repair Git identity before retry/skip, or stop and inspect the recovery snapshot.`
      : `Step ${plan.currentId}: ${reason}. Retry with guidance, skip, or stop?`,
      options: reason === "budget" ? ["skip", "stop"] : ["retry", "skip", "stop"] };
  }

  private async planIdentityUnchanged(task: Task): Promise<boolean> {
    const execution = task.stepExecution!;
    if (!execution.identity) return true; // No Cline launch happened if initial identity capture failed.
    try {
      const current = await headAndIndexIdentity(task.cwd!);
      if (current.head === execution.identity.head && current.indexHash === execution.identity.indexHash) return true;
      this.waitPlan(task, "head_changed", { before: execution.identity, after: current,
        snapshotDirectory: execution.snapshot?.directory, message: "HEAD/index changed. No reset or file restoration was performed." });
    } catch (err) {
      this.waitPlan(task, "head_changed", { before: execution.identity, error: redactSecrets(String(err)),
        snapshotDirectory: execution.snapshot?.directory, message: "Could not establish HEAD/index identity; no restoration was performed." });
    }
    return false;
  }

  private async restorePlanStep(task: Task): Promise<boolean> {
    const snapshot = task.stepExecution!.snapshot;
    if (!snapshot) return true;
    if (!await this.planIdentityUnchanged(task)) return false;
    task.plan!.phase = "restore";
    const record = task.plan!.steps[task.plan!.currentIndex];
    try { record.restore = await restoreSnapshot(snapshot); }
    catch (err) { record.restore = { restored: [], removed: [], failed: [{ path: ".", error: redactSecrets(String(err)) }] }; }
    if (record.restore.failed.length) {
      this.waitPlan(task, "cline_error", { message: "Baseline restoration is incomplete; automatic advancement is blocked.",
        restore: record.restore, snapshotDirectory: snapshot.directory });
      return false;
    }
    return true;
  }

  private async discardPlanSnapshot(task: Task): Promise<void> {
    const execution = task.stepExecution!;
    if (execution.snapshot) await discardSnapshot(execution.snapshot);
    execution.snapshot = undefined;
    execution.identity = undefined;
  }

  private async finishPlanCancellation(task: Task): Promise<void> {
    if (await this.restorePlanStep(task)) await this.discardPlanSnapshot(task);
    task.state = "cancelled";
    task.plan!.phase = "done";
    if (task.plan!.steps[task.plan!.currentIndex].state === "running") task.plan!.steps[task.plan!.currentIndex].state = "failed";
    task.error = new ClineRunError("cancelled", "The task was cancelled.", { attempts: 0 });
    task.waitReason = undefined;
    task.question = undefined;
  }

  private planPrompt(task: Task, message: string, resumeQuestion: boolean): string {
    const plan = task.plan!, execution = task.stepExecution!;
    const step = execution.definitions[plan.currentIndex];
    const preamble = getEffectivePreamble("edits", this.deps.runOptions?.promptPreamble ?? "");
    const fits = (prompt: string) => !isPromptTooLarge(prompt, task, preamble, this.deps.platform ?? process.platform, this.deps.runOptions?.deps);
    const guidance = message ? `Caller guidance:\n${message}` : "";
    const failure = task.evidence ? `Previous failure evidence:\n${redactSecrets(JSON.stringify(task.evidence)).slice(0, 2000)}` : "";
    if (!resumeQuestion) {
      const context = [guidance, failure].filter(Boolean).join("\n\n");
      return buildStepPrompt(task.originalPrompt, step, plan.steps, context, fits, suffixFits => {
        let evidence = failure;
        const render = () => [guidance, evidence].filter(Boolean).join("\n\n");
        while (evidence.length > 200 && !suffixFits(render())) evidence = evidence.slice(0, Math.floor(evidence.length * 0.7));
        if (!suffixFits(render()) && failure) evidence = `Previous failure: ${task.waitReason}.`;
        return render();
      });
    }
    const history = [...task.qaHistory, { question: task.question?.question ?? "", answer: message, options: task.question?.options }];
    const full = buildResumedPrompt({ originalPrompt: "", previousAnswer: task.previousRunAnswer ?? "", qaHistory: history, task, preamble });
    return buildStepPrompt(task.originalPrompt, step, plan.steps, full, fits, suffixFits => buildResumedPrompt({
      originalPrompt: "", previousAnswer: task.previousRunAnswer ?? "", qaHistory: history, task, preamble,
      platform: this.deps.platform, deps: this.deps.runOptions?.deps, fits: suffixFits
    }));
  }

  /** One segment runs until waiting or terminal. The settled promise includes verification and rollback. */
  private launchPlan(task: Task, action?: StepAction | "cancel", message = ""): void {
    const resumeQuestion = action === "retry" && task.waitReason === "cline_question";
    // Validate a resume before replacing its waiting state or controller.
    const resumedPrompt = action === "retry" ? this.planPrompt(task, message, resumeQuestion) : undefined;
    if (resumeQuestion) task.qaHistory.push({ question: task.question?.question ?? "", answer: message, options: task.question?.options });
    else if (action === "retry") task.qaHistory = [];
    task.state = action ? "resuming" : "running";
    task.plan!.phase = resumeQuestion ? "run" : task.stepExecution!.snapshot ? "restore" : "snapshot";
    task.endedAt = undefined;
    task.controller = new AbortController();
    if (action === "cancel") task.controller.abort();
    task.question = undefined;
    task.reportedQuestion = undefined;
    task.recorder = undefined;
    const startedAt = this.wallNow();
    task.settled = this.runPlan(task, action, resumedPrompt, resumeQuestion).then(() => this.checkCancelled(task)).catch(async err => {
      task.error = err;
      if (task.controller.signal.aborted || (err instanceof ClineRunError && err.kind === "cancelled")) {
        await this.finishPlanCancellation(task);
      } else if (task.checkoutLock) {
        if (await this.restorePlanStep(task)) this.waitPlan(task, "cline_error", { error: errorText(err) });
      } else { task.state = "failed"; task.plan!.phase = "done"; }
    }).then(async () => {
      // Abort may arrive during failure cleanup, which deliberately runs without the aborted signal.
      if (task.controller.signal.aborted && task.state !== "cancelled") await this.finishPlanCancellation(task);
    }).catch(err => {
      // Cleanup errors must remain observable and may never become an unhandled background rejection.
      task.error = err;
      task.evidence = { ...task.evidence, cleanupError: redactSecrets(String(err)), snapshotDirectory: task.stepExecution?.snapshot?.directory };
      if (task.controller.signal.aborted) { task.state = "cancelled"; task.plan!.phase = "done"; }
      else if (task.checkoutLock) this.waitPlan(task, "cline_error", task.evidence);
      else { task.state = "failed"; task.plan!.phase = "done"; }
    }).finally(() => {
      // Publish waiting only after all segment I/O settles. A caller cannot resume into an old rollback/finalizer.
      if (task.plan!.phase === "waiting") task.state = "input_required";
      task.endedAt = this.wallNow();
      task.activeMs += task.endedAt - startedAt;
      if (task.state !== "input_required") this.releaseCheckout(task);
    });
  }

  private async runPlan(task: Task, action?: StepAction | "cancel", resumedPrompt?: string, resumeQuestion = false): Promise<void> {
    const plan = task.plan!, execution = task.stepExecution!;
    this.checkCancelled(task);
    if (!task.checkoutLock) {
      const root = await editsCheckoutRoot(task.cwd!, task.controller.signal);
      this.checkCancelled(task);
      task.checkoutLock = acquire(root, { lockDirectory: this.deps.runOptions?.checkoutLockDirectory });
      task.cwd = root;
    }
    if (action === "stop") {
      if (await this.restorePlanStep(task)) await this.discardPlanSnapshot(task);
      this.checkCancelled(task);
      if (plan.steps[plan.currentIndex].state === "running") plan.steps[plan.currentIndex].state = "failed";
      task.outcome = "stopped";
      task.state = "done";
      plan.phase = "done";
      task.question = undefined;
      task.waitReason = undefined;
      task.error = undefined;
      return;
    }
    if (action === "skip") {
      if (!await this.restorePlanStep(task)) return;
      plan.steps[plan.currentIndex].state = "skipped";
      await this.discardPlanSnapshot(task);
      this.checkCancelled(task);
      if (!this.advancePlan(task)) return;
      resumedPrompt = undefined;
    } else if (action === "retry" && !resumeQuestion) {
      if (!await this.restorePlanStep(task)) return;
    }
    task.waitReason = undefined;
    task.error = undefined;
    while (true) {
      this.checkCancelled(task);
      const record = plan.steps[plan.currentIndex];
      if (record.attempts >= 3) {
        if (await this.restorePlanStep(task)) this.waitPlan(task, "budget", { message: "Three Cline launches exhausted; only skip or stop is allowed." });
        return;
      }
      if (!execution.snapshot) {
        plan.phase = "snapshot";
        execution.snapshot = await takeSnapshot(task.cwd!, { ...this.deps.snapshotOptions, signal: task.controller.signal });
        this.checkCancelled(task);
        execution.identity = await headAndIndexIdentity(task.cwd!);
      } else if (!await this.planIdentityUnchanged(task)) return;
      if (!execution.identity) execution.identity = await headAndIndexIdentity(task.cwd!);
      this.checkCancelled(task);
      const prompt = resumedPrompt ?? this.planPrompt(task, "", false);
      resumedPrompt = undefined;
      task.evidence = undefined;
      execution.prompt = prompt;
      plan.phase = "run";
      record.state = "running";
      record.attempts++;
      plan.attempt = record.attempts;
      if (execution.launches++) {
        task.run++;
        const runId = `${task.id}-run-${task.run}`;
        const dir = path.join(resolveTraceBase(this.deps.traceBase), runId);
        task.trace = { runId, dir, events: path.join(dir, "events.ndjson"), status: path.join(dir, "status.json") };
        task.runs.push(task.trace);
      }
      task.recorder = undefined;
      task.autoAnswered = undefined;
      task.guardReport = undefined;
      task.guardReportSummary = undefined;
      task.state = "running";
      let result: ClineResponse | undefined, failure: unknown;
      const options: Partial<ClineInvocationOptions> = { ...this.deps.runOptions,
        checkoutLock: task.checkoutLock, trace: true, traceRunId: task.trace.runId,
        promptPreamble: (this.deps.runOptions?.promptPreamble ?? "") + TASK_QUESTION_PREAMBLE,
        maxAttempts: 1, maxTimeoutSeconds: MAX_TASK_TIMEOUT_SECONDS, guard: task.guard,
        onTraceStart: recorder => { task.recorder = recorder; } };
      if (this.deps.traceBase) options.deps = { ...options.deps, traceBase: this.deps.traceBase };
      try {
        const runner = this.deps.runners?.edits ?? runClineEditStep;
        result = await runner({ prompt, cwd: task.cwd!, provider: task.provider, model: task.model,
          thinking: task.thinking, timeoutSeconds: task.timeoutSeconds ?? DEFAULT_TASK_TIMEOUT_SECONDS,
          guard: task.guard, codeMap: task.codeMap }, task.controller.signal, options);
        sumUsage(execution.usage, result.usage);
        execution.durationMs += result.durationMs;
        if (typeof result.cost === "number") execution.cost += result.cost;
        task.previousRunAnswer = result.text;
        task.result = { ...result, usage: execution.usage, cost: execution.cost, durationMs: execution.durationMs };
      } catch (err) {
        failure = err;
        task.error = err;
        if (err instanceof ClineRunError && err.guard) {
          task.guardReport = err.guard;
          task.guardReportSummary = formatReportSummary(err.guard, err.message);
        }
        const metrics = err as { usage?: Record<string, unknown>; durationMs?: number } | undefined;
        if (metrics?.usage && typeof metrics.usage === "object") sumUsage(execution.usage, metrics.usage);
        else if (err instanceof ClineRunError && err.guard) sumUsage(execution.usage, { inputTokens: err.guard.totalInputTokens });
        if (typeof metrics?.durationMs === "number" && Number.isFinite(metrics.durationMs)) execution.durationMs += metrics.durationMs;
      }
      task.runHistory ??= [];
      task.runHistory.push({ run: task.run, trace: task.trace, ...(failure ? { error: errorText(failure), guard: task.guardReport } : {}) });
      this.checkCancelled(task);
      if (!await this.planIdentityUnchanged(task)) return;
      if (failure) {
        const reason = failure instanceof ClineRunError && (failure.kind === "loop_detected" || failure.kind === "budget_exceeded")
          ? "guard" : "cline_error";
        if (await this.restorePlanStep(task)) this.waitPlan(task, record.attempts >= 3 ? "budget" : reason,
          { error: errorText(failure), guard: task.guardReport, restore: record.restore });
        return;
      }
      const question = parseQuestionFromText(result!.text);
      if (question) {
        if (record.attempts >= 3) {
          if (await this.restorePlanStep(task)) this.waitPlan(task, "budget", { message: "Launch cap reached while Cline requested another answer.", question });
        } else this.waitPlan(task, "cline_question", { question }, question);
        return;
      }
      plan.phase = "verify";
      const verified = await (this.deps.runVerification ?? runVerification)(execution.definitions[plan.currentIndex].verify, task.cwd!, task.controller.signal);
      record.verify = { passed: verified.passed, exitCode: verified.exitCode, timedOut: verified.timedOut,
        stdoutTail: verified.stdoutTail, stderrTail: verified.stderrTail };
      this.checkCancelled(task);
      if (!await this.planIdentityUnchanged(task)) return;
      if (!verified.passed) {
        if (await this.restorePlanStep(task)) this.waitPlan(task, record.attempts >= 3 ? "budget" : "verify_failed", { verify: verified, restore: record.restore });
        return;
      }
      const after = await takeSnapshot(task.cwd!, { ...this.deps.snapshotOptions, signal: task.controller.signal });
      try {
        this.checkCancelled(task);
        const beforeFiles = new Map(execution.snapshot.manifest.map(entry => [entry.path, entry.sha256]));
        const afterFiles = new Map(after.manifest.map(entry => [entry.path, entry.sha256]));
        record.changedFiles = [...new Set([...beforeFiles.keys(), ...afterFiles.keys()])]
          .filter(file => beforeFiles.get(file) !== afterFiles.get(file)).sort();
      } finally { await discardSnapshot(after); }
      this.checkCancelled(task);
      if (!await this.planIdentityUnchanged(task)) return;
      record.summary = redactSecrets(result!.text.split(/\r\n|\r|\n/, 1)[0]);
      record.state = "verified";
      await this.discardPlanSnapshot(task);
      this.checkCancelled(task);
      if (!this.advancePlan(task)) return;
    }
  }

  private advancePlan(task: Task): boolean {
    const plan = task.plan!;
    task.waitReason = undefined;
    task.error = undefined;
    task.qaHistory = [];
    task.previousRunAnswer = undefined;
    task.guardReport = undefined;
    task.guardReportSummary = undefined;
    task.evidence = undefined;
    if (plan.currentIndex + 1 >= plan.total) {
      task.outcome = plan.steps.some(step => step.state === "skipped") ? "completed_with_skips" : "completed";
      task.state = "done";
      plan.phase = "done";
      return false;
    }
    plan.currentIndex++;
    plan.currentId = plan.steps[plan.currentIndex].id;
    plan.attempt = 0;
    plan.phase = "snapshot";
    return true;
  }

  start(input: StartTaskInput): TaskStatusView {
    if (this.closing) throw new ClineRunError("cancelled", "The bridge is shutting down; no new tasks start.", { attempts: 0 });
    requireSelection(input);
    const validated = startTaskSchema.safeParse(input);
    if (!validated.success) throw new ClineRunError("launch_failed", validated.error.message, { attempts: 0 });
    input = validated.data;
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
    const trace: TraceInfo = { runId: id, dir, events: path.join(dir, "events.ndjson"), status: path.join(dir, "status.json") };
    const task: Task = {
      id, mode: input.mode, state: "running", startedAt: this.wallNow(), activeMs: 0,
      run: 1, runs: [trace],
      controller: new AbortController(),
      trace,
      settled: Promise.resolve(),
      provider: input.provider,
      model: input.model,
      cwd: input.cwd,
      thinking: input.thinking,
      timeoutSeconds: input.timeoutSeconds,
      originalPrompt: input.prompt,
      qaHistory: [],
      guard: input.guard,
      codeMap: input.codeMap
    };
    if (input.steps) {
      task.plan = { total: input.steps.length, currentIndex: 0, currentId: input.steps[0].id, phase: "snapshot", attempt: 0,
        steps: input.steps.map(step => ({ id: step.id, state: "pending", attempts: 0 })) };
      task.stepExecution = { definitions: input.steps, launches: 0, usage: Object.create(null), cost: 0, durationMs: 0 };
    }
    this.tasks.set(id, task);
    if (task.plan) this.launchPlan(task); else this.executeRun(task, input.prompt, trace);
    return this.view(task);
  }

  async send(taskId: string, message = "", action: StepAction = "retry"): Promise<TaskStatusView> {
    if (this.closing) throw new ClineRunError("cancelled", "The bridge is shutting down; no new tasks start.", { attempts: 0 });
    const task = this.get(taskId);
    if (task.state !== "input_required") {
      throw new ClineRunError("task_not_waiting", `Task ${taskId} is in state "${task.state}", not "input_required". cline_send can only be called on tasks waiting for input.`, { attempts: 0 });
    }
    if (task.plan) {
      if (!["retry", "skip", "stop"].includes(action) || typeof message !== "string" || message.length > 20_000) {
        throw new ClineRunError("launch_failed", "Expected retry, skip or stop, and guidance up to 20000 characters.", { attempts: 0 });
      }
      if (action === "retry" && (task.waitReason === "budget" || task.plan.steps[task.plan.currentIndex].attempts >= 3)) {
        throw new ClineRunError("budget_exceeded", "This step allows only skip or stop.", { attempts: 0 });
      }
      if (action !== "stop" && this.running().length >= MAX_RUNNING_TASKS) throw new ClineRunError("task_limit", "At most two tasks run at once.", { attempts: 0 });
      this.launchPlan(task, action, message);
      return this.view(task);
    }
    if (action !== "retry") throw new ClineRunError("launch_failed", "skip and stop require a step plan.", { attempts: 0 });
    if (typeof message !== "string" || message.length < 1 || message.length > 20_000) {
      throw new ClineRunError("launch_failed", "message must be a string between 1 and 20000 characters.", { attempts: 0 });
    }

    const questionText = task.question?.question ?? "";
    const options = task.question?.options;
    const preamble = getEffectivePreamble(task.mode, this.deps.runOptions?.promptPreamble ?? "");
    const platform = this.deps.platform ?? process.platform;
    const latestQA: TaskQA = {
      question: questionText,
      answer: message,
      ...(options && options.length > 0 ? { options } : {})
    };

    // Check upfront: latest question + answer + reserved room for mandatory guard notice alone must fit
    const minGuardLine = (task.guardReportSummary || task.guardReport)
      ? "Previous run was stopped by the bridge: loop or budget exceeded; do not repeat the same failing action."
      : undefined;
    if (isPromptTooLarge(minimumPrompt(latestQA, minGuardLine), task, preamble, platform, this.deps.runOptions?.deps)) {
      throw new ClineRunError("launch_failed", "The question and caller answer together exceed the prompt or command line limit.", { attempts: 0 });
    }

    // Prune uncollected settled tasks, ensuring taskId is never pruned (Defect 4)
    this.prune(taskId);

    // Concurrency check: resuming counts against running limit (Defect 1)
    if (this.running().length >= MAX_RUNNING_TASKS) {
      throw new ClineRunError("task_limit", `At most ${MAX_RUNNING_TASKS} Cline tasks run at once; ` +
        `wait for one to finish (cline_status) or cancel one (cline_cancel).`, { attempts: 0 });
    }

    // Defect 1: Give a resuming task a fresh pending settled promise
    let resolveSettled!: () => void;
    task.settled = new Promise<void>(resolve => { resolveSettled = resolve; });
    task.resolveSettled = resolveSettled;

    // Defect 1 & Defect 4: Clear old trace data & reserve synchronously before any await
    const savedQuestion = task.question;
    const savedGuardReport = task.guardReport;
    const savedGuardReportSummary = task.guardReportSummary;
    task.state = "resuming";
    task.controller = new AbortController();
    task.recorder = undefined;
    task.autoAnswered = undefined;
    task.question = undefined;
    task.reportedQuestion = undefined;
    task.result = undefined;
    task.error = undefined;
    task.guardReport = undefined;
    task.guardReportSummary = undefined;

    const candidateQAs = [...task.qaHistory, latestQA];

    let diffStat: string | undefined;
    try {
      if ((task.mode === "workspace" || task.mode === "edits") && task.cwd) {
        diffStat = await this.getGitDiffStat(task.cwd, task.controller.signal);
      }
    } catch {
      // Best effort, ignore
    }

    // Revalidate after the await (Defects 1 & 4)
    if (this.closing) {
      task.state = "cancelled";
      this.releaseCheckout(task);
      if (!task.error) {
        task.error = new ClineRunError("cancelled", "The bridge is shutting down; no new tasks start.", { attempts: 0 });
      }
      task.resolveSettled?.();
      task.resolveSettled = undefined;
      throw task.error;
    }
    if (!this.tasks.has(taskId)) {
      task.resolveSettled?.();
      task.resolveSettled = undefined;
      throw new ClineRunError("task_not_found", `Task ${taskId} was removed during resume.`, { attempts: 0 });
    }
    if ((task.state as TaskState) === "cancelled" || task.controller.signal.aborted) {
      task.state = "cancelled";
      this.releaseCheckout(task);
      if (!task.error) {
        task.error = new ClineRunError("cancelled", "The task was cancelled.", { attempts: 0 });
      }
      task.resolveSettled?.();
      task.resolveSettled = undefined;
      throw task.error;
    }

    const previousAnswer = task.previousRunAnswer ?? "";
    let prompt: string;
    try {
      prompt = buildResumedPrompt({
        originalPrompt: task.originalPrompt,
        previousAnswer,
        diffStat,
        qaHistory: candidateQAs,
        task,
        preamble,
        guardReportSummary: savedGuardReportSummary,
        guardReport: savedGuardReport,
        platform,
        deps: this.deps.runOptions?.deps
      });
    } catch (err) {
      task.state = "input_required";
      task.question = savedQuestion;
      task.guardReport = savedGuardReport;
      task.guardReportSummary = savedGuardReportSummary;
      task.resolveSettled?.();
      task.resolveSettled = undefined;
      throw err;
    }

    task.qaHistory.push(latestQA);

    task.run++;
    const runId = `${task.id}-run-${task.run}`;
    const dir = path.join(resolveTraceBase(this.deps.traceBase), runId);
    const trace: TraceInfo = { runId, dir, events: path.join(dir, "events.ndjson"), status: path.join(dir, "status.json") };
    task.runs.push(trace);

    this.executeRun(task, prompt, trace);
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
    const autoAnswer = snap?.question?.autoAnswer;
    if (autoAnswer && snap?.question?.question) {
      task.autoAnswered = { question: snap.question.question, answer: autoAnswer };
    }
    return {
      taskId: task.id,
      mode: task.mode,
      state: task.state,
      elapsedMs: (task.endedAt ?? this.wallNow()) - task.startedAt,
      run: task.run ?? 1,
      runs: task.runs ?? [task.trace],
      ...(task.runHistory && task.runHistory.length > 0 ? { runHistory: task.runHistory } : {}),
      ...(task.guardReport ? { guard: task.guardReport } : {}),
      ...(progress ? { progress } : {}),
      ...(task.question ? { question: task.question } : {}),
      ...(task.autoAnswered ? { autoAnswered: task.autoAnswered } : {}),
      ...(task.state === "failed" || task.state === "cancelled" ? { error: errorText(task.error).slice(0, 2000) } : {}),
      resultReady: task.state !== "running" && task.state !== "resuming",
      trace: task.trace,
      ...(task.plan ? { plan: structuredClone(task.plan), outcome: task.outcome,
        waitReason: task.waitReason, evidence: structuredClone(task.evidence) } : {})
    };
  }

  /**
   * Long poll: returns as soon as the task settles (done or input_required) or Cline asks a question not yet reported,
   * otherwise after waitSeconds (max 60). waitSeconds 0 returns immediately.
   */
  async status(taskId: string, waitSeconds = 0, pollMs = 250): Promise<TaskStatusView> {
    const task = this.get(taskId);
    const deadline = Date.now() + Math.min(Math.max(0, waitSeconds), MAX_WAIT_SECONDS) * 1000;
    const newQuestion = () => {
      const q = task.recorder?.snapshot().question?.question;
      return q !== undefined && q !== task.reportedQuestion ? q : undefined;
    };
    while ((task.state === "running" || task.state === "resuming") && !newQuestion() && Date.now() < deadline) {
      let timer: NodeJS.Timeout | undefined;
      const waitMs = Math.min(pollMs, Math.max(1, deadline - Date.now()));
      await Promise.race([task.settled, new Promise<void>(resolve => { timer = setTimeout(resolve, waitMs); })]);
      if (timer) clearTimeout(timer);
      await new Promise<void>(resolve => setImmediate(resolve));
    }
    const q = newQuestion();
    if (q !== undefined) task.reportedQuestion = q;
    return this.view(task);
  }

  /** Stops the task's Cline process and waits briefly for it to settle. */
  async cancel(taskId: string, waitMs = 5000): Promise<TaskStatusView> {
    const task = this.get(taskId);
    if (task.plan) {
      if (task.state === "input_required") this.launchPlan(task, "cancel");
      else if (task.state === "running" || task.state === "resuming") task.controller.abort();
      await task.settled; // A plan's cancellation is not complete until rollback and lock release finish.
      return this.view(task);
    }
    if (task.state === "running" || task.state === "resuming" || (task.state === "cancelled" && task.resolveSettled !== undefined)) {
      task.controller.abort();
      if (task.state === "resuming") {
        task.state = "cancelled";
        task.error = new ClineRunError("cancelled", "The task was cancelled.", { attempts: 0 });
      }
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([task.settled, new Promise<void>(resolve => { timer = setTimeout(resolve, waitMs); })]);
      if (timer) clearTimeout(timer);
    } else if (task.state === "input_required") {
      task.state = "cancelled";
      task.error = new ClineRunError("cancelled", "The task was cancelled while waiting for input.", { attempts: 0 });
      this.releaseCheckout(task);
    }
    return this.view(task);
  }

  /** Final result of a settled task. Removes the task and, unless keepTrace, its trace folders. */
  async result(taskId: string, keepTrace = false): Promise<{ state: TaskState; result?: Record<string, unknown>; error?: string;
    guard?: GuardReport; runHistory?: TaskRunHistoryItem[];
    plan?: PlanView; outcome?: PlanOutcome; waitReason?: WaitReason; evidence?: Record<string, unknown>;
    log_run_hint: LogRunHint | null; log_run_note?: string; trace?: TraceInfo }> {
    const task = this.get(taskId);
    if (task.state === "running" || task.state === "resuming") {
      throw new ClineRunError("task_running", `Task ${taskId} is still running; use cline_status (it can wait up to ${MAX_WAIT_SECONDS} s).`, { attempts: 0 });
    }
    const hint = hintFor(task);
    const out = {
      state: task.state,
      ...(task.plan ? { plan: structuredClone(task.plan), outcome: task.outcome, waitReason: task.waitReason,
        evidence: structuredClone(task.evidence), result: { ...task.result, usage: structuredClone(task.stepExecution!.usage),
          durationMs: task.stepExecution!.durationMs, cost: task.stepExecution!.cost, trace: undefined } } : {}),
      ...(task.result && !task.plan ? { result: { ...task.result, trace: undefined } } : {}),
      ...(task.error !== undefined ? { error: errorText(task.error) } : {}),
      ...(task.guardReport ? { guard: task.guardReport } : {}),
      ...(task.runHistory && task.runHistory.length > 0 ? { runHistory: task.runHistory } : {}),
      log_run_hint: hint,
      ...(noteFor(task) ? { log_run_note: noteFor(task) } : {}),
      ...(keepTrace ? { trace: task.trace } : {})
    };
    if (task.state === "input_required") {
      return out;
    }
    this.tasks.delete(taskId);
    if (!keepTrace) {
      // Stop queued writes, then let one in progress land, so nothing recreates the folder after removal.
      task.recorder?.close();
      await task.recorder?.idle();
      for (const t of task.runs ?? [task.trace]) {
        await rm(t.dir, { recursive: true, force: true, maxRetries: 3 }).catch(() => {});
      }
    }
    return out;
  }

  /** Cancels every running task (bridge shutdown) and waits up to waitMs for them to settle. */
  async shutdown(waitMs = 3000): Promise<void> {
    this.closing = true;
    const toSettle: Task[] = [];
    for (const t of this.tasks.values()) {
      if (t.plan && (t.state === "running" || t.state === "resuming" || t.state === "input_required")) {
        if (t.state === "input_required") this.launchPlan(t, "cancel"); else t.controller.abort();
        toSettle.push(t);
        continue;
      }
      if (t.state === "running") {
        t.controller.abort();
        toSettle.push(t);
      } else if (t.state === "resuming") {
        t.controller.abort();
        t.state = "cancelled";
        t.error = new ClineRunError("cancelled", "The bridge is shutting down.", { attempts: 0 });
        toSettle.push(t);
      } else if (t.state === "input_required") {
        t.state = "cancelled";
        t.error = new ClineRunError("cancelled", "The bridge is shutting down.", { attempts: 0 });
        this.releaseCheckout(t);
      } else if (t.resolveSettled !== undefined) {
        t.controller.abort();
        toSettle.push(t);
      }
    }
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([Promise.allSettled(toSettle.map(t => t.settled)), new Promise<void>(resolve => { timer = setTimeout(resolve, waitMs); })]);
    if (timer) clearTimeout(timer);
  }
}
