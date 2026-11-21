import { spawn } from "node:child_process";
import { PROCESS_TABLE_TIMEOUT_MS, TREE_KILL_CONFIRM_MS } from "./waits.js";

// Confirmed process-tree kill (plan S3, review item A2). A stopped run must not settle while any process
// of its tree is alive: callers restore the snapshot right after, and a living child could still write.
// Keep this file in step with openCodeHelperMcp `src/proctree.js` (same algorithm, same tests).

export interface ProcessEntry {
  pid: number;
  parentPid: number;
  /** Creation time in Unix milliseconds (0 when Windows does not report one). */
  createdMs: number;
}

export interface TreeKillResult {
  /** True when the root and every known descendant are gone and the descendant list could be read. */
  confirmed: boolean;
  /** PIDs still alive when the cap passed. */
  alive: number[];
  /** True when the process list could not be read, so orphans of the root are unknown. */
  unverified?: boolean;
}

/**
 * Clock slack between `Date.now()` around spawn/exit and the OS creation time. Limit: CreationDate is local
 * time, so in the repeated autumn DST hour a time can be off by one hour (orphans then go unrecognised).
 */
export const CREATION_SLACK_MS = 100;

/**
 * One snapshot of every process with its parent and creation time (Windows). Null when it cannot be read
 * (timeout, error, empty output) so callers never mistake "unknown" for "no descendants".
 */
export function listProcessTable(timeoutMs = PROCESS_TABLE_TIMEOUT_MS, signal?: AbortSignal): Promise<ProcessEntry[] | null> {
  if (process.platform !== "win32" || timeoutMs <= 0 || signal?.aborted) return Promise.resolve(null);
  const script = "Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,CreationDate | ForEach-Object { "
    + "$c = if ($_.CreationDate) { ([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds() } else { 0 }; "
    + "[string]$_.ProcessId + ',' + [string]$_.ParentProcessId + ',' + [string]$c }";
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
        shell: false, windowsHide: true, stdio: ["ignore", "pipe", "ignore"]
      });
    } catch { resolve(null); return; }
    let out = "";
    let done = false;
    const finish = (ok: boolean) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", stop);
      if (!ok) { resolve(null); return; }
      const entries = out.split(/\r?\n/).flatMap((line) => {
        const [pid, parentPid, createdMs] = line.trim().split(",").map(Number);
        return Number.isInteger(pid) && pid > 0 && Number.isInteger(parentPid) && parentPid >= 0 && Number.isFinite(createdMs)
          ? [{ pid, parentPid, createdMs }] : [];
      });
      resolve(entries.length > 0 ? entries : null);
    };
    const stop = () => { try { child.kill(); } catch { /* gone */ } child.stdout?.destroy(); finish(false); };
    const timer = setTimeout(stop, Math.min(PROCESS_TABLE_TIMEOUT_MS, timeoutMs));
    timer.unref?.();
    signal?.addEventListener("abort", stop, { once: true });
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => { out += chunk; });
    child.on("error", () => finish(false));
    child.on("close", (code) => finish(code === 0));
  });
}

/**
 * Descendants of our root in a snapshot, safe against PID reuse: Windows keeps a dead parent's PID in its
 * children, and that PID can belong to another process later. A child counts only when it was created after
 * its parent; a child of the root only when created between our spawn and the root's exit.
 */
export function treeDescendants(rootPid: number, table: readonly ProcessEntry[], opts: {
  rootStartedMs: number; rootExitedMs?: number; selfPid?: number;
}): number[] {
  const selfPid = opts.selfPid ?? process.pid;
  const byParent = new Map<number, ProcessEntry[]>();
  for (const entry of table) {
    if (entry.pid === selfPid || entry.pid === entry.parentPid) continue;
    const list = byParent.get(entry.parentPid);
    if (list) list.push(entry); else byParent.set(entry.parentPid, [entry]);
  }
  const earliest = opts.rootStartedMs - CREATION_SLACK_MS;
  const latest = opts.rootExitedMs === undefined ? Infinity : opts.rootExitedMs + CREATION_SLACK_MS;
  const descendants: number[] = [];
  const seen = new Set<number>([rootPid]);
  const queue: Array<{ pid: number; createdMs: number }> = [];
  for (const entry of byParent.get(rootPid) ?? []) {
    if (entry.createdMs < earliest || entry.createdMs > latest || seen.has(entry.pid)) continue;
    seen.add(entry.pid); descendants.push(entry.pid); queue.push(entry);
  }
  while (queue.length > 0) {
    const parent = queue.shift()!;
    for (const entry of byParent.get(parent.pid) ?? []) {
      if (entry.createdMs < parent.createdMs || seen.has(entry.pid)) continue;
      seen.add(entry.pid); descendants.push(entry.pid); queue.push(entry);
    }
  }
  return descendants;
}

export function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException | undefined)?.code === "EPERM"; }
}

function killOnePid(pid: number, platform: NodeJS.Platform): void {
  try {
    if (platform === "win32") {
      spawn("taskkill", ["/PID", String(pid), "/T", "/F"], { shell: false, windowsHide: true, stdio: "ignore" })
        .on("error", () => { try { process.kill(pid, "SIGKILL"); } catch { /* gone */ } });
    } else process.kill(pid, "SIGKILL");
  } catch { /* gone */ }
}

