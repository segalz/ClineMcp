import { readFile, writeFile, rename, unlink, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { createServer, createConnection } from "node:net";
import { ClineRunError } from "./runner.js";
export const PROHIBITED_NAMES = new Set(["__proto__", "constructor", "prototype"]);
export function resolveProviderSettingsPath(overridePath?: string): string {
  if (overridePath) return path.resolve(overridePath);
  if (process.env.CLINE_PROVIDER_SETTINGS_PATH) {
    return path.resolve(process.env.CLINE_PROVIDER_SETTINGS_PATH);
  }
  if (process.env.CLINE_DATA_DIR) {
    return path.join(path.resolve(process.env.CLINE_DATA_DIR), "settings", "providers.json");
  }
  return path.join(os.homedir(), ".cline", "data", "settings", "providers.json");
}

function isPlainObject(val: unknown): val is Record<string, any> {
  return typeof val === "object" && val !== null && !Array.isArray(val);
}

function getProviderEntry(data: Record<string, any>, providerId: string): Record<string, any> | undefined {
  if (isPlainObject(data.providers) && Object.hasOwn(data.providers, providerId) && isPlainObject(data.providers[providerId])) {
    return data.providers[providerId];
  }
  if (Object.hasOwn(data, providerId) && isPlainObject(data[providerId])) {
    return data[providerId];
  }
  return undefined;
}

export interface ProviderSettingsSnapshot {
  settingsPath: string;
  targetProvider?: string;
  hadFile: boolean;
  skipRestore: boolean;
  hadEntry: boolean;
  originalLastUsedProvider?: string;
  hadLastUsedProvider: boolean;
  originalModel?: unknown;
  hadModel: boolean;
  originalReasoning?: unknown;
  hadReasoning: boolean;
  warning?: string;
}

export async function readProviderSettingsSnapshot(
  settingsPath: string,
  requestedProvider?: string
): Promise<ProviderSettingsSnapshot> {
  if (requestedProvider && PROHIBITED_NAMES.has(requestedProvider.toLowerCase())) {
    throw new ClineRunError("launch_failed", `provider "${requestedProvider}" is prohibited.`);
  }

  let content: string;
  try {
    content = await readFile(settingsPath, "utf8");
  } catch (err: any) {
    if (err?.code === "ENOENT") {
      return {
        settingsPath,
        targetProvider: requestedProvider ?? "cline",
        hadFile: false,
        skipRestore: false,
        hadEntry: false,
        hadLastUsedProvider: false,
        hadModel: false,
        hadReasoning: false
      };
    }
    return {
      settingsPath,
      targetProvider: requestedProvider,
      hadFile: true,
      skipRestore: true,
      hadEntry: false,
      hadLastUsedProvider: false,
      hadModel: false,
      hadReasoning: false,
      warning: `Unable to read provider settings file: ${err?.message || String(err)}`
    };
  }

  content = content.replace(/^\uFEFF/, "");

  let data: Record<string, any>;
  try {
    const parsed = JSON.parse(content);
    if (!isPlainObject(parsed)) {
      throw new Error("Provider settings root must be a JSON object");
    }
    data = parsed;
  } catch (err: any) {
    return {
      settingsPath,
      targetProvider: requestedProvider,
      hadFile: true,
      skipRestore: true,
      hadEntry: false,
      hadLastUsedProvider: false,
      hadModel: false,
      hadReasoning: false,
      warning: `Unable to parse provider settings JSON: ${err?.message || String(err)}`
    };
  }

  const hadLastUsedProvider = Object.hasOwn(data, "lastUsedProvider");
  const originalLastUsedProvider = typeof data.lastUsedProvider === "string" ? data.lastUsedProvider : undefined;
  const targetProvider = requestedProvider || originalLastUsedProvider || "cline";

  let hadEntry = false;
  let originalModel: unknown;
  let hadModel = false;
  let originalReasoning: unknown;
  let hadReasoning = false;

  if (targetProvider) {
    const entry = getProviderEntry(data, targetProvider);
    if (entry) {
      hadEntry = true;
      if (isPlainObject(entry.settings)) {
        hadModel = Object.hasOwn(entry.settings, "model");
        originalModel = entry.settings.model;
        hadReasoning = Object.hasOwn(entry.settings, "reasoning");
        originalReasoning = entry.settings.reasoning;
      }
    }
  }

  return {
    settingsPath,
    targetProvider,
    hadFile: true,
    skipRestore: false,
    hadEntry,
    originalLastUsedProvider,
    hadLastUsedProvider,
    originalModel,
    hadModel,
    originalReasoning,
    hadReasoning
  };
}


export type RestoreResult = "unchanged" | "restored" | "failed";
export type ReleaseSettingsMutex = (() => Promise<void>) & { verifyOwnership?: () => Promise<boolean> };
export interface MutexOptions {
  deadline?: number;
  lockTimeoutMs?: number;
  nowFn?: () => number;
  sleep?: (ms: number) => Promise<void>;
  acquireSettingsMutex?: typeof acquireSettingsMutex;
}
export function getSettingsMutexPath(settingsPath: string): string {
  const resolved = path.resolve(settingsPath);
  const hash = createHash("sha256").update(process.platform === "win32" ? resolved.toLowerCase() : resolved).digest("hex").slice(0, 16);
  return process.platform === "win32" ? "\\\\.\\pipe\\cline-mcp-bridge-settings-" + hash : path.join(path.dirname(resolved), ".cline-mcp-bridge-settings-" + hash + ".sock");
}
export async function verifySocketOwnership(
  address: string, token: string, options: MutexOptions = {}
): Promise<boolean> {
  const now = options.nowFn ?? (() => performance.now());
  const remaining = Math.min(250, (options.deadline ?? Infinity) - now());
  if (remaining <= 0) return false;
  return new Promise<boolean>(resolve => {
    const socket = createConnection(address);
    let received = "";
    let finished = false;
    const finish = (owned: boolean) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(owned);
    };
    const timer = setTimeout(() => finish(false), remaining);
    socket.setEncoding("utf8");
    socket.on("data", chunk => {
      received += chunk;
      if (received.includes("\n")) finish(received === token + "\n");
      else if (received.length > token.length) finish(false);
    });
    socket.once("error", () => finish(false));
    socket.once("end", () => finish(false));
    socket.once("close", () => finish(false));
  });
}
export async function acquireSettingsMutex(settingsPath: string, signal?: AbortSignal, options: MutexOptions = {}): Promise<ReleaseSettingsMutex> {
  const now = options.nowFn ?? (() => performance.now());
  const deadline = Math.min(options.deadline ?? Infinity, now() + (options.lockTimeoutMs ?? 30_000));
  const address = getSettingsMutexPath(settingsPath);
  await mkdir(path.dirname(settingsPath), { recursive: true });
  let backoff = 10;
  while (true) {
    if (signal?.aborted) throw new ClineRunError("cancelled", "The Cline request was cancelled.");
    if (now() >= deadline) throw new ClineRunError("settings_lock_timeout", "Timed out waiting for the settings mutex.");
    const token = randomUUID();
    const server = createServer(socket => {
      socket.on("error", () => {});
      socket.end(token + "\n");
    });
    const error = await new Promise<NodeJS.ErrnoException | undefined>(resolve => {
      server.once("error", resolve);
      server.listen(address, () => resolve(undefined));
    });
    if (!error) {
      const verifyOwnership = () => verifySocketOwnership(address, token, { deadline, nowFn: now });
      if (process.platform !== "win32" && !await verifyOwnership()) {
        await new Promise<void>(resolve => server.close(() => resolve()));
        continue;
      }
      if (signal?.aborted || now() >= deadline) {
        await new Promise<void>(resolve => server.close(() => resolve()));
        continue;
      }
      let released = false;
      const release: ReleaseSettingsMutex = async () => {
        if (released) return;
        released = true;
        await new Promise<void>((resolve, reject) => server.close(err => err ? reject(err) : resolve()));
      };
      if (process.platform !== "win32") release.verifyOwnership = verifyOwnership;
      return release;
    }
    if (error.code !== "EADDRINUSE") throw error;
    if (process.platform !== "win32") {
      const stale = await new Promise<boolean>(resolve => {
        const socket = createConnection(address);
        const finish = (result: boolean) => { clearTimeout(timer); socket.destroy(); resolve(result); };
        const timer = setTimeout(() => finish(false), Math.min(100, Math.max(0, deadline - now())));
        socket.once("connect", () => finish(false));
        socket.once("error", (err: NodeJS.ErrnoException) => finish(err.code === "ECONNREFUSED" || err.code === "ENOENT"));
      });
      if (stale) {
        await unlink(address).catch((err: NodeJS.ErrnoException) => { if (err.code !== "ENOENT") throw err; });
        continue;
      }
    }
    await (options.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms))))(Math.min(backoff, Math.max(0, deadline - now())));
    backoff = Math.min(250, backoff * 2);
  }
}
async function atomicWrite(destination: string, data: unknown): Promise<void> {
  const temp = destination + "." + randomUUID() + ".tmp";
  try {
    await writeFile(temp, JSON.stringify(data, null, 2), { encoding: "utf8", mode: 0o600, flag: "wx" });
    await rename(temp, destination);
  } finally {
    await unlink(temp).catch((err: NodeJS.ErrnoException) => { if (err.code !== "ENOENT") throw err; });
  }
}
async function readSettings(settingsPath: string): Promise<Record<string, any>> {
  const parsed = JSON.parse((await readFile(settingsPath, "utf8")).replace(/^\uFEFF/, ""));
  if (!isPlainObject(parsed)) throw new Error("Provider settings root must be an object.");
  return parsed;
}
export async function restoreProviderSettingsSnapshot(snapshot: ProviderSettingsSnapshot): Promise<RestoreResult> {
  if (snapshot.skipRestore) return "failed";
  try {
    // Merge only touched fields into the freshest file. Never fall back to an older read.
    const data = await readSettings(snapshot.settingsPath).catch((err: NodeJS.ErrnoException) => {
      if (err.code === "ENOENT") return undefined;
      throw err;
    });
    if (!data) return "unchanged";
    const before = JSON.stringify(data);
    if (snapshot.hadLastUsedProvider) data.lastUsedProvider = snapshot.originalLastUsedProvider;
    else delete data.lastUsedProvider;
    if (snapshot.targetProvider) {
      const entry = getProviderEntry(data, snapshot.targetProvider);
      if (entry) {
        if (!isPlainObject(entry.settings) && (snapshot.hadModel || snapshot.hadReasoning)) return "failed";
        if (isPlainObject(entry.settings)) {
          if (snapshot.hadModel) entry.settings.model = snapshot.originalModel;
          else delete entry.settings.model;
          if (snapshot.hadReasoning) entry.settings.reasoning = snapshot.originalReasoning;
          else delete entry.settings.reasoning;
        }
        if (!snapshot.hadEntry) {
          if (isPlainObject(entry.settings) && Object.keys(entry.settings).length === 0) delete entry.settings;
          if (Object.keys(entry).length === 0) {
            const container = isPlainObject(data.providers) && Object.hasOwn(data.providers, snapshot.targetProvider) ? data.providers : data;
            delete container[snapshot.targetProvider];
          }
        }
      } else if (snapshot.hadEntry && (snapshot.hadModel || snapshot.hadReasoning)) return "failed";
    }
    if (JSON.stringify(data) === before) return "unchanged";
    await atomicWrite(snapshot.settingsPath, data);
    return "restored";
  } catch { return "failed"; }
}
export function getJournalPath(settingsPath: string): string { return path.resolve(settingsPath) + ".bridge-restore.json"; }
export async function writeRestoreJournal(
  journalPath: string, snapshot: ProviderSettingsSnapshot, verifyOwnership?: () => Promise<boolean>
): Promise<boolean> {
  // The caller holds the OS mutex; never replace an existing or unreadable journal.
  try {
    await readFile(journalPath);
    throw new ClineRunError("settings_restore_failed", "An existing restore journal must be recovered first.");
  } catch (err: any) { if (err.code !== "ENOENT") throw err; }
  const { targetProvider, hadFile, hadEntry, hadLastUsedProvider, originalLastUsedProvider, hadModel, originalModel, hadReasoning, originalReasoning } = snapshot;
  if (verifyOwnership && !await verifyOwnership()) return false;
  await atomicWrite(journalPath, { targetProvider, hadFile, hadEntry, hadLastUsedProvider, originalLastUsedProvider, hadModel, originalModel, hadReasoning, originalReasoning });
  return true;
}
async function readJournal(settingsPath: string): Promise<ProviderSettingsSnapshot | undefined> {
  let raw: string;
  try { raw = await readFile(getJournalPath(settingsPath), "utf8"); }
  catch (err: any) { if (err.code === "ENOENT") return undefined; throw err; }
  const data = JSON.parse(raw);
  if (!isPlainObject(data) || ["hadFile", "hadEntry", "hadLastUsedProvider", "hadModel", "hadReasoning"].some(key => typeof data[key] !== "boolean") ||
      (data.targetProvider !== undefined && (typeof data.targetProvider !== "string" || PROHIBITED_NAMES.has(data.targetProvider.toLowerCase())))) throw new Error("Invalid settings restore journal.");
  return { ...data, settingsPath, skipRestore: false } as ProviderSettingsSnapshot;
}
async function recoverLocked(settingsPath: string): Promise<RestoreResult> {
  try {
    const snapshot = await readJournal(settingsPath);
    if (!snapshot) return "unchanged";
    const result = await restoreProviderSettingsSnapshot(snapshot);
    if (result !== "failed") await unlink(getJournalPath(settingsPath));
    return result;
  } catch { return "failed"; }
}
export async function recoverProviderSettingsJournal(settingsPath: string, options: MutexOptions = {}): Promise<RestoreResult> {
  const release = await (options.acquireSettingsMutex ?? acquireSettingsMutex)(settingsPath, undefined, { ...options, lockTimeoutMs: options.lockTimeoutMs ?? 10_000 });
  try { return await recoverLocked(settingsPath); }
  finally { await release(); }
}
const warnedJournals = new Set<string>();
async function readSelectionJournal(settingsPath: string): Promise<ProviderSettingsSnapshot | undefined> {
  try { return await readJournal(settingsPath); }
  catch {
    const key = getJournalPath(settingsPath);
    if (!warnedJournals.has(key)) {
      warnedJournals.add(key);
      console.error("Invalid or unreadable settings restore journal; using saved settings: " + key);
    }
    return undefined;
  }
}
export async function resolveSavedSelection(settingsPath: string): Promise<{ provider?: string; model?: string }> {
  const priorJournal = await readSelectionJournal(settingsPath);
  const data = await readSettings(settingsPath).catch(() => ({} as Record<string, any>));
  const journal = priorJournal ?? await readSelectionJournal(settingsPath);
  const provider = journal ? journal.originalLastUsedProvider : data.lastUsedProvider;
  if (typeof provider !== "string" || PROHIBITED_NAMES.has(provider.toLowerCase())) return {};
  const model = journal?.targetProvider === provider ? journal.originalModel : getProviderEntry(data, provider)?.settings?.model;
  return typeof model === "string" ? { provider, model } : {};
}
export async function withProviderOverride<T extends { warnings?: string[] }>(
  input: { provider?: string; model?: string }, settingsPath: string, signal: AbortSignal | undefined,
  action: (selection: { provider?: string; model?: string }) => Promise<T>, options: MutexOptions = {}
): Promise<T> {
  if (!input.provider && !input.model) return action(await resolveSavedSelection(settingsPath));
  const now = options.nowFn ?? (() => performance.now());
  const deadline = Math.min(options.deadline ?? Infinity, now() + (options.lockTimeoutMs ?? 30_000));
  while (true) {
    if (now() >= deadline) throw new ClineRunError("settings_lock_timeout", "Timed out waiting for settings mutex ownership.");
    const release = await (options.acquireSettingsMutex ?? acquireSettingsMutex)(settingsPath, signal, { ...options, deadline });
    try {
      if (await recoverLocked(settingsPath) === "failed") throw new ClineRunError("settings_restore_failed", "Unable to recover the existing settings restore journal.");
      const snapshot = await readProviderSettingsSnapshot(settingsPath, input.provider);
      if (snapshot.skipRestore) throw new ClineRunError("settings_restore_failed", "Unable to snapshot provider settings.");
      if (!await writeRestoreJournal(getJournalPath(settingsPath), snapshot, release.verifyOwnership)) continue;
      try {
        return await action({ provider: input.provider ?? snapshot.targetProvider,
          model: input.model ?? (typeof snapshot.originalModel === "string" ? snapshot.originalModel : undefined) });
      } finally {
        if (await recoverLocked(settingsPath) === "failed") throw new ClineRunError("settings_restore_failed", "Unable to restore provider settings; the journal was retained.");
      }
    } finally { await release(); }
  }
}
