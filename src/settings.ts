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
/** Original values of one provider entry, as captured before the first bridge override touched it. */
export interface ProviderBaseline {
  hadEntry: boolean;
  hadModel: boolean;
  originalModel?: unknown;
  hadReasoning: boolean;
  originalReasoning?: unknown;
}
/** Original selection fields of the whole settings file plus every provider any active run overrode. */
export interface SettingsBaseline {
  hadLastUsedProvider: boolean;
  originalLastUsedProvider?: string;
  providers: Record<string, ProviderBaseline>;
}
export interface JournalRun { pid: number; provider: string; startedAtMs: number; }
/** Restore journal v2: the baseline is restored only once no live run remains. */
export interface RestoreJournal { version: 2; base: SettingsBaseline; runs: Record<string, JournalRun>; }

/** A run older than this is treated as dead even if its PID is alive again (PID reuse). */
export const MAX_RUN_AGE_MS = 6 * 60 * 60 * 1000;

function applyProviderBaseline(data: Record<string, any>, providerId: string, base: ProviderBaseline): boolean {
  const entry = getProviderEntry(data, providerId);
  if (entry) {
    if (!isPlainObject(entry.settings) && (base.hadModel || base.hadReasoning)) return false;
    if (isPlainObject(entry.settings)) {
      if (base.hadModel) entry.settings.model = base.originalModel;
      else delete entry.settings.model;
      if (base.hadReasoning) entry.settings.reasoning = base.originalReasoning;
      else delete entry.settings.reasoning;
    }
    if (!base.hadEntry) {
      if (isPlainObject(entry.settings) && Object.keys(entry.settings).length === 0) delete entry.settings;
      if (Object.keys(entry).length === 0) {
        const container = isPlainObject(data.providers) && Object.hasOwn(data.providers, providerId) ? data.providers : data;
        delete container[providerId];
      }
    }
  } else if (base.hadEntry && (base.hadModel || base.hadReasoning)) return false;
  return true;
}

async function restoreBaseline(settingsPath: string, base: SettingsBaseline): Promise<RestoreResult> {
  try {
    // Merge only touched fields into the freshest file. Never fall back to an older read.
    const data = await readSettings(settingsPath).catch((err: NodeJS.ErrnoException) => {
      if (err.code === "ENOENT") return undefined;
      throw err;
    });
    if (!data) return "unchanged";
    const before = JSON.stringify(data);
    if (base.hadLastUsedProvider) data.lastUsedProvider = base.originalLastUsedProvider;
    else delete data.lastUsedProvider;
    for (const [providerId, providerBase] of Object.entries(base.providers)) {
      if (!applyProviderBaseline(data, providerId, providerBase)) return "failed";
    }
    if (JSON.stringify(data) === before) return "unchanged";
    await atomicWrite(settingsPath, data);
    return "restored";
  } catch { return "failed"; }
}

function providerBaselineFrom(snapshot: ProviderSettingsSnapshot): ProviderBaseline {
  const { hadEntry, hadModel, originalModel, hadReasoning, originalReasoning } = snapshot;
  return { hadEntry, hadModel, originalModel, hadReasoning, originalReasoning };
}

function baselineFrom(snapshot: ProviderSettingsSnapshot): SettingsBaseline {
  return {
    hadLastUsedProvider: snapshot.hadLastUsedProvider,
    originalLastUsedProvider: snapshot.originalLastUsedProvider,
    providers: snapshot.targetProvider ? { [snapshot.targetProvider]: providerBaselineFrom(snapshot) } : {}
  };
}

