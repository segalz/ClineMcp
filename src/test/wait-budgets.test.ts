import "./heavy-test-dir.js";
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import fsPromises, { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DedicatedHubSession, runCline, stopDedicatedHub, ClineRunError } from "../runner.js";
import { syncBuiltinESMExports } from "node:module";
import { PassThrough } from "node:stream";
import test from "node:test";
import { acquire, CheckoutBusyError, checkoutLockPath } from "../checkoutlock.js";
import { killWindowsTree } from "../codemap-kill.js";
import { applyClineEdits } from "../edits.js";
import { FinalCheckLifecycle, VERIFY_RESERVE_MARGIN_MS } from "../finalcheck.js";
import { createWindowsJob, type WindowsJob } from "../jobobject.js";
import { listClineProcesses } from "../procs.js";
import { confirmTreeDead } from "../proctree.js";
import { createdFiles, headAndIndexIdentity, restoreSnapshot, takeSnapshot } from "../snapshot.js";
import { TaskManager } from "../tasks.js";
import { runVerification } from "../verify.js";
import {
  DIFF_STAT_TIMEOUT_MS, KILL_CONFIRM_MARGIN_MS, KILL_SETTLE_MS, PROCESS_TABLE_TIMEOUT_MS,
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
    assert.equal(confirmCap, KILL_CONFIRM_MARGIN_MS);
    t.mock.timers.tick(KILL_CONFIRM_MARGIN_MS);
    const check = await result;
    assert.deepEqual([check.passed, check.timedOut, check.killConfirmed, check.killUnverified], [false, true, false, true]);
    assert.equal(check.durationMs, workMs + KILL_CONFIRM_MARGIN_MS);
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
    const cap = reason === "timeout" ? 175 : KILL_CONFIRM_MARGIN_MS;
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
  t.mock.timers.tick(KILL_CONFIRM_MARGIN_MS);
  const result = await pending;
  assert.deepEqual([result.passed, result.killConfirmed, result.killUnverified], [false, false, true]);
  assert.equal(result.durationMs, KILL_CONFIRM_MARGIN_MS);
});

test("budget constants satisfy the shutdown, reserve, cancel, drain, and two-read invariants", () => {
  assert.ok(RESTORE_BUDGET_MS < 120_000, "restore budget fits below the 120 s shutdown cap");
  assert.ok(SETTLE_MARGIN_MS < 5_000, "settlement margin fits inside tasks.cancel's 5 s wait");
  assert.ok(SETTLE_MARGIN_MS < VERIFY_RESERVE_MARGIN_MS, "verify settlement margin fits inside VERIFY_RESERVE_MARGIN_MS");
  assert.ok(KILL_SETTLE_MS <= VERIFY_RESERVE_MARGIN_MS, "kill settle cap fits inside VERIFY_RESERVE_MARGIN_MS");
  assert.ok(KILL_SETTLE_MS > 2_000, "job.close() cap exceeds the Windows job owner's 2 s drain");
  assert.ok(KILL_CONFIRM_MARGIN_MS >= PROCESS_TABLE_TIMEOUT_MS + 1_000, "no-job confirmation margin fits a full table read plus polling");
  assert.ok(KILL_CONFIRM_MARGIN_MS < TREE_KILL_CONFIRM_MS, "no-job confirmation margin stays below two-read cap");
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
  await secondGit;
  t.mock.timers.tick(50_000);
  await thirdGit;
  assert.equal(kills, 0);
  t.mock.timers.tick(RESTORE_BUDGET_MS - 50_000);
  const report = await restoring;
  assert.equal(kills, 1);
  assert.deepEqual(report.failed, [{ path: ".", error: "not attempted (restore deadline): created-files scan did not run" }]);
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
  let spawned = 0;
  mockSpawn(t, () => {
    spawned++;
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

  spawned = 0;
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
  t.mock.timers.tick(1_000 + KILL_CONFIRM_MARGIN_MS);
  await rejected;
  assert.equal(Date.now() - 1_000, 1_000 + KILL_CONFIRM_MARGIN_MS);

  const budget = settlementBudget(0, undefined, Date.now);
  t.after(() => budget.dispose());
  const hubStop = stopDedicatedHub(4321, {
    hubStarted: async () => true,
    runHubStop: () => new Promise(() => {})
  }, budget);
  t.mock.timers.tick(SETTLE_MARGIN_MS);
  assert.deepEqual(await hubStop, { confirmed: false, alive: [], unverified: true });
});

// ---- Review follow-up tests (fail on HEAD 2f78bf0 before fixes) ----

test("slow 12 s process-table read confirms a timed-out check when no Job Object is available", async t => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1_000 });
  let started!: () => void;
  const launched = new Promise<void>(resolve => { started = resolve; });
  let proc!: ReturnType<typeof child>;
  mockSpawn(t, file => {
    const p = child();
    if (file === process.execPath) {
      proc = p;
      started();
      return Object.assign(p, { pid: 12345 });
    }
    return p;
  });
  const readCaps: number[] = [];
  const pending = runVerification({ command: process.execPath, timeoutSeconds: 1 }, process.cwd(), undefined, {
    now: Date.now,
    createWindowsJob: async () => undefined,
    confirmTreeDead: (pid, opts) => confirmTreeDead(pid, {
      ...opts,
      platform: "win32",
      killRoot: () => { (proc as any).exitCode = 1; proc.emit("exit", 1, null); proc.emit("close", 1, null); },
      listTable: ms => {
        readCaps.push(ms);
        return new Promise(resolve => {
          const timer = setTimeout(() => resolve([]), 12_000);
          opts.signal?.addEventListener("abort", () => { clearTimeout(timer); resolve(null); }, { once: true });
        });
      }
    })
  });
  await launched;
  t.mock.timers.tick(1_000);
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.deepEqual(readCaps, [PROCESS_TABLE_TIMEOUT_MS]);
  t.mock.timers.tick(12_000);
  await new Promise<void>(resolve => setImmediate(resolve));
  t.mock.timers.tick(250);
  const result = await pending;
  assert.equal(result.timedOut, true);
  assert.equal(result.killConfirmed, undefined, "12 s table read must confirm the kill");
  assert.equal(result.killUnverified, undefined);
});

