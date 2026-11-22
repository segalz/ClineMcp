import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { closeSync, existsSync, linkSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ClineRunError } from "./runner.js";
import { PROCESS_QUERY_TIMEOUT_MS, boundedSignal } from "./waits.js";

export class CheckoutBusyError extends ClineRunError {
  constructor(public readonly checkoutRoot: string) {
    super("checkout_busy", `Checkout already has a writer: ${checkoutRoot}`, { attempts: 0 });
    this.name = "CheckoutBusyError";
  }
}

export interface RetainOptions {
  killUnverified?: boolean;
}
export type FileLease = (() => boolean) & {
  forceRelease(): boolean;
  retain(survivors: number[], options?: RetainOptions): boolean;
  readonly lastError?: string;
};
export type CheckoutRelease = FileLease & { readonly checkoutRoot: string };
interface HeldCheckout {
  release: CheckoutRelease;
  retained: boolean;
  released: boolean;
}
const held = new Map<string, HeldCheckout>();
const acquiring = new Set<string>();

export function canonicalCheckoutPath(checkoutRoot: string): string {
  const resolved = realpathSync(checkoutRoot);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

export function checkoutLockPath(checkoutRoot: string, lockDirectory = path.join(os.homedir(), ".cline-mcp", "locks")): string {
  return path.join(lockDirectory, createHash("sha256").update(canonicalCheckoutPath(checkoutRoot)).digest("hex") + ".lock");
}

function pidIsGone(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); }
  catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // ESRCH: PID does not exist. EPERM: PID belongs to another user or a protected/system process, not a bridge of ours.
    return code === "ESRCH" || code === "EPERM";
  }
  return false;
}

function execFileText(command: string, args: string[], timeout: number, signal?: AbortSignal): Promise<{ ok: boolean; stdout: string }> {
  if (signal?.aborted || timeout <= 0) return Promise.resolve({ ok: false, stdout: "" });
  return new Promise(resolve => {
    let settled = false;
    const finish = (result: { ok: boolean; stdout: string }) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      resolve(result);
    };
    const child = execFile(command, args, { encoding: "utf8", windowsHide: true, timeout, signal }, (error, stdout) => {
      finish({ ok: !error, stdout: stdout ?? "" });
    });
    const onAbort = () => {
      try { child.kill(); } catch { /* already gone */ }
      finish({ ok: false, stdout: "" });
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

async function readProcessStartMs(pid: number, signal?: AbortSignal): Promise<number | "denied" | undefined> {
  if (!Number.isSafeInteger(pid) || pid <= 0) return undefined;
  try {
    if (process.platform === "win32") {
      // Call get_StartTime() directly so Win32 ERROR_ACCESS_DENIED (5) surfaces instead of PowerShell yielding $null.
      const command =
        `try { [System.Diagnostics.Process]::GetProcessById(${pid}).get_StartTime().ToUniversalTime().ToString('o') } ` +
        `catch { $e = $_.Exception; while ($e) { ` +
        `if (($e -is [System.ComponentModel.Win32Exception] -and $e.NativeErrorCode -eq 5) -or $e -is [System.UnauthorizedAccessException]) { Write-Output 'ACCESS_DENIED'; exit 0 }; ` +
        `$e = $e.InnerException }; exit 1 }`;
      const out = await execFileText("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command], PROCESS_QUERY_TIMEOUT_MS, signal);
      if (!out.ok) return undefined;
      const text = out.stdout.trim();
      if (text === "ACCESS_DENIED") return "denied";
      const ms = Date.parse(text);
      return Number.isFinite(ms) ? ms : undefined;
    }
    if (process.platform === "linux") {
      let stat: string;
      try { stat = await readFile(`/proc/${pid}/stat`, { encoding: "utf8", signal }); }
      catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "EACCES" || code === "EPERM") return "denied";
        return undefined;
      }
      const ticks = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19]);
      const boot = Number(/^btime (\d+)$/m.exec(await readFile("/proc/stat", { encoding: "utf8", signal }))?.[1]);
      const getconf = await execFileText("getconf", ["CLK_TCK"], 10_000, signal);
      const hz = (getconf.ok ? Number(getconf.stdout.trim()) : NaN) || 100;
      return Number.isFinite(ticks) && Number.isFinite(boot) ? boot * 1000 + (ticks / hz) * 1000 : undefined;
    }
  } catch { /* unknown */ }
  return undefined;
}

/** Start time of a live process in ms, or undefined when it cannot be read (then nothing is reclaimed). */
export async function processStartMs(pid: number): Promise<number | undefined> {
  const result = await readProcessStartMs(pid);
  return typeof result === "number" ? result : undefined;
}

