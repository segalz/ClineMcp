import { spawn } from "node:child_process";
import path from "node:path";
import { buildEnvironmentLine, WORKING_RULES } from "./rules.js";
import { withCodeMap, codeMapCommandLineLength } from "./codemap.js";
import { FinalCheckLifecycle, verificationSchema, type VerifySpec, type FinalVerification } from "./finalcheck.js";
import { ownsCheckoutLock } from "./checkoutlock.js";
import {
  defaultKillTree,
  ClineRunError,
  MAX_SYSTEM_PROMPT_CHARACTERS, MAX_TOTAL_TEXT_CHARACTERS, WINDOWS_COMMAND_LINE_LIMIT,
  runCline,
  type AskClineInput,
  type ClineInvocationOptions,
  type ClineResponse
} from "./runner.js";

export interface ApplyClineEditsInput {
  prompt: string;
  cwd: string;
  thinking?: AskClineInput["thinking"];
  timeoutSeconds?: number;
  provider?: string;
  model?: string;
  codeMap?: boolean;
  guard?: AskClineInput["guard"];
  verify: VerifySpec;
  maxFixRuns?: number;
  keepOnFailure?: boolean;
}

export interface ClineEditsResponse extends ClineResponse {
  gitDiff: string;
  status: string;
  headBefore: string;
  headAfter: string;
  commitWasReverted: boolean;
  verification: FinalVerification;
}

export interface ClineEditsEvidence {
  headBefore: string;
  headAfter?: string;
  gitDiff?: string;
  status?: string;
}

export class ClineEditsError extends ClineRunError {
  constructor(
    kind: "commit_created" | "edits_inspection_failed",
    message: string,
    public readonly evidence: ClineEditsEvidence
  ) {
    super(kind, message);
    this.name = "ClineEditsError";
  }
}

const MAX_DIFF_CHARACTERS = 48_000;
export const EDIT_SYSTEM_PROMPT = [
  "You are implementing a software-development task directly in the current Git checkout.",
  "You may inspect and edit only files needed for the requested task, then run safe, relevant verification commands.",
  "Never run git add, git commit, git merge, git rebase, git checkout, git restore, git reset, git stash, git clean, or change branches.",
  "Do not access credentials, make unrelated network requests, or modify files outside this checkout.",
  "Leave all changes uncommitted and summarize the changed files and verification in your final response.",
  WORKING_RULES
].join("\n");

export function buildEditSystemPrompt(cwd: string, platform: NodeJS.Platform = process.platform): string {
  return `${buildEnvironmentLine(cwd, "edits", platform)}\n${EDIT_SYSTEM_PROMPT}`;
}

function gitExecutable(): string {
  return process.platform === "win32" ? "git.exe" : "git";
}

/** A Git command may not hang a run or a task slot: it has a deadline and follows the caller's abort signal. */
export const GIT_TIMEOUT_MS = 60_000;
/** Total for all Git steps after the run (inspection and commit recovery). */
export const POST_RUN_GIT_BUDGET_MS = 60_000;
/** Total for the read-only Git checks before a retry. */
export const RETRY_CHECK_GIT_BUDGET_MS = 20_000;

function runGit(cwd: string, args: string[], signal?: AbortSignal, timeoutMs = GIT_TIMEOUT_MS): Promise<string> {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    const child = spawn(gitExecutable(), ["-C", cwd, ...args], {
      shell: false,
      windowsHide: true,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
      stdio: ["ignore", "pipe", "pipe"]
    });
    let finished = false;
    const stop = (message: string) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      // Windows: kill the whole tree (worktree add runs its checkout in a child git). Elsewhere git is not a
      // group leader, so a plain kill of the process is what is available.
      try {
        if (process.platform === "win32" && typeof child.pid === "number") defaultKillTree(child.pid, "SIGKILL", "win32");
        else child.kill();
      } catch { /* already gone */ }
      // Reject only once Git has really exited (or after 5 s), so the caller's cleanup does not race it.
      const giveUp = setTimeout(() => reject(new Error(message)), 5000);
      child.once("close", () => { clearTimeout(giveUp); reject(new Error(message)); });
    };
    const timer = setTimeout(() => stop(`git ${args[0]} timed out after ${Math.round(timeoutMs / 1000)} s`), timeoutMs);
    timer.unref?.();
    const onAbort = () => stop("git command cancelled");
    if (signal?.aborted) onAbort(); else signal?.addEventListener("abort", onAbort, { once: true });
    const settle = (fn: () => void) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      fn();
    };
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
    child.on("error", () => settle(() => reject(new Error("git launch failed"))));
    child.on("close", (code) => settle(() => {
      if (code === 0) return resolve(stdout.trim());
      reject(new Error(stderr.trim() || "git command failed"));
    }));
  });
}

export function truncateGitDiff(diff: string): string {
  if (diff.length <= MAX_DIFF_CHARACTERS) return diff;
  return `${diff.slice(0, MAX_DIFF_CHARACTERS)}\n\n[Diff truncated at ${MAX_DIFF_CHARACTERS} characters.]`;
}

