import { setTimeout as delay } from "node:timers/promises";
import { ChildProcess, spawn } from "node:child_process";
import { hubDaemonPidsOnPort, listClineProcesses } from "./procs.js";
import { KILL_SETTLE_MS, PROCESS_QUERY_TIMEOUT_MS, PROCESS_TABLE_TIMEOUT_MS, TREE_KILL_CONFIRM_MS, settlementBudget, untilAborted, type SettlementBudget } from "./waits.js";
import { killWindowsTree } from "./codemap-kill.js";
import { confirmTreeDead, type TreeKillResult } from "./proctree.js";
import { createWindowsJob, type WindowsJob } from "./jobobject.js";
import { randomUUID } from "node:crypto";
import { access, mkdir, rm } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { existsSync, realpathSync } from "node:fs";
import { z } from "zod";
import { LineSplitter, TraceRecorder, type TraceInfo } from "./trace.js";
import { createGuard, buildGuardTripMessage, type Guard, type GuardOptions, type GuardReport, type GuardVerdict } from "./guard.js";
import {
  JsonlParseError,
  parseClineJsonl,
  parseUsableResult,
  extractLastJsonlError,
  lastTerminalErrorMessage,
  type ClineFinalResult
} from "./parser.js";
import {
  PROHIBITED_NAMES,
  resolveProviderSettingsPath,
  withProviderOverride,
  type MutexOptions
} from "./settings.js";
import {
  activeQuotaLock,
  buildEntry,
  classifyErrorText,
  classifyRunError,
  isDailyQuotaText,
  readStatusEntry,
  recordStatusSafely,
  resolveStatusPath,
  type ProviderState
} from "./status.js";

export type ThinkingLevel = "none" | "low" | "medium" | "high" | "xhigh";

export interface AskClineInput {
  prompt: string;
  cwd?: string;
  thinking?: ThinkingLevel;
  timeoutSeconds?: number;
  systemPrompt?: string;
  provider?: string;
  model?: string;
  guard?: GuardOptions;
}

export const guardOptionsSchema = z
  .object({
    maxRepeatedFailures: z
      .number()
      .int()
      .min(2)
      .max(20)
      .optional()
      .describe("Trip after this many repeated failures on the same tool+target (default 3, range 2..20)."),
    window: z
      .number()
      .int()
      .min(3)
      .max(50)
      .optional()
      .describe("Sliding window of recent tool calls to inspect for repeated failures (default 10, range 3..50). Must be >= maxRepeatedFailures."),
    maxToolCalls: z
      .number()
      .int()
      .min(10)
      .max(1000)
      .optional()
      .describe("Trip if cumulative tool calls exceed this limit (default 150, range 10..1000)."),
    maxInputTokens: z
      .number()
      .int()
      .min(10_000)
      .max(20_000_000)
      .optional()
      .describe("Trip if cumulative input tokens exceed this limit (default 1,500,000, range 10,000..20,000,000).")
  })
  .refine(
    (val) => {
      const failures = val.maxRepeatedFailures ?? 3;
      const win = val.window ?? 10;
      return win >= failures;
    },
    {
      message: "window must be greater than or equal to maxRepeatedFailures",
      path: ["window"]
    }
  );

export type ClineErrorKind =
  | "checkout_busy"
  | "machine_busy"
  | "settings_lock_timeout"
  | "settings_restore_failed"
  | "timeout"
  | "cancelled"
  | "loop_detected"
  | "budget_exceeded"
  | "non_zero_exit"
  | "transient_provider_error"
  | "cline_updating"
  | "malformed_json"
  | "missing_final_result"
  | "launch_failed"
  | "workspace_not_git"
  | "workspace_setup_failed"
  | "workspace_cleanup_failed"
  | "commit_created"
  | "edits_inspection_failed"
  | "quota_exhausted"
  | "catalog_unavailable"
  | "task_limit"
  | "task_not_found"
  | "task_running"
  | "task_not_waiting";

export interface ClineRunErrorDetails {
  exitCode?: number | null;
  stderrTail?: string;
  stdoutTail?: string;
  attempts?: number;
  extractedMessage?: string;
  /** Separate plain-stderr diagnostics, each classified on its own (never split into lines). */
  diagnostics?: string[];
  providerState?: ProviderState;
  resetAt?: string;
  retryAfterSeconds?: number;
  guard?: GuardReport;
  processesStillAlive?: number[];
  /** The process list could not be read, so the stopped run's descendants are not confirmed dead. */
  killUnverified?: boolean;
}

export class ClineRunError extends Error {
  public codeMapSource?: CodeMapSource;
  public readonly exitCode?: number | null;
  public readonly stderrTail?: string;
  public readonly stdoutTail?: string;
  public readonly attempts?: number;
  public readonly extractedMessage?: string;
  public readonly diagnostics?: string[];
  public readonly providerState?: ProviderState;
  public readonly resetAt?: string;
  public readonly retryAfterSeconds?: number;
  public readonly guard?: GuardReport;
  public readonly processesStillAlive?: number[];
  public readonly killUnverified?: boolean;
  /** Where the failed run's trace was written, when one was recorded. */
  public trace?: TraceInfo;
  /** Secondary problems that happened after this error, e.g. a cleanup that also failed. */
  public notes?: string[];

  constructor(
    public readonly kind: ClineErrorKind,
    message: string,
    details?: ClineRunErrorDetails
  ) {
    super(message);
    this.name = "ClineRunError";
    if (details) {
      this.exitCode = details.exitCode;
      this.stderrTail = details.stderrTail;
      this.stdoutTail = details.stdoutTail;
      this.attempts = details.attempts;
      this.extractedMessage = details.extractedMessage ? redactSecrets(details.extractedMessage) : undefined;
      this.diagnostics = details.diagnostics?.length ? details.diagnostics.map(redactSecrets) : undefined;
      this.providerState = details.providerState;
      this.resetAt = details.resetAt;
      this.retryAfterSeconds = details.retryAfterSeconds;
      this.guard = details.guard;
      this.processesStillAlive = details.processesStillAlive;
      this.killUnverified = details.killUnverified;
    }
  }
}

export type KillTreeFn = (pid: number, signal?: NodeJS.Signals) => void;

export function defaultKillTree(pid: number, signal: NodeJS.Signals = "SIGKILL", platform: NodeJS.Platform = process.platform): void {
  try {
    if (platform === "win32") {
      spawn("taskkill", ["/PID", String(pid), "/T", "/F"], {
        windowsHide: true,
        stdio: "ignore"
      }).on("error", () => {});
    } else {
      process.kill(-pid, signal);
    }
  } catch {}
}

