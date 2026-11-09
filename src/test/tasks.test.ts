import assert from "node:assert/strict";
import test, { after } from "node:test";
import { EventEmitter } from "node:events";
import { access, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { TaskManager, MAX_RUNNING_TASKS, UNCOLLECTED_TTL_MS } from "../tasks.js";
import { ClineRunError, askCline } from "../runner.js";
import { TraceRecorder } from "../trace.js";

const root = await mkdtemp(path.join(os.tmpdir(), "cline-tasks-test-"));
process.env.CLINE_MCP_STATUS_PATH = path.join(root, "provider-status.json");
process.env.CLINE_PROVIDER_SETTINGS_PATH = path.join(root, "providers.json");
after(() => rm(root, { recursive: true, force: true }));
let counter = 0;
const traceBase = () => path.join(root, `traces-${++counter}`);
const sel = { provider: "p", model: "m" };
const exists = (p: string) => access(p).then(() => true, () => false);

/** A runner that records a trace like the real one and finishes when told to. */
function controllable() {
  const runs: Array<{ finish: (text?: string) => void; fail: (err: unknown) => void; recorder: TraceRecorder; signal: AbortSignal }> = [];
  const runner = (_input: any, signal: AbortSignal, options: any) => new Promise<any>((resolve, reject) => {
    const recorder = new TraceRecorder({ base: options.deps?.traceBase, runId: options.traceRunId, statusIntervalMs: 5 });
    options.onTraceStart?.(recorder);
    recorder.attemptStarted(1);
    const run = {
      recorder, signal,
      finish: async (text = "done") => resolve({ text, durationMs: 1, trace: await recorder.finish({ ok: true }) }),
      fail: async (err: unknown) => { await recorder.finish({ ok: false }); reject(err); }
    };
    signal.addEventListener("abort", () => run.fail(new ClineRunError("cancelled", "The Cline request was cancelled.")), { once: true });
    runs.push(run);
  });
  return { runs, runner };
}

test("start returns at once; status long-polls until done; result returns the answer, a log hint, and cleans up", async () => {
  const c = controllable();
  const m = new TaskManager({ runners: { ask: c.runner }, traceBase: traceBase() });
  const started = m.start({ mode: "ask", prompt: "x", ...sel });
  assert.equal(started.state, "running");
  assert.equal(started.trace.runId, started.taskId);
  assert.equal((await m.status(started.taskId, 0)).state, "running");
  setTimeout(() => c.runs[0].finish("the answer"), 50);
  const t0 = Date.now();
  const done = await m.status(started.taskId, 30);
  assert.ok(Date.now() - t0 < 5000, "long poll returns when the task finishes, not at the wait limit");
  assert.equal(done.state, "done");
  assert.equal(done.resultReady, true);
  assert.ok(await exists(started.trace.dir));
  const r = await m.result(started.taskId);
  assert.equal(r.state, "done");
  assert.equal((r.result as any).text, "the answer");
  assert.equal(r.log_run_hint?.ok, true);
  assert.ok(!(await exists(started.trace.dir)), "trace folder removed after collection");
  await assert.rejects(m.status(started.taskId), (e: unknown) => e instanceof ClineRunError && e.kind === "task_not_found");
});

test("result of a running task is refused; keepTrace keeps the folder", async () => {
  const c = controllable();
  const m = new TaskManager({ runners: { ask: c.runner }, traceBase: traceBase() });
  const t = m.start({ mode: "ask", prompt: "x", ...sel });
  await assert.rejects(m.result(t.taskId), (e: unknown) => e instanceof ClineRunError && e.kind === "task_running");
  await c.runs[0].finish();
  await m.status(t.taskId, 5);
  const r = await m.result(t.taskId, true);
  assert.equal(r.trace?.dir, t.trace.dir);
  assert.ok(await exists(t.trace.dir));
});

test(`at most ${MAX_RUNNING_TASKS} tasks run at once`, async () => {
  const c = controllable();
  const m = new TaskManager({ runners: { ask: c.runner }, traceBase: traceBase() });
  const a = m.start({ mode: "ask", prompt: "1", ...sel });
  m.start({ mode: "ask", prompt: "2", ...sel });
  assert.throws(() => m.start({ mode: "ask", prompt: "3", ...sel }), (e: unknown) => e instanceof ClineRunError && e.kind === "task_limit");
  await c.runs[0].finish();
  await m.status(a.taskId, 5);
  assert.equal(m.start({ mode: "ask", prompt: "3", ...sel }).state, "running");
  await m.shutdown(1000);
});

test("cancel stops the task; its log hint is null (do not log)", async () => {
  const c = controllable();
  const m = new TaskManager({ runners: { ask: c.runner }, traceBase: traceBase() });
  const t = m.start({ mode: "ask", prompt: "x", ...sel });
  const v = await m.cancel(t.taskId);
  assert.equal(v.state, "cancelled");
  assert.ok(c.runs[0].signal.aborted);
  assert.equal((await m.result(t.taskId)).log_run_hint, null);
});

test("status returns early once for a new question Cline asked", async () => {
  const c = controllable();
  const m = new TaskManager({ runners: { ask: c.runner }, traceBase: traceBase() });
  const t = m.start({ mode: "ask", prompt: "x", ...sel });
  setTimeout(() => c.runs[0].recorder.line(JSON.stringify({ type: "agent_event", event: { type: "content_start", contentType: "tool",
    toolName: "ask_question", input: { question: "Which language?", options: ["Go", "Rust"] } } }), 1), 50);
  const t0 = Date.now();
  const v = await m.status(t.taskId, 30, 20);
  assert.ok(Date.now() - t0 < 5000);
  assert.equal(v.progress?.question?.question, "Which language?");
  const t1 = Date.now();
  await m.status(t.taskId, 1, 20);
  assert.ok(Date.now() - t1 >= 900, "the same question does not end the next long poll early");
  await m.shutdown(1000);
});

test("failures map to model-picker error kinds", async () => {
  const cases: Array<[unknown, string, number | undefined]> = [
    [new ClineRunError("timeout", "slow"), "timeout", undefined],
    [new ClineRunError("quota_exhausted", "daily quota"), "quota", undefined],
    [new ClineRunError("transient_provider_error", "429", { providerState: "rate_limited", retryAfterSeconds: 45 }), "quota", 45],
    [new ClineRunError("non_zero_exit", "boom"), "crash", undefined],
    [new Error("plain"), "crash", undefined]
  ];
  for (const [err, kind, retry] of cases) {
    const m = new TaskManager({ runners: { ask: async () => { throw err; } }, traceBase: traceBase() });
    const t = m.start({ mode: "ask", prompt: "x", ...sel });
    const v = await m.status(t.taskId, 5);
    assert.equal(v.state, "failed");
    const r = await m.result(t.taskId);
    assert.equal(r.log_run_hint?.ok, false);
    assert.equal(r.log_run_hint?.error_kind, kind);
    assert.equal(r.log_run_hint?.retry_after_s, retry);
  }
});

test("start validates selection and cwd before anything runs", () => {
  let ran = false;
  const m = new TaskManager({ runners: { ask: async () => { ran = true; return {} as any; }, workspace: async () => { ran = true; return {} as any; } } });
  assert.throws(() => m.start({ mode: "ask", prompt: "x", provider: "", model: "m" }), /provider and model are required/);
  assert.throws(() => m.start({ mode: "workspace", prompt: "x", ...sel }), /requires cwd/);
  assert.equal(ran, false);
});

test("uncollected settled tasks expire", async () => {
  let now = Date.parse("2026-11-10T10:00:00Z");
  const c = controllable();
  const m = new TaskManager({ runners: { ask: c.runner }, traceBase: traceBase(), wallNow: () => now });
  const t = m.start({ mode: "ask", prompt: "x", ...sel });
  await c.runs[0].finish();
  await m.status(t.taskId, 5);
  now += UNCOLLECTED_TTL_MS + 1;
  m.start({ mode: "ask", prompt: "y", ...sel }); // pruning happens on start
  await assert.rejects(m.status(t.taskId), (e: unknown) => e instanceof ClineRunError && e.kind === "task_not_found");
  await m.shutdown(1000);
});

function mockChild(stdout: string, code: number) {
  const child = new EventEmitter() as any;
  child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.kill = () => {}; child.pid = 777;
  queueMicrotask(() => { child.stdout.emit("data", Buffer.from(stdout)); child.emit("close", code); });
  return child;
}

test("real runner: one attempt only, a longer timeout than sync, child PID in progress", async () => {
  let spawns = 0;
  const base = traceBase();
  const deps = { entryPath: "fake", access: async () => {}, traceBase: base, backoffMs: 0, acquireSettingsMutex: async () => async () => {},
    spawn: (() => { spawns++; return mockChild('{"type":"run_result","finishReason":"error","text":"Service temporarily overloaded"}\n', 1); }) as any };
  const m = new TaskManager({ traceBase: base, runOptions: { deps } });
  const t = m.start({ mode: "ask", prompt: "x", ...sel, timeoutSeconds: 1500 });
  const v = await m.status(t.taskId, 10);
  assert.equal(v.state, "failed");
  assert.equal(spawns, 1, "a transient error is not retried in a task");
  assert.equal(v.progress?.childPid, 777);
  await assert.rejects(askCline({ prompt: "x", ...sel, timeoutSeconds: 1500 }, undefined, { deps }),
    /timeoutSeconds must be an integer from 1 to 300/, "the sync tools keep the 300 s cap");
});

test("a cancel before launch never starts Cline", async () => {
  let spawned = false;
  const controller = new AbortController();
  const work = askCline({ prompt: "x", ...sel }, controller.signal, { deps: {
    entryPath: "fake", acquireSettingsMutex: async () => async () => {},
    access: async () => { controller.abort(); },
    spawn: (() => { spawned = true; return mockChild("", 0); }) as any
  } });
  await assert.rejects(work, (e: unknown) => e instanceof ClineRunError && e.kind === "cancelled");
  assert.equal(spawned, false);
});

test("local failures are not logged against the model", async () => {
  for (const kind of ["workspace_not_git", "launch_failed", "settings_lock_timeout"] as const) {
    const m = new TaskManager({ runners: { ask: async () => { throw new ClineRunError(kind, "local"); } }, traceBase: traceBase() });
    const t = m.start({ mode: "ask", prompt: "x", ...sel });
    await m.status(t.taskId, 5);
    const r = await m.result(t.taskId);
    assert.equal(r.log_run_hint, null, kind);
    assert.match(r.log_run_note ?? "", /not a model run/);
  }
});

test("a closed recorder never recreates a deleted trace folder", async () => {
  let release!: () => void;
  const gate = new Promise<void>(r => { release = r; });
  const rec = new TraceRecorder({ base: traceBase(), statusIntervalMs: 1, appendFile: (async () => { await gate; }) as any });
  rec.line(JSON.stringify({ type: "run_result", text: "ok" }), 1);
  rec.line(JSON.stringify({ type: "run_result", text: "again" }), 1);
  await rec.finish({ ok: true }); // bounded wait; the stalled append is still queued
  rec.close();
  await rm(rec.info.dir, { recursive: true, force: true });
  release();
  await rec.idle(500);
  await new Promise(r => setTimeout(r, 50));
  assert.equal(await exists(rec.info.dir), false);
});

test("a cancel while the workspace is being prepared is reported as cancelled", async () => {
  const { askClineWorkspace } = await import("../workspace.js");
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(askClineWorkspace({ prompt: "x", cwd: process.cwd(), ...sel }, controller.signal),
    (e: unknown) => e instanceof ClineRunError && e.kind === "cancelled");
});

test("no task starts once shutdown has begun", async () => {
  const c = controllable();
  const m = new TaskManager({ runners: { ask: c.runner }, traceBase: traceBase() });
  const t = m.start({ mode: "ask", prompt: "x", ...sel });
  await m.shutdown(1000);
  assert.equal((await m.status(t.taskId)).state, "cancelled");
  assert.throws(() => m.start({ mode: "ask", prompt: "y", ...sel }), (e: unknown) => e instanceof ClineRunError && e.kind === "cancelled");
});

test("a status write after the trace folder was removed does not recreate it", async () => {
  const rec = new TraceRecorder({ base: traceBase(), statusIntervalMs: 1 });
  await rec.idle();
  await rm(rec.info.dir, { recursive: true, force: true });
  rec.attemptStarted(1); // schedules a status write
  await new Promise(r => setTimeout(r, 50));
  await rec.finish({ ok: true });
  assert.equal(await exists(rec.info.dir), false);
});

test("task errors keep notes that follow the trace line", async () => {
  const err = new ClineRunError("timeout", "slow");
  err.trace = { runId: "r", dir: "D", events: "E", status: "S" };
  err.notes = ["The temporary worktree W could not be removed: busy"];
  const m = new TaskManager({ runners: { ask: async () => { throw err; } }, traceBase: traceBase() });
  const t = m.start({ mode: "ask", prompt: "x", ...sel });
  const v = await m.status(t.taskId, 5);
  assert.match(v.error ?? "", /Note: The temporary worktree W could not be removed/);
  assert.doesNotMatch(v.error ?? "", /Trace: D/);
  assert.match((await m.result(t.taskId)).error ?? "", /Note: The temporary worktree W/);
});