test("Windows Job Object still runs process-table confirmation and confirms an unreadable table when no pipes are held open", { skip: process.platform !== "win32" && "Windows-only: exercises Windows Job Object confirmation; POSIX never creates the job and the real tree check never settles under mocked timers" }, async t => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1_000 });
  let tableCalls = 0;
  let verifyStarted!: () => void;
  const verifyLaunched = new Promise<void>(resolve => { verifyStarted = resolve; });
  let verifyProc!: ReturnType<typeof child>;
  mockSpawn(t, file => {
    const proc = child();
    if (file === process.execPath) {
      verifyProc = proc;
      verifyStarted();
      return Object.assign(proc, { pid: 12345 });
    }
    return proc;
  });
  let closed = false;
  const mockJob = (): WindowsJob => {
    let alive = true, assigned = false;
    return {
      get alive() { return alive; },
      get assigned() { return assigned; },
      assign() { assigned = true; },
      async close() {
        closed = true;
        alive = false;
        assigned = false;
        queueMicrotask(() => (verifyProc as any)?.emit?.("close", null, "SIGKILL"));
        return true as any;
      }
    };
  };
  const verified = runVerification({ command: process.execPath, timeoutSeconds: 1 }, process.cwd(), undefined, {
    now: Date.now,
    createWindowsJob: async () => mockJob(),
    confirmTreeDead: async () => { tableCalls++; return { confirmed: false, alive: [], unverified: true }; }
  });
  await verifyLaunched;
  t.mock.timers.tick(1_000);
  const result = await verified;
  assert.equal(closed, true);
  assert.equal(tableCalls, 1, "drained Job Object must still run confirmTreeDead");
  assert.equal(result.timedOut, true);
  assert.equal(result.killConfirmed, undefined);
  assert.equal(result.killUnverified, undefined);

  // Also test runCline with a real-PID child assigned to a WindowsJob.
  const folder = await mkdtemp(path.join(os.tmpdir(), "runner-job-confirm-"));
  t.after(() => rm(folder, { recursive: true, force: true }));
  let runnerStarted!: () => void;
  const runnerLaunched = new Promise<void>(resolve => { runnerStarted = resolve; });
  closed = false;
  const pendingRun = runCline({ prompt: "test", provider: "p", model: "m" }, undefined, {
    maxAttempts: 1, recordStatus: false, respectQuotaLock: false, deps: {
      platform: "win32", entryPath: "mock/cline", providerSettingsPath: path.join(folder, "providers.json"),
      access: async () => {}, acquireSettingsMutex: async () => async () => {},
      totalBudgetMs: 1_000, timeoutMs: 1_000, now: Date.now, killTree: () => {},
      createWindowsJob: async () => mockJob(),
      confirmTreeDead: async () => { tableCalls++; return { confirmed: false, alive: [], unverified: true }; },
      spawn: (() => {
        runnerStarted();
        return Object.assign(new childProcess.ChildProcess(), { pid: 12345, stdout: new PassThrough(), stderr: new PassThrough() });
      }) as typeof childProcess.spawn
    }
  });
  const rejected = assert.rejects(pendingRun, (err: unknown) => {
    assert.ok(err instanceof ClineRunError);
    assert.equal(err.kind, "timeout");
    assert.equal(err.killUnverified, undefined);
    assert.equal(err.processesStillAlive, undefined);
    return true;
  });
  await runnerLaunched;
  t.mock.timers.tick(1_000);
  await rejected;
  assert.equal(closed, true);
  assert.equal(tableCalls, 2, "runner with drained Job Object must still run confirmTreeDead");
});

test("real Windows Job Object helper confirms ActiveProcesses == 0 on close", { skip: process.platform !== "win32" }, async t => {
  const job = await createWindowsJob(15_000);
  assert.ok(job);
  const proc = childProcess.spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore", windowsHide: true });
  t.after(async () => { proc.kill(); await job.close(); });
  job.assign(proc);
  const deadline = Date.now() + 10_000;
  while (!job.assigned && Date.now() < deadline) await new Promise(r => setTimeout(r, 10));
  assert.equal(job.assigned, true);
  const confirmed = await job.close();
  assert.equal(confirmed, true, "closing an assigned job must confirm ActiveProcesses == 0");
});

test("a restore that hits RESTORE_BUDGET_MS mid-loop finishes the current file, returns a partial report, keeps the snapshot, and sets evidence.restore", async t => {
  const base = await mkdtemp(path.join(os.tmpdir(), "partial-restore-"));
  t.after(() => rm(base, { recursive: true, force: true, maxRetries: 5 }));
  const root = path.join(base, "repo"), snapshots = path.join(base, "snapshots"), locks = path.join(base, "locks");
  await mkdir(root);
  for (const [name, content] of [["a.txt", "base-a"], ["b.txt", "base-b"], ["c.txt", "base-c"]]) {
    await writeFile(path.join(root, name), content);
  }
  const gitMock = t.mock.method(childProcess, "spawn", (_file: string, args: string[]) => {
    const proc = child();
    const cmd = args[2], arg = args[3];
    let out = "";
    if (cmd === "rev-parse") out = arg === "--show-toplevel" ? root : arg === "--git-path" ? ".git/info/exclude" : "a".repeat(40);
    else if (cmd === "ls-files" && arg === "--stage") out = "";
    else if (cmd === "ls-files" && args.includes("--ignored")) out = "";
    else if (cmd === "ls-files") out = "a.txt\0b.txt\0c.txt\0";
    else if (cmd === "check-ignore") out = "";
    queueMicrotask(() => { proc.stdout.end(out); proc.emit("close", 0); });
    return proc;
  });
  syncBuiltinESMExports();
  t.after(() => { gitMock.mock.restore(); syncBuiltinESMExports(); });

  const lifecycle = new FinalCheckLifecycle(
    { prompt: "Edit", cwd: root, verify: { none: true, reason: "Partial restore fixture" }, timeoutSeconds: 120 },
    {
      resolveRoot: async () => root, fits: () => true, question: text => text.startsWith("QUESTION:") ? { question: text } : undefined,
      lockDirectory: locks, snapshotOptions: { snapshotBase: snapshots },
      run: async () => {
        await writeFile(path.join(root, "a.txt"), "edit-a");
        await writeFile(path.join(root, "b.txt"), "edit-b");
        await writeFile(path.join(root, "c.txt"), "edit-c");
        return { text: "QUESTION: Stop here?", durationMs: 1 };
      }
    }
  );
  t.after(() => lifecycle.release());
  await lifecycle.execute(new AbortController().signal);
  const snapDir = lifecycle.snapshot!.directory;
  assert.ok(existsSync(snapDir));

  // Hit RESTORE_BUDGET_MS while restoring a.txt; a.txt must still finish cleanly, while b.txt and c.txt are marked not attempted.
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const realRename = fsPromises.rename;
  let tripped = false;
  const renameMock = t.mock.method(fsPromises, "rename", async (...args: Parameters<typeof realRename>) => {
    if (!tripped && String(args[1]).endsWith("a.txt")) {
      tripped = true;
      t.mock.timers.tick(RESTORE_BUDGET_MS);
    }
    return realRename(...args);
  });
  syncBuiltinESMExports();
  t.after(() => { renameMock.mock.restore(); syncBuiltinESMExports(); });

  const restored = await lifecycle.restore();
  assert.equal(restored, false);
  assert.equal(lifecycle.verification.restored, false);
  assert.ok(existsSync(snapDir), "snapshot directory must be kept after partial restore");
  assert.equal(await readFile(path.join(root, "a.txt"), "utf8"), "base-a", "current file must finish restoring");
  assert.equal(await readFile(path.join(root, "b.txt"), "utf8"), "edit-b");
  assert.equal(await readFile(path.join(root, "c.txt"), "utf8"), "edit-c");
  const report = lifecycle.evidence.restore as { restored: string[]; removed: string[]; failed: Array<{ path: string; error: string }> } | undefined;
  assert.ok(report, "evidence.restore must be populated with the partial report");
  assert.deepEqual(report.restored, ["a.txt"]);
  assert.deepEqual(report.failed, [
    { path: "b.txt", error: "not attempted (restore deadline)" },
    { path: "c.txt", error: "not attempted (restore deadline)" }
  ]);
});

