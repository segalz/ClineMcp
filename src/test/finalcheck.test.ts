import assert from "node:assert/strict";
import "./git-test-serial.js";
import { TEST_WAIT_MS } from "./test-waits.js";
import test, { after } from "node:test";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import { mkdtemp, writeFile, readFile, mkdir, rm, readdir } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import { EventEmitter, once } from "node:events";
import { FinalCheckLifecycle, buildFixPrompt, verificationSchema, maxFixRunsSchema, startTaskSchema, editActionSchema, type VerifySpec } from "../finalcheck.js";
import { TaskManager, type TaskStatusView, type TaskManagerDeps } from "../tasks.js";
import { applyClineEdits, editPromptFits, editQuestion } from "../edits.js";
import { ClineRunError, stopDedicatedHub } from "../runner.js";
import { headAndIndexIdentity } from "../snapshot.js";
import { acquire, CheckoutBusyError } from "../checkoutlock.js";
import { acquireHeavySlot, type QueuePosition } from "../heavyslots.js";
import { VerificationError } from "../verify.js";

const snapshotDir = await mkdtemp(path.join(os.tmpdir(), "cline-finalcheck-snapshots-"));
process.env.CLINE_MCP_SNAPSHOT_DIR = snapshotDir;
after(() => rm(snapshotDir, { recursive: true, force: true, maxRetries: 5 }));

const verify = { command: process.execPath, args: ["-e", 'process.exit(require("fs").readFileSync("a","utf8")==="pass"?0:7)'] };
const none = { none: true as const, reason: "Explicit test opt-out" };
function git(cwd: string, ...args: string[]): string {
  const r = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8", windowsHide: true, env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" } });
  assert.equal(r.status, 0, r.stderr); return r.stdout.trim();
}
async function fixture(t: test.TestContext) {
  const base = await mkdtemp(path.join(os.tmpdir(), "cline-final-"));
  t.after(() => rm(base, { recursive: true, force: true, maxRetries: 5 }));
  const cwd = path.join(base, "repo"), locks = path.join(base, "locks"), snapshots = path.join(base, "snapshots");
  await mkdir(cwd); git(cwd, "init", "--quiet");
  await writeFile(path.join(cwd, "a"), "committed"); git(cwd, "add", ".");
  git(cwd, "-c", "user.name=Test", "-c", "user.email=t@example.invalid", "commit", "-qm", "baseline");
  await writeFile(path.join(cwd, "a"), "staged"); git(cwd, "add", "a");
  await writeFile(path.join(cwd, "a"), "dirty"); await writeFile(path.join(cwd, "untracked"), Buffer.from([0, 255]));
  const identity = await headAndIndexIdentity(cwd);
  const put = (text: string) => writeFile(path.join(cwd, "a"), text);
  const bytes = () => readFile(path.join(cwd, "a"), "utf8");
  const clean = async () => { assert.equal(await bytes(), "dirty"); assert.deepEqual(await headAndIndexIdentity(cwd), identity);
    assert.deepEqual(await readFile(path.join(cwd, "untracked")), Buffer.from([0, 255])); };
  return { base, cwd, locks, snapshots, identity, put, bytes, clean };
}
async function until<T>(read: () => Promise<T>, predicate: (value: T) => boolean): Promise<T> {
  const deadline = Date.now() + TEST_WAIT_MS;
  while (true) { const value = await read(); if (predicate(value)) return value;
    assert.ok(Date.now() < deadline, JSON.stringify(value)); await new Promise(r => setTimeout(r, 10)); }
}

test("strict verification union, required edits verification, and optional context prompt fitting", () => {
  for (const value of [undefined, { none: true, reason: "short" }, { ...none, command: "node" }, { command: "node", extra: true }, { none: true, reason: " ".repeat(20) }])
    assert.equal(verificationSchema.safeParse(value).success, false);
  const m = new TaskManager();
  assert.throws(() => m.start({ mode: "edits", cwd: "repo", prompt: "x", provider: "p", model: "m" }), /verify/);
  for (const limit of [-1, 4, 1.5]) assert.equal(maxFixRunsSchema.safeParse(limit).success, false);
  const attempt = { run: 1, passed: false, exitCode: 7, signal: null, timedOut: false, killedForOutput: false, durationMs: 1,
    stdoutTail: "x".repeat(8192), stderrTail: "y".repeat(8192) };
  const fits = (prompt: string) => editPromptFits({ cwd: process.cwd(), prompt, provider: "p", model: "m" });
  const prompt = buildFixPrompt("objective".repeat(1700), verify, attempt, "Latest guidance", fits);
  assert.match(prompt, /Latest guidance/); assert.match(prompt, /never weaken or bypass/); assert.ok(fits(prompt));
  assert.throws(() => buildFixPrompt("x".repeat(20000), verify, attempt, "g".repeat(20000), fits), /limits/);
});