export async function restoreProviderSettingsSnapshot(snapshot: ProviderSettingsSnapshot): Promise<RestoreResult> {
  if (snapshot.skipRestore) return "failed";
  return restoreBaseline(snapshot.settingsPath, baselineFrom(snapshot));
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
function validProviderId(id: unknown): id is string {
  return typeof id === "string" && id.length > 0 && !PROHIBITED_NAMES.has(id.toLowerCase());
}
function validProviderBaseline(value: unknown): value is ProviderBaseline {
  return isPlainObject(value) && ["hadEntry", "hadModel", "hadReasoning"].every(key => typeof value[key] === "boolean");
}
/** Reads the journal in either format. A v1 journal (single snapshot, no runs) converts to v2 with no live runs. */
async function readJournal(settingsPath: string): Promise<RestoreJournal | undefined> {
  let raw: string;
  try { raw = await readFile(getJournalPath(settingsPath), "utf8"); }
  catch (err: any) { if (err.code === "ENOENT") return undefined; throw err; }
  const data = JSON.parse(raw);
  if (!isPlainObject(data)) throw new Error("Invalid settings restore journal.");
  if (data.version === 2) {
    const base = data.base, runs = data.runs;
    if (!isPlainObject(base) || typeof base.hadLastUsedProvider !== "boolean" || !isPlainObject(base.providers) || !isPlainObject(runs) ||
        (base.originalLastUsedProvider !== undefined && typeof base.originalLastUsedProvider !== "string") ||
        Object.entries(base.providers).some(([id, value]) => !validProviderId(id) || !validProviderBaseline(value)) ||
        Object.values(runs).some(run => !isPlainObject(run) || !Number.isInteger(run.pid) || !validProviderId(run.provider) || typeof run.startedAtMs !== "number")) {
      throw new Error("Invalid settings restore journal.");
    }
    return data as unknown as RestoreJournal;
  }
  if (["hadFile", "hadEntry", "hadLastUsedProvider", "hadModel", "hadReasoning"].some(key => typeof data[key] !== "boolean") ||
      (data.targetProvider !== undefined && !validProviderId(data.targetProvider))) throw new Error("Invalid settings restore journal.");
  return { version: 2, base: baselineFrom({ ...data, settingsPath, skipRestore: false } as ProviderSettingsSnapshot), runs: {} };
}
function isProcessAlive(pid: number): boolean {
  if (pid === process.pid) return true;
  try { process.kill(pid, 0); return true; }
  catch (err: any) { return err?.code === "EPERM"; }
}
/** Runs of this process that finished but could not be removed from the journal (cleanup failed). */
const finishedRuns = new Set<string>();
/** Drops runs that finished, whose bridge process is gone, or that are older than MAX_RUN_AGE_MS. */
function pruneDeadRuns(journal: RestoreJournal, nowMs: number, alive: (pid: number) => boolean): RestoreJournal {
  const runs: Record<string, JournalRun> = {};
  for (const [id, run] of Object.entries(journal.runs)) {
    if (!finishedRuns.has(id) && nowMs - run.startedAtMs < MAX_RUN_AGE_MS && alive(run.pid)) runs[id] = run;
  }
  return { ...journal, runs };
}
interface JournalOptions { wallNow?: () => number; isProcessAlive?: (pid: number) => boolean; }
/**
 * Caller holds the mutex. Prunes dead runs; restores the baseline and removes the journal only when no
 * live run remains. Never restores while another live bridge run still relies on its override.
 */
async function recoverLocked(settingsPath: string, options: JournalOptions = {}): Promise<RestoreResult> {
  try {
    const journal = await readJournal(settingsPath);
    if (!journal) return "unchanged";
    const pruned = pruneDeadRuns(journal, (options.wallNow ?? Date.now)(), options.isProcessAlive ?? isProcessAlive);
    if (Object.keys(pruned.runs).length > 0) {
      if (Object.keys(pruned.runs).length !== Object.keys(journal.runs).length) await atomicWrite(getJournalPath(settingsPath), pruned);
      return "unchanged";
    }
    const result = await restoreBaseline(settingsPath, journal.base);
    if (result !== "failed") await unlink(getJournalPath(settingsPath));
    return result;
  } catch { return "failed"; }
}
export async function recoverProviderSettingsJournal(settingsPath: string, options: MutexOptions & JournalOptions = {}): Promise<RestoreResult> {
  const release = await (options.acquireSettingsMutex ?? acquireSettingsMutex)(settingsPath, undefined, { ...options, lockTimeoutMs: options.lockTimeoutMs ?? 10_000 });
  try { return await recoverLocked(settingsPath, options); }
  finally { await release(); }
}
const warnedJournals = new Set<string>();
async function readSelectionJournal(settingsPath: string): Promise<RestoreJournal | undefined> {
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
  const base = journal?.base;
  const provider = base ? base.originalLastUsedProvider : data.lastUsedProvider;
  if (typeof provider !== "string" || PROHIBITED_NAMES.has(provider.toLowerCase())) return {};
  const model = base && Object.hasOwn(base.providers, provider) ? base.providers[provider].originalModel : getProviderEntry(data, provider)?.settings?.model;
  return typeof model === "string" ? { provider, model } : {};
}
/** Lock wait for the end-of-run cleanup. Independent of the run's deadline, which may already have passed. */
export const RELEASE_LOCK_TIMEOUT_MS = 30_000;
/**
 * Runs `action` with an explicit provider/model while protecting the user's saved selection.
 * The settings mutex is held only briefly: once to register the run and capture the original values,
 * once at the end to unregister it. The original values are restored when the last live run ends,
 * so overlapping runs (in this or another bridge process) do not wait for each other.
 */
export async function withProviderOverride<T extends { warnings?: string[] }>(
  input: { provider?: string; model?: string }, settingsPath: string, signal: AbortSignal | undefined,
  action: (selection: { provider?: string; model?: string }) => Promise<T>, options: MutexOptions & JournalOptions = {}
): Promise<T> {
  if (!input.provider && !input.model) return action(await resolveSavedSelection(settingsPath));
  const now = options.nowFn ?? (() => performance.now());
  const wallNow = options.wallNow ?? Date.now;
  const acquire = options.acquireSettingsMutex ?? acquireSettingsMutex;
  const journalPath = getJournalPath(settingsPath);
  const deadline = Math.min(options.deadline ?? Infinity, now() + (options.lockTimeoutMs ?? 30_000));
  const runId = randomUUID();
  let selection: { provider?: string; model?: string } | undefined;
  while (!selection) {
    if (now() >= deadline) throw new ClineRunError("settings_lock_timeout", "Timed out waiting for settings mutex ownership.");
    const release = await acquire(settingsPath, signal, { ...options, deadline });
    try {
      if (await recoverLocked(settingsPath, options) === "failed") throw new ClineRunError("settings_restore_failed", "Unable to recover the existing settings restore journal.");
      let existing: RestoreJournal | undefined;
      try { existing = await readJournal(settingsPath); }
      catch { throw new ClineRunError("settings_restore_failed", "Unable to read the settings restore journal."); }
      // With live runs the file's lastUsedProvider may be another run's override; the journal holds the user's original.
      // No original lastUsedProvider means Cline's own default, "cline" (as readProviderSettingsSnapshot assumes).
      const requested = input.provider ?? (existing ? existing.base.originalLastUsedProvider ?? "cline" : undefined);
      const snapshot = await readProviderSettingsSnapshot(settingsPath, requested);
      if (snapshot.skipRestore) throw new ClineRunError("settings_restore_failed", "Unable to snapshot provider settings.");
      const provider = snapshot.targetProvider ?? "cline";
      const journal: RestoreJournal = existing ?? { version: 2, base: baselineFrom(snapshot), runs: {} };
      // Capture a provider's original values only the first time any live run overrides it.
      if (!Object.hasOwn(journal.base.providers, provider)) journal.base.providers[provider] = providerBaselineFrom(snapshot);
      journal.runs[runId] = { pid: process.pid, provider, startedAtMs: wallNow() };
      if (release.verifyOwnership && !await release.verifyOwnership()) continue;
      await atomicWrite(journalPath, journal);
      const originalModel = journal.base.providers[provider].originalModel;
      selection = { provider: input.provider ?? provider, model: input.model ?? (typeof originalModel === "string" ? originalModel : undefined) };
    } finally { await release(); }
  }
  let result: T;
  try {
    result = await action(selection);
  } catch (err) {
    // Never let cleanup mask the run's own error.
    await unregisterRun(settingsPath, runId, options).catch(() => { finishedRuns.add(runId); });
    throw err;
  }
  try {
    await unregisterRun(settingsPath, runId, options);
  } catch (err: any) {
    // The run is done: mark it finished so the next call in this process prunes it and restores.
    finishedRuns.add(runId);
    (result.warnings ??= []).push("Provider settings were not restored yet (" + (err?.message ?? String(err)) +
      "); the bridge restores them on its next call.");
  }
  return result;
}
async function unregisterRun(settingsPath: string, runId: string, options: MutexOptions & JournalOptions): Promise<void> {
  const release = await (options.acquireSettingsMutex ?? acquireSettingsMutex)(settingsPath, undefined,
    { ...options, deadline: undefined, lockTimeoutMs: RELEASE_LOCK_TIMEOUT_MS });
  try {
    let journal: RestoreJournal | undefined;
    try { journal = await readJournal(settingsPath); } catch { journal = undefined; }
    if (journal && Object.hasOwn(journal.runs, runId)) {
      delete journal.runs[runId];
      await atomicWrite(getJournalPath(settingsPath), journal);
    }
    if (await recoverLocked(settingsPath, options) === "failed") {
      throw new ClineRunError("settings_restore_failed", "Unable to restore provider settings; the journal was retained.");
    }
  } finally { await release(); }
}
