import { access, mkdir, readdir, rm, rmdir, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { buildEnvironmentLine, WORKING_RULES } from "./rules.js";
import { withCodeMap } from "./codemap.js";
import { subfolderOf } from "./finalcheck.js";
import { listClineProcesses, type ProcessInfo } from "./procs.js";
import {
  defaultKillTree,
  enforceQuotaLock,
  killTreeAndWait,
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

export type { ProcessInfo } from "./procs.js";

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

function hubDaemonCwd(commandLine: string): string | undefined {
  if (!commandLine.includes("--cline-hub-daemon")) return undefined;
  const match = /--cwd\s+(?:"([^"]+)"|(\S+))/.exec(commandLine);
  return match?.[1] ?? match?.[2];
}

/** Includes the run checking for leftovers, from worktree setup through cleanup. */
let activeWorktreeRuns = 0;

/**
 * A worktree folder younger than this may still be filling up (another bridge process running `git worktree
 * add`), so it is never treated as a leftover.
 */
export const LEFTOVER_MIN_AGE_MS = 60_000;

/** Yield directories children-first, only after checking the entire worktree for files. */
async function* emptyWorktreeFolders(base: string, minAgeMs = LEFTOVER_MIN_AGE_MS, nowMs = Date.now()) {
  const entries = await readdir(base, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith("review-")) continue;
    const modified = await stat(path.join(base, entry.name)).then(info => info.mtimeMs, () => undefined);
    if (modified === undefined || (minAgeMs > 0 && nowMs - modified < minAgeMs)) continue;
    const folders: string[] = [];
    if (await folderIsEmptyOrGone(path.join(base, entry.name), folders) && folders.length) yield folders;
  }
}

/** True when an emptied `review-*` worktree folder is left behind: the sign of a hub still holding it. */
export async function hasEmptyWorktreeFolder(base = WORKTREE_BASE, minAgeMs = LEFTOVER_MIN_AGE_MS, nowMs = Date.now()): Promise<boolean> {
  const first = await emptyWorktreeFolders(base, minAgeMs, nowMs).next();
  return !first.done;
}

async function folderIsOldEnoughOrGone(folder: string, minAgeMs: number, nowMs: number): Promise<boolean> {
  try {
    const info = await stat(folder);
    return !(minAgeMs > 0 && nowMs - info.mtimeMs < minAgeMs);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT";
  }
}

async function folderIsEmptyOrGone(folder: string, folders?: string[]): Promise<boolean> {
  try {
    const entries = await readdir(folder, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() || !await folderIsEmptyOrGone(path.join(folder, entry.name), folders)) return false;
    }
    folders?.push(folder);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT";
  }
}

export interface LeftoverHubCleanupDeps {
  base?: string;
  minAgeMs?: number;
  now?: () => number;
  isSoleRun?: () => boolean;
  listProcesses?: typeof listClineProcesses;
  killTree?: (pid: number) => Promise<unknown>;
}

/**
 * Stop leftover hub daemons whose own worktree folder is old enough and already empty, then sweep empty
 * leftover `review-*` folders. Applies `minAgeMs` to each hub's own cwd folder as well as to the trigger.
 */