test("start schemas reject removed orchestration fields and actions while preserving shared validation", () => {
  const input = { mode: "edits", cwd: "repo", prompt: "Implement", provider: "p", model: "m", verify: none };
  assert.equal(startTaskSchema.safeParse(input).success, true);
  for (const removed of [{ steps: [] }, { stepBudget: {} }, { extra: true }, { keepOnFailure: true }])
    assert.equal(startTaskSchema.safeParse({ ...input, ...removed }).success, false);
  for (const mode of ["ask", "workspace"]) {
    assert.equal(startTaskSchema.safeParse({ ...input, mode }).success, false);
    const { verify: _verify, ...plain } = input;
    assert.equal(startTaskSchema.safeParse({ ...plain, mode }).success, true);
    assert.equal(startTaskSchema.safeParse({ ...plain, mode, maxFixRuns: 0 }).success, false);
  }
  assert.equal(startTaskSchema.safeParse({ ...input, guard: { unexpected: true } }).success, false);
  assert.equal(startTaskSchema.safeParse({ ...input, verify: { command: "node", args: ["x".repeat(65536)] } }).success, false);
  for (const removed of ["skip", "stop"]) assert.equal(editActionSchema.safeParse(removed).success, false);
  for (const action of ["retry", "restore", "keep"]) assert.equal(editActionSchema.safeParse(action).success, true);
});

test("shared lifecycle passes first time and fail/fix/pass retains the original dirty baseline", async t => {
  for (const failFirst of [false, true]) {
    const f = await fixture(t); let runs = 0;
    const lifecycle = new FinalCheckLifecycle({ prompt: "Implement", cwd: f.cwd, verify }, {
      resolveRoot: async cwd => cwd, fits: () => true, question: editQuestion, lockDirectory: f.locks,
      snapshotOptions: { snapshotBase: f.snapshots },
      run: async (prompt, _signal, lock, guard) => {
        assert.ok(lock); assert.ok(guard.maxToolCalls! <= 150);
        if (runs++) { assert.equal(await f.bytes(), "failed"); assert.match(prompt, /exit=7/); }
        await f.put(failFirst && runs === 1 ? "failed" : "pass");
        return { text: "done", durationMs: 1, usage: { inputTokens: 10 } } as any;
      }
    });
    await lifecycle.execute(new AbortController().signal);
    assert.equal(lifecycle.phase, "done"); assert.equal(lifecycle.verification.passed, true);
    assert.equal(lifecycle.verification.fixRuns, failFirst ? 1 : 0); assert.equal(lifecycle.usage.inputTokens, failFirst ? 20 : 10);
    lifecycle.release(); assert.deepEqual(await readdir(f.snapshots), []);
  }
});

test("a first run left under a minute after the check's reserve is refused before the model starts", async t => {
  // Live use 2026-11-21: verify 240 s of a 300 s budget left Cline 47 s, and the run could only time out.
  const f = await fixture(t); let runs = 0;
  const lifecycle = new FinalCheckLifecycle({ prompt: "Implement", cwd: f.cwd, timeoutSeconds: 300, verify: { ...verify, timeoutSeconds: 240 } }, {
    resolveRoot: async cwd => cwd, fits: () => true, question: editQuestion, lockDirectory: f.locks,
    snapshotOptions: { snapshotBase: f.snapshots },
    run: async () => { runs++; return { text: "done", durationMs: 1 } as any; }
  });
  await lifecycle.execute(new AbortController().signal);
  assert.equal(runs, 0);
  assert.equal(lifecycle.phase, "waiting");
  assert.equal(lifecycle.waitReason, "budget");
  assert.match(String((lifecycle.error as Error)?.message), /left for Cline after reserving 250 s for the check/);
  lifecycle.release();
});

test("a run stopped by the guard still reports its measured duration", async t => {
  // Live use 2026-11-22 (Stage 14 run 6): a loop_detected run of tens of seconds reported durationMs 0.
  const f = await fixture(t);
  const lifecycle = new FinalCheckLifecycle({ prompt: "Implement", cwd: f.cwd, verify }, {
    resolveRoot: async cwd => cwd, fits: () => true, question: editQuestion, lockDirectory: f.locks,
    snapshotOptions: { snapshotBase: f.snapshots },
    run: async () => {
      await new Promise(resolve => setTimeout(resolve, 60));
      throw new ClineRunError("loop_detected", "Stopped by the bridge: 3 failed edits");
    }
  });
  await lifecycle.execute(new AbortController().signal);
  assert.equal(lifecycle.waitReason, "guard");
  assert.ok(lifecycle.durationMs >= 50, String(lifecycle.durationMs));
  lifecycle.release();
});

