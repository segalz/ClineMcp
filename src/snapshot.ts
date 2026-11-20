import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readdir, readFile, readlink, realpath, rename, rm, rmdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { defaultKillTree } from "./runner.js";

export type SnapshotErrorKind = "snapshot_limit" | "snapshot_unsupported" | "snapshot_git_failed" | "snapshot_invalid";
export class SnapshotError extends Error {
  constructor(public readonly kind: SnapshotErrorKind, message: string) { super(message); this.name = "SnapshotError"; }
}
export interface SnapshotEntry { path: string; size: number; sha256: string; }
export interface SnapshotSpecialEntry { path: string; kind: "symlink" | "submodule"; state: string; }
export interface SnapshotHandle {
  checkoutRoot: string; directory: string; manifest: SnapshotEntry[];
  /** Tracked symlinks (120000) and submodules (160000) recorded at snapshot time, never rewritten on restore. */
  specialEntries?: SnapshotSpecialEntry[];
  /** Ignored paths at snapshot time ("dir/" for a whole ignored folder): finds a self-ignoring .gitignore the model added. */
  ignoredEntries?: string[];
  /** The repository's info/exclude at snapshot time (base64, null when absent). */
  excludeFile?: { path: string; content: string | null };
}
export interface SnapshotOptions {
  /** Parent directory outside the checkout. Limits can only be lowered. */
  snapshotBase?: string;
  maxFiles?: number;
  maxFileBytes?: number;
  maxTotalBytes?: number;
  signal?: AbortSignal;
}
export interface RestoreReport { restored: string[]; removed: string[]; failed: { path: string; error: string }[]; }
const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const missing = (err: unknown) => (err as NodeJS.ErrnoException).code === "ENOENT";

/** All Git operations are read-only, bounded in time and aggregate output, and do not refresh the index. */
async function git(root: string, args: string[], signal?: AbortSignal, input?: string, allowedCodes = [0]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.platform === "win32" ? "git.exe" : "git", ["-C", root, ...args], {
      shell: false, windowsHide: true, detached: process.platform !== "win32", stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" }
    });
    const chunks: Buffer[] = [];
    let bytes = 0;
    let failure: Error | undefined;
    let killDeadline: ReturnType<typeof setTimeout> | undefined;
    const stop = () => {
      if (failure) return;
      failure = new SnapshotError("snapshot_git_failed", "Snapshot Git call cancelled or exceeded its time/output bound.");
      if (child.pid) defaultKillTree(child.pid);
      // Killing trees may be denied by the host. Do not leave a Git call or inherited pipe unbounded.
      killDeadline = setTimeout(() => {
        child.kill("SIGKILL"); child.stdout.destroy(); child.stderr.destroy();
        cleanup(); reject(failure);
      }, 5000);
    };
    const timer = setTimeout(stop, 10_000);
    const abort = () => stop();
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) stop();
    child.stdin.on("error", () => {});
    child.stdin.end(input);
    const collect = (chunk: Buffer, stdout: boolean) => {
      bytes += chunk.length;
      if (bytes > 16 * 1024 * 1024) stop();
      else if (stdout) chunks.push(chunk);
    };
    child.stdout.on("data", (chunk: Buffer) => collect(chunk, true));
    child.stderr.on("data", (chunk: Buffer) => collect(chunk, false));
    const cleanup = () => { clearTimeout(timer); clearTimeout(killDeadline); signal?.removeEventListener("abort", abort); };
    child.on("error", () => { cleanup(); reject(new SnapshotError("snapshot_git_failed", "Could not launch Git.")); });
    child.on("close", code => {
      cleanup();
      if (failure) reject(failure);
      else if (code === null || !allowedCodes.includes(code)) reject(new SnapshotError("snapshot_git_failed", `Git ${args[0]} failed.`));
      else resolve(Buffer.concat(chunks));
    });
  });
}

