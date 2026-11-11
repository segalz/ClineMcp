import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import path from "node:path";
import { defaultKillTree, redactSecrets } from "./runner.js";

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
}
export class VerificationError extends Error {
  constructor(public readonly kind: "verification_refused" | "verification_launch_failed", message: string) {
    super(message); this.name = "VerificationError";
  }
}
const OUTPUT_LIMIT = 1024 * 1024;
const TAIL_LIMIT = 8 * 1024;

export async function resolveVerificationCommand(command: string, args: string[] = [], cwd = process.cwd()): Promise<{ command: string; args: string[] }> {
  if (!command || command.includes("\0") || args.some(arg => typeof arg !== "string" || arg.includes("\0"))) {
    throw new VerificationError("verification_refused", "Verification requires a command and literal string arguments.");
  }
  if (process.platform !== "win32") return { command, args };
  const npm = /^(npm|npx)(?:\.cmd)?$/i.exec(path.basename(command));
  if (npm) {
    const script = npm[1].toLowerCase() + "-cli.js";
    const candidates = [path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", script),
      ...(process.env.APPDATA ? [path.join(process.env.APPDATA, "npm", "node_modules", "npm", "bin", script)] : [])];
    for (const candidate of candidates) {
      try { await access(candidate); return { command: process.execPath, args: [candidate, ...args] }; }
      catch { /* Try the next supported npm installation. */ }
    }
    throw new VerificationError("verification_refused", "Could not resolve the npm installation's CLI script.");
  }
  if (/\.(cmd|bat)$/i.test(command)) throw new VerificationError("verification_refused", "Windows batch commands require a shell and are refused.");
  // Resolve plain executable names ourselves so PATHEXT cannot silently select a batch shim.
  const hasDirectory = command.includes("/") || command.includes("\\");
  const directories = hasDirectory ? [""] : (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
  const extensions = path.extname(command) ? [""] : [".exe", ".com"];
  for (const directory of directories) for (const extension of extensions) {
    const candidate = path.resolve(cwd, directory.replace(/^"|"$/g, ""), command + extension);
    try { await access(candidate); return { command: candidate, args }; }
    catch { /* Continue PATH search. */ }
  }
  throw new VerificationError("verification_launch_failed", "Verification executable was not found on PATH.");
}

function tail(chunks: Buffer[]): string {
  const redacted = Buffer.from(redactSecrets(Buffer.concat(chunks).toString("utf8")), "utf8");
  let start = Math.max(0, redacted.length - TAIL_LIMIT);
  // Do not start inside a UTF-8 code point (replacement characters could exceed the byte budget).
  while (start < redacted.length && (redacted[start] & 0xc0) === 0x80) start++;
  return redacted.subarray(start).toString("utf8");
}

export async function runVerification(spec: VerificationCommand, cwd: string, signal?: AbortSignal): Promise<VerificationResult> {
  const timeout = spec.timeoutSeconds ?? 60;
  if (!Number.isInteger(timeout) || timeout < 1 || timeout > 300) throw new VerificationError("verification_refused", "Verification timeout must be 1-300 seconds.");
  const started = performance.now();
  const executable = await resolveVerificationCommand(spec.command, spec.args, cwd);
  if (signal?.aborted) return { passed: false, exitCode: null, signal: "SIGKILL", timedOut: false,
    killedForOutput: false, durationMs: performance.now() - started, stdoutTail: "", stderrTail: "" };
  return new Promise((resolve, reject) => {
    const child = spawn(executable.command, executable.args, {
      cwd: path.resolve(cwd), shell: false, windowsHide: true, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"]
    });
    const stdout: Buffer[] = [], stderr: Buffer[] = [];
    let bytes = 0, timedOut = false, killedForOutput = false, cancelled = false, done = false;
    let killDeadline: ReturnType<typeof setTimeout> | undefined;
    const stop = () => {
      if (done || killDeadline) return;
      if (child.pid) defaultKillTree(child.pid);
      // Settle even if an inherited pipe or OS kill failure prevents a close event.
      killDeadline = setTimeout(() => {
        child.kill("SIGKILL");
        child.stdout.destroy(); child.stderr.destroy();
        finish(null, "SIGKILL");
      }, 5000);
    };
    const timer = setTimeout(() => { timedOut = true; stop(); }, timeout * 1000);
    const abort = () => { cancelled = true; stop(); };
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    const cleanup = () => { clearTimeout(timer); clearTimeout(killDeadline); signal?.removeEventListener("abort", abort); };
    const finish = (exitCode: number | null, exitSignal: NodeJS.Signals | null) => {
      if (done) return;
      done = true; cleanup();
      resolve({ passed: exitCode === 0 && !timedOut && !killedForOutput && !cancelled && !exitSignal,
        exitCode, signal: exitSignal ?? (cancelled ? "SIGKILL" : null), timedOut, killedForOutput,
        durationMs: performance.now() - started, stdoutTail: tail(stdout), stderrTail: tail(stderr) });
    };
    const collect = (chunk: Buffer, chunks: Buffer[]) => {
      if (done || killedForOutput) return;
      // Keep a bounded redaction context before cutting the final 8 KiB tails.
      const remaining = Math.max(0, OUTPUT_LIMIT + 1 - bytes);
      chunks.push(chunk.subarray(0, remaining));
      bytes += chunk.length;
      if (bytes > OUTPUT_LIMIT) { killedForOutput = true; stop(); }
    };
    child.stdout.on("data", (chunk: Buffer) => collect(chunk, stdout));
    child.stderr.on("data", (chunk: Buffer) => collect(chunk, stderr));
    child.once("error", () => {
      if (done) return;
      done = true; cleanup();
      reject(new VerificationError("verification_launch_failed", "Could not launch verification executable."));
    });
    child.once("close", finish);
  });
}
