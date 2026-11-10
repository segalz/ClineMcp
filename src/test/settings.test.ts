import assert from "node:assert/strict";
import test, { after } from "node:test";
import { mkdtemp, readFile, writeFile, rm, unlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  acquireSettingsMutex, getSettingsMutexPath, getJournalPath, verifySocketOwnership,
  recoverProviderSettingsJournal, readProviderSettingsSnapshot,
  restoreProviderSettingsSnapshot, writeRestoreJournal, withProviderOverride,
  type ReleaseSettingsMutex
} from "../settings.js";
import { ClineRunError, runCline } from "../runner.js";
import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";
import { createServer } from "node:net";

// Runs here must never touch the real ~/.cline-mcp/* files or real trace directory.
const settingsTestEnvDir = await mkdtemp(path.join(os.tmpdir(), `cline-settings-env-${process.pid}-`));
process.env.CLINE_MCP_STATUS_PATH = path.join(settingsTestEnvDir, "status.json");
process.env.CLINE_MCP_CATALOG_PATH = path.join(settingsTestEnvDir, "catalog.json");
process.env.CLINE_MCP_STATE_PATH = path.join(settingsTestEnvDir, "state.json");
process.env.CLINE_MCP_TRACE_DIR = path.join(settingsTestEnvDir, "traces");
after(() => rm(settingsTestEnvDir, { recursive: true, force: true }));

const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>(r => { resolve = r; });
  return { promise, resolve };
};
async function fixture(fn: (file: string) => Promise<void>) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "cline-mutex-"));
  const file = path.join(dir, "providers.json");
  await writeFile(file, JSON.stringify({ lastUsedProvider: "default", providers: {
    default: { settings: { model: "baseline", reasoning: "low", apiKey: "never-journal-this" } }
  } }));
  try { await fn(file); } finally { await rm(dir, { recursive: true, force: true }); }
}
const json = async (file: string) => JSON.parse(await readFile(file, "utf8"));
// Each caller can represent a separate bridge process; ownership is shared only here.
function fakeMutex() {
  let owner: ReleaseSettingsMutex | undefined;
  const acquire: typeof acquireSettingsMutex = async (_file, signal, options = {}) => {
    const now = options.nowFn ?? (() => performance.now());
    const deadline = Math.min(options.deadline ?? Infinity, now() + (options.lockTimeoutMs ?? 30_000));
    while (owner) {
      if (signal?.aborted) throw new ClineRunError("cancelled", "Cancelled");
      if (now() >= deadline) throw new ClineRunError("settings_lock_timeout", "Mutex timeout");
      await (options.sleep ?? delay)(Math.min(1, deadline - now()));
    }
    const release = async () => { if (owner === release) owner = undefined; };
    owner = release;
    return release;
  };
  return { acquire, crash: async () => { await owner?.(); } };
}

test("overlapping overrides run concurrently; originals restored only after the last run ends", async () => fixture(async file => {
  const mutex = fakeMutex();
  const options = { acquireSettingsMutex: mutex.acquire, lockTimeoutMs: 50 };
  const entered = deferred();
  const finishFirst = deferred();
  const finishSecond = deferred();
  const secondEntered = deferred();
  let secondSelection: unknown;
  const first = withProviderOverride({ provider: "other", model: "one" }, file, undefined, async () => {
    // Simulate the CLI writing its selection back, as Cline 3.0.74 does.
    await writeFile(file, JSON.stringify({ lastUsedProvider: "other", providers: {
      default: { settings: { model: "baseline", reasoning: "low", apiKey: "never-journal-this" } },
      other: { settings: { model: "one" } } } }));
    entered.resolve(); await finishFirst.promise; return {};
  }, options);
  await entered.promise;
  // Model-only override while another run is live: provider comes from the user's original selection.
  const second = withProviderOverride({ provider: "default", model: "two" }, file, undefined, async selection => {
    secondSelection = selection; secondEntered.resolve(); await finishSecond.promise; return {};
  }, options);
  await secondEntered.promise;
  assert.deepEqual(secondSelection, { provider: "default", model: "two" });
  assert.equal(Object.keys((await json(getJournalPath(file))).runs).length, 2);
  finishFirst.resolve();
  await first;
  assert.equal((await json(file)).lastUsedProvider, "other", "must not restore while a run is live");
  assert.equal(Object.keys((await json(getJournalPath(file))).runs).length, 1);
  finishSecond.resolve();
  await second;
  const restored = await json(file);
  assert.equal(restored.lastUsedProvider, "default");
  assert.equal(restored.providers.default.settings.model, "baseline");
  assert.equal(restored.providers.other, undefined);
  await assert.rejects(readFile(getJournalPath(file)), { code: "ENOENT" });
}));

