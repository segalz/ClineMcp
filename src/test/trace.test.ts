import assert from "node:assert/strict";
import test, { after } from "node:test";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { LineSplitter, TraceRecorder, cleanupTraces, reduceEvent, redactValue, type TraceStatus } from "../trace.js";
import { ClineRunError, formatErrorAsText, runCline } from "../runner.js";

const root = await mkdtemp(path.join(os.tmpdir(), "cline-trace-"));
process.env.CLINE_MCP_STATUS_PATH = path.join(root, "provider-status.json");
process.env.CLINE_PROVIDER_SETTINGS_PATH = path.join(root, "providers.json");
after(() => rm(root, { recursive: true, force: true }));
let counter = 0;
const base = () => path.join(root, `base-${++counter}`);
const agent = (event: Record<string, unknown>) => ({ type: "agent_event", event });
const lines = async (file: string) => (await readFile(file, "utf8")).trim().split("\n").map(l => JSON.parse(l));

test("line splitter decodes UTF-8 across chunks, strips CR and flushes the remainder", () => {
  const out: string[] = [];
  const s = new LineSplitter(l => out.push(l));
  const bytes = Buffer.from("שלום\r\nsecond\nthird");
  s.push(bytes.subarray(0, 3)); // splits the second Hebrew character
  s.push(bytes.subarray(3));
  assert.deepEqual(out, ["שלום", "second"]);
  s.flush();
  assert.deepEqual(out, ["שלום", "second", "third"]);
});

test("reducer builds live status from Cline 3.0.74 event shapes", () => {
  const status = { runId: "r", pid: 1, state: "running", startedAt: "", updatedAt: "", elapsedMs: 0, attempt: 1, iteration: 0,
    toolCalls: 0, files: [], eventsWritten: 0, eventsDropped: 0 } as TraceStatus;
  const scratch = { reasoning: "", text: "" };
  reduceEvent(status, scratch, { type: "hook_event", hookEventName: "agent_start", taskId: "conv_1" });
  reduceEvent(status, scratch, agent({ type: "iteration_start", iteration: 2 }));
  reduceEvent(status, scratch, agent({ type: "content_start", contentType: "reasoning", reasoning: "Let me " }));
  reduceEvent(status, scratch, agent({ type: "content_start", contentType: "reasoning", reasoning: "read the file" }));
  assert.equal(status.lastReasoning, undefined, "partial deltas never become a snippet");
  assert.equal(status.streamingChars, 20);
  reduceEvent(status, scratch, agent({ type: "content_end", contentType: "reasoning", reasoning: "Let me read the file" }));
  assert.equal(status.lastReasoning, "Let me read the file");
  assert.equal(status.streamingChars, 0);
  reduceEvent(status, scratch, agent({ type: "content_start", contentType: "tool", toolName: "read_files", input: { files: [{ path: "src/a.ts" }] } }));
  reduceEvent(status, scratch, agent({ type: "content_start", contentType: "tool", toolName: "run_commands", input: { commands: ["ls", "pwd"] } }));
  reduceEvent(status, scratch, agent({ type: "content_start", contentType: "tool", toolName: "ask_question",
    input: { question: "Which language?", options: ["Python", "Go"] } }));
  reduceEvent(status, scratch, agent({ type: "content_end", contentType: "tool", toolName: "ask_question", output: "Python" }));
  assert.equal(status.clineTaskId, "conv_1");
  assert.equal(status.iteration, 2);
  assert.equal(status.toolCalls, 3);
  assert.deepEqual(status.files, ["src/a.ts"]);
  assert.deepEqual(status.currentTool, { name: "ask_question", target: "Which language?" });
  assert.deepEqual(status.question, { question: "Which language?", options: ["Python", "Go"], autoAnswer: "Python" });
  reduceEvent(status, scratch, agent({ type: "iteration_start", iteration: 3 }));
  assert.equal(status.currentTool, undefined);
});

test("a sensitive key redacts its whole subtree, whatever the value type", () => {
  const out = JSON.stringify(redactValue({ key: "hunter2", password: 123456, credentials: { value: "hunter2", n: 7 }, ok: "visible" }));
  assert.ok(!out.includes("hunter2") && !out.includes("123456"), out);
  assert.ok(out.includes("visible"));
});

test("an oversized line delivered in one chunk is dropped too", () => {
  const out: string[] = [];
  let oversized = 0;
  const s = new LineSplitter(l => out.push(l), () => oversized++);
  s.push("x".repeat(600_000));
  s.push("y".repeat(500_000) + "\nnext\n");
  s.push("z".repeat(1_100_000));
  s.flush();
  assert.deepEqual(out, ["next"]);
  assert.equal(oversized, 2);
});

