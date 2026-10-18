import assert from "node:assert/strict";
import test from "node:test";
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

test("two simulated bridge processes serialize overrides", async () => fixture(async file => {
  const mutex = fakeMutex();
  const options = { acquireSettingsMutex: mutex.acquire };
  const entered = deferred();
  const finish = deferred();
  let secondStarted = false;
  const first = withProviderOverride({ model: "one" }, file, undefined, async () => {
    entered.resolve(); await finish.promise; return {};
  }, options);
  await entered.promise;
  const second = withProviderOverride({ model: "two" }, file, undefined, async () => {
    secondStarted = true; return {};
  }, options);
  await delay(10);
  assert.equal(secondStarted, false);
  finish.resolve();
  await Promise.all([first, second]);
  assert.equal(secondStarted, true);
}));

test("crash releases fake mutex but leaves journal: next override restores before snapshot", async () => fixture(async file => {
  const mutex = fakeMutex();
  await mutex.acquire(file);
  const snapshot = await readProviderSettingsSnapshot(file, "default");
  await writeRestoreJournal(getJournalPath(file), snapshot);
  await writeFile(file, JSON.stringify({ lastUsedProvider: "default", providers: { default: { settings: { model: "crashed", reasoning: "high", apiKey: "refreshed" } } } }));
  await mutex.crash();
  await withProviderOverride({ model: "next" }, file, undefined, async () => {
    assert.equal((await json(file)).providers.default.settings.model, "baseline");
    assert.equal((await json(getJournalPath(file))).originalModel, "baseline");
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
    await assert.rejects(withProviderOverride({ model: "next" }, file, undefined, async () => {
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

test("non-override during in-flight override runs immediately with journal baseline flags", async () => fixture(async file => {
  const entered = deferred(); const finish = deferred();
  const first = withProviderOverride({ model: "temporary" }, file, undefined, async () => {
    const data = await json(file); data.providers.default.settings.model = "temporary";
    await writeFile(file, JSON.stringify(data)); entered.resolve(); await finish.promise; return {};
  });
  await entered.promise;
  try {
    let flags: string[] = [];
    const result = await runCline({ prompt: "hello" }, undefined, { deps: {
      providerSettingsPath: file, entryPath: "fake", access: async () => {},
      acquireSettingsMutex: async () => { assert.fail("default must never acquire mutex"); },
      spawn: ((_exe: string, args: string[]) => {
        flags = args; const child = new EventEmitter() as any;
        child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.kill = () => {};
        queueMicrotask(() => { child.stdout.emit("data", JSON.stringify({ type: "run_result", finishReason: "completed", text: "ok" })); child.emit("close", 0); });
        return child;
      }) as any
    } });
    assert.equal(result.text, "ok");
    assert.equal(flags[flags.indexOf("-P") + 1], "default");
    assert.equal(flags[flags.indexOf("-m") + 1], "baseline");
  } finally { finish.resolve(); await first; }
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


test("end-of-run restore failure retains journal and blocks subsequent override", async () => fixture(async file => {
  const mutex = fakeMutex();
  await assert.rejects(withProviderOverride({ model: "temporary" }, file, undefined, async () => {
    await writeFile(file, "broken during run"); return {};
  }, { acquireSettingsMutex: mutex.acquire }), (err: unknown) => err instanceof ClineRunError && err.kind === "settings_restore_failed");
  const original = await readFile(getJournalPath(file), "utf8");
  await assert.rejects(withProviderOverride({ model: "next" }, file, undefined, async () => {
    assert.fail("unrecovered journal must block execution"); return {};
  }, { acquireSettingsMutex: mutex.acquire }), (err: unknown) => err instanceof ClineRunError && err.kind === "settings_restore_failed");
  assert.equal(await readFile(getJournalPath(file), "utf8"), original);
}));

test("default selection uses saved flags, or journal's original provider when override targets another provider", async () => fixture(async file => {
  const forbiddenMutex: typeof acquireSettingsMutex = async () => { throw new Error("unexpected mutex"); };
  await withProviderOverride({}, file, undefined, async selection => {
    assert.deepEqual(selection, { provider: "default", model: "baseline" }); return {};
  }, { acquireSettingsMutex: forbiddenMutex });
  const snapshot = await readProviderSettingsSnapshot(file, "other");
  await writeRestoreJournal(getJournalPath(file), snapshot);
  const data = await json(file); data.lastUsedProvider = "other";
  data.providers.other = { settings: { model: "temporary" } };
  await writeFile(file, JSON.stringify(data));
  await withProviderOverride({}, file, undefined, async selection => {
    assert.deepEqual(selection, { provider: "default", model: "baseline" }); return {};
  }, { acquireSettingsMutex: forbiddenMutex });
  await recoverProviderSettingsJournal(file);
  await writeFile(file, JSON.stringify({ lastUsedProvider: "unknown" }));
  await withProviderOverride({}, file, undefined, async selection => {
    assert.deepEqual(selection, {}); return {};
  }, { acquireSettingsMutex: forbiddenMutex });
}));

test("malformed restore journal is retained and cannot be overwritten", async () => fixture(async file => {
  await writeFile(getJournalPath(file), "truncated journal");
  assert.equal(await recoverProviderSettingsJournal(file), "failed");
  await assert.rejects(withProviderOverride({ model: "next" }, file, undefined, async () => ({})),
    (err: unknown) => err instanceof ClineRunError && err.kind === "settings_restore_failed");
  assert.equal(await readFile(getJournalPath(file), "utf8"), "truncated journal");
}));

test("built stdio bridge startup restores a temporary journal and logs failed recovery", async () => fixture(async file => {
  const start = async () => await new Promise<{ code: number | null; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, [path.resolve("dist/index.js")], {
      env: { ...process.env, CLINE_PROVIDER_SETTINGS_PATH: file },
      stdio: ["pipe", "pipe", "pipe"], windowsHide: true
    });
    let stderr = "";
    const timer = setTimeout(() => { child.kill(); reject(new Error("startup did not settle")); }, 3000);
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



test("malformed journal lets defaults use saved flags, logs once, and blocks overrides with a typed error", async t => fixture(async file => {
  const warnings: string[] = [];
  t.mock.method(console, "error", (message: string) => warnings.push(message));
  await writeFile(getJournalPath(file), "malformed");
  for (let i = 0; i < 2; i++) {
    await withProviderOverride({}, file, undefined, async selection => {
      assert.deepEqual(selection, { provider: "default", model: "baseline" }); return {};
    });
  }
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /using saved settings/);
  await assert.rejects(withProviderOverride({ model: "temporary" }, file, undefined, async () => {
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

test("model-only override without lastUsedProvider journals cline and removes its temporary entry", async () => fixture(async file => {
  for (const missingFile of [false, true]) {
    if (missingFile) await unlink(file);
    else await writeFile(file, JSON.stringify({ providers: {} }));
    await withProviderOverride({ model: "temporary" }, file, undefined, async selection => {
      assert.deepEqual(selection, { provider: "cline", model: "temporary" });
      const journal = await json(getJournalPath(file));
      assert.equal(journal.targetProvider, "cline");
      assert.equal(journal.hadEntry, false);
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
    await withProviderOverride({ model: "temporary" }, file, undefined, async () => {
      const journal = await json(getJournalPath(file));
      assert.equal(journal.hadModel, true); assert.equal(journal.hadReasoning, true);
      assert.deepEqual(journal.originalModel, value); assert.deepEqual(journal.originalReasoning, value);
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
    await withProviderOverride({ model: "temporary" }, file, undefined, async () => {
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
  await withProviderOverride({ model: "temporary" }, file, undefined, async () => {
    actionRan = true;
    assert.equal(attempts, 2);
    assert.equal(releases, 1);
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
  assert.equal(releases, 2);
}));

test("repeated ownership loss before journal creation respects the original deadline", async () => fixture(async file => {
  let now = 0; let releases = 0;
  await assert.rejects(withProviderOverride({ model: "temporary" }, file, undefined, async () => {
    assert.fail("unowned mutex must not run"); return {};
  }, { deadline: 10, nowFn: () => now, acquireSettingsMutex: async () => {
    const release: ReleaseSettingsMutex = async () => { releases++; };
    release.verifyOwnership = async () => { now += 5; return false; };
    return release;
  } }), (err: unknown) => err instanceof ClineRunError && err.kind === "settings_lock_timeout");
  assert.equal(now, 10); assert.equal(releases, 2);
  await assert.rejects(readFile(getJournalPath(file)), { code: "ENOENT" });
}));
