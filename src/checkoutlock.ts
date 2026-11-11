import { createHash, randomUUID } from "node:crypto";
import { closeSync, mkdirSync, openSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ClineRunError } from "./runner.js";

export class CheckoutBusyError extends ClineRunError {
  constructor(public readonly checkoutRoot: string) {
    super("checkout_busy", `Checkout already has a writer: ${checkoutRoot}`, { attempts: 0 });
    this.name = "CheckoutBusyError";
  }
}

export type CheckoutRelease = (() => void) & { readonly checkoutRoot: string };
const held = new Map<string, CheckoutRelease>();

export function canonicalCheckoutPath(checkoutRoot: string): string {
  const resolved = realpathSync(checkoutRoot);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

export function checkoutLockPath(checkoutRoot: string, lockDirectory = path.join(os.homedir(), ".cline-mcp", "locks")): string {
  return path.join(lockDirectory, createHash("sha256").update(canonicalCheckoutPath(checkoutRoot)).digest("hex") + ".lock");
}

function deadHolder(file: string): boolean {
  try {
    const holder = JSON.parse(readFileSync(file, "utf8"));
    if (!Number.isSafeInteger(holder.pid) || holder.pid <= 0) return false;
    try { process.kill(holder.pid, 0); }
    catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH"; }
  } catch { /* An incomplete or unreadable lock is busy, never stale by age alone. */ }
  return false;
}

/** Exclusive across this process and bridge processes. Callers pass the Git checkout root. */
export function acquire(checkoutRoot: string, options: { lockDirectory?: string } = {}): CheckoutRelease {
  const root = canonicalCheckoutPath(checkoutRoot);
  if (held.has(root)) throw new CheckoutBusyError(root);
  const file = checkoutLockPath(root, options.lockDirectory);
  mkdirSync(path.dirname(file), { recursive: true });
  const token = randomUUID();
  const create = () => {
    const fd = openSync(file, "wx", 0o600);
    try { writeFileSync(fd, JSON.stringify({ pid: process.pid, time: new Date().toISOString(), token })); }
    catch (error) { unlinkSync(file); throw error; }
    finally { closeSync(fd); }
  };
  try { create(); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    if (!deadHolder(file)) throw new CheckoutBusyError(root);
    // Serialize reclaimers: none may unlink a newly created live lock after another reclaimed it.
    const reaper = file + ".reap";
    let fd: number;
    try { fd = openSync(reaper, "wx", 0o600); }
    catch { throw new CheckoutBusyError(root); }
    try {
      if (!deadHolder(file)) throw new CheckoutBusyError(root);
      unlinkSync(file);
      try { create(); }
      catch (err) {
        if ((err as NodeJS.ErrnoException).code === "EEXIST") throw new CheckoutBusyError(root);
        throw err;
      }
    } finally { closeSync(fd); unlinkSync(reaper); }
  }
  const release: CheckoutRelease = Object.assign(() => {
    if (held.get(root) !== release) return;
    // Do not remove a lock replaced by an external actor.
    try {
      if (JSON.parse(readFileSync(file, "utf8")).token === token) unlinkSync(file);
    } catch {
      // An externally removed/replaced lock must not turn task cleanup into an unhandled rejection.
    } finally { held.delete(root); }
  }, { checkoutRoot: root });
  held.set(root, release);
  return release;
}

export function ownsCheckoutLock(release: CheckoutRelease | undefined, checkoutRoot: string): boolean {
  return !!release && held.get(canonicalCheckoutPath(checkoutRoot)) === release;
}
