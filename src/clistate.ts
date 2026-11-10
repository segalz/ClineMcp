import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  clearVersionCache,
  listFreeModels,
  readInstalledCliVersions,
  resolveCatalogPath,
  writeCatalogSnapshot,
  type FreeModel,
  type FreeModelList,
  type ModelCatalogDeps
} from "./models.js";
import { clinePing, type ClinePingInput, type ClinePingResult } from "./ping.js";
import { defaultKillTree, redactSecrets, resolveClineEntry, type ClineDependencies } from "./runner.js";
import {
  acquireSettingsMutex,
  hasActiveRunsLocked,
  isProcessAlive,
  resolveProviderSettingsPath,
  type MutexOptions
} from "./settings.js";
import { atomicWriteJson, readStatusFile, resolveStatusPath, statusKey, type StatusFile } from "./status.js";

export type UpdateState = "ok" | "update_available" | "updating" | "rolled_back" | "broken";

export interface FailedVersionEntry {
  version: string;
  failed_at: string;
  reason: string;
}

export interface CliStateInfo {
  version: string;
  catalog_version: string;
  update_state: UpdateState;
  latest_known_version: string | null;
  last_check_at: string | null;
  previous_version: string | null;
  last_error: string | null;
  failed_versions: FailedVersionEntry[];
  /** Present only while update_state === "updating" to coordinate across bridges and detect stale updates. */
  updating_pid?: number;
  updating_started_at?: string;
}

export interface BridgeStateFile {
  version: 1;
  machine_id: string;
  updated_at: string;
  cli: CliStateInfo;
}

export interface CliReplyStatus {
  state: UpdateState;
  version: string;
  latest?: string;
  failed?: { version: string; reason: string };
}

export const DAILY_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
export const CHECK_TIMEOUT_MS = 30_000;
export const INSTALL_TIMEOUT_MS = 300_000;
export const STALE_UPDATING_MS = 15 * 60 * 1000;
export const MAX_STATE_ERROR_CHARS = 240;
export const MAX_SELF_CHECK_CANDIDATES = 3;

export function selectSelfCheckCandidates(
  models: FreeModel[],
  statusFile?: StatusFile,
  maxCandidates = MAX_SELF_CHECK_CANDIDATES
): FreeModel[] {
  const entries = statusFile?.entries ?? {};
  const availableWithIndex: Array<{ model: FreeModel; idx: number; checkedAtMs: number }> = [];
  const remaining: FreeModel[] = [];

  for (let idx = 0; idx < models.length; idx++) {
    const model = models[idx];
    const entry = entries[statusKey(model.provider || "cline", model.id)];
    if (entry && typeof entry === "object" && entry.state === "available") {
      const parsed = typeof entry.checked_at === "string" ? Date.parse(entry.checked_at) : NaN;
      const checkedAtMs = Number.isFinite(parsed) ? parsed : -Infinity;
      availableWithIndex.push({ model, idx, checkedAtMs });
    } else {
      remaining.push(model);
    }
  }

  availableWithIndex.sort((a, b) => {
    if (b.checkedAtMs !== a.checkedAtMs) {
      return b.checkedAtMs - a.checkedAtMs;
    }
    return a.idx - b.idx;
  });

  return [...availableWithIndex.map((x) => x.model), ...remaining].slice(0, maxCandidates);
}

const VALID_UPDATE_STATES = new Set<UpdateState>([
  "ok",
  "update_available",
  "updating",
  "rolled_back",
  "broken"
]);

export function resolveStatePath(overridePath: null): undefined;
export function resolveStatePath(overridePath?: string): string;
export function resolveStatePath(overridePath?: string | null): string | undefined;
export function resolveStatePath(overridePath?: string | null): string | undefined {
  if (overridePath === null) return undefined;
  if (overridePath) return path.resolve(overridePath);
  if (process.env.CLINE_MCP_STATE_PATH) return path.resolve(process.env.CLINE_MCP_STATE_PATH);
  return path.join(os.homedir(), ".cline-mcp", "state.json");
}

export function sanitizeStateReason(text: string | null | undefined): string | null {
  if (text === null || text === undefined) return null;
  const cleaned = redactSecrets(String(text)).replace(/\r?\n/g, " ").trim();
  if (!cleaned) return null;
  return cleaned.length > MAX_STATE_ERROR_CHARS
    ? cleaned.slice(0, MAX_STATE_ERROR_CHARS - 1) + "…"
    : cleaned;
}

export type SyncHookFn = (state: BridgeStateFile) => void | Promise<void>;
let customSyncHook: SyncHookFn | undefined;

export function setSyncHook(hook: SyncHookFn | undefined): void {
  customSyncHook = hook;
}

/**
 * Future Supabase sync hook (see plan/cline-bridge-v2/future-supabase.md).
 * No-op by default; called after every state write and must never throw outward.
 */
export function syncHook(state: BridgeStateFile): void {
  if (!customSyncHook) return;
  try {
    const res = customSyncHook(state);
    if (res && typeof (res as Promise<void>).catch === "function") {
      void (res as Promise<void>).catch(() => {});
    }
  } catch {
    // Must never throw outward
  }
}

export interface ParsedSemver {
  major: number;
  minor: number;
  patch: number;
  prerelease: Array<string | number>;
}

export function parseSemver(version: string | null | undefined): ParsedSemver | null {
  if (!version || typeof version !== "string") return null;
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(version.trim());
  if (!match) return null;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);
  if (!Number.isSafeInteger(major) || !Number.isSafeInteger(minor) || !Number.isSafeInteger(patch)) return null;
  const prerelease = match[4]
    ? match[4].split(".").map((part) => (/^\d+$/.test(part) ? Number(part) : part))
    : [];
  return { major, minor, patch, prerelease };
}