/** Kill a process tree and wait until the root process is gone (or the deadline passes). True when it is gone. */
export async function killTreeAndWait(pid: number, timeoutMs = TREE_KILL_CONFIRM_MS, platform: NodeJS.Platform = process.platform, signal?: AbortSignal): Promise<boolean> {
  const gone = () => { try { process.kill(pid, 0); return false; } catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH"; } };
  if (gone()) return true;
  if (signal?.aborted || timeoutMs <= 0) return false;
  const capMs = Math.min(timeoutMs, TREE_KILL_CONFIRM_MS);
  const deadline = performance.now() + capMs;
  if (platform === "win32") {
    await killWindowsTree(pid, capMs, signal);
  } else {
    try { process.kill(-pid, "SIGKILL"); } catch { try { process.kill(pid, "SIGKILL"); } catch { /* gone */ } }
  }
  while (!gone() && !signal?.aborted && performance.now() < deadline) {
    await new Promise<void>(resolve => {
      const wake = () => { clearTimeout(timer); signal?.removeEventListener("abort", wake); resolve(); };
      const timer = setTimeout(wake, Math.min(100, Math.max(0, deadline - performance.now())));
      signal?.addEventListener("abort", wake, { once: true });
    });
  }
  return gone();
}

export interface ClineDependencies {
  spawn?: typeof spawn;
  platform?: NodeJS.Platform;
  access?: typeof access;
  entryPath?: string;
  providerSettingsPath?: string;
  backoffMs?: number;
  updateBackoffMs?: number;
  timeoutMs?: number;
  closeGracePeriodMs?: number;
  killGracePeriodMs?: number;
  settlementDeadlineMs?: number;
  minRetryBudgetMs?: number;
  lockTimeoutMs?: number;
  acquireSettingsMutex?: MutexOptions["acquireSettingsMutex"];
  sleep?: (ms: number) => Promise<void>;
  setTimeout?: typeof setTimeout;
  clearTimeout?: typeof clearTimeout;
  totalBudgetMs?: number;
  killTree?: KillTreeFn;
  now?: () => number;
  /** Wall clock for the provider status file; `now` stays monotonic. */
  wallNow?: () => number;
  /** Provider status file; null disables status bookkeeping. */
  statusPath?: string | null;
  /** Base folder for per-run traces (default %TEMP%/cline-tasks). */
  traceBase?: string;
  /** Test seams for the hub and its Windows job, including with a fake spawn. */
  startHub?: (options: ClineInvocationOptions) => Promise<DedicatedHub | undefined>;
  createWindowsJob?: typeof createWindowsJob;
  confirmTreeDead?: typeof confirmTreeDead;
}

export interface ClineInvocationOptions {
  /** Internal: environment that points this run at its own Cline hub (set by runCline). */
  hubEnv?: Record<string, string>;
  /** Internal: starts this run's hub on first use and returns its environment (set by runCline). */
  hubProvider?: (cwd?: string) => Promise<Record<string, string> | undefined>;
  /** Internal: owns the hub and its job across the runs of one edit execution. */
  editHub?: DedicatedHubSession;
  /** Internal: called once Cline was actually launched with the hub environment (set by runCline). */
  onLaunched?: () => void;
  /** Map preparation is part of the run's existing total deadline. */
  preparationMs?: number;
  codeMapSource?: CodeMapSource;
  onCodeMapSource?: (source: CodeMapSource) => void;
  /** Internal task-owned lease; a sync run otherwise acquires its own lease. */
  checkoutLock?: import("./checkoutlock.js").CheckoutRelease;
  /** Internal: the checkout root that `checkoutLock` covers, when the run itself works in a subfolder of it. */
  checkoutRoot?: string;
  /** Override for isolated tests; production uses ~/.cline-mcp/locks. */
  checkoutLockDirectory?: string;
  onHeavyQueue?: (queue?: import("./heavyslots.js").QueuePosition) => void;
  autoApprove?: boolean;
  cwd?: string;
  systemPrompt?: string;
  provider?: string;
  model?: string;
  deps?: ClineDependencies;
  /** Defaults to 2; the ping uses 1. */
  maxAttempts?: number;
  /** Record a live trace (events.ndjson + status.json) for this run and return its location. */
  trace?: boolean;
  /** Text placed before the caller's prompt. Not counted against the prompt limits, which apply to the caller's text. */
  promptPreamble?: string;
  /** Upper bound for timeoutSeconds (default 300). Async tasks raise it; the sync tools keep 300. */
  maxTimeoutSeconds?: number;
  /** Fixed run id for the trace (async tasks use their task id). */
  traceRunId?: string;
  /** Called as soon as the trace recorder exists, before Cline starts. */
  onTraceStart?: (recorder: TraceRecorder) => void;
  /** Record the outcome in the provider status file (default true). */
  recordStatus?: boolean;
  /** Refuse without launching while a cached daily-quota lock is active (default true). */
  respectQuotaLock?: boolean;
  canRetry?: (attemptOutput: { stdout: string; stderr: string; attempt: number }) => Promise<boolean> | boolean;
  guard?: GuardOptions;
}

export type CodeMapSource = "codeindex" | "regex" | "none";

export interface ClineResponse extends ClineFinalResult {
  codeMapSource?: CodeMapSource;
  /** Final counters on every run, including successful runs and all internal attempts. */
  guard?: GuardReport;
  durationMs: number;
  /** Where this run's live trace was written (only when requested). */
  trace?: TraceInfo;
}

const DEFAULT_TIMEOUT_SECONDS = 180;
const MAX_TIMEOUT_SECONDS = 300;
export const MAX_PROMPT_CHARACTERS = 20_000;
export const MAX_SYSTEM_PROMPT_CHARACTERS = 8_000;
export const MAX_TOTAL_TEXT_CHARACTERS = 24_000;
export const PROVIDER_MODEL_REGEX = /^[A-Za-z0-9._:/@-]{1,120}$/;
export const TAIL_CHARACTERS = 2000;

export function redactSecrets(text: string): string {
  if (!text) return "";
  let result = text;

  const typeKeyword = /^(?:string|number|boolean|bigint|symbol|object|unknown|any|never|void|undefined|null|true|false)(?:\[\])?[),;}>\]]*$/;

  // Quoted keys in JSON and configuration snippets. A nested object or array is left alone (its own keys are
  // checked separately), and an exact type keyword (`"apiKey": string`) is a type annotation, not a value.
  result = result.replace(
    /((["'])(?:api[_-]?key|x-api-key|(?:access|refresh|auth)[_-]?token|client[_-]?secret|token|secret|password|key|authorization|proxy-authorization|cookie|set-cookie)\2\s*[:=]\s*)(?:(Bearer|Basic)[ \t]+)?("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s"',;}\]{[][^\s"',;}\]]*)/gi,
    (match, prefix, _keyQuote, scheme: string | undefined, value: string) => {
      if (!scheme && (typeKeyword.test(value) || value === "<redacted>")) return match;
      const quote = /^["']/.test(value) ? value[0] : "";
      return prefix + (scheme ? `${scheme} ` : "") + quote + "<redacted>" + quote;
    }
  );

  // 3. Environment variable assignments (e.g. KEY=val, NVIDIA_KEY=val, MY_TOKEN=val):
  result = result.replace(
    /\b([A-Za-z0-9_]*(?:API_KEY|TOKEN|SECRET|PASSWORD|_KEY|KEY)[A-Za-z0-9_]*\s*=\s*(?:(?:Bearer|Basic)[ \t]+)?)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\S+)/gi,
    "$1<redacted>"
  );

  // 4. Header-style Authorization and Proxy-Authorization:
  // Authorization: Basic ..., Authorization: Bearer ..., Authorization: <scheme> <value>, or Authorization: <value>
  result = result.replace(
    /\b((?:Proxy-)?Authorization\s*:\s*)(?:([A-Za-z0-9_-]+)[ \t]+)?(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s"',;]+)/gi,
    (match, prefix, scheme) => {
      return scheme ? `${prefix}${scheme} <redacted>` : `${prefix}<redacted>`;
    }
  );

  // 5. Cookie and Set-Cookie headers:
  result = result.replace(/\b((?:Set-)?Cookie\s*:\s*)[^\r\n]+/gi, "$1<redacted>");

  // 6. Headers / key-value forms for x-api-key, api-key:
  result = result.replace(
    /\b(x-api-key|api-key)\s*[:=]\s*(?:(?:Bearer|Basic)[ \t]+)?(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\S+)/gi,
    "$1: <redacted>"
  );

  // 7. Key-value forms for token, key, secret, password (e.g. token: ..., secret = ..., password: ...):
  // Redacts whole value up to whitespace/quote/comma/semicolon (covers JWT a.b.c),
  // while keeping TypeScript/JS type annotations like `key: string` or `token: unknown[]`.
  result = result.replace(
    // A scheme and its value stay on one line, and a quoted value after the scheme is hidden too (plan S20 review).
    /\b(api_?key|(?:access|refresh|auth)[_-]?token|client[_-]?secret|token|key|secret|password)\s*([:=]|\bis\b)\s*(?:(Bearer|Basic)[ \t]+(?:<redacted>|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s"',;]+)|(<redacted>|(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')|[^\s"',;]+))/gi,
    (match, keyName, sep, scheme, value) => {
      if (sep === ":" && !scheme && value && typeKeyword.test(value)) {
        return match;
      }
      // Already redacted by an earlier rule (e.g. `AUTH_TOKEN=<redacted>`): keep the text exactly as it is.
      if (!scheme && value === "<redacted>") return match;
      const isIs = sep.toLowerCase() === "is";
      const separator = isIs ? " is " : (sep.includes("=") ? " = " : ": ");
      if (scheme) {
        return `${keyName}${separator}${scheme} <redacted>`;
      }
      return `${keyName}${separator}<redacted>`;
    }
  );

  // 8. Known token prefixes (sk-..., nvapi-...):
  result = result.replace(/\bsk-[A-Za-z0-9_-]{8,}\b/gi, "<redacted>");
  result = result.replace(/\bnvapi-[A-Za-z0-9_-]{8,}\b/gi, "<redacted>");

  return result;
}

function formatSeconds(ms: number): string {
  const seconds = ms / 1000;
  return Number.isInteger(seconds) ? `${seconds}s` : `${seconds.toFixed(seconds < 10 ? 3 : 1)}s`;
}

export function getTail(text: string, maxChars: number = TAIL_CHARACTERS): string {
  if (!text) return "";
  return text.length <= maxChars ? text : text.slice(-maxChars);
}

export function buildErrorTextWithTails(summary: string, stderrTail?: string, stdoutTail?: string): string {
  const parts = [redactSecrets(summary)];
  if (stderrTail && stderrTail.trim()) {
    parts.push(`Stderr tail:\n${redactSecrets(stderrTail.trim())}`);
  }
  if (stdoutTail && stdoutTail.trim()) {
    parts.push(`Stdout tail:\n${redactSecrets(stdoutTail.trim())}`);
  }
  return parts.join("\n\n");
}

export function formatErrorAsText(error: unknown, fallbackMessage: string): string {
  if (error instanceof ClineRunError) {
    const lines: string[] = [
      `Kind: ${error.kind}`,
      `Message: ${error.message}`
    ];
    if (error.exitCode !== undefined && error.exitCode !== null && !error.message.includes(`Exit code: ${error.exitCode}`)) {
      lines.push(`Exit code: ${error.exitCode}`);
    }
    if (error.attempts !== undefined && !error.message.includes(`Attempts: ${error.attempts}`)) {
      lines.push(`Attempts: ${error.attempts}`);
    }
    if (error.resetAt) {
      lines.push(`Reset at: ${error.resetAt}`);
    }
    if (error.retryAfterSeconds !== undefined) {
      lines.push(`Retry after: ${error.retryAfterSeconds}s`);
    }
    if (error.stderrTail && !error.message.includes(error.stderrTail)) {
      lines.push(`Stderr tail:\n${error.stderrTail}`);
    }
    if (error.stdoutTail && !error.message.includes(error.stdoutTail)) {
      lines.push(`Stdout tail:\n${error.stdoutTail}`);
    }
    if (error.trace) {
      lines.push(`Trace: ${error.trace.dir}`);
    }
    if (error.guard) {
      lines.push(`Guard Report:\n${JSON.stringify(error.guard, null, 2)}`);
    }
    if (error.processesStillAlive && error.processesStillAlive.length > 0) {
      lines.push(`Processes still alive: ${error.processesStillAlive.join(", ")}`);
    }
    if (error.codeMapSource) lines.push(`codeMapSource: ${error.codeMapSource}`);
    for (const note of error.notes ?? []) {
      lines.push(`Note: ${note}`);
    }
    if ("evidence" in error && (error as any).evidence) {
      lines.push(`Evidence:\n${JSON.stringify((error as any).evidence, null, 2)}`);
    }
    return lines.join("\n\n");
  }
  if (error instanceof Error) {
    const trace = (error as { trace?: TraceInfo }).trace;
    return trace ? `${error.message}\n\nTrace: ${trace.dir}` : error.message;
  }
  return fallbackMessage;
}

export function isTransientError(info: {
  code?: number | null;
  stderr?: string;
  runResultErrorText?: string;
  extractedError?: string;
  timedOut?: boolean;
}): boolean {
  if (info.timedOut) return true;

  const errorSources: string[] = [];
  if (info.extractedError) {
    errorSources.push(info.extractedError);
  }
  if (info.runResultErrorText) {
    errorSources.push(info.runResultErrorText);
  }
  if (info.stderr) {
    for (const rawLine of info.stderr.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line) continue;
      try {
        const parsed = JSON.parse(line);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          if (parsed.type === "error" || Object.hasOwn(parsed, "error")) {
            const msg = typeof parsed.message === "string"
              ? parsed.message
              : typeof parsed.error === "string"
              ? parsed.error
              : typeof parsed.error?.message === "string"
              ? parsed.error.message
              : line;
            errorSources.push(msg);
          }
        }
      } catch {
        if (
          /error/i.test(line) ||
          /(?:status|code|http)\D{0,5}(?:429|5\d\d)\b/i.test(line) ||
          /\b(overloaded|rate\s*limit|too\s*many\s*requests|temporarily\s*unavailable|temporarily\s*overloaded|econnreset|etimedout)\b/i.test(line) ||
          /\b(upstream\s*error|provider\s*error)\b/i.test(line)
        ) {
          errorSources.push(line);
        }
      }
    }
  }

  const combined = errorSources.join("\n").toLowerCase();
  if (!combined.trim()) return false;

  const patterns = [
    /(?:status|code|http)\D{0,5}(?:429|5\d\d)\b/i,
    /\b(overloaded|rate\s*limit|too\s*many\s*requests|temporarily\s*unavailable|temporarily\s*overloaded|econnreset|etimedout)\b/i,
    /\b(upstream\s*error|provider\s*error)\b/i
  ];

  return patterns.some((pattern) => pattern.test(combined));
}

function plainStderrDiagnostics(stderr: string): string[] {
  const diagnostics: string[] = [];
  for (const rawLine of stderr.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.startsWith("{") || line.startsWith("[")) {
      try { JSON.parse(line); continue; } catch { /* plain diagnostic */ }
    }
    if (
      /error/i.test(line) ||
      // A bare leading status (`429 status code (no body)`) is a provider diagnostic too (plan S20, Gate 6).
      /^429\b(?!\s*\|)/.test(line) ||
      /(?:status|code|http)\D{0,5}(?:429|5\d\d)\b/i.test(line) ||
      /\b(overloaded|rate\s*limit|too\s*many\s*requests|temporarily\s*unavailable|temporarily\s*overloaded|econnreset|etimedout)\b/i.test(line) ||
      /\b(upstream\s*error|provider\s*error)\b/i.test(line)
    ) {
      diagnostics.push(line);
    }
  }
  return diagnostics;
}

export function extractPlainStderrError(stderr: string): string | undefined {
  return plainStderrDiagnostics(stderr).at(-1);
}

export function hasMadeToolCallsOrModifications(stdout: string): boolean {
  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    try {
      const obj = JSON.parse(line);
      if (!obj || typeof obj !== "object") continue;
      const type = String(obj.type ?? "").toLowerCase();
      if (type.includes("tool") || type.includes("action") || type.includes("command") || type.includes("edit")) {
        return true;
      }
      if (obj.event && typeof obj.event === "object") {
        const innerType = String(obj.event.type ?? "").toLowerCase();
        if (innerType.includes("tool") || innerType.includes("action") || innerType.includes("command") || innerType.includes("edit")) {
          return true;
        }
      }
      if (obj.tool || obj.tools || obj.toolCall || obj.toolCalls) {
        return true;
      }
    } catch {
      return true;
    }
  }
  return false;
}

async function validateCwd(cwd: string | undefined, accessFn?: typeof access): Promise<string | undefined> {
  if (!cwd) return undefined;
  const resolved = path.resolve(cwd);
  try {
    await (accessFn ?? access)(resolved);
    return resolved;
  } catch {
    throw new ClineRunError("launch_failed", "The requested cwd does not exist or is not accessible.");
  }
}

export function validateInputLimits(input: AskClineInput): void {
  const systemPromptLength = input.systemPrompt?.length ?? 0;
  if (input.prompt.length > MAX_PROMPT_CHARACTERS) {
    throw new ClineRunError("launch_failed", `prompt must not exceed ${MAX_PROMPT_CHARACTERS} characters.`);
  }
  if (systemPromptLength > MAX_SYSTEM_PROMPT_CHARACTERS) {
    throw new ClineRunError("launch_failed", `systemPrompt must not exceed ${MAX_SYSTEM_PROMPT_CHARACTERS} characters.`);
  }
  if (input.prompt.length + systemPromptLength > MAX_TOTAL_TEXT_CHARACTERS) {
    throw new ClineRunError("launch_failed", `prompt and systemPrompt together must not exceed ${MAX_TOTAL_TEXT_CHARACTERS} characters.`);
  }
  if (input.provider) {
    if (PROHIBITED_NAMES.has(input.provider.toLowerCase())) {
      throw new ClineRunError("launch_failed", `provider "${input.provider}" is prohibited.`);
    }
    if (!PROVIDER_MODEL_REGEX.test(input.provider)) {
      throw new ClineRunError("launch_failed", `provider must match ^[A-Za-z0-9._:/@-]{1,120}$`);
    }
  }
  if (input.model) {
    if (PROHIBITED_NAMES.has(input.model.toLowerCase())) {
      throw new ClineRunError("launch_failed", `model "${input.model}" is prohibited.`);
    }
    if (!PROVIDER_MODEL_REGEX.test(input.model)) {
      throw new ClineRunError("launch_failed", `model must match ^[A-Za-z0-9._:/@-]{1,120}$`);
    }
  }
}

/** CreateProcess limit is 32,767 UTF-16 units; keep a margin for what Node adds. */
export const WINDOWS_COMMAND_LINE_LIMIT = 32_000;

/**
 * Length of the command line Node builds on Windows (MSVC quoting: each argument quoted, quotes escaped,
 * backslashes before a quote or the closing quote doubled). Used to refuse an over-long request clearly
 * instead of failing at spawn.
 */
export function windowsCommandLineLength(executable: string, args: string[]): number {
  let total = 0;
  for (const arg of [executable, ...args]) {
    let length = 2; // surrounding quotes
    let backslashes = 0;
    for (const ch of arg) {
      if (ch === "\\") { backslashes++; length++; continue; }
      if (ch === "\"") length += backslashes + 2; // doubled backslashes + escaped quote
      else length += ch.length; // UTF-16 units: a character outside the BMP (e.g. an emoji) counts 2
      backslashes = 0;
    }
    length += backslashes; // backslashes before the closing quote are doubled
    total += length + 1; // separating space
  }
  return total;
}

/** The Cline CLI entry script the runner launches (and whose install holds the model catalog). */
export interface ResolveEntryOptions {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  execPath?: string;
  exists?: (p: string) => boolean;
  realpath?: (p: string) => string;
}

export function resolveClineEntry(entryPath?: string, opts: ResolveEntryOptions = {}): string | undefined {
  const {
    platform = process.platform,
    env = process.env,
    execPath = process.execPath,
    exists = existsSync,
    realpath = realpathSync
  } = opts;
  if (entryPath !== undefined) return entryPath;
  if (env.CLINE_MCP_CLINE_ENTRY) return env.CLINE_MCP_CLINE_ENTRY;
  if (platform === "win32") {
    return env.APPDATA ? path.win32.join(env.APPDATA, "npm", "node_modules", "cline", "bin", "cline") : undefined;
  }
  const a = path.posix.join(path.posix.dirname(path.posix.dirname(execPath)), "lib", "node_modules", "cline", "bin", "cline");
  if (exists(a)) return a;
  for (const dir of (env.PATH ?? "").split(":")) {
    if (!dir) continue;
    const c = path.posix.join(dir, "cline");
    if (!exists(c)) continue;
    let r: string;
    try { r = realpath(c); } catch { continue; }
    if (r.endsWith("/node_modules/cline/bin/cline")) return r;
  }
  return undefined;
}

export const MISSING_SELECTION_MESSAGE =
  "provider and model are required. The bridge never runs on Cline's saved default model, which can go stale silently. " +
  "Pass provider \"cline\" and a model id; call cline_list_models for the free models the installed Cline offers now.";

/** Refuses before launching (or creating a worktree) while a cached daily-quota lock is active. */
export async function enforceQuotaLock(
  provider: string | undefined,
  model: string | undefined,
  options: Partial<ClineInvocationOptions> = {}
): Promise<void> {
  if (options.respectQuotaLock === false) return;
  const statusPath = resolveStatusPath(options.deps?.statusPath);
  if (!statusPath) return;
  const wallNow = options.deps?.wallNow ?? Date.now;
  const lock = activeQuotaLock(
    await readStatusEntry(statusPath, provider, model).catch(() => undefined),
    wallNow()
  );
  if (lock) {
    throw new ClineRunError(
      "quota_exhausted",
      `Daily free quota for ${lock.provider}/${lock.model} is exhausted until ${lock.reset_at ?? lock.expires_at} ` +
        `(recorded ${lock.checked_at}); Cline was not launched.`,
      { attempts: 0, providerState: "quota_exhausted", resetAt: lock.reset_at ?? lock.expires_at, extractedMessage: lock.reason }
    );
  }
}

/** Fails before any I/O when the caller did not choose both provider and model. */
export function requireSelection(input: { provider?: string; model?: string }): void {
  if (!input.provider || !input.model) throw new ClineRunError("launch_failed", MISSING_SELECTION_MESSAGE, { attempts: 0 });
}

/** Free loopback TCP port (best effort; the hub binds it moments later). */
async function freeLoopbackPort(): Promise<number | undefined> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(undefined));
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : undefined;
      server.close(() => resolve(port));
    });
  });
}

