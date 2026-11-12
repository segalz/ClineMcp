import { spawn } from "node:child_process";
import path from "node:path";
import { buildEnvironmentLine, WORKING_RULES } from "./rules.js";
import { withCodeMap } from "./codemap.js";
import { acquire, ownsCheckoutLock } from "./checkoutlock.js";
import {
  defaultKillTree,
  ClineRunError,
  hasMadeToolCallsOrModifications,
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
}

export interface ClineEditsResponse extends ClineResponse {
  gitDiff: string;
  status: string;
  headBefore: string;
  headAfter: string;
  commitWasReverted: boolean;
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
  const requestedCwd = path.resolve(input.cwd);
  let repositoryRoot: string;
  let headBefore: string;
  try {
    repositoryRoot = path.resolve(await runGit(requestedCwd, ["rev-parse", "--show-toplevel"], signal));
    headBefore = await runGit(repositoryRoot, ["rev-parse", "HEAD"], signal);
  } catch {
    if (signal?.aborted) throw new ClineRunError("cancelled", "The Cline request was cancelled.", { attempts: 0 });
    throw new ClineRunError("workspace_not_git", "The requested cwd must be inside a Git repository with at least one commit.");
  }

  const release = ownsCheckoutLock(options.checkoutLock, repositoryRoot) ? undefined
    : acquire(repositoryRoot, { lockDirectory: options.checkoutLockDirectory });
  try {
    return await applyWithinLock(input, repositoryRoot, headBefore, signal, options);
  } finally { release?.(); }
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
export async function runClineEditStep(input: ApplyClineEditsInput, signal: AbortSignal,
  options: Partial<ClineInvocationOptions>): Promise<ClineResponse> {
  if (!ownsCheckoutLock(options.checkoutLock, input.cwd)) {
    throw new ClineRunError("checkout_busy", "A step requires its task's checkout lock.", { attempts: 0 });
  }
  return runEdits(input, input.cwd, signal, options);
}

async function runEdits(input: ApplyClineEditsInput, repositoryRoot: string, signal: AbortSignal | undefined,
  options: Partial<ClineInvocationOptions>): Promise<ClineResponse> {
  return runCline({ ...input, cwd: repositoryRoot }, signal, await withCodeMap(repositoryRoot, input, {
    ...options, autoApprove: true, cwd: repositoryRoot, systemPrompt: buildEditSystemPrompt(repositoryRoot),
    provider: input.provider, model: input.model
  }, signal));
}

async function applyWithinLock(input: ApplyClineEditsInput, repositoryRoot: string, headBefore: string,
  signal: AbortSignal | undefined, options: Partial<ClineInvocationOptions>): Promise<ClineEditsResponse> {

  const canRetry = async ({ stdout }: { stdout: string; stderr: string; attempt: number }) => {
    // Read-only checks before a retry: they follow the caller's cancel and share one short budget.
    const deadline = Date.now() + RETRY_CHECK_GIT_BUDGET_MS;
    const checkGit = (args: string[]) => runGit(repositoryRoot, args, signal, Math.max(1000, deadline - Date.now()));
    try {
      const currentHead = await checkGit(["rev-parse", "HEAD"]);
      if (currentHead !== headBefore) return false;
      const gitDiff = await checkGit(["diff", "--binary", "--no-ext-diff", "HEAD"]);
      if (gitDiff.trim().length > 0) return false;
      const status = await checkGit(["status", "--short"]);
      if (status.trim().length > 0) return false;
    } catch {
      return false;
    }

    if (hasMadeToolCallsOrModifications(stdout)) {
      return false;
    }

    return true;
  };

  const result = await runEdits(input, repositoryRoot, signal, { ...options, canRetry });

  try {
    return await inspectAfterRun(result);
  } catch (err) {
    // The run itself was traced; a failure while inspecting Git must not lose that trace.
    if (err instanceof ClineRunError && result.trace && !err.trace) err.trace = result.trace;
    throw err;
  }

  async function inspectAfterRun(result: Awaited<ReturnType<typeof runCline>>): Promise<ClineEditsResponse> {
  // One shared budget for every post-run Git step, so inspection plus commit recovery stays inside the
  // bridge's shutdown wait instead of 60 s per command.
  const postRunDeadline = Date.now() + POST_RUN_GIT_BUDGET_MS;
  const postGit = (args: string[]) => runGit(repositoryRoot, args, undefined, Math.max(1000, postRunDeadline - Date.now()));
  let headAfter: string | undefined;
  let gitDiff: string | undefined;
  let status: string | undefined;
  try {
    headAfter = await postGit(["rev-parse", "HEAD"]);
    gitDiff = truncateGitDiff(await postGit(["diff", "--binary", "--no-ext-diff", "HEAD"]));
    status = await postGit(["status", "--short"]);
  } catch {
    throw new ClineEditsError(
      "edits_inspection_failed",
      "Cline finished, but the resulting Git state could not be inspected.",
      { headBefore, ...(headAfter ? { headAfter } : {}), ...(gitDiff !== undefined ? { gitDiff } : {}), ...(status !== undefined ? { status } : {}) }
    );
  }

  let commitWasReverted = false;
  if (headAfter !== headBefore) {
    const committedHead = headAfter;
    try {
      const headImmediatelyBeforeReset = await postGit(["rev-parse", "HEAD"]);
      if (headImmediatelyBeforeReset !== committedHead) {
        throw new Error("HEAD changed while preparing to cancel Cline's commit");
      }
      await postGit(["merge-base", "--is-ancestor", headBefore, committedHead]);
      await postGit(["reset", "--soft", headBefore]);
      headAfter = await postGit(["rev-parse", "HEAD"]);
      if (headAfter !== headBefore) throw new Error("HEAD did not return to its original commit");
      gitDiff = truncateGitDiff(await postGit(["diff", "--binary", "--no-ext-diff", "HEAD"]));
      status = await postGit(["status", "--short"]);
      commitWasReverted = true;
    } catch {
      throw new ClineEditsError(
        "commit_created",
        "Cline changed HEAD and the commit could not be safely cancelled. Inspect the repository before continuing.",
        { headBefore, headAfter: committedHead, gitDiff, status }
      );
    }
  }

  return { ...result, gitDiff, status, headBefore, headAfter, commitWasReverted };
  }
}
