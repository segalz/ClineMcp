import { mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import {
  defaultKillTree,
  ClineRunError,
  runCline,
  type AskClineInput,
  type ClineInvocationOptions,
  type ClineResponse
} from "./runner.js";

export interface AskClineWorkspaceInput {
  prompt: string;
  cwd: string;
  thinking?: AskClineInput["thinking"];
  timeoutSeconds?: number;
  provider?: string;
  model?: string;
}

const WORKTREE_BASE = path.join(os.tmpdir(), "cline-mcp-worktrees");
const WORKSPACE_SYSTEM_PROMPT = [
  "You are performing an analysis-only review in a disposable Git worktree.",
  "Do not create, edit, delete, rename, format, stage, commit, or restore files.",
  "Do not run commands that modify state, access credentials, or make network requests.",
  "You may use only read/search/inspection tools inside this worktree.",
  "Return findings and recommendations as final response text only."
].join(" ");

function gitExecutable(): string {
  return process.platform === "win32" ? "git.exe" : "git";
}

/** A Git command may not hang a run or a task slot: it has a deadline and follows the caller's abort signal. */
export const GIT_TIMEOUT_MS = 60_000;
/** Worktree removal is quick; a shorter deadline keeps the bridge's shutdown wait bounded. */
export const CLEANUP_GIT_TIMEOUT_MS = 20_000;

function runGit(cwd: string, args: string[], signal?: AbortSignal, timeoutMs = GIT_TIMEOUT_MS): Promise<string> {
  return new Promise((resolve, reject) => {
    let stdout = "";
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
    child.stderr.resume();
    child.on("error", () => settle(() => reject(new Error("git launch failed"))));
    child.on("close", (code) => settle(() => { code === 0 ? resolve(stdout.trim()) : reject(new Error("git command failed")); }));
  });
}

async function cleanupWorktree(repositoryRoot: string, worktreePath: string): Promise<void> {
  try {
    await runGit(repositoryRoot, ["worktree", "remove", "--force", worktreePath], undefined, CLEANUP_GIT_TIMEOUT_MS);
  } catch {
    // Removal can fail transiently on Windows when Cline has just released a handle.
  }
  try {
    await rm(worktreePath, { recursive: true, force: true, maxRetries: 5, retryDelay: 250 });
    await runGit(repositoryRoot, ["worktree", "prune"], undefined, CLEANUP_GIT_TIMEOUT_MS);
  } catch {
    throw new ClineRunError("workspace_cleanup_failed", "The temporary Cline worktree could not be removed completely.");
  }
}

export async function askClineWorkspace(
  input: AskClineWorkspaceInput,
  signal?: AbortSignal,
  options: Partial<ClineInvocationOptions> = {}
): Promise<ClineResponse> {
  const requestedCwd = path.resolve(input.cwd);
  let repositoryRoot: string;
  let commit: string;
  try {
    repositoryRoot = await runGit(requestedCwd, ["rev-parse", "--show-toplevel"], signal);
    commit = await runGit(repositoryRoot, ["rev-parse", "HEAD"], signal);
  } catch {
    if (signal?.aborted) throw new ClineRunError("cancelled", "The Cline request was cancelled.", { attempts: 0 });
    throw new ClineRunError("workspace_not_git", "The requested cwd must be inside a Git repository with at least one commit.");
  }

  await mkdir(WORKTREE_BASE, { recursive: true });
  const worktreePath = path.join(WORKTREE_BASE, `review-${randomUUID()}`);
  try {
    await runGit(repositoryRoot, ["worktree", "add", "--detach", worktreePath, commit], signal);
  } catch {
    // A failed, timed-out or cancelled add can leave a partial worktree behind; if removing it fails too,
    // the caller is told where it is.
    let leftover: string | undefined;
    await cleanupWorktree(repositoryRoot, worktreePath).catch((cleanupError: unknown) => {
      leftover = `The partial worktree ${worktreePath} could not be removed: ${(cleanupError as Error)?.message ?? String(cleanupError)}`;
    });
    const setupError = signal?.aborted
      ? new ClineRunError("cancelled", "The Cline request was cancelled.", { attempts: 0 })
      : undefined;
    if (setupError) {
      if (leftover) setupError.notes = [leftover];
      throw setupError;
    }
    if (leftover) {
      const failed = new ClineRunError("workspace_setup_failed", "Unable to create a temporary Git worktree for Cline.");
      failed.notes = [leftover];
      throw failed;
    }
    throw new ClineRunError("workspace_setup_failed", "Unable to create a temporary Git worktree for Cline.");
  }

  let result: ClineResponse | undefined;
  let runError: unknown;
  try {
    result = await runCline(
      { ...input, cwd: worktreePath },
      signal,
      {
        ...options,
        autoApprove: true,
        cwd: worktreePath,
        systemPrompt: WORKSPACE_SYSTEM_PROMPT,
        provider: input.provider,
        model: input.model
      }
    );
  } catch (err) {
    runError = err;
  }
  try {
    await cleanupWorktree(repositoryRoot, worktreePath);
  } catch (cleanupError) {
    const trace = result?.trace ?? (runError as { trace?: ClineResponse["trace"] } | undefined)?.trace;
    if (cleanupError instanceof ClineRunError && trace) cleanupError.trace = trace;
    // A failed run's own error stays primary, but the leftover worktree must still be reported.
    if (runError === undefined) throw cleanupError;
    const note = `The temporary worktree ${worktreePath} could not be removed: ${(cleanupError as Error)?.message ?? String(cleanupError)}`;
    if (runError instanceof ClineRunError) {
      runError.notes = [...(runError.notes ?? []), note];
    } else {
      // A plain error cannot carry notes: report both in one typed error so the leftover path is never hidden.
      const wrapped = new ClineRunError("workspace_cleanup_failed",
        `The Cline run failed (${(runError as Error)?.message ?? String(runError)}).`);
      wrapped.notes = [note];
      if (trace) wrapped.trace = trace;
      throw wrapped;
    }
  }
  if (runError !== undefined) throw runError;
  return result!;
}