test("cleanup failure returns the result with a warning and the next call restores", async () => fixture(async file => {
  const mutex = fakeMutex();
  let failNextAcquire = false;
  const acquire: typeof acquireSettingsMutex = async (f, s, o) => {
    if (failNextAcquire) { failNextAcquire = false; throw new ClineRunError("settings_lock_timeout", "held elsewhere"); }
    return mutex.acquire(f, s, o);
  };
  const result = await withProviderOverride<{ warnings?: string[]; value: number }>({ provider: "default", model: "temp" }, file, undefined, async () => {
    await writeFile(file, JSON.stringify({ lastUsedProvider: "default", providers: { default: { settings: { model: "temp" } } } }));
    failNextAcquire = true;
    return { value: 7 };
  }, { acquireSettingsMutex: acquire });
  assert.equal(result.value, 7);
  assert.match(result.warnings?.[0] ?? "", /not restored yet/);
  assert.equal((await json(file)).providers.default.settings.model, "temp");
  assert.equal(await recoverProviderSettingsJournal(file, { acquireSettingsMutex: mutex.acquire }), "restored");
  assert.equal((await json(file)).providers.default.settings.model, "baseline");
}));

test("cleanup failure never masks the action's own error", async () => fixture(async file => {
  const mutex = fakeMutex();
  let failNextAcquire = false;
  const acquire: typeof acquireSettingsMutex = async (f, s, o) => {
    if (failNextAcquire) { failNextAcquire = false; throw new ClineRunError("settings_lock_timeout", "held elsewhere"); }
    return mutex.acquire(f, s, o);
  };
  await assert.rejects(withProviderOverride({ provider: "default", model: "temp" }, file, undefined, async () => {
    failNextAcquire = true; throw new Error("action failed");
  }, { acquireSettingsMutex: acquire }), /action failed/);
}));

test("a run left in the journal by a dead bridge process is pruned and the originals restored", async () => fixture(async file => {
  const mutex = fakeMutex();
  await writeFile(getJournalPath(file), JSON.stringify({ version: 2,
    base: { hadLastUsedProvider: true, originalLastUsedProvider: "default",
      providers: { default: { hadEntry: true, hadModel: true, originalModel: "baseline", hadReasoning: true, originalReasoning: "low" } } },
    runs: { dead: { pid: 999_999, provider: "default", startedAtMs: Date.now() } } }));
  await writeFile(file, JSON.stringify({ lastUsedProvider: "default", providers: { default: { settings: { model: "crashed", reasoning: "high" } } } }));
  const result = await recoverProviderSettingsJournal(file, { acquireSettingsMutex: mutex.acquire, isProcessAlive: pid => pid !== 999_999 });
  assert.equal(result, "restored");
  assert.equal((await json(file)).providers.default.settings.model, "baseline");
  await assert.rejects(readFile(getJournalPath(file)), { code: "ENOENT" });
}));

test("startup recovery keeps the journal while another live bridge process still has a run", async () => fixture(async file => {
  const mutex = fakeMutex();
  await writeFile(getJournalPath(file), JSON.stringify({ version: 2,
    base: { hadLastUsedProvider: true, originalLastUsedProvider: "default",
      providers: { default: { hadEntry: true, hadModel: true, originalModel: "baseline", hadReasoning: true, originalReasoning: "low" } } },
    runs: { live: { pid: 424_242, provider: "default", startedAtMs: Date.now() } } }));
  await writeFile(file, JSON.stringify({ lastUsedProvider: "default", providers: { default: { settings: { model: "in-use" } } } }));
  const result = await recoverProviderSettingsJournal(file, { acquireSettingsMutex: mutex.acquire, isProcessAlive: () => true });
  assert.equal(result, "unchanged");
  assert.equal((await json(file)).providers.default.settings.model, "in-use");
  assert.ok(await readFile(getJournalPath(file)));
}));