function relativePath(root: string, file: string): string {
  const parts = file.split("/");
  if (!file || parts.some(p => !p || p === "." || p === ".." || p.toLowerCase() === ".git") ||
      file.includes("\\") || file.includes("\0") || path.isAbsolute(file) ||
      (process.platform === "win32" && parts.some(p => /[:]|[. ]$|^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p)))) {
    throw new SnapshotError("snapshot_unsupported", `Unsafe snapshot path: ${file}`);
  }
  return path.join(root, ...parts);
}

async function statOrMissing(file: string) {
  try { return await lstat(file); } catch (err) { if (missing(err)) return undefined; throw err; }
}

/** Never follow a checkout link (including Windows junctions) or enter a nested repository. */
async function safeFile(root: string, file: string) {
  const absolute = relativePath(root, file);
  let current = root;
  for (const part of file.split("/")) {
    current = path.join(current, part);
    const stat = await statOrMissing(current);
    if (!stat) return undefined;
    if (stat.isSymbolicLink()) throw new SnapshotError("snapshot_unsupported", `Symlink/reparse point refused: ${file}`);
    const resolved = await realpath(current);
    if (path.resolve(resolved).toLowerCase() !== path.resolve(current).toLowerCase()) {
      throw new SnapshotError("snapshot_unsupported", `Reparse point refused: ${file}`);
    }
    if (stat.isDirectory() && await statOrMissing(path.join(current, ".git"))) {
      throw new SnapshotError("snapshot_unsupported", `Nested repository refused: ${file}`);
    }
    if (current === absolute) return stat;
    if (!stat.isDirectory()) throw new SnapshotError("snapshot_unsupported", `Non-directory ancestor: ${file}`);
  }
}

/** Walk all ancestor directories of `file`, refusing links/reparse points, nested repos, and non-directories. False when an ancestor is missing. */
async function safeAncestors(root: string, file: string): Promise<boolean> {
  relativePath(root, file);
  const parts = file.split("/");
  let current = root;
  for (let i = 0; i < parts.length - 1; i++) {
    current = path.join(current, parts[i]);
    const stat = await statOrMissing(current);
    if (!stat) return false;
    if (stat.isSymbolicLink()) throw new SnapshotError("snapshot_unsupported", `Symlink/reparse point refused: ${file}`);
    const resolved = await realpath(current);
    if (path.resolve(resolved).toLowerCase() !== path.resolve(current).toLowerCase()) {
      throw new SnapshotError("snapshot_unsupported", `Reparse point refused: ${file}`);
    }
    if (stat.isDirectory() && await statOrMissing(path.join(current, ".git"))) {
      throw new SnapshotError("snapshot_unsupported", `Nested repository refused: ${file}`);
    }
    if (!stat.isDirectory()) throw new SnapshotError("snapshot_unsupported", `Non-directory ancestor: ${file}`);
  }
  return true;
}

const MAX_SYMLINK_PLACEHOLDER_BYTES = 1024 * 1024;

