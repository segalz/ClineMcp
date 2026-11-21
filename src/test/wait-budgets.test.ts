import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runCline, stopDedicatedHub } from "../runner.js";
import { syncBuiltinESMExports } from "node:module";
import { PassThrough } from "node:stream";
import test from "node:test";
import { acquire, CheckoutBusyError, checkoutLockPath } from "../checkoutlock.js";
import { killWindowsTree } from "../codemap-kill.js";
import { VERIFY_RESERVE_MARGIN_MS } from "../finalcheck.js";
import { listClineProcesses } from "../procs.js";
import { createdFiles, headAndIndexIdentity, restoreSnapshot, takeSnapshot } from "../snapshot.js";
import { TaskManager } from "../tasks.js";
import { runVerification } from "../verify.js";
import {
  DIFF_STAT_TIMEOUT_MS, KILL_SETTLE_MS, PROCESS_TABLE_TIMEOUT_MS,
  RESTORE_BUDGET_MS, SETTLE_MARGIN_MS, TREE_KILL_CONFIRM_MS, settlementBudget
} from "../waits.js";

function child(exitCode: number | null = null) {
  return Object.assign(new EventEmitter(), {
    stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
    kill: () => true, exitCode, signalCode: null
  });
}
function mockSpawn(t: test.TestContext, spawn: (file: string, args: string[]) => ReturnType<typeof child>) {
  const stub = t.mock.method(childProcess, "spawn", spawn);
  syncBuiltinESMExports();
  t.after(() => { stub.mock.restore(); syncBuiltinESMExports(); });
}

for (const stage of ["checkout", "identity"]) {
  test(`aborting an in-flight ${stage} Git call stops the child without waiting for close`, async t => {
    const controller = new AbortController();
    const reason = new Error("cancelled during Git");
    let kills = 0, calls = 0;
    mockSpawn(t, (_file, args) => {
      const proc = child();
      calls++;
      if (stage === "identity" && args.includes("--show-toplevel")) {
        queueMicrotask(() => { proc.stdout.end(process.cwd()); proc.emit("close", 0); });
      } else {
        proc.kill = () => { kills++; return true; };
        queueMicrotask(() => controller.abort(reason));
      }
      return proc;
    });
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const work = stage === "identity" ? headAndIndexIdentity(process.cwd(), controller.signal)
      : takeSnapshot(process.cwd(), { signal: controller.signal });
    await assert.rejects(work, error => error === reason);
    assert.equal(kills, 1);
    assert.equal(calls, stage === "identity" ? 2 : 1);
  });
}

test("diff stat is omitted at five seconds even if Git never emits close", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const proc = child();
  let kills = 0;
  proc.kill = () => { kills++; return true; };
  mockSpawn(t, () => proc);
  const pending = new TaskManager()["getGitDiffStat"](process.cwd());
  proc.stdout.write("partial stat");
  assert.equal(DIFF_STAT_TIMEOUT_MS, 5_000);
  t.mock.timers.tick(4_999);
  assert.equal(kills, 0);
  t.mock.timers.tick(1);
  assert.equal(await pending, undefined);
  assert.equal(kills, 1);
});

for (const { remainingMs, timeoutSeconds, workMs } of [
  { remainingMs: 800, timeoutSeconds: 30, workMs: 800 },
  { remainingMs: 60_000, timeoutSeconds: 1, workMs: 1_000 }
]) {
  test(`a stalled confirmation settles within the shorter verify budget (${workMs} ms) plus margin`, async t => {
    t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1_000 });
    let started!: () => void;
    const launched = new Promise<void>(resolve => { started = resolve; });
    mockSpawn(t, file => {
      const proc = child();
      if (file === process.execPath) { started(); return Object.assign(proc, { pid: 12345, exitCode: 0 }); }
      return proc;
    });
    let confirmCap: number | undefined;
    const result = runVerification({ command: process.execPath, timeoutSeconds }, process.cwd(), undefined, {
      remainingMs, now: Date.now, createWindowsJob: async () => undefined,
      confirmTreeDead: (_pid, options) => { confirmCap = options.capMs; return new Promise(() => {}); }
    });
    await launched;
    t.mock.timers.tick(workMs);
    assert.equal(confirmCap, SETTLE_MARGIN_MS);
    t.mock.timers.tick(SETTLE_MARGIN_MS);
    const check = await result;
    assert.deepEqual([check.passed, check.timedOut, check.killConfirmed, check.killUnverified], [false, true, false, true]);
    assert.equal(check.durationMs, workMs + SETTLE_MARGIN_MS);
  });
}

