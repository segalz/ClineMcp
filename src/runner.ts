import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import path from "node:path";
import { JsonlParseError, parseClineJsonl, type ClineFinalResult } from "./parser.js";

export type ThinkingLevel = "none" | "low" | "medium" | "high" | "xhigh";

export interface AskClineInput {
  prompt: string;
  cwd?: string;
  thinking?: ThinkingLevel;
  timeoutSeconds?: number;
  systemPrompt?: string;
}

export class ClineRunError extends Error {
  constructor(
    public readonly kind: "timeout" | "cancelled" | "non_zero_exit" | "malformed_json" | "missing_final_result" | "launch_failed" | "workspace_not_git" | "workspace_setup_failed" | "workspace_cleanup_failed" | "commit_created" | "edits_inspection_failed",
    message: string
  ) {
    super(message);
    this.name = "ClineRunError";
  }
}

export interface ClineInvocationOptions {
  autoApprove?: boolean;
  cwd?: string;
  systemPrompt?: string;
}

export interface ClineResponse extends ClineFinalResult {
  durationMs: number;
}

const DEFAULT_TIMEOUT_SECONDS = 180;
const MAX_TIMEOUT_SECONDS = 300;
export const MAX_PROMPT_CHARACTERS = 20_000;
export const MAX_SYSTEM_PROMPT_CHARACTERS = 8_000;
export const MAX_TOTAL_TEXT_CHARACTERS = 24_000;

async function validateCwd(cwd: string | undefined): Promise<string | undefined> {
  if (!cwd) return undefined;
  const resolved = path.resolve(cwd);
  try {
    await access(resolved);
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
}

export async function runCline(
  input: AskClineInput,
  signal?: AbortSignal,
  options: ClineInvocationOptions = {}
): Promise<ClineResponse> {
  const effectiveInput: AskClineInput = {
    ...input,
    cwd: options.cwd ?? input.cwd,
    systemPrompt: options.systemPrompt ?? input.systemPrompt
  };
  const timeoutSeconds = effectiveInput.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS;
  if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > MAX_TIMEOUT_SECONDS) {
    throw new ClineRunError("launch_failed", `timeoutSeconds must be an integer from 1 to ${MAX_TIMEOUT_SECONDS}.`);
  }
  validateInputLimits(effectiveInput);

  const cwd = await validateCwd(effectiveInput.cwd);
  const args = ["--json", "--auto-approve", String(options.autoApprove ?? false), "--thinking", effectiveInput.thinking ?? "none", "--timeout", String(timeoutSeconds)];
  if (effectiveInput.systemPrompt) args.push("--system", effectiveInput.systemPrompt);
  if (cwd) args.push("--cwd", cwd);
  args.push(effectiveInput.prompt);

  // A global npm install provides cline.cmd on Windows. Do not spawn that
  // batch wrapper: invoke its Node entrypoint directly to keep shell:false.
  const windowsEntry = process.env.APPDATA
    ? path.join(process.env.APPDATA, "npm", "node_modules", "cline", "bin", "cline")
    : undefined;
  if (process.platform === "win32" && !windowsEntry) {
    throw new ClineRunError("launch_failed", "Unable to locate the local Cline CLI.");
  }
  const executable = process.platform === "win32" ? process.execPath : "cline";
  const spawnArgs = process.platform === "win32" ? [windowsEntry!, ...args] : args;
  const started = performance.now();
  return new Promise<ClineResponse>((resolve, reject) => {
    let stdout = "";
    let finished = false;
    let timedOut = false;
    let cancelled = false;
    const child = spawn(executable, spawnArgs, { shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutSeconds * 1000 + 1_000);
    timer.unref();

    const abort = () => {
      cancelled = true;
      child.kill();
    };
    signal?.addEventListener("abort", abort, { once: true });

    const done = (error?: Error) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      if (error) reject(error);
    };

    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
    child.on("error", () => done(new ClineRunError("launch_failed", "Unable to launch the local Cline CLI.")));
    child.on("close", (code) => {
      if (finished) return;
      if (timedOut) return done(new ClineRunError("timeout", `Cline exceeded the ${timeoutSeconds}-second timeout.`));
      if (cancelled) return done(new ClineRunError("cancelled", "The Cline request was cancelled."));
      if (code !== 0) return done(new ClineRunError("non_zero_exit", "Cline exited without a successful result."));
      try {
        const result = parseClineJsonl(stdout);
        finished = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        resolve({ ...result, durationMs: result.durationMs ?? Math.round(performance.now() - started) });
      } catch (error) {
        if (error instanceof JsonlParseError) {
          const kind = error.message.includes("malformed") ? "malformed_json" : "missing_final_result";
          return done(new ClineRunError(kind, error.message));
        }
        return done(new ClineRunError("missing_final_result", "Cline did not return a usable final result."));
      }
    });
  });
}

export async function askCline(input: AskClineInput, signal?: AbortSignal): Promise<ClineResponse> {
  return runCline(input, signal);
}