async function specialState(root: string, file: string, kind: "symlink" | "submodule", signal?: AbortSignal, checkBaseline = false): Promise<string> {
  const absolute = relativePath(root, file);
  if (!await safeAncestors(root, file)) return "missing";
  const stat = await statOrMissing(absolute);
  if (!stat) return "missing";
  if (kind === "symlink") {
    if (stat.isSymbolicLink()) {
      const target = await readlink(absolute);
      if (checkBaseline) {
        const rel = path.relative(root, path.resolve(path.dirname(absolute), target));
        if (rel === ".." || rel.startsWith(".." + path.sep) || path.isAbsolute(rel)) {
          throw new SnapshotError("snapshot_unsupported", `Tracked symlink target escapes checkout: ${file}`);
        }
      }
      return `link:${target}`;
    }
    if (stat.isFile()) {
      if (stat.size > MAX_SYMLINK_PLACEHOLDER_BYTES) return `file-large:${stat.size}`;
      return `file:${hash(await readFile(absolute, { signal }))}`;
    }
    return "other";
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) return "other";
  const resolved = await realpath(absolute);
  if (path.resolve(resolved).toLowerCase() !== path.resolve(absolute).toLowerCase()) return "other";
  if (await statOrMissing(path.join(absolute, ".git"))) {
    const head = (await git(absolute, ["rev-parse", "HEAD"], signal)).toString("utf8").trim();
    const status = await git(absolute, ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignore-submodules=none"], signal);
    if (checkBaseline && status.length > 0) {
      throw new SnapshotError("snapshot_unsupported", `Dirty submodule baseline refused: ${file}`);
    }
    return `repo:${head}:${hash(status)}`;
  }
  const names = (await readdir(absolute)).sort();
  if (checkBaseline && names.length > 0) {
    throw new SnapshotError("snapshot_unsupported", `Non-empty uninitialized submodule refused: ${file}`);
  }
  return `dir:${JSON.stringify(names)}`;
}

function isUnderSpecial(file: string, specials: readonly { path: string; kind: "symlink" | "submodule" }[]): boolean {
  if (!specials.length) return false;
  const normalized = file.endsWith("/") ? file.slice(0, -1) : file;
  return specials.some(entry => normalized === entry.path || normalized.startsWith(entry.path + "/"));
}

async function files(root: string, signal?: AbortSignal): Promise<{ regular: string[]; special: { path: string; kind: "symlink" | "submodule" }[]; conflictedSpecial?: string }> {
  const stages = (await git(root, ["ls-files", "--stage", "-z"], signal)).toString("utf8").split("\0");
  const specialMap = new Map<string, "symlink" | "submodule">();
  const regularStaged = new Set<string>();
  let conflictedSpecial: string | undefined;
  for (const line of stages) {
    const tab = line.indexOf("\t");
    if (tab === -1) continue;
    const meta = line.slice(0, tab).split(" ");
    const mode = meta[0];
    const stage = meta[2];
    const file = line.slice(tab + 1);
    if (!file) continue;
    if (mode === "120000" || mode === "160000") {
      if (stage !== "0") conflictedSpecial ??= file;
      const kind = mode === "120000" ? "symlink" : "submodule";
      const prev = specialMap.get(file);
      if (prev && prev !== kind) conflictedSpecial ??= file;
      specialMap.set(file, kind);
    } else {
      regularStaged.add(file);
    }
  }
  for (const file of specialMap.keys()) {
    if (regularStaged.has(file)) conflictedSpecial ??= file;
  }
  const special = [...specialMap.entries()].map(([file, kind]) => ({ path: file, kind }))
    .sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  const regular = [...new Set((await git(root, ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], signal))
    .toString("utf8").split("\0").filter(file => Boolean(file) && !isUnderSpecial(file, special)))].sort();
  return { regular, special, conflictedSpecial };
}

/** Ignored paths, with ignored folders collapsed to one "dir/" entry (cheap even with node_modules). */
async function ignoredEntries(root: string, signal?: AbortSignal): Promise<string[]> {
  return [...new Set((await git(root, ["ls-files", "-z", "--others", "--ignored", "--exclude-standard", "--directory"], signal))
    .toString("utf8").split("\0").filter(Boolean))].sort();
}

async function excludeFile(root: string, signal?: AbortSignal): Promise<{ path: string; content: string | null }> {
  const file = path.resolve(root, (await git(root, ["rev-parse", "--git-path", "info/exclude"], signal)).toString("utf8").trim());
  try { return { path: file, content: (await readFile(file)).toString("base64") }; }
  catch (err) { if (missing(err)) return { path: file, content: null }; throw err; }
}

async function checkout(root: string): Promise<string> {
  const stat = await lstat(path.resolve(root));
  if (stat.isSymbolicLink()) throw new SnapshotError("snapshot_unsupported", "Checkout root is a symlink/reparse point.");
  const resolved = await realpath(root);
  const top = (await git(resolved, ["rev-parse", "--show-toplevel"])).toString("utf8").trim();
  const normalize = (value: string) => process.platform === "win32" ? path.normalize(value).toLowerCase() : path.normalize(value);
  if (normalize(await realpath(top)) !== normalize(resolved)) throw new SnapshotError("snapshot_invalid", "Expected the checkout root.");
  return resolved;
}

function limit(value: number | undefined, maximum: number): number {
  if (value === undefined) return maximum;
  if (!Number.isSafeInteger(value) || value < 0 || value > maximum) throw new SnapshotError("snapshot_invalid", "Invalid snapshot limit.");
  return value;
}