test("an unconfirmed kill never triggers an automatic restore in sync edits or cancelled lifecycle", async t => {
  const base = await mkdtemp(path.join(os.tmpdir(), "unconfirmed-no-restore-"));
  t.after(() => rm(base, { recursive: true, force: true, maxRetries: 5 }));
  let root = path.join(base, "repo");
  const snapshots = path.join(base, "snapshots"), locks = path.join(base, "locks");
  await mkdir(root);
  await writeFile(path.join(root, "a.txt"), "baseline");
  const gitMock = t.mock.method(childProcess, "spawn", (_file: string, args: string[]) => {
    const proc = child();
    const cmd = args[2], arg = args[3];
    let out = "";
    if (cmd === "rev-parse") out = arg === "--show-toplevel" ? root : arg === "--git-path" ? ".git/info/exclude" : "a".repeat(40);
    else if (cmd === "ls-files" && arg === "--stage") out = "";
    else if (cmd === "ls-files" && args.includes("--ignored")) out = "";
    else if (cmd === "ls-files") out = "a.txt\0";
    queueMicrotask(() => { proc.stdout.end(out); proc.emit("close", 0); });
    return proc;
  });
  syncBuiltinESMExports();
  t.after(() => { gitMock.mock.restore(); syncBuiltinESMExports(); });

  // 1. Cancelled FinalCheckLifecycle with unconfirmed kill: must NOT restore.
  const controller = new AbortController();
  const lifecycle = new FinalCheckLifecycle(
    { prompt: "Edit", cwd: root, verify: { none: true, reason: "Unconfirmed cancel fixture" }, timeoutSeconds: 120 },
    {
      resolveRoot: async () => root, fits: () => true, question: () => undefined,
      lockDirectory: locks, snapshotOptions: { snapshotBase: snapshots },
      run: async () => {
        await writeFile(path.join(root, "a.txt"), "edited-before-cancel");
        controller.abort();
        throw new ClineRunError("cancelled", "cancelled", { processesStillAlive: [9090], killUnverified: true });
      }
    }
  );
  t.after(() => lifecycle.release());
  await lifecycle.execute(controller.signal);
  assert.equal(await readFile(path.join(root, "a.txt"), "utf8"), "edited-before-cancel", "must not restore while kill is unconfirmed");
  assert.equal(lifecycle.verification.restored, false);
  assert.ok(lifecycle.snapshot && existsSync(lifecycle.snapshot.directory));
  assert.deepEqual(lifecycle.evidence.processesStillAlive, [9090]);
  assert.equal(lifecycle.evidence.snapshotDirectory, lifecycle.snapshot.directory);
  lifecycle.release();

  root = await mkdtemp(path.join(base, "sync-"));
  // 2. Sync applyClineEdits with unconfirmed kill: must NOT restore; error carries snapshotDirectory and processesStillAlive.
  await writeFile(path.join(root, "a.txt"), "baseline");
  const prevSnapDir = process.env.CLINE_MCP_SNAPSHOT_DIR;
  process.env.CLINE_MCP_SNAPSHOT_DIR = snapshots;
  t.after(() => { if (prevSnapDir === undefined) delete process.env.CLINE_MCP_SNAPSHOT_DIR; else process.env.CLINE_MCP_SNAPSHOT_DIR = prevSnapDir; });
  await assert.rejects(
    applyClineEdits(
      { prompt: "Edit", cwd: root, provider: "p", model: "m", codeMap: false, verify: { none: true, reason: "Sync unconfirmed fixture" } },
      undefined,
      {
        checkoutLockDirectory: locks, recordStatus: false, respectQuotaLock: false,
        deps: {
          platform: "win32", entryPath: "mock/cline", providerSettingsPath: path.join(base, "providers.json"),
          access: async () => {}, acquireSettingsMutex: async () => async () => {},
          totalBudgetMs: 200, timeoutMs: 50, settlementDeadlineMs: 20,
          createWindowsJob: async () => undefined,
          killTree: () => {},
          confirmTreeDead: async () => ({ confirmed: false, alive: [4242], unverified: true }),
          spawn: (() => {
            void writeFile(path.join(root, "a.txt"), "edited-sync");
            return Object.assign(new childProcess.ChildProcess(), { pid: 4242, stdout: new PassThrough(), stderr: new PassThrough() });
          }) as typeof childProcess.spawn
        }
      }
    ),
    (err: any) => {
      assert.equal(err.verification?.restored, false);
      assert.deepEqual(err.evidence?.processesStillAlive, [4242]);
      assert.ok(typeof err.evidence?.snapshotDirectory === "string" && existsSync(err.evidence.snapshotDirectory));
      return true;
    }
  );
  assert.equal(await readFile(path.join(root, "a.txt"), "utf8"), "edited-sync", "sync edits must not restore while kill is unconfirmed");
  const lockHolder = JSON.parse(await readFile(checkoutLockPath(root, locks), "utf8"));
  assert.deepEqual(lockHolder.survivors, [4242]); assert.equal(lockHolder.pid, process.pid);
  assert.equal(existsSync(path.join(process.env.BRIDGE_HEAVY_DIR!, "slot-1.json")), false, "heavy slot must be freed after killUnverified");
  assert.equal(existsSync(path.join(process.env.BRIDGE_HEAVY_DIR!, "slot-2.json")), false, "heavy slot must be freed after killUnverified");
  await assert.rejects(acquire(root, { lockDirectory: locks }), CheckoutBusyError);

  root = await mkdtemp(path.join(base, "async-"));
  process.env.BRIDGE_HEAVY_DIR = path.join(base, "async-heavy");
  // 3. Async TaskManager.cancel() while running with unconfirmed kill: stays waiting (input_required), retry refused, restore/keep offered, no auto-restore.
  await writeFile(path.join(root, "a.txt"), "baseline");
  let runStarted!: () => void;
  const startedRun = new Promise<void>(resolve => { runStarted = resolve; });
  const manager = new TaskManager({
    traceBase: path.join(base, "traces"),
    snapshotOptions: { snapshotBase: snapshots },
    runOptions: { checkoutLockDirectory: locks },
    runners: {
      edits: async (_input, runSignal) => {
        await writeFile(path.join(root, "a.txt"), "edited-async");
        runStarted();
        await new Promise<void>(resolve => {
          if (runSignal?.aborted) resolve();
          else runSignal?.addEventListener("abort", () => resolve(), { once: true });
        });
        throw new ClineRunError("cancelled", "cancelled", { processesStillAlive: [7171], killUnverified: true });
      }
    }
  });
  t.after(() => manager.shutdown(5_000));
  const task = manager.start({
    mode: "edits", prompt: "Edit", cwd: root, provider: "p", model: "m", codeMap: false,
    verify: { none: true, reason: "Async unconfirmed cancel fixture" }
  });
  await startedRun;
  const cancelledView = await manager.cancel(task.taskId);
  assert.equal(cancelledView.state, "input_required", "unconfirmed kill on cancel must end waiting, not restore");
  assert.deepEqual(cancelledView.question?.options, ["restore", "keep"]);
  assert.deepEqual(cancelledView.evidence?.processesStillAlive, [7171]);
  assert.ok(typeof cancelledView.evidence?.snapshotDirectory === "string" && existsSync(cancelledView.evidence.snapshotDirectory));
  assert.equal(await readFile(path.join(root, "a.txt"), "utf8"), "edited-async");
  await assert.rejects(manager.send(task.taskId, "retry", "retry"), (err: unknown) => err instanceof ClineRunError && /restore|keep/i.test(err.message));
});