/** Slack between the OS start time and the holder's own clock reading. */
const START_TOLERANCE_MS = 5_000;

/** Cache of OS process start-time lookups keyed by `${pid}:${time}` for the duration of one wait. */
export type ProcessStartCache = Map<string, number | "denied">;

/** A holder is dead when its PID is gone or inaccessible (protected/other-user process), or when that PID now belongs
 * to a process started after the lock was written (PID reuse). An unreadable start time otherwise keeps the lock busy:
 * a live lock is never reclaimed by age. */
async function pidOwnerIsDead(
  holder: { pid: unknown; time?: unknown; token?: unknown },
  startMs?: (pid: number) => number | undefined | Promise<number | undefined>,
  signal?: AbortSignal,
  startCache?: ProcessStartCache
): Promise<boolean> {
  const pid = Number(holder?.pid);
  if (pidIsGone(pid)) return true;
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  const written = typeof holder?.time === "string" ? Date.parse(holder.time) : NaN;
  if (!Number.isFinite(written)) return false;
  if (pid === process.pid) {
    // A restarted bridge can inherit the old bridge's PID. Legacy tokenless self-locks stay busy.
    return typeof holder.token === "string" && performance.timeOrigin > written + START_TOLERANCE_MS;
  }
  if (!startMs || startMs === processStartMs) {
    const key = `${pid}:${holder.time as string}`;
    let result = startCache?.get(key);
    if (result === undefined) {
      result = await readProcessStartMs(pid, signal);
      signal?.throwIfAborted();
      if (result !== undefined) startCache?.set(key, result);
    }
    if (result === "denied") return true;
    return result !== undefined && result > written + START_TOLERANCE_MS;
  }
  try {
    const started = await startMs(pid);
    return started !== undefined && started > written + START_TOLERANCE_MS;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    return code === "EACCES" || code === "EPERM";
  }
}

/** True when every recorded survivor PID is gone or reused since observation time. */
export async function survivorsAreDead(
  survivors: readonly number[],
  observedAt: string | undefined,
  startMs?: (pid: number) => number | undefined | Promise<number | undefined>,
  signal?: AbortSignal,
  startCache?: ProcessStartCache
): Promise<boolean> {
  for (const pid of survivors) {
    if (!await pidOwnerIsDead({ pid, time: observedAt }, startMs, signal, startCache)) return false;
  }
  return true;
}

/** Survivors can start after acquisition. Compare their OS start against the time they were observed. */
export async function holderIsDead(
  holder: { pid: unknown; time?: unknown; token?: unknown; survivors?: unknown; survivor_time?: unknown; kill_unverified?: unknown },
  startMs?: (pid: number) => number | undefined | Promise<number | undefined>,
  signal?: AbortSignal,
  startCache?: ProcessStartCache
): Promise<boolean> {
  const ownerDead = await pidOwnerIsDead(holder, startMs, signal, startCache);
  if (holder.survivors === undefined) return ownerDead;
  if (!Array.isArray(holder.survivors)) return false;
  if (!ownerDead) {
    // An own-pid retained lease with known survivors heals as soon as every survivor is dead.
    const ownPid = Number(holder.pid) === process.pid;
    if (!ownPid || holder.kill_unverified === true || holder.survivors.length === 0) return false;
  }
  for (const pid of holder.survivors) {
    if (!await pidOwnerIsDead({ pid, time: holder.survivor_time, token: holder.token }, startMs, signal, startCache)) return false;
  }
  return true;
}

export async function deadHolderText(text: string, signal?: AbortSignal, startCache?: ProcessStartCache): Promise<boolean> {
  try { return await holderIsDead(JSON.parse(text), undefined, signal, startCache); }
  catch { signal?.throwIfAborted(); /* An incomplete or unreadable lock is busy, never stale by age alone. */ }
  return false;
}

async function deadHolder(file: string, signal?: AbortSignal): Promise<boolean> {
  try { return await deadHolderText(readFileSync(file, "utf8"), signal); }
  catch { signal?.throwIfAborted(); /* An incomplete or unreadable lock is busy, never stale by age alone. */ }
  return false;
}

/** Removes the lock only if it still holds the exact metadata that was found dead. The death check awaits a process
 * launch, so the holder may release meanwhile and a new writer may create a fresh lock at the same path; that lock
 * must never be unlinked. The re-read and the unlink run with no await in between. */
