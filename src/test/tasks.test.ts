import assert from "node:assert/strict";
import test, { after } from "node:test";
import { EventEmitter } from "node:events";
import { access, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  TaskManager, MAX_RUNNING_TASKS, UNCOLLECTED_TTL_MS, parseQuestionFromText,
  TASK_QUESTION_PREAMBLE, getEffectivePreamble, isPromptTooLarge, minimumPrompt
} from "../tasks.js";
import {
  ClineRunError, askCline, NO_TOOLS_PREAMBLE,
  windowsCommandLineLength, WINDOWS_COMMAND_LINE_LIMIT
} from "../runner.js";
import { applyClineEdits, buildEditSystemPrompt, EDIT_SYSTEM_PROMPT } from "../edits.js";
import { TraceRecorder } from "../trace.js";

const root = await mkdtemp(path.join(os.tmpdir(), "cline-tasks-test-"));
process.env.CLINE_MCP_STATUS_PATH = path.join(root, "provider-status.json");
process.env.CLINE_PROVIDER_SETTINGS_PATH = path.join(root, "providers.json");
process.env.CLINE_MCP_CATALOG_PATH = path.join(root, "catalog.json");
process.env.CLINE_MCP_STATE_PATH = path.join(root, "state.json");
process.env.CLINE_MCP_TRACE_DIR = path.join(root, "traces-default");
after(() => rm(root, { recursive: true, force: true }));
let counter = 0;
const traceBase = () => path.join(root, `traces-${++counter}`);
const sel = { provider: "p", model: "m" };
const exists = (p: string) => access(p).then(() => true, () => false);