export function compareSemver(a: string, b: string): number {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (!pa || !pb) return 0;
  if (pa.major !== pb.major) return pa.major - pb.major;
  if (pa.minor !== pb.minor) return pa.minor - pb.minor;
  if (pa.patch !== pb.patch) return pa.patch - pb.patch;
  if (pa.prerelease.length === 0 && pb.prerelease.length === 0) return 0;
  if (pa.prerelease.length === 0) return 1;
  if (pb.prerelease.length === 0) return -1;
  const len = Math.max(pa.prerelease.length, pb.prerelease.length);
  for (let i = 0; i < len; i++) {
    const ia = pa.prerelease[i];
    const ib = pb.prerelease[i];
    if (ia === undefined) return -1;
    if (ib === undefined) return 1;
    if (ia === ib) continue;
    if (typeof ia === "number" && typeof ib === "number") return ia - ib;
    if (typeof ia === "number") return -1;
    if (typeof ib === "number") return 1;
    return ia < ib ? -1 : 1;
  }
  return 0;
}

/**
 * Returns true if `candidate` is a valid semver strictly newer than `installedVersion`
 * AND strictly newer than every version in `failedVersions` ("Versions <= a failed version
 * are never offered; only newer ones").
 */
export function isVersionOfferable(
  candidate: string | null | undefined,
  installedVersion: string,
  failedVersions: FailedVersionEntry[]
): boolean {
  if (!candidate || !parseSemver(candidate)) return false;
  if (!installedVersion || installedVersion === "unknown" || !parseSemver(installedVersion)) {
    return false;
  }
  if (compareSemver(candidate, installedVersion) <= 0) {
    return false;
  }
  for (const failed of failedVersions) {
    if (failed.version === candidate) return false;
    if (parseSemver(failed.version) && compareSemver(candidate, failed.version) <= 0) {
      return false;
    }
  }
  return true;
}

export interface NpmCommandResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

export interface CliStateDeps {
  statePath?: string;
  catalogPath?: string;
  statusPath?: string;
  providerSettingsPath?: string;
  entryPath?: string;
  importModule?: ModelCatalogDeps["importModule"];
  stat?: ModelCatalogDeps["stat"];
  readFile?: ModelCatalogDeps["readFile"];
  wallNow?: () => number;
  now?: () => number;
  pid?: number;
  isProcessAlive?: (pid: number) => boolean;
  acquireStateMutex?: MutexOptions["acquireSettingsMutex"];
  acquireSettingsMutex?: MutexOptions["acquireSettingsMutex"];
  stateLockTimeoutMs?: number;
  updateLockAcquireTimeoutMs?: number;
  checkTimeoutMs?: number;
  installTimeoutMs?: number;
  syncHook?: SyncHookFn;
  /** Injectable check for `npm view cline version` (30 s timeout). */
  checkLatestVersion?: (signal?: AbortSignal) => Promise<string>;
  /** Injectable installer for `npm install -g cline@<v>` (300 s timeout). */
  installCli?: (version: string, signal?: AbortSignal) => Promise<void>;
  /** Low-level injectable npm runner used when checkLatestVersion/installCli are not provided. */
  execNpm?: (args: string[], options: { timeoutMs: number; signal?: AbortSignal }) => Promise<NpmCommandResult>;
  /** Injectable catalog loader for post-install self-check (defaults to listFreeModels). */
  listModels?: (deps?: ModelCatalogDeps) => Promise<FreeModelList>;
  /** Injectable ping runner for post-install self-check (defaults to clinePing). */
  pingModel?: (input: ClinePingInput, signal?: AbortSignal, deps?: ClineDependencies) => Promise<ClinePingResult>;
  /** Extra ClineDependencies passed to default clinePing during self-check. */
  pingDeps?: ClineDependencies;
}

const pendingMachineIds = new Map<string, string>();

function getOrCreateMachineId(statePath: string): string {
  const resolved = path.resolve(statePath);
  let id = pendingMachineIds.get(resolved);
  if (!id) {
    id = randomUUID();
    pendingMachineIds.set(resolved, id);
  }
  return id;
}

function emptyStateFile(
  statePath: string,
  nowMs: number,
  cliVersion = "unknown",
  catalogVersion = "unknown"
): BridgeStateFile {
  const iso = new Date(nowMs).toISOString();
  return {
    version: 1,
    machine_id: getOrCreateMachineId(statePath),
    updated_at: iso,
    cli: {
      version: cliVersion,
      catalog_version: catalogVersion,
      update_state: "ok",
      latest_known_version: null,
      last_check_at: null,
      previous_version: null,
      last_error: null,
      failed_versions: []
    }
  };
}