test("redaction works on decoded values, including sensitive keys and escaped content", () => {
  const event = JSON.parse(JSON.stringify({ apiKey: "plain-value", nested: { text: "token is \"sk-abcdefghijklmnopqrstuvwx\" ok" } }));
  const out = JSON.stringify(redactValue(event));
  assert.ok(!out.includes("plain-value"));
  assert.ok(!out.includes("sk-abcdefghijklmnopqrstuvwx"));
});

test("recorder persists events in order with attempt numbers, skips deltas, and writes a final status", async () => {
  const rec = new TraceRecorder({ base: base(), statusIntervalMs: 5 });
  rec.attemptStarted(1);
  rec.line(JSON.stringify({ type: "hook_event", taskId: "conv_9" }), 1);
  rec.line(JSON.stringify(agent({ type: "content_start", contentType: "reasoning", reasoning: "secret sk-abcdefghijklmnopqrstuvwx" })), 1);
  rec.line(JSON.stringify(agent({ type: "content_end", contentType: "reasoning", reasoning: "full sk-abcdefghijklmnopqrstuvwx thought" })), 1);
  rec.line("not json at all", 1);
  rec.line("", 1);
  const info = await rec.finish({ ok: true });
  assert.deepEqual(await rec.finish({ ok: false }), info, "finish is idempotent");
  const events = await lines(info.events);
  assert.equal(events.length, 3, "the reasoning delta and the empty line are not persisted");
  assert.deepEqual(events.map(e => e.attempt), [1, 1, 1]);
  assert.equal(events[2].type, "raw");
  const raw = await readFile(info.events, "utf8");
  assert.ok(!raw.includes("sk-abcdefghijklmnopqrstuvwx"));
  const status = JSON.parse(await readFile(info.status, "utf8"));
  assert.equal(status.state, "done");
  assert.equal(status.clineTaskId, "conv_9");
  assert.equal(status.eventsWritten, 3);
  assert.ok(!status.lastReasoning.includes("sk-abcdefghijklmnopqrstuvwx"));
});

test("a secret split across streaming deltas never reaches the status or event file", async () => {
  const rec = new TraceRecorder({ base: base(), statusIntervalMs: 1 });
  rec.line(JSON.stringify(agent({ type: "content_start", contentType: "reasoning", reasoning: 'config {"password":"hunter2' })), 1);
  await new Promise(r => setTimeout(r, 30)); // a status write happens before the closing quote arrives
  const mid = await readFile(rec.info.status, "utf8");
  assert.ok(!mid.includes("hunter2"), "status written mid-block must not contain the partial secret");
  rec.line(JSON.stringify(agent({ type: "content_start", contentType: "reasoning", reasoning: '"} done' })), 1);
  rec.line(JSON.stringify(agent({ type: "content_end", contentType: "reasoning", reasoning: 'config {"password":"hunter2"} done' })), 1);
  const info = await rec.finish({ ok: true });
  assert.ok(!(await readFile(info.status, "utf8")).includes("hunter2"));
  assert.ok(!(await readFile(info.events, "utf8")).includes("hunter2"));
});

test("an oversized line is dropped with a marker; its content never reaches the file", async () => {
  const rec = new TraceRecorder({ base: base() });
  const forwarded: string[] = [];
  const splitter = new LineSplitter(l => { forwarded.push(l); rec.line(l, 1); }, () => rec.oversizedLine(1));
  const secretDelta = JSON.stringify(agent({ type: "content_start", contentType: "reasoning",
    reasoning: '{"password":"hunter2"} ' + "x".repeat(1_100_000) }));
  splitter.push(secretDelta.slice(0, 600_000));
  splitter.push(secretDelta.slice(600_000)); // buffer passes the cap here, before the newline
  splitter.push("\n" + JSON.stringify({ type: "run_result", text: "ok" }) + "\n");
  splitter.flush();
  assert.deepEqual(forwarded, [JSON.stringify({ type: "run_result", text: "ok" })], "the tail of the oversized line is not forwarded");
  const info = await rec.finish({ ok: true });
  const file = await readFile(info.events, "utf8");
  assert.ok(!file.includes("hunter2"));
  assert.deepEqual((await lines(info.events)).map(e => e.type), ["oversized_line_dropped", "run_result"]);
});