test("DedicatedHubSession.stop counts a Job Object kill as confirmed even after settlement budget expires", async t => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1_000 });
  for (const stopped of [true, false]) {
    const session = new DedicatedHubSession();
    let closeCalls = 0;
    let receivedCap: number | undefined;
    session.jobs.current = {
      alive: true, assigned: true,
      assign() {},
      async close(cap) { closeCalls++; receivedCap = cap; return true as any; }
    };
    session.jobs.stopped = stopped;
    await session.environment(process.cwd(), {
      deps: {
        startHub: async () => ({
          env: { CLINE_HUB_PORT: "4321" },
          stop: b => stopDedicatedHub(4321, { hubStarted: async () => true, runHubStop: async () => false }, b)
        })
      }
    });
    session.launched = true;
    const budget = settlementBudget(0, undefined, Date.now);
    t.after(() => budget.dispose());
    t.mock.timers.tick(SETTLE_MARGIN_MS); // Settlement budget is now expired (remaining === 0, confirmRemaining > 0).
    await session.stop(budget);
    assert.ok(closeCalls >= 1);
    assert.ok((receivedCap ?? 0) >= 2_000, `job.close must get drain room, got ${receivedCap}`);
    assert.equal(session.unconfirmedStop, undefined, `stopped=${stopped}: Job Object confirmation must prevent spurious unconfirmedStop`);
    assert.deepEqual(session.warnings, []);
  }
});

test("verify exitGrace gets its full 500 ms inside the settle margin when the check exits at its deadline", { skip: process.platform !== "win32" && "Windows-only: an assigned Windows Job Object stands in for the tree check; on POSIX the real process-group check runs on a fake pid under mocked timers and never settles" }, async t => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1_000 });
  let started!: () => void;
  const launched = new Promise<void>(resolve => { started = resolve; });
  let proc!: ReturnType<typeof child>;
  mockSpawn(t, () => {
    proc = child();
    started();
    return Object.assign(proc, { pid: 12345 });
  });
  const job: WindowsJob = { alive: true, assigned: true, assign() {}, async close() { return true as any; } };
  const pending = runVerification({ command: process.execPath, timeoutSeconds: 1 }, process.cwd(), undefined, {
    now: Date.now,
    createWindowsJob: async () => job
  });
  await launched;
  // Advance to right before timeout, then advance to exact deadline and emit exit(0) before close arrives 50 ms later.
  t.mock.timers.tick(999);
  Date.now(); // clock is at 1999; jump to 2000 right as child exits without letting timer fire first.
  t.mock.timers.setTime(2_000);
  (proc as any).exitCode = 0;
  proc.emit("exit", 0, null);
  t.mock.timers.tick(50);
  proc.emit("close", 0, null);
  const result = await pending;
  assert.equal(result.passed, true, "exit at deadline followed by prompt close must not be treated as pipesHeldOpen");
  assert.equal(result.timedOut, false);
  assert.equal(result.killConfirmed, undefined);
});

test("timeout during keep preserves the snapshot and does not mark edits kept", async t => {
  const base = await mkdtemp(path.join(os.tmpdir(), "keep-timeout-"));
  t.after(() => rm(base, { recursive: true, force: true, maxRetries: 5 }));
  const root = path.join(base, "repo"), snapshots = path.join(base, "snapshots"), locks = path.join(base, "locks");
  await mkdir(root);
  await writeFile(path.join(root, "a.txt"), "baseline");
  let stallIdentity = false;
  let identityStarted!: () => void;
  const identityStalled = new Promise<void>(resolve => { identityStarted = resolve; });
  const gitMock = t.mock.method(childProcess, "spawn", (_file: string, args: string[]) => {
    const proc = child();
    const cmd = args[2], arg = args[3];
    if (stallIdentity && cmd === "rev-parse" && arg === "HEAD") {
      identityStarted();
      return proc; // stalls forever
    }
    let out = "";
    if (cmd === "rev-parse") out = arg === "--show-toplevel" ? root : arg === "--git-path" ? ".git/info/exclude" : "a".repeat(40);
    else if (cmd === "ls-files" && arg === "--stage") out = "";
    else if (cmd === "ls-files" && args.includes("--ignored")) out = "";
    else if (cmd === "ls-files") out = "a.txt\0";
    queueMicrotask(() => { proc.stdout.end(out); proc.emit("close", 0); });
    return proc;
  });
  syncBuiltinESMExports();
  t.after(() => { gitMock.mock.restore(); syncBuiltinESMExports(); });

  const lifecycle = new FinalCheckLifecycle(
    { prompt: "Edit", cwd: root, verify: { none: true, reason: "Keep timeout fixture" }, timeoutSeconds: 120 },
    {
      resolveRoot: async () => root, fits: () => true, question: text => text.startsWith("QUESTION:") ? { question: text } : undefined,
      lockDirectory: locks, snapshotOptions: { snapshotBase: snapshots },
      run: async () => ({ text: "QUESTION: Keep?", durationMs: 1 })
    }
  );
  t.after(() => lifecycle.release());
  await lifecycle.execute(new AbortController().signal);
  const snapDir = lifecycle.snapshot!.directory;
  stallIdentity = true;
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const keeping = lifecycle.keep();
  const rejected = assert.rejects(keeping, (err: unknown) => err instanceof Error && err.name === "TimeoutError");
  await identityStalled;
  t.mock.timers.tick(RESTORE_BUDGET_MS);
  await rejected;
  assert.equal(lifecycle.verification.kept, false);
  assert.ok(existsSync(snapDir), "snapshot must be kept when keep() times out");
});

