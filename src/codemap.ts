import { spawn } from "node:child_process";
import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { killCodeMapTree } from "./codemap-kill.js";
import {
  defaultKillTree, resolveClineEntry, windowsCommandLineLength, WINDOWS_COMMAND_LINE_LIMIT, MAX_TOTAL_TEXT_CHARACTERS,
  ClineRunError, type CodeMapSource, type AskClineInput, type ClineInvocationOptions
} from "./runner.js";

export const CODE_MAP_HEADER = "## Code map (bridge-generated, line numbers at HEAD)";
const MAX_FILES = 3_000;
const MAX_BYTES = 512 * 1024;
const TIME_BUDGET_MS = 1_500;
const CODEINDEX_TIME_BUDGET_MS = 10_000;
const KILL_BUDGET_MS = 1_500;
const SKIP_DIRS = new Set(["node_modules", "dist", "build", "out", "vendor", ".git"]);
const BINARY_EXTENSION = /\.(?:png|jpe?g|gif|webp|ico|pdf|zip|gz|7z|rar|exe|dll|so|dylib|woff2?|ttf|eot|mp[34]|wav|ogg|wasm|class|pyc|db|sqlite)$/i;

export interface CodeMapOptions {
  prompt?: string;
  maxChars?: number;
  signal?: AbortSignal;
  /** Remaining preparation budget, including fallback and process termination. */
  deadlineMs?: number;
  /** Full escaped Windows command-line length for a candidate map preamble. */
  commandLineLength?: (preamble: string) => number;
}

function trackedFiles(root: string, signal: AbortSignal): Promise<string[]> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new Error("Code map cancelled"));
    const child = spawn(process.platform === "win32" ? "git.exe" : "git", ["-C", root, "ls-files", "-z"], {
      shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"]
    });
    const chunks: Buffer[] = [];
    let bytes = 0;
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", stop);
      if (error) reject(error);
      else resolve(Buffer.concat(chunks).toString("utf8").split("\0").filter(Boolean));
    };
    const stop = () => {
      if (settled) return;
      try {
        if (process.platform === "win32" && child.pid) defaultKillTree(child.pid, "SIGKILL", "win32");
        else child.kill();
      } catch { /* already exited */ }
      finish(new Error("Code map Git deadline or output limit exceeded"));
    };
    signal.addEventListener("abort", stop, { once: true });
    child.stdout.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > 8 * 1024 * 1024) stop();
      else if (!settled) chunks.push(chunk);
    });
    child.stderr.resume();
    child.on("error", () => finish(new Error("Code map Git launch failed")));
    child.on("close", code => finish(code === 0 ? undefined : new Error("Code map Git failed")));
  });
}

function included(file: string): boolean {
  const parts = file.split("/");
  const base = parts.at(-1)!;
  return !parts.some(part => SKIP_DIRS.has(part.toLowerCase())) &&
    !/(?:\.min\.|\.lock$|^package-lock\.json$|^npm-shrinkwrap\.json$|^yarn\.lock$|^pnpm-lock\.yaml$|^bun\.lockb?$)/i.test(base) &&
    !BINARY_EXTENSION.test(base) && !/[\r\n\x00-\x1f]/.test(file);
}

function symbolPattern(file: string): RegExp | undefined {
  switch (path.extname(file).toLowerCase()) {
    case ".ts": case ".tsx": case ".js": case ".jsx": case ".mjs": case ".cjs": case ".mts": case ".cts":
      return /^(?:export\s+(?:default\s+)?)?(?:declare\s+)?(?:abstract\s+)?(?:async\s+)?(?:function\s*\*?\s*|(?:class|interface|type|enum|const)\s+)([\w$]+)|^export\s+default\s+([\w$]+)/;
    case ".py": case ".pyi": return /^(?:async\s+)?(?:def|class)\s+(\w+)/;
    case ".go": return /^(?:func\s+(?:\([^)]*\)\s*)?|type\s+)(\w+)/;
    case ".rs": return /^(?:pub(?:\([^)]*\))?\s+)?(?:async\s+|unsafe\s+)?(?:fn|struct|enum|trait|impl|mod)\s+(?:<[^>]*>\s*)?([\w:]+)/;
    case ".java": case ".cs": case ".kt": case ".kts":
      return /^(?:(?:public|private|protected|internal|abstract|final|open|sealed|data|static|partial|expect|actual|annotation|value)\s+)*(?:class|interface|enum(?:\s+class)?|record(?:\s+(?:class|struct))?)\s+(\w+)/;
    case ".php": return /^(?:(?:abstract|final|readonly)\s+)*(?:class|interface|trait|enum|function)\s+&?([\w]+)/;
    case ".rb": return /^(?:class|module|def)\s+([\w:.!?=]+)/;
    default: return undefined;
  }
}