export async function cleanupLeftoverHubs(deps: LeftoverHubCleanupDeps = {}): Promise<void> {
  const worktreeBase = deps.base ?? WORKTREE_BASE;
  const minAgeMs = deps.minAgeMs ?? LEFTOVER_MIN_AGE_MS;
  const now = deps.now ?? Date.now;
  const isSoleRun = deps.isSoleRun ?? (() => true);
  if (!isSoleRun()) return;
  const normalizedBase = `${normalizePathForMatch(path.resolve(worktreeBase))}/`;
  // The ~1 s process scan runs only when an emptied worktree folder is left behind (plan S6, B6): that is
  // the sign of a hub still holding it. Each run's own hub is stopped by runCline itself.
  if (!await hasEmptyWorktreeFolder(worktreeBase, minAgeMs, now()) || !isSoleRun()) return;
  for (const { pid, commandLine } of await (deps.listProcesses ?? listClineProcesses)()) {
    const cwd = hubDaemonCwd(commandLine);
    if (!cwd) continue;
    const resolvedCwd = path.resolve(cwd);
    const normalizedCwd = normalizePathForMatch(resolvedCwd);
    if (!normalizedCwd.startsWith(normalizedBase)) continue;
    const topSegment = normalizedCwd.slice(normalizedBase.length).split("/")[0];
    const worktreeRoot = path.join(worktreeBase, topSegment);
    const nowMs = now();
    // Apply the age rule to the hub's own folder (and its review-* root when nested) so a fresh worktree
    // being set up by another bridge process is never killed when an unrelated old folder triggers cleanup.
    if (!await folderIsOldEnoughOrGone(resolvedCwd, minAgeMs, nowMs)) continue;
    if (normalizePathForMatch(path.resolve(worktreeRoot)) !== normalizedCwd &&
        !await folderIsOldEnoughOrGone(worktreeRoot, minAgeMs, nowMs)) continue;
    // Wait for the kill: the sweep below cannot remove a folder the hub still holds.
    if (!await folderIsEmptyOrGone(resolvedCwd)) continue;
    if (!isSoleRun()) return;
    await (deps.killTree ?? killTreeAndWait)(pid);
  }
  for await (const folders of emptyWorktreeFolders(worktreeBase, minAgeMs, now())) {
    for (const folder of folders) {
      if (!isSoleRun()) return;
      // rmdir also checks at removal time: a file created since the sweep must survive.
      await rmdir(folder).catch(() => {});
    }
  }
}

/**
 * Each bridge run uses its own hub (runCline's dedicatedHub), stopped when the run ends. Older bridge
 * versions let the shared hub settle inside a worktree, where it keeps the folder busy on Windows.
 * Before each worktree run: stop such a leftover hub when its folder is already empty, and sweep empty
 * leftover `review-*` folders.
 */
async function ensureNeutralHub(options: Partial<ClineInvocationOptions>): Promise<void> {
  if (process.platform !== "win32" || options.deps?.spawn || options.deps?.entryPath || activeWorktreeRuns !== 1) return;
  // The hub is shared by every Cline run on the machine, so a leftover one is stopped only while
  // this bridge has no other worktree run in flight, and only when its folder is already empty.
  await cleanupLeftoverHubs({ isSoleRun: () => activeWorktreeRuns === 1 });
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
  activeWorktreeRuns++;
  try {
    return await runWorkspace(input, signal, options);
  } finally {
    activeWorktreeRuns--;
  }
}

async function runWorkspace(input: AskClineWorkspaceInput, signal: AbortSignal | undefined,
  options: Partial<ClineInvocationOptions>): Promise<ClineResponse> {
  if (signal?.aborted) throw new ClineRunError("cancelled", "The Cline request was cancelled.", { attempts: 0 });
  const provider = options.provider ?? input.provider;
  const model = options.model ?? input.model;
  if (provider && model) await enforceQuotaLock(provider, model, options);
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

  // A monorepo subfolder runs in the same subfolder of the worktree (plan S5); an uncommitted folder does not
  // exist at HEAD, so that run starts at the worktree root and says so.
  const inRepository = await subfolderOf(repositoryRoot, requestedCwd);
  const relative = inRepository === undefined ? "" : path.relative(repositoryRoot, inRepository);
  const wantsSubfolder = relative !== "";
  const subfolder = wantsSubfolder ? path.join(worktreePath, relative) : undefined;
  const runCwd = subfolder && await access(subfolder).then(() => true, () => false) ? subfolder : worktreePath;
  const cwdNote = wantsSubfolder && runCwd === worktreePath
    ? `The folder ${relative} does not exist at HEAD; Cline ran at the repository root of the snapshot.` : undefined;

  let result: ClineResponse | undefined;
  let runError: unknown;
  try {
    await ensureNeutralHub(options);
    result = await runCline(
      { ...input, cwd: runCwd },
      signal,
      await withCodeMap(runCwd, input, {
        ...options,
        autoApprove: true,
        cwd: runCwd,
        systemPrompt: buildWorkspaceSystemPrompt(runCwd),
        provider: input.provider,
        model: input.model
      }, signal)
    );
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
      return { ...result, warnings: [...(result.warnings ?? []), ...(cwdNote ? [cwdNote] : []), note] };
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
  return cwdNote ? { ...result!, warnings: [...(result!.warnings ?? []), cwdNote] } : result!;
}