test("combined runner confirmation and dedicated hub stop share one settlement budget", async t => {
  const folder = await mkdtemp(path.join(os.tmpdir(), "runner-hub-budget-"));
  t.after(() => rm(folder, { recursive: true, force: true }));
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1_000 });
  let started!: () => void;
  const launched = new Promise<void>(resolve => { started = resolve; });
  const pending = runCline({ prompt: "test", provider: "p", model: "m" }, undefined, {
    maxAttempts: 1, recordStatus: false, respectQuotaLock: false, deps: {
      platform: "win32", entryPath: "mock/cline", providerSettingsPath: path.join(folder, "providers.json"),
      access: async () => {}, acquireSettingsMutex: async () => async () => {},
      totalBudgetMs: 1_000, timeoutMs: 1_000, settlementDeadlineMs: 1_500, now: Date.now, killTree: () => {},
      createWindowsJob: async () => undefined,
      startHub: async () => ({
        env: { CLINE_HUB_PORT: "4321" },
        stop: b => stopDedicatedHub(4321, {
          hubStarted: async () => true,
          runHubStop: () => new Promise(() => {}) // hangs forever
        }, b)
      }),
      confirmTreeDead: () => new Promise(resolve => setTimeout(() => resolve({ confirmed: true, alive: [] }), 1_500)),
      spawn: (() => {
        started();
        return Object.assign(new childProcess.ChildProcess(), { pid: 12345, stdout: new PassThrough(), stderr: new PassThrough() });
      }) as typeof childProcess.spawn
    }
  });
  const rejected = assert.rejects(pending, (err: unknown) => {
    assert.ok(err instanceof ClineRunError);
    assert.equal(err.kind, "timeout");
    assert.ok(err.notes?.some(n => /hub/i.test(n)), JSON.stringify(err.notes));
    return true;
  });
  await launched;
  // 1 s work + 1.5 s confirmation + remaining 2.5 s for hub stop = 5 s total (1 s + SETTLE_MARGIN_MS).
  t.mock.timers.tick(1_000 + 1_500);
  await new Promise<void>(resolve => setImmediate(resolve));
  t.mock.timers.tick(SETTLE_MARGIN_MS - 1_500);
  await rejected;
  assert.equal(Date.now() - 1_000, 1_000 + SETTLE_MARGIN_MS);
});

// ---- Drained Job Object is not proof alone + three small fixes (fail on HEAD 69185cc) ----

test("a child alive outside a drained Job Object is NOT confirmed in verify or runner, and triggers no auto-restore", { skip: process.platform !== "win32" && "Windows-only: drained Windows Job Object scenario; POSIX uses process groups, not jobs" }, async t => {
  const base = await mkdtemp(path.join(os.tmpdir(), "job-escape-"));
  t.after(() => rm(base, { recursive: true, force: true, maxRetries: 5 }));
  let root = path.join(base, "repo");
  const snapshots = path.join(base, "snapshots"), locks = path.join(base, "locks");
  await mkdir(root);
  await writeFile(path.join(root, "a.txt"), "baseline");

  const drainedJob = (): WindowsJob => {
    let alive = true, assigned = false, confirmed = false;
    return {
      get alive() { return alive; },
      get assigned() { return assigned; },
      get confirmed() { return confirmed; },
      assign() { assigned = true; },
      async close() { alive = false; assigned = false; confirmed = true; return true; }
    };
  };

  // 1. runVerification timeout: drained job + live descendant in table => NOT confirmed.
  {
    t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1_000 });
    let started!: () => void;
    const launched = new Promise<void>(resolve => { started = resolve; });
    let verifyProc!: ReturnType<typeof child>;
    mockSpawn(t, file => {
      const p = child();
      if (file === process.execPath) { verifyProc = p; started(); return Object.assign(p, { pid: 12345 }); }
      return p;
    });
    let tableCalls = 0;
    const job = drainedJob();
    const origClose = job.close.bind(job);
    job.close = async () => {
      const ok = await origClose();
      queueMicrotask(() => { (verifyProc as any).exitCode = 1; verifyProc.emit("exit", 1, null); verifyProc.emit("close", 1, null); });
      return ok;
    };
    const pending = runVerification({ command: process.execPath, timeoutSeconds: 1 }, process.cwd(), undefined, {
      now: Date.now,
      createWindowsJob: async () => job,
      confirmTreeDead: async () => { tableCalls++; return { confirmed: false, alive: [9001] }; }
    });
    await launched;
    t.mock.timers.tick(1_000);
    const result = await pending;
    assert.equal(tableCalls, 1, "confirmTreeDead must still run after a drained job");
    assert.equal(result.passed, false);
    assert.equal(result.killConfirmed, false);
    assert.deepEqual(result.stillAlive, [9001]);
    t.mock.timers.reset();
  }

  // 2. runVerification pipesHeldOpen: root exits 0, drained job + live descendant => NOT confirmed, no auto-restore in lifecycle.
  {
    t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1_000 });
    let started!: () => void;
    const launched = new Promise<void>(resolve => { started = resolve; });
    let verifyProc!: ReturnType<typeof child>;
    mockSpawn(t, file => {
      const p = child();
      if (file === process.execPath) { verifyProc = p; started(); return Object.assign(p, { pid: 12346 }); }
      return p;
    });
    let tableCalls = 0;
    const pending = runVerification({ command: process.execPath, timeoutSeconds: 10 }, process.cwd(), undefined, {
      now: Date.now,
      createWindowsJob: async () => drainedJob(),
      confirmTreeDead: async () => { tableCalls++; return { confirmed: false, alive: [9002] }; }
    });
    await launched;
    // Root exits cleanly, but a child outside the job keeps pipes open (no close event).
    (verifyProc as any).exitCode = 0;
    verifyProc.emit("exit", 0, null);
    t.mock.timers.tick(500);
    const result = await pending;
    assert.equal(tableCalls, 1, "pipesHeldOpen must still run confirmTreeDead after a drained job");
    assert.equal(result.passed, false);
    assert.equal(result.killConfirmed, false);
    assert.deepEqual(result.stillAlive, [9002]);
    t.mock.timers.reset();
  }

  // 3. Sync applyClineEdits with drained job + live descendant in runner (timeout and exit-with-held-pipes): NOT confirmed, NO auto-restore.
  const prevSnapDir = process.env.CLINE_MCP_SNAPSHOT_DIR;
  process.env.CLINE_MCP_SNAPSHOT_DIR = snapshots;
  t.after(() => { if (prevSnapDir === undefined) delete process.env.CLINE_MCP_SNAPSHOT_DIR; else process.env.CLINE_MCP_SNAPSHOT_DIR = prevSnapDir; });

  const gitStub = t.mock.method(childProcess, "spawn", (_file: string, args: string[]) => {
    const proc = child();
    const cmd = args[2], arg = args[3];
    let out = "";
    if (cmd === "rev-parse") out = arg === "--show-toplevel" ? root : arg === "--git-path" ? ".git/info/exclude" : "a".repeat(40);
    else if (cmd === "ls-files" && arg === "--stage") out = "";
    else if (cmd === "ls-files" && args.includes("--ignored")) out = "";
    else if (cmd === "ls-files") out = "a.txt\0";
    queueMicrotask(() => { proc.stdout.end(out); proc.emit("close", 0); });
    return proc;
  });
  syncBuiltinESMExports();
  t.after(() => { gitStub.mock.restore(); syncBuiltinESMExports(); });

  for (const mode of ["timeout", "pipesHeldOpen"] as const) {
    root = await mkdtemp(path.join(base, mode));
    await writeFile(path.join(root, "a.txt"), "baseline");
    const alivePid = mode === "timeout" ? 9003 : 9004;
    let tableCalls = 0;
    await assert.rejects(
      applyClineEdits(
        { prompt: "Edit", cwd: root, provider: "p", model: "m", codeMap: false, verify: { none: true, reason: `Escaped child ${mode} fixture` } },
        undefined,
        {
          checkoutLockDirectory: locks, recordStatus: false, respectQuotaLock: false,
          deps: {
            platform: "win32", entryPath: "mock/cline", providerSettingsPath: path.join(base, "providers.json"),
            access: async () => {}, acquireSettingsMutex: async () => async () => {},
            totalBudgetMs: 2_000, timeoutMs: mode === "timeout" ? 40 : 2_000,
            closeGracePeriodMs: 25, settlementDeadlineMs: 200,
            createWindowsJob: async () => drainedJob(),
            killTree: () => {},
            confirmTreeDead: async () => { tableCalls++; return { confirmed: false, alive: [alivePid] }; },
            spawn: (() => {
              const proc = Object.assign(new childProcess.ChildProcess(), { pid: 4242, stdout: new PassThrough(), stderr: new PassThrough() });
              void writeFile(path.join(root, "a.txt"), `edited-${mode}`).then(() => {
                if (mode === "pipesHeldOpen") {
                  (proc.stdout as PassThrough).write('{"type":"run_result","finishReason":"completed","text":"done"}\n');
                  (proc as any).exitCode = 0;
                  proc.emit("exit", 0, null);
                  // Deliberately do NOT emit "close" — simulates an escaped child holding pipes open.
                }
              });
              return proc;
            }) as typeof childProcess.spawn
          }
        }
      ),
      (err: any) => {
        assert.equal(err.verification?.restored, false, `${mode}: must NOT auto-restore`);
        assert.deepEqual(err.evidence?.processesStillAlive, [alivePid]);
        assert.ok(typeof err.evidence?.snapshotDirectory === "string" && existsSync(err.evidence.snapshotDirectory));
        return true;
      }
    );
    assert.equal(tableCalls, 1, `${mode}: runner must run confirmTreeDead after drained job`);
    assert.equal(await readFile(path.join(root, "a.txt"), "utf8"), `edited-${mode}`, `${mode}: file must stay unrestored`);
  }
});