interface Entry { base: string; symbols: string; }

function formatMap(entries: Entry[], omitted: number, fits: (text: string) => boolean): string | undefined {
  const render = (count: number, symbols: number) => {
    const missing = omitted + entries.length - count;
    return [CODE_MAP_HEADER, ...entries.slice(0, count).map((entry, i) => entry.base + (i < symbols ? entry.symbols : "")),
      ...(missing ? [`... and ${missing} more files`] : [])].join("\n");
  };
  // Keep all paths first; sacrifice symbols from the lowest-priority files before dropping paths.
  if (!entries.length && !omitted) return undefined;
  const full = render(entries.length, entries.length);
  if (fits(full)) return full;
  const pathsFit = fits(render(entries.length, 0));
  // Binary search keeps rendering bounded even when thousands of symbols must be dropped.
  let low = 0;
  let high = entries.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (fits(pathsFit ? render(entries.length, mid) : render(mid, 0))) low = mid;
    else high = mid - 1;
  }
  const result = pathsFit ? render(entries.length, low) : render(low, 0);
  return fits(result) ? result : undefined;
}

/** Best-effort, bounded map of tracked files. A scan-budget stop keeps completed entries; I/O failure omits the map. */
async function buildRegexCodeMap(root: string, options: CodeMapOptions = {}): Promise<string | undefined> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const abort = () => controller.abort();
  try {
    if (options.signal?.aborted) return undefined;
    const maxChars = options.maxChars ?? 6_000;
    if (!Number.isFinite(maxChars) || maxChars <= 0) return undefined;
    const commandLimit = WINDOWS_COMMAND_LINE_LIMIT - 1_000;
    if (options.commandLineLength && commandLimit - options.commandLineLength("") < 800) return undefined;
    const fits = (text: string) => text.length <= maxChars &&
      (!options.commandLineLength || options.commandLineLength(text + "\n\n") <= commandLimit);
    const duration = Math.min(TIME_BUDGET_MS, options.deadlineMs ?? TIME_BUDGET_MS);
    if (duration <= 0) return undefined;
    const deadline = performance.now() + duration;
    timer = setTimeout(abort, duration);
    options.signal?.addEventListener("abort", abort, { once: true });
    // Bound every I/O operation, including metadata calls which do not accept an AbortSignal.
    const bounded = <T>(operation: Promise<T>): Promise<T> => new Promise((resolve, reject) => {
      const onAbort = () => reject(new Error("Code map timed out"));
      if (controller.signal.aborted) onAbort();
      else controller.signal.addEventListener("abort", onAbort, { once: true });
      operation.then(resolve, reject).finally(() => controller.signal.removeEventListener("abort", onAbort));
    });
    const rootPath = await bounded(realpath(root));
    const prompt = (options.prompt ?? "").replaceAll("\\", "/");
    const files = [...new Set(await trackedFiles(rootPath, controller.signal))].filter(included);
    files.sort((a, b) => Number(prompt.includes(b)) - Number(prompt.includes(a)) || (a < b ? -1 : a > b ? 1 : 0));
    const entries: Entry[] = [];
    let scanned = 0;
    for (; scanned < files.length; scanned++) {
      if (scanned >= MAX_FILES || performance.now() >= deadline) break;
      const file = files[scanned];
      try {
        const absolute = path.resolve(rootPath, file);
        const relative = path.relative(rootPath, absolute);
        if (relative.startsWith("..") || path.isAbsolute(relative)) continue;
        const stat = await bounded(lstat(absolute));
        if (!stat.isFile() || stat.size > MAX_BYTES) continue;
        const resolved = await bounded(realpath(absolute));
        const resolvedRelative = path.relative(rootPath, resolved);
        if (resolvedRelative.startsWith("..") || path.isAbsolute(resolvedRelative)) continue;
        const bytes = await bounded(readFile(resolved, { signal: controller.signal }));
        if (bytes.length > MAX_BYTES || bytes.includes(0)) continue;
        let text: string;
        try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
        catch { continue; } // Binary/non-UTF-8 content.
        if (/[\x01-\x08\x0e-\x1f]/.test(text)) continue;
        const lines = text.length ? text.split(/\r?\n/) : [];
        if (text.endsWith("\n")) lines.pop();
        const pattern = symbolPattern(file);
        const symbols: string[] = [];
        if (pattern) lines.forEach((line, index) => {
          const match = pattern.exec(line);
          if (match) symbols.push(`${match[1] ?? match[2]}:${index + 1}`);
        });
        entries.push({ base: `${file} (${lines.length} lines):`, symbols: symbols.length ? " " + symbols.join(", ") : "" });
      } catch (error) {
        // The overall scan budget is a normal partial-result boundary. Other I/O errors omit the map.
        if (controller.signal.aborted && !options.signal?.aborted && entries.length > 0) break;
        throw error;
      }
    }
    if (options.signal?.aborted) return undefined;
    return formatMap(entries, files.length - scanned, fits);
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", abort);
    controller.abort();
  }
}