test("sync failure restores by default, keepOnFailure retains changes, and none reports its reason", async t => {
  for (const keepOnFailure of [false, true]) {
    const f = await fixture(t);
    const deps = { entryPath: "fake", access: async () => {}, acquireSettingsMutex: async () => async () => {},
      spawn: (() => {
        const child = new EventEmitter() as any; child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.pid = 999; child.kill = () => {};
        void f.put("failed").then(() => { child.stdout.emit("data", Buffer.from('{"type":"run_result","finishReason":"success","text":"done"}\n')); child.emit("close", 0); });
        return child;
      }) as any };
    process.env.CLINE_PROVIDER_SETTINGS_PATH = path.join(f.base, "providers.json");
    process.env.CLINE_MCP_STATE_PATH = path.join(f.base, "state.json"); process.env.CLINE_MCP_STATUS_PATH = path.join(f.base, "status.json");
    process.env.CLINE_MCP_CATALOG_PATH = path.join(f.base, "catalog.json"); process.env.CLINE_MCP_TRACE_DIR = path.join(f.base, "traces");
    await assert.rejects(applyClineEdits({ prompt: "Implement", cwd: f.cwd, verify, maxFixRuns: 2, keepOnFailure,
      provider: "p", model: "m", codeMap: false }, undefined, { deps: deps as any, checkoutLockDirectory: f.locks }), (e: any) => {
      assert.equal(e.verification.restored, !keepOnFailure); assert.equal(e.verification.kept, keepOnFailure);
      assert.equal(e.verification.fixRuns, 2); assert.equal(e.verification.attempts.length, 3);
      assert.equal(e.verification.passed, false); assert.match(e.evidence.gitDiff, /failed/); return true;
    });
    if (keepOnFailure) assert.equal(await f.bytes(), "failed"); else await f.clean();
    const result = await applyClineEdits({ prompt: "Implement", cwd: f.cwd, verify: none,
      provider: "p", model: "m", codeMap: false }, undefined, { deps: deps as any, checkoutLockDirectory: f.locks });
    assert.equal(result.verification.passed, null); assert.equal(result.verification.reason, none.reason);
    assert.deepEqual(result.verification.attempts, []);
  }
});

async function asyncFixture(t: test.TestContext, spec: VerifySpec = verify, extra: TaskManagerDeps = {}) {
  const f = await fixture(t);
  const runs: Array<{ input: any; options: any; signal: AbortSignal; finish: (text?: string, guard?: any) => void; fail: (error: unknown) => void }> = [];
  const waiters: Array<{ count: number; resolve: () => void }> = [];
  const manager = new TaskManager({ ...extra, traceBase: path.join(f.base, "traces"), snapshotOptions: { snapshotBase: f.snapshots },
    runOptions: { checkoutLockDirectory: f.locks }, runners: { edits: (input, signal, options) => new Promise((resolve, reject) => {
      runs.push({ input, options, signal, finish: (text = "done", guard) => resolve({ text, durationMs: 1, guard, usage: { inputTokens: 10 } } as any), fail: reject });
      for (let i = waiters.length - 1; i >= 0; i--) {
        if (runs.length >= waiters[i].count) waiters.splice(i, 1)[0].resolve();
      }
      signal.addEventListener("abort", () => reject(new ClineRunError("cancelled", "cancelled")), { once: true });
    }) } });
  t.after(() => manager.shutdown(30_000));
  const start = (options = {}) => manager.start({ mode: "edits", prompt: "Implement", cwd: f.cwd, verify: spec, maxFixRuns: 0,
    codeMap: false, provider: "p", model: "m", ...options });
  const wait = async (id: string, state: TaskStatusView["state"]) => {
    const deadline = Date.now() + 60_000;
    while (true) {
      const value = await manager.status(id, Math.max(1, Math.min(30, Math.ceil((deadline - Date.now()) / 1000))));
      if (value.state === state) return value;
      assert.ok(Date.now() < deadline, JSON.stringify(value));
      await new Promise(r => setTimeout(r, 10));
    }
  };
  const launched = async (count: number) => {
    if (runs.length < count) {
      await new Promise<void>((resolve, reject) => {
        const entry = { count, resolve: () => { clearTimeout(timer); resolve(); } };
        const timer = setTimeout(() => {
          const idx = waiters.indexOf(entry);
          if (idx !== -1) waiters.splice(idx, 1);
          reject(new Error(`Timed out waiting for launch #${count} (have ${runs.length})`));
        }, 60_000);
        waiters.push(entry);
      });
    }
    return runs[count - 1];
  };
  return { ...f, manager, runs, start, wait, launched };
}

test("async exhausted verification waits with retained edits; restore, keep and one manual repair", async t => {
  for (const action of ["restore", "keep", "retry"] as const) {
    const f = await asyncFixture(t); const task = f.start({ maxFixRuns: 1 });
    const first = await f.launched(1); await f.put("failed"); first.finish();
    const automatic = await f.launched(2); assert.equal(await f.bytes(), "failed"); automatic.finish();
    const waiting = await f.wait(task.taskId, "input_required");
    assert.equal("plan" in waiting, false); assert.equal("outcome" in waiting, false);
    assert.equal(waiting.waitReason, "verify_failed"); assert.equal(waiting.verification?.fixRuns, 1);
    assert.equal((await f.manager.result(task.taskId)).log_run_hint, null);
    await assert.rejects(acquire(f.cwd, { lockDirectory: f.locks }));
    await f.manager.send(task.taskId, "Use the failing test", action);
    if (action === "retry") { const repair = await f.launched(3); assert.match(repair.input.prompt, /Use the failing test/); await f.put("pass"); repair.finish(); }
    const done = await f.wait(task.taskId, "done");
    assert.equal(done.verification?.restored, action === "restore"); assert.equal(done.verification?.kept, action === "keep");
    const result = await f.manager.result(task.taskId); assert.equal(result.log_run_hint?.ok, action === "retry");
    assert.equal("plan" in result, false); assert.equal("outcome" in result, false);
    if (action === "restore") await f.clean(); else assert.equal(await f.bytes(), action === "retry" ? "pass" : "failed");
    const release = await acquire(f.cwd, { lockDirectory: f.locks }); release(); assert.deepEqual(await readdir(f.snapshots), []);
  }
});