export async function applyClineEdits(
  input: ApplyClineEditsInput,
  signal?: AbortSignal,
  options: Partial<ClineInvocationOptions> = {}
): Promise<ClineEditsResponse> {
  const verify = verificationSchema.parse(input.verify);
  const lifecycle: FinalCheckLifecycle = new FinalCheckLifecycle({ ...input, guard: options.guard ?? input.guard, verify, timeoutSeconds: input.timeoutSeconds ?? 180 }, {
    resolveRoot: editsCheckoutRoot, checkoutLock: options.checkoutLock, lockDirectory: options.checkoutLockDirectory,
    fits: prompt => editPromptFits({ ...input, cwd: lifecycle.root, prompt }, options), question: editQuestion,
    run: (prompt, runSignal, lock, guard, remainingSeconds) => runEdits({ ...input, prompt, cwd: lifecycle.root,
      timeoutSeconds: remainingSeconds, guard }, lifecycle.root, runSignal,
      { ...options, checkoutLock: lock, guard, maxAttempts: 1 })
  });
  try {
    await lifecycle.execute(signal ?? new AbortController().signal);
    if (lifecycle.phase !== "done") {
      const reason = lifecycle.waitReason;
      if (lifecycle.lock) {
        try { lifecycle.evidence.gitDiff = truncateGitDiff(await runGit(lifecycle.root, ["diff", "--binary", "--no-ext-diff", "HEAD"])); }
        catch { /* Recovery evidence must survive an inspection failure. */ }
      }
      if (input.keepOnFailure && !signal?.aborted && lifecycle.waitReason !== "head_changed") await lifecycle.keep();
      else await lifecycle.restore();
      const error = lifecycle.error instanceof ClineRunError ? lifecycle.error
        : new ClineRunError("edits_inspection_failed", `Edit failed: ${reason ?? "verification failed"}.`);
      Object.assign(error, { verification: lifecycle.verification, evidence: lifecycle.evidence,
        usage: lifecycle.usage, cost: lifecycle.cost, durationMs: lifecycle.durationMs });
      throw error;
    }
    if (lifecycle.cancelled) {
      const error = new ClineRunError("cancelled", "The Cline request was cancelled.");
      Object.assign(error, { verification: lifecycle.verification, evidence: lifecycle.evidence }); throw error;
    }
    const head = lifecycle.identity!.head;
    return { ...lifecycle.result!, usage: lifecycle.usage, cost: lifecycle.cost, durationMs: lifecycle.durationMs,
      gitDiff: truncateGitDiff(await runGit(lifecycle.root, ["diff", "--binary", "--no-ext-diff", "HEAD"])),
      status: await runGit(lifecycle.root, ["--no-optional-locks", "status", "--short"]),
      headBefore: head, headAfter: head, commitWasReverted: false, verification: lifecycle.verification };
  } finally { lifecycle.release(); }
}

export function editQuestion(text: string): { question: string; options?: string[] } | undefined {
  const lines = text.split(/\r?\n/).filter(line => line.trim());
  const last = lines.at(-1) ?? "";
  const options = /^ {0,3}OPTIONS:\s*(.+)$/i.exec(last);
  const question = /^ {0,3}QUESTION:\s*(.+)$/i.exec(options ? lines.at(-2) ?? "" : last)?.[1]?.trim();
  return question ? { question, ...(options ? { options: options[1].split("|").map(v => v.trim()).filter(Boolean).slice(0, 5) } : {}) } : undefined;
}

export function editPromptFits(input: Omit<ApplyClineEditsInput, "verify">, options: Partial<ClineInvocationOptions> = {}): boolean {
  const systemPrompt = buildEditSystemPrompt(path.resolve(input.cwd), options.deps?.platform ?? process.platform);
  return input.prompt.length <= 20_000 && systemPrompt.length <= MAX_SYSTEM_PROMPT_CHARACTERS &&
    input.prompt.length + systemPrompt.length + (options.promptPreamble?.length ?? 0) <= MAX_TOTAL_TEXT_CHARACTERS &&
    ((options.deps?.platform ?? process.platform) !== "win32" || codeMapCommandLineLength(input,
      { ...options, systemPrompt, autoApprove: true, cwd: input.cwd }, "") <= WINDOWS_COMMAND_LINE_LIMIT);
}

/** Resolve the same root as the sync edits path before an async task takes ownership. */
export async function editsCheckoutRoot(cwd: string, signal?: AbortSignal): Promise<string> {
  try { return path.resolve(await runGit(path.resolve(cwd), ["rev-parse", "--show-toplevel"], signal)); }
  catch {
    if (signal?.aborted) throw new ClineRunError("cancelled", "The Cline request was cancelled.", { attempts: 0 });
    throw new ClineRunError("workspace_not_git", "The requested cwd must be inside a Git repository with at least one commit.");
  }
}

/** A task-owned step must inspect identity itself: no Git status refresh or commit recovery is allowed here. */
export async function runClineEditStep(input: Omit<ApplyClineEditsInput, "verify">, signal: AbortSignal,
  options: Partial<ClineInvocationOptions>): Promise<ClineResponse> {
  if (!ownsCheckoutLock(options.checkoutLock, input.cwd)) {
    throw new ClineRunError("checkout_busy", "A step requires its task's checkout lock.", { attempts: 0 });
  }
  return runEdits(input, input.cwd, signal, options);
}

async function runEdits(input: Omit<ApplyClineEditsInput, "verify">, repositoryRoot: string, signal: AbortSignal | undefined,
  options: Partial<ClineInvocationOptions>): Promise<ClineResponse> {
  return runCline({ ...input, cwd: repositoryRoot }, signal, await withCodeMap(repositoryRoot, input, {
    ...options, autoApprove: true, cwd: repositoryRoot, systemPrompt: buildEditSystemPrompt(repositoryRoot),
    provider: input.provider, model: input.model
  }, signal));
}