function normalizeStateFile(
  raw: any,
  statePath: string,
  nowMs: number,
  fallbackVersions?: { cliVersion?: string; catalogVersion?: string }
): BridgeStateFile {
  const fallbackIso = new Date(nowMs).toISOString();
  const machineId = typeof raw?.machine_id === "string" && raw.machine_id.trim()
    ? raw.machine_id.trim()
    : getOrCreateMachineId(statePath);
  pendingMachineIds.set(path.resolve(statePath), machineId);

  const rawCli = raw?.cli && typeof raw.cli === "object" && !Array.isArray(raw.cli) ? raw.cli : {};
  const updateState: UpdateState = VALID_UPDATE_STATES.has(rawCli.update_state) ? rawCli.update_state : "ok";
  const failedVersions: FailedVersionEntry[] = Array.isArray(rawCli.failed_versions)
    ? rawCli.failed_versions
        .filter((f: any) => f && typeof f === "object" && typeof f.version === "string" && f.version.trim())
        .map((f: any) => ({
          version: f.version.trim(),
          failed_at: typeof f.failed_at === "string" && Number.isFinite(Date.parse(f.failed_at))
            ? f.failed_at
            : fallbackIso,
          reason: sanitizeStateReason(typeof f.reason === "string" ? f.reason : "update failed") ?? "update failed"
        }))
    : [];

  const cli: CliStateInfo = {
    version: typeof rawCli.version === "string" && rawCli.version.trim()
      ? rawCli.version.trim()
      : fallbackVersions?.cliVersion ?? "unknown",
    catalog_version: typeof rawCli.catalog_version === "string" && rawCli.catalog_version.trim()
      ? rawCli.catalog_version.trim()
      : fallbackVersions?.catalogVersion ?? "unknown",
    update_state: updateState,
    latest_known_version: typeof rawCli.latest_known_version === "string" && rawCli.latest_known_version.trim()
      ? rawCli.latest_known_version.trim()
      : null,
    last_check_at: typeof rawCli.last_check_at === "string" && Number.isFinite(Date.parse(rawCli.last_check_at))
      ? rawCli.last_check_at
      : null,
    previous_version: typeof rawCli.previous_version === "string" && rawCli.previous_version.trim()
      ? rawCli.previous_version.trim()
      : null,
    last_error: sanitizeStateReason(typeof rawCli.last_error === "string" ? rawCli.last_error : null),
    failed_versions: failedVersions
  };

  if (updateState === "updating") {
    if (typeof rawCli.updating_pid === "number" && Number.isInteger(rawCli.updating_pid)) {
      cli.updating_pid = rawCli.updating_pid;
    }
    if (typeof rawCli.updating_started_at === "string" && Number.isFinite(Date.parse(rawCli.updating_started_at))) {
      cli.updating_started_at = rawCli.updating_started_at;
    }
  }

  return {
    version: 1,
    machine_id: machineId,
    updated_at: typeof raw?.updated_at === "string" && Number.isFinite(Date.parse(raw.updated_at))
      ? raw.updated_at
      : fallbackIso,
    cli
  };
}

export async function readStateFile(statePath?: string, deps: CliStateDeps = {}): Promise<BridgeStateFile> {
  const resolved = resolveStatePath(statePath ?? deps.statePath);
  const nowMs = (deps.wallNow ?? Date.now)();
  try {
    const text = (await readFile(resolved, "utf8")).replace(/^\uFEFF/, "");
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const hasCliVer = typeof parsed?.cli?.version === "string" && Boolean(parsed.cli.version.trim());
      const hasCatVer = typeof parsed?.cli?.catalog_version === "string" && Boolean(parsed.cli.catalog_version.trim());
      if (hasCliVer && hasCatVer) {
        return normalizeStateFile(parsed, resolved, nowMs);
      }
      const installed = await readInstalledCliVersions({
        entryPath: deps.entryPath,
        stat: deps.stat,
        readFile: deps.readFile
      });
      return normalizeStateFile(parsed, resolved, nowMs, installed);
    }
  } catch {
    // Missing or unreadable state file falls back to initial state
  }
  const installed = await readInstalledCliVersions({
    entryPath: deps.entryPath,
    stat: deps.stat,
    readFile: deps.readFile
  });
  return emptyStateFile(
    resolved,
    nowMs,
    installed?.cliVersion ?? "unknown",
    installed?.catalogVersion ?? "unknown"
  );
}

async function runSyncHookSafely(state: BridgeStateFile, deps: CliStateDeps): Promise<void> {
  try {
    if (deps.syncHook) {
      await deps.syncHook(state);
    } else {
      syncHook(state);
    }
  } catch {
    // Never throw outward
  }
}

let stateWriteQueue: Promise<unknown> = Promise.resolve();

export function mutateStateFile(
  statePath: string | undefined,
  mutator: (current: BridgeStateFile) => BridgeStateFile | Promise<BridgeStateFile>,
  deps: CliStateDeps = {}
): Promise<BridgeStateFile> {
  const resolved = resolveStatePath(statePath ?? deps.statePath);
  const acquire = deps.acquireStateMutex ?? deps.acquireSettingsMutex ?? acquireSettingsMutex;
  const wallNow = deps.wallNow ?? Date.now;

  const task = stateWriteQueue.then(async () => {
    const release = await acquire(resolved, undefined, {
      lockTimeoutMs: deps.stateLockTimeoutMs ?? 5_000,
      nowFn: deps.now
    });
    try {
      const current = await readStateFile(resolved, deps);
      const preservedMachineId = current.machine_id;
      const updated = await mutator(current);
      const nowMs = wallNow();
      const normalized = normalizeStateFile(
        {
          ...updated,
          version: 1,
          machine_id: preservedMachineId,
          updated_at: new Date(nowMs).toISOString()
        },
        resolved,
        nowMs
      );
      await atomicWriteJson(resolved, normalized);
      await runSyncHookSafely(normalized, deps);
      return normalized;
    } finally {
      await release();
    }
  });
  stateWriteQueue = task.catch(() => {});
  return task;
}

export function writeStateFile(
  statePath: string | undefined,
  state: BridgeStateFile,
  deps: CliStateDeps = {}
): Promise<BridgeStateFile> {
  return mutateStateFile(statePath, () => state, deps);
}

export function isStaleUpdating(state: BridgeStateFile, deps: CliStateDeps = {}): boolean {
  if (state.cli.update_state !== "updating") return false;
  const nowMs = (deps.wallNow ?? Date.now)();
  const startedIso = state.cli.updating_started_at ?? state.updated_at;
  const startedMs = Date.parse(startedIso);
  if (!Number.isFinite(startedMs) || nowMs - startedMs < STALE_UPDATING_MS) {
    return false;
  }
  const pid = state.cli.updating_pid;
  if (typeof pid === "number" && Number.isInteger(pid)) {
    const aliveFn = deps.isProcessAlive ?? isProcessAlive;
    if (aliveFn(pid)) return false;
  }
  return true;
}