test("QUESTION during automatic fix retains edits, check evidence and original baseline", async t => {
  const f = await asyncFixture(t, verify, {
    runVerification: async (_spec, cwd) => {
      const passed = await readFile(path.join(cwd, "a"), "utf8") === "pass";
      return { passed, exitCode: passed ? 0 : 7, signal: null, timedOut: false, killedForOutput: false, durationMs: 1, stdoutTail: "", stderrTail: "" };
    }
  }); const task = f.start({ maxFixRuns: 2 });
  const first = await f.launched(1); await f.put("failed"); first.finish();
  const second = await f.launched(2); await f.put("partial repair"); second.finish("QUESTION: Which behavior?\nOPTIONS: exact | approximate");
  const waiting = await f.wait(task.taskId, "input_required"); assert.equal(waiting.waitReason, "cline_question");
  assert.equal(waiting.verification?.attempts.length, 1);
  await f.manager.send(task.taskId, "exact");
  const third = await f.launched(3); assert.equal(await f.bytes(), "partial repair");
  assert.match(third.input.prompt, /Which behavior/); assert.match(third.input.prompt, /exact/);
  await f.put("pass"); third.finish();
  const done = await f.wait(task.taskId, "done"); assert.equal(done.verification?.passed, true);
  assert.equal(done.verification?.attempts.length, 2); assert.equal(done.verification?.fixRuns, 2);
});

test("guard errors pause, cumulative allowances never reset on retries, cancellation restores", async t => {
  const f = await asyncFixture(t, none); const task = f.start({ guard: { maxToolCalls: 10, maxInputTokens: 10000 } });
  const first = await f.launched(1); await f.put("partial");
  const error = new ClineRunError("loop_detected", "repeated failure", { guard: { totalToolCalls: 7, totalInputTokens: 5000 } as any });
  first.fail(error); const waiting = await f.wait(task.taskId, "input_required"); assert.equal(waiting.waitReason, "guard");
  await f.manager.send(task.taskId, "Try another approach");
  const second = await f.launched(2); assert.equal(second.options.guard.maxToolCalls, 3); assert.equal(second.options.guard.maxInputTokens, 5000);
  second.finish("QUESTION: Continue?", { totalToolCalls: 3, totalInputTokens: 5000 });
  await f.wait(task.taskId, "input_required"); await f.manager.send(task.taskId, "Continue");
  const exhausted = await f.wait(task.taskId, "input_required"); assert.equal(exhausted.waitReason, "guard"); assert.equal(f.runs.length, 2);
  const cancelled = await f.manager.cancel(task.taskId); assert.equal(cancelled.state, "cancelled"); await f.clean();
  assert.equal((await f.manager.result(task.taskId)).log_run_hint, null);
});

test("cancel during verification waits for verifier abort and restores all edit bytes", async t => {
  let started = false, stopped = false;
  const f = await asyncFixture(t, verify, { runVerification: async (_spec, _cwd, signal) => {
    started = true; return new Promise(resolve => signal!.addEventListener("abort", () => { stopped = true;
      resolve({ passed: false, exitCode: null, signal: "SIGKILL", timedOut: false, killedForOutput: false, durationMs: 1, stdoutTail: "", stderrTail: "" });
    }, { once: true }));
  } });
  const task = f.start(); const first = await f.launched(1); await f.put("partial"); first.finish();
  await until(async () => started, Boolean); const cancelled = await f.manager.cancel(task.taskId);
  assert.equal(cancelled.state, "cancelled"); assert.equal(stopped, true); assert.equal(cancelled.verification?.restored, true); await f.clean();
});

test("HEAD changes refuse restore and preserve the recovery snapshot without reset", async t => {
  const f = await asyncFixture(t); const task = f.start(); const first = await f.launched(1);
  await f.put("unexpected"); git(f.cwd, "add", "a"); git(f.cwd, "-c", "user.name=Test", "-c", "user.email=t@example.invalid", "commit", "-qm", "unexpected");
  const changed = await headAndIndexIdentity(f.cwd); first.finish();
  const waiting = await f.wait(task.taskId, "input_required"); assert.equal(waiting.waitReason, "head_changed");
  await f.manager.send(task.taskId, "", "restore"); const refused = await f.wait(task.taskId, "input_required");
  assert.equal(refused.verification?.restored, false); assert.deepEqual(await headAndIndexIdentity(f.cwd), changed);
  assert.equal((await readdir(f.snapshots)).length, 1); await f.manager.cancel(task.taskId);
  assert.deepEqual(await headAndIndexIdentity(f.cwd), changed); assert.equal((await readdir(f.snapshots)).length, 1);
});