test("a cut-off JSON fragment is recorded only by size, never raw", async () => {
  const rec = new TraceRecorder({ base: base() });
  rec.line('{"type":"agent_event","event":{"type":"content_start","reasoning":"{\\"password\\":\\"hunter2', 1);
  rec.line("plain text line", 1);
  const info = await rec.finish({ ok: true });
  assert.ok(!(await readFile(info.events, "utf8")).includes("hunter2"));
  assert.deepEqual((await lines(info.events)).map(e => e.type), ["unparsed_line_dropped", "raw"]);
});

test("error notes are shown with the error", () => {
  const err = new ClineRunError("timeout", "slow");
  err.notes = ["The temporary worktree X could not be removed: busy"];
  assert.match(formatErrorAsText(err, ""), /Note: The temporary worktree X could not be removed/);
});

test("deeply nested events never throw out of the recorder", async () => {
  const rec = new TraceRecorder({ base: base() });
  const deep = "[".repeat(5000) + "]".repeat(5000);
  assert.doesNotThrow(() => rec.line(deep, 1));
  assert.doesNotThrow(() => rec.line(JSON.stringify({ type: "x", v: JSON.parse("[".repeat(2000) + "1" + "]".repeat(2000)) }), 1));
  const info = await rec.finish({ ok: true });
  assert.equal(JSON.parse(await readFile(info.status, "utf8")).state, "done");
});

test("a stalled disk does not hold finish beyond its wait", async () => {
  const rec = new TraceRecorder({ base: base(), finishWaitMs: 50, appendFile: (() => new Promise(() => {})) as any });
  rec.line(JSON.stringify({ type: "run_result", text: "ok" }), 1);
  const started = Date.now();
  await rec.finish({ ok: true });
  assert.ok(Date.now() - started < 1000);
});

test("recorder caps the event file and counts dropped events", async () => {
  const rec = new TraceRecorder({ base: base(), maxEventBytes: 300 });
  for (let i = 0; i < 20; i++) rec.line(JSON.stringify(agent({ type: "iteration_start", iteration: i })), 1);
  const info = await rec.finish({ ok: true });
  const status = JSON.parse(await readFile(info.status, "utf8"));
  assert.ok(status.eventsDropped > 0);
  assert.ok((await readFile(info.events, "utf8")).length <= 300);
  assert.equal(status.eventsWritten + status.eventsDropped, 20);
});

function mockChild(stdoutChunks: string[], code: number) {
  const child = new EventEmitter() as any;
  child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.kill = () => {}; child.pid = 4242;
  queueMicrotask(() => { for (const c of stdoutChunks) child.stdout.emit("data", Buffer.from(c)); child.emit("close", code); });
  return child;
}

test("runCline with trace returns its location; a failed run attaches the trace to the error", async () => {
  const traceBase = base();
  const ok = await runCline({ prompt: "x", provider: "p", model: "m" }, undefined, { trace: true, maxAttempts: 1, deps: {
    entryPath: "fake", access: async () => {}, traceBase, acquireSettingsMutex: async () => async () => {},
    spawn: (() => mockChild([
      JSON.stringify(agent({ type: "iteration_start", iteration: 1 })) + "\n" + '{"type":"run_res',
      'ult","finishReason":"completed","text":"done"}'
    ], 0)) as any
  } });
  assert.equal(ok.text, "done");
  assert.ok(ok.trace);
  const events = await lines(ok.trace!.events);
  assert.deepEqual(events.map(e => e.type), ["agent_event", "run_result"], "a line split across chunks is joined");
  assert.equal(JSON.parse(await readFile(ok.trace!.status, "utf8")).state, "done");

  await assert.rejects(runCline({ prompt: "x", provider: "p", model: "m" }, undefined, { trace: true, maxAttempts: 1, deps: {
    entryPath: "fake", access: async () => {}, traceBase, acquireSettingsMutex: async () => async () => {},
    spawn: (() => mockChild([JSON.stringify({ type: "error", message: "boom" }) + "\n"], 1)) as any
  } }), (err: unknown) => {
    assert.ok(err instanceof ClineRunError && err.trace);
    assert.match(formatErrorAsText(err, ""), /Trace: /);
    return true;
  });
  const dirs = await readdir(traceBase);
  assert.equal(dirs.length, 2);
});

