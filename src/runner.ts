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
  withProviderOverride
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

export interface ClineDependencies {
  spawn?: typeof spawn;
  access?: typeof access;
  entryPath?: string;
  providerSettingsPath?: string;
  backoffMs?: number;
  updateBackoffMs?: number;
  timeoutMs?: number;
  closeGracePeriodMs?: number;
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
  return text
    .replace(
      /"(apiKey|api_key|accessToken|refreshToken|token|secret|password|key|authorization)"(\s*:\s*)"[^"]*"/gi,
      '"$1"$2"<redacted>"'
    )
    .replace(
      /'(apiKey|api_key|accessToken|refreshToken|token|secret|password|key|authorization)'(\s*:\s*)'[^']*'/gi,
      "'$1'$2'<redacted>'"
    )
    .replace(
      /\b([A-Za-z0-9_]*(?:API_KEY|TOKEN|SECRET|PASSWORD|_KEY|KEY)[A-Za-z0-9_]*\s*=\s*)(?:"[^"]*"|'[^']*'|\S+)/gi,
      "$1<redacted>"
    )
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer <redacted>")
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/gi, "<redacted>")
    .replace(/\bnvapi-[A-Za-z0-9_-]{8,}\b/gi, "<redacted>");
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
        if (/error/i.test(line)) {
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
  const settingsPath = resolveProviderSettingsPath(deps.providerSettingsPath);

  return withProviderOverride(
    { provider: effectiveInput.provider, model: effectiveInput.model },
    settingsPath,
    signal,
    async () => {
      const cwd = await validateCwd(effectiveInput.cwd, deps.access);
      const args = [
        "--json",
        "--auto-approve", String(options.autoApprove ?? false),
        "--thinking", effectiveInput.thinking ?? "none",
        "--timeout", String(timeoutSeconds)
      ];
      if (effectiveInput.provider) args.push("-P", effectiveInput.provider);
      if (effectiveInput.model) args.push("-m", effectiveInput.model);
      if (effectiveInput.systemPrompt) args.push("--system", effectiveInput.systemPrompt);
      if (cwd) args.push("--cwd", cwd);
      args.push(effectiveInput.prompt);

      const windowsEntry = deps.entryPath ?? (process.platform === "win32" && process.env.APPDATA
        ? path.join(process.env.APPDATA, "npm", "node_modules", "cline", "bin", "cline")
        : undefined);

      if (process.platform === "win32" && !windowsEntry && !deps.entryPath) {
        throw new ClineRunError("launch_failed", "Unable to locate the local Cline CLI.");
      }

      const executable = (process.platform === "win32" || deps.entryPath) ? process.execPath : "cline";
      const spawnArgs = (process.platform === "win32" || deps.entryPath) && windowsEntry
        ? [windowsEntry, ...args]
        : args;

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
            if (attempt < maxAttempts) {
              if (signal?.aborted) {
                throw new ClineRunError("cancelled", "The Cline request was cancelled.", { attempts: attempt });
              }
              await new Promise((r) => setTimeout(r, updateBackoffMs));
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

        const started = performance.now();
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
          let exitCode: number | null = null;
          let exitSignal: NodeJS.Signals | null = null;

          const timerDuration = deps.timeoutMs ?? (timeoutSeconds * 1000 + 1_000);
          const timer = setTimeout(() => {
            timedOut = true;
            try {
              child?.kill();
            } catch {}
          }, timerDuration);
          if (!deps.timeoutMs) {
            timer.unref();
          }

          const abort = () => {
            cancelled = true;
            try {
              child?.kill();
            } catch {}
          };
          signal?.addEventListener("abort", abort, { once: true });

          const cleanup = () => {
            if (settled) return false;
            settled = true;
            clearTimeout(timer);
            if (exitTimer) {
              clearTimeout(exitTimer);
            }
            signal?.removeEventListener("abort", abort);
            return true;
          };

          const closeGracePeriodMs = deps.closeGracePeriodMs ?? 500;

          try {
            child = spawnFn(executable, spawnArgs, {
              shell: false,
              windowsHide: true,
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

          let spawnError: any;
          child.on("error", (err) => {
            spawnError = err;
            if (cleanup()) {
              resolve({ code: null, signal: null, error: err });
            }
          });

          child.on("exit", (code, sig) => {
            exitCode = code;
            exitSignal = sig;
            exitTimer = setTimeout(() => {
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
            }, closeGracePeriodMs);
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

        const elapsedSec = ((performance.now() - started) / 1000).toFixed(1);
        const code = exitInfo.code;

        if (cancelled || signal?.aborted) {
          throw new ClineRunError("cancelled", "The Cline request was cancelled.", { attempts: attempt });
        }

        const stdoutTail = getTail(redactSecrets(stdout));
        const stderrTail = getTail(redactSecrets(stderr));
        const effectiveCode = code !== null ? code : -1;

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
              durationMs: usableResult.durationMs ?? Math.round(performance.now() - started)
            };
          }
          return {
            ...usableResult,
            durationMs: usableResult.durationMs ?? Math.round(performance.now() - started)
          };
        }

        // 2. Timeout check (retry only if timeoutSeconds <= 120)
        if (timedOut) {
          const timeoutMsg = buildErrorTextWithTails(
            `Cline exceeded the ${timeoutSeconds}-second timeout (elapsed: ${elapsedSec}s).`,
            stderrTail,
            stdoutTail
          );
          let allowRetry = timeoutSeconds <= 120;
          if (allowRetry && options.canRetry) {
            allowRetry = await options.canRetry({ stdout, stderr, attempt });
          }
          if (allowRetry && attempt < maxAttempts) {
            if (signal?.aborted) {
              throw new ClineRunError("cancelled", "The Cline request was cancelled.", { attempts: attempt });
            }
            await new Promise((r) => setTimeout(r, backoffMs));
            if (signal?.aborted) {
              throw new ClineRunError("cancelled", "The Cline request was cancelled.", { attempts: attempt });
            }
            continue;
          }
          throw new ClineRunError("timeout", timeoutMsg, {
            exitCode: null,
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
          let allowRetry = true;
          if (options.canRetry) {
            allowRetry = await options.canRetry({ stdout, stderr, attempt });
          }
          if (allowRetry && attempt < maxAttempts) {
            if (signal?.aborted) {
              throw new ClineRunError("cancelled", "The Cline request was cancelled.", { attempts: attempt });
            }
            await new Promise((r) => setTimeout(r, updateBackoffMs));
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
        const transient = isTransientError({
          code,
          stderr,
          runResultErrorText,
          extractedError,
          timedOut: false
        });

        if (transient) {
          let allowRetry = true;
          if (options.canRetry) {
            allowRetry = await options.canRetry({ stdout, stderr, attempt });
          }
          if (allowRetry && attempt < maxAttempts) {
            if (signal?.aborted) {
              throw new ClineRunError("cancelled", "The Cline request was cancelled.", { attempts: attempt });
            }
            await new Promise((r) => setTimeout(r, backoffMs));
            if (signal?.aborted) {
              throw new ClineRunError("cancelled", "The Cline request was cancelled.", { attempts: attempt });
            }
            continue;
          }
          const exitMsg = code !== null ? ` (exit code ${code})` : exitInfo.signal ? ` (signal ${exitInfo.signal})` : "";
          const summary = `Cline failed with transient provider error${exitMsg}: ${extractedError || runResultErrorText || "Service temporarily unavailable"}.`;
          const msg = buildErrorTextWithTails(summary, stderrTail, stdoutTail);
          throw new ClineRunError("transient_provider_error", msg, {
            exitCode: code,
            stderrTail,
            stdoutTail,
            attempts: attempt,
            extractedMessage: extractedError || runResultErrorText
          });
        }

        // 5. If not transient, but run_result or stderr had an error message (even with code === 0):
        if (runResultErrorText || extractedError) {
          const errorDetail = extractedError || runResultErrorText;
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
  );
}

export async function askCline(
  input: AskClineInput,
  signal?: AbortSignal,
  options?: ClineInvocationOptions
): Promise<ClineResponse> {
  return runCline(input, signal, options);
}
