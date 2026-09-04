import { spawn } from "node:child_process";
import path from "node:path";
import { ClineRunError, runCline, type AskClineInput, type ClineResponse } from "./runner.js";

export interface ApplyClineEditsInput {
  prompt: string;
  cwd: string;
  thinking?: AskClineInput["thinking"];
  timeoutSeconds?: number;
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
const EDIT_SYSTEM_PROMPT = [
  "You are implementing a software-development task directly in the current Git checkout.",
  "You may inspect and edit only files needed for the requested task, then run safe, relevant verification commands.",
  "Never run git add, git commit, git merge, git rebase, git checkout, git restore, git reset, git stash, git clean, or change branches.",
  "Do not access credentials, make unrelated network requests, or modify files outside this checkout.",
  "Leave all changes uncommitted and summarize the changed files and verification in your final response."
].join(" ");

function gitExecutable(): string {
  return process.platform === "win32" ? "git.exe" : "git";
}

function runGit(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    const child = spawn(gitExecutable(), ["-C", cwd, ...args], {
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
    child.on("error", () => reject(new Error("git launch failed")));
    child.on("close", (code) => {
      if (code === 0) return resolve(stdout.trim());
      reject(new Error(stderr.trim() || "git command failed"));
    });
  });
}

export function truncateGitDiff(diff: string): string {
  if (diff.length <= MAX_DIFF_CHARACTERS) return diff;
  return `${diff.slice(0, MAX_DIFF_CHARACTERS)}\n\n[Diff truncated at ${MAX_DIFF_CHARACTERS} characters.]`;
}

export async function applyClineEdits(
  input: ApplyClineEditsInput,
  signal?: AbortSignal
): Promise<ClineEditsResponse> {
  const requestedCwd = path.resolve(input.cwd);
  let repositoryRoot: string;
  let headBefore: string;
  try {
    repositoryRoot = await runGit(requestedCwd, ["rev-parse", "--show-toplevel"]);
    headBefore = await runGit(repositoryRoot, ["rev-parse", "HEAD"]);
  } catch {
    throw new ClineRunError("workspace_not_git", "The requested cwd must be inside a Git repository with at least one commit.");
  }

  const result = await runCline(
    { ...input, cwd: repositoryRoot },
    signal,
    { autoApprove: true, cwd: repositoryRoot, systemPrompt: EDIT_SYSTEM_PROMPT }
  );

  let headAfter: string | undefined;
  let gitDiff: string | undefined;
  let status: string | undefined;
  try {
    headAfter = await runGit(repositoryRoot, ["rev-parse", "HEAD"]);
    gitDiff = truncateGitDiff(await runGit(repositoryRoot, ["diff", "--binary", "--no-ext-diff", "HEAD"]));
    status = await runGit(repositoryRoot, ["status", "--short"]);
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
      const headImmediatelyBeforeReset = await runGit(repositoryRoot, ["rev-parse", "HEAD"]);
      if (headImmediatelyBeforeReset !== committedHead) {
        throw new Error("HEAD changed while preparing to cancel Cline's commit");
      }
      await runGit(repositoryRoot, ["merge-base", "--is-ancestor", headBefore, committedHead]);
      await runGit(repositoryRoot, ["reset", "--soft", headBefore]);
      headAfter = await runGit(repositoryRoot, ["rev-parse", "HEAD"]);
      if (headAfter !== headBefore) throw new Error("HEAD did not return to its original commit");
      gitDiff = truncateGitDiff(await runGit(repositoryRoot, ["diff", "--binary", "--no-ext-diff", "HEAD"]));
      status = await runGit(repositoryRoot, ["status", "--short"]);
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
