import assert from "node:assert/strict";
import "./git-test-serial.js";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { mkdtemp, writeFile, readFile, mkdir, rm, readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { FinalCheckLifecycle, buildFixPrompt, verificationSchema, maxFixRunsSchema, startTaskSchema, editActionSchema, type VerifySpec } from "../finalcheck.js";
import { TaskManager, type TaskStatusView, type TaskManagerDeps } from "../tasks.js";
import { applyClineEdits, editPromptFits, editQuestion } from "../edits.js";
import { ClineRunError } from "../runner.js";
import { headAndIndexIdentity } from "../snapshot.js";
import { acquire } from "../checkoutlock.js";
import { VerificationError } from "../verify.js";

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
  const deadline = Date.now() + 20_000;
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
  const manager = new TaskManager({ ...extra, traceBase: path.join(f.base, "traces"), snapshotOptions: { snapshotBase: f.snapshots },
    runOptions: { checkoutLockDirectory: f.locks }, runners: { edits: (input, signal, options) => new Promise((resolve, reject) => {
      runs.push({ input, options, signal, finish: (text = "done", guard) => resolve({ text, durationMs: 1, guard, usage: { inputTokens: 10 } } as any), fail: reject });
      signal.addEventListener("abort", () => reject(new ClineRunError("cancelled", "cancelled")), { once: true });
    }) } });
  t.after(() => manager.shutdown(30_000));
  const start = (options = {}) => manager.start({ mode: "edits", prompt: "Implement", cwd: f.cwd, verify: spec, maxFixRuns: 0,
    codeMap: false, provider: "p", model: "m", ...options });
  const wait = (id: string, state: TaskStatusView["state"]) => until(() => manager.status(id, 0), s => s.state === state);
  const launched = async (count: number) => { await until(async () => runs.length, n => n >= count); return runs[count - 1]; };
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
    assert.throws(() => acquire(f.cwd, { lockDirectory: f.locks }));
    await f.manager.send(task.taskId, "Use the failing test", action);
    if (action === "retry") { const repair = await f.launched(3); assert.match(repair.input.prompt, /Use the failing test/); await f.put("pass"); repair.finish(); }
    const done = await f.wait(task.taskId, "done");
    assert.equal(done.verification?.restored, action === "restore"); assert.equal(done.verification?.kept, action === "keep");
    const result = await f.manager.result(task.taskId); assert.equal(result.log_run_hint?.ok, action === "retry");
    assert.equal("plan" in result, false); assert.equal("outcome" in result, false);
    if (action === "restore") await f.clean(); else assert.equal(await f.bytes(), action === "retry" ? "pass" : "failed");
    const release = acquire(f.cwd, { lockDirectory: f.locks }); release(); assert.deepEqual(await readdir(f.snapshots), []);
  }
});

test("QUESTION during automatic fix retains edits, check evidence and original baseline", async t => {
  const f = await asyncFixture(t); const task = f.start({ maxFixRuns: 2 });
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

test("missing verifier does not trigger repair runs", async t => {
  const f = await asyncFixture(t, { command: "cline-finalcheck-missing-executable-972643" });
  const task = f.start({ maxFixRuns: 3 }); (await f.launched(1)).finish();
  const waiting = await f.wait(task.taskId, "input_required");
  assert.equal(waiting.waitReason, "verify_failed"); assert.equal(waiting.verification?.fixRuns, 0);
  assert.equal(waiting.verification?.attempts[0].exitCode, null); assert.equal(f.runs.length, 1);
  await f.manager.cancel(task.taskId);
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