test("refused verifier spends no fixes and reports local failure without a model hint", async t => {
  const f = await asyncFixture(t, verify, { runVerification: async () => { throw new VerificationError("verification_refused", "Executable refused"); } });
  const task = f.start({ maxFixRuns: 3 }); const first = await f.launched(1); first.finish();
  const waiting = await f.wait(task.taskId, "input_required"); assert.equal(waiting.waitReason, "verify_failed");
  assert.equal(waiting.verification?.fixRuns, 0); assert.equal(f.runs.length, 1);
  await f.manager.send(task.taskId, "", "keep"); await f.wait(task.taskId, "done");
  assert.equal((await f.manager.result(task.taskId)).log_run_hint, null);
});

test("missing verifier is refused before any run and triggers no repair runs", async t => {
  // Plan S4: the check is resolved up front, so a missing verifier no longer wastes a model run.
  const f = await asyncFixture(t, { command: "cline-finalcheck-missing-executable-972643" });
  const task = f.start({ maxFixRuns: 3 });
  const failed = await f.wait(task.taskId, "failed");
  assert.equal(failed.waitReason, "verify_failed"); assert.equal(failed.verification?.fixRuns, 0);
  assert.equal(failed.verification?.attempts.length, 0); assert.equal(f.runs.length, 0);
});

test("overall active-time budget stops a run and survives manual retries", async t => {
  const f = await asyncFixture(t, none); const task = f.start({ timeoutSeconds: 1 });
  const waiting = await f.wait(task.taskId, "input_required");
  assert.equal(waiting.waitReason, "budget");
  const launches = f.runs.length;
  await f.manager.send(task.taskId, "Try again");
  const again = await f.wait(task.taskId, "input_required");
  assert.equal(again.waitReason, "budget"); assert.equal(f.runs.length, launches);
  await f.manager.cancel(task.taskId); await f.clean();
});

test("sync queue give-up spends no model run, snapshot or checkout lease; invalid budgets and verifiers keep their own errors", async t => {
  const f = await fixture(t);
  process.env.BRIDGE_HEAVY_SLOTS = "1";
  const release = await acquireHeavySlot(f.cwd, () => TEST_WAIT_MS, new AbortController().signal);
  t.after(release);
  const input = { prompt: "edit", provider: "p", model: "m", cwd: f.cwd, verify: none, timeoutSeconds: 63 };
  let queued = false, launches = 0;
  const options = { checkoutLockDirectory: f.locks, onHeavyQueue: (q?: QueuePosition) => { if (q) queued = true; },
    deps: { spawn: (() => { launches++; throw new Error("unexpected launch"); }) as never } };
  await assert.rejects(applyClineEdits({ ...input, timeoutSeconds: 30 }, undefined, options), { kind: "budget_exceeded" });
  await assert.rejects(applyClineEdits({ ...input, verify: { command: "nonexistent-f10-verifier" } }, undefined, options),
    { kind: "launch_failed" });
  assert.equal(queued, false);
  const before = await readdir(snapshotDir);
  await assert.rejects(applyClineEdits(input, undefined, options), (error: any) => {
    assert.equal(error.kind, "machine_busy"); assert.equal(error.attempts, 0);
    assert.match(error.message, /1 active, 1 queued.*retry/i); return true;
  });
  assert.equal(queued, true); assert.equal(launches, 0);
  assert.deepEqual(await readdir(snapshotDir), before);
  assert.deepEqual(await readdir(path.join(process.env.BRIDGE_HEAVY_DIR!, "queue")), []);
  const lock = await acquire(f.cwd, { lockDirectory: f.locks }); lock();
});

test("async input_required releases only the slot; retry queues, and cancellation cleans up both queued and running edits", async t => {
  process.env.BRIDGE_HEAVY_SLOTS = "1";
  const f = await asyncFixture(t, none);
  const task = f.start();
  (await f.launched(1)).finish("QUESTION: Continue?");
  await f.wait(task.taskId, "input_required");
  const other = await acquireHeavySlot(f.cwd, () => TEST_WAIT_MS, new AbortController().signal);
  t.after(other);
  await assert.rejects(acquire(f.cwd, { lockDirectory: f.locks }), { kind: "checkout_busy" });
  await f.manager.send(task.taskId, "Continue");
  const status = await until(() => f.manager.status(task.taskId), s => s.phase === "queued");
  assert.equal(status.state, "resuming"); assert.deepEqual(status.queue, { position: 1, total: 1 });
  assert.equal(f.runs.length, 1);
  await f.manager.cancel(task.taskId); await f.clean();
  const heavy = process.env.BRIDGE_HEAVY_DIR!;
  assert.deepEqual(await readdir(path.join(heavy, "queue")), []);
  other();
  const next = f.start(); await f.launched(2);
  assert.equal(JSON.parse(await readFile(path.join(heavy, "slot-1.json"), "utf8")).pid, process.pid);
  assert.equal((await f.manager.cancel(next.taskId)).state, "cancelled");
  await assert.rejects(readFile(path.join(heavy, "slot-1.json")), { code: "ENOENT" });
  const lock = await acquire(f.cwd, { lockDirectory: f.locks }); lock();
});