export async function takeSnapshot(checkoutRoot: string, opts: SnapshotOptions = {}): Promise<SnapshotHandle> {
  const root = await checkout(checkoutRoot);
  const maxFiles = limit(opts.maxFiles, 20_000);
  const maxFile = limit(opts.maxFileBytes, 64 * 1024 * 1024);
  const maxTotal = limit(opts.maxTotalBytes, 512 * 1024 * 1024);
  const envSnapshotDir = process.env.CLINE_MCP_SNAPSHOT_DIR?.trim();
  const base = path.resolve(opts.snapshotBase ?? (envSnapshotDir || path.join(os.tmpdir(), "cline-mcp-snapshots")));
  // Resolve the closest existing ancestor too: a symlinked base must not lead back into the checkout.
  let ancestor = base;
  while (!await statOrMissing(ancestor)) ancestor = path.dirname(ancestor);
  const resolvedBase = path.resolve(await realpath(ancestor), path.relative(ancestor, base));
  const relative = path.relative(root, resolvedBase);
  if (!relative || (!relative.startsWith(".." + path.sep) && relative !== ".." && !path.isAbsolute(relative))) {
    throw new SnapshotError("snapshot_invalid", "Snapshot storage must be outside the checkout.");
  }
  const { regular: candidates, special, conflictedSpecial } = await files(root, opts.signal);
  if (conflictedSpecial !== undefined) {
    throw new SnapshotError("snapshot_unsupported", `Conflicted tracked symlink/submodule refused: ${conflictedSpecial}`);
  }
  const specialLower = new Map<string, string>();
  for (const entry of special) {
    const lower = entry.path.toLowerCase();
    const existing = specialLower.get(lower);
    if (existing !== undefined && existing !== entry.path) {
      throw new SnapshotError("snapshot_unsupported", `Special entry collides case-insensitively with ${existing}: ${entry.path}`);
    }
    specialLower.set(lower, entry.path);
  }
  if (specialLower.size) {
    for (const file of candidates) {
      const normalized = file.endsWith("/") ? file.slice(0, -1) : file;
      let prefix = "";
      for (const part of normalized.split("/")) {
        prefix = prefix ? `${prefix}/${part}` : part;
        const match = specialLower.get(prefix.toLowerCase());
        if (match !== undefined && match !== prefix) {
          throw new SnapshotError("snapshot_unsupported", `Path collides case-insensitively with tracked special entry ${match}: ${file}`);
        }
      }
    }
  }
  const specialEntries: SnapshotSpecialEntry[] = [];
  for (const entry of special) {
    specialEntries.push({ path: entry.path, kind: entry.kind, state: await specialState(root, entry.path, entry.kind, opts.signal, true) });
  }
  const entries: { path: string; size: number }[] = [];
  let total = 0;
  for (const file of candidates) {
    // Git reports an untracked nested repository with a trailing slash.
    const normalized = file.endsWith("/") ? file.slice(0, -1) : file;
    const stat = await safeFile(root, normalized);
    if (!stat) continue; // A tracked deletion is an absent baseline file.
    if (!stat.isFile()) throw new SnapshotError("snapshot_unsupported", `Non-regular file refused: ${file}`);
    total += stat.size;
    entries.push({ path: file, size: stat.size });
    if (entries.length > maxFiles || stat.size > maxFile || total > maxTotal) {
      throw new SnapshotError("snapshot_limit", "Snapshot file count or byte limit exceeded.");
    }
  }
  // Read all bytes before writing anything: even growth between stat and read cannot leave a partial snapshot on refusal.
  const content: Buffer[] = [];
  total = 0;
  for (const entry of entries) {
    await safeFile(root, entry.path);
    const bytes = await readFile(relativePath(root, entry.path), { signal: opts.signal });
    total += bytes.length;
    if (bytes.length > maxFile || total > maxTotal) throw new SnapshotError("snapshot_limit", "Snapshot byte limit exceeded during read.");
    content.push(bytes);
  }
  const directory = path.join(resolvedBase, randomUUID());
  const handle: SnapshotHandle = { checkoutRoot: root, directory, manifest: entries.map((entry, i) => ({ path: entry.path, size: content[i].length, sha256: hash(content[i]) })),
    specialEntries, ignoredEntries: await ignoredEntries(root, opts.signal), excludeFile: await excludeFile(root, opts.signal) };
  try {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    for (let i = 0; i < content.length; i++) await writeFile(path.join(directory, String(i)), content[i], { flag: "wx", mode: 0o600 });
    await writeFile(path.join(directory, "manifest.json"), JSON.stringify(handle), { flag: "wx", mode: 0o600 });
    return handle;
  } catch (err) { await rm(directory, { recursive: true, force: true }); throw err; }
}

