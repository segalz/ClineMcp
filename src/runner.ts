import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { LineSplitter, TraceRecorder, type TraceInfo } from "./trace.js";
import { createGuard, buildGuardTripMessage, type GuardOptions, type GuardReport, type GuardVerdict } from "./guard.js";
import {
  JsonlParseError,
  parseClineJsonl,
  parseUsableResult,
  extractLastJsonlError,
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
  providerState?: ProviderState;
  resetAt?: string;
  retryAfterSeconds?: number;
  guard?: GuardReport;
}

export class ClineRunError extends Error {
  public readonly exitCode?: number | null;
  public readonly stderrTail?: string;
  public readonly stdoutTail?: string;
  public readonly attempts?: number;
  public readonly extractedMessage?: string;
  public readonly providerState?: ProviderState;
  public readonly resetAt?: string;
  public readonly retryAfterSeconds?: number;
  public readonly guard?: GuardReport;
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
      this.providerState = details.providerState;
      this.resetAt = details.resetAt;
      this.retryAfterSeconds = details.retryAfterSeconds;
      this.guard = details.guard;
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
}

export interface ClineInvocationOptions {
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

export interface ClineResponse extends ClineFinalResult {
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

  // 1. JSON-style double-quoted keys:
  result = result.replace(
    /"(apiKey|api_key|x-api-key|api-key|accessToken|refreshToken|token|secret|password|key|authorization|proxy-authorization|cookie|set-cookie)"(\s*:\s*)"[^"]*"/gi,
    '"$1"$2"<redacted>"'
  );

