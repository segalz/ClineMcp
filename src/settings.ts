import { readFile, writeFile, rename, unlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { ClineRunError } from "./runner.js";

export const PROHIBITED_NAMES = new Set(["__proto__", "constructor", "prototype"]);

type LockType = "read" | "write";

interface LockWaiter {
  type: LockType;
  resolve: (release: () => void) => void;
  reject: (err: any) => void;
  signal?: AbortSignal;
  abortHandler?: () => void;
}

export class AsyncRwLock {
  private activeReaders = 0;
  private activeWriter = false;
  private queue: LockWaiter[] = [];

  acquireRead(signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) {
      return Promise.reject(new ClineRunError("cancelled", "The Cline request was cancelled."));
    }

    if (!this.activeWriter && this.queue.length === 0) {
      this.activeReaders++;
      let released = false;
      return Promise.resolve(() => {
        if (released) return;
        released = true;
        this.activeReaders--;
        this.drainQueue();
      });
    }

    return new Promise<() => void>((resolve, reject) => {
      const waiter: LockWaiter = {
        type: "read",
        resolve,
        reject,
        signal
      };

      if (signal) {
        const abortHandler = () => {
          const index = this.queue.indexOf(waiter);
          if (index !== -1) {
            this.queue.splice(index, 1);
          }
          signal.removeEventListener("abort", abortHandler);
          reject(new ClineRunError("cancelled", "The Cline request was cancelled."));
          this.drainQueue();
        };
        waiter.abortHandler = abortHandler;
        signal.addEventListener("abort", abortHandler, { once: true });
      }

      this.queue.push(waiter);
    });
  }

  acquireWrite(signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) {
      return Promise.reject(new ClineRunError("cancelled", "The Cline request was cancelled."));
    }

    if (!this.activeWriter && this.activeReaders === 0 && this.queue.length === 0) {
      this.activeWriter = true;
      let released = false;
      return Promise.resolve(() => {
        if (released) return;
        released = true;
        this.activeWriter = false;
        this.drainQueue();
      });
    }

    return new Promise<() => void>((resolve, reject) => {
      const waiter: LockWaiter = {
        type: "write",
        resolve,
        reject,
        signal
      };

      if (signal) {
        const abortHandler = () => {
          const index = this.queue.indexOf(waiter);
          if (index !== -1) {
            this.queue.splice(index, 1);
          }
          signal.removeEventListener("abort", abortHandler);
          reject(new ClineRunError("cancelled", "The Cline request was cancelled."));
          this.drainQueue();
        };
        waiter.abortHandler = abortHandler;
        signal.addEventListener("abort", abortHandler, { once: true });
      }

      this.queue.push(waiter);
    });
  }

  async runExclusive<T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const release = await this.acquireWrite(signal);
    try {
      return await fn();
    } finally {
      release();
    }
  }

  private drainQueue(): void {
    if (this.activeWriter) return;

    while (this.queue.length > 0) {
      const next = this.queue[0];
      if (next.type === "write") {
        if (this.activeReaders === 0) {
          this.queue.shift();
          this.activeWriter = true;
          this.cleanupWaiter(next);
          let released = false;
          next.resolve(() => {
            if (released) return;
            released = true;
            this.activeWriter = false;
            this.drainQueue();
          });
        }
        return;
      }

      this.queue.shift();
      this.activeReaders++;
      this.cleanupWaiter(next);
      let released = false;
      next.resolve(() => {
        if (released) return;
        released = true;
        this.activeReaders--;
        this.drainQueue();
      });
    }
  }

  private cleanupWaiter(waiter: LockWaiter): void {
    if (waiter.signal && waiter.abortHandler) {
      waiter.signal.removeEventListener("abort", waiter.abortHandler);
    }
  }

  getState() {
    return {
      activeReaders: this.activeReaders,
      activeWriter: this.activeWriter,
      queueLength: this.queue.length
    };
  }
}