/** Restore one baseline file in place; true when it had to be rewritten. */
async function restoreEntry(root: string, handle: SnapshotHandle, i: number): Promise<boolean> {
  const entry = handle.manifest[i];
  const bytes = await readFile(path.join(handle.directory, String(i)));
  if (bytes.length !== entry.size || hash(bytes) !== entry.sha256) throw new SnapshotError("snapshot_invalid", "Snapshot bytes failed integrity check.");
  const stat = await safeFile(root, entry.path);
  const absolute = relativePath(root, entry.path);
  if (stat?.isFile() && hash(await readFile(absolute)) === entry.sha256) return false;
  if (stat?.isDirectory()) await rmdir(absolute); // Only an empty replacement directory is safe to remove.
  else if (stat && !stat.isFile()) throw new SnapshotError("snapshot_unsupported", "Baseline path is no longer a regular file.");
  await mkdir(path.dirname(absolute), { recursive: true });
  // Replace instead of writing through a hard link to another (possibly ignored) path.
  const temporary = path.join(path.dirname(absolute), `.cline-restore-${randomUUID()}`);
  try {
    await writeFile(temporary, bytes, { flag: "wx" });
    await rename(temporary, absolute);
  } finally { await rm(temporary, { force: true }); }
  return true;
}

const isIgnoreFile = (file: string) => file === ".gitignore" || file.endsWith("/.gitignore");