for (const reason of ["timeout", "cancelled"] as const) {
  test(`real-PID runner confirmation respects the ${reason} settlement cap`, async t => {
    const folder = await mkdtemp(path.join(os.tmpdir(), "runner-settle-"));
    t.after(() => rm(folder, { recursive: true, force: true }));
    t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1_000 });
    const controller = new AbortController();
    let started!: () => void;
    const launched = new Promise<void>(resolve => { started = resolve; });
    const cap = reason === "timeout" ? 175 : SETTLE_MARGIN_MS;
    let received: number | undefined;
    const pending = runCline({ prompt: "test", provider: "p", model: "m" }, controller.signal, {
      maxAttempts: 1, recordStatus: false, respectQuotaLock: false, deps: {
        platform: "win32", entryPath: "mock/cline", providerSettingsPath: path.join(folder, "providers.json"),
        access: async () => {}, acquireSettingsMutex: async () => async () => {},
        totalBudgetMs: 60_000, timeoutMs: 1_000, settlementDeadlineMs: reason === "timeout" ? cap : undefined,
        now: Date.now, killTree: () => {},
        spawn: (() => {
          started();
          return Object.assign(new childProcess.ChildProcess(), { pid: 12345, stdout: new PassThrough(), stderr: new PassThrough() });
        }) as typeof childProcess.spawn,
        confirmTreeDead: (_pid, opts) => {
          received = opts.capMs;
          return new Promise(resolve => setTimeout(() => resolve({ confirmed: false, alive: [], unverified: true }), received));
        }
      }
    });
    const rejected = assert.rejects(pending, { kind: reason, killUnverified: true });
    await launched;
    if (reason === "cancelled") controller.abort(); else t.mock.timers.tick(1_000);
    assert.equal(received, cap);
    t.mock.timers.tick(cap);
    await rejected;
  });
}

test("cancel also shortens a verification already waiting for its process table", async t => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1_000 });
  const controller = new AbortController();
  let started!: () => void;
  const confirming = new Promise<void>(resolve => { started = resolve; });
  mockSpawn(t, () => {
    const proc = Object.assign(child(0), { pid: 12345 });
    queueMicrotask(() => { proc.emit("exit", 0, null); proc.emit("close", 0, null); });
    return proc;
  });
  const pending = runVerification({ command: process.execPath }, process.cwd(), controller.signal, {
    now: Date.now, createWindowsJob: async () => undefined,
    confirmTreeDead: () => { started(); return new Promise(() => {}); }
  });
  await confirming;
  controller.abort();
  t.mock.timers.tick(SETTLE_MARGIN_MS);
  const result = await pending;
  assert.deepEqual([result.passed, result.killConfirmed, result.killUnverified], [false, false, true]);
  assert.equal(result.durationMs, SETTLE_MARGIN_MS);
});