async function unlinkIfStillDead(file: string, signal?: AbortSignal, knownDeadText?: string): Promise<boolean> {
  let text: string;
  try { text = readFileSync(file, "utf8"); } catch { return false; }
  if (text !== knownDeadText) {
    try { if (!await holderIsDead(JSON.parse(text), undefined, signal)) return false; } catch { signal?.throwIfAborted(); return false; }
    signal?.throwIfAborted();
    try { if (readFileSync(file, "utf8") !== text) return false; } catch { return false; }
  }
  unlinkSync(file);
  return true;
}

function createHolder(file: string, token: string): void {
  const fd = openSync(file, "wx", 0o600);
  try { writeFileSync(fd, JSON.stringify({ pid: process.pid, time: new Date().toISOString(), token })); }
  catch (error) {
    closeSync(fd); // Windows cannot unlink the failed write while this handle is still open.
    unlinkSync(file);
    throw error;
  }
  closeSync(fd);
}

/** Unique claims cannot be replaced while being inspected. Refuse if another live claimant exists.
 * Keeping our claim through the critical section prevents two stale-reaper recoverers from both entering. */
async function claimReclamation(file: string, token: string, root: string, signal?: AbortSignal): Promise<{ file: string; release: () => void }> {
  const directory = file + ".reap-claims";
  mkdirSync(directory, { recursive: true });
  const own = `${process.pid}-${token}.json`;
  const claim = path.join(directory, own);
  createHolder(claim, token);
  try {
    for (const name of readdirSync(directory)) {
      signal?.throwIfAborted();
      if (name === own) continue;
      const pid = /^(\d+)-[a-f0-9-]+\.json$/i.exec(name)?.[1];
      if (!pid || !(pidIsGone(Number(pid)) || await deadHolder(path.join(directory, name), signal))) throw new CheckoutBusyError(root);
      // The pid is encoded before creation, so even a crash before writing metadata is recoverable.
      try { unlinkSync(path.join(directory, name)); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
    return { file: claim, release: () => unlinkSync(claim) };
  } catch (error) { unlinkSync(claim); throw error; }
}

/** Publish only complete metadata. An interrupted private file is never interpreted as a lease. */
export function publishHolder(file: string, data: Record<string, unknown>): void {
  const tmp = file + "." + randomUUID() + ".tmp";
  let linked = false;
  try {
    writeFileSync(tmp, JSON.stringify(data), { flag: "wx", mode: 0o600 });
    linkSync(tmp, file);
    linked = true;
  } finally {
    // .tmp files have no authority: never hide a successful hard link or mask an earlier write/link error.
    try { rmTemp(tmp); } catch { if (linked) { /* published */ } }
  }
}

function rmTemp(file: string): void {
  try { unlinkSync(file); } catch { /* .tmp has no authority */ }
}

/** The owner alone releases or annotates a live lease. Never unlink a replacement or a retained lease unless forced.
 * Both release (with one retry) and retain are best-effort and never throw. */
export function fileLease(file: string, token: string): FileLease {
  let retained = false;
  let lastError: string | undefined;
  const releaseOnce = (): boolean => {
    try {
      if (JSON.parse(readFileSync(file, "utf8")).token === token) unlinkSync(file);
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT" || err instanceof SyntaxError) return true;
      lastError = err instanceof Error ? err.message : String(err);
      return false;
    }
  };
  const releaseWithMode = (force: boolean): boolean => {
    lastError = undefined;
    if (retained && !force) return true;
    if (releaseOnce()) { retained = false; return true; }
    // One best-effort retry for transient Windows sharing/AV locks.
    lastError = undefined;
    if (releaseOnce()) { retained = false; return true; }
    return false;
  };
  const releaseFn = (): boolean => releaseWithMode(false);
  const forceRelease = (): boolean => releaseWithMode(true);
  const retain = (survivors: number[], options?: RetainOptions): boolean => {
    retained = true;
    lastError = undefined;
    let tmp: string | undefined;
    try {
      const data = JSON.parse(readFileSync(file, "utf8"));
      if (data.token !== token) {
        lastError = "Cannot retain a replaced lease";
        return false;
      }
      tmp = file + "." + randomUUID() + ".tmp";
      const updated: Record<string, unknown> = {
        ...data,
        survivors,
        survivor_time: new Date().toISOString()
      };
      if (options?.killUnverified) updated.kill_unverified = true;
      else delete updated.kill_unverified;
      writeFileSync(tmp, JSON.stringify(updated), { flag: "wx", mode: 0o600 });
      renameSync(tmp, file);
      return true;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      return false;
    } finally {
      if (tmp) rmTemp(tmp);
    }
  };
  const lease = Object.assign(releaseFn, { forceRelease, retain });
  Object.defineProperty(lease, "lastError", { get: () => lastError, enumerable: true });
  return lease as FileLease;
}

/** Shared serialized stale reaper for checkout and admission locks. */
export async function claimFile(file: string, token: string, root: string, create: () => void,
  signal?: AbortSignal, deadlineMs?: number): Promise<void> {
  try { create(); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const reclaimSignal = boundedSignal(deadlineMs ?? PROCESS_QUERY_TIMEOUT_MS, signal);
    try {
      let initialText: string | undefined;
      try { initialText = readFileSync(file, "utf8"); } catch { /* gone or unreadable */ }
      if (initialText === undefined || !await deadHolderText(initialText, reclaimSignal)) {
        signal?.throwIfAborted();
        throw new CheckoutBusyError(root);
      }
      // Serialize reclaimers: none may unlink a newly created live lock after another reclaimed it.
      const reaper = file + ".reap";
      const claim = await claimReclamation(file, token, root, reclaimSignal);
      let reaperOwned = false;
      try {
        reclaimSignal.throwIfAborted();
        if (existsSync(reaper)) {
          if (!await deadHolder(reaper, reclaimSignal)) {
            signal?.throwIfAborted();
            throw new CheckoutBusyError(root);
          }
          unlinkSync(reaper);
        }
        // Publish complete, closed metadata atomically; a crash cannot leave an empty .reap file.
        try { linkSync(claim.file, reaper); reaperOwned = true; }
        catch (err) {
          if ((err as NodeJS.ErrnoException).code === "EEXIST") throw new CheckoutBusyError(root);
          throw err;
        }
        if (!await unlinkIfStillDead(file, reclaimSignal, initialText)) {
          signal?.throwIfAborted();
          throw new CheckoutBusyError(root);
        }
        try { create(); }
        catch (err) {
          if ((err as NodeJS.ErrnoException).code === "EEXIST") throw new CheckoutBusyError(root);
          throw err;
        }
      } finally {
        try { if (reaperOwned) unlinkSync(reaper); }
        finally { claim.release(); }
      }
    } catch (reclaimError) {
      if (signal?.aborted) throw signal.reason;
      if (reclaimSignal.aborted) throw new CheckoutBusyError(root);
      throw reclaimError;
    }
  }
}

/** Exclusive across this process and bridge processes. Callers pass the Git checkout root.
 * Stale-lock reclamation shares one bounded deadline (`deadlineMs`, default `PROCESS_QUERY_TIMEOUT_MS`) and respects `signal`. */
export async function acquire(
  checkoutRoot: string,
  options: { lockDirectory?: string; signal?: AbortSignal; deadlineMs?: number } = {}
): Promise<CheckoutRelease> {
  const { signal } = options;
  signal?.throwIfAborted();
  const root = canonicalCheckoutPath(checkoutRoot);
  const existing = held.get(root);
  if (acquiring.has(root) || (existing && (!existing.retained || !existing.released))) throw new CheckoutBusyError(root);
  acquiring.add(root);
  try {
    const file = checkoutLockPath(root, options.lockDirectory);
    mkdirSync(path.dirname(file), { recursive: true });
    const token = randomUUID();
    const create = () => createHolder(file, token);
    await claimFile(file, token, root, create, signal, options.deadlineMs);
    const owner = fileLease(file, token);
    const entry: HeldCheckout = { release: undefined as unknown as CheckoutRelease, retained: false, released: false };
    const releaseWithMode = (force: boolean): boolean => {
      if (held.get(root) !== entry) return true;
      if (entry.retained && !force) {
        entry.released = true;
        return true;
      }
      const ok = force ? owner.forceRelease() : owner();
      if (ok || !entry.retained) held.delete(root);
      else entry.released = true;
      return ok;
    };
    const releaseFn = (): boolean => releaseWithMode(false);
    const release = Object.assign(releaseFn, {
      checkoutRoot: root,
      forceRelease: (): boolean => releaseWithMode(true),
      retain(survivors: number[], retainOpts?: RetainOptions): boolean {
        entry.retained = true;
        return owner.retain(survivors, retainOpts);
      }
    });
    Object.defineProperty(release, "lastError", { get: () => owner.lastError, enumerable: true });
    entry.release = release as CheckoutRelease;
    held.set(root, entry);
    return release as CheckoutRelease;
  } finally {
    acquiring.delete(root);
  }
}

export function ownsCheckoutLock(release: CheckoutRelease | undefined, checkoutRoot: string): boolean {
  const entry = held.get(canonicalCheckoutPath(checkoutRoot));
  return !!release && entry?.release === release && !entry.released;
}