function recoverStaleStateInPlace(state: BridgeStateFile): boolean {
  const canOffer = isVersionOfferable(
    state.cli.latest_known_version,
    state.cli.version,
    state.cli.failed_versions
  );
  delete state.cli.updating_pid;
  delete state.cli.updating_started_at;
  state.cli.update_state = canOffer
    ? "update_available"
    : state.cli.failed_versions.length > 0 && state.cli.previous_version
      ? "rolled_back"
      : "ok";
  state.cli.last_error = sanitizeStateReason("recovered stale updating state");
  return true;
}

export function formatCliReplyStatus(state: BridgeStateFile): CliReplyStatus {
  const out: CliReplyStatus = {
    state: state.cli.update_state,
    version: state.cli.version
  };
  if (
    state.cli.latest_known_version &&
    (state.cli.update_state === "update_available" ||
      state.cli.update_state === "updating" ||
      state.cli.latest_known_version !== state.cli.version)
  ) {
    out.latest = state.cli.latest_known_version;
  }
  if (state.cli.failed_versions.length > 0) {
    const lastFailed = state.cli.failed_versions[state.cli.failed_versions.length - 1];
    out.failed = {
      version: lastFailed.version,
      reason: lastFailed.reason
    };
  }
  return out;
}

export function attachCliToObject<T extends Record<string, unknown>>(
  payload: T,
  state: BridgeStateFile | undefined,
  options?: { always?: boolean }
): T & { cli?: CliReplyStatus } {
  if (!state) return payload;
  if (!options?.always && state.cli.update_state === "ok") {
    return payload;
  }
  return {
    ...payload,
    cli: formatCliReplyStatus(state)
  };
}

export function attachCliToText(
  text: string,
  state: BridgeStateFile | undefined,
  options?: { always?: boolean }
): string {
  if (!state) return text;
  if (!options?.always && state.cli.update_state === "ok") {
    return text;
  }
  const cli = formatCliReplyStatus(state);
  return `${text}\n\ncli: ${JSON.stringify(cli)}`;
}

export function defaultExecNpm(
  args: string[],
  options: { timeoutMs: number; signal?: AbortSignal }
): Promise<NpmCommandResult> {
  if (process.env.NODE_TEST_CONTEXT && process.env.CLINE_MCP_ALLOW_REAL_NPM !== "1") {
    return Promise.reject(new Error("Real npm execution is disabled during tests; inject a fake runner."));
  }
  return new Promise<NpmCommandResult>((resolve, reject) => {
    if (options.signal?.aborted) {
      reject(new Error("npm command was cancelled before start."));
      return;
    }
    const isWin = process.platform === "win32";
    const cmd = isWin ? "npm.cmd" : "npm";
    let settled = false;
    let timedOut = false;
    let stdout = "";
    let stderr = "";

    const child = spawn(cmd, args, {
      shell: isWin,
      windowsHide: true,
      detached: !isWin,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, NO_UPDATE_NOTIFIER: "1", NPM_CONFIG_FUND: "false", NPM_CONFIG_AUDIT: "false" }
    });

    const cleanup = () => {
      if (settled) return false;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      return true;
    };

    const killChild = () => {
      if (typeof child.pid === "number") {
        defaultKillTree(child.pid, "SIGKILL", process.platform);
      } else {
        try { child.kill("SIGKILL"); } catch {}
      }
    };

    const timer = setTimeout(() => {
      timedOut = true;
      killChild();
      if (cleanup()) {
        reject(new Error(`npm ${args[0] ?? "command"} timed out after ${Math.round(options.timeoutMs / 1000)}s.`));
      }
    }, options.timeoutMs);
    timer.unref?.();

    const onAbort = () => {
      killChild();
      if (cleanup()) {
        reject(new Error(`npm ${args[0] ?? "command"} was cancelled.`));
      }
    };
    options.signal?.addEventListener("abort", onAbort, { once: true });

    child.stdout?.on("data", (chunk: Buffer | string) => { stdout += chunk.toString(); });
    child.stderr?.on("data", (chunk: Buffer | string) => { stderr += chunk.toString(); });

    child.once("error", (err) => {
      if (cleanup()) reject(err);
    });
    child.once("close", (code) => {
      if (cleanup()) {
        if (timedOut) {
          reject(new Error(`npm ${args[0] ?? "command"} timed out after ${Math.round(options.timeoutMs / 1000)}s.`));
          return;
        }
        resolve({ stdout, stderr, exitCode: code });
      }
    });
  });
}

async function runCheckLatestVersion(deps: CliStateDeps, signal?: AbortSignal): Promise<string> {
  const timeoutMs = deps.checkTimeoutMs ?? CHECK_TIMEOUT_MS;
  if (deps.checkLatestVersion) {
    let timer: NodeJS.Timeout | undefined;
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    if (signal?.aborted) controller.abort();
    else signal?.addEventListener("abort", onAbort, { once: true });
    try {
      const result = await Promise.race([
        deps.checkLatestVersion(controller.signal),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            controller.abort();
            reject(new Error(`npm view timed out after ${Math.round(timeoutMs / 1000)}s.`));
          }, timeoutMs);
          timer.unref?.();
        })
      ]);
      return String(result).trim();
    } finally {
      if (timer) clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
  }
  const exec = deps.execNpm ?? defaultExecNpm;
  const res = await exec(["view", "cline", "version"], { timeoutMs, signal });
  if (res.exitCode !== 0) {
    throw new Error(res.stderr.trim() || `npm view exited with code ${res.exitCode}`);
  }
  return res.stdout.trim();
}