test("crash releases fake mutex but leaves journal: next override restores before snapshot", async () => fixture(async file => {
  const mutex = fakeMutex();
  await mutex.acquire(file);
  const snapshot = await readProviderSettingsSnapshot(file, "default");
  await writeRestoreJournal(getJournalPath(file), snapshot);
  await writeFile(file, JSON.stringify({ lastUsedProvider: "default", providers: { default: { settings: { model: "crashed", reasoning: "high", apiKey: "refreshed" } } } }));
  await mutex.crash();
  await withProviderOverride({ provider: "default", model: "next" }, file, undefined, async () => {
    assert.equal((await json(file)).providers.default.settings.model, "baseline");
    assert.equal((await json(getJournalPath(file))).base.providers.default.originalModel, "baseline");
    return {};
  }, { acquireSettingsMutex: mutex.acquire });
  assert.equal((await json(file)).providers.default.settings.apiKey, "refreshed");
  await assert.rejects(readFile(getJournalPath(file)), { code: "ENOENT" });
}));

test("failed recovery keeps journal and fails every override without overwriting or running", async () => fixture(async file => {
  const snapshot = await readProviderSettingsSnapshot(file, "default");
  await writeRestoreJournal(getJournalPath(file), snapshot);
  const original = await readFile(getJournalPath(file), "utf8");
  await writeFile(file, "invalid json");
  for (let n = 0; n < 2; n++) {
    await assert.rejects(withProviderOverride({ provider: "default", model: "next" }, file, undefined, async () => {
      assert.fail("must not run"); return {};
    }), (err: unknown) => err instanceof ClineRunError && err.kind === "settings_restore_failed");
    assert.equal(await readFile(getJournalPath(file), "utf8"), original);
  }
  await assert.rejects(writeRestoreJournal(getJournalPath(file), snapshot));
  assert.equal(await readFile(getJournalPath(file), "utf8"), original);
}));

test("new entry removed on restore; mid-run refreshed auth preserved without model/reasoning", async () => fixture(async file => {
  for (const auth of [false, true]) {
    await withProviderOverride({ provider: "new", model: "temporary" }, file, undefined, async () => {
      const journal = await readFile(getJournalPath(file), "utf8");
      assert.ok(!journal.includes("never-journal-this"));
      const data = await json(file);
      data.lastUsedProvider = "new";
      data.providers.new = { settings: { model: "temporary", reasoning: "high", ...(auth ? { accessToken: "fresh-token" } : {}) } };
      data.providers.default.settings.apiKey = "refreshed-existing";
      await writeFile(file, JSON.stringify(data));
      return {};
    });
    const data = await json(file);
    assert.equal(data.lastUsedProvider, "default");
    if (auth) assert.deepEqual(data.providers.new, { settings: { accessToken: "fresh-token" } });
    else assert.equal(data.providers.new, undefined);
    assert.equal(data.providers.default.settings.apiKey, "refreshed-existing");
  }
}));

test("runCline without both provider and model fails before touching settings, the mutex or Cline", async () => fixture(async file => {
  const before = await readFile(file, "utf8");
  for (const input of [{}, { provider: "default" }, { model: "baseline" }]) {
    await assert.rejects(runCline({ prompt: "hello", ...input }, undefined, { deps: {
      providerSettingsPath: file, entryPath: "fake", access: async () => {},
      acquireSettingsMutex: async () => { assert.fail("must not acquire the mutex"); },
      spawn: (() => { assert.fail("must not launch Cline"); }) as any
    } }), (err: unknown) => err instanceof ClineRunError && err.kind === "launch_failed" && err.attempts === 0 &&
      /provider and model are required/.test(err.message));
  }
  assert.equal(await readFile(file, "utf8"), before);
  await assert.rejects(readFile(getJournalPath(file)), { code: "ENOENT" });
}));

test("startup restores orphan journal, deletes unchanged journal, and retains failed recovery", async () => fixture(async file => {
  const snapshot = await readProviderSettingsSnapshot(file, "default");
  await writeRestoreJournal(getJournalPath(file), snapshot);
  const data = await json(file); data.providers.default.settings.model = "temporary";
  await writeFile(file, JSON.stringify(data));
  assert.equal(await recoverProviderSettingsJournal(file), "restored");
  await assert.rejects(readFile(getJournalPath(file)), { code: "ENOENT" });
  await writeRestoreJournal(getJournalPath(file), snapshot);
  assert.equal(await recoverProviderSettingsJournal(file), "unchanged");
  await assert.rejects(readFile(getJournalPath(file)), { code: "ENOENT" });
  await writeRestoreJournal(getJournalPath(file), snapshot);
  await writeFile(file, "malformed");
  assert.equal(await recoverProviderSettingsJournal(file), "failed");
  assert.ok(await readFile(getJournalPath(file)));
}));

