import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import path from "node:path";
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

export type ThinkingLevel = "none" | "low" | "medium" | "high" | "xhigh";

export interface AskClineInput {
  prompt: string;
  cwd?: string;
  thinking?: ThinkingLevel;
  timeoutSeconds?: number;
  systemPrompt?: string;
  provider?: string;
  model?: string;
}

export type ClineErrorKind =
  | "settings_lock_timeout"
  | "settings_restore_failed"
  | "timeout"
  | "cancelled"
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
  | "edits_inspection_failed";

export interface ClineRunErrorDetails {
  exitCode?: number | null;
  stderrTail?: string;
  stdoutTail?: string;
  attempts?: number;
  extractedMessage?: string;
}

export class ClineRunError extends Error {
  public readonly exitCode?: number | null;
  public readonly stderrTail?: string;
  public readonly stdoutTail?: string;
  public readonly attempts?: number;
  public readonly extractedMessage?: string;

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
}

export interface ClineInvocationOptions {
  autoApprove?: boolean;
  cwd?: string;
  systemPrompt?: string;
  provider?: string;
  model?: string;
  deps?: ClineDependencies;
  canRetry?: (attemptOutput: { stdout: string; stderr: string; attempt: number }) => Promise<boolean> | boolean;
}

export interface ClineResponse extends ClineFinalResult {
  durationMs: number;
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
    if (error.stderrTail && !error.message.includes(error.stderrTail)) {
      lines.push(`Stderr tail:\n${error.stderrTail}`);
    }
    if (error.stdoutTail && !error.message.includes(error.stdoutTail)) {
      lines.push(`Stdout tail:\n${error.stdoutTail}`);
    }
    if ("evidence" in error && (error as any).evidence) {
      lines.push(`Evidence:\n${JSON.stringify((error as any).evidence, null, 2)}`);
    }
    return lines.join("\n\n");
  }
  return error instanceof Error ? error.message : fallbackMessage;
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
    model: options.model ?? input.model
  };
  const timeoutSeconds = effectiveInput.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS;
  if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > MAX_TIMEOUT_SECONDS) {
    throw new ClineRunError("launch_failed", `timeoutSeconds must be an integer from 1 to ${MAX_TIMEOUT_SECONDS}.`);
  }
  validateInputLimits(effectiveInput);

  const deps = options.deps ?? {};
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

  return withProviderOverride(
    { provider: effectiveInput.provider, model: effectiveInput.model },
    settingsPath,
    signal,
    async (selection) => {
      effectiveInput.provider = selection.provider;
      effectiveInput.model = selection.model;
      const cwd = await validateCwd(effectiveInput.cwd, deps.access);
      const windowsEntry = deps.entryPath ?? (process.platform === "win32" && process.env.APPDATA
        ? path.join(process.env.APPDATA, "npm", "node_modules", "cline", "bin", "cline")
        : undefined);

      if (process.platform === "win32" && !windowsEntry && !deps.entryPath) {
        throw new ClineRunError("launch_failed", "Unable to locate the local Cline CLI.");
      }

      const executable = (process.platform === "win32" || deps.entryPath) ? process.execPath : "cline";
      const backoffMs = deps.backoffMs ?? 2500;
      const updateBackoffMs = deps.updateBackoffMs ?? 2000;
      const maxAttempts = 2;
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
        args.push(effectiveInput.prompt);

        const spawnArgs = (process.platform === "win32" || deps.entryPath) && windowsEntry
          ? [windowsEntry, ...args]
          : args;

        if (getRemainingBudgetMs() <= 0) throw new ClineRunError("timeout", "Cline exceeded the global deadline.", { attempts: attempt - 1 });
        const started = nowFn();
        let stdout = "";
        let stderr = "";
        let timedOut = false;
        let cancelled = false;

        const spawnFn = deps.spawn ?? spawn;
        const env = {
          ...process.env,
          CLINE_NO_AUTO_UPDATE: "1"
        };

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

          const terminateChild = (isTimeout: boolean) => {
            if (isTimeout) {
              timedOut = true;
            } else {
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
                  signal: exitSignal ?? (isTimeout ? "SIGTERM" : null),
                  error: spawnError
                });
              }
            }, clampGrace(deps.settlementDeadlineMs ?? (deps.closeGracePeriodMs ?? 500) * 3));
          };

          const timer = schedule(() => {
            terminateChild(true);
          }, Math.min(attemptTimerMs, getRemainingBudgetMs()));
          if (!deps.timeoutMs) {
            timer.unref();
          }

          const abort = () => {
            terminateChild(false);
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

          child.stdout?.on("data", (chunk: Buffer | string) => {
            stdout += chunk.toString();
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
        } catch (err: any) {
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

        // 2. Timeout check with budget split
        if (timedOut) {
          const timeoutMsg = buildErrorTextWithTails(
            `Cline exceeded the ${timeoutSeconds}-second timeout (elapsed: ${elapsedSec}s).`,
            stderrTail,
            stdoutTail
          );
          const remainingBudgetMs = getRemainingBudgetMs();
          let allowRetry = remainingBudgetMs > 0 && remainingBudgetMs >= minRetryBudgetMs;
          if (allowRetry && options.canRetry) {
            allowRetry = await options.canRetry({ stdout, stderr, attempt });
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
          if (allowRetry && options.canRetry) {
            allowRetry = await options.canRetry({ stdout, stderr, attempt });
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
          if (allowRetry && options.canRetry) {
            allowRetry = await options.canRetry({ stdout, stderr, attempt });
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
    },
    {
      deadline: overallDeadline,
      lockTimeoutMs: deps.lockTimeoutMs,
      acquireSettingsMutex: deps.acquireSettingsMutex,
      sleep: deps.sleep,
      nowFn
    }
  );
}

export async function askCline(
  input: AskClineInput,
  signal?: AbortSignal,
  options?: ClineInvocationOptions
): Promise<ClineResponse> {
  return runCline(input, signal, options);
}