/** A runner that records a trace like the real one and finishes when told to. */
function controllable() {
  const runs: Array<{ finish: (text?: string) => void; fail: (err: unknown) => void; recorder: TraceRecorder; signal: AbortSignal; input: any; options: any }> = [];
  const runner = (_input: any, signal: AbortSignal, options: any) => new Promise<any>((resolve, reject) => {
    const recorder = new TraceRecorder({ base: options.deps?.traceBase, runId: options.traceRunId, statusIntervalMs: 5 });
    options.onTraceStart?.(recorder);
    recorder.attemptStarted(1);
    const run = {
      recorder, signal, input: _input, options,
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

test("parseQuestionFromText parses questions and options (last line wins, max 5, no question returns undefined)", () => {
  // With options
  const q1 = parseQuestionFromText("Working on files...\nQUESTION: Which database should we use?\nOPTIONS: SQLite | Postgres | MySQL");
  assert.deepEqual(q1, { question: "Which database should we use?", options: ["SQLite", "Postgres", "MySQL"] });

  // Without options
  const q2 = parseQuestionFromText("QUESTION: What is the target folder?");
  assert.deepEqual(q2, { question: "What is the target folder?" });

  // Last line wins
  const q3 = parseQuestionFromText("QUESTION: First question\nOPTIONS: 1 | 2\nThinking...\nQUESTION: Final question\nOPTIONS: a | b | c");
  assert.deepEqual(q3, { question: "Final question", options: ["a", "b", "c"] });

  // Max 5 options, trimmed
  const q4 = parseQuestionFromText("QUESTION: Pick one\nOPTIONS: opt1 | opt2 | opt3 | opt4 | opt5 | opt6 | opt7");
  assert.deepEqual(q4, { question: "Pick one", options: ["opt1", "opt2", "opt3", "opt4", "opt5"] });

  // No question
  assert.equal(parseQuestionFromText("Here is the answer, no questions asked."), undefined);
  assert.equal(parseQuestionFromText(""), undefined);
});

test("runner finishing with QUESTION enters input_required; finishing without QUESTION enters done", async () => {
  const c = controllable();
  const m = new TaskManager({ runners: { ask: c.runner }, traceBase: traceBase() });

  // Task 1: finishes with QUESTION -> input_required
  const t1 = m.start({ mode: "ask", prompt: "first task", ...sel });
  await c.runs[0].finish("Here is what I found.\nQUESTION: Proceed with changes?\nOPTIONS: yes | no");
  const s1 = await m.status(t1.taskId, 0);
  assert.equal(s1.state, "input_required");
  assert.deepEqual(s1.question, { question: "Proceed with changes?", options: ["yes", "no"] });

  // Task 2: finishes without QUESTION -> done
  const t2 = m.start({ mode: "ask", prompt: "second task", ...sel });
  await c.runs[1].finish("Here is what I found. Everything is done.");
  const s2 = await m.status(t2.taskId, 0);
  assert.equal(s2.state, "done");
  assert.equal(s2.question, undefined);

  await m.shutdown(1000);
});

test("long poll returns at once when a task enters input_required", async () => {
  const c = controllable();
  const m = new TaskManager({ runners: { ask: c.runner }, traceBase: traceBase() });
  const started = m.start({ mode: "ask", prompt: "x", ...sel });
  assert.equal(started.state, "running");

  setTimeout(() => c.runs[0].finish("Step 1 done.\nQUESTION: Which port?\nOPTIONS: 8080 | 3000"), 50);
  const t0 = Date.now();
  const status = await m.status(started.taskId, 30);
  assert.ok(Date.now() - t0 < 5000, "long poll returns promptly on input_required");
  assert.equal(status.state, "input_required");
  assert.equal(status.question?.question, "Which port?");
  assert.deepEqual(status.question?.options, ["8080", "3000"]);

  await m.shutdown(1000);
});

test("cline_send starts run 2 with a prompt containing original prompt, previous answer, question and answer", async () => {
  const c = controllable();
  let diffCalled = false;
  const m = new TaskManager({
    runners: { workspace: c.runner },
    traceBase: traceBase(),
    gitDiffStat: async () => { diffCalled = true; return "src/index.ts | 4 +-\n 1 file changed"; }
  });

  const started = m.start({ mode: "workspace", prompt: "Original prompt: build an HTTP server", cwd: "/fake/repo", ...sel });
  assert.equal(started.run, 1);
  assert.equal(started.runs.length, 1);

  // Run 1 finishes with a question
  await c.runs[0].finish("I looked at the repo.\nQUESTION: Express or Fastify?\nOPTIONS: Express | Fastify");
  const s1 = await m.status(started.taskId, 0);
  assert.equal(s1.state, "input_required");

  // Send answer to resume
  const sent = await m.send(started.taskId, "Caller answer: please use Fastify");
  assert.equal(sent.state, "running");
  assert.equal(sent.run, 2);
  assert.equal(sent.runs.length, 2);
  assert.equal(sent.trace.runId, `${started.taskId}-run-2`);
  assert.equal(diffCalled, true, "git diff --stat was queried for workspace task");

  assert.equal(c.runs.length, 2);
  const run2Prompt = c.runs[1].input.prompt;
  assert.ok(run2Prompt.includes("Original prompt: build an HTTP server"), "contains original prompt");
  assert.ok(run2Prompt.includes("I looked at the repo."), "contains previous answer");
  assert.ok(run2Prompt.includes("src/index.ts | 4 +-"), "contains git diff stat");
  assert.ok(run2Prompt.includes("Express or Fastify?"), "contains question");
  assert.ok(run2Prompt.includes("Caller answer: please use Fastify"), "contains caller answer");

  // Finish run 2
  await c.runs[1].finish("Server implemented with Fastify.");
  const s2 = await m.status(started.taskId, 0);
  assert.equal(s2.state, "done");
  assert.equal(s2.run, 2);
  assert.equal(s2.trace.runId, `${started.taskId}-run-2`);

  const res = await m.result(started.taskId);
  assert.equal(res.state, "done");
  assert.equal((res.result as any).text, "Server implemented with Fastify.");
});

test("wrong-state cline_send is refused with clear ClineRunError", async () => {
  const c = controllable();
  const m = new TaskManager({ runners: { ask: c.runner }, traceBase: traceBase() });
  const t = m.start({ mode: "ask", prompt: "x", ...sel });

  // While running: refused
  await assert.rejects(
    m.send(t.taskId, "answer"),
    (e: unknown) => e instanceof ClineRunError && e.kind === "task_not_waiting"
  );

  // After done: refused
  await c.runs[0].finish("Finished directly.");
  await m.status(t.taskId, 0);
  await assert.rejects(
    m.send(t.taskId, "answer"),
    (e: unknown) => e instanceof ClineRunError && e.kind === "task_not_waiting"
  );

  // Invalid message lengths refused
  const t2 = m.start({ mode: "ask", prompt: "x2", ...sel });
  await c.runs[1].finish("QUESTION: What next?");
  await assert.rejects(
    m.send(t2.taskId, ""),
    (e: unknown) => e instanceof ClineRunError && e.kind === "launch_failed"
  );
  await assert.rejects(
    m.send(t2.taskId, "x".repeat(20_001)),
    (e: unknown) => e instanceof ClineRunError && e.kind === "launch_failed"
  );

  await m.shutdown(1000);
});

test("result on input_required returns partial answer and keeps the task", async () => {
  const c = controllable();
  const m = new TaskManager({ runners: { ask: c.runner }, traceBase: traceBase() });
  const t = m.start({ mode: "ask", prompt: "initial task", ...sel });

  await c.runs[0].finish("Partial answer so far.\nQUESTION: Should I continue?\nOPTIONS: yes | no");
  const s = await m.status(t.taskId, 0);
  assert.equal(s.state, "input_required");

  // Call result while in input_required
  const r = await m.result(t.taskId);
  assert.equal(r.state, "input_required");
  assert.ok((r.result as any).text.includes("Partial answer so far."));
  assert.equal(r.log_run_hint, null);
  assert.match(r.log_run_note ?? "", /Task requires caller input/);

  // Task is NOT removed: can still read status and send
  const sAgain = await m.status(t.taskId, 0);
  assert.equal(sAgain.state, "input_required");

  // cline_send still works after result
  await m.send(t.taskId, "yes, continue");
  assert.equal(c.runs.length, 2);
  await c.runs[1].finish("Finished completely.");

  const finalRes = await m.result(t.taskId);
  assert.equal(finalRes.state, "done");
  assert.equal((finalRes.result as any).text, "Finished completely.");
});

test("autoAnswered is surfaced in status view when ask_question tool was used", async () => {
  const c = controllable();
  const m = new TaskManager({ runners: { ask: c.runner }, traceBase: traceBase() });
  const t = m.start({ mode: "ask", prompt: "x", ...sel });

  // Simulate Cline calling ask_question and auto-answering
  c.runs[0].recorder.line(JSON.stringify({
    type: "agent_event",
    event: {
      type: "content_start",
      contentType: "tool",
      toolName: "ask_question",
      input: { question: "Which port?", options: ["8080", "3000"] }
    }
  }), 1);
  c.runs[0].recorder.line(JSON.stringify({
    type: "agent_event",
    event: {
      type: "content_end",
      contentType: "tool",
      toolName: "ask_question",
      output: "8080"
    }
  }), 1);

  const v = await m.status(t.taskId, 0);
  assert.deepEqual(v.autoAnswered, { question: "Which port?", answer: "8080" });

  await c.runs[0].finish("done");
  const vDone = await m.status(t.taskId, 0);
  assert.deepEqual(vDone.autoAnswered, { question: "Which port?", answer: "8080" });

  await m.shutdown(1000);
});

test("question preamble is present in every task run, combined with no-tools preamble for ask mode", async () => {
  const c = controllable();
  const m = new TaskManager({ runners: { ask: c.runner }, traceBase: traceBase() });

  // Run 1
  const t = m.start({ mode: "ask", prompt: "run 1", ...sel });
  assert.ok(c.runs[0].options?.promptPreamble?.includes("never use the ask_question tool"), "preamble in run 1");

  await c.runs[0].finish("Partial.\nQUESTION: Continue?");
  await m.send(t.taskId, "yes");

  // Run 2
  assert.ok(c.runs[1].options?.promptPreamble?.includes("never use the ask_question tool"), "preamble in run 2");
  await c.runs[1].finish("Finished.");

  // Test real askCline: combines promptPreamble with NO_TOOLS_PREAMBLE
  let capturedPreamble: string | undefined;
  const mockDeps = {
    entryPath: "fake",
    access: async () => {},
    acquireSettingsMutex: async () => async () => {},
    spawn: ((_cmd: string, args: string[]) => {
      // Find the prompt argument (last arg)
      const lastArg = args[args.length - 1];
      capturedPreamble = lastArg;
      const child = new EventEmitter() as any;
      child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.kill = () => {}; child.pid = 999;
      queueMicrotask(() => {
        child.stdout.emit("data", Buffer.from('{"type":"run_result","finishReason":"success","text":"ok"}\n'));
        child.emit("close", 0);
      });
      return child;
    }) as any
  };

  await askCline({ prompt: "my test prompt", ...sel }, undefined, {
    promptPreamble: TASK_QUESTION_PREAMBLE,
    deps: mockDeps
  });

  assert.ok(capturedPreamble?.includes("never use the ask_question tool"), "TASK_QUESTION_PREAMBLE present in askCline prompt");
  assert.ok(capturedPreamble?.includes("this request runs WITHOUT tools"), "NO_TOOLS_PREAMBLE present in askCline prompt");
  assert.ok(capturedPreamble?.includes("my test prompt"), "user prompt present");
});

test("cancel and shutdown work during a resumed run (run 2)", async () => {
  const c = controllable();
  const m = new TaskManager({ runners: { ask: c.runner }, traceBase: traceBase() });
  const t = m.start({ mode: "ask", prompt: "x", ...sel });

  await c.runs[0].finish("QUESTION: Which language?");
  await m.send(t.taskId, "Go");
  assert.equal(c.runs.length, 2);
  assert.equal((await m.status(t.taskId, 0)).state, "running");

  // Cancel during run 2
  const v = await m.cancel(t.taskId);
  assert.equal(v.state, "cancelled");
  assert.equal(c.runs[1].signal.aborted, true);

  // Shutdown test with resumed run
  const c2 = controllable();
  const m2 = new TaskManager({ runners: { ask: c2.runner }, traceBase: traceBase() });
  const t2 = m2.start({ mode: "ask", prompt: "x2", ...sel });
  await c2.runs[0].finish("QUESTION: Which db?");
  await m2.send(t2.taskId, "Postgres");
  assert.equal((await m2.status(t2.taskId, 0)).state, "running");

  await m2.shutdown(1000);
  assert.equal((await m2.status(t2.taskId, 0)).state, "cancelled");
  assert.equal(c2.runs[1].signal.aborted, true);
});

test("resume race: send reserves synchronously; concurrent send or cancel during git diff is handled safely", async () => {
  const c = controllable();
  let releaseGit!: () => void;
  const gitGate = new Promise<string>((resolve) => {
    releaseGit = () => resolve("diff --stat output");
  });
  const m = new TaskManager({
    runners: { workspace: c.runner },
    traceBase: traceBase(),
    gitDiffStat: async () => gitGate
  });

  const t = m.start({ mode: "workspace", prompt: "work", cwd: "/fake/repo", ...sel });
  await c.runs[0].finish("QUESTION: Continue?");

  // Start send (it will await gitGate in 'resuming' state)
  const sendP1 = m.send(t.taskId, "yes");
  assert.equal((await m.status(t.taskId, 0)).state, "resuming");

  // A concurrent send while resuming must be rejected immediately
  await assert.rejects(
    m.send(t.taskId, "second send"),
    (e: unknown) => e instanceof ClineRunError && e.kind === "task_not_waiting"
  );

  // Release git diff to let first send finish resuming
  releaseGit();
  await sendP1;
  assert.equal(c.runs.length, 2);

  // Now test cancel during resuming:
  const c2 = controllable();
  let releaseGit2!: () => void;
  const m2 = new TaskManager({
    runners: { workspace: c2.runner },
    traceBase: traceBase(),
    gitDiffStat: async (_cwd, signal) => new Promise<string>((resolve) => {
      signal?.addEventListener("abort", () => resolve("diff cancelled"));
      releaseGit2 = () => resolve("diff 2");
    })
  });
  const t2 = m2.start({ mode: "workspace", prompt: "work 2", cwd: "/fake/repo", ...sel });
  await c2.runs[0].finish("QUESTION: Continue 2?");

  const sendP2 = m2.send(t2.taskId, "yes 2");
  assert.equal((await m2.status(t2.taskId, 0)).state, "resuming");

  // Cancel while git diff is awaiting
  await m2.cancel(t2.taskId);
  assert.equal((await m2.status(t2.taskId, 0)).state, "cancelled");

  releaseGit2();
  await assert.rejects(sendP2, (e: unknown) => e instanceof ClineRunError && e.kind === "cancelled");
  // No second run was ever launched on c2.runs for t2
  assert.equal(c2.runs.length, 1);
  await m.shutdown(1000);
  await m2.shutdown(1000);
});

test("truncation budget: caller answer is always kept in full; previous answer and diff trimmed first; oversized question+answer rejected before state change", async () => {
  const c = controllable();
  const m = new TaskManager({ runners: { ask: c.runner }, traceBase: traceBase() });
  const t = m.start({ mode: "ask", prompt: "A".repeat(5000), ...sel });

  // Run 1 finishes with large answer + question
  const bigAnswer = "B".repeat(15_000);
  await c.runs[0].finish(`${bigAnswer}\nQUESTION: Proceed?`);
  assert.equal((await m.status(t.taskId, 0)).state, "input_required");

  // Send a large caller answer (12,000 chars)
  const callerAnswer = "C".repeat(12_000);
  await m.send(t.taskId, callerAnswer);

  assert.equal(c.runs.length, 2);
  const run2Prompt = c.runs[1].input.prompt;
  // Caller answer must be kept in full!
  assert.ok(run2Prompt.includes(callerAnswer), "caller answer kept in full");
  assert.ok(run2Prompt.includes("QUESTION: Proceed?"), "question kept in full");
  // Previous answer must have been trimmed!
  assert.ok(!run2Prompt.includes(bigAnswer), "previous answer was trimmed to fit");
  assert.ok(run2Prompt.includes("[...]"), "contains truncation marker");
  assert.ok(run2Prompt.length <= 20_000, "fits inside 20000 chars");

  // If question + answer alone exceed 20,000 chars: reject BEFORE changing state
  const t2 = m.start({ mode: "ask", prompt: "t2", ...sel });
  await c.runs[2].finish("QUESTION: " + "Q".repeat(1000));
  assert.equal((await m.status(t2.taskId, 0)).state, "input_required");

  await assert.rejects(
    m.send(t2.taskId, "X".repeat(19_500)),
    (e: unknown) => e instanceof ClineRunError && e.kind === "launch_failed"
  );
  // Task state MUST remain input_required!
  assert.equal((await m.status(t2.taskId, 0)).state, "input_required");
});

test("windows command line: quote-heavy prompt exceeding escaped command limit is rejected before state change; quote-heavy previous answer is trimmed", async () => {
  const c = controllable();
  const m = new TaskManager({
    runners: { ask: c.runner },
    traceBase: traceBase(),
    platform: "win32"
  });
  const t = m.start({ mode: "ask", prompt: "short prompt", ...sel });
  await c.runs[0].finish("QUESTION: Which option?");

  // Caller answer with 18,000 quotes: fits in 20,000 chars, but exceeds MSVC escaped command line limit (32,000)
  const quoteHeavyAnswer = '"'.repeat(18_000);
  await assert.rejects(
    m.send(t.taskId, quoteHeavyAnswer),
    (e: unknown) => e instanceof ClineRunError && e.kind === "launch_failed"
  );
  // Task state remains input_required
  assert.equal((await m.status(t.taskId, 0)).state, "input_required");

  // Conversely: quote-heavy previous answer is trimmed to fit
  const t2 = m.start({ mode: "ask", prompt: "short prompt 2", ...sel });
  await c.runs[1].finish('"'.repeat(18_000) + '\nQUESTION: Continue?');
  // Small caller answer
  await m.send(t2.taskId, "yes");
  assert.equal(c.runs.length, 3);
  assert.equal((await m.status(t2.taskId, 0)).state, "running");
});

test("send does not prune the task being resumed even if idle for longer than TTL", async () => {
  let now = Date.parse("2026-11-10T10:00:00Z");
  const c = controllable();
  const m = new TaskManager({
    runners: { ask: c.runner },
    traceBase: traceBase(),
    wallNow: () => now
  });
  const t = m.start({ mode: "ask", prompt: "x", ...sel });
  await c.runs[0].finish("QUESTION: Which language?");
  assert.equal((await m.status(t.taskId, 0)).state, "input_required");

  // Advance time past uncollected TTL
  now += UNCOLLECTED_TTL_MS + 5000;

  // Resuming must NOT drop the task!
  const sent = await m.send(t.taskId, "Go");
  assert.equal(sent.state, "running");
  assert.equal((await m.status(t.taskId, 0)).state, "running");
  assert.equal(c.runs.length, 2);
});

test("QUESTION: inside code blocks or mid-answer prose leaves the task done, not input_required", async () => {
  const c = controllable();
  const m = new TaskManager({ runners: { ask: c.runner }, traceBase: traceBase() });

  // Inside fenced code block
  const t1 = m.start({ mode: "ask", prompt: "code example", ...sel });
  await c.runs[0].finish("Here is an example:\n```\nQUESTION: Which one?\nOPTIONS: a | b\n```\n");
  const s1 = await m.status(t1.taskId, 0);
  assert.equal(s1.state, "done", "QUESTION inside code block leaves task done");
  assert.equal(s1.question, undefined);

  // Mid-answer prose (followed by other non-empty lines)
  const t2 = m.start({ mode: "ask", prompt: "mid prose", ...sel });
  await c.runs[1].finish("I have a QUESTION: Is this right?\nHere are more explanations.\nDone.\n");
  const s2 = await m.status(t2.taskId, 0);
  assert.equal(s2.state, "done", "QUESTION followed by prose leaves task done");
  assert.equal(s2.question, undefined);

  // Trailing QUESTION outside code block correctly enters input_required
  const t3 = m.start({ mode: "ask", prompt: "real question", ...sel });
  await c.runs[2].finish("```ts\nconst x = 1;\n```\n\nQUESTION: Proceed with this code?\nOPTIONS: yes | no\n");
  const s3 = await m.status(t3.taskId, 0);
  assert.equal(s3.state, "input_required", "trailing QUESTION enters input_required");
  assert.equal(s3.question?.question, "Proceed with this code?");
});

test("stale result cleared when resume starts so a failed run 2 does not return run 1's partial answer", async () => {
  const c = controllable();
  const m = new TaskManager({ runners: { ask: c.runner }, traceBase: traceBase() });
  const t = m.start({ mode: "ask", prompt: "task 1", ...sel });

  await c.runs[0].finish("Partial answer from run 1.\nQUESTION: What next?");
  assert.equal((await m.status(t.taskId, 0)).state, "input_required");

  // Send answer
  await m.send(t.taskId, "next step");
  assert.equal(c.runs.length, 2);

  // Run 2 fails
  await c.runs[1].fail(new ClineRunError("non_zero_exit", "Run 2 crashed"));
  const s = await m.status(t.taskId, 0);
  assert.equal(s.state, "failed");

  const r = await m.result(t.taskId);
  assert.equal(r.state, "failed");
  assert.equal(r.result, undefined, "failed run 2 must NOT return run 1 partial result");
  assert.ok(r.error?.includes("Run 2 crashed"));
});

test("P1 long poll does not starve a resume: status races pending settled promise and yields to event loop", async () => {
  const c = controllable();
  let releaseGit!: () => void;
  const gitPromise = new Promise<string>((resolve) => {
    releaseGit = () => resolve("src/app.ts | 2 +-\n 1 file changed");
  });

  const m = new TaskManager({
    runners: { workspace: c.runner },
    traceBase: traceBase(),
    gitDiffStat: async () => gitPromise
  });

  const t = m.start({ mode: "workspace", prompt: "initial", cwd: "/fake/repo", ...sel });
  await c.runs[0].finish("QUESTION: Continue?");

  // Call send, transitioning task to 'resuming' while waiting on gitDiffStat
  const sendP = m.send(t.taskId, "yes");
  const initialStatus = await m.status(t.taskId, 0);
  assert.equal(initialStatus.state, "resuming");

  // Timer scheduled during resuming must fire and not be starved by concurrent status long poll
  let timerFired = false;
  const timerPromise = new Promise<void>(resolve => {
    setTimeout(() => { timerFired = true; resolve(); }, 10);
  });

  // Long poll status call with waitSeconds > 0
  const statusP = m.status(t.taskId, 2);

  // Allow timer to fire while statusP is actively waiting
  await timerPromise;
  assert.equal(timerFired, true, "event loop timer fired while status was long polling a resuming task");

  // Release git diff to let run 2 launch
  releaseGit();
  await sendP;
  assert.equal(c.runs.length, 2);

  // Finish run 2; long poll statusP must resolve promptly with done
  await c.runs[1].finish("Finished after resume.");
  const finalStatus = await statusP;
  assert.equal(finalStatus.state, "done");
  assert.equal(finalStatus.run, 2);

  await m.shutdown(1000);
});

test("P2 Windows command line budgeting uses real workspace worktree path, system prompt, and preambles", async () => {
  const c = controllable();
  const m = new TaskManager({
    runners: { workspace: c.runner },
    traceBase: traceBase(),
    platform: "win32"
  });

  const t = m.start({ mode: "workspace", prompt: "short prompt", cwd: "/fake/repo", ...sel });
  await c.runs[0].finish("QUESTION: Which port?");

  // Check isPromptTooLarge directly for workspace mode:
  // It accounts for WORKSPACE_SYSTEM_PROMPT, WORKTREE_BASE, and preamble
  const preamble = getEffectivePreamble("workspace");
  const dummyTask: any = {
    mode: "workspace",
    provider: "anthropic",
    model: "claude-3-5-sonnet",
    cwd: "/fake/repo",
    thinking: "none",
    timeoutSeconds: 1800
  };

  // An oversized quote-heavy prompt that would be allowed under a small dummy system prompt
  // but exceeds the 32,000 escaped limit with real WORKSPACE_SYSTEM_PROMPT and WORKTREE_BASE
  const quoteHeavyAnswer = '"'.repeat(16_500);
  const tooLarge = isPromptTooLarge(minimumPrompt({ question: "Which port?", answer: quoteHeavyAnswer }), dummyTask, preamble, "win32");
  assert.equal(tooLarge, true, "isPromptTooLarge correctly detects command line overflow using real workspace args");

  // Rejection happens before state change on send
  await assert.rejects(
    m.send(t.taskId, quoteHeavyAnswer),
    (e: unknown) => e instanceof ClineRunError && e.kind === "launch_failed"
  );
  assert.equal((await m.status(t.taskId, 0)).state, "input_required");

  await m.shutdown(1000);
});

test("P2 multi-turn Q&A history: prompt retains entire history oldest first and trims older turns when constrained", async () => {
  const c = controllable();
  const m = new TaskManager({
    runners: { ask: c.runner },
    traceBase: traceBase()
  });

  const t = m.start({ mode: "ask", prompt: "Initial prompt for multi-turn task", ...sel });

  // Run 1 asks Q1
  await c.runs[0].finish("Started work.\nQUESTION: Q1: What port?");
  assert.equal((await m.status(t.taskId, 0)).state, "input_required");

  // Send answer A1 -> launches Run 2
  await m.send(t.taskId, "A1: 8080 " + "A".repeat(1000));
  assert.equal(c.runs.length, 2);
  const run2Prompt = c.runs[1].input.prompt;
  assert.ok(run2Prompt.includes("Q1: What port?"));
  assert.ok(run2Prompt.includes("A1: 8080"));

  // Run 2 asks Q2
  await c.runs[1].finish("Port set.\nQUESTION: Q2: Which host?");
  assert.equal((await m.status(t.taskId, 0)).state, "input_required");

  // Send answer A2 -> launches Run 3
  await m.send(t.taskId, "A2: localhost");
  assert.equal(c.runs.length, 3);
  const run3Prompt = c.runs[2].input.prompt;

  // Prompt must contain BOTH turns oldest first!
  const idxQ1 = run3Prompt.indexOf("Previous question:\nQ1: What port?");
  const idxA1 = run3Prompt.indexOf("Previous answer:\nA1: 8080");
  const idxQ2 = run3Prompt.indexOf("Cline question:\nQ2: Which host?");
  const idxA2 = run3Prompt.indexOf("Caller answer:\nA2: localhost");
  assert.ok(idxQ1 !== -1, "run 3 prompt contains Q1");
  assert.ok(idxA1 !== -1, "run 3 prompt contains A1");
  assert.ok(idxQ2 !== -1, "run 3 prompt contains Q2");
  assert.ok(idxA2 !== -1, "run 3 prompt contains A2");
  assert.ok(idxQ1 < idxA1 && idxA1 < idxQ2 && idxQ2 < idxA2, "turns are ordered oldest first");

  // Run 3 asks Q3
  await c.runs[2].finish("Host set.\nQUESTION: Q3: HTTPS?");
  assert.equal((await m.status(t.taskId, 0)).state, "input_required");

  // Send large answer A3: older turns must be trimmed first, latest turn (Q3/A3) kept in full
  const largeAnswer = "X".repeat(19_200);
  await m.send(t.taskId, largeAnswer);
  assert.equal(c.runs.length, 4);
  const run4Prompt = c.runs[3].input.prompt;

  assert.ok(run4Prompt.includes(largeAnswer), "latest caller answer A3 kept in full");
  assert.ok(run4Prompt.includes("Q3: HTTPS?"), "latest question Q3 kept in full");
  // Due to size budget, older turns should have been trimmed out
  assert.ok(!run4Prompt.includes("Q1: What port?"), "oldest turn trimmed to fit budget");

  await m.shutdown(1000);
});

test("P2 old trace data (recorder, progress, autoAnswered) is cleared during resuming", async () => {
  const c = controllable();
  let releaseGit!: () => void;
  const gitPromise = new Promise<string>((resolve) => {
    releaseGit = () => resolve("diff stat");
  });

  const m = new TaskManager({
    runners: { workspace: c.runner },
    traceBase: traceBase(),
    gitDiffStat: async () => gitPromise
  });

  const t = m.start({ mode: "workspace", prompt: "task with trace", cwd: "/fake/repo", ...sel });

  // Simulate tool call and auto-answer in run 1
  c.runs[0].recorder.line(JSON.stringify({
    type: "agent_event",
    event: {
      type: "content_start",
      contentType: "tool",
      toolName: "ask_question",
      input: { question: "Q from run 1?", options: ["a", "b"] }
    }
  }), 1);
  c.runs[0].recorder.line(JSON.stringify({
    type: "agent_event",
    event: {
      type: "content_end",
      contentType: "tool",
      toolName: "ask_question",
      output: "a"
    }
  }), 1);

  // Run 1 ends with question
  await c.runs[0].finish("Finished step 1.\nQUESTION: What next?");
  const s1 = await m.status(t.taskId, 0);
  assert.equal(s1.state, "input_required");
  assert.deepEqual(s1.autoAnswered, { question: "Q from run 1?", answer: "a" });
  assert.equal(s1.question?.question, "What next?");

  // Send answer: enters resuming
  const sendP = m.send(t.taskId, "proceed");
  const sResuming = await m.status(t.taskId, 0);
  assert.equal(sResuming.state, "resuming");
  // Recorder and old trace data must be cleared!
  assert.equal(sResuming.progress, undefined, "progress cleared during resuming");
  assert.equal(sResuming.autoAnswered, undefined, "autoAnswered cleared during resuming");
  assert.equal(sResuming.question, undefined, "question cleared during resuming");
  assert.equal(sResuming.resultReady, false, "resultReady false during resuming");

  // Complete resume
  releaseGit();
  await sendP;
  assert.equal(c.runs.length, 2);

  await m.shutdown(1000);
});

test("budget uses the exact system prompt that applyClineEdits passes", async () => {
  assert.equal(typeof EDIT_SYSTEM_PROMPT, "string");
  assert.ok(EDIT_SYSTEM_PROMPT.length > 50);

  // 1. Verify applyClineEdits passes EDIT_SYSTEM_PROMPT to runCline
  let capturedSystemPrompt: string | undefined;
  const mockDeps = {
    entryPath: "fake",
    access: async () => {},
    acquireSettingsMutex: async () => async () => {},
    spawn: ((_cmd: string, args: string[]) => {
      const idx = args.indexOf("--system");
      if (idx !== -1) capturedSystemPrompt = args[idx + 1];
      const child = new EventEmitter() as any;
      child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.kill = () => {}; child.pid = 999;
      queueMicrotask(() => {
        child.stdout.emit("data", Buffer.from('{"type":"run_result","finishReason":"success","text":"ok"}\n'));
        child.emit("close", 0);
      });
      return child;
    }) as any
  };

  await applyClineEdits({ prompt: "edit test", cwd: process.cwd(), codeMap: false, ...sel }, undefined, {
    deps: mockDeps as any, checkoutLockDirectory: path.join(root, "locks")
  });
  assert.equal(capturedSystemPrompt, buildEditSystemPrompt(process.cwd()), "applyClineEdits passes the per-run environment and mode prompt");

  // 2. Verify isPromptTooLarge for edits mode uses the exact EDIT_SYSTEM_PROMPT
  const task: any = { mode: "edits", provider: "p", model: "m", cwd: process.cwd(), thinking: "none", timeoutSeconds: 600 };
  const preamble = getEffectivePreamble("edits");
  const buildArgs = (prompt: string) => [
    "fake",
    "--json",
    "--auto-approve", "true",
    "--thinking", "none",
    "--timeout", "600",
    "-P", "p",
    "-m", "m",
    "--system", buildEditSystemPrompt(process.cwd(), "win32"),
    "--cwd", process.cwd(),
    preamble + prompt
  ];

  // Each quote costs two UTF-16 units. Derive room from the real system prompt and machine paths.
  const room = WINDOWS_COMMAND_LINE_LIMIT - windowsCommandLineLength(process.execPath, buildArgs(""));
  const quotePromptUnder = '"'.repeat(Math.floor(room / 2)) + "x".repeat(room % 2);
  const quotePromptOver = quotePromptUnder + '"';

  assert.equal(windowsCommandLineLength(process.execPath, buildArgs(quotePromptUnder)), WINDOWS_COMMAND_LINE_LIMIT);
  assert.equal(windowsCommandLineLength(process.execPath, buildArgs(quotePromptOver)), WINDOWS_COMMAND_LINE_LIMIT + 2);

  assert.equal(isPromptTooLarge(quotePromptUnder, task, preamble, "win32", { entryPath: "fake" }), false);
  assert.equal(isPromptTooLarge(quotePromptOver, task, preamble, "win32", { entryPath: "fake" }), true);
});

test("parseQuestionFromText parses trailing question regardless of preceding Markdown (closed 4-backtick/tilde/list fences, accepted residual)", async () => {
  // 1. Closed 4-backtick block enclosing 3 backticks, followed by trailing QUESTION
  const userExample = "````text\n```\n````\nQUESTION: Continue?";
  assert.deepEqual(parseQuestionFromText(userExample), { question: "Continue?" });

  // User example with OPTIONS
  const userExampleWithOptions = "````text\n```\n````\nQUESTION: Continue?\nOPTIONS: yes | no";
  assert.deepEqual(parseQuestionFromText(userExampleWithOptions), { question: "Continue?", options: ["yes", "no"] });

  // QUESTION inside closed code block is not the trailing line -> not a question (undefined)
  const insideEnclosed = "````text\n```\nQUESTION: Should be ignored\n```\n````";
  assert.equal(parseQuestionFromText(insideEnclosed), undefined);

  // 2. Closed tilde fence: ~~~ followed by trailing QUESTION
  const tildeExample = "~~~\nconst code = 123;\n~~~\nQUESTION: Continue with tilde?";
  assert.deepEqual(parseQuestionFromText(tildeExample), { question: "Continue with tilde?" });

  // QUESTION inside closed tilde fence is not trailing -> undefined
  const insideTilde = "~~~\nQUESTION: Inside tilde block?\n~~~";
  assert.equal(parseQuestionFromText(insideTilde), undefined);

  // Mixed fence delimiters inside closed blocks -> undefined
  const backticksInsideTilde = "~~~\n```\nQUESTION: Inside tilde with backticks?\n```\n~~~";
  assert.equal(parseQuestionFromText(backticksInsideTilde), undefined);

  const tildesInsideBackticks = "```\n~~~\nQUESTION: Inside backticks with tildes?\n~~~\n```";
  assert.equal(parseQuestionFromText(tildesInsideBackticks), undefined);

  // 3. Longer closing fence: 3 backticks opened, 5 backticks closed, followed by QUESTION
  const longerClosing = "```\nconst x = 1;\n`````\nQUESTION: Continue after longer fence?";
  assert.deepEqual(parseQuestionFromText(longerClosing), { question: "Continue after longer fence?" });

  // Closing fence with up to 3 spaces indent followed by QUESTION
  const indentedClose = "```\nconst x = 1;\n   ```\nQUESTION: Indented close?";
  assert.deepEqual(parseQuestionFromText(indentedClose), { question: "Indented close?" });

  // 4. Decision D-25: Fence opened inside a list item followed by trailing QUESTION -> input_required
  const listFenceExample = "- ```text\n  example\n  ```\n\nQUESTION: Continue?";
  assert.deepEqual(parseQuestionFromText(listFenceExample), { question: "Continue?" });

  // 5. Accepted residual: text ending inside an unclosed fence with a column-0 QUESTION line is treated as a question
  const unclosedFenceEndingInQuestion = "```ts\nconst x = 1;\nQUESTION: Unclosed fence question?";
  assert.deepEqual(parseQuestionFromText(unclosedFenceEndingInQuestion), { question: "Unclosed fence question?" });

  // Task runner context: list fence example enters input_required
  const c = controllable();
  const m = new TaskManager({ runners: { ask: c.runner }, traceBase: traceBase() });
  const t = m.start({ mode: "ask", prompt: "task", ...sel });
  await c.runs[0].finish(listFenceExample);
  const status = await m.status(t.taskId, 0);
  assert.equal(status.state, "input_required");
  assert.equal(status.question?.question, "Continue?");
  await m.shutdown(1000);
});

test("QUESTION and OPTIONS count only with 0-3 leading spaces and no leading tab (CommonMark indented code blocks)", async () => {
  // 1. 4-space indented example stays done (undefined from parser, done in task runner)
  const fourSpacesExample = "Example:\n\n    QUESTION: Which database?";
  assert.equal(parseQuestionFromText(fourSpacesExample), undefined);

  // 4-space with OPTIONS
  const fourSpacesWithOptions = "Example:\n\n    QUESTION: Which database?\n    OPTIONS: Postgres | SQLite";
  assert.equal(parseQuestionFromText(fourSpacesWithOptions), undefined);

  // 5+ spaces also stay undefined
  const fiveSpaces = "Example:\n\n     QUESTION: Which database?";
  assert.equal(parseQuestionFromText(fiveSpaces), undefined);

  // Task runner: 4-space example ends with state 'done', not 'input_required'
  const c1 = controllable();
  const m1 = new TaskManager({ runners: { ask: c1.runner }, traceBase: traceBase() });
  const t1 = m1.start({ mode: "ask", prompt: "t1", ...sel });
  await c1.runs[0].finish(fourSpacesExample);
  const s1 = await m1.status(t1.taskId, 0);
  assert.equal(s1.state, "done", "4-space indented QUESTION leaves task done");
  assert.equal(s1.question, undefined);
  await m1.shutdown(1000);

  // 2. Tab-indented example stays done
  const tabIndentedExample = "Example:\n\n\tQUESTION: Which database?";
  assert.equal(parseQuestionFromText(tabIndentedExample), undefined);

  const tabIndentedWithOptions = "Example:\n\n\tQUESTION: Which database?\n\tOPTIONS: Postgres | SQLite";
  assert.equal(parseQuestionFromText(tabIndentedWithOptions), undefined);

  const mixedTabSpace = "Example:\n\n \tQUESTION: Which database?";
  assert.equal(parseQuestionFromText(mixedTabSpace), undefined);

  // Task runner: tab-indented example ends with state 'done'
  const c2 = controllable();
  const m2 = new TaskManager({ runners: { ask: c2.runner }, traceBase: traceBase() });
  const t2 = m2.start({ mode: "ask", prompt: "t2", ...sel });
  await c2.runs[0].finish(tabIndentedExample);
  const s2 = await m2.status(t2.taskId, 0);
  assert.equal(s2.state, "done", "tab-indented QUESTION leaves task done");
  assert.equal(s2.question, undefined);
  await m2.shutdown(1000);

  // 3. 0-3 leading spaces count as real questions
  const zeroSpaces = "QUESTION: Which database?";
  assert.deepEqual(parseQuestionFromText(zeroSpaces), { question: "Which database?" });

  const oneSpace = " QUESTION: Which database?";
  assert.deepEqual(parseQuestionFromText(oneSpace), { question: "Which database?" });

  const twoSpaces = "  QUESTION: Which database?";
  assert.deepEqual(parseQuestionFromText(twoSpaces), { question: "Which database?" });

  const threeSpaces = "   QUESTION: Which database?";
  assert.deepEqual(parseQuestionFromText(threeSpaces), { question: "Which database?" });

  // 0-3 spaces with OPTIONS
  const threeSpacesWithOptions = "   QUESTION: Which database?\n   OPTIONS: Postgres | SQLite";
  assert.deepEqual(parseQuestionFromText(threeSpacesWithOptions), {
    question: "Which database?",
    options: ["Postgres", "SQLite"]
  });

  // Task runner: 3-space indented question enters input_required
  const c3 = controllable();
  const m3 = new TaskManager({ runners: { ask: c3.runner }, traceBase: traceBase() });
  const t3 = m3.start({ mode: "ask", prompt: "t3", ...sel });
  await c3.runs[0].finish(threeSpacesWithOptions);
  const s3 = await m3.status(t3.taskId, 0);
  assert.equal(s3.state, "input_required");
  assert.deepEqual(s3.question, { question: "Which database?", options: ["Postgres", "SQLite"] });
  await m3.shutdown(1000);
});

test("aborting during a slow injected gitDiffStat resolves without launching", async () => {
  const c = controllable();
  let helperAborted = false;
  let helperFinished = false;
  let cancelFinished = false;

  const m = new TaskManager({
    runners: { workspace: c.runner },
    traceBase: traceBase(),
    gitDiffStat: async (_cwd, signal) => {
      return new Promise<string | undefined>((resolve) => {
        signal?.addEventListener("abort", () => {
          helperAborted = true;
          setTimeout(() => {
            assert.equal(cancelFinished, false, "gitDiffStat must finish BEFORE cancel resolves");
            helperFinished = true;
            resolve(undefined);
          }, 30);
        });
      });
    }
  });

  const t = m.start({ mode: "workspace", prompt: "initial task", cwd: "/fake/repo", ...sel });
  await c.runs[0].finish("QUESTION: Should I proceed?");

  const sendP = m.send(t.taskId, "yes");
  assert.equal((await m.status(t.taskId, 0)).state, "resuming");

  // Cancel while git diff is awaiting
  const cancelPromise = m.cancel(t.taskId);
  await cancelPromise;
  cancelFinished = true;

  assert.equal(helperAborted, true, "gitDiffStat observed abort signal");
  assert.equal(helperFinished, true, "gitDiffStat finished during cancel await");

  await assert.rejects(sendP, (e: unknown) => e instanceof ClineRunError && e.kind === "cancelled");
  assert.equal(c.runs.length, 1, "run 2 must never be launched");

  const res = await m.result(t.taskId);
  assert.equal(res.state, "cancelled");
  assert.match(res.error ?? "", /cancelled/i);

  await m.shutdown(1000);
});

test("shutdown() awaits a resuming task (the injected helper observes the abort and finishes before shutdown() resolves)", async () => {
  const c = controllable();
  let helperAborted = false;
  let helperFinished = false;
  let shutdownFinished = false;

  const m = new TaskManager({
    runners: { workspace: c.runner },
    traceBase: traceBase(),
    gitDiffStat: async (_cwd, signal) => {
      return new Promise<string | undefined>((resolve) => {
        signal?.addEventListener("abort", () => {
          helperAborted = true;
          setTimeout(() => {
            assert.equal(shutdownFinished, false, "injected git helper must finish BEFORE shutdown resolves");
            helperFinished = true;
            resolve(undefined);
          }, 40);
        });
      });
    }
  });

  const t = m.start({ mode: "workspace", prompt: "initial task for shutdown", cwd: "/fake/repo", ...sel });
  await c.runs[0].finish("QUESTION: Ready for shutdown test?");

  const sendP = m.send(t.taskId, "go ahead");
  assert.equal((await m.status(t.taskId, 0)).state, "resuming");

  // Shutdown while git diff is awaiting
  const shutdownPromise = m.shutdown(2000);
  await shutdownPromise;
  shutdownFinished = true;

  assert.equal(helperAborted, true, "injected git helper observed abort signal");
  assert.equal(helperFinished, true, "injected git helper finished before shutdown resolved");

  await assert.rejects(sendP, (e: unknown) => e instanceof ClineRunError && e.kind === "cancelled");
  assert.equal(c.runs.length, 1, "run 2 must never be launched");

  const s = await m.status(t.taskId, 0);
  assert.equal(s.state, "cancelled");
});

test("options stored in Q&A history: resumed prompt contains options and answer when previous answer is trimmed", async () => {
  const c = controllable();
  const m = new TaskManager({
    runners: { ask: c.runner },
    traceBase: traceBase()
  });

  // Near-limit original prompt (e.g. 19,000 chars)
  const bigPrompt = "Original long task description: " + "a".repeat(18_900);
  const t = m.start({ mode: "ask", prompt: bigPrompt, ...sel });

  // Run 1 finishes with question and options, plus detailed previous answer prose
  const prevAnswerProse = "Detailed analysis of potential database architectures and options...\n".repeat(20);
  await c.runs[0].finish(`${prevAnswerProse}\nQUESTION: Which database?\nOPTIONS: SQLite | PostgreSQL`);

  const s1 = await m.status(t.taskId, 0);
  assert.equal(s1.state, "input_required");
  assert.deepEqual(s1.question, {
    question: "Which database?",
    options: ["SQLite", "PostgreSQL"]
  });

  // Caller responds "the second one"
  await m.send(t.taskId, "the second one");

  assert.equal(c.runs.length, 2);
  const run2Prompt = c.runs[1].input.prompt;

  // The resumed prompt contains both options, the question, and the answer
  assert.ok(run2Prompt.includes("Options: SQLite | PostgreSQL"), "resumed prompt contains options");
  assert.ok(run2Prompt.includes("Which database?"), "resumed prompt contains question");
  assert.ok(run2Prompt.includes("the second one"), "resumed prompt contains answer");

  await m.shutdown(1000);
});

test("minimum budget check rejects send when question + options + answer together exceed limit", async () => {
  const c = controllable();
  const m = new TaskManager({
    runners: { ask: c.runner },
    traceBase: traceBase()
  });

  const t = m.start({ mode: "ask", prompt: "short prompt", ...sel });
  await c.runs[0].finish("Here is a question.\nQUESTION: Which option?\nOPTIONS: opt1 | opt2");

  const s1 = await m.status(t.taskId, 0);
  assert.equal(s1.state, "input_required");

  // Send an answer that fits within 20,000 chars alone (19,950 chars) but combined with question + options exceeds limit
  const bigAnswer = "b".repeat(19_950);
  await assert.rejects(
    m.send(t.taskId, bigAnswer),
    (e: unknown) => e instanceof ClineRunError && e.kind === "launch_failed"
  );

  // State remains input_required
  const s2 = await m.status(t.taskId, 0);
  assert.equal(s2.state, "input_required");

  await m.shutdown(1000);
});




