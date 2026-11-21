import { spawn } from "node:child_process";
import { access, constants as fsConstants, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { defaultKillTree, redactSecrets } from "./runner.js";
import { confirmTreeDead, type TreeKillResult } from "./proctree.js";
import { createWindowsJob } from "./jobobject.js";
import { KILL_SETTLE_MS, TREE_KILL_CONFIRM_MS, settlementBudget, untilAborted } from "./waits.js";

export interface VerificationCommand { command: string; args?: string[]; timeoutSeconds?: number; }
export interface VerificationResult {
  passed: boolean;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  killedForOutput: boolean;
  durationMs: number;
  stdoutTail: string;
  stderrTail: string;
  /** False when a stopped verify process tree could not be confirmed dead (a restore may be overwritten). */
  killConfirmed?: false;
  stillAlive?: number[];
  killUnverified?: true;
}
export class VerificationError extends Error {
  constructor(public readonly kind: "verification_refused" | "verification_launch_failed", message: string) {
    super(message); this.name = "VerificationError";
  }
}
const OUTPUT_LIMIT = 1024 * 1024;
const TAIL_LIMIT = 8 * 1024;
const EXIT_GRACE_MS = 500;

export async function resolveVerificationCommand(command: string, args: string[] = [], cwd = process.cwd()): Promise<{ command: string; args: string[] }> {
  if (!command || command.includes("\0") || args.some(arg => typeof arg !== "string" || arg.includes("\0"))) {
    throw new VerificationError("verification_refused", "Verification requires a command and literal string arguments.");
  }
  // A drive-relative path (`C:npm`) names a location too; it must never fall back to the installed tool.
  const hasDirectory = command.includes("/") || command.includes("\\") || /^[A-Za-z]:/.test(command);
  const bare = !hasDirectory && !path.extname(command);
  if (process.platform !== "win32") {
    // POSIX spawns resolve through PATH; check that the target is a runnable file so directories or non-executables are refused up front.
    const found = hasDirectory ? await isRunnablePosix(path.resolve(cwd, command))
      : (await Promise.all(pathDirectories().map(dir => isRunnablePosix(path.join(dir, command))))).some(Boolean);
    if (!found) throw new VerificationError("verification_launch_failed", "Verification executable was not found on PATH.");
    return { command, args };
  }
  const npm = /^(npm|npx)(?:\.cmd)?$/i.exec(path.basename(command));
  if (npm && (!hasDirectory || await isFile(path.resolve(cwd, command)) || (!path.extname(command) && await isFile(path.resolve(cwd, command + ".cmd"))))) {
    const script = npm[1].toLowerCase() + "-cli.js";
    const candidates = [path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", script),
      ...(process.env.APPDATA ? [path.join(process.env.APPDATA, "npm", "node_modules", "npm", "bin", script)] : [])];
    for (const candidate of candidates) {
      if (await isFile(candidate)) return { command: process.execPath, args: [candidate, ...args] };
    }
    throw new VerificationError("verification_refused", "Could not resolve the npm installation's CLI script.");
  }
  if (/\.(cmd|bat)$/i.test(command)) throw new VerificationError("verification_refused", "Windows batch commands require a shell and are refused.");
  // A project-local tool (vitest, tsc, eslint...) wins, as with `npm run`: the nearest node_modules/.bin upward.
  if (bare) {
    const local = await nearestBinShim(command, cwd);
    if (local) return resolveCmdShim(local, args, 0);
  }
  // Resolve names ourselves so PATHEXT cannot silently run a batch file. As on Windows, the first PATH folder
  // that has the name wins; a global npm/corepack .cmd shim (pnpm, yarn) or explicit extensionless shim path
  // (e.g. node_modules/.bin/vitest) is parsed, never run by cmd.exe.
  const ext = path.extname(command);
  const isDirectExe = /^\.(exe|com)$/i.test(ext);
  for (const directory of hasDirectory ? [""] : pathDirectories()) {
    for (const extension of isDirectExe ? [""] : [".exe", ".com"]) {
      const candidate = path.resolve(cwd, directory, command + extension);
      if (await isFile(candidate)) return { command: candidate, args };
    }
    const shim = !ext ? path.resolve(cwd, directory, command + ".cmd") : undefined;
    if (shim && await isFile(shim)) return resolveCmdShim(shim, args, 0);
  }
  if (hasDirectory) {
    const info = await stat(path.resolve(cwd, command)).catch(() => undefined);
    if (info?.isDirectory()) throw new VerificationError("verification_refused", "Verification command refers to a directory, not an executable.");
    if (info?.isFile() && !isDirectExe) throw new VerificationError("verification_refused", "Verification command is not a runnable Windows executable.");
  }
  throw new VerificationError("verification_launch_failed", "Verification executable was not found on PATH.");
}

const exists = (file: string) => access(file).then(() => true, () => false);
const isFile = (file: string) => stat(file).then(info => info.isFile(), () => false);
const isRunnablePosix = (file: string) => stat(file).then(
  info => info.isFile() ? access(file, fsConstants.X_OK).then(() => true, () => false) : false,
  () => false
);
const pathDirectories = () => (process.env.PATH ?? "").split(path.delimiter).map(dir => dir.replace(/^"|"$/g, "")).filter(Boolean);

async function findOnPath(fileName: string, first?: string): Promise<string | undefined> {
  for (const directory of [...(first ? [first] : []), ...pathDirectories()]) {
    const candidate = path.resolve(directory, fileName);
    if (await isFile(candidate)) return candidate;
  }
  return undefined;
}

/** The nearest `node_modules/.bin/<name>.cmd` from `cwd` upward, stopping at the repository root (`.git`). */
async function nearestBinShim(name: string, cwd: string): Promise<string | undefined> {
  for (let dir = path.resolve(cwd); ; dir = path.dirname(dir)) {
    const candidate = path.join(dir, "node_modules", ".bin", name + ".cmd");
    if (await isFile(candidate)) return candidate;
    if (path.dirname(dir) === dir || await exists(path.join(dir, ".git"))) return undefined;
  }
}

// The launch line of an npm cmd-shim, in its current and older forms:
//   endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\..\vitest\vitest.mjs" %*
//   "%~dp0\node.exe"  "%~dp0\..\x\cli.js" %*      node  "%~dp0\..\x\cli.js" %*      "%dp0%\..\esbuild\esbuild.exe" %*
const SHIM_PREFIX = String.raw`^(?:endLocal & goto #_undefined_# 2>NUL \|\| title %COMSPEC% & )?@?`;
const SHIM_TARGET = String.raw`"%~?dp0%?[\\/]?([^"]+)"\s+%\*$`;
const SHIM_NODE = [
  new RegExp(SHIM_PREFIX + String.raw`"%_prog%"\s+` + SHIM_TARGET, "i"),
  new RegExp(SHIM_PREFIX + String.raw`"%~?dp0%?[\\/]?(?:[^"]*[\\/])?node(?:\.exe)?"\s+` + SHIM_TARGET, "i"),
  new RegExp(SHIM_PREFIX + String.raw`node(?:\.exe)?\s+` + SHIM_TARGET, "i")
];
const SHIM_EXE = new RegExp(SHIM_PREFIX + String.raw`"%~?dp0%?[\\/]?([^"]+\.exe)"\s+%\*$`, "i");

/**
 * Turn an npm cmd-shim (or a corepack `@corepack <tool> %*` shim) into a direct, shell-free launch: node plus
 * the JS entry, or the wrapped .exe. Anything else is a real batch file and stays refused.
 * Keep in step with openCodeHelperMcp `src/verify.js`.
 */
async function resolveCmdShim(file: string, args: string[], depth: number): Promise<{ command: string; args: string[] }> {
  const refuse = (why: string) => new VerificationError("verification_refused",
    `${file} is a batch file that cannot run without a shell (${why}); give the program directly.`);
  let text: string;
  try { text = await readFile(file, "utf8"); } catch { throw refuse("unreadable"); }
  const corepack = /^@?corepack\s+([A-Za-z0-9._-]+)\s+%\*$/i.exec(text.trim());
  if (corepack) {
    if (depth > 0) throw refuse("nested shim");
    const inner = await findOnPath("corepack.cmd", path.dirname(file));
    if (!inner) throw refuse("corepack not found");
    return resolveCmdShim(inner, [corepack[1], ...args], depth + 1);
  }
  const line = text.split(/\r?\n/).map(l => l.trim()).filter(l => /%\*$/.test(l)).pop() ?? "";
  const viaNode = SHIM_NODE.map(pattern => pattern.exec(line)).find(Boolean);
  const exe = viaNode ? undefined : SHIM_EXE.exec(line);
  const relative = viaNode?.[1] ?? exe?.[1];
  if (!relative) throw refuse("not an npm shim");
  const target = path.resolve(path.dirname(file), relative);
  if (!await isFile(target)) throw refuse(`its target ${target} does not exist`);
  return viaNode ? { command: process.execPath, args: [target, ...args] } : { command: target, args };
}

const EMPTY_CHUNK = Buffer.alloc(0);
interface RollingBuffer { chunks: Buffer[]; head: number; bytes: number; }

function appendRolling(stream: RollingBuffer, chunk: Buffer): void {
  if (!chunk.length) return;
  if (chunk.length >= OUTPUT_LIMIT) {
    stream.chunks = [chunk.length === OUTPUT_LIMIT ? chunk : Buffer.from(chunk.subarray(chunk.length - OUTPUT_LIMIT))];
    stream.head = 0;
    stream.bytes = OUTPUT_LIMIT;
    return;
  }
  stream.chunks.push(chunk);
  stream.bytes += chunk.length;
  while (stream.bytes > OUTPUT_LIMIT && stream.head < stream.chunks.length) {
    const excess = stream.bytes - OUTPUT_LIMIT;
    const first = stream.chunks[stream.head];
    if (first.length <= excess) {
      stream.chunks[stream.head] = EMPTY_CHUNK;
      stream.head++;
      stream.bytes -= first.length;
    } else {
      stream.chunks[stream.head] = first.subarray(excess);
      stream.bytes -= excess;
    }
  }
  if (stream.head > 64 && stream.head * 2 >= stream.chunks.length) {
    stream.chunks = stream.chunks.slice(stream.head);
    stream.head = 0;
  }
}

function tail(chunks: Buffer[]): string {
  const redacted = Buffer.from(redactSecrets(Buffer.concat(chunks).toString("utf8")), "utf8");
  let start = Math.max(0, redacted.length - TAIL_LIMIT);
  // Do not start inside a UTF-8 code point (replacement characters could exceed the byte budget).
  while (start < redacted.length && (redacted[start] & 0xc0) === 0x80) start++;
  return redacted.subarray(start).toString("utf8");
}

export async function runVerification(spec: VerificationCommand, cwd: string, signal?: AbortSignal,
  deps: { createWindowsJob?: typeof createWindowsJob; confirmTreeDead?: typeof confirmTreeDead; remainingMs?: number; now?: () => number } = {}): Promise<VerificationResult> {
  const timeout = spec.timeoutSeconds ?? 60;
  if (!Number.isInteger(timeout) || timeout < 1 || timeout > 300) throw new VerificationError("verification_refused", "Verification timeout must be 1-300 seconds.");
  const now = deps.now ?? (() => performance.now());
  const started = now();
  const workMs = Math.max(0, Math.min(timeout * 1000, deps.remainingMs ?? Infinity));
  const remaining = () => Math.max(0, started + workMs - now());
  // Both the command timeout and the enclosing edit limit this check, including settlement.
  const budget = settlementBudget(workMs, signal, now);
  try { return await run(); } finally { budget.dispose(); }

  async function run(): Promise<VerificationResult> {
    let executable: { command: string; args: string[] };
    try { executable = await untilAborted(resolveVerificationCommand(spec.command, spec.args, cwd), budget.signal); }
    catch (error) {
      if (error instanceof VerificationError) throw error;
      if (!budget.signal.aborted && !signal?.aborted) throw error;
      return { passed: false, exitCode: null, signal: "SIGKILL", timedOut: !signal?.aborted,
        killedForOutput: false, durationMs: now() - started, stdoutTail: "", stderrTail: "" };
    }
    const job = process.platform === "win32" && remaining() > 0
      ? await (deps.createWindowsJob ?? createWindowsJob)(remaining(), signal) : undefined;
    const closeJob = () => job?.close(budget.remaining(), budget.signal);
    if (signal?.aborted || remaining() <= 0) {
      await closeJob();
      return { passed: false, exitCode: null, signal: "SIGKILL", timedOut: !signal?.aborted,
        killedForOutput: false, durationMs: now() - started, stdoutTail: "", stderrTail: "" };
    }
    return await new Promise<VerificationResult>((resolve, reject) => {
      const rootStartedMs = Date.now();
      const child = spawn(executable.command, executable.args, {
        cwd: path.resolve(cwd), shell: false, windowsHide: true, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"]
      });
      job?.assign(child);
      const pid = child.pid;
      const stdout: RollingBuffer = { chunks: [], head: 0, bytes: 0 };
      const stderr: RollingBuffer = { chunks: [], head: 0, bytes: 0 };
      let timedOut = false, cancelled = false, done = false, stopped = false;
      let killDeadline: ReturnType<typeof setTimeout> | undefined, exitGrace: ReturnType<typeof setTimeout> | undefined;
      // The verify tree must be confirmed dead before the result returns: a restore can follow.
      let confirm: Promise<TreeKillResult> | undefined;
      let jobWasAssigned = false;
      // Set when the root exited but something kept its pipes open: a likely survivor, so an unreadable process
      // table must fail the check (S3b). Pipes that closed normally are not such evidence (plan S18 review).
      let pipesHeldOpen = false;
      let exitedAt: number | undefined;
      const rootAlive = () => exitedAt === undefined && child.exitCode === null && child.signalCode === null;
      const confirmWithTable = (pid: number) => untilAborted((deps.confirmTreeDead ?? confirmTreeDead)(pid, {
        capMs: Math.min(TREE_KILL_CONFIRM_MS, budget.confirmRemaining()), now, signal: budget.confirmSignal,
        killRoot: () => defaultKillTree(pid), isRootAlive: rootAlive, rootStartedMs, rootExitedMs: () => exitedAt
      }), budget.confirmSignal).catch(() => ({ confirmed: false, alive: rootAlive() ? [pid] : [], unverified: true }));
      const confirmKill = (pid: number): Promise<TreeKillResult> => {
        if (job) {
          return (async () => {
            const confirmed = (await job.close(budget.remaining(), budget.signal)) === true || job.confirmed === true;
            if (confirmed) return { confirmed: true, alive: [] };
            return confirmWithTable(pid);
          })();
        }
        return confirmWithTable(pid);
      };
      const destroyPipes = () => { child.stdout.destroy(); child.stderr.destroy(); };
      const forceStop = () => {
        if (rootAlive()) { try { child.kill("SIGKILL"); } catch { /* confirmation reports the failure */ } }
        finish(null, "SIGKILL");
        destroyPipes();
      };
      const stop = () => {
        if (done || stopped) return;
        stopped = true;
        clearTimeout(timer);
        clearTimeout(exitGrace);
        if (pid) confirm = confirmKill(pid);
        else void closeJob();
        // Settle even if an inherited pipe or OS kill failure prevents a close event.
        killDeadline = setTimeout(forceStop, Math.min(KILL_SETTLE_MS, budget.remaining()));
        budget.signal.addEventListener("abort", forceStop, { once: true });
        // After exit the root PID may already belong to another process.
        if (pid && rootAlive()) defaultKillTree(pid);
      };
      const timer = setTimeout(() => { timedOut = true; stop(); }, remaining());
      const abort = () => {
        if (remaining() <= 0) timedOut = true;
        else cancelled = true;
        stop();
      };
      const cleanup = () => {
        clearTimeout(timer); clearTimeout(exitGrace); clearTimeout(killDeadline);
        signal?.removeEventListener("abort", abort);
        budget.signal.removeEventListener("abort", forceStop);
      };
      const finish = (exitCode: number | null, exitSignal: NodeJS.Signals | null) => {
        if (done) return;
        done = true; cleanup();
        // A check that ended by itself fails the tree check only on a real survivor: an unreadable process table alone
        // must not turn a passing check into a failure (plan S18 review). A stopped check needs a confirmed kill.
        const ended = () => !stopped && !timedOut && !cancelled && !signal?.aborted;
        const unsafe = (kill?: TreeKillResult): kill is TreeKillResult => !!kill && !kill.confirmed && (!ended() || pipesHeldOpen || kill.alive.length > 0);
        const settle = (kill?: TreeKillResult) => resolve({ passed: exitCode === 0 && ended() && !exitSignal && !unsafe(kill),
          exitCode, signal: exitSignal ?? (cancelled || signal?.aborted ? "SIGKILL" : null), timedOut, killedForOutput: false,
          durationMs: now() - started, stdoutTail: tail(stdout.chunks.slice(stdout.head)), stderrTail: tail(stderr.chunks.slice(stderr.head)),
          ...(unsafe(kill) ? { killConfirmed: false as const, stillAlive: kill.alive, ...(kill.unverified ? { killUnverified: true as const } : {}) } : {}) });
        if (confirm) void confirm.then(settle); else settle();
      };
      const collect = (chunk: Buffer, stream: RollingBuffer) => {
        if (done) return;
        // Keep a bounded 1 MiB rolling window per stream before redacting and cutting the final 8 KiB tail.
        appendRolling(stream, chunk);
      };
      child.stdout.on("data", (chunk: Buffer) => collect(chunk, stdout));
      child.stderr.on("data", (chunk: Buffer) => collect(chunk, stderr));
      child.once("error", () => {
        if (done) return;
        if (stopped) { finish(null, "SIGKILL"); destroyPipes(); return; }
        done = true; cleanup();
        reject(new VerificationError("verification_launch_failed", "Could not launch verification executable."));
      });
      child.once("exit", (code, sig) => {
        exitedAt = Date.now();
        // Closing the job clears `assigned`; remember it first so `close` does not run a needless tree check.
        if (job?.assigned) jobWasAssigned = true;
        void closeJob();
        if (done || stopped || !pid) return;
        clearTimeout(timer);
        // A child outside the job can keep the pipes open after the root exits.
        // Give exitGrace its full window inside the settle margin even if the check exited right at its work deadline.
        exitGrace = setTimeout(() => {
          pipesHeldOpen = true;
          confirm = confirmKill(pid);
          finish(code, sig);
          destroyPipes();
        }, Math.min(EXIT_GRACE_MS, budget.remaining()));
      });
      child.once("close", (code, sig) => {
        // Closed pipes do not prove all descendants exited. Without an assigned job, await the tree check.
        if (!done && !stopped && !confirm && !jobWasAssigned && !job?.assigned && pid) confirm = confirmWithTable(pid);
        if (stopped) finish(null, "SIGKILL");
        else finish(code, sig);
      });
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
    }).finally(closeJob);
  }
}