async function runInstallCliVersion(version: string, deps: CliStateDeps, signal?: AbortSignal): Promise<void> {
  const cleanVersion = version.trim().replace(/^v/i, "");
  if (!parseSemver(cleanVersion) || !/^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/.test(cleanVersion)) {
    throw new Error(`Invalid CLI version "${version}" for install.`);
  }
  const timeoutMs = deps.installTimeoutMs ?? INSTALL_TIMEOUT_MS;
  if (deps.installCli) {
    let timer: NodeJS.Timeout | undefined;
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    if (signal?.aborted) controller.abort();
    else signal?.addEventListener("abort", onAbort, { once: true });
    try {
      await Promise.race([
        deps.installCli(cleanVersion, controller.signal),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            controller.abort();
            reject(new Error(`npm install timed out after ${Math.round(timeoutMs / 1000)}s.`));
          }, timeoutMs);
          timer.unref?.();
        })
      ]);
      return;
    } finally {
      if (timer) clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
  }
  const exec = deps.execNpm ?? defaultExecNpm;
  const res = await exec(["install", "-g", `cline@${cleanVersion}`], { timeoutMs, signal });
  if (res.exitCode !== 0) {
    throw new Error(res.stderr.trim() || `npm install exited with code ${res.exitCode}`);
  }
}

export class CliStateManager {
  private shuttingDown = false;
  private backgroundPromise: Promise<void> | undefined;
  private activeInstallPromise: Promise<void> | undefined;

  constructor(private readonly defaultDeps: CliStateDeps = {}) {}

  private mergeDeps(override?: CliStateDeps): CliStateDeps {
    return override ? { ...this.defaultDeps, ...override } : this.defaultDeps;
  }

  public notifyShutdown(): void {
    this.shuttingDown = true;
  }

  public isShuttingDown(): boolean {
    return this.shuttingDown;
  }

  public async waitForBackgroundWork(): Promise<void> {
    while (this.backgroundPromise || this.activeInstallPromise) {
      const p1 = this.backgroundPromise;
      const p2 = this.activeInstallPromise;
      await Promise.allSettled([p1, p2].filter(Boolean));
      if (this.backgroundPromise === p1 && this.activeInstallPromise === p2) break;
    }
  }

  public async waitForActiveUpdate(): Promise<void> {
    if (this.activeInstallPromise) {
      await this.activeInstallPromise.catch(() => {});
    }
  }

  /**
   * 8.2 Catalog follows the CLI: cheaply compares the installed `cline` and `@cline/llms`
   * `package.json` versions (cached by file mtime) with `state.json`; on change reloads
   * the catalog with `?v=<version>`, rewrites `catalog.json`, and updates `state.json`.
   */
  public async syncCatalogIfChanged(
    overrideDeps?: CliStateDeps
  ): Promise<{ state: BridgeStateFile; reloaded: boolean; catalog?: FreeModelList }> {
    const deps = this.mergeDeps(overrideDeps);
    const statePath = resolveStatePath(deps.statePath);
    const catalogPath = resolveCatalogPath(deps.catalogPath);
    const wallNow = deps.wallNow ?? Date.now;

    let stateExists = true;
    try {
      await access(statePath);
    } catch {
      stateExists = false;
    }

    const installed = await readInstalledCliVersions({
      entryPath: deps.entryPath,
      stat: deps.stat,
      readFile: deps.readFile
    });

    let state = await readStateFile(statePath, deps);

    if (isStaleUpdating(state, deps)) {
      state = await mutateStateFile(
        statePath,
        (curr) => {
          if (isStaleUpdating(curr, deps)) {
            recoverStaleStateInPlace(curr);
          }
          return curr;
        },
        deps
      );
    }

    if (!installed) {
      if (!stateExists) {
        state = await writeStateFile(statePath, state, deps);
      }
      return { state, reloaded: false };
    }

    let catalogExists = true;
    if (catalogPath) {
      try {
        await access(catalogPath);
      } catch {
        catalogExists = false;
      }
    }

    const versionChanged =
      !stateExists ||
      !catalogExists ||
      (installed.cliVersion !== undefined && installed.cliVersion !== state.cli.version) ||
      (installed.catalogVersion !== undefined && installed.catalogVersion !== state.cli.catalog_version);

    if (!versionChanged || state.cli.update_state === "updating") {
      return { state, reloaded: false };
    }

    const bustVersion =
      installed.catalogVersion !== undefined && installed.catalogVersion !== state.cli.catalog_version
        ? installed.catalogVersion
        : installed.cliVersion !== undefined && installed.cliVersion !== state.cli.version
          ? installed.cliVersion
          : installed.catalogVersion ?? installed.cliVersion ?? String(wallNow());
    const listFn = deps.listModels ?? listFreeModels;
    let catalog: FreeModelList | undefined;
    try {
      catalog = await listFn({
        entryPath: deps.entryPath,
        importModule: deps.importModule,
        statusPath: deps.statusPath,
        statePath,
        stat: deps.stat,
        readFile: deps.readFile,
        cacheBust: bustVersion
      });
      if (catalogPath) {
        await writeCatalogSnapshot(catalog, catalogPath, wallNow());
      }
    } catch {
      // If catalog reload fails (e.g., mock entryPath without @cline/llms), still record known versions
    }

    const nextCliVersion = catalog?.source.cliVersion ?? installed.cliVersion ?? state.cli.version;
    const nextCatalogVersion = catalog?.source.version ?? installed.catalogVersion ?? state.cli.catalog_version;

    state = await mutateStateFile(
      statePath,
      (curr) => {
        curr.cli.version = nextCliVersion;
        curr.cli.catalog_version = nextCatalogVersion;
        if (
          curr.cli.update_state === "update_available" &&
          !isVersionOfferable(curr.cli.latest_known_version, curr.cli.version, curr.cli.failed_versions)
        ) {
          curr.cli.update_state = "ok";
        }
        return curr;
      },
      deps
    );

    return { state, reloaded: catalog !== undefined, catalog };
  }