test("startup mutex wait is bounded to ten seconds with fake clock", async () => fixture(async file => {
  let time = 0; const mutex = fakeMutex(); await mutex.acquire(file);
  await assert.rejects(recoverProviderSettingsJournal(file, {
    acquireSettingsMutex: mutex.acquire, nowFn: () => time, sleep: async ms => { time += ms; }
  }), (err: unknown) => err instanceof ClineRunError && err.kind === "settings_lock_timeout");
  assert.equal(time, 10_000); await mutex.crash();
}));

test("real OS pipe/socket mutex second acquisition waits for close", async () => fixture(async file => {
  if (process.platform === "win32") assert.match(getSettingsMutexPath(file), /^\\\\\.\\pipe\\cline-mcp-bridge-settings-[a-f0-9]{16}$/);
  const release = await acquireSettingsMutex(file);
  let acquired = false;
  const second = acquireSettingsMutex(file, undefined, { lockTimeoutMs: 2000 }).then(async close => { acquired = true; await close(); });
  try { await delay(40); assert.equal(acquired, false); } finally { await release(); }
  await second; assert.equal(acquired, true);
}));

test("real OS mutex timeout is clamped to remaining deadline and abort cancels waiter", async () => fixture(async file => {
  const release = await acquireSettingsMutex(file);
  try {
    const start = performance.now();
    await assert.rejects(acquireSettingsMutex(file, undefined, { deadline: start + 25, lockTimeoutMs: 10_000 }),
      (err: unknown) => err instanceof ClineRunError && err.kind === "settings_lock_timeout");
    const controller = new AbortController();
    const pending = acquireSettingsMutex(file, controller.signal);
    controller.abort();
    await assert.rejects(pending, (err: unknown) => err instanceof ClineRunError && err.kind === "cancelled");
  } finally { await release(); }
}));


test("end-of-run restore failure returns a warning, retains journal and blocks subsequent override", async () => fixture(async file => {
  const mutex = fakeMutex();
  const result = await withProviderOverride<{ warnings?: string[] }>({ provider: "default", model: "temporary" }, file, undefined, async () => {
    await writeFile(file, "broken during run"); return {};
  }, { acquireSettingsMutex: mutex.acquire });
  assert.match(result.warnings?.[0] ?? "", /not restored yet/);
  const original = await readFile(getJournalPath(file), "utf8");
  await assert.rejects(withProviderOverride({ provider: "default", model: "next" }, file, undefined, async () => {
    assert.fail("unrecovered journal must block execution"); return {};
  }, { acquireSettingsMutex: mutex.acquire }), (err: unknown) => err instanceof ClineRunError && err.kind === "settings_restore_failed");
  assert.equal(await readFile(getJournalPath(file), "utf8"), original);
}));

test("withProviderOverride without both provider and model is rejected before any settings access", async () => fixture(async file => {
  const forbiddenMutex: typeof acquireSettingsMutex = async () => { throw new Error("unexpected mutex"); };
  for (const input of [{}, { provider: "default" }, { model: "baseline" }]) {
    await assert.rejects(withProviderOverride(input, file, undefined, async () => {
      assert.fail("must not run on the saved default"); return {};
    }, { acquireSettingsMutex: forbiddenMutex }), (err: unknown) => err instanceof ClineRunError && err.kind === "launch_failed");
  }
  await assert.rejects(readFile(getJournalPath(file)), { code: "ENOENT" });
}));

test("malformed restore journal is retained and cannot be overwritten", async () => fixture(async file => {
  await writeFile(getJournalPath(file), "truncated journal");
  assert.equal(await recoverProviderSettingsJournal(file), "failed");
  await assert.rejects(withProviderOverride({ provider: "default", model: "next" }, file, undefined, async () => ({})),
    (err: unknown) => err instanceof ClineRunError && err.kind === "settings_restore_failed");
  assert.equal(await readFile(getJournalPath(file), "utf8"), "truncated journal");
}));