export const providerSettingsLock = new AsyncRwLock();
export const providerSettingsMutex = providerSettingsLock;

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
  originalModel?: string;
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
        targetProvider: requestedProvider,
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
  const targetProvider = requestedProvider || originalLastUsedProvider;

  let hadEntry = false;
  let originalModel: string | undefined;
  let hadModel = false;
  let originalReasoning: unknown;
  let hadReasoning = false;

  if (targetProvider) {
    const entry = getProviderEntry(data, targetProvider);
    if (entry) {
      hadEntry = true;
      if (isPlainObject(entry.settings)) {
        hadModel = Object.hasOwn(entry.settings, "model");
        originalModel = typeof entry.settings.model === "string" ? entry.settings.model : undefined;
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

async function atomicRename(source: string, destination: string): Promise<void> {
  try {
    await rename(source, destination);
  } catch (err: any) {
    if (process.platform === "win32" && (err?.code === "EPERM" || err?.code === "EBUSY")) {
      await new Promise((r) => setTimeout(r, 100));
      await rename(source, destination);
      return;
    }
    throw err;
  }
}

export async function restoreProviderSettingsSnapshot(
  snapshot: ProviderSettingsSnapshot
): Promise<boolean> {
  if (snapshot.skipRestore) {
    return false;
  }

  let content: string;
  try {
    content = await readFile(snapshot.settingsPath, "utf8");
  } catch {
    return false;
  }

  content = content.replace(/^\uFEFF/, "");

  let data: Record<string, any>;
  try {
    const parsed = JSON.parse(content);
    if (!isPlainObject(parsed)) {
      return false;
    }
    data = parsed;
  } catch {
    return false;
  }

  let changed = false;

  // 1. Restore lastUsedProvider
  if (snapshot.hadLastUsedProvider) {
    if (data.lastUsedProvider !== snapshot.originalLastUsedProvider) {
      data.lastUsedProvider = snapshot.originalLastUsedProvider;
      changed = true;
    }
  } else if (Object.hasOwn(data, "lastUsedProvider")) {
    delete data.lastUsedProvider;
    changed = true;
  }

  // 2. Restore target provider's settings.model and settings.reasoning ONLY if hadEntry was true
  if (snapshot.targetProvider && snapshot.hadEntry) {
    const entry = getProviderEntry(data, snapshot.targetProvider);
    if (entry && isPlainObject(entry.settings)) {
      if (snapshot.hadModel) {
        if (entry.settings.model !== snapshot.originalModel) {
          entry.settings.model = snapshot.originalModel;
          changed = true;
        }
      } else if (Object.hasOwn(entry.settings, "model")) {
        delete entry.settings.model;
        changed = true;
      }

      if (snapshot.hadReasoning) {
        if (JSON.stringify(entry.settings.reasoning) !== JSON.stringify(snapshot.originalReasoning)) {
          entry.settings.reasoning = snapshot.originalReasoning;
          changed = true;
        }
      } else if (Object.hasOwn(entry.settings, "reasoning")) {
        delete entry.settings.reasoning;
        changed = true;
      }
    }
  }

  if (!changed) {
    return false;
  }

  const dir = path.dirname(snapshot.settingsPath);
  const tempPath = path.join(dir, `.providers.${randomUUID()}.tmp`);
  try {
    await writeFile(tempPath, JSON.stringify(data, null, 2), { encoding: "utf8", mode: 0o600 });
    await atomicRename(tempPath, snapshot.settingsPath);
    return true;
  } catch (err) {
    try {
      await unlink(tempPath);
    } catch {
      // Ignore cleanup error
    }
    throw err;
  }
}

export async function withProviderOverride<T extends { warnings?: string[] }>(
  input: { provider?: string; model?: string },
  settingsPath: string,
  signal: AbortSignal | undefined,
  action: () => Promise<T>
): Promise<T> {
  const hasOverride = Boolean(input.provider || input.model);
  if (!hasOverride) {
    const release = await providerSettingsLock.acquireRead(signal);
    try {
      return await action();
    } finally {
      release();
    }
  }

  const release = await providerSettingsLock.acquireWrite(signal);
  try {
    const snapshot = await readProviderSettingsSnapshot(settingsPath, input.provider);

    let actionResult: T | undefined;
    let actionError: unknown;
    try {
      actionResult = await action();
    } catch (err) {
      actionError = err;
    }

    let restoreWarning: string | undefined;
    if (snapshot.warning) {
      restoreWarning = `Settings snapshot warning: ${snapshot.warning}`;
    } else if (!snapshot.skipRestore) {
      try {
        await restoreProviderSettingsSnapshot(snapshot);
      } catch (err: any) {
        restoreWarning = `Settings restore warning: ${err?.message || String(err)}`;
      }
    }

    if (actionError) {
      if (restoreWarning && typeof (actionError as any)?.message === "string") {
        (actionError as any).message += ` (Warning: ${restoreWarning})`;
      }
      throw actionError;
    }

    if (restoreWarning && actionResult) {
      actionResult.warnings = [...(actionResult.warnings ?? []), restoreWarning];
    }

    return actionResult!;
  } finally {
    release();
  }
}