function checkCancellation(signal?: AbortSignal): void {
  if (signal?.aborted) {
    const error = new ClineRunError("cancelled", "The Cline request was cancelled.", { attempts: 0 });
    error.codeMapSource = "none";
    throw error;
  }
}

/** A failed adapter is silent. Termination and regex fallback share the preparation deadline. */
function codeindexMap(cli: string, root: string, prompt: string, budget: number, deadline: number,
  signal?: AbortSignal): Promise<string | undefined> {
  return new Promise(resolve => {
    // Reserve a regex scan and a short process-termination window inside the same bound.
    const remaining = Math.max(0, deadline - performance.now());
    const duration = Math.floor(Math.min(CODEINDEX_TIME_BUDGET_MS,
      remaining - Math.min(TIME_BUDGET_MS, remaining / 4) - Math.min(KILL_BUDGET_MS, remaining / 3)));
    if (duration <= 0 || signal?.aborted) return resolve(undefined);
    const child = spawn(process.execPath, [cli, "map", "--root", root, "--json", "--budget", String(budget),
      "--deadline-ms", String(duration)], {
      shell: false, windowsHide: true, detached: process.platform !== "win32", stdio: ["pipe", "pipe", "ignore"]
    });
    const chunks: Buffer[] = [];
    let bytes = 0, finished = false, stopping = false;
    const finish = (map?: string) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", stop);
      child.stdin.destroy(); child.stdout.destroy();
      resolve(map);
    };
    const stop = () => {
      if (finished || stopping) return;
      stopping = true;
      clearTimeout(timer);
      void killCodeMapTree(child, Math.max(0, Math.min(KILL_BUDGET_MS, deadline - performance.now()))).then(() => finish());
    };
    const timer = setTimeout(stop, duration);
    signal?.addEventListener("abort", stop, { once: true });
    if (signal?.aborted) stop();
    child.stdin.on("error", () => {}); // EPIPE is expected if a failed CLI exits before consuming stdin.
    child.stdout.on("data", (chunk: Buffer) => {
      if (finished || stopping) return;
      bytes += chunk.length;
      if (bytes > 64 * 1024) stop();
      else chunks.push(chunk);
    });
    child.once("error", () => finish());
    child.once("close", code => {
      if (stopping) { if (process.platform !== "win32") finish(); return; }
      if (code !== 0) return finish();
      try {
        const raw = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
        const reply = JSON.parse(raw);
        finish(raw.length <= budget && reply?.schemaVersion === 2 && reply.command === "map" &&
          typeof reply.map === "string" ? reply.map : undefined);
      } catch { finish(); }
    });
    child.stdin.end(prompt, "utf8");
  });
}

export interface CodeMapResult { map?: string; source: CodeMapSource; }