  /**
   * 8.5 Daily check: runs `npm view cline version` (30 s timeout).
   * If newer than installed and > all failed_versions -> `update_available`.
   */
  public async checkForUpdates(overrideDeps?: CliStateDeps): Promise<BridgeStateFile> {
    const deps = this.mergeDeps(overrideDeps);
    if (this.shuttingDown) {
      return readStateFile(deps.statePath, deps);
    }
    const statePath = resolveStatePath(deps.statePath);
    const wallNow = deps.wallNow ?? Date.now;

    // Claim the daily check under state lock so concurrent calls/bridges do not duplicate npm view
    let shouldRunCheck = false;
    let state = await mutateStateFile(
      statePath,
      (curr) => {
        if (isStaleUpdating(curr, deps)) {
          recoverStaleStateInPlace(curr);
        }
        if (curr.cli.update_state === "updating") {
          return curr;
        }
        const nowMs = wallNow();
        const lastCheckMs = curr.cli.last_check_at ? Date.parse(curr.cli.last_check_at) : NaN;
        if (!Number.isFinite(lastCheckMs) || nowMs - lastCheckMs >= DAILY_CHECK_INTERVAL_MS) {
          curr.cli.last_check_at = new Date(nowMs).toISOString();
          shouldRunCheck = true;
        }
        return curr;
      },
      deps
    );

    if (!shouldRunCheck) {
      return state;
    }

    try {
      const latestRaw = await runCheckLatestVersion(deps);
      const latest = latestRaw.replace(/^v/i, "").trim();
      if (!parseSemver(latest)) {
        throw new Error(`Invalid version returned by npm view: ${JSON.stringify(latestRaw)}`);
      }
      state = await mutateStateFile(
        statePath,
        (curr) => {
          curr.cli.last_check_at = new Date(wallNow()).toISOString();
          curr.cli.latest_known_version = latest;
          if (!curr.cli.version || curr.cli.version === "unknown" || !parseSemver(curr.cli.version)) {
            curr.cli.last_error = sanitizeStateReason("cannot start update: installed CLI version is unknown");
            return curr;
          }
          if (curr.cli.update_state !== "updating" && curr.cli.update_state !== "broken") {
            if (isVersionOfferable(latest, curr.cli.version, curr.cli.failed_versions)) {
              curr.cli.update_state = "update_available";
              curr.cli.last_error = null;
            }
          }
          return curr;
        },
        deps
      );
    } catch (err: any) {
      state = await mutateStateFile(
        statePath,
        (curr) => {
          curr.cli.last_error = sanitizeStateReason(err?.message ?? String(err));
          return curr;
        },
        deps
      );
    }

    return state;
  }

  /**
   * 8.6 Safe update: installs `latest_known_version` only when the settings journal has no live runs,
   * holds the settings mutex during install + self-check + any rollback, verifies via `listFreeModels()`
   * and `clinePing` on the first catalog model, and rolls back automatically on failure.
   */
  public async runSafeUpdate(overrideDeps?: CliStateDeps): Promise<BridgeStateFile> {
    const deps = this.mergeDeps(overrideDeps);
    if (this.shuttingDown) {
      return readStateFile(deps.statePath, deps);
    }
    if (this.activeInstallPromise) {
      await this.activeInstallPromise.catch(() => {});
      return readStateFile(deps.statePath, deps);
    }

    const work = this.executeSafeUpdate(deps);
    this.activeInstallPromise = work.then(
      () => {},
      () => {}
    );
    try {
      return await work;
    } finally {
      if (this.activeInstallPromise) {
        this.activeInstallPromise = undefined;
      }
    }
  }