test("finding 2: killUnverified keeps the checkout lock until explicit restore/keep, frees the heavy slot with a note; survivors-only heals via interval and stops on keep/restore", async t => {
  process.env.BRIDGE_HEAVY_SLOTS = "1";
  const spawnSurvivor = async () => {
    const proc = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore", windowsHide: true });
    const exited = once(proc, "exit");
    t.after(async () => {
      if (proc.exitCode === null && proc.signalCode === null) proc.kill();
      await exited;
    });
    await once(proc, "spawn");
    return { proc, exited };
  };

  // 1. killUnverified: checkout lock stays retained on release(), heavy slot is freed immediately with a cleanup note,
  // and only explicit keep() or restore() frees the checkout lock.
  for (const disposition of ["keep", "restore"] as const) {
    const f = await fixture(t);
    const lifecycle = new FinalCheckLifecycle({ prompt: "Edit", cwd: f.cwd, verify: none }, {
      resolveRoot: async cwd => cwd, fits: () => true, question: editQuestion, lockDirectory: f.locks,
      snapshotOptions: { snapshotBase: f.snapshots },
      survivorCheckIntervalMs: 15,
      run: async () => { throw new ClineRunError("timeout", "timed out", { killUnverified: true }); }
    });
    t.after(() => lifecycle.release());
    await lifecycle.execute(new AbortController().signal);

    await lifecycle.release();
    // Heavy slot is freed immediately so machine capacity is not stranded.
    const slot = await acquireHeavySlot(f.cwd, () => TEST_WAIT_MS, new AbortController().signal);
    slot();
    // Checkout lock stays retained and never auto-heals.
    await assert.rejects(acquire(f.cwd, { lockDirectory: f.locks }), CheckoutBusyError);
    assert.ok(lifecycle.cleanupNotes.some(note => /released.*slot.*checkout lock/i.test(note)), JSON.stringify(lifecycle.cleanupNotes));
    assert.ok((lifecycle.evidence.cleanupNotes as string[] | undefined)?.some(note => /released.*slot.*checkout lock/i.test(note)));

    // Explicit user keep/restore frees the checkout lock (snapshot stays preserved because kill was unconfirmed).
    if (disposition === "keep") await lifecycle.keep();
    else assert.equal(await lifecycle.restore(), true);
    const lock = await acquire(f.cwd, { lockDirectory: f.locks });
    lock();
  }

  // 2. Survivors-only healing via the injected interval (after release() while survivor is still alive).
  {
    const f = await fixture(t);
    const { proc, exited } = await spawnSurvivor();
    const lifecycle = new FinalCheckLifecycle({ prompt: "Edit", cwd: f.cwd, verify: none }, {
      resolveRoot: async cwd => cwd, fits: () => true, question: editQuestion, lockDirectory: f.locks,
      snapshotOptions: { snapshotBase: f.snapshots },
      survivorCheckIntervalMs: 20,
      run: async () => { throw new ClineRunError("timeout", "timed out", { processesStillAlive: [proc.pid!] }); }
    });
    t.after(() => lifecycle.release());
    await lifecycle.execute(new AbortController().signal);

    // Calling release() while survivor lives keeps both leases retained and leaves the interval running.
    await lifecycle.release();
    await assert.rejects(acquire(f.cwd, { lockDirectory: f.locks }), CheckoutBusyError);
    await assert.rejects(acquireHeavySlot(f.cwd, () => 0, new AbortController().signal), { kind: "machine_busy" });

    // Once survivor exits, the interval force-releases BOTH checkout lock and heavy slot on its own.
    proc.kill();
    await exited;
    await until(async () => !fs.existsSync(path.join(process.env.BRIDGE_HEAVY_DIR!, "slot-1.json")), Boolean);
    const lock = await acquire(f.cwd, { lockDirectory: f.locks }); lock();
    const slot = await acquireHeavySlot(f.cwd, () => TEST_WAIT_MS, new AbortController().signal); slot();
  }

  // 3. Survivors-only healing via PID reuse (start time past 5 s tolerance) on the injected interval.
  {
    const f = await fixture(t);
    let reused = false;
    let checks = 0;
    const lifecycle = new FinalCheckLifecycle({ prompt: "Edit", cwd: f.cwd, verify: none }, {
      resolveRoot: async cwd => cwd, fits: () => true, question: editQuestion, lockDirectory: f.locks,
      snapshotOptions: { snapshotBase: f.snapshots },
      survivorCheckIntervalMs: 15,
      processStartMs: async () => {
        checks++;
        return reused ? Date.now() + 60_000 : Date.now() - 60_000;
      },
      run: async () => { throw new ClineRunError("timeout", "timed out", { processesStillAlive: [process.ppid] }); }
    });
    t.after(() => lifecycle.release());
    await lifecycle.execute(new AbortController().signal);

    await until(async () => checks >= 2, Boolean);
    await assert.rejects(acquire(f.cwd, { lockDirectory: f.locks }), CheckoutBusyError);
    await assert.rejects(acquireHeavySlot(f.cwd, () => 0, new AbortController().signal), { kind: "machine_busy" });

    reused = true;
    await until(async () => !fs.existsSync(path.join(process.env.BRIDGE_HEAVY_DIR!, "slot-1.json")), Boolean);
    const lock = await acquire(f.cwd, { lockDirectory: f.locks }); lock();
    const slot = await acquireHeavySlot(f.cwd, () => TEST_WAIT_MS, new AbortController().signal); slot();
    const settledChecks = checks;
    await new Promise(r => setTimeout(r, 60));
    assert.equal(checks, settledChecks, "interval must stop once leases are force-released");
  }

  // 4. The survivor re-check interval stops on keep() and restore().
  for (const mode of ["keep", "restore"] as const) {
    const f = await fixture(t);
    process.env.BRIDGE_HEAVY_DIR = path.join(f.base, "heavy");
    let checks = 0;
    const lifecycle = new FinalCheckLifecycle({ prompt: "Edit", cwd: f.cwd, verify: none }, {
      resolveRoot: async cwd => cwd, fits: () => true, question: editQuestion, lockDirectory: f.locks,
      snapshotOptions: { snapshotBase: f.snapshots },
      survivorCheckIntervalMs: 15,
      processStartMs: async () => { checks++; return Date.now() - 60_000; },
      run: async () => { throw new ClineRunError("timeout", "timed out", { processesStillAlive: [process.ppid] }); }
    });
    t.after(() => lifecycle.release());
    await lifecycle.execute(new AbortController().signal);
    await until(async () => checks >= 2, Boolean);

    if (mode === "keep") await lifecycle.keep();
    else assert.equal(await lifecycle.restore(), true);

    const checksAfterDisposition = checks;
    await new Promise(r => setTimeout(r, 80));
    assert.equal(checks, checksAfterDisposition, `survivor re-check interval must stop on ${mode}()`);
  }
});