export async function restoreSnapshot(handle: SnapshotHandle): Promise<RestoreReport> {
  const root = await checkout(handle.checkoutRoot);
  const report: RestoreReport = { restored: [], removed: [], failed: [] };
  const baseline = new Set(handle.manifest.map(entry => entry.path));
  const specials = handle.specialEntries ?? [];
  const prune = async (dir: string) => {
    while (dir !== root) {
      try { await rmdir(dir); } catch { break; } // Never recursively remove directories or ignored content.
      dir = path.dirname(dir);
    }
  };
  const remove = async (file: string) => {
    try {
      const stat = await safeFile(root, file);
      if (!stat) return;
      if (!stat.isFile()) throw new SnapshotError("snapshot_unsupported", `Non-regular file refused: ${file}`);
      const absolute = relativePath(root, file);
      await rm(absolute);
      report.removed.push(file);
      await prune(path.dirname(absolute));
    } catch (err) { report.failed.push({ path: file, error: (err as Error).message }); }
  };
  // Ignore rules first: a rule the model added must not hide its new files from removal,
  // and must not make a baseline file look "newly ignored" and stay changed.
  const ignoreDone = new Set<number>();
  for (let i = 0; i < handle.manifest.length; i++) {
    if (!isIgnoreFile(handle.manifest[i].path)) continue;
    ignoreDone.add(i);
    try { if (await restoreEntry(root, handle, i)) report.restored.push(handle.manifest[i].path); }
    catch (err) { report.failed.push({ path: handle.manifest[i].path, error: (err as Error).message }); }
  }
  if (handle.ignoredEntries) {
    // Remove .gitignore files the model created: visible ones, and self-ignoring ones found through
    // ignored entries that did not exist at snapshot time. Repeat for nested ones, a bounded number of times.
    const known = new Set(handle.ignoredEntries);
    for (let round = 0; round < 5; round++) {
      const candidates = new Set((await files(root)).regular.filter(file => isIgnoreFile(file) && !baseline.has(file) && !isUnderSpecial(file, specials)));
      for (const entry of await ignoredEntries(root)) {
        if (known.has(entry)) continue;
        const file = entry.endsWith("/") ? `${entry}.gitignore` : entry;
        if (isIgnoreFile(file) && !baseline.has(file) && !isUnderSpecial(file, specials) && await statOrMissing(relativePath(root, file)).catch(() => undefined)) candidates.add(file);
      }
      if (!candidates.size) break;
      const before = report.removed.length;
      for (const file of candidates) await remove(file);
      if (report.removed.length === before) break;
    }
  }
  if (handle.excludeFile) {
    const { path: file, content } = handle.excludeFile;
    try {
      const now = await readFile(file).then(b => b.toString("base64"), err => { if (missing(err)) return null; throw err; });
      if (now !== content) {
        if (content === null) await rm(file, { force: true });
        else await writeFile(file, Buffer.from(content, "base64"));
        report.restored.push("info/exclude");
      }
    } catch (err) { report.failed.push({ path: "info/exclude", error: (err as Error).message }); }
  }
  const current = (await files(root)).regular;
  // check-ignore respects tracked files. A newly ignored baseline path must not be overwritten.
  const ignored = new Set(handle.manifest.length ? (await git(root, ["check-ignore", "-z", "--stdin"], undefined,
    handle.manifest.map(entry => entry.path).join("\0") + "\0", [0, 1])).toString("utf8").split("\0") : []);
  for (const file of current.filter(file => !baseline.has(file) && !isUnderSpecial(file, specials))) await remove(file);
  for (let i = 0; i < handle.manifest.length; i++) {
    if (ignoreDone.has(i)) continue;
    const entry = handle.manifest[i];
    try {
      if (ignored.has(entry.path)) throw new SnapshotError("snapshot_unsupported", "Baseline path is now ignored; left untouched.");
      if (await restoreEntry(root, handle, i)) report.restored.push(entry.path);
    } catch (err) { report.failed.push({ path: entry.path, error: (err as Error).message }); }
  }
  for (const entry of specials) {
    try {
      if (await specialState(root, entry.path, entry.kind) !== entry.state) {
        report.failed.push({ path: entry.path, error: "Tracked symlink/submodule changed during the run; it was left as is." });
      }
    } catch {
      report.failed.push({ path: entry.path, error: "Tracked symlink/submodule changed during the run; it was left as is." });
    }
  }
  return report;
}

/** Files that exist now but not in the baseline (ignored files excluded, so build caches do not show up). */
export async function createdFiles(handle: SnapshotHandle): Promise<string[]> {
  const baseline = new Set(handle.manifest.map(entry => entry.path));
  const specials = handle.specialEntries ?? [];
  const root = await checkout(handle.checkoutRoot);
  const created: string[] = [];
  // A tracked file deleted before the run is listed by Git but absent: only files that exist now count.
  for (const file of (await files(root)).regular.filter(file => !baseline.has(file) && !isUnderSpecial(file, specials))) {
    try { if ((await statOrMissing(relativePath(root, file.endsWith("/") ? file.slice(0, -1) : file)))) created.push(file); }
    catch { created.push(file); }
  }
  return created;
}

export async function discardSnapshot(handle: SnapshotHandle): Promise<void> {
  await rm(handle.directory, { recursive: true, force: true });
}

export async function headAndIndexIdentity(checkoutRoot: string): Promise<{ head: string; indexHash: string | null }> {
  const root = await checkout(checkoutRoot);
  const head = (await git(root, ["rev-parse", "HEAD"])).toString("utf8").trim();
  const index = (await git(root, ["rev-parse", "--git-path", "index"])).toString("utf8").trim();
  try { await readFile(path.resolve(root, index)); }
  catch (err) { if (missing(err)) return { head, indexHash: null }; throw err; }
  // Hash the staged entries, not the raw index bytes: `git status`, editors and Git tools rewrite the
  // index's stat cache without changing what is staged, which used to refuse restores as "index changed".
  return { head, indexHash: hash(await git(root, ["ls-files", "--stage", "-z"])) };
}
