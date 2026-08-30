import { mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { ClineRunError, runCline, type AskClineInput, type ClineResponse } from "./runner.js";

export interface AskClineWorkspaceInput {
  prompt: string;
  cwd: string;
  thinking?: AskClineInput["thinking"];
  timeoutSeconds?: number;
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

function runGit(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    let stdout = "";
    const child = spawn(gitExecutable(), ["-C", cwd, ...args], {
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
    child.stderr.resume();
    child.on("error", () => reject(new Error("git launch failed")));
    child.on("close", (code) => code === 0 ? resolve(stdout.trim()) : reject(new Error("git command failed")));
  });
}

async function cleanupWorktree(repositoryRoot: string, worktreePath: string): Promise<void> {
  try {
    await runGit(repositoryRoot, ["worktree", "remove", "--force", worktreePath]);
  } catch {
    // Removal can fail transiently on Windows when Cline has just released a handle.
  }
  try {
    await rm(worktreePath, { recursive: true, force: true, maxRetries: 5, retryDelay: 250 });
    await runGit(repositoryRoot, ["worktree", "prune"]);
  } catch {
    throw new ClineRunError("workspace_cleanup_failed", "The temporary Cline worktree could not be removed completely.");
  }
}

export async function askClineWorkspace(
  input: AskClineWorkspaceInput,
  signal?: AbortSignal
): Promise<ClineResponse> {
  const requestedCwd = path.resolve(input.cwd);
  let repositoryRoot: string;
  let commit: string;
  try {
    repositoryRoot = await runGit(requestedCwd, ["rev-parse", "--show-toplevel"]);
    commit = await runGit(repositoryRoot, ["rev-parse", "HEAD"]);
  } catch {
    throw new ClineRunError("workspace_not_git", "The requested cwd must be inside a Git repository with at least one commit.");
  }

  await mkdir(WORKTREE_BASE, { recursive: true });
  const worktreePath = path.join(WORKTREE_BASE, `review-${randomUUID()}`);
  try {
    await runGit(repositoryRoot, ["worktree", "add", "--detach", worktreePath, commit]);
  } catch {
    throw new ClineRunError("workspace_setup_failed", "Unable to create a temporary Git worktree for Cline.");
  }

  try {
    return await runCline(
      { ...input, cwd: worktreePath },
      signal,
      { autoApprove: true, cwd: worktreePath, systemPrompt: WORKSPACE_SYSTEM_PROMPT }
    );
  } finally {
    await cleanupWorktree(repositoryRoot, worktreePath);
  }
}