test("finding 4 (low): task.state publishes immediately before awaiting a slow survivors-only release", async t => {
  const f = await asyncFixture(t, none);
  let releaseStarted!: () => void;
  let finishRelease!: () => void;
  const started = new Promise<void>(resolve => { releaseStarted = resolve; });
  const gate = new Promise<void>(resolve => { finishRelease = resolve; });
  const origReleaseSlot = FinalCheckLifecycle.prototype.releaseSlot;
  const stub = t.mock.method(FinalCheckLifecycle.prototype, "releaseSlot", async function(this: FinalCheckLifecycle, signal?: AbortSignal) {
    if (this.hasSlowRelease) {
      releaseStarted();
      await gate;
    }
    return origReleaseSlot.call(this, signal);
  });
  t.after(() => { finishRelease(); stub.mock.restore(); });

  const task = f.start();
  const run = await f.launched(1);
  run.fail(new ClineRunError("timeout", "timed out", { processesStillAlive: [process.ppid] }));
  await started;
  const view = await f.manager.status(task.taskId, 0);
  assert.equal(view.state, "input_required", "status must reflect input_required before slow lease release completes");
  finishRelease();
  // Clean up via explicit keep so no background interval lingers.
  await f.manager.send(task.taskId, "", "keep");
  await f.wait(task.taskId, "done");
});

test("finding 3: pre-slot 60 s floor applies only when launches === 0; repair runs keep the 1 s minimum", async t => {
  const f = await fixture(t);
  let clock = 1_000;
  let calls = 0;
  const lifecycle = new FinalCheckLifecycle({ prompt: "Edit", cwd: f.cwd, timeoutSeconds: 90, verify: none }, {
    resolveRoot: async cwd => cwd, fits: () => true, question: editQuestion, lockDirectory: f.locks,
    snapshotOptions: { snapshotBase: f.snapshots },
    now: () => clock,
    run: async () => {
      calls++;
      if (calls === 1) { clock += 70_000; return { text: "QUESTION: Continue?", durationMs: 1 } as any; }
      return { text: "done", durationMs: 1 } as any;
    }
  });
  t.after(() => lifecycle.release());

  await lifecycle.execute(new AbortController().signal);
  assert.equal(lifecycle.phase, "waiting");
  assert.equal(lifecycle.waitReason, "cline_question");
  assert.equal(lifecycle.launches, 1);
  // Simulate async input_required releasing the slot while keeping the checkout lock; 20 s remains (< 60 s, >= 1 s).
  await lifecycle.releaseSlot();
  await lifecycle.execute(new AbortController().signal, "Finish it");
  assert.equal(calls, 2, "repair run with 20 s left must not be refused by MIN_FIRST_RUN_SECONDS");
  assert.equal(lifecycle.phase, "done");

  // Repair run with < 1 s left is still refused before taking a slot.
  const f2 = await fixture(t);
  let clock2 = 1_000;
  let calls2 = 0;
  const lifecycle2 = new FinalCheckLifecycle({ prompt: "Edit", cwd: f2.cwd, timeoutSeconds: 90, verify: none }, {
    resolveRoot: async cwd => cwd, fits: () => true, question: editQuestion, lockDirectory: f2.locks,
    snapshotOptions: { snapshotBase: f2.snapshots },
    now: () => clock2,
    run: async () => {
      calls2++;
      clock2 += 89_500;
      return { text: "QUESTION: Continue?", durationMs: 1 } as any;
    }
  });
  t.after(() => lifecycle2.release());
  await lifecycle2.execute(new AbortController().signal);
  await lifecycle2.releaseSlot();
  await lifecycle2.execute(new AbortController().signal, "Retry with 500 ms left");
  assert.equal(calls2, 1);
  assert.equal(lifecycle2.waitReason, "budget");
});