test("built stdio bridge startup restores a temporary journal and logs failed recovery", async () => fixture(async file => {
  const dir = path.dirname(file);
  const start = async () => await new Promise<{ code: number | null; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, [path.resolve("dist/index.js")], {
      env: {
        ...process.env,
        CLINE_PROVIDER_SETTINGS_PATH: file,
        CLINE_MCP_CATALOG_PATH: path.join(dir, "catalog.json"),
        CLINE_MCP_STATE_PATH: path.join(dir, "state.json"),
        CLINE_MCP_STATUS_PATH: path.join(dir, "status.json"),
        CLINE_MCP_TRACE_DIR: path.join(dir, "traces")
      },
      stdio: ["pipe", "pipe", "pipe"], windowsHide: true
    });
    let stderr = "";
    const timer = setTimeout(() => { child.kill(); reject(new Error("startup did not settle")); }, 15_000);
    child.stderr.on("data", chunk => { stderr += chunk.toString(); });
    child.once("error", err => { clearTimeout(timer); reject(err); });
    child.once("close", code => { clearTimeout(timer); resolve({ code, stderr }); });
    child.stdin.end();
  });
  const snapshot = await readProviderSettingsSnapshot(file, "default");
  await writeRestoreJournal(getJournalPath(file), snapshot);
  const data = await json(file); data.providers.default.settings.model = "temporary";
  await writeFile(file, JSON.stringify(data));
  assert.deepEqual(await start(), { code: 0, stderr: "" });
  assert.equal((await json(file)).providers.default.settings.model, "baseline");
  await assert.rejects(readFile(getJournalPath(file)), { code: "ENOENT" });
  await writeRestoreJournal(getJournalPath(file), snapshot);
  await writeFile(file, "invalid settings");
  const result = await start();
  assert.equal(result.code, 0);
  assert.match(result.stderr, /startup recovery failed.*journal was retained/);
  assert.ok(await readFile(getJournalPath(file)));
}));



test("malformed journal blocks overrides with a typed error and is kept", async () => fixture(async file => {
  await writeFile(getJournalPath(file), "malformed");
  await assert.rejects(withProviderOverride({ provider: "default", model: "temporary" }, file, undefined, async () => {
    assert.fail("override must not run"); return {};
  }), (err: unknown) => err instanceof ClineRunError && err.kind === "settings_restore_failed");
  assert.equal(await readFile(getJournalPath(file), "utf8"), "malformed");
}));

test("journal with a removed settings file is unchanged and deleted", async () => fixture(async file => {
  const snapshot = await readProviderSettingsSnapshot(file, "default");
  assert.equal(snapshot.hadFile, true);
  await writeRestoreJournal(getJournalPath(file), snapshot);
  await unlink(file);
  assert.equal(await recoverProviderSettingsJournal(file), "unchanged");
  await assert.rejects(readFile(getJournalPath(file)), { code: "ENOENT" });
  await assert.rejects(readFile(file), { code: "ENOENT" });
}));

test("override of a provider with no saved entry journals it and removes its temporary entry", async () => fixture(async file => {
  for (const missingFile of [false, true]) {
    if (missingFile) await unlink(file);
    else await writeFile(file, JSON.stringify({ providers: {} }));
    await withProviderOverride({ provider: "cline", model: "temporary" }, file, undefined, async selection => {
      assert.deepEqual(selection, { provider: "cline", model: "temporary" });
      const journal = await json(getJournalPath(file));
      assert.deepEqual(Object.keys(journal.base.providers), ["cline"]);
      assert.equal(journal.base.providers.cline.hadEntry, false);
      assert.equal((Object.values(journal.runs)[0] as any).provider, "cline");
      await writeFile(file, JSON.stringify({ lastUsedProvider: "cline", providers: { cline: { settings: { model: "temporary", reasoning: "high" } } } }));
      return {};
    });
    const restored = await json(file);
    assert.equal(restored.lastUsedProvider, undefined);
    assert.equal(restored.providers.cline, undefined);
  }
}));

test("non-string model and reasoning values survive journal round trip and restoration", async () => fixture(async file => {
  for (const value of [null, 42, false, { custom: [1, "two"] }]) {
    await writeFile(file, JSON.stringify({ lastUsedProvider: "default", providers: { default: { settings: { model: value, reasoning: value } } } }));
    await withProviderOverride({ provider: "default", model: "temporary" }, file, undefined, async () => {
      const base = (await json(getJournalPath(file))).base.providers.default;
      assert.equal(base.hadModel, true); assert.equal(base.hadReasoning, true);
      assert.deepEqual(base.originalModel, value); assert.deepEqual(base.originalReasoning, value);
      await writeFile(file, JSON.stringify({ lastUsedProvider: "default", providers: { default: { settings: { model: "temporary", reasoning: "high", accessToken: "fresh" } } } }));
      return {};
    });
    const fields = (await json(file)).providers.default.settings;
    assert.equal(Object.hasOwn(fields, "model"), true);
    assert.equal(Object.hasOwn(fields, "reasoning"), true);
    assert.deepEqual(fields.model, value); assert.deepEqual(fields.reasoning, value);
    assert.equal(fields.accessToken, "fresh");
  }
}));