test("budget constants satisfy the shutdown, reserve, cancel, drain, and two-read invariants", () => {
  assert.ok(RESTORE_BUDGET_MS < 120_000, "restore budget fits below the 120 s shutdown cap");
  assert.ok(SETTLE_MARGIN_MS < 5_000, "settlement margin fits inside tasks.cancel's 5 s wait");
  assert.ok(SETTLE_MARGIN_MS < VERIFY_RESERVE_MARGIN_MS, "verify settlement margin fits inside VERIFY_RESERVE_MARGIN_MS");
  assert.ok(KILL_SETTLE_MS <= VERIFY_RESERVE_MARGIN_MS, "kill settle cap fits inside VERIFY_RESERVE_MARGIN_MS");
  assert.ok(KILL_SETTLE_MS > 2_000, "job.close() cap exceeds the Windows job owner's 2 s drain");
  assert.ok(TREE_KILL_CONFIRM_MS >= 2 * PROCESS_TABLE_TIMEOUT_MS + 2_000, "two process-table reads fit with slack");
});

test("createdFiles and restoreSnapshot honor AbortSignal and the 90 s RESTORE_BUDGET_MS cap", async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "snap-budget-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const handle = { checkoutRoot: dir, directory: path.join(dir, "store"), manifest: [] };
  const controller = new AbortController();
  const reason = new Error("cancelled createdFiles");
  let phase: "created" | "restore" = "created";
  let secondStarted!: () => void;
  const secondGit = new Promise<void>(resolve => { secondStarted = resolve; });
  let thirdStarted!: () => void;
  const thirdGit = new Promise<void>(resolve => { thirdStarted = resolve; });
  let kills = 0;
  let gitCalls = 0;
  mockSpawn(t, (_file, args) => {
    const proc = child();
    if (phase === "created") {
      if (args.includes("--show-toplevel")) {
        queueMicrotask(() => { proc.stdout.end(dir); proc.emit("close", 0); });
      } else {
        proc.kill = () => { kills++; return true; };
        queueMicrotask(() => controller.abort(reason));
      }
      return proc;
    }
    gitCalls++;
    if (args.includes("--show-toplevel")) {
      queueMicrotask(() => { proc.stdout.end(dir); proc.emit("close", 0); });
    } else if (gitCalls === 2) {
      // First ls-files takes 50 s (under the 60 s per-call cap), leaving 40 s of RESTORE_BUDGET_MS.
      secondStarted();
      setTimeout(() => { proc.stdout.end(""); proc.emit("close", 0); }, 50_000);
    } else {
      // Next Git call stalls forever; must abort at RESTORE_BUDGET_MS (90 s), not 50 s + 60 s = 110 s.
      proc.kill = () => { kills++; return true; };
      thirdStarted();
    }
    return proc;
  });
  t.mock.timers.enable({ apis: ["setTimeout"] });
  await assert.rejects(createdFiles(handle, controller.signal), err => err === reason);
  assert.equal(kills, 1);

  phase = "restore";
  kills = 0;
  const restoring = restoreSnapshot(handle);
  const rejected = assert.rejects(restoring, (err: unknown) => err instanceof Error && err.name === "TimeoutError");
  await secondGit;
  t.mock.timers.tick(50_000);
  await thirdGit;
  assert.equal(kills, 0);
  t.mock.timers.tick(RESTORE_BUDGET_MS - 50_000);
  await rejected;
  assert.equal(kills, 1);
});