test("finding 4: retain and release failures stay best-effort, record evidence/warnings, and never fail a passed check", async t => {
  // 1. retain failure during an unconfirmed hub stop after a passing check keeps the check passed and records evidence.
  const f1 = await fixture(t);
  const realRename = fs.renameSync;
  const renameStub = t.mock.method(fs, "renameSync", (src: fs.PathLike, dst: fs.PathLike) => {
    if (String(dst).endsWith(".lock") || String(dst).endsWith("slot-1.json")) {
      throw Object.assign(new Error("injected retain EPERM"), { code: "EPERM" });
    }
    return realRename(src, dst);
  });
  syncBuiltinESMExports();
  t.after(() => { renameStub.mock.restore(); syncBuiltinESMExports(); });

  const lifecycle = new FinalCheckLifecycle({ prompt: "Edit", cwd: f1.cwd, verify: none }, {
    resolveRoot: async cwd => cwd, fits: () => true, question: editQuestion, lockDirectory: f1.locks,
    snapshotOptions: { snapshotBase: f1.snapshots },
    run: async (_p, _s, _l, _g, _r, _n, hub) => {
      await hub.environment(f1.cwd, { deps: { startHub: async () => ({ env: {}, stop: () => stopDedicatedHub(4321, {
        hubStarted: async () => true, runHubStop: async () => false, isListening: async () => true, listProcesses: async () => []
      }) }) } });
      hub.launched = true;
      return { text: "done", durationMs: 1 } as any;
    }
  });
  t.after(() => lifecycle.release());
  await lifecycle.execute(new AbortController().signal);
  assert.equal(lifecycle.phase, "done", "a retain failure after a passed edit must not turn into cline_error");
  const retainErrors = lifecycle.evidence.leaseErrors as string[];
  assert.ok(Array.isArray(retainErrors) && retainErrors.some(e => e.includes("injected retain EPERM")), JSON.stringify(lifecycle.evidence));
  renameStub.mock.restore(); syncBuiltinESMExports();

  // 2. release failure on a passing applyClineEdits stays passed and surfaces in result warnings.
  const f2 = await fixture(t);
  const realUnlink = fs.unlinkSync;
  const unlinkStub = t.mock.method(fs, "unlinkSync", (target: fs.PathLike) => {
    if (String(target).endsWith(".lock")) {
      throw Object.assign(new Error("injected release EPERM"), { code: "EPERM" });
    }
    return realUnlink(target);
  });
  syncBuiltinESMExports();
  t.after(() => { unlinkStub.mock.restore(); syncBuiltinESMExports(); });

  const deps = {
    entryPath: "fake", access: async () => {}, acquireSettingsMutex: async () => async () => {},
    spawn: (() => {
      const child = new EventEmitter() as any; child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.pid = 999; child.kill = () => {};
      queueMicrotask(() => {
        child.stdout.emit("data", Buffer.from('{"type":"run_result","finishReason":"success","text":"done"}\n'));
        child.emit("close", 0);
      });
      return child;
    }) as any
  };
  process.env.CLINE_PROVIDER_SETTINGS_PATH = path.join(f2.base, "providers.json");
  process.env.CLINE_MCP_STATE_PATH = path.join(f2.base, "state.json");
  process.env.CLINE_MCP_STATUS_PATH = path.join(f2.base, "status.json");
  process.env.CLINE_MCP_CATALOG_PATH = path.join(f2.base, "catalog.json");
  process.env.CLINE_MCP_TRACE_DIR = path.join(f2.base, "traces");
  const result = await applyClineEdits({ prompt: "Implement", cwd: f2.cwd, verify: none, provider: "p", model: "m", codeMap: false },
    undefined, { deps: deps as any, checkoutLockDirectory: f2.locks });
  assert.equal(result.text, "done");
  assert.ok(result.warnings?.some(w => w.includes("injected release EPERM")), JSON.stringify(result.warnings));
});

test("finding 6: queued retry keeps resuming state until admitted and transitions to running when the run starts", async t => {
  process.env.BRIDGE_HEAVY_SLOTS = "1";
  const f = await asyncFixture(t, none);
  const task = f.start();
  (await f.launched(1)).finish("QUESTION: Continue?");
  await f.wait(task.taskId, "input_required");

  const blocker = await acquireHeavySlot(f.cwd, () => TEST_WAIT_MS, new AbortController().signal);
  t.after(blocker);
  const resumed = await f.manager.send(task.taskId, "Continue");
  assert.equal(resumed.state, "resuming");
  const queued = await until(() => f.manager.status(task.taskId), s => s.phase === "queued");
  assert.equal(queued.state, "resuming", "queueing a retry must not overwrite resuming with running");
  assert.deepEqual(queued.queue, { position: 1, total: 1 });

  blocker();
  const second = await f.launched(2);
  const running = await f.manager.status(task.taskId);
  assert.equal(running.state, "running");
  assert.equal(running.queue, undefined);
  second.finish("done");
  assert.equal((await f.wait(task.taskId, "done")).state, "done");
});