test("a retried run records both attempts in order with their attempt numbers", async () => {
  let calls = 0;
  const result = await runCline({ prompt: "x", provider: "p", model: "m" }, undefined, { trace: true, deps: {
    entryPath: "fake", access: async () => {}, traceBase: base(), backoffMs: 0, acquireSettingsMutex: async () => async () => {},
    spawn: (() => ++calls === 1
      ? mockChild([JSON.stringify(agent({ type: "iteration_start", iteration: 1 })) + "\n" +
          JSON.stringify({ type: "run_result", finishReason: "error", text: "Service temporarily overloaded" }) + "\n"], 1)
      : mockChild([JSON.stringify(agent({ type: "iteration_start", iteration: 1 })) + "\n" +
          JSON.stringify({ type: "run_result", finishReason: "completed", text: "ok" }) + "\n"], 0)) as any
  } });
  assert.equal(calls, 2);
  const events = await lines(result.trace!.events);
  assert.deepEqual(events.map(e => [e.attempt, e.type, e.finishReason ?? ""]), [
    [1, "agent_event", ""], [1, "run_result", "error"], [2, "agent_event", ""], [2, "run_result", "completed"]]);
  assert.equal(JSON.parse(await readFile(result.trace!.status, "utf8")).attempt, 2);
});

test("a new attempt resets the Cline task id and step counter in the status", async () => {
  const rec = new TraceRecorder({ base: base() });
  rec.attemptStarted(1);
  rec.line(JSON.stringify({ type: "hook_event", taskId: "task-A" }), 1);
  rec.line(JSON.stringify(agent({ type: "iteration_start", iteration: 3 })), 1);
  rec.attemptStarted(2);
  rec.line(JSON.stringify({ type: "hook_event", taskId: "task-B" }), 2);
  const s = rec.snapshot();
  assert.equal(s.clineTaskId, "task-B");
  assert.equal(s.iteration, 0);
  await rec.finish({ ok: true });
});

test("a plain (untyped) error during a traced run still carries and shows the trace", async () => {
  await assert.rejects(runCline({ prompt: "x", provider: "p", model: "m" }, undefined, { trace: true, maxAttempts: 1, deps: {
    entryPath: "fake", access: async () => {}, traceBase: base(),
    acquireSettingsMutex: async () => { throw new Error("socket refused"); }
  } }), (err: unknown) => {
    assert.ok(!(err instanceof ClineRunError));
    assert.ok((err as any).trace?.dir);
    assert.match(formatErrorAsText(err, ""), /socket refused\n\nTrace: /);
    return true;
  });
});

test("runCline without trace writes nothing", async () => {
  const traceBase = base();
  await runCline({ prompt: "x", provider: "p", model: "m" }, undefined, { maxAttempts: 1, deps: {
    entryPath: "fake", access: async () => {}, traceBase, acquireSettingsMutex: async () => async () => {},
    spawn: (() => mockChild(['{"type":"run_result","finishReason":"completed","text":"ok"}\n'], 0)) as any
  } });
  await assert.rejects(readdir(traceBase), { code: "ENOENT" });
});

test("cleanup removes stale and orphaned traces and keeps live and recent ones", async () => {
  const b = base();
  const now = Date.parse("2026-11-10T12:00:00Z");
  const hour = 3_600_000;
  const make = async (name: string, status: object | string) => {
    await mkdir(path.join(b, name), { recursive: true });
    await writeFile(path.join(b, name, "status.json"), typeof status === "string" ? status : JSON.stringify(status));
  };
  const at = (ms: number) => new Date(ms).toISOString();
  await make("done-old-0001", { state: "done", pid: 1, updatedAt: at(now - 25 * hour) });
  await make("done-new-0002", { state: "done", pid: 1, updatedAt: at(now - hour) });
  await make("orphan-0003", { state: "running", pid: 111, updatedAt: at(now - 60_000) });
  await make("live-0004", { state: "running", pid: 222, updatedAt: at(now - 60_000) });
  await make("reused-pid-0005", { state: "running", pid: 222, updatedAt: at(now - 8 * 24 * hour) });
  await make("asleep-0007", { state: "running", pid: 222, updatedAt: at(now - 25 * hour) });
  await make("unreadable-0006", "{broken");
  await mkdir(path.join(b, "weird name!"), { recursive: true });
  const { removed } = await cleanupTraces({ base: b, wallNow: () => now, isProcessAlive: pid => pid === 222 });
  assert.deepEqual(removed.sort(), ["done-old-0001", "orphan-0003", "reused-pid-0005"]);
  assert.deepEqual((await readdir(b)).sort(), ["asleep-0007", "done-new-0002", "live-0004", "unreadable-0006", "weird name!"],
    "a live PID silent for a day (machine asleep) is kept; only a week of silence counts as PID reuse");
});