  private async executeSafeUpdate(deps: CliStateDeps): Promise<BridgeStateFile> {
    const statePath = resolveStatePath(deps.statePath);
    const settingsPath = resolveProviderSettingsPath(deps.providerSettingsPath);
    const catalogPath = resolveCatalogPath(deps.catalogPath);
    const statusPath = resolveStatusPath(deps.statusPath);
    const wallNow = deps.wallNow ?? Date.now;
    const pid = deps.pid ?? process.pid;

    // Step 1: Quick state inspection (and stale updating recovery) before touching the settings mutex
    let preState = await readStateFile(statePath, deps);
    if (isStaleUpdating(preState, deps)) {
      preState = await mutateStateFile(
        statePath,
        (curr) => {
          if (isStaleUpdating(curr, deps)) {
            recoverStaleStateInPlace(curr);
          }
          return curr;
        },
        deps
      );
    }

    if (
      !this.shuttingDown &&
      (!preState.cli.version || preState.cli.version === "unknown" || !parseSemver(preState.cli.version))
    ) {
      return mutateStateFile(
        statePath,
        (curr) => {
          curr.cli.last_error = sanitizeStateReason("cannot start update: installed CLI version is unknown");
          if (curr.cli.update_state === "update_available" || curr.cli.update_state === "updating") {
            curr.cli.update_state = "ok";
            delete curr.cli.updating_pid;
            delete curr.cli.updating_started_at;
          }
          return curr;
        },
        deps
      );
    }

    if (
      this.shuttingDown ||
      preState.cli.update_state !== "update_available" ||
      !isVersionOfferable(preState.cli.latest_known_version, preState.cli.version, preState.cli.failed_versions)
    ) {
      return preState;
    }

    // Step 2: Acquire settings mutex and hold it for the entire install + self-check + rollback
    const acquireSettings = deps.acquireSettingsMutex ?? acquireSettingsMutex;
    let releaseSettings: (() => Promise<void>) | undefined;
    try {
      releaseSettings = await acquireSettings(settingsPath, undefined, {
        lockTimeoutMs: deps.updateLockAcquireTimeoutMs ?? 5_000,
        nowFn: deps.now
      });
    } catch {
      // Settings lock is busy elsewhere; defer update to a later call
      return readStateFile(statePath, deps);
    }

    try {
      if (this.shuttingDown) {
        return await readStateFile(statePath, deps);
      }

      // Check settings journal for any live runs across all bridge processes on this machine
      const busy = await hasActiveRunsLocked(settingsPath, {
        wallNow,
        isProcessAlive: deps.isProcessAlive
      });
      if (busy) {
        return await readStateFile(statePath, deps);
      }

      // Step 3: Under state lock, claim the update (`update_state = "updating"`)
      let claimed = false;
      let oldVersion = "";
      let oldCatalogVersion = "";
      let targetVersion = "";

      const claimedState = await mutateStateFile(
        statePath,
        (curr) => {
          if (isStaleUpdating(curr, deps)) {
            recoverStaleStateInPlace(curr);
          }
          if (!curr.cli.version || curr.cli.version === "unknown" || !parseSemver(curr.cli.version)) {
            curr.cli.last_error = sanitizeStateReason("cannot start update: installed CLI version is unknown");
            if (curr.cli.update_state === "update_available" || curr.cli.update_state === "updating") {
              curr.cli.update_state = "ok";
              delete curr.cli.updating_pid;
              delete curr.cli.updating_started_at;
            }
            return curr;
          }
          if (
            this.shuttingDown ||
            curr.cli.update_state !== "update_available" ||
            !curr.cli.latest_known_version ||
            !isVersionOfferable(curr.cli.latest_known_version, curr.cli.version, curr.cli.failed_versions)
          ) {
            return curr;
          }
          oldVersion = curr.cli.version;
          oldCatalogVersion = curr.cli.catalog_version;
          targetVersion = curr.cli.latest_known_version.replace(/^v/i, "").trim();
          curr.cli.update_state = "updating";
          curr.cli.updating_pid = pid;
          curr.cli.updating_started_at = new Date(wallNow()).toISOString();
          claimed = true;
          return curr;
        },
        deps
      );

      if (!claimed) {
        return claimedState;
      }

      // Step 4: Run `npm install -g cline@<targetVersion>`, verify on-disk version, and run self-check
      const listFn = deps.listModels ?? listFreeModels;
      const pingFn = deps.pingModel ?? clinePing;

      try {
        await runInstallCliVersion(targetVersion, deps);
        clearVersionCache();

        const installedAfter = await readInstalledCliVersions({
          entryPath: deps.entryPath,
          stat: deps.stat,
          readFile: deps.readFile
        });
        const diskCliVersion = installedAfter?.cliVersion ?? "unknown";
        if (diskCliVersion !== targetVersion) {
          throw new Error(`npm reported success but installed version is ${diskCliVersion}`);
        }

        const list = await listFn({
          entryPath: deps.entryPath,
          importModule: deps.importModule,
          statusPath,
          statePath,
          stat: deps.stat,
          readFile: deps.readFile,
          cacheBust: targetVersion
        });

        if (!list.models || list.models.length === 0) {
          throw new Error("self-check failed: catalog returned no free models.");
        }

        if (catalogPath) {
          await writeCatalogSnapshot(list, catalogPath, wallNow()).catch(() => {});
        }

        const statusBeforeCheck = statusPath ? await readStatusFile(statusPath) : undefined;
        const candidates = selectSelfCheckCandidates(list.models, statusBeforeCheck, MAX_SELF_CHECK_CANDIDATES);

        // Pass a re-entrant no-op acquireSettingsMutex for default clinePing because we already hold the outer settings mutex
        const selfCheckPingDeps: ClineDependencies = {
          entryPath: deps.entryPath,
          providerSettingsPath: settingsPath,
          statusPath,
          wallNow,
          now: deps.now,
          ...deps.pingDeps,
          acquireSettingsMutex: async () => async () => {}
        };

        let anyAvailable = false;
        const failedCandidates: Array<{ id: string; state: string; reason?: string }> = [];

        for (const candidate of candidates) {
          const pingResult = await pingFn(
            { provider: candidate.provider || "cline", model: candidate.id, force: true },
            undefined,
            selfCheckPingDeps
          );
          if (
            !pingResult ||
            typeof pingResult !== "object" ||
            !("state" in pingResult) ||
            pingResult.state === "available"
          ) {
            anyAvailable = true;
            break;
          }
          failedCandidates.push({
            id: candidate.id,
            state: String(pingResult.state),
            reason: pingResult.reason
          });
        }

        if (!anyAvailable) {
          const summary = failedCandidates.map((c) => `${c.id}: ${c.state}`).join(", ");
          const details = failedCandidates
            .map((c) => c.reason)
            .filter((r): r is string => Boolean(r && r.trim()))
            .join("; ");
          throw new Error(
            details
              ? `self-check ping failed (${summary}): ${details}`
              : `self-check ping failed (${summary})`
          );
        }

        const newCliVersion = targetVersion;
        const newCatalogVersion = list.source.version ?? installedAfter?.catalogVersion ?? oldCatalogVersion;

        return await mutateStateFile(
          statePath,
          (curr) => {
            curr.cli.previous_version = oldVersion;
            curr.cli.version = newCliVersion;
            curr.cli.catalog_version = newCatalogVersion;
            curr.cli.update_state = "ok";
            curr.cli.last_error = null;
            delete curr.cli.updating_pid;
            delete curr.cli.updating_started_at;
            return curr;
          },
          deps
        );
      } catch (updateErr: any) {
        const failReason = sanitizeStateReason(updateErr?.message ?? String(updateErr)) ?? "update failed";
        const failedAt = new Date(wallNow()).toISOString();

        // Step 5: Rollback to oldVersion (never start rollback if oldVersion is "unknown")
        let rolledBackOk = false;
        let rollbackErrMessage: string | undefined;
        if (!oldVersion || oldVersion === "unknown" || !parseSemver(oldVersion)) {
          rollbackErrMessage = "cannot roll back: previous CLI version is unknown";
        } else {
          try {
            await runInstallCliVersion(oldVersion, deps);
            clearVersionCache();
            const installedRestored = await readInstalledCliVersions({
              entryPath: deps.entryPath,
              stat: deps.stat,
              readFile: deps.readFile
            });
            const restoredCliVersion = installedRestored?.cliVersion ?? "unknown";
            if (restoredCliVersion !== oldVersion) {
              throw new Error(`npm reported success but installed version is ${restoredCliVersion}`);
            }
            oldCatalogVersion = installedRestored?.catalogVersion ?? oldCatalogVersion;
            try {
              const restoredList = await listFn({
                entryPath: deps.entryPath,
                importModule: deps.importModule,
                statusPath,
                statePath,
                stat: deps.stat,
                readFile: deps.readFile,
                cacheBust: oldVersion
              });
              if (catalogPath) {
                await writeCatalogSnapshot(restoredList, catalogPath, wallNow()).catch(() => {});
              }
            } catch {
              // Best-effort catalog reload on rollback
            }
            rolledBackOk = true;
          } catch (rbErr: any) {
            rollbackErrMessage = rbErr?.message ?? String(rbErr);
          }
        }

        return await mutateStateFile(
          statePath,
          (curr) => {
            delete curr.cli.updating_pid;
            delete curr.cli.updating_started_at;
            const existingIdx = curr.cli.failed_versions.findIndex((f) => f.version === targetVersion);
            const entry: FailedVersionEntry = {
              version: targetVersion,
              failed_at: failedAt,
              reason: failReason
            };
            if (existingIdx >= 0) {
              curr.cli.failed_versions[existingIdx] = entry;
            } else {
              curr.cli.failed_versions.push(entry);
            }

            if (rolledBackOk) {
              curr.cli.version = oldVersion;
              curr.cli.catalog_version = oldCatalogVersion;
              curr.cli.update_state = "rolled_back";
              curr.cli.last_error = failReason;
            } else {
              curr.cli.update_state = "broken";
              curr.cli.last_error = sanitizeStateReason(
                `update to ${targetVersion} failed (${failReason}); rollback to ${oldVersion} failed: ${rollbackErrMessage ?? "unknown error"}`
              );
            }
            return curr;
          },
          deps
        );
      }
    } finally {
      await releaseSettings();
    }
  }