test("checkoutlock acquire honors signal abort and deadlineMs across stale-lock reclamation", async t => {
  const base = await mkdtemp(path.join(os.tmpdir(), "lock-budget-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const repo = path.join(base, "repo"), locks = path.join(base, "locks");
  await mkdir(repo); await mkdir(locks);
  const lockFile = checkoutLockPath(repo, locks);
  // Use a live PID (process.ppid) with an old timestamp so Windows/Linux must query its start time.
  await writeFile(lockFile, JSON.stringify({ pid: process.ppid, time: new Date(Date.now() - 3_600_000).toISOString(), token: "stale" }));

  let kills = 0;
  let execCalls = 0;
  const stub = t.mock.method(childProcess, "execFile", ((..._args: unknown[]) => {
    execCalls++;
    const proc = child();
    proc.kill = () => { kills++; return true; };
    return proc;
  }) as unknown as typeof childProcess.execFile);
  syncBuiltinESMExports();
  t.after(() => { stub.mock.restore(); syncBuiltinESMExports(); });

  t.mock.timers.enable({ apis: ["setTimeout"] });
  if (process.platform === "win32") {
    const controller = new AbortController();
    const reason = new Error("cancelled lock acquire");
    const pendingCancel = acquire(repo, { lockDirectory: locks, signal: controller.signal });
    queueMicrotask(() => controller.abort(reason));
    await assert.rejects(pendingCancel, err => err === reason);
    assert.equal(execCalls, 1);
    assert.equal(kills, 1);

    execCalls = 0; kills = 0;
    const pendingDeadline = acquire(repo, { lockDirectory: locks, deadlineMs: 120 });
    const busy = assert.rejects(pendingDeadline, CheckoutBusyError);
    t.mock.timers.tick(120);
    await busy;
    assert.equal(execCalls, 1);
    assert.equal(kills, 1);
  }
});

test("listClineProcesses and killWindowsTree respect caller timeout and abort signal", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let kills = 0;
  mockSpawn(t, () => {
    const proc = child();
    proc.kill = () => { kills++; return true; };
    return proc;
  });

  if (process.platform === "win32") {
    const pendingTimeout = listClineProcesses(300);
    t.mock.timers.tick(299);
    assert.equal(kills, 0);
    t.mock.timers.tick(1);
    assert.equal(await pendingTimeout, undefined);
    assert.equal(kills, 1);

    kills = 0;
    const controller = new AbortController();
    const pendingAbort = listClineProcesses(PROCESS_TABLE_TIMEOUT_MS, controller.signal);
    controller.abort();
    assert.equal(await pendingAbort, undefined);
    assert.equal(kills, 1);
  }

  kills = 0;
  const controller = new AbortController();
  const killing = killWindowsTree(12345, 5_000, controller.signal);
  controller.abort();
  await killing;
  assert.equal(kills, 1);

  let spawned = 0;
  mockSpawn(t, () => { spawned++; return child(); });
  await killWindowsTree(12345, 0);
  assert.equal(spawned, 1, "zero wait budget still fires taskkill without waiting");
});

test("runner settles within budget plus margin even when confirmTreeDead hangs, and stopDedicatedHub obeys budget", async t => {
  const folder = await mkdtemp(path.join(os.tmpdir(), "runner-hang-"));
  t.after(() => rm(folder, { recursive: true, force: true }));
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1_000 });
  let started!: () => void;
  const launched = new Promise<void>(resolve => { started = resolve; });
  const pending = runCline({ prompt: "test", provider: "p", model: "m" }, undefined, {
    maxAttempts: 1, recordStatus: false, respectQuotaLock: false, deps: {
      platform: "win32", entryPath: "mock/cline", providerSettingsPath: path.join(folder, "providers.json"),
      access: async () => {}, acquireSettingsMutex: async () => async () => {},
      totalBudgetMs: 1_000, timeoutMs: 1_000, now: Date.now, killTree: () => {},
      spawn: (() => {
        started();
        return Object.assign(new childProcess.ChildProcess(), { pid: 12345, stdout: new PassThrough(), stderr: new PassThrough() });
      }) as typeof childProcess.spawn,
      confirmTreeDead: () => new Promise(() => {})
    }
  });
  const rejected = assert.rejects(pending, { kind: "timeout", killUnverified: true });
  await launched;
  t.mock.timers.tick(1_000 + SETTLE_MARGIN_MS);
  await rejected;
  assert.equal(Date.now() - 1_000, 1_000 + SETTLE_MARGIN_MS);

  const budget = settlementBudget(0, undefined, Date.now);
  t.after(() => budget.dispose());
  const hubStop = stopDedicatedHub(4321, {
    hubStarted: async () => true,
    runHubStop: () => new Promise(() => {})
  }, budget);
  t.mock.timers.tick(SETTLE_MARGIN_MS);
  assert.deepEqual(await hubStop, { confirmed: false, alive: [], unverified: true });
});