test("ownership handshake accepts only the endpoint's complete acquisition token", async () => fixture(async file => {
  const address = getSettingsMutexPath(file);
  const server = createServer(socket => { socket.on("error", () => {}); socket.end("our-test-token\n"); });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(address, resolve); });
  try {
    assert.equal(await verifySocketOwnership(address, "our-test-token"), true);
    assert.equal(await verifySocketOwnership(address, "another-owner"), false);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
  assert.equal(await verifySocketOwnership(address, "our-test-token"), false);
}));

test("real POSIX socket path replacement loses ownership and prevents journal creation", { skip: process.platform === "win32" }, async () => fixture(async file => {
  const address = getSettingsMutexPath(file);
  const release = await acquireSettingsMutex(file);
  const replacement = createServer(socket => { socket.on("error", () => {}); socket.end("replacement-owner\n"); });
  try {
    assert.equal(await release.verifyOwnership!(), true);
    await unlink(address);
    await new Promise<void>((resolve, reject) => { replacement.once("error", reject); replacement.listen(address, resolve); });
    assert.equal(await release.verifyOwnership!(), false);
    const snapshot = await readProviderSettingsSnapshot(file, "default");
    assert.equal(await writeRestoreJournal(getJournalPath(file), snapshot, release.verifyOwnership), false);
    await assert.rejects(readFile(getJournalPath(file)), { code: "ENOENT" });
    let acquisitions = 0;
    await withProviderOverride({ provider: "default", model: "temporary" }, file, undefined, async () => {
      assert.equal(acquisitions, 2, "must reacquire after rejecting the replaced endpoint");
      assert.ok(await readFile(getJournalPath(file)));
      return {};
    }, { acquireSettingsMutex: async (settingsPath, signal, options) => {
      if (++acquisitions > 1) return acquireSettingsMutex(settingsPath, signal, options);
      const close: ReleaseSettingsMutex = async () => {
        await release();
        await new Promise<void>(resolve => replacement.close(() => resolve()));
      };
      close.verifyOwnership = release.verifyOwnership;
      return close;
    } });
  } finally {
    await release();
    if (replacement.listening) await new Promise<void>(resolve => replacement.close(() => resolve()));
  }
}));

test("ownership lost before journal creation releases and reacquires before running", async () => fixture(async file => {
  let attempts = 0;
  let releases = 0;
  let checks = 0;
  let actionRan = false;
  await withProviderOverride({ provider: "default", model: "temporary" }, file, undefined, async () => {
    actionRan = true;
    // Registration released the lost lock, reacquired, and released again before the run.
    assert.equal(attempts, 2);
    assert.equal(releases, 2);
    assert.equal(checks, 2);
    assert.ok(await readFile(getJournalPath(file)));
    return {};
  }, { acquireSettingsMutex: async () => {
    const attempt = ++attempts;
    const release: ReleaseSettingsMutex = async () => { releases++; };
    release.verifyOwnership = async () => {
      checks++;
      await assert.rejects(readFile(getJournalPath(file)), { code: "ENOENT" });
      return attempt > 1;
    };
    return release;
  } });
  assert.equal(actionRan, true);
  // One more short acquisition to unregister the run at the end.
  assert.equal(attempts, 3);
  assert.equal(releases, 3);
}));

test("repeated ownership loss before journal creation respects the original deadline", async () => fixture(async file => {
  let now = 0; let releases = 0;
  await assert.rejects(withProviderOverride({ provider: "default", model: "temporary" }, file, undefined, async () => {
    assert.fail("unowned mutex must not run"); return {};
  }, { deadline: 10, nowFn: () => now, acquireSettingsMutex: async () => {
    const release: ReleaseSettingsMutex = async () => { releases++; };
    release.verifyOwnership = async () => { now += 5; return false; };
    return release;
  } }), (err: unknown) => err instanceof ClineRunError && err.kind === "settings_lock_timeout");
  assert.equal(now, 10); assert.equal(releases, 2);
  await assert.rejects(readFile(getJournalPath(file)), { code: "ENOENT" });
}));