  /**
   * Per-tool-call hook:
   * 1. Cheaply compares installed CLI & catalog versions (mtime cached) and reloads catalog if changed.
   * 2. Recovers any stale `updating` state (> 15 min with dead PID).
   * 3. Starts background daily check (when `last_check_at` is null or > 24 h old) or retries a pending
   *    `update_available` install in the background without delaying the tool call.
   */
  public async onToolCall(overrideDeps?: CliStateDeps): Promise<BridgeStateFile> {
    const deps = this.mergeDeps(overrideDeps);
    const { state } = await this.syncCatalogIfChanged(deps);

    if (this.shuttingDown) {
      return state;
    }

    const nowMs = (deps.wallNow ?? Date.now)();
    const lastCheckMs = state.cli.last_check_at ? Date.parse(state.cli.last_check_at) : NaN;
    const checkDue = !Number.isFinite(lastCheckMs) || nowMs - lastCheckMs >= DAILY_CHECK_INTERVAL_MS;
    const canRunNpm =
      Boolean(deps.checkLatestVersion || deps.installCli || deps.execNpm) ||
      !process.env.NODE_TEST_CONTEXT ||
      process.env.CLINE_MCP_ALLOW_REAL_NPM === "1";

    if (canRunNpm && !this.backgroundPromise) {
      if (checkDue && state.cli.update_state !== "updating") {
        const bg: Promise<void> = (async () => {
          const afterCheck = await this.checkForUpdates(deps);
          if (!this.shuttingDown && afterCheck.cli.update_state === "update_available") {
            await this.runSafeUpdate(deps);
          }
        })()
          .catch(() => {})
          .finally(() => {
            if (this.backgroundPromise === bg) this.backgroundPromise = undefined;
          });
        this.backgroundPromise = bg;
      } else if (state.cli.update_state === "update_available") {
        const bg: Promise<void> = (async () => {
          await this.runSafeUpdate(deps);
        })()
          .catch(() => {})
          .finally(() => {
            if (this.backgroundPromise === bg) this.backgroundPromise = undefined;
          });
        this.backgroundPromise = bg;
      }
    }

    return state;
  }
}

export const defaultCliStateManager = new CliStateManager();

export function syncCatalogIfChanged(deps?: CliStateDeps) {
  return defaultCliStateManager.syncCatalogIfChanged(deps);
}

export function checkForCliUpdates(deps?: CliStateDeps) {
  return defaultCliStateManager.checkForUpdates(deps);
}

export function runSafeCliUpdate(deps?: CliStateDeps) {
  return defaultCliStateManager.runSafeUpdate(deps);
}

export function onToolCall(deps?: CliStateDeps) {
  return defaultCliStateManager.onToolCall(deps);
}

export function waitForCliBackgroundWork() {
  return defaultCliStateManager.waitForBackgroundWork();
}

export function waitForActiveCliUpdate() {
  return defaultCliStateManager.waitForActiveUpdate();
}

export function notifyCliStateShutdown() {
  defaultCliStateManager.notifyShutdown();
}