test("drained Job Object + unreadable process table: confirmed without pipesHeldOpen, unconfirmed with pipesHeldOpen", { skip: process.platform !== "win32" && "Windows-only: drained Windows Job Object scenario; POSIX uses process groups, not jobs" }, async t => {
  const drainedJob = (): WindowsJob => {
    let alive = true, assigned = false, confirmed = false;
    return {
      get alive() { return alive; },
      get assigned() { return assigned; },
      get confirmed() { return confirmed; },
      assign() { assigned = true; },
      async close() { alive = false; assigned = false; confirmed = true; return true; }
    };
  };

  // 1. runVerification: timeout (pipesHeldOpen = false) + drained job + unreadable table => confirmed.
  {
    t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1_000 });
    let started!: () => void;
    const launched = new Promise<void>(resolve => { started = resolve; });
    let verifyProc!: ReturnType<typeof child>;
    mockSpawn(t, file => {
      const p = child();
      if (file === process.execPath) { verifyProc = p; started(); return Object.assign(p, { pid: 12345 }); }
      return p;
    });
    let tableCalls = 0;
    const job = drainedJob();
    const origClose = job.close.bind(job);
    job.close = async () => {
      const ok = await origClose();
      queueMicrotask(() => { (verifyProc as any).exitCode = 1; verifyProc.emit("exit", 1, null); verifyProc.emit("close", 1, null); });
      return ok;
    };
    const pending = runVerification({ command: process.execPath, timeoutSeconds: 1 }, process.cwd(), undefined, {
      now: Date.now,
      createWindowsJob: async () => job,
      confirmTreeDead: async () => { tableCalls++; return { confirmed: false, alive: [], unverified: true }; }
    });
    await launched;
    t.mock.timers.tick(1_000);
    const result = await pending;
    assert.equal(tableCalls, 1);
    assert.equal(result.timedOut, true);
    assert.equal(result.killConfirmed, undefined);
    assert.equal(result.killUnverified, undefined);
    t.mock.timers.reset();
  }

  // 2. runVerification: pipesHeldOpen = true + drained job + unreadable table => unconfirmed (unverified: true).
  {
    t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1_000 });
    let started!: () => void;
    const launched = new Promise<void>(resolve => { started = resolve; });
    let verifyProc!: ReturnType<typeof child>;
    mockSpawn(t, file => {
      const p = child();
      if (file === process.execPath) { verifyProc = p; started(); return Object.assign(p, { pid: 12346 }); }
      return p;
    });
    let tableCalls = 0;
    const pending = runVerification({ command: process.execPath, timeoutSeconds: 10 }, process.cwd(), undefined, {
      now: Date.now,
      createWindowsJob: async () => drainedJob(),
      confirmTreeDead: async () => { tableCalls++; return { confirmed: false, alive: [], unverified: true }; }
    });
    await launched;
    (verifyProc as any).exitCode = 0;
    verifyProc.emit("exit", 0, null);
    t.mock.timers.tick(500);
    const result = await pending;
    assert.equal(tableCalls, 1);
    assert.equal(result.passed, false);
    assert.equal(result.killConfirmed, false);
    assert.equal(result.killUnverified, true);
    t.mock.timers.reset();
  }

  // 3. runner: exit-with-held-pipes + drained job + unreadable table => unconfirmed (no auto-restore).
  {
    const base = await mkdtemp(path.join(os.tmpdir(), "runner-unreadable-pipes-"));
    t.after(() => rm(base, { recursive: true, force: true, maxRetries: 5 }));
    const root = path.join(base, "repo"), snapshots = path.join(base, "snapshots"), locks = path.join(base, "locks");
    await mkdir(root);
    await writeFile(path.join(root, "a.txt"), "baseline");
    const prevSnapDir = process.env.CLINE_MCP_SNAPSHOT_DIR;
    process.env.CLINE_MCP_SNAPSHOT_DIR = snapshots;
    t.after(() => { if (prevSnapDir === undefined) delete process.env.CLINE_MCP_SNAPSHOT_DIR; else process.env.CLINE_MCP_SNAPSHOT_DIR = prevSnapDir; });
    const gitStub = t.mock.method(childProcess, "spawn", (_file: string, args: string[]) => {
      const proc = child();
      const cmd = args[2], arg = args[3];
      let out = "";
      if (cmd === "rev-parse") out = arg === "--show-toplevel" ? root : arg === "--git-path" ? ".git/info/exclude" : "a".repeat(40);
      else if (cmd === "ls-files" && arg === "--stage") out = "";
      else if (cmd === "ls-files" && args.includes("--ignored")) out = "";
      else if (cmd === "ls-files") out = "a.txt\0";
      queueMicrotask(() => { proc.stdout.end(out); proc.emit("close", 0); });
      return proc;
    });
    syncBuiltinESMExports();
    t.after(() => { gitStub.mock.restore(); syncBuiltinESMExports(); });

    let tableCalls = 0;
    await assert.rejects(
      applyClineEdits(
        { prompt: "Edit", cwd: root, provider: "p", model: "m", codeMap: false, verify: { none: true, reason: "Unreadable table pipesHeldOpen fixture" } },
        undefined,
        {
          checkoutLockDirectory: locks, recordStatus: false, respectQuotaLock: false,
          deps: {
            platform: "win32", entryPath: "mock/cline", providerSettingsPath: path.join(base, "providers.json"),
            access: async () => {}, acquireSettingsMutex: async () => async () => {},
            totalBudgetMs: 2_000, timeoutMs: 2_000, closeGracePeriodMs: 25, settlementDeadlineMs: 200,
            createWindowsJob: async () => drainedJob(),
            killTree: () => {},
            confirmTreeDead: async () => { tableCalls++; return { confirmed: false, alive: [], unverified: true }; },
            spawn: (() => {
              const proc = Object.assign(new childProcess.ChildProcess(), { pid: 4243, stdout: new PassThrough(), stderr: new PassThrough() });
              void writeFile(path.join(root, "a.txt"), "edited-unreadable").then(() => {
                (proc.stdout as PassThrough).write('{"type":"run_result","finishReason":"completed","text":"done"}\n');
                (proc as any).exitCode = 0;
                proc.emit("exit", 0, null);
              });
              return proc;
            }) as typeof childProcess.spawn
          }
        }
      ),
      (err: any) => {
        assert.equal(err.verification?.restored, false);
        assert.equal(err.evidence?.killUnverified, true);
        assert.ok(typeof err.evidence?.snapshotDirectory === "string" && existsSync(err.evidence.snapshotDirectory));
        return true;
      }
    );
    assert.equal(tableCalls, 1);
    assert.equal(await readFile(path.join(root, "a.txt"), "utf8"), "edited-unreadable");
  }
});