export async function buildCodeMapWithSource(root: string, options: CodeMapOptions = {}): Promise<CodeMapResult> {
  checkCancellation(options.signal);
  const maxChars = Math.min(6_000, options.maxChars ?? 6_000);
  const room = options.commandLineLength ? WINDOWS_COMMAND_LINE_LIMIT - 1_000 - options.commandLineLength("") : Infinity;
  if (!Number.isFinite(maxChars) || maxChars <= 0 || room < 800) return { source: "none" };
  const cli = process.env.CODEINDEX_CLI;
  const configured = cli && path.isAbsolute(cli);
  const deadline = performance.now() + Math.max(0, Math.min(configured
    ? CODEINDEX_TIME_BUDGET_MS + TIME_BUDGET_MS + KILL_BUDGET_MS : TIME_BUDGET_MS,
    options.deadlineMs ?? Infinity));
  if (configured) {
    // Windows quoting can double each map code unit. Reserve both preamble newlines too.
    const budget = Math.floor(Math.min(maxChars, (room - 4) / 2));
    const map = await codeindexMap(cli, root, options.prompt ?? "", budget, deadline, options.signal);
    checkCancellation(options.signal);
    if (map && map.length <= maxChars && (!options.commandLineLength ||
        options.commandLineLength(map + "\n\n") <= WINDOWS_COMMAND_LINE_LIMIT - 1_000)) return { map, source: "codeindex" };
  }
  checkCancellation(options.signal);
  const map = await buildRegexCodeMap(root, { ...options, maxChars, deadlineMs: deadline - performance.now() });
  checkCancellation(options.signal);
  return { map, source: map ? "regex" : "none" };
}

/** Compatibility text API; provenance is available through buildCodeMapWithSource. */
export async function buildCodeMap(root: string, options: CodeMapOptions = {}): Promise<string | undefined> {
  return (await buildCodeMapWithSource(root, options)).map;
}

/** Use the same arguments and quoting as the runner, reserving its full timeout (retries may shorten it). */
export function codeMapCommandLineLength(input: AskClineInput, options: Partial<ClineInvocationOptions>, map: string): number {
  const args = ["--json", "--auto-approve", String(options.autoApprove ?? false),
    "--thinking", input.thinking ?? "none", "--timeout", String(input.timeoutSeconds ?? 180)];
  const provider = options.provider ?? input.provider;
  const model = options.model ?? input.model;
  const system = options.systemPrompt ?? input.systemPrompt;
  const cwd = options.cwd ?? input.cwd;
  if (provider) args.push("-P", provider);
  if (model) args.push("-m", model);
  if (system) args.push("--system", system);
  if (cwd) args.push("--cwd", path.resolve(cwd));
  args.push(map + (options.promptPreamble ?? "") + input.prompt);
  const entry = resolveClineEntry(options.deps?.entryPath);
  return entry ? windowsCommandLineLength(process.execPath, [entry, ...args]) : windowsCommandLineLength("cline", args);
}

export async function withCodeMap(
  root: string, input: AskClineInput & { codeMap?: boolean }, options: Partial<ClineInvocationOptions>, signal?: AbortSignal
): Promise<Partial<ClineInvocationOptions>> {
  const started = performance.now();
  const remaining = Math.min((input.timeoutSeconds ?? 180) * 1000, options.deps?.totalBudgetMs ?? Infinity) -
    (options.preparationMs ?? 0);
  const { map, source } = input.codeMap === false ? { source: "none" as const, map: undefined } : await buildCodeMapWithSource(root, {
    prompt: input.prompt, signal,
    deadlineMs: remaining,
    maxChars: Math.min(6_000, MAX_TOTAL_TEXT_CHARACTERS - input.prompt.length -
      (options.systemPrompt ?? input.systemPrompt ?? "").length - (options.promptPreamble?.length ?? 0) - 2),
    commandLineLength: preamble => codeMapCommandLineLength(input, options, preamble)
  });
  options.onCodeMapSource?.(source);
  return { ...options, codeMapSource: source, preparationMs: (options.preparationMs ?? 0) + performance.now() - started,
    ...(map ? { promptPreamble: map + "\n\n" + (options.promptPreamble ?? "") } : {}) };
}