export const DEDICATED_HUB_BASE = path.join(os.tmpdir(), "cline-mcp-hubs");

export interface DedicatedHub { env: Record<string, string>; stop: (budget?: SettlementBudget) => Promise<TreeKillResult | void>; isListening?: (timeoutMs?: number, signal?: AbortSignal) => Promise<boolean> }

export interface HubStopDeps {
  /** True while something accepts connections on the hub's loopback port. */
  isListening?: (port: number, timeoutMs?: number, signal?: AbortSignal) => Promise<boolean>;
  /** True when the hub wrote its discovery record, i.e. it started even if the port probe misses it. */
  hubStarted?: () => Promise<boolean>;
  /** Runs `cline hub stop` for this hub's discovery record. False signals a failed stop. */
  runHubStop?: (timeoutMs: number, signal?: AbortSignal) => Promise<boolean | void>;
  listProcesses?: typeof listClineProcesses;
  killTree?: (pid: number, timeoutMs: number) => Promise<unknown>;
  removeFiles?: () => Promise<void>;
}

export function loopbackPortListening(port: number, timeoutMs = 1_500, signal?: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    if (timeoutMs <= 0 || signal?.aborted) { resolve(false); return; }
    const socket = net.createConnection({ host: "127.0.0.1", port });
    const done = (open: boolean) => { signal?.removeEventListener("abort", abort); socket.destroy(); resolve(open); };
    const abort = () => done(false);
    signal?.addEventListener("abort", abort, { once: true });
    socket.setTimeout(Math.max(1, Math.floor(timeoutMs)), () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}

/** Stop a detected hub and fall back to a Windows process scan if the stop fails or the port stays open. */
export async function stopDedicatedHub(port: number, deps: HubStopDeps, budget?: SettlementBudget): Promise<TreeKillResult | void> {
  const now = budget?.now ?? (() => performance.now());
  const deadline = now() + 60_000;
  const remaining = (cap: number) => Math.max(0, Math.min(cap, deadline - now(), budget?.remaining() ?? Infinity));
  const check = () => { if (!remaining(Infinity) || budget?.signal.aborted) throw new Error("Hub stop deadline expired."); };
  const bounded = <T>(work: Promise<T>): Promise<T> => budget ? untilAborted(work, budget.signal) : work;
  const isListening = async () => {
    check();
    const listening = await bounded((deps.isListening ?? loopbackPortListening)(port, remaining(1_500), budget?.signal));
    check();
    return listening;
  };
  const hubDetected = async () => (await deps.hubStarted?.()) || isListening();
  const alive: number[] = [];
  try {
    if (!await hubDetected()) {
      await new Promise<void>(resolve => {
        const wait = remaining(300);
        if (wait <= 0 || budget?.signal.aborted) { resolve(); return; }
        const wake = () => { clearTimeout(timer); budget?.signal.removeEventListener("abort", wake); resolve(); };
        const timer = setTimeout(wake, wait);
        budget?.signal.addEventListener("abort", wake, { once: true });
      });
      if (!await hubDetected()) return;
    }
    check();
    const stopped = deps.runHubStop
      ? await bounded(deps.runHubStop(remaining(PROCESS_QUERY_TIMEOUT_MS), budget?.signal)).catch(() => false)
      : undefined;
    if (stopped !== false && !await isListening()) return;
    if (process.platform === "win32") {
      const listProcesses = deps.listProcesses ?? listClineProcesses;
      const processes = await bounded(listProcesses(remaining(PROCESS_TABLE_TIMEOUT_MS), budget?.signal)).catch(() => undefined);
      // The stop failed and the process list cannot be read: the daemon is not confirmed dead (plan S20, Gate 6).
      if (!processes) return { confirmed: false, alive, unverified: true };
      for (const pid of hubDaemonPidsOnPort(port, processes)) {
        const cap = remaining(TREE_KILL_CONFIRM_MS);
        const confirmed = await bounded(deps.killTree ? deps.killTree(pid, cap) : killTreeAndWait(pid, cap, process.platform, budget?.signal)).catch(() => false);
        if (confirmed !== true) alive.push(pid);
      }
    }
    if (await isListening() || alive.length) return { confirmed: false, alive, unverified: true };
  } catch {
    return { confirmed: false, alive, unverified: true };
  } finally {
    await deps.removeFiles?.();
  }
}

/**
 * Cline 3.x runs sessions through a hub daemon and resolves a model's RELATIVE tool paths against the
 * hub's own cwd, not the session's --cwd. The shared hub sits wherever it was first started (the user's
 * home, or an old worktree), so `src/x.py` was read from, and could be written to, the wrong folder.
 * Cline starts a dedicated hub on demand in the run's --cwd. Only automatic repairs in that same
 * edit execution can reuse its discovery record and port.
 */
async function dedicatedHub(options: ClineInvocationOptions): Promise<DedicatedHub | undefined> {
  if (options.hubEnv || options.deps?.spawn || options.deps?.entryPath) return undefined;
  const entry = resolveClineEntry();
  if (!entry) return undefined;
  const port = await freeLoopbackPort();
  if (port === undefined) throw new Error("No free loopback port.");
  await mkdir(DEDICATED_HUB_BASE, { recursive: true });
  const discovery = path.join(DEDICATED_HUB_BASE, `hub-${randomUUID()}.json`);
  const env = { CLINE_HUB_DISCOVERY_PATH: discovery, CLINE_HUB_PORT: String(port) };
  const stop = (budget?: SettlementBudget) => stopDedicatedHub(port, {
    hubStarted: () => access(discovery).then(() => true, () => false),
    runHubStop: (timeoutMs, signal) => new Promise<boolean>((resolve) => {
      if (!timeoutMs || signal?.aborted) { resolve(false); return; }
      const child = spawn(process.execPath, [entry, "hub", "stop"], {
        cwd: os.homedir(), windowsHide: true, stdio: "ignore", env: { ...process.env, ...env }
      });
      const stop = () => { try { child.kill(); } catch { /* gone */ } resolve(false); };
      const timer = setTimeout(stop, timeoutMs);
      signal?.addEventListener("abort", stop, { once: true });
      const cleanup = () => { clearTimeout(timer); signal?.removeEventListener("abort", stop); };
      timer.unref?.();
      child.once("error", () => { cleanup(); resolve(false); });
      child.once("close", code => { cleanup(); resolve(code === 0); });
    }).catch(() => false),
    removeFiles: async () => {
      for (const file of [discovery, `${discovery}.instance.lock`]) {
        await rm(file, { force: true, maxRetries: 3, retryDelay: 200 }).catch(() => {});
      }
    }
  }, budget);
  return { env, stop, isListening: (ms, signal) => loopbackPortListening(port, ms, signal) };
}

interface RunJobs {
  current?: WindowsJob;
  stopped?: boolean;
}

/** Owns a hub and the kill-on-close job inherited by its daemon. Runs in a session are sequential. */
export class DedicatedHubSession {
  readonly jobs: RunJobs = {};
  readonly warnings: string[] = [];
  unconfirmedStop?: ClineRunError;
  private hub?: DedicatedHub;
  private cwd?: string;
  launched = false;

  async environment(cwd: string, options: ClineInvocationOptions, budget?: SettlementBudget): Promise<Record<string, string> | undefined> {
    if (this.hub) {
      if (cwd === this.cwd && (!this.hub.isListening || await this.hub.isListening(Math.min(1_500, budget?.remaining() ?? Infinity), budget?.signal))) return this.hub.env;
      await this.stop(budget);
    }
    if (this.unconfirmedStop) throw this.unconfirmedStop;
    this.cwd = cwd;
    this.hub = await (options.deps?.startHub ?? dedicatedHub)(options);
    return this.hub?.env;
  }

  async stop(budget?: SettlementBudget): Promise<void> {
    const job = this.jobs.current;
    const isConfirmed = (j?: WindowsJob) => j?.confirmed === true;
    let jobConfirmed = isConfirmed(job);
    const closeJob = async (): Promise<boolean> => {
      if (!job) return false;
      if (isConfirmed(job)) { jobConfirmed = true; return true; }
      const cap = budget
        ? (job.assigned ? Math.min(KILL_SETTLE_MS, Math.max(budget.remaining(), budget.confirmRemaining())) : budget.remaining())
        : KILL_SETTLE_MS;
      const closeSignal = budget ? (job.assigned ? budget.confirmSignal : budget.signal) : undefined;
      const ok = await job.close(cap, closeSignal);
      if (ok === true || isConfirmed(job)) jobConfirmed = true;
      return jobConfirmed;
    };
    try {
      if (this.jobs.stopped) await closeJob();
      const jobDrainedBeforeHubStop = jobConfirmed;
      // Only the launched CLI can have started the daemon.
      const result = this.launched ? await this.hub?.stop(budget) : undefined;
      if (result && !result.confirmed) {
        if (!jobConfirmed) await closeJob();
        if (!jobConfirmed || (jobDrainedBeforeHubStop && result.alive.length > 0)) {
          const message = "The dedicated Cline hub could not be confirmed stopped.";
          this.unconfirmedStop = new ClineRunError("edits_inspection_failed", message,
            { processesStillAlive: result.alive, killUnverified: true });
          this.warnings.push(message);
        }
      }
    } catch (error) {
      this.warnings.push(redactSecrets(`Failed to stop the dedicated Cline hub: ${error instanceof Error ? error.message : String(error)}`));
    } finally {
      await closeJob();
      this.jobs.current = undefined;
      this.jobs.stopped = false;
      this.hub = undefined;
      this.launched = false;
    }
  }
}

export async function runCline(
  input: AskClineInput,
  signal?: AbortSignal,
  options: ClineInvocationOptions = {}
): Promise<ClineResponse> {
  // The hub starts only when Cline is about to launch (plan S6, B6): a call refused before launch (quota
  // lock, bad cwd, cancel) starts and stops nothing.
  const workMs = (options.deps?.totalBudgetMs ?? (input.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS) * 1000) - (options.preparationMs ?? 0);
  const budget = settlementBudget(workMs, signal, options.deps?.now);
  const hub = options.editHub ?? new DedicatedHubSession();
  // Internal CLI attempts share their original environment; only the next run probes the hub.
  let hubEnv: Promise<Record<string, string> | undefined> | undefined;
  const hubProvider = (cwd?: string) => hubEnv ??= hub.environment(cwd ?? process.cwd(), options, budget);
  const invocation = options.hubEnv ? options : { ...options, hubProvider, onLaunched: () => { hub.launched = true; } };

  let result: ClineResponse | undefined;
  let runError: unknown;
  try {
    result = await runClineInner(input, signal, invocation, hub.jobs, budget);
    return result;
  } catch (error) {
    runError = error;
    throw error;
  } finally {
    try { if (!options.editHub) await hub.stop(budget); } finally { budget.dispose(); }
    if (!options.editHub && hub.warnings.length) {
      if (result) (result.warnings ??= []).push(...hub.warnings);
      else if (runError instanceof ClineRunError) (runError.notes ??= []).push(...hub.warnings);
    }
  }
}

async function runClineInner(
  input: AskClineInput,
  signal: AbortSignal | undefined,
  options: ClineInvocationOptions,
  jobs: RunJobs, budget: SettlementBudget
): Promise<ClineResponse> {
  const guards: Guard[] = [];
  const finalReport = (existing?: GuardReport): GuardReport => {
    const reports = guards.map(guard => guard.snapshot());
    const last = reports.at(-1) ?? existing ?? { window: options.guard?.window ?? input.guard?.window ?? 10,
      lastErrors: [], totalToolCalls: 0, totalInputTokens: 0, budgetInputTokens: 0, filesTouched: [] };
    return Object.assign(last, {
      ...(reports.length ? { processToolCalls: reports.reduce((sum, report) => sum + (report.processToolCalls ?? 0), 0) } : {}),
      totalToolCalls: reports.length ? reports.reduce((sum, report) => sum + report.totalToolCalls, 0) : last.totalToolCalls,
      totalInputTokens: reports.length ? reports.reduce((sum, report) => sum + report.totalInputTokens, 0) : last.totalInputTokens,
      budgetInputTokens: reports.length ? reports.reduce((sum, report) => sum + (report.budgetInputTokens ?? report.totalInputTokens), 0)
        : last.budgetInputTokens ?? last.totalInputTokens,
      filesTouched: [...new Set(reports.length ? reports.flatMap(report => report.filesTouched) : last.filesTouched)] });
  };
  try {
    const response = await runClineCore(input, signal, options, guards, jobs, budget);
    response.guard = finalReport();
    if (options.codeMapSource) response.codeMapSource = options.codeMapSource;
    return response;
  } catch (error) {
    if (error && typeof error === "object") {
      const outcome = error as { guard?: GuardReport; codeMapSource?: CodeMapSource };
      outcome.guard = finalReport(outcome.guard);
      if (options.codeMapSource) outcome.codeMapSource = options.codeMapSource;
    }
    throw error;
  }
}

async function runClineCore(input: AskClineInput, signal: AbortSignal | undefined,
  options: ClineInvocationOptions, guards: Guard[], jobs: RunJobs, budget: SettlementBudget): Promise<ClineResponse> {
  if (signal?.aborted) {
    throw new ClineRunError("cancelled", "The Cline request was cancelled.", { attempts: 0 });
  }

  const effectiveInput: AskClineInput = {
    ...input,
    cwd: options.cwd ?? input.cwd,
    systemPrompt: options.systemPrompt ?? input.systemPrompt,
    provider: options.provider ?? input.provider,
    model: options.model ?? input.model,
    guard: options.guard ?? input.guard
  };
  requireSelection(effectiveInput);
  const timeoutSeconds = effectiveInput.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS;
  const maxTimeoutSeconds = options.maxTimeoutSeconds ?? MAX_TIMEOUT_SECONDS;
  if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > maxTimeoutSeconds) {
    throw new ClineRunError("launch_failed", `timeoutSeconds must be an integer from 1 to ${maxTimeoutSeconds}.`);
  }
  validateInputLimits(effectiveInput);

  const deps = options.deps ?? {};
  const recorder = options.trace ? new TraceRecorder({ base: deps.traceBase, wallNow: deps.wallNow, runId: options.traceRunId }) : undefined;
  if (recorder) options.onTraceStart?.(recorder);
  const platform = deps.platform ?? process.platform;
  const settingsPath = resolveProviderSettingsPath(deps.providerSettingsPath);

  const nowFn = deps.now ?? (() => performance.now());
  const totalBudgetMs = deps.totalBudgetMs ?? (timeoutSeconds * 1000);
  const overallDeadline = budget.workDeadline;
  const getRemainingBudgetMs = () => Math.max(0, overallDeadline - nowFn());
  const sleep = deps.sleep ?? (ms => delay(ms, undefined, { signal }).catch(() => {}));
  const schedule = deps.setTimeout ?? setTimeout;
  const unschedule = deps.clearTimeout ?? clearTimeout;
  const minRetryBudgetMs = deps.minRetryBudgetMs ?? (deps.timeoutMs !== undefined ? 0 : Math.min(15_000, Math.floor(totalBudgetMs * 0.25)));
  const wallNow = deps.wallNow ?? Date.now;

  const work = withProviderOverride(
    { provider: effectiveInput.provider, model: effectiveInput.model },
    settingsPath,
    signal,
    async (selection) => {
      effectiveInput.provider = selection.provider;
      effectiveInput.model = selection.model;
      const cwd = await validateCwd(effectiveInput.cwd, deps.access);

      const statusPath = options.recordStatus === false && options.respectQuotaLock === false
        ? undefined
        : resolveStatusPath(deps.statusPath);
      await enforceQuotaLock(effectiveInput.provider, effectiveInput.model, options);

      const recordPath = options.recordStatus === false ? undefined : statusPath;
      const statusStarted = nowFn();
      try {
        const response = await runAttempts(cwd);
        await recordStatusSafely(recordPath, buildEntry({
          provider: effectiveInput.provider,
          model: effectiveInput.model,
          classification: { state: "available" },
          reason: "real run completed",
          source: "run",
          latencyMs: nowFn() - statusStarted
        }, wallNow()));
        return response;
      } catch (error) {
        const classified = recordPath ? classifyRunError(error, wallNow()) : undefined;
        if (classified) {
          await recordStatusSafely(recordPath, buildEntry({
            provider: effectiveInput.provider,
            model: effectiveInput.model,
            classification: classified,
            reason: redactSecrets(classified.reason),
            source: "run",
            latencyMs: nowFn() - statusStarted
          }, wallNow()));
        }
        throw error;
      }
    },
    {
      deadline: overallDeadline,
      lockTimeoutMs: deps.lockTimeoutMs,
      acquireSettingsMutex: deps.acquireSettingsMutex,
      sleep: deps.sleep,
      nowFn
    }
  );
  if (!recorder) return work;
  try {
    const response = await work;
    response.trace = await recorder.finish({ ok: true });
    return response;
  } catch (err: any) {
    const info = await recorder.finish({ ok: false, kind: err?.kind, message: err?.message });
    // Any error object carries the trace location, typed or not, so no caller loses it.
    if (err && typeof err === "object") (err as { trace?: TraceInfo }).trace = info;
    throw err;
  }

  async function runAttempts(cwd: string | undefined): Promise<ClineResponse> {
      const windowsEntry = resolveClineEntry(deps.entryPath);

      if (process.platform === "win32" && !windowsEntry && !deps.entryPath) {
        throw new ClineRunError("launch_failed", "Unable to locate the local Cline CLI.");
      }

      const executable = windowsEntry ? process.execPath : "cline";
      const backoffMs = deps.backoffMs ?? 2500;
      const updateBackoffMs = deps.updateBackoffMs ?? 2000;
      const maxAttempts = Math.max(1, options.maxAttempts ?? 2);
      let attempt = 0;

      function remainingLaunchBudgetMs(): number {
        if (signal?.aborted) {
          throw new ClineRunError("cancelled", "The Cline request was cancelled.", { attempts: attempt - 1 });
        }
        const remaining = getRemainingBudgetMs();
        if (remaining <= 0) {
          throw new ClineRunError("timeout", `Cline exceeded the ${timeoutSeconds}-second timeout.`, { attempts: attempt - 1 });
        }
        return remaining;
      }

      while (attempt < maxAttempts) {
        attempt++;

        if (signal?.aborted) {
          throw new ClineRunError("cancelled", "The Cline request was cancelled.", { attempts: attempt - 1 });
        }

        // Auto-update check: if windowsEntry exists, check if file exists
        if (windowsEntry) {
          const accessFn = deps.access ?? access;
          try {
            await accessFn(windowsEntry);
          } catch {
            const remainingForUpdate = getRemainingBudgetMs();
            if (attempt < maxAttempts && remainingForUpdate > 0 && remainingForUpdate >= minRetryBudgetMs) {
              if (signal?.aborted) {
                throw new ClineRunError("cancelled", "The Cline request was cancelled.", { attempts: attempt });
              }
              const sleepMs = Math.min(updateBackoffMs, Math.max(0, remainingForUpdate - minRetryBudgetMs));
              if (sleepMs > 0) await sleep(sleepMs);
              if (signal?.aborted) {
                throw new ClineRunError("cancelled", "The Cline request was cancelled.", { attempts: attempt });
              }
              continue;
            }
            throw new ClineRunError(
              "cline_updating",
              "Cline CLI is missing or being updated; retry in ~30 s",
              { attempts: attempt }
            );
          }
        }

        // Every attempt may use all the time left (plan S6, B1): a 60/40 split killed slow but healthy first
        // attempts at 60%. A retry happens only when an attempt fails early enough to leave minRetryBudgetMs.
        const effectiveAttemptBudgetMs = remainingLaunchBudgetMs();
        const attemptTimeoutSeconds = Math.max(1, Math.ceil(effectiveAttemptBudgetMs / 1000));
        const attemptTimerMs = deps.timeoutMs !== undefined
          ? Math.min(deps.timeoutMs, effectiveAttemptBudgetMs)
          : effectiveAttemptBudgetMs;

        const args = [
          "--json",
          "--auto-approve", String(options.autoApprove ?? false),
          "--thinking", effectiveInput.thinking ?? "none",
          "--timeout", String(attemptTimeoutSeconds)
        ];
        if (effectiveInput.provider) args.push("-P", effectiveInput.provider);
        if (effectiveInput.model) args.push("-m", effectiveInput.model);
        if (effectiveInput.systemPrompt) args.push("--system", effectiveInput.systemPrompt);
        if (cwd) args.push("--cwd", cwd);
        args.push((options.promptPreamble ?? "") + effectiveInput.prompt);

        const spawnArgs = windowsEntry ? [windowsEntry, ...args] : args;
        if (platform === "win32") {
          const length = windowsCommandLineLength(executable, spawnArgs);
          if (length > WINDOWS_COMMAND_LINE_LIMIT) {
            throw new ClineRunError("launch_failed",
              `The request is too long for the Windows command line after escaping (${length} of ${WINDOWS_COMMAND_LINE_LIMIT} characters; ` +
              "quotes and backslashes count extra). Shorten the prompt or system prompt.", { attempts: attempt - 1 });
          }
        }

        const started = nowFn();
        let stdout = "";
        let stderr = "";
        // Per-attempt line splitting for the live trace; fragments never join across attempts.
        const thisAttempt = attempt;
        recorder?.attemptStarted(thisAttempt);
        const attemptGuard = { ...effectiveInput.guard, maxToolCalls: effectiveInput.guard?.maxToolCalls ?? 150,
          maxInputTokens: effectiveInput.guard?.maxInputTokens ?? 1_500_000 };
        for (const previous of guards) {
          const report = previous.snapshot();
          attemptGuard.maxToolCalls -= report.totalToolCalls;
          attemptGuard.maxInputTokens -= report.budgetInputTokens ?? report.totalInputTokens;
        }
        if (guards.length && (attemptGuard.maxToolCalls <= 0 || attemptGuard.maxInputTokens <= 0)) {
          throw new ClineRunError("budget_exceeded", "No guard budget remains for another attempt.", { attempts: attempt - 1 });
        }
        const guard = createGuard(attemptGuard);
        guards.push(guard);
        // Never repeat an attempt whose model already ran tools (plan S6, B1): its work may be half done.
        const guardState: { verdict: GuardVerdict | null } = { verdict: null };
        let trippedOnResult = false;
        let terminateChild!: (reason: "timeout" | "cancelled" | "guard") => void;
        const splitter = new LineSplitter(
          line => {
            recorder?.line(line, thisAttempt);
            try {
              const parsed = JSON.parse(line.trim());
              if (parsed && typeof parsed === "object") {
                const verdict = guard.observe(parsed);
                if (verdict) {
                  guardState.verdict = verdict;
                  trippedOnResult = verdict.kind === "budget_exceeded" && !!parseUsableResult(line, 0);
                  recorder?.line(JSON.stringify({
                    attempt: thisAttempt,
                    type: "guard_trip",
                    kind: verdict.kind,
                    report: verdict
                  }), thisAttempt);
                  terminateChild("guard");
                }
              }
            } catch {}
          },
          () => {
            guard.oversizedLine();
            recorder?.oversizedLine(thisAttempt);
          }
        );
        let timedOut = false;
        let cancelled = false;

        remainingLaunchBudgetMs();
        let hubEnv: Record<string, string> | undefined;
        try {
          hubEnv = options.hubEnv ?? await options.hubProvider?.(cwd);
        } catch (error) {
          if (error instanceof ClineRunError) throw error;
          throw new ClineRunError("launch_failed",
            redactSecrets(`Failed to start the dedicated Cline hub: ${error instanceof Error ? error.message : String(error)}`),
            { attempts: attempt - 1 });
        }
        const spawnFn = deps.spawn ?? spawn;
        // A hub launched by this CLI inherits its job, even when it detaches. Its job spans retries.
        const ownsHub = !!hubEnv && !options.hubEnv;
        const useJob = platform === "win32" && (!deps.spawn || !!deps.createWindowsJob);
        const prepareStarted = nowFn();
        if (useJob && !jobs.current?.alive) {
          jobs.current = await (deps.createWindowsJob ?? createWindowsJob)(Math.min(attemptTimerMs, remainingLaunchBudgetMs()), signal);
        }
        const job = jobs.current;
        const setupMs = useJob ? nowFn() - prepareStarted : 0;
        const env = {
          ...process.env,
          CLINE_NO_AUTO_UPDATE: "1",
          ...(hubEnv ?? {})
        };

        remainingLaunchBudgetMs();
        jobs.stopped = false;
        const execPromise = new Promise<{ code: number | null; signal: NodeJS.Signals | null; error?: any; processesStillAlive?: number[]; killUnverified?: boolean }>((resolve) => {
          let settled = false;
          let terminating = false;
          let hasRealPid = false;
          let child: ReturnType<typeof spawn>;
          let exitTimer: NodeJS.Timeout | undefined;
          let escalationTimer: NodeJS.Timeout | undefined;
          let settlementTimer: NodeJS.Timeout | undefined;
          let exitSeen = false;
          let exitSeenAt: number | undefined;
          let rootStartedMs = Date.now();
          let exitCode: number | null = null;
          let exitSignal: NodeJS.Signals | null = null;
          let spawnError: any;
          let closeStoppedJob: (() => Promise<boolean | void>) | undefined;

          const clampGrace = (ms: number) => Math.min(ms, getRemainingBudgetMs(), budget.remaining());
          const cleanup = () => {
            if (settled) return false;
            settled = true;
            unschedule(timer);
            if (exitTimer) unschedule(exitTimer);
            if (escalationTimer) unschedule(escalationTimer);
            if (settlementTimer) unschedule(settlementTimer);
            signal?.removeEventListener("abort", abort);
            return true;
          };

          terminateChild = (reason: "timeout" | "cancelled" | "guard") => {
            if (reason === "timeout") {
              timedOut = true;
            } else if (reason === "cancelled") {
              cancelled = true;
            }
            if (settled || terminating || settlementTimer) return;
            terminating = true;
            jobs.stopped = true;
            if (job) {
              const retryPossible = reason === "timeout" && attempt < maxAttempts &&
                getRemainingBudgetMs() > 0 && getRemainingBudgetMs() >= minRetryBudgetMs;
              if (!ownsHub || !retryPossible) closeStoppedJob = () => job.close(budget.remaining(), budget.signal);
            }

            const kill = (signal: NodeJS.Signals) => {
              if (exitSeen || settled || !child) return;
              try {
                if (typeof child.pid === "number") {
                  if (deps.killTree) deps.killTree(child.pid, signal);
                  else defaultKillTree(child.pid, signal, platform);
                }
                else child.kill(signal);
              } catch {}
            };
            // Windows taskkill must see the live root to enumerate its descendants.
            // POSIX children lead a process group, so signal the entire group.
            kill(platform === "win32" ? "SIGKILL" : "SIGTERM");
            if (settled) return;
            if (platform !== "win32" && !exitSeen) {
              escalationTimer = schedule(() => kill("SIGKILL"),
                clampGrace(deps.killGracePeriodMs ?? deps.closeGracePeriodMs ?? 500));
            }

            const pid = child?.pid;
            if (hasRealPid && typeof pid === "number") {
              // At the deadline return survivor/unknown evidence so a retry cannot race the old tree.
              if (exitTimer) {
                unschedule(exitTimer);
                exitTimer = undefined;
              }
              const killRoot = () => {
                if (settled) return;
                try {
                  if (deps.killTree) deps.killTree(pid, "SIGKILL");
                  else defaultKillTree(pid, "SIGKILL", platform);
                } finally { void closeStoppedJob?.(); }
              };
              const settleAfterKill = (stillAlive?: number[], unverified?: boolean) => {
                if (settled) return;
                try {
                  if (typeof child?.stdout?.destroy === "function") child.stdout.destroy();
                  if (typeof child?.stderr?.destroy === "function") child.stderr.destroy();
                } catch {}
                if (cleanup()) {
                  resolve({
                    code: exitCode,
                    signal: exitSignal ?? (reason === "timeout" ? "SIGTERM" : (reason === "guard" ? "SIGKILL" : null)),
                    error: spawnError,
                    ...(stillAlive ? { processesStillAlive: stillAlive } : {}),
                    ...(unverified ? { killUnverified: true } : {})
                  });
                }
              };
              const isRootAlive = () => !exitSeen && child.exitCode === null && child.signalCode === null;
              const runTableConfirm = (): Promise<TreeKillResult> => {
                const confirmCap = Math.min(
                  deps.settlementDeadlineMs !== undefined ? budget.remaining() : budget.confirmRemaining(),
                  deps.settlementDeadlineMs ?? TREE_KILL_CONFIRM_MS
                );
                const confirmSignal = deps.settlementDeadlineMs !== undefined ? budget.signal : budget.confirmSignal;
                return untilAborted((deps.confirmTreeDead ?? confirmTreeDead)(pid, {
                  capMs: confirmCap,
                  now: nowFn,
                  signal: confirmSignal,
                  killRoot,
                  isRootAlive,
                  rootStartedMs,
                  rootExitedMs: () => exitSeenAt,
                  firstPollMs: platform === "win32" ? undefined : (deps.killGracePeriodMs ?? deps.closeGracePeriodMs ?? 500),
                  platform
                }), confirmSignal).catch(() => ({ confirmed: false, alive: isRootAlive() ? [pid] : [], unverified: true }));
              };
              // Terminate the job first, then still check the process table for children spawned before assignment.
              const confirm: Promise<TreeKillResult> = (async () => {
                const jobDrained = closeStoppedJob
                  ? (await closeStoppedJob().catch(() => false)) === true || job?.confirmed === true
                  : false;
                const table = await runTableConfirm();
                if (table.confirmed) return table;
                if (table.unverified && table.alive.length === 0 && jobDrained) {
                  return { confirmed: true, alive: [] };
                }
                return table;
              })();
              confirm.then(({ confirmed, alive, unverified }) => settleAfterKill(confirmed ? undefined : alive, unverified));
              return;
            }

            settlementTimer = schedule(() => {
              if (settled) return;
              try {
                if (typeof child?.stdout?.destroy === "function") child.stdout.destroy();
                if (typeof child?.stderr?.destroy === "function") child.stderr.destroy();
              } catch {}
              if (cleanup()) {
                resolve({
                  code: exitCode,
                  signal: exitSignal ?? (reason === "timeout" ? "SIGTERM" : (reason === "guard" ? "SIGKILL" : null)),
                  error: spawnError
                });
              }
            }, clampGrace(deps.settlementDeadlineMs ?? (deps.closeGracePeriodMs ?? 500) * 3));
          };

          const timer = schedule(() => {
            terminateChild("timeout");
          }, Math.max(0, Math.min(attemptTimerMs - setupMs, getRemainingBudgetMs())));
          if (!deps.timeoutMs) {
            timer.unref();
          }

          const abort = () => {
            terminateChild("cancelled");
          };
          signal?.addEventListener("abort", abort, { once: true });

          try {
            rootStartedMs = Date.now();
            child = spawnFn(executable, spawnArgs, {
              shell: false,
              windowsHide: true,
              detached: platform !== "win32",
              stdio: ["ignore", "pipe", "pipe"],
              env,
              // Cline resolves a model's relative tool paths against its process cwd, not only `--cwd`:
              // without this, `src/x.py` resolved under the MCP server's folder (the user's home).
              ...(cwd ? { cwd } : {})
            });
          } catch (err) {
            if (cleanup()) {
              resolve({ code: null, signal: null, error: err });
            }
            return;
          }

          // Only a real child process gets the confirmed tree kill; a fake child's PID may belong to an unrelated process.
          hasRealPid = child instanceof ChildProcess && Number.isInteger(child.pid) && (child.pid as number) > 0;
          if (hasRealPid) job?.assign(child);
          options.onLaunched?.();
          if (typeof child.pid === "number") recorder?.processStarted(child.pid);

          child.stdout?.on("data", (chunk: Buffer | string) => {
            stdout += chunk.toString();
            splitter?.push(chunk);
          });
          child.stderr?.on("data", (chunk: Buffer | string) => {
            stderr += chunk.toString();
          });

          child.on("error", (err) => {
            spawnError = err;
            if (cleanup()) {
              resolve({ code: null, signal: null, error: err });
            }
          });

          child.on("exit", (code, sig) => {
            if (exitSeen) return;
            exitSeen = true;
            exitSeenAt = Date.now();
            if (job) {
              if (job.assigned) unschedule(timer);
              if (terminating) void closeStoppedJob?.();
              else if (!ownsHub) void job.close(budget.remaining(), budget.signal);
            }
            // The group remains addressable while descendants live, even after its leader exits.
            if (platform !== "win32" && typeof child.pid === "number") {
              try {
                if (deps.killTree) deps.killTree(child.pid, "SIGKILL");
                else defaultKillTree(child.pid, "SIGKILL", platform);
              } catch {}
            }
            if (escalationTimer) unschedule(escalationTimer);
            if (settled) return;
            exitCode = code;
            exitSignal = sig;
            if (terminating && hasRealPid) return;
            const settleExit = (stillAlive?: number[], unverified?: boolean) => {
              try {
                if (typeof child.stdout?.destroy === "function") {
                  child.stdout.destroy();
                }
              } catch {}
              try {
                if (typeof child.stderr?.destroy === "function") {
                  child.stderr.destroy();
                }
              } catch {}
              if (cleanup()) {
                resolve({ code: exitCode, signal: exitSignal, error: spawnError,
                  ...(stillAlive ? { processesStillAlive: stillAlive } : {}), ...(unverified ? { killUnverified: true } : {}) });
              }
            };
            exitTimer = schedule(() => {
              // The root exited but its pipes stayed open, so descendants still run. On Windows nothing else
              // stops them (POSIX signalled the group above) and the caller may restore next: reap them first.
              const pid = child.pid;
              if (hasRealPid && platform === "win32" && typeof pid === "number" && !terminating) {
                terminating = true;
                const runTableConfirm = (): Promise<TreeKillResult> => {
                  const confirmCap = Math.min(
                    deps.settlementDeadlineMs !== undefined ? budget.remaining() : budget.confirmRemaining(),
                    deps.settlementDeadlineMs ?? TREE_KILL_CONFIRM_MS
                  );
                  const confirmSignal = deps.settlementDeadlineMs !== undefined ? budget.signal : budget.confirmSignal;
                  return untilAborted((deps.confirmTreeDead ?? confirmTreeDead)(pid, {
                    capMs: confirmCap,
                    now: nowFn, signal: confirmSignal, killRoot: () => {}, isRootAlive: () => false,
                    rootStartedMs, rootExitedMs: () => exitSeenAt, platform
                  }), confirmSignal)
                    .then((result) => result, () => ({ confirmed: false, alive: [] as number[], unverified: true }));
                };
                // Pipes stayed open after root exit (sign of a live descendant, possibly outside the job):
                // close the job first, then require the process-table check; a drained job alone cannot confirm.
                const confirm: Promise<TreeKillResult> = (async () => {
                  if (job && !ownsHub) await job.close(budget.remaining(), budget.signal).catch(() => false);
                  return runTableConfirm();
                })();
                confirm.then(({ confirmed, alive, unverified }) => settleExit(confirmed ? undefined : alive, unverified));
                return;
              }
              settleExit();
            }, clampGrace(deps.closeGracePeriodMs ?? 500));
            if (!deps.closeGracePeriodMs) {
              exitTimer.unref();
            }
          });

          child.on("close", (code, sig) => {
            exitCode = code ?? exitCode;
            exitSignal = sig ?? exitSignal;
            if (terminating && hasRealPid) return;
            if (cleanup()) {
              resolve({ code: exitCode, signal: exitSignal, error: spawnError });
            }
          });
        });

        let exitInfo: { code: number | null; signal: NodeJS.Signals | null; error?: any; processesStillAlive?: number[]; killUnverified?: boolean };
        try {
          exitInfo = await execPromise;
          splitter?.flush();
        } catch (err: any) {
          splitter?.flush();
          const errCode = err?.code ? ` (${err.code})` : "";
          throw new ClineRunError("launch_failed", `Unable to launch the local Cline CLI${errCode}: ${err?.message || String(err)}`, {
            exitCode: null,
            attempts: attempt
          });
        } finally {
          if (job && !ownsHub) {
            await job.close(budget.remaining(), budget.signal);
            jobs.current = undefined;
          }
        }

        if (exitInfo.error) {
          const errCode = exitInfo.error.code ? ` (${exitInfo.error.code})` : "";
          throw new ClineRunError(
            "launch_failed",
            `Unable to launch the local Cline CLI${errCode}: ${exitInfo.error.message || String(exitInfo.error)}`,
            { exitCode: null, attempts: attempt, processesStillAlive: exitInfo.processesStillAlive, killUnverified: exitInfo.killUnverified }
          );
        }

        const elapsedSec = ((nowFn() - started) / 1000).toFixed(1);
        const code = exitInfo.code;

        const stdoutTail = getTail(redactSecrets(stdout));
        const stderrTail = getTail(redactSecrets(stderr));
        const effectiveCode = code !== null ? code : -1;
        const processesStillAlive = exitInfo.processesStillAlive && exitInfo.processesStillAlive.length > 0
          ? exitInfo.processesStillAlive
          : undefined;
        const aliveSentence = processesStillAlive
          ? ` Process tree kill was not confirmed; PIDs still alive: ${processesStillAlive.join(", ")}.`
          : (exitInfo.killUnverified ? " The process list could not be read, so the stopped run's child processes are not confirmed dead." : "");
        const killEvidence = { processesStillAlive, killUnverified: exitInfo.killUnverified };
        const canRetry = (output: { stdout: string; stderr: string; attempt: number }) => !aliveSentence &&
          (options.canRetry ? options.canRetry(output) : !guard.toolActivity && guard.snapshot().totalToolCalls === 0);

        if (guardState.verdict) {
          const verdict = guardState.verdict;
          const summary = buildGuardTripMessage(verdict, attemptGuard) + aliveSentence;
          // The final run_result carries cumulative token counts, so the guard can trip on the very
          // event that holds the finished answer. A completed answer is kept, with the trip as a warning.
          const finished = trippedOnResult ? parseUsableResult(stdout, effectiveCode) : null;
          if (finished && !(options.editHub && aliveSentence)) {
            return {
              ...finished,
              warnings: [...(finished.warnings ?? []), `guard: ${summary}`],
              guard: verdict,
              durationMs: finished.durationMs ?? Math.round(nowFn() - started)
            } as ClineResponse;
          }
          throw new ClineRunError(verdict.kind, summary, {
            exitCode: code,
            stderrTail,
            stdoutTail,
            attempts: attempt,
            guard: verdict,
            processesStillAlive, killUnverified: exitInfo.killUnverified
          });
        }

        if (cancelled || signal?.aborted) {
          const cancelSummary = `The Cline request was cancelled.${aliveSentence}`;
          const cancelMsg = buildErrorTextWithTails(cancelSummary, stderrTail, stdoutTail);
          throw new ClineRunError("cancelled", cancelMsg, {
            exitCode: code,
            stderrTail,
            stdoutTail,
            attempts: attempt,
            processesStillAlive, killUnverified: exitInfo.killUnverified
          });
        }

        // 1. Usable completed result check FIRST
        const usableResult = parseUsableResult(stdout, effectiveCode);
        if (usableResult) {
          if (options.editHub && aliveSentence) {
            throw new ClineRunError("edits_inspection_failed", aliveSentence.trim(), { exitCode: code, attempts: attempt, ...killEvidence });
          }
          // A finished run whose leftover processes could not be confirmed dead keeps its answer, with a warning.
          const aliveWarnings = aliveSentence ? [aliveSentence.trim()] : [];
          if (code !== 0) {
            const rawExtracted = extractLastJsonlError(stdout, stderr);
            const extractedError = rawExtracted ? redactSecrets(rawExtracted) : undefined;
            const exitDetail = code !== null
              ? `with code ${code}`
              : exitInfo.signal
              ? `with signal ${exitInfo.signal}`
              : "without exit code";
            const warning = `cline exited ${exitDetail} after a completed result${extractedError ? `: ${extractedError}` : ""}`;
            const warnings = [...(usableResult.warnings ?? []), warning, ...aliveWarnings];
            return {
              ...usableResult,
              warnings,
              durationMs: usableResult.durationMs ?? Math.round(nowFn() - started)
            };
          }
          return {
            ...usableResult,
            ...(aliveWarnings.length ? { warnings: [...(usableResult.warnings ?? []), ...aliveWarnings] } : {}),
            durationMs: usableResult.durationMs ?? Math.round(nowFn() - started)
          };
        }

        // A provider may print a quota error and then hang; never retry that scope.
        const rawExtracted = extractLastJsonlError(stdout, stderr);
        // stdout's last terminal error decides the run (an older quota line never does); without one, every
        // diagnostic counts, stderr included, as before S18.
        const terminalError = lastTerminalErrorMessage(stdout);
        const earlyQuotaText = terminalError ?? [rawExtracted, stderr].filter(Boolean).join("\n");
        if (isDailyQuotaText(earlyQuotaText)) {
          const quota = classifyErrorText(earlyQuotaText, wallNow());
          throw new ClineRunError("quota_exhausted", `Cline daily free quota exhausted. Not retried.${aliveSentence}`, {
            exitCode: code, stderrTail, stdoutTail, attempts: attempt,
            extractedMessage: redactSecrets(earlyQuotaText) + (quota.assumedReset ? " (reset time not given; assumed next UTC midnight)" : ""),
            providerState: "quota_exhausted",
            resetAt: quota.resetAtMs !== undefined ? new Date(quota.resetAtMs).toISOString() : undefined,
            retryAfterSeconds: quota.retryAfterSeconds,
            processesStillAlive, killUnverified: exitInfo.killUnverified
          });
        }

        // 2. Timeout check with budget split
        if (timedOut) {
          const timeoutMsg = buildErrorTextWithTails(
            `Cline timeout: attempt ${attempt}/${maxAttempts} killed at ${elapsedSec}s of ${formatSeconds(attemptTimerMs)} budget ` +
              `(total ${timeoutSeconds}s).${aliveSentence}`,
            stderrTail,
            stdoutTail
          );
          const remainingBudgetMs = getRemainingBudgetMs();
          let allowRetry = remainingBudgetMs > 0 && remainingBudgetMs >= minRetryBudgetMs;
          if (allowRetry && attempt < maxAttempts) {
            allowRetry = await canRetry({ stdout, stderr, attempt });
            // A cancel during the retry check is a cancel, not the provider error that triggered it.
            if (signal?.aborted) throw new ClineRunError("cancelled", `The Cline request was cancelled.${aliveSentence}`, { attempts: attempt, processesStillAlive, killUnverified: exitInfo.killUnverified });
            allowRetry = allowRetry && getRemainingBudgetMs() > 0 && getRemainingBudgetMs() >= minRetryBudgetMs;
          }
          if (allowRetry && attempt < maxAttempts) {
            if (signal?.aborted) {
              throw new ClineRunError("cancelled", `The Cline request was cancelled.${aliveSentence}`, { attempts: attempt, processesStillAlive, killUnverified: exitInfo.killUnverified });
            }
            const sleepMs = Math.min(backoffMs, Math.max(0, getRemainingBudgetMs() - minRetryBudgetMs));
            if (sleepMs > 0) await sleep(sleepMs);
            if (signal?.aborted) {
              throw new ClineRunError("cancelled", `The Cline request was cancelled.${aliveSentence}`, { attempts: attempt, processesStillAlive, killUnverified: exitInfo.killUnverified });
            }
            continue;
          }
          throw new ClineRunError("timeout", timeoutMsg, {
            exitCode: typeof code === "number" ? code : null,
            stderrTail,
            stdoutTail,
            attempts: attempt,
            processesStillAlive, killUnverified: exitInfo.killUnverified
          });
        }

        // 3. Check for MODULE_NOT_FOUND in stderr (auto-update), routed through canRetry
        if (
          // The CLI itself crashed: only its stderr can say so, never the model's own error text (plan S18 review).
          stderr.includes("MODULE_NOT_FOUND") ||
          stderr.includes("Cannot find module")
        ) {
          let allowRetry = getRemainingBudgetMs() > 0 && getRemainingBudgetMs() >= minRetryBudgetMs;
          if (allowRetry && attempt < maxAttempts) {
            allowRetry = await canRetry({ stdout, stderr, attempt });
            // A cancel during the retry check is a cancel, not the provider error that triggered it.
            if (signal?.aborted) throw new ClineRunError("cancelled", "The Cline request was cancelled.", { attempts: attempt });
            allowRetry = allowRetry && getRemainingBudgetMs() > 0 && getRemainingBudgetMs() >= minRetryBudgetMs;
          }
          if (allowRetry && attempt < maxAttempts) {
            if (signal?.aborted) {
              throw new ClineRunError("cancelled", "The Cline request was cancelled.", { attempts: attempt });
            }
            const sleepMs = Math.min(updateBackoffMs, Math.max(0, getRemainingBudgetMs() - minRetryBudgetMs));
            if (sleepMs > 0) await sleep(sleepMs);
            if (signal?.aborted) {
              throw new ClineRunError("cancelled", "The Cline request was cancelled.", { attempts: attempt });
            }
            continue;
          }
          throw new ClineRunError(
            "cline_updating",
            "Cline CLI is missing or being updated; retry in ~30 s",
            {
              exitCode: code,
              stderrTail,
              stdoutTail,
              attempts: attempt, ...killEvidence
            }
          );
        }

        // 4. Extract errors and classify transient/non-transient BEFORE code === 0 check
        const extractedError = rawExtracted ? redactSecrets(rawExtracted) : undefined;
        const plainDiagnostics = terminalError === undefined ? plainStderrDiagnostics(stderr) : [];
        const rawPlainStderrError = plainDiagnostics.at(-1);
        const plainStderrError = rawPlainStderrError ? redactSecrets(rawPlainStderrError) : undefined;
        const diagnostic = [...plainDiagnostics, extractedError].filter(Boolean).join("\n");

        const transient = isTransientError({
          code,
          // Older stderr diagnostics count unless stdout's last terminal error decides the run.
          stderr: terminalError === undefined ? stderr : undefined,
          extractedError,
          timedOut: false
        });

        if (transient) {
          const remainingBudgetMs = getRemainingBudgetMs();
          let allowRetry = remainingBudgetMs > 0 && remainingBudgetMs >= minRetryBudgetMs;
          if (allowRetry && attempt < maxAttempts) {
            allowRetry = await canRetry({ stdout, stderr, attempt });
            // A cancel during the retry check is a cancel, not the provider error that triggered it.
            if (signal?.aborted) throw new ClineRunError("cancelled", "The Cline request was cancelled.", { attempts: attempt });
            allowRetry = allowRetry && getRemainingBudgetMs() > 0 && getRemainingBudgetMs() >= minRetryBudgetMs;
          }
          if (allowRetry && attempt < maxAttempts) {
            if (signal?.aborted) {
              throw new ClineRunError("cancelled", "The Cline request was cancelled.", { attempts: attempt });
            }
            const sleepMs = Math.min(backoffMs, Math.max(0, getRemainingBudgetMs() - minRetryBudgetMs));
            if (sleepMs > 0) await sleep(sleepMs);
            if (signal?.aborted) {
              throw new ClineRunError("cancelled", "The Cline request was cancelled.", { attempts: attempt });
            }
            continue;
          }
          const exitMsg = code !== null ? ` (exit code ${code})` : exitInfo.signal ? ` (signal ${exitInfo.signal})` : "";
          const effectiveDetail = extractedError || plainStderrError || "Service temporarily unavailable";
          const summary = `Cline failed with transient provider error${exitMsg}: ${effectiveDetail}.`;
          throw new ClineRunError("transient_provider_error", summary, {
            exitCode: code,
            stderrTail,
            stdoutTail,
            attempts: attempt,
            extractedMessage: diagnostic || effectiveDetail, diagnostics: [...plainDiagnostics, ...(extractedError ? [extractedError] : [])], ...killEvidence
          });
        }

        // 5. If not transient, but run_result or stderr had an error message (even with code === 0):
        if (extractedError || (plainStderrError && /error/i.test(plainStderrError))) {
          const errorDetail = extractedError || plainStderrError;
          const exitMsg = code !== null && code !== 0 ? ` (exit code ${code})` : exitInfo.signal ? ` (signal ${exitInfo.signal})` : "";
          const summary = `Cline failed${exitMsg}: ${errorDetail}.`;
          // Keep tails in their diagnostic fields: provider status classifies the error message.
          throw new ClineRunError("non_zero_exit", summary, {
            exitCode: code,
            stderrTail,
            stdoutTail,
            attempts: attempt,
            extractedMessage: diagnostic, diagnostics: [...plainDiagnostics, ...(extractedError ? [extractedError] : [])], ...killEvidence
          });
        }

        // 6. Clean exit 0 without error message: parse to detect malformed JSON or missing final result
        if (code === 0) {
          try {
            parseClineJsonl(stdout);
          } catch (error) {
            if (error instanceof JsonlParseError) {
              const kind = error.message.includes("malformed") ? "malformed_json" : "missing_final_result";
              throw new ClineRunError(kind, error.message, { exitCode: 0, stderrTail, stdoutTail, attempts: attempt, ...killEvidence });
            }
            throw new ClineRunError("missing_final_result", "Cline did not return a usable final result.", {
              exitCode: 0,
              stderrTail,
              stdoutTail,
              attempts: attempt, ...killEvidence
            });
          }
        }

        // 7. Non-zero exit or killed by signal
        const exitMsg = code !== null
          ? `exited with code ${code}`
          : exitInfo.signal
          ? `killed by signal ${exitInfo.signal}`
          : "exited unexpectedly";
        const summary = `Cline ${exitMsg}.`;
        const msg = buildErrorTextWithTails(summary, stderrTail, stdoutTail);
        throw new ClineRunError("non_zero_exit", msg, {
          exitCode: code,
          stderrTail,
          stdoutTail,
          attempts: attempt,
          extractedMessage: diagnostic, diagnostics: [...plainDiagnostics, ...(extractedError ? [extractedError] : [])], ...killEvidence
        });
      }

      throw new ClineRunError("launch_failed", "Cline execution failed unexpectedly.", { attempts: attempt });
  }
}

/**
 * ask_cline runs Cline with auto-approval off. Headless, that refuses EVERY tool call (even reads), and the
 * Cline 3.0.74 CLI has no read-only approval option (D-21). Without this notice Cline spends iterations
 * trying tools, gets refused, and answers that it needs approval.
 */
export const NO_TOOLS_PREAMBLE =
  "[Bridge note: this request runs WITHOUT tools. Every tool call (reading files, listing directories, " +
  "running commands, searching) will be refused, so do not call any tool. Answer only from the text of this " +
  "message. If you cannot answer without reading files, say so in one sentence.]\n\n";

export async function askCline(
  input: AskClineInput,
  signal?: AbortSignal,
  options?: ClineInvocationOptions
): Promise<ClineResponse> {
  const promptPreamble = (options?.promptPreamble ?? "") + NO_TOOLS_PREAMBLE;
  return runCline(input, signal, { ...options, promptPreamble });
}