test("jobobject close() resolves false if any queued root was never sent or assigned", { skip: process.platform !== "win32" }, async t => {
  // Ensure helper binary exists once, then stub owner.exe so we can control protocol replies deterministically.
  const warmup = await createWindowsJob(15_000);
  await warmup?.close();

  const makeFakeRoot = (pid: number) => Object.assign(new childProcess.ChildProcess(), { pid, exitCode: null as number | null, signalCode: null as NodeJS.Signals | null });

  const runOwnerScenario = async (scenario: "queued-exited" | "first-skipped-second-assigned" | "assign-already-dead" | "all-assigned") => {
    let helper!: ReturnType<typeof child>;
    let receivedLines: string[] = [];
    const stub = t.mock.method(childProcess, "spawn", ((file: string) => {
      assert.equal(path.basename(file), "owner.exe");
      const proc = child();
      helper = Object.assign(proc, { unref: () => {}, ref: () => {} });
      let buf = "";
      let stdinEnded = false;
      const emitDrainedAndExit = () => {
        proc.stdout.write("drained\n");
        proc.stdout.end();
        (proc as any).exitCode = 0;
        proc.emit("exit", 0, null);
        proc.emit("close", 0, null);
      };
      proc.stdin.on("data", (chunk: Buffer) => {
        buf += chunk.toString("utf8");
        const parts = buf.split(/\r?\n/);
        buf = parts.pop()!;
        for (const line of parts) {
          if (!line) continue;
          receivedLines.push(line);
          if (/^\d+$/.test(line)) {
            if (scenario === "queued-exited" && receivedLines.length === 1) {
              // Delay replying to root1 until the caller queues root2 and root2 exits.
              continue;
            }
            proc.stdout.write("opened\n");
          } else if (line === "assign" || line === "skip") {
            const reply = (scenario === "first-skipped-second-assigned" && receivedLines.filter(l => l === "assign" || l === "skip").length === 1)
              ? "skipped" : (line === "assign" ? "assigned" : "skipped");
            proc.stdout.write(reply + "\n");
          }
        }
      });
      proc.stdin.on("end", () => {
        stdinEnded = true;
        emitDrainedAndExit();
      });
      queueMicrotask(() => proc.stdout.write("ready\n"));
      return Object.assign(helper, { emitOpened: () => proc.stdout.write("opened\n"), stdinEnded: () => stdinEnded });
    }) as unknown as typeof childProcess.spawn);
    syncBuiltinESMExports();
    try {
      const job = await createWindowsJob(15_000);
      assert.ok(job);
      if (scenario === "queued-exited") {
        const root1 = makeFakeRoot(1001);
        const root2 = makeFakeRoot(1002);
        job.assign(root1);
        job.assign(root2); // stays in `queued` while root1 is pending
        (root2 as any).exitCode = 0; // root2 exits before sendNext() can send it
        (helper as any).emitOpened();
        const confirmed = await job.close();
        assert.equal(confirmed, false, "queued root2 was never sent/assigned: close() must resolve false");
        assert.equal(job.confirmed, false);
      } else if (scenario === "first-skipped-second-assigned") {
        const root1 = makeFakeRoot(2001);
        const root2 = makeFakeRoot(2002);
        job.assign(root1);
        await new Promise(r => setTimeout(r, 10));
        job.assign(root2);
        await new Promise(r => setTimeout(r, 10));
        assert.equal(job.assigned, true);
        const confirmed = await job.close();
        assert.equal(confirmed, false, "root1 was skipped even though root2 succeeded: close() must resolve false");
        assert.equal(job.confirmed, false);
      } else if (scenario === "assign-already-dead") {
        const root1 = makeFakeRoot(3001);
        const deadRoot2 = makeFakeRoot(3002);
        (deadRoot2 as any).exitCode = 0;
        job.assign(root1);
        await new Promise(r => setTimeout(r, 10));
        assert.equal(job.assigned, true);
        job.assign(deadRoot2);
        const confirmed = await job.close();
        assert.equal(confirmed, false, "deadRoot2 was never assigned: close() must resolve false");
        assert.equal(job.confirmed, false);
      } else {
        const root1 = makeFakeRoot(4001);
        const root2 = makeFakeRoot(4002);
        job.assign(root1);
        job.assign(root2);
        const confirmed = await job.close();
        assert.equal(confirmed, true, "all queued roots assigned and drained: close() must resolve true");
        assert.equal(job.confirmed, true);
      }
    } finally {
      stub.mock.restore();
      syncBuiltinESMExports();
    }
  };

  await runOwnerScenario("queued-exited");
  await runOwnerScenario("first-skipped-second-assigned");
  await runOwnerScenario("assign-already-dead");
  await runOwnerScenario("all-assigned");
});

