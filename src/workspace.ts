import { mkdir, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { buildEnvironmentLine, WORKING_RULES } from "./rules.js";
import { withCodeMap } from "./codemap.js";
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
  codeMap?: boolean;
}

export const WORKTREE_BASE = path.join(os.tmpdir(), "cline-mcp-worktrees");
export const WORKSPACE_SYSTEM_PROMPT = [
  "You are performing an analysis-only review in a disposable Git worktree.",
  "Do not create, edit, delete, rename, format, stage, commit, or restore files.",
  "Do not run commands that modify state, access credentials, or make network requests.",
  "You may use only read/search/inspection tools inside this worktree.",
  "Return findings and recommendations as final response text only.",
  WORKING_RULES
].join("\n");

export function buildWorkspaceSystemPrompt(cwd: string, platform: NodeJS.Platform = process.platform): string {
  return `${buildEnvironmentLine(cwd, "workspace", platform)}\n${WORKSPACE_SYSTEM_PROMPT}`;
}

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

export interface ProcessInfo {
  pid: number;
  commandLine: string;
}

function normalizePathForMatch(value: string): string {
  return value.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

/**
 * PIDs of Cline hub daemons whose working directory is this worktree. Cline starts
 * `cline --cline-hub-daemon --cwd <dir>` on demand and it outlives the run, so on Windows
 * it keeps the worktree folder busy and the folder cannot be removed.
 */
export function hubDaemonPidsFor(worktreePath: string, processes: readonly ProcessInfo[]): number[] {
  const target = normalizePathForMatch(worktreePath);
  return processes
    .filter(({ commandLine }) => {
      const cwd = hubDaemonCwd(commandLine);
      return cwd !== undefined && normalizePathForMatch(cwd) === target;
    })
    .map(({ pid }) => pid);
}

/** Lists cline.exe processes with their command lines (Windows only; empty elsewhere or on error). */
async function listClineProcesses(): Promise<ProcessInfo[]> {
  if (process.platform !== "win32") return [];
  const script = "Get-CimInstance Win32_Process -Filter \"Name='cline.exe'\" | "
    + "ForEach-Object { [string]$_.ProcessId + [char]9 + $_.CommandLine }";
  return new Promise((resolve) => {
    let stdout = "";
    const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
      windowsHide: true, stdio: ["ignore", "pipe", "ignore"]
    });
    const timer = setTimeout(() => { try { child.kill(); } catch { /* gone */ } resolve([]); }, 15_000);
    timer.unref?.();
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
    child.on("error", () => { clearTimeout(timer); resolve([]); });
    child.on("close", () => {
      clearTimeout(timer);
      resolve(stdout.split(/\r?\n/).flatMap((line) => {
        const tab = line.indexOf("\t");
        const pid = Number(line.slice(0, tab));
        return tab > 0 && Number.isInteger(pid) && pid > 0 ? [{ pid, commandLine: line.slice(tab + 1) }] : [];
      }));
    });
  });
}

function hubDaemonCwd(commandLine: string): string | undefined {
  if (!commandLine.includes("--cline-hub-daemon")) return undefined;
  const match = /--cwd\s+(?:"([^"]+)"|(\S+))/.exec(commandLine);
  return match?.[1] ?? match?.[2];
}

/** Worktree runs in flight in this process; leftovers are only touched when it is zero. */
let activeWorktreeRuns = 0;

/** Removes empty `review-*` folders that an earlier run could not delete (best effort). */
async function sweepEmptyWorktreeFolders(): Promise<void> {
  let names: string[];
  try { names = await readdir(WORKTREE_BASE); } catch { return; }
  for (const name of names) {
    if (!name.startsWith("review-")) continue;
    const folder = path.join(WORKTREE_BASE, name);
    if (await folderIsEmptyOrGone(folder)) await rm(folder, { recursive: true, force: true }).catch(() => {});
  }
}

async function folderIsEmptyOrGone(folder: string): Promise<boolean> {
  try {
    return (await readdir(folder)).length === 0;
  } catch {
    return true;
  }
}

/**
 * Each bridge run uses its own hub (runCline's dedicatedHub), stopped when the run ends. Older bridge
 * versions let the shared hub settle inside a worktree, where it keeps the folder busy on Windows.
 * Before each worktree run: stop such a leftover hub when its folder is already empty, and sweep empty
 * leftover `review-*` folders.
 */
async function ensureNeutralHub(options: Partial<ClineInvocationOptions>): Promise<void> {
  if (process.platform !== "win32" || options.deps?.spawn || options.deps?.entryPath) return;
  const base = `${normalizePathForMatch(WORKTREE_BASE)}/`;
  // The hub is shared by every Cline run on the machine, so a leftover one is stopped only while
  // this bridge has no other worktree run in flight, and only when its folder is already empty.
  if (activeWorktreeRuns === 0) {
    let stopped = false;
    for (const { pid, commandLine } of await listClineProcesses()) {
      const cwd = hubDaemonCwd(commandLine);
      if (cwd && normalizePathForMatch(cwd).startsWith(base) && await folderIsEmptyOrGone(cwd)) {
        defaultKillTree(pid, "SIGKILL", process.platform);
        stopped = true;
      }
    }
    if (stopped) await new Promise((resolve) => setTimeout(resolve, 1000));
    await sweepEmptyWorktreeFolders();
  }
}

async function removeWorktreeFolder(repositoryRoot: string, worktreePath: string): Promise<void> {
  await rm(worktreePath, { recursive: true, force: true, maxRetries: 5, retryDelay: 250 });
  await runGit(repositoryRoot, ["worktree", "prune"], undefined, CLEANUP_GIT_TIMEOUT_MS);
}

async function cleanupWorktree(repositoryRoot: string, worktreePath: string): Promise<void> {
  try {
    await runGit(repositoryRoot, ["worktree", "remove", "--force", worktreePath], undefined, CLEANUP_GIT_TIMEOUT_MS);
  } catch {
    // Removal can fail transiently on Windows when Cline has just released a handle.
  }
  try {
    await removeWorktreeFolder(repositoryRoot, worktreePath);
  } catch {
    // Usually a Cline hub daemon started inside this worktree holds the folder. It is shared by
    // other runs, so it is not killed here; the next run's ensureNeutralHub handles it when idle.
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
    await ensureNeutralHub(options);
    activeWorktreeRuns++;
    try {
    result = await runCline(
      { ...input, cwd: worktreePath },
      signal,
      await withCodeMap(worktreePath, input, {
        ...options,
        autoApprove: true,
        cwd: worktreePath,
        systemPrompt: buildWorkspaceSystemPrompt(worktreePath),
        provider: input.provider,
        model: input.model
      }, signal)
    );
    } finally {
      activeWorktreeRuns--;
    }
  } catch (err) {
    runError = err;
  }
  try {
    await cleanupWorktree(repositoryRoot, worktreePath);
  } catch (cleanupError) {
    const trace = result?.trace ?? (runError as { trace?: ClineResponse["trace"] } | undefined)?.trace;
    const note = `The temporary worktree ${worktreePath} could not be removed: ${(cleanupError as Error)?.message ?? String(cleanupError)}`;
    // A finished answer is never discarded because the worktree could not be removed.
    if (runError === undefined && result !== undefined) {
      return { ...result, warnings: [...(result.warnings ?? []), note] };
    }
    // A failed run's own error stays primary, but the leftover worktree must still be reported.
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
