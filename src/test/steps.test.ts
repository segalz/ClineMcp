import assert from "node:assert/strict";
import "./git-test-serial.js";
import test from "node:test";
import { EventEmitter } from "node:events";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { TaskManager, isPromptTooLarge, getEffectivePreamble, type Task, type TaskManagerDeps, type TaskStatusView, type StartTaskInput } from "../tasks.js";
import { buildStepPrompt, startTaskSchema, stepsSchema, DEFAULT_STEP_BUDGET, type StepDefinition } from "../steps.js";
import type { GuardReport } from "../guard.js";
import { ClineRunError } from "../runner.js";
import { acquire, CheckoutBusyError, ownsCheckoutLock } from "../checkoutlock.js";
import { runClineEditStep } from "../edits.js";
import { headAndIndexIdentity } from "../snapshot.js";

const selection = { provider: "p", model: "m" };
const verification = { command: process.execPath, args: ["-e", "process.exit(0)"] };
const step = (id: string, verify = verification): StepDefinition => ({ id, instruction: `Implement ${id}`, paths: ["a"], verify });
function git(cwd: string, ...args: string[]): string {
  const result = spawnSync(process.platform === "win32" ? "git.exe" : "git", ["-C", cwd, ...args], {
    encoding: "utf8", windowsHide: true, timeout: 10_000, env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" }
  });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  return result.stdout.trim();
}
async function fixture(t: test.TestContext, extra: TaskManagerDeps = {}) {
  const base = await mkdtemp(path.join(os.tmpdir(), "cline-steps-test-"));
  process.env.CLINE_PROVIDER_SETTINGS_PATH = path.join(base, "providers.json");
  process.env.CLINE_MCP_STATUS_PATH = path.join(base, "status.json");
  process.env.CLINE_MCP_STATE_PATH = path.join(base, "state.json");
  process.env.CLINE_MCP_CATALOG_PATH = path.join(base, "catalog.json");
  process.env.CLINE_MCP_TRACE_DIR = path.join(base, "traces");
  t.after(() => rm(base, { recursive: true, force: true, maxRetries: 5 }));
  const cwd = path.join(base, "repo"), locks = path.join(base, "locks"), snapshots = path.join(base, "snapshots");
  await mkdir(cwd); git(cwd, "init", "--quiet");
  await writeFile(path.join(cwd, "a"), "committed\n");
  await writeFile(path.join(cwd, ".gitignore"), "ignored\n");
  git(cwd, "add", "."); git(cwd, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "baseline");
  await writeFile(path.join(cwd, "a"), "staged\n"); git(cwd, "add", "a");
  await writeFile(path.join(cwd, "a"), "dirty baseline\r\n");
  await writeFile(path.join(cwd, "untracked"), Buffer.from([0, 255, 13, 10]));
  await writeFile(path.join(cwd, "ignored"), "ignored baseline");
  const runs: Array<{ input: any; options: any; signal: AbortSignal; finish: (text?: string, usage?: Record<string, unknown>, guard?: GuardReport) => void; fail: (error: unknown) => void }> = [];
  const manager = new TaskManager({ ...extra, traceBase: path.join(base, "traces"),
    snapshotOptions: { snapshotBase: snapshots, ...extra.snapshotOptions },
    runOptions: { checkoutLockDirectory: locks, ...extra.runOptions },
    runners: { edits: (input, signal, options) => new Promise((resolve, reject) => {
      const run = { input, signal, options, fail: reject,
        finish: (text = "Implemented\nDetails", usage: Record<string, unknown> = { inputTokens: 10, outputTokens: 2 }, guard?: GuardReport) => resolve({ text, usage, guard, cost: 0.1, durationMs: 10 } as any) };
      runs.push(run);
      signal.addEventListener("abort", () => reject(new ClineRunError("cancelled", "cancelled")), { once: true });
    }) } });
  t.after(() => manager.shutdown(30_000));
  let lastTaskId = "";
  const start = (steps: StepDefinition[], prompt = "Complete the objective", options: Pick<StartTaskInput, "guard" | "stepBudget"> = {}) => {
    const started = manager.start({ mode: "edits", cwd, prompt, steps, codeMap: false, ...selection, ...options });
    lastTaskId = started.taskId;
    return started;
  };
  const wait = async (id: string, predicate: (status: TaskStatusView) => boolean) => {
    const deadline = Date.now() + 30_000;
    while (true) {
      const status = await manager.status(id, 0);
      if (predicate(status)) return status;
      assert.ok(Date.now() < deadline, `Timed out waiting: ${JSON.stringify(status)}`);
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  };
  const launched = async (count: number) => {
    const deadline = Date.now() + 30_000;
    while (runs.length < count) {
      const status = await manager.status(lastTaskId, 0);
      assert.ok(status.state !== "input_required" && status.state !== "failed", `Unexpected wait before run ${count}: ${JSON.stringify(status)}`);
      assert.ok(Date.now() < deadline, `Only ${runs.length}/${count} Cline runs launched: ${JSON.stringify(status)}`);
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    return runs[count - 1];
  };
  const snapshotsEmpty = async () => assert.deepEqual(await readdir(snapshots).catch(() => []), []);
  return { base, cwd, locks, snapshots, manager, runs, start, wait, launched, snapshotsEmpty };
}

test("step schemas reject invalid mode, unknown fields, ids, unsafe paths, missing verify and oversized UTF-8 input", () => {
  const input = { mode: "edits", prompt: "objective", cwd: "repo", ...selection, steps: [step("one")] };
  assert.equal(startTaskSchema.safeParse(input).success, true);
  for (const mode of ["ask", "workspace"]) assert.equal(startTaskSchema.safeParse({ ...input, mode }).success, false);
  assert.equal(startTaskSchema.safeParse({ ...input, extra: true }).success, false);
  assert.equal(startTaskSchema.safeParse({ ...input, guard: { unknown: true } }).success, false);
  assert.equal(startTaskSchema.safeParse({ ...input, guard: { window: 3, maxRepeatedFailures: 5 } }).success, false);
  for (const steps of [[], Array.from({ length: 17 }, (_, i) => step(String(i))), [step("one"), step("one")],
    [{ ...step("one"), extra: true }], [{ ...step("one"), id: "bad id" }], [{ ...step("one"), instruction: "" }],
    [{ id: "one", instruction: "no verification" }], [{ ...step("one"), verify: { ...verification, shell: true } }],
    [{ ...step("one"), verify: { command: "node", timeoutSeconds: 301 } }]]) assert.equal(stepsSchema.safeParse(steps).success, false);
  for (const file of ["../a", "a/../b", "/root", "C:\\root", "a/.git/config", "a/.GiT", "NUL.txt", "com1", "CONIN$", "con .txt", "a:stream", "a\\..\\b", "a/", "a.", "a /b"]) {
    assert.equal(stepsSchema.safeParse([{ ...step("one"), paths: [file] }]).success, false, file);
  }
  assert.equal(stepsSchema.safeParse([{ ...step("one"), paths: ["src/a.ts", "dir\\file.ts"] }]).success, true);
  assert.equal(stepsSchema.safeParse([{ ...step("one"), paths: Array(33).fill("a") }]).success, false);
  const huge = { ...input, steps: Array.from({ length: 16 }, (_, i) => ({ ...step(String(i)), instruction: "😀".repeat(2000) })) };
  assert.equal(startTaskSchema.safeParse(huge).success, false);
});

test("three passing steps run sequentially with ledger, aggregate usage, unchanged index and one lock", async t => {
  const f = await fixture(t);
  const identity = await headAndIndexIdentity(f.cwd);
  const started = f.start([step("one"), step("two"), step("three")]);
  const first = await f.launched(1);
  assert.match(first.input.prompt, /Objective:\nComplete the objective/); assert.match(first.input.prompt, /Current step: one/);
  assert.equal(first.options.maxAttempts, 1); assert.equal(first.input.codeMap, false);
  assert.ok(ownsCheckoutLock(first.options.checkoutLock, f.cwd));
  await writeFile(path.join(f.cwd, "a"), "step one"); first.finish("One summary\nMore text");
  const second = await f.launched(2);
  assert.equal(second.options.checkoutLock, first.options.checkoutLock);
  assert.match(second.input.prompt, /one: One summary; changed files: a/);
  await writeFile(path.join(f.cwd, "two"), "step two"); second.finish("Two summary");
  const third = await f.launched(3);
  assert.match(third.input.prompt, /two: Two summary; changed files: two/);
  third.finish("Three summary");
  const done = await f.wait(started.taskId, status => status.state === "done");
  assert.equal(done.outcome, "completed"); assert.equal(done.plan?.phase, "done"); assert.equal(done.plan?.currentIndex, 2);
  assert.deepEqual(done.plan?.steps.map(s => s.state), ["verified", "verified", "verified"]);
  assert.deepEqual(done.plan?.steps.map(s => s.attempts), [1, 1, 1]);
  assert.deepEqual(done.plan?.steps[0].changedFiles, ["a"]);
  assert.deepEqual(await headAndIndexIdentity(f.cwd), identity);
  const result = await f.manager.result(started.taskId);
  assert.deepEqual(result.result?.usage, { inputTokens: 30, outputTokens: 6 });
  assert.equal(result.result?.durationMs, 30); assert.equal(result.log_run_hint?.ok, true);
  const release = acquire(f.cwd, { lockDirectory: f.locks }); release(); await f.snapshotsEmpty();
});

test("verification failure restores dirty/untracked baseline; retry receives evidence and passes", async t => {
  const f = await fixture(t);
  const identity = await headAndIndexIdentity(f.cwd);
  const verify = { command: process.execPath, args: ["-e", 'process.exit(require("fs").readFileSync("a","utf8").includes("pass") ? 0 : 7)'] };
  const started = f.start([step("one", verify)]);
  const first = await f.launched(1);
  await writeFile(path.join(f.cwd, "a"), "failing bytes"); await writeFile(path.join(f.cwd, "new"), "added"); first.finish();
  const waiting = await f.wait(started.taskId, s => s.state === "input_required");
  assert.equal(waiting.waitReason, "verify_failed"); assert.equal(waiting.plan?.steps[0].verify?.exitCode, 7);
  assert.equal(await readFile(path.join(f.cwd, "a"), "utf8"), "dirty baseline\r\n");
  await assert.rejects(readFile(path.join(f.cwd, "new")), { code: "ENOENT" });
  assert.deepEqual(await headAndIndexIdentity(f.cwd), identity);
  assert.throws(() => acquire(f.cwd, { lockDirectory: f.locks }), CheckoutBusyError);
  const partial = await f.manager.result(started.taskId); assert.equal(partial.log_run_hint, null);
  await f.manager.send(started.taskId, "Write pass instead");
  const second = await f.launched(2);
  assert.match(second.input.prompt, /Write pass instead/); assert.match(second.input.prompt, /Previous failure evidence/);
  await writeFile(path.join(f.cwd, "a"), "pass"); second.finish();
  const done = await f.wait(started.taskId, s => s.state === "done");
  assert.equal(done.plan?.steps[0].attempts, 2); assert.equal(done.outcome, "completed"); await f.snapshotsEmpty();
});

test("skip records an unverified step, excludes it from the ledger, and aggregates a non-ok hint", async t => {
  const f = await fixture(t);
  const started = f.start([step("bad", { command: process.execPath, args: ["-e", "process.exit(1)"] }), step("good")]);
  (await f.launched(1)).finish("Bad summary");
  await f.wait(started.taskId, s => s.state === "input_required");
  await f.manager.send(started.taskId, undefined, "skip");
  const next = await f.launched(2); assert.doesNotMatch(next.input.prompt, /bad: Bad summary/); next.finish();
  const done = await f.wait(started.taskId, s => s.state === "done");
  assert.equal(done.outcome, "completed_with_skips"); assert.equal(done.plan?.steps[0].state, "skipped");
  assert.equal(done.waitReason, undefined);
  assert.equal((await f.manager.result(started.taskId)).log_run_hint?.ok, false); await f.snapshotsEmpty();
});

test("stop restores the unverified question step while preserving verified changes", async t => {
  const f = await fixture(t);
  const started = f.start([step("one"), step("two"), step("three")]);
  await f.launched(1); await writeFile(path.join(f.cwd, "a"), "verified one"); f.runs[0].finish();
  await f.launched(2); await writeFile(path.join(f.cwd, "a"), "partial two"); f.runs[1].finish("QUESTION: Continue?");
  await f.wait(started.taskId, s => s.waitReason === "cline_question");
  await f.manager.send(started.taskId, undefined, "stop");
  const done = await f.wait(started.taskId, s => s.state === "done");
  assert.equal(done.outcome, "stopped"); assert.equal(done.plan?.steps[2].state, "pending");
  assert.equal(await readFile(path.join(f.cwd, "a"), "utf8"), "verified one");
  assert.equal(f.runs.length, 2); assert.equal((await f.manager.result(started.taskId)).log_run_hint?.ok, false);
  const release = acquire(f.cwd, { lockDirectory: f.locks }); release(); await f.snapshotsEmpty();
});

test("question resumes the same baseline with partial edits and cumulative Q&A; verification runs only after an answer", async t => {
  let verifications = 0;
  const f = await fixture(t, { runVerification: async () => { verifications++; return { passed: true, exitCode: 0, signal: null,
    timedOut: false, killedForOutput: false, durationMs: 1, stdoutTail: "", stderrTail: "" }; } });
  const started = f.start([step("one")]);
  await f.launched(1); await writeFile(path.join(f.cwd, "a"), "partial"); f.runs[0].finish("Partial summary\nQUESTION: Which port?\nOPTIONS: 80 | 8080");
  await f.wait(started.taskId, s => s.waitReason === "cline_question");
  assert.equal(verifications, 0); assert.equal(await readFile(path.join(f.cwd, "a"), "utf8"), "partial");
  await f.manager.send(started.taskId, "8080"); const second = await f.launched(2);
  assert.match(second.input.prompt, /Current step: one/); assert.match(second.input.prompt, /Which port/); assert.match(second.input.prompt, /8080/);
  assert.equal(await readFile(path.join(f.cwd, "a"), "utf8"), "partial"); second.finish("QUESTION: Which host?");
  await f.wait(started.taskId, s => s.waitReason === "cline_question");
  await f.manager.send(started.taskId, "localhost"); const third = await f.launched(3);
  assert.match(third.input.prompt, /Which port/); assert.match(third.input.prompt, /Which host/); assert.match(third.input.prompt, /localhost/);
  third.finish("Finished"); await f.wait(started.taskId, s => s.state === "done");
  assert.equal(verifications, 1); await f.snapshotsEmpty();
});

test("guard trip and Cline error restore before waiting, preserve evidence, and permit retry", async t => {
  for (const kind of ["loop_detected", "budget_exceeded", "non_zero_exit"] as const) {
    const f = await fixture(t);
    const started = f.start([step("one")]);
    await f.launched(1); await writeFile(path.join(f.cwd, "a"), "partial");
    f.runs[0].fail(new ClineRunError(kind, "run failed", kind !== "non_zero_exit" ? { guard: {
      window: 10, lastErrors: ["pattern mismatch"], filesTouched: ["a"], totalToolCalls: 3, totalInputTokens: 15
    } } : undefined));
    const waiting = await f.wait(started.taskId, s => s.state === "input_required");
    assert.equal(waiting.waitReason, kind !== "non_zero_exit" ? "guard" : "cline_error");
    assert.equal(await readFile(path.join(f.cwd, "a"), "utf8"), "dirty baseline\r\n");
    assert.deepEqual(waiting.plan?.steps[0].restore?.failed, []);
    await f.manager.send(started.taskId, "Use another approach"); (await f.launched(2)).finish();
    await f.wait(started.taskId, s => s.state === "done"); await f.snapshotsEmpty();
  }
});

test("HEAD/index changes fail closed without restoring or resetting, and keep evidence under the lock", async t => {
  for (const change of ["head", "index"] as const) {
    const f = await fixture(t);
    const started = f.start([step("one")]);
    await f.launched(1); await writeFile(path.join(f.cwd, "a"), "changed by step"); git(f.cwd, "add", "a");
    if (change === "head") git(f.cwd, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "unexpected");
    const changed = await headAndIndexIdentity(f.cwd); f.runs[0].finish();
    const waiting = await f.wait(started.taskId, s => s.state === "input_required");
    assert.equal(waiting.waitReason, "head_changed"); assert.ok(waiting.evidence?.before); assert.ok(waiting.evidence?.after);
    assert.equal(waiting.plan?.steps[0].verify, undefined);
    assert.equal(await readFile(path.join(f.cwd, "a"), "utf8"), "changed by step");
    assert.deepEqual(await headAndIndexIdentity(f.cwd), changed);
    assert.throws(() => acquire(f.cwd, { lockDirectory: f.locks }), CheckoutBusyError);
    await f.manager.send(started.taskId, undefined, "skip");
    await f.wait(started.taskId, s => s.state === "input_required"); assert.equal(f.runs.length, 1);
    await f.manager.send(started.taskId, undefined, "stop");
    await f.wait(started.taskId, s => s.state === "done"); assert.deepEqual(await headAndIndexIdentity(f.cwd), changed);
    const release = acquire(f.cwd, { lockDirectory: f.locks }); release();
  }
});

test("cancel during verification aborts the verifier, restores unverified bytes, and releases the lock", async t => {
  let verifierAborted = false;
  const f = await fixture(t, { runVerification: async (_spec, _cwd, signal) => new Promise(resolve => {
    signal?.addEventListener("abort", () => { verifierAborted = true; resolve({ passed: false, exitCode: null, signal: "SIGKILL",
      timedOut: false, killedForOutput: false, durationMs: 1, stdoutTail: "", stderrTail: "" }); }, { once: true });
  }) });
  const identity = await headAndIndexIdentity(f.cwd);
  const started = f.start([step("one")]);
  await f.launched(1); await writeFile(path.join(f.cwd, "a"), "unverified"); f.runs[0].finish();
  await f.wait(started.taskId, s => s.plan?.phase === "verify");
  const cancelled = await f.manager.cancel(started.taskId);
  assert.equal(cancelled.state, "cancelled"); assert.equal(verifierAborted, true);
  assert.equal(await readFile(path.join(f.cwd, "a"), "utf8"), "dirty baseline\r\n");
  assert.deepEqual(await headAndIndexIdentity(f.cwd), identity);
  assert.equal((await f.manager.result(started.taskId)).log_run_hint, null);
  const release = acquire(f.cwd, { lockDirectory: f.locks }); release(); await f.snapshotsEmpty();
});

test("three launches cap failure retries and question resumes; only skip/stop remain", async t => {
  for (const question of [false, true]) {
    const f = await fixture(t);
    const started = f.start([step("one", { command: process.execPath, args: ["-e", "process.exit(1)"] })]);
    for (let i = 1; i <= 3; i++) {
      const run = await f.launched(i); await writeFile(path.join(f.cwd, "a"), `attempt ${i}`);
      run.finish(question ? "QUESTION: Continue?" : "failed verification");
      const waiting = await f.wait(started.taskId, s => s.state === "input_required");
      if (i < 3) await f.manager.send(started.taskId, "Try again");
      else { assert.equal(waiting.waitReason, "budget"); assert.equal(waiting.plan?.attempt, 3); }
    }
    await assert.rejects(f.manager.send(started.taskId, "fourth attempt"), (e: unknown) => e instanceof ClineRunError && e.kind === "budget_exceeded");
    assert.equal(f.runs.length, 3); assert.equal(await readFile(path.join(f.cwd, "a"), "utf8"), "dirty baseline\r\n");
    await f.manager.send(started.taskId, undefined, "skip");
    const done = await f.wait(started.taskId, s => s.state === "done");
    assert.equal(done.waitReason, undefined);
    await f.snapshotsEmpty();
  }
});

test("ledger is at most 4000 chars and shrinks before mandatory objective/step/guidance under Windows limits", () => {
  const task = { mode: "edits", cwd: process.cwd(), provider: "p", model: "m", timeoutSeconds: 600 } as Task;
  const records = Array.from({ length: 15 }, (_, i) => ({ id: String(i), state: "verified" as const, attempts: 1,
    summary: "summary ".repeat(100), changedFiles: ["a"] }));
  const unlimited = buildStepPrompt("objective", step("current"), records, "Guidance", () => true);
  assert.ok(unlimited.split("Verified steps:\n")[1].split("\n\nGuidance")[0].length <= 4000);
  const fits = (text: string) => !isPromptTooLarge(text, task, getEffectivePreamble("edits"), "win32", { entryPath: "fake" });
  const objective = '"'.repeat(14000);
  const prompt = buildStepPrompt(objective, step("current"), records, "Required guidance", fits);
  assert.ok(fits(prompt)); assert.ok(prompt.includes(objective)); assert.match(prompt, /Implement current/); assert.match(prompt, /Required guidance/);
  assert.ok(prompt.length < unlimited.length + objective.length, "ledger was shrunk");
});

test("cancellation during a run or waiting restores the same baseline; shutdown also rolls back", async t => {
  for (const action of ["active", "waiting", "shutdown"]) {
    const f = await fixture(t);
    const started = f.start([step("one")]); await f.launched(1); await writeFile(path.join(f.cwd, "a"), "partial");
    if (action !== "active") { f.runs[0].finish("QUESTION: Continue?"); await f.wait(started.taskId, s => s.state === "input_required"); }
    if (action === "shutdown") await f.manager.shutdown(30_000); else await f.manager.cancel(started.taskId);
    assert.equal((await f.manager.status(started.taskId, 0)).state, "cancelled");
    assert.equal(await readFile(path.join(f.cwd, "a"), "utf8"), "dirty baseline\r\n");
    const release = acquire(f.cwd, { lockDirectory: f.locks }); release(); await f.snapshotsEmpty();
  }
});

test("step runner preserves unexpected commits instead of invoking the sync commit recovery path", async t => {
  const f = await fixture(t);
  const release = acquire(f.cwd, { lockDirectory: f.locks }); t.after(release);
  let changedHead = "";
  await runClineEditStep({ cwd: f.cwd, prompt: "step", codeMap: false, ...selection }, new AbortController().signal, {
    checkoutLock: release, recordStatus: false, respectQuotaLock: false,
    deps: { entryPath: "fake", access: async () => {}, acquireSettingsMutex: async () => async () => {},
      spawn: (() => {
        git(f.cwd, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "unexpected");
        changedHead = git(f.cwd, "rev-parse", "HEAD");
        const child = new EventEmitter() as any; child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.kill = () => {};
        queueMicrotask(() => { child.stdout.emit("data", Buffer.from('{"type":"run_result","finishReason":"success","text":"done"}\n')); child.emit("close", 0); });
        return child;
      }) as any }
  });
  assert.equal(git(f.cwd, "rev-parse", "HEAD"), changedHead);
});

test("a waiting segment publishes only after cleanup; immediate retry retains its lease and failure metrics", async t => {
  const f = await fixture(t);
  const started = f.start([step("one")]);
  const first = await f.launched(1);
  const failure = Object.assign(new ClineRunError("non_zero_exit", "failed"), { usage: { inputTokens: 7, outputTokens: 3 }, durationMs: 5 });
  first.fail(failure);
  await f.wait(started.taskId, s => s.state === "input_required");
  await f.manager.send(started.taskId, "Retry immediately");
  const second = await f.launched(2);
  assert.equal(second.options.checkoutLock, first.options.checkoutLock);
  assert.ok(ownsCheckoutLock(second.options.checkoutLock, f.cwd));
  second.finish();
  await f.wait(started.taskId, s => s.state === "done");
  const result = await f.manager.result(started.taskId);
  assert.deepEqual(result.result?.usage, { inputTokens: 17, outputTokens: 5 });
  assert.equal(result.result?.durationMs, 15);
  await f.snapshotsEmpty();
});

test("cancel during snapshot or restore never launches another run and waits for baseline cleanup", async t => {
  for (const phase of ["snapshot", "restore"] as const) {
    const f = await fixture(t);
    const started = f.start([step("one"), step("two")]);
    if (phase === "restore") {
      await f.launched(1); await writeFile(path.join(f.cwd, "a"), "partial");
      f.runs[0].fail(new ClineRunError("loop_detected", "guard stopped"));
    }
    await f.wait(started.taskId, s => s.plan?.phase === phase);
    await f.manager.cancel(started.taskId);
    assert.equal((await f.manager.status(started.taskId, 0)).state, "cancelled");
    assert.equal(await readFile(path.join(f.cwd, "a"), "utf8"), "dirty baseline\r\n");
    assert.ok(f.runs.length <= (phase === "snapshot" ? 0 : 1));
    const release = acquire(f.cwd, { lockDirectory: f.locks }); release(); await f.snapshotsEmpty();
  }
});

const counters = (calls: number, tokens: number): GuardReport => ({ window: 10, lastErrors: [], filesTouched: [],
  totalToolCalls: calls, totalInputTokens: tokens });

test("stepBudget is strict, bounded like guard, requires steps, and defaults are exposed", async t => {
  const input = { mode: "edits", prompt: "objective", cwd: "repo", ...selection, steps: [step("one")] };
  for (const stepBudget of [{ maxToolCallsPerStep: 9 }, { maxToolCallsPerPlan: 1001 }, { maxInputTokensPerStep: 9999 },
    { maxInputTokensPerPlan: 20_000_001 }, { maxToolCallsPerStep: 10.5 }, { unknown: 10 }]) {
    assert.equal(startTaskSchema.safeParse({ ...input, stepBudget }).success, false);
  }
  assert.equal(startTaskSchema.safeParse({ ...input, steps: undefined, stepBudget: {} }).success, false);
  assert.equal(startTaskSchema.safeParse({ ...input, stepBudget: {} }).success, true);
  const f = await fixture(t);
  const started = f.start([step("one")]);
  assert.deepEqual(started.plan?.budget?.limits, DEFAULT_STEP_BUDGET);
  await f.manager.cancel(started.taskId);
});

test("verification resolution errors populate failed verification evidence and restore before waiting", async t => {
  for (const command of ["cline-mcp-review-no-such-executable", ...(process.platform === "win32" ? ["review-refused.cmd", "review-refused.bat"] : [])]) {
    const f = await fixture(t);
    const started = f.start([step("one", { command, args: [] })]);
    const run = await f.launched(1);
    await writeFile(path.join(f.cwd, "a"), "unverified edit");
    run.finish("ready to verify");
    const waiting = await f.wait(started.taskId, status => status.state === "input_required");
    assert.equal(waiting.waitReason, "verify_failed", command);
    const result = waiting.plan!.steps[0].verify!;
    assert.equal(result.passed, false); assert.equal(result.exitCode, null); assert.equal(result.timedOut, false);
    assert.ok(result.error); assert.equal(result.stderrTail, result.error);
    assert.equal(await readFile(path.join(f.cwd, "a"), "utf8"), "dirty baseline\r\n");
    assert.deepEqual(waiting.plan!.steps[0].restore?.failed, []);
    await f.manager.send(started.taskId, undefined, "stop");
    await f.wait(started.taskId, status => status.state === "done");
    await f.snapshotsEmpty();
  }
});

test("per-step budgets span question resumes, cap explicit guard limits, restore and permit only skip/stop", async t => {
  for (const dimension of ["calls", "tokens"] as const) {
    const f = await fixture(t);
    const started = f.start([step("one"), step("two")], "objective", { stepBudget: {
      maxToolCallsPerStep: 20, maxInputTokensPerStep: 20_000
    }, guard: { maxToolCalls: 15, maxInputTokens: 15_000, window: 7 } });
    const first = await f.launched(1);
    assert.equal(first.options.guard.maxToolCalls, 15); assert.equal(first.options.guard.maxInputTokens, 15_000);
    assert.equal(first.options.guard.window, 7); assert.deepEqual(first.input.guard, first.options.guard);
    await writeFile(path.join(f.cwd, "a"), "partial question");
    first.finish("QUESTION: Continue?", undefined, dimension === "calls" ? counters(12, 100) : counters(1, 12_000));
    await f.wait(started.taskId, status => status.waitReason === "cline_question");
    await f.manager.send(started.taskId, "Continue");
    const second = await f.launched(2);
    assert.equal(second.options.guard[dimension === "calls" ? "maxToolCalls" : "maxInputTokens"], dimension === "calls" ? 8 : 8000);
    await writeFile(path.join(f.cwd, "a"), "over budget");
    second.fail(new ClineRunError("budget_exceeded", "step budget", { guard: dimension === "calls" ? counters(9, 100) : counters(1, 9000) }));
    const waiting = await f.wait(started.taskId, status => status.state === "input_required");
    assert.equal(waiting.waitReason, "budget"); assert.equal(waiting.evidence?.scope, "step");
    assert.equal(waiting.plan?.steps[0].counters?.[dimension === "calls" ? "totalToolCalls" : "totalInputTokens"], dimension === "calls" ? 21 : 21_000);
    assert.equal(await readFile(path.join(f.cwd, "a"), "utf8"), "dirty baseline\r\n");
    await assert.rejects(f.manager.send(started.taskId, "retry"), (err: unknown) => err instanceof ClineRunError && err.kind === "budget_exceeded");
    await f.manager.send(started.taskId, undefined, "skip");
    const third = await f.launched(3);
    assert.equal(third.options.guard.maxToolCalls, 15); assert.equal(third.options.guard.maxInputTokens, 15_000);
    third.finish("done", undefined, counters(1, 100));
    const done = await f.wait(started.taskId, status => status.state === "done");
    assert.equal(done.outcome, "completed_with_skips");
    await f.snapshotsEmpty();
  }
});

test("plan budgets sum success and error guards across steps/retries, retain verified edits, and cannot be reset by skip", async t => {
  for (const dimension of ["calls", "tokens"] as const) {
    const f = await fixture(t);
    const started = f.start([step("one"), step("two"), step("three")], "objective", { stepBudget: {
      maxToolCallsPerPlan: 20, maxInputTokensPerPlan: 20_000
    } });
    const report = (amount: number) => dimension === "calls" ? counters(amount, 100) : counters(1, amount * 1000);
    const first = await f.launched(1);
    await writeFile(path.join(f.cwd, "a"), "verified step"); first.finish("one", undefined, report(8));
    const second = await f.launched(2);
    await writeFile(path.join(f.cwd, "a"), "failed step"); second.fail(new ClineRunError("non_zero_exit", "retry me", { guard: report(6) }));
    await f.wait(started.taskId, status => status.state === "input_required");
    await f.manager.send(started.taskId, "Retry");
    const third = await f.launched(3);
    await writeFile(path.join(f.cwd, "a"), "unverified overspend"); third.finish("two", undefined, report(7));
    const waiting = await f.wait(started.taskId, status => status.state === "input_required");
    assert.equal(waiting.waitReason, "budget"); assert.equal(waiting.evidence?.scope, "plan");
    assert.equal(waiting.plan?.budget?.[dimension === "calls" ? "totalToolCalls" : "totalInputTokens"], dimension === "calls" ? 21 : 21_000);
    assert.equal(waiting.plan?.steps[1].verify, undefined, "verification never runs after crossing the plan limit");
    assert.equal(await readFile(path.join(f.cwd, "a"), "utf8"), "verified step");
    assert.equal(waiting.runHistory?.filter(run => run.guard).length, 3);
    await assert.rejects(f.manager.send(started.taskId, "retry"), ClineRunError);
    await f.manager.send(started.taskId, undefined, "skip");
    const stillWaiting = await f.wait(started.taskId, status => status.state === "input_required");
    assert.equal(stillWaiting.plan?.currentId, "three"); assert.equal(stillWaiting.waitReason, "budget");
    assert.equal(f.runs.length, 3, "skip cannot launch past the retained plan budget");
    await f.manager.send(started.taskId, undefined, "stop");
    await f.wait(started.taskId, status => status.state === "done");
    const result = await f.manager.result(started.taskId);
    assert.equal(result.outcome, "stopped"); assert.equal(result.log_run_hint?.ok, false);
    await f.snapshotsEmpty();
  }
});