test("sync applyClineEdits after a partial restore keeps original failure reason (budget/cancel/verify) and notes incomplete restore", async t => {
  const base = await mkdtemp(path.join(os.tmpdir(), "sync-partial-restore-msg-"));
  t.after(() => rm(base, { recursive: true, force: true, maxRetries: 5 }));
  const root = path.join(base, "repo"), snapshots = path.join(base, "snapshots"), locks = path.join(base, "locks");
  await mkdir(root);
  const prevSnapDir = process.env.CLINE_MCP_SNAPSHOT_DIR;
  process.env.CLINE_MCP_SNAPSHOT_DIR = snapshots;
  t.after(() => { if (prevSnapDir === undefined) delete process.env.CLINE_MCP_SNAPSHOT_DIR; else process.env.CLINE_MCP_SNAPSHOT_DIR = prevSnapDir; });

  const breakBForPartialRestore = async () => {
    await writeFile(path.join(root, "a.txt"), "edited");
    await rm(path.join(root, "b.txt"), { recursive: true, force: true });
    await mkdir(path.join(root, "b.txt"));
    await writeFile(path.join(root, "b.txt", "nested.txt"), "blocks rmdir so restoreEntry fails");
  };

  const combinedStub = t.mock.method(childProcess, "spawn", (file: string, args: string[]) => {
    const proc = child();
    if (file === process.execPath) {
      queueMicrotask(() => { (proc as any).exitCode = 1; proc.emit("exit", 1, null); proc.emit("close", 1, null); });
      return Object.assign(proc, { pid: 5555 });
    }
    if (path.basename(file) === "owner.exe") {
      let buf = "";
      proc.stdin.on("data", (chunk: Buffer) => {
        buf += chunk.toString("utf8");
        const parts = buf.split(/\r?\n/);
        buf = parts.pop()!;
        for (const line of parts) {
          if (/^\d+$/.test(line)) proc.stdout.write("opened\n");
          else if (line === "assign") proc.stdout.write("assigned\n");
          else if (line === "skip") proc.stdout.write("skipped\n");
        }
      });
      proc.stdin.on("end", () => {
        proc.stdout.write("drained\n");
        proc.stdout.end();
        (proc as any).exitCode = 0;
        proc.emit("exit", 0, null);
        proc.emit("close", 0, null);
      });
      queueMicrotask(() => proc.stdout.write("ready\n"));
      return Object.assign(proc, { unref: () => {}, ref: () => {} });
    }
    const cmd = args[2], arg = args[3];
    let out = "";
    if (cmd === "rev-parse") out = arg === "--show-toplevel" ? root : arg === "--git-path" ? ".git/info/exclude" : "a".repeat(40);
    else if (cmd === "ls-files" && arg === "--stage") out = "";
    else if (cmd === "ls-files" && args.includes("--ignored")) out = "";
    else if (cmd === "ls-files") out = "a.txt\0b.txt\0";
    else if (cmd === "check-ignore") out = "";
    queueMicrotask(() => { proc.stdout.end(out); proc.emit("close", 0); });
    return proc;
  });
  syncBuiltinESMExports();
  t.after(() => { combinedStub.mock.restore(); syncBuiltinESMExports(); });

  for (const mode of ["verify", "budget", "cancel"] as const) {
    await rm(path.join(root, "b.txt"), { recursive: true, force: true });
    await writeFile(path.join(root, "a.txt"), "base-a");
    await writeFile(path.join(root, "b.txt"), "base-b");
    const controller = new AbortController();
    const verifySpec = mode === "verify"
      ? { command: process.execPath, args: ["-e", "process.exit(1)"] }
      : { none: true as const, reason: `Partial restore ${mode} fixture` };

    await assert.rejects(
      applyClineEdits(
        { prompt: "Edit", cwd: root, provider: "p", model: "m", codeMap: false, maxFixRuns: 0, verify: verifySpec },
        controller.signal,
        {
          checkoutLockDirectory: locks, recordStatus: false, respectQuotaLock: false,
          deps: {
            platform: "win32", entryPath: "mock/cline", providerSettingsPath: path.join(base, "providers.json"),
            access: async () => {}, acquireSettingsMutex: async () => async () => {},
            totalBudgetMs: mode === "budget" ? 40 : 10_000,
            timeoutMs: mode === "budget" ? 40 : 10_000,
            settlementDeadlineMs: 100,
            createWindowsJob: async () => undefined,
            killTree: () => {},
            confirmTreeDead: async () => ({ confirmed: true, alive: [] }),
            spawn: (() => {
              const proc = Object.assign(child(), { pid: 4444 });
              void breakBForPartialRestore().then(() => {
                if (mode === "verify") {
                  proc.stdout.write('{"type":"run_result","finishReason":"completed","text":"done"}\n');
                  (proc as any).exitCode = 0;
                  proc.emit("exit", 0, null);
                  proc.emit("close", 0, null);
                } else if (mode === "cancel") {
                  controller.abort();
                  (proc as any).exitCode = 1;
                  proc.emit("exit", 1, null);
                  proc.emit("close", 1, null);
                }
                // For mode === "budget", leave proc running until timeoutMs fires.
              });
              return proc;
            }) as unknown as typeof childProcess.spawn
          }
        }
      ),
      (err: unknown) => {
        assert.ok(err instanceof ClineRunError, `expected ClineRunError, got ${String(err)}`);
        assert.doesNotMatch(err.message, /Edit failed:\s*cline_error/i, `${mode}: must not degrade to generic cline_error: ${err.message}`);
        assert.match(err.message, /incomplete/i, `${mode}: must mention incomplete restore: ${err.message}`);
        if (mode === "verify") assert.match(err.message, /verif/i, `${mode}: must preserve verify reason: ${err.message}`);
        if (mode === "budget") assert.match(err.message, /timed out|budget/i, `${mode}: must preserve budget/timeout reason: ${err.message}`);
        if (mode === "cancel") {
          assert.equal(err.kind, "cancelled");
          assert.match(err.message, /cancel/i, `${mode}: must preserve cancel reason: ${err.message}`);
        }
        const report = (err as any).evidence?.restore as { failed?: Array<{ path: string }> } | undefined;
        assert.ok(report?.failed?.some(f => f.path === "b.txt"), `${mode}: evidence.restore must list b.txt`);
        return true;
      }
    );
  }
});

test("snapshot finishPartial adds an explicit failed entry when the deadline hits before the created-files scan ran, even with non-empty manifest", async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "snap-no-created-scan-"));
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 5 }));
  const handle = {
    checkoutRoot: dir,
    directory: path.join(dir, "store"),
    manifest: [{ path: "a.txt", size: 4, sha256: "0".repeat(64) }]
  };
  let lsFilesStarted!: () => void;
  const lsFilesRunning = new Promise<void>(resolve => { lsFilesStarted = resolve; });
  mockSpawn(t, (_file, args) => {
    const proc = child();
    if (args.includes("--show-toplevel")) {
      queueMicrotask(() => { proc.stdout.end(dir); proc.emit("close", 0); });
    } else {
      // Stall during the created-files scan (ls-files --stage / regular) until RESTORE_BUDGET_MS expires.
      lsFilesStarted();
    }
    return proc;
  });
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const restoring = restoreSnapshot(handle);
  await lsFilesRunning;
  t.mock.timers.tick(RESTORE_BUDGET_MS);
  const report = await restoring;
  assert.ok(
    report.failed.some(f => f.path === "a.txt" && /not attempted/i.test(f.error)),
    `manifest file should be marked not attempted: ${JSON.stringify(report.failed)}`
  );
  assert.ok(
    report.failed.some(f => /created-files scan did not run/i.test(f.error)),
    `must include explicit failed entry saying created-files scan did not run: ${JSON.stringify(report.failed)}`
  );
});