export interface ConfirmTreeDeadOptions {
  /** Kills the root's tree once (taskkill /T, or a process-group signal). Called again while the root lives. */
  killRoot: () => void;
  /** Whether the root is still running, from the child handle: after `exit` its PID may already be reused. */
  isRootAlive: () => boolean;
  /** `Date.now()` taken just before the root was spawned. */
  rootStartedMs: number;
  /** `Date.now()` when the root's `exit` was seen, if it was. */
  rootExitedMs?: () => number | undefined;
  /** POSIX: wait this long after the caller's SIGTERM before escalating to `killRoot`. */
  firstPollMs?: number;
  capMs?: number;
  now?: () => number;
  pollMs?: number;
  platform?: NodeJS.Platform;
  signal?: AbortSignal;
  listTable?: (timeoutMs: number, signal?: AbortSignal) => Promise<ProcessEntry[] | null>;
  isAlive?: (pid: number) => boolean;
  killPid?: (pid: number) => void;
}

/**
 * Wait until the root and its descendants are dead, retrying the kill every `pollMs`, bounded by `capMs`.
 * The caller sends the first kill. A descendant seen dead once is never killed again (its PID may be reused).
 */
export async function confirmTreeDead(rootPid: number, opts: ConfirmTreeDeadOptions): Promise<TreeKillResult> {
  const platform = opts.platform ?? process.platform;
  const capMs = Math.min(opts.capMs ?? TREE_KILL_CONFIRM_MS, TREE_KILL_CONFIRM_MS);
  const pollMs = opts.pollMs ?? 250;
  const isAlive = opts.isAlive ?? pidAlive;
  const killPid = opts.killPid ?? ((pid: number) => killOnePid(pid, platform));
  const now = opts.now ?? (() => performance.now());
  const deadline = now() + capMs;
  const remaining = () => opts.signal?.aborted ? 0 : Math.max(0, deadline - now());
  const pause = (ms = pollMs) => new Promise<void>(resolve => {
    const wait = Math.min(ms, remaining());
    if (opts.signal?.aborted || wait <= 0) { resolve(); return; }
    const wake = () => { clearTimeout(timer); opts.signal?.removeEventListener("abort", wake); resolve(); };
    const timer = setTimeout(wake, wait);
    opts.signal?.addEventListener("abort", wake, { once: true });
  });
  const killRoot = () => { try { opts.killRoot(); } catch { /* retried next poll */ } };

  if (platform !== "win32") {
    // The process group outlives its leader while members live, and its ID is not reused meanwhile.
    const groupAlive = () => isAlive(-rootPid);
    // Let a SIGTERM sent by the caller take effect before escalating.
    if (opts.firstPollMs && remaining() > 0) await pause(opts.firstPollMs);
    while (remaining() > 0) {
      await pause();
      if (!opts.isRootAlive() && !groupAlive()) return { confirmed: true, alive: [] };
      killRoot();
    }
    if (!opts.isRootAlive() && !groupAlive()) return { confirmed: true, alive: [] };
    return { confirmed: false, alive: [rootPid] };
  }

  const listTable = opts.listTable ?? listProcessTable;
  const known = new Set<number>();
  let tableRead = false;
  let snapshotDone = false;
  const pollReserve = Math.min(pollMs, capMs / 10);
  const readTable = async () => {
    for (let attempt = 0; attempt < 2 && !tableRead; attempt++) {
      // Share a shortened caller cap between the remaining attempts, too.
      const readMs = Math.min(PROCESS_TABLE_TIMEOUT_MS, Math.floor((remaining() - pollReserve) / (2 - attempt)));
      if (readMs <= 0) break;
      const table = await listTable(readMs, opts.signal).catch(() => null);
      if (!table) continue;
      tableRead = true;
      for (const pid of treeDescendants(rootPid, table, { rootStartedMs: opts.rootStartedMs, rootExitedMs: opts.rootExitedMs?.() })) {
        known.add(pid);
      }
    }
    snapshotDone = true;
  };
  const snapshot = readTable();
  const waitForSnapshot = () => new Promise<void>(resolve => {
    if (snapshotDone || remaining() <= 0) { resolve(); return; }
    let done = false;
    const wake = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", wake);
      resolve();
    };
    const timer = setTimeout(wake, remaining());
    opts.signal?.addEventListener("abort", wake, { once: true });
    void snapshot.then(wake);
  });
  const liveDescendants = () => {
    for (const pid of [...known]) if (!isAlive(pid)) known.delete(pid);
    return [...known];
  };

  while (remaining() > 0) {
    await pause();
    const rootAlive = opts.isRootAlive();
    const alive = liveDescendants();
    if (!rootAlive && alive.length === 0) {
      if (snapshotDone) return tableRead ? { confirmed: true, alive: [] } : { confirmed: false, alive: [], unverified: true };
      await waitForSnapshot();
      const after = liveDescendants();
      if (!opts.isRootAlive() && after.length === 0) {
        if (snapshotDone) return tableRead ? { confirmed: true, alive: [] } : { confirmed: false, alive: [], unverified: true };
        break;
      }
      if (remaining() > 0) {
        if (opts.isRootAlive()) killRoot();
        else for (const pid of after) killPid(pid);
      }
      continue;
    }
    // While the root lives its /T kill covers the tree; killing descendants by PID at the same time could hit
    // a PID that kill just freed. Orphans are killed (with their own subtree) only once the root is gone.
    if (rootAlive) killRoot();
    else for (const pid of alive) killPid(pid);
  }
  const alive = [...(opts.isRootAlive() ? [rootPid] : []), ...liveDescendants()];
  if (alive.length === 0 && !tableRead) return { confirmed: false, alive, unverified: true };
  return { confirmed: alive.length === 0, alive };
}