  // 2. JSON-style single-quoted keys:
  result = result.replace(
    /'(apiKey|api_key|x-api-key|api-key|accessToken|refreshToken|token|secret|password|key|authorization|proxy-authorization|cookie|set-cookie)'(\s*:\s*)'[^']*'/gi,
    "'$1'$2'<redacted>'"
  );

  // 3. Environment variable assignments (e.g. KEY=val, NVIDIA_KEY=val, MY_TOKEN=val):
  result = result.replace(
    /\b([A-Za-z0-9_]*(?:API_KEY|TOKEN|SECRET|PASSWORD|_KEY|KEY)[A-Za-z0-9_]*\s*=\s*)(?:"[^"]*"|'[^']*'|\S+)/gi,
    "$1<redacted>"
  );

  // 4. Header-style Authorization and Proxy-Authorization:
  // Authorization: Basic ..., Authorization: Bearer ..., Authorization: <scheme> <value>, or Authorization: <value>
  result = result.replace(
    /\b((?:Proxy-)?Authorization\s*:\s*)(?:([A-Za-z0-9_-]+)\s+)?(?:"[^"]*"|'[^']*'|[^\s"',;]+)/gi,
    (match, prefix, scheme) => {
      return scheme ? `${prefix}${scheme} <redacted>` : `${prefix}<redacted>`;
    }
  );

  // 5. Cookie and Set-Cookie headers:
  result = result.replace(/\b((?:Set-)?Cookie\s*:\s*)[^\r\n]+/gi, "$1<redacted>");

  // 6. Headers / key-value forms for x-api-key, api-key:
  result = result.replace(
    /\b(x-api-key|api-key)\s*[:=]\s*(?:"[^"]*"|'[^']*'|\S+)/gi,
    "$1: <redacted>"
  );

  // 7. Key-value forms for token, key, secret, password (e.g. token: ..., secret = ..., password: ...):
  // Redacts whole value up to whitespace/quote/comma/semicolon (covers JWT a.b.c)
  result = result.replace(
    /\b(token|key|secret|password)\s*([:=]|\bis\b)\s*(?:(Bearer|Basic)\s+(?:<redacted>|[^\s"',;]+)|<redacted>|(?:"[^"]*"|'[^']*')|[^\s"',;]+)/gi,
    (match, keyName, sep, scheme) => {
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

export function extractPlainStderrError(stderr: string): string | undefined {
  const lines = stderr.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (
      /error/i.test(line) ||
      /(?:status|code|http)\D{0,5}(?:429|5\d\d)\b/i.test(line) ||
      /\b(overloaded|rate\s*limit|too\s*many\s*requests|temporarily\s*unavailable|temporarily\s*overloaded|econnreset|etimedout)\b/i.test(line) ||
      /\b(upstream\s*error|provider\s*error)\b/i.test(line)
    ) {
      return line;
    }
  }
  return undefined;
}

function extractRunResultErrorText(stdout: string): string | undefined {
  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    try {
      const parsed = JSON.parse(line);
      if (parsed && typeof parsed === "object") {
        if (["run_result", "run-finished", "run_completed"].includes(String(parsed.type))) {
          if (String(parsed.finishReason ?? "") === "error") {
            const text = parsed.text ?? parsed.outputText ?? parsed.finalText;
            if (typeof text === "string") return text;
          }
        }
      }
    } catch {}
  }
  return undefined;
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
export function resolveClineEntry(entryPath?: string): string | undefined {
  if (entryPath !== undefined) return entryPath;
  return process.platform === "win32" && process.env.APPDATA
    ? path.join(process.env.APPDATA, "npm", "node_modules", "cline", "bin", "cline")
    : undefined;
}

export const MISSING_SELECTION_MESSAGE =
  "provider and model are required. The bridge never runs on Cline's saved default model, which can go stale silently. " +
  "Pass provider \"cline\" and a model id; call cline_list_models for the free models the installed Cline offers now.";

/** Fails before any I/O when the caller did not choose both provider and model. */
export function requireSelection(input: { provider?: string; model?: string }): void {
  if (!input.provider || !input.model) throw new ClineRunError("launch_failed", MISSING_SELECTION_MESSAGE, { attempts: 0 });
}

export async function runCline(
  input: AskClineInput,
  signal?: AbortSignal,
  options: ClineInvocationOptions = {}
): Promise<ClineResponse> {
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
  const overallStarted = nowFn();
  const totalBudgetMs = deps.totalBudgetMs ?? (timeoutSeconds * 1000);
  const overallDeadline = overallStarted + totalBudgetMs;
  const getRemainingBudgetMs = () => Math.max(0, overallDeadline - nowFn());
  const sleep = deps.sleep ?? (ms => new Promise<void>(resolve => setTimeout(resolve, ms)));
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
      if (statusPath && options.respectQuotaLock !== false) {
        const lock = activeQuotaLock(
          await readStatusEntry(statusPath, effectiveInput.provider, effectiveInput.model).catch(() => undefined),
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

      const executable = (process.platform === "win32" || deps.entryPath) ? process.execPath : "cline";
      const backoffMs = deps.backoffMs ?? 2500;
      const updateBackoffMs = deps.updateBackoffMs ?? 2000;
      const maxAttempts = Math.max(1, options.maxAttempts ?? 2);
      let attempt = 0;

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

        const remainingBeforeAttempt = getRemainingBudgetMs();
        if (remainingBeforeAttempt <= 0) {
          throw new ClineRunError("timeout", `Cline exceeded the ${timeoutSeconds}-second timeout.`, { attempts: attempt - 1 });
        }

        // Budget calculation for this attempt
        let attemptBudgetMs = totalBudgetMs;
        if (attempt === 1) {
          if (maxAttempts > 1 && Math.floor(totalBudgetMs * 0.40) >= minRetryBudgetMs) {
            attemptBudgetMs = Math.floor(totalBudgetMs * 0.60);
          }
        } else {
          attemptBudgetMs = remainingBeforeAttempt;
        }

        const effectiveAttemptBudgetMs = Math.min(attemptBudgetMs, remainingBeforeAttempt);
        const attemptTimeoutSeconds = Math.max(1, Math.floor(effectiveAttemptBudgetMs / 1000));
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

        const spawnArgs = (process.platform === "win32" || deps.entryPath) && windowsEntry
          ? [windowsEntry, ...args]
          : args;
        if (platform === "win32") {
          const length = windowsCommandLineLength(executable, spawnArgs);
          if (length > WINDOWS_COMMAND_LINE_LIMIT) {
            throw new ClineRunError("launch_failed",
              `The request is too long for the Windows command line after escaping (${length} of ${WINDOWS_COMMAND_LINE_LIMIT} characters; ` +
              "quotes and backslashes count extra). Shorten the prompt or system prompt.", { attempts: attempt - 1 });
          }
        }

        if (getRemainingBudgetMs() <= 0) throw new ClineRunError("timeout", "Cline exceeded the global deadline.", { attempts: attempt - 1 });
        const started = nowFn();
        let stdout = "";
        let stderr = "";
        // Per-attempt line splitting for the live trace; fragments never join across attempts.
        const thisAttempt = attempt;
        recorder?.attemptStarted(thisAttempt);
        const guard = createGuard(options.guard ?? effectiveInput.guard);
        const guardState: { verdict: GuardVerdict | null } = { verdict: null };
        let terminateChild!: (reason: "timeout" | "cancelled" | "guard") => void;
        const splitter = new LineSplitter(
          line => {
            recorder?.line(line, thisAttempt);
            if (guardState.verdict) return;
            try {
              const parsed = JSON.parse(line.trim());
              if (parsed && typeof parsed === "object") {
                const verdict = guard.observe(parsed);
                if (verdict) {
                  guardState.verdict = verdict;
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
          () => recorder?.oversizedLine(thisAttempt)
        );
        let timedOut = false;
        let cancelled = false;

        const spawnFn = deps.spawn ?? spawn;
        const env = {
          ...process.env,
          CLINE_NO_AUTO_UPDATE: "1"
        };

        // A cancel that arrived during the awaits above (entry access, budget checks) must stop the launch.
        if (signal?.aborted) {
          throw new ClineRunError("cancelled", "The Cline request was cancelled.", { attempts: attempt - 1 });
        }
        const execPromise = new Promise<{ code: number | null; signal: NodeJS.Signals | null; error?: any }>((resolve) => {
          let settled = false;
          let child: ReturnType<typeof spawn>;
          let exitTimer: NodeJS.Timeout | undefined;
          let escalationTimer: NodeJS.Timeout | undefined;
          let settlementTimer: NodeJS.Timeout | undefined;
          let exitSeen = false;
          let exitCode: number | null = null;
          let exitSignal: NodeJS.Signals | null = null;
          let spawnError: any;

          const clampGrace = (ms: number) => Math.max(0, Math.min(ms, getRemainingBudgetMs()));
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
            if (settled || settlementTimer) return;

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
          }, Math.min(attemptTimerMs, getRemainingBudgetMs()));
          if (!deps.timeoutMs) {
            timer.unref();
          }

          const abort = () => {
            terminateChild("cancelled");
          };
          signal?.addEventListener("abort", abort, { once: true });

          try {
            child = spawnFn(executable, spawnArgs, {
              shell: false,
              windowsHide: true,
              detached: platform !== "win32",
              stdio: ["ignore", "pipe", "pipe"],
              env
            });
          } catch (err) {
            if (cleanup()) {
              resolve({ code: null, signal: null, error: err });
            }
            return;
          }

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
            exitTimer = schedule(() => {
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
                resolve({ code: exitCode, signal: exitSignal, error: spawnError });
              }
            }, clampGrace(deps.closeGracePeriodMs ?? 500));
            if (!deps.closeGracePeriodMs) {
              exitTimer.unref();
            }
          });

          child.on("close", (code, sig) => {
            if (cleanup()) {
              resolve({ code: code ?? exitCode, signal: sig ?? exitSignal, error: spawnError });
            }
          });
        });

        let exitInfo: { code: number | null; signal: NodeJS.Signals | null; error?: any };
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
        }

        if (exitInfo.error) {
          const errCode = exitInfo.error.code ? ` (${exitInfo.error.code})` : "";
          throw new ClineRunError(
            "launch_failed",
            `Unable to launch the local Cline CLI${errCode}: ${exitInfo.error.message || String(exitInfo.error)}`,
            { exitCode: null, attempts: attempt }
          );
        }

        const elapsedSec = ((nowFn() - started) / 1000).toFixed(1);
        const code = exitInfo.code;

        const stdoutTail = getTail(redactSecrets(stdout));
        const stderrTail = getTail(redactSecrets(stderr));
        const effectiveCode = code !== null ? code : -1;

        if (guardState.verdict) {
          const verdict = guardState.verdict;
          const summary = buildGuardTripMessage(verdict, options.guard);
          throw new ClineRunError(verdict.kind, summary, {
            exitCode: code,
            stderrTail,
            stdoutTail,
            attempts: attempt,
            guard: verdict
          });
        }

        if (cancelled || signal?.aborted) {
          const cancelSummary = "The Cline request was cancelled.";
          const cancelMsg = buildErrorTextWithTails(cancelSummary, stderrTail, stdoutTail);
          throw new ClineRunError("cancelled", cancelMsg, {
            exitCode: code,
            stderrTail,
            stdoutTail,
            attempts: attempt
          });
        }

        // 1. Usable completed result check FIRST
        const usableResult = parseUsableResult(stdout, effectiveCode);
        if (usableResult) {
          if (code !== 0) {
            const rawExtracted = extractLastJsonlError(stdout, stderr);
            const extractedError = rawExtracted ? redactSecrets(rawExtracted) : undefined;
            const exitDetail = code !== null
              ? `with code ${code}`
              : exitInfo.signal
              ? `with signal ${exitInfo.signal}`
              : "without exit code";
            const warning = `cline exited ${exitDetail} after a completed result${extractedError ? `: ${extractedError}` : ""}`;
            const warnings = [...(usableResult.warnings ?? []), warning];
            return {
              ...usableResult,
              warnings,
              durationMs: usableResult.durationMs ?? Math.round(nowFn() - started)
            };
          }
          return {
            ...usableResult,
            durationMs: usableResult.durationMs ?? Math.round(nowFn() - started)
          };
        }

        // A provider may print a quota error and then hang; never retry that scope.
        const earlyQuotaText = [extractLastJsonlError(stdout, stderr), extractRunResultErrorText(stdout), stderr].filter(Boolean).join("\n");
        if (isDailyQuotaText(earlyQuotaText)) {
          const quota = classifyErrorText(earlyQuotaText, wallNow());
          throw new ClineRunError("quota_exhausted", "Cline daily free quota exhausted. Not retried.", {
            exitCode: code, stderrTail, stdoutTail, attempts: attempt,
            extractedMessage: redactSecrets(earlyQuotaText) + (quota.assumedReset ? " (reset time not given; assumed next UTC midnight)" : ""),
            providerState: "quota_exhausted",
            resetAt: quota.resetAtMs !== undefined ? new Date(quota.resetAtMs).toISOString() : undefined,
            retryAfterSeconds: quota.retryAfterSeconds
          });
        }

        // 2. Timeout check with budget split
        if (timedOut) {
          const timeoutMsg = buildErrorTextWithTails(
            `Cline timeout: attempt ${attempt}/${maxAttempts} killed at ${elapsedSec}s of ${formatSeconds(attemptTimerMs)} budget ` +
              `(total ${timeoutSeconds}s).`,
            stderrTail,
            stdoutTail
          );
          const remainingBudgetMs = getRemainingBudgetMs();
          let allowRetry = remainingBudgetMs > 0 && remainingBudgetMs >= minRetryBudgetMs;
          if (allowRetry && attempt < maxAttempts && options.canRetry) {
            allowRetry = await options.canRetry({ stdout, stderr, attempt });
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
          throw new ClineRunError("timeout", timeoutMsg, {
            exitCode: typeof code === "number" ? code : null,
            stderrTail,
            stdoutTail,
            attempts: attempt
          });
        }

        // 3. Check for MODULE_NOT_FOUND in stderr (auto-update), routed through canRetry
        if (
          stderr.includes("MODULE_NOT_FOUND") ||
          stderr.includes("Cannot find module")
        ) {
          let allowRetry = getRemainingBudgetMs() > 0 && getRemainingBudgetMs() >= minRetryBudgetMs;
          if (allowRetry && attempt < maxAttempts && options.canRetry) {
            allowRetry = await options.canRetry({ stdout, stderr, attempt });
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
              attempts: attempt
            }
          );
        }

        // 4. Extract errors and classify transient/non-transient BEFORE code === 0 check
        const rawExtracted = extractLastJsonlError(stdout, stderr);
        const extractedError = rawExtracted ? redactSecrets(rawExtracted) : undefined;
        const rawRunResultError = extractRunResultErrorText(stdout);
        const runResultErrorText = rawRunResultError ? redactSecrets(rawRunResultError) : undefined;
        const rawPlainStderrError = extractPlainStderrError(stderr);
        const plainStderrError = rawPlainStderrError ? redactSecrets(rawPlainStderrError) : undefined;

        const transient = isTransientError({
          code,
          stderr,
          runResultErrorText,
          extractedError,
          timedOut: false
        });

        if (transient) {
          const remainingBudgetMs = getRemainingBudgetMs();
          let allowRetry = remainingBudgetMs > 0 && remainingBudgetMs >= minRetryBudgetMs;
          if (allowRetry && attempt < maxAttempts && options.canRetry) {
            allowRetry = await options.canRetry({ stdout, stderr, attempt });
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
          const effectiveDetail = extractedError || runResultErrorText || plainStderrError || "Service temporarily unavailable";
          const summary = `Cline failed with transient provider error${exitMsg}: ${effectiveDetail}.`;
          const msg = buildErrorTextWithTails(summary, stderrTail, stdoutTail);
          throw new ClineRunError("transient_provider_error", msg, {
            exitCode: code,
            stderrTail,
            stdoutTail,
            attempts: attempt,
            extractedMessage: effectiveDetail
          });
        }

        // 5. If not transient, but run_result or stderr had an error message (even with code === 0):
        if (runResultErrorText || extractedError || (plainStderrError && /error/i.test(plainStderrError))) {
          const errorDetail = extractedError || runResultErrorText || plainStderrError;
          const exitMsg = code !== null && code !== 0 ? ` (exit code ${code})` : exitInfo.signal ? ` (signal ${exitInfo.signal})` : "";
          const summary = `Cline failed${exitMsg}: ${errorDetail}.`;
          const msg = buildErrorTextWithTails(summary, stderrTail, stdoutTail);
          throw new ClineRunError("non_zero_exit", msg, {
            exitCode: code,
            stderrTail,
            stdoutTail,
            attempts: attempt,
            extractedMessage: errorDetail
          });
        }

        // 6. Clean exit 0 without error message: parse to detect malformed JSON or missing final result
        if (code === 0) {
          try {
            parseClineJsonl(stdout);
          } catch (error) {
            if (error instanceof JsonlParseError) {
              const kind = error.message.includes("malformed") ? "malformed_json" : "missing_final_result";
              throw new ClineRunError(kind, error.message, { exitCode: 0, stderrTail, stdoutTail, attempts: attempt });
            }
            throw new ClineRunError("missing_final_result", "Cline did not return a usable final result.", {
              exitCode: 0,
              stderrTail,
              stdoutTail,
              attempts: attempt
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
          extractedMessage: extractedError
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
