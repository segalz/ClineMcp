import assert from "node:assert/strict";
import "./git-test-serial.js";
import test, { after } from "node:test";
import { EventEmitter } from "node:events";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  runCline,
  ClineRunError,
  formatErrorAsText
} from "../runner.js";
import {
  createGuard,
  type GuardReport,
  type GuardVerdict
} from "../guard.js";
import {
  TaskManager,
  hintFor,
  type Task
} from "../tasks.js";
import { TraceRecorder } from "../trace.js";

const root = await mkdtemp(path.join(os.tmpdir(), "cline-guard-runner-test-"));
process.env.CLINE_MCP_STATUS_PATH = path.join(root, "status.json");
process.env.CLINE_PROVIDER_SETTINGS_PATH = path.join(root, "providers.json");
process.env.CLINE_MCP_CATALOG_PATH = path.join(root, "catalog.json");
process.env.CLINE_MCP_STATE_PATH = path.join(root, "state.json");
process.env.CLINE_MCP_TRACE_DIR = path.join(root, "traces");
after(() => rm(root, { recursive: true, force: true }));

let counter = 0;
const traceBase = () => path.join(root, `traces-${++counter}`);
const sel = { provider: "test-provider", model: "test-model" };
const editsRepo = path.join(root, "edits-repo");
await mkdir(editsRepo);
assert.equal(spawnSync(process.platform === "win32" ? "git.exe" : "git", ["-C", editsRepo, "init", "--quiet"], { windowsHide: true }).status, 0);

async function waitForWorkspaceRun(c: ReturnType<typeof controllable>) {
  const deadline = Date.now() + 5000;
  while (!c.runs.length) {
    assert.ok(Date.now() < deadline, "edits runner did not launch after lock acquisition");
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

function createMockChild() {
  const child = new EventEmitter() as any;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdout.destroyed = false;
  child.stderr.destroyed = false;
  child.stdout.destroy = () => {
    child.stdout.destroyed = true;
  };
  child.stderr.destroy = () => {
    child.stderr.destroyed = true;
  };
  child.killed = false;
  child.pid = 98765;
  child.kill = (sig?: NodeJS.Signals) => {
    child.killed = true;
    queueMicrotask(() => {
      child.emit("close", null, sig ?? "SIGKILL");
    });
  };
  return child;
}

/** Controllable runner for TaskManager testing */
function controllable() {
  const runs: Array<{
    finish: (text?: string) => Promise<void>;
    fail: (err: unknown) => Promise<void>;
    recorder: TraceRecorder;
    signal: AbortSignal;
    input: any;
    options: any;
  }> = [];

  const runner = (_input: any, signal: AbortSignal, options: any) =>
    new Promise<any>((resolve, reject) => {
      const recorder = new TraceRecorder({
        base: options.deps?.traceBase,
        runId: options.traceRunId,
        statusIntervalMs: 5
      });
      options.onTraceStart?.(recorder);
      recorder.attemptStarted(1);
      const run = {
        recorder,
        signal,
        input: _input,
        options,
        finish: async (text = "done") =>
          resolve({ text, durationMs: 1, trace: await recorder.finish({ ok: true }) }),
        fail: async (err: unknown) => {
          await recorder.finish({ ok: false });
          reject(err);
        }
      };
      signal.addEventListener(
        "abort",
        () => run.fail(new ClineRunError("cancelled", "The Cline request was cancelled.")),
        { once: true }
      );
      runs.push(run);
    });

  return { runs, runner };
}

test("runner: repeated edit failures trip loop guard, kill process once, attach report, no retry", async () => {
  let spawnCalls = 0;
  let killTreeCalls = 0;
  const tBase = traceBase();

  const mockSpawn = (_exe: string, _args: string[]) => {
    spawnCalls++;
    const child = createMockChild();

    queueMicrotask(() => {
      // Send 3 failing tool calls on the same target
      const events = [
        // 1st failure
        JSON.stringify({
          type: "agent_event",
          event: {
            type: "content_start",
            contentType: "tool",
            toolName: "replace_in_file",
            toolCallId: "c1",
            input: { path: "src/app.ts", diff: "- a\n+ b" }
          }
        }),
        JSON.stringify({
          type: "agent_event",
          event: {
            type: "content_end",
            contentType: "tool",
            toolName: "replace_in_file",
            toolCallId: "c1",
            error: "Pattern not found"
          }
        }),
        // Interleaved success on another file
        JSON.stringify({
          type: "agent_event",
          event: {
            type: "content_start",
            contentType: "tool",
            toolName: "read_file",
            toolCallId: "c2",
            input: { path: "package.json" }
          }
        }),
        JSON.stringify({
          type: "agent_event",
          event: {
            type: "content_end",
            contentType: "tool",
            toolName: "read_file",
            toolCallId: "c2",
            output: "{\"name\": \"app\"}"
          }
        }),
        // 2nd failure on src/app.ts
        JSON.stringify({
          type: "agent_event",
          event: {
            type: "content_start",
            contentType: "tool",
            toolName: "replace_in_file",
            toolCallId: "c3",
            input: { path: "src/app.ts", diff: "- a2\n+ b2" }
          }
        }),
        JSON.stringify({
          type: "agent_event",
          event: {
            type: "content_end",
            contentType: "tool",
            toolName: "replace_in_file",
            toolCallId: "c3",
            error: "Pattern still not found"
          }
        }),
        // 3rd failure on src/app.ts -> should trip the guard!
        JSON.stringify({
          type: "agent_event",
          event: {
            type: "content_start",
            contentType: "tool",
            toolName: "replace_in_file",
            toolCallId: "c4",
            input: { path: "src/app.ts", diff: "- a3\n+ b3" }
          }
        }),
        JSON.stringify({
          type: "agent_event",
          event: {
            type: "content_end",
            contentType: "tool",
            toolName: "replace_in_file",
            toolCallId: "c4",
            error: "Secret token=ghp_secretTokenVal123 pattern missing"
          }
        })
      ];

      child.stdout.emit("data", Buffer.from(events.join("\n") + "\n"));
    });

    return child;
  };

  const mockKillTree = (pid: number, sig?: NodeJS.Signals) => {
    killTreeCalls++;
    assert.equal(pid, 98765);
    assert.equal(sig, process.platform === "win32" ? "SIGKILL" : "SIGTERM");
  };

  let caughtError: any;
  try {
    await runCline(
      { ...sel, prompt: "test prompt" },
      undefined,
      {
        trace: true,
        maxAttempts: 2, // Verification: must NOT retry despite maxAttempts: 2
        deps: {
          spawn: mockSpawn as any,
          killTree: mockKillTree,
          entryPath: "fake/path/cline",
          traceBase: tBase,
          access: async () => {}
        }
      }
    );
  } catch (err) {
    caughtError = err;
  }

  // 1. Kind is loop_detected
  assert.ok(caughtError instanceof ClineRunError, "threw ClineRunError");
  assert.equal(caughtError.kind, "loop_detected");
  assert.equal(caughtError.attempts, 1, "never retried (attempts = 1)");
  assert.equal(spawnCalls, 1, "process spawned only once");
  assert.equal(killTreeCalls, 1, "killTree called exactly once");

  // 2. Short message formatted
  assert.match(caughtError.message, /Stopped by the bridge: 3 failed edits on src\/app\.ts within 10 tool calls/);

  // 3. Guard report attached
  const report = caughtError.guard as GuardReport;
  assert.ok(report, "guard report is attached");
  assert.equal(report.kind, "loop_detected");
  assert.equal(report.tool, "replace_in_file");
  assert.equal(report.target, "src/app.ts");
  assert.equal(report.count, 3);
  assert.equal(report.window, 10);
  assert.equal(report.totalToolCalls, 4);
  assert.equal(report.lastErrors.length, 3);
  // Redaction check: secret must be redacted
  assert.ok(!JSON.stringify(report).includes("ghp_secretTokenVal123"), "secret token must be redacted");
  assert.ok(JSON.stringify(report).includes("<redacted>"), "secret replaced with <redacted>");

  // 4. Trace has guard_trip marker event
  assert.ok(caughtError.trace, "trace info attached to error");
  const eventsContent = await readFile(caughtError.trace.events, "utf8");
  const traceLines = eventsContent.split(/\r?\n/).filter(Boolean).map(l => JSON.parse(l));
  const guardTripEvents = traceLines.filter(e => e.type === "guard_trip");
  assert.equal(guardTripEvents.length, 1, "exactly one guard_trip marker event in trace");
  assert.equal(guardTripEvents[0].kind, "loop_detected");
  assert.equal(guardTripEvents[0].report.target, "src/app.ts");

  // 5. formatErrorAsText includes Guard Report
  const formatted = formatErrorAsText(caughtError, "fallback");
  assert.ok(formatted.includes("Kind: loop_detected"));
  assert.ok(formatted.includes("Guard Report:"));
  assert.ok(formatted.includes('"target": "src/app.ts"'));
});

test("runner: budget_exceeded trips when maxToolCalls exceeded", async () => {
  let spawnCalls = 0;
  let killTreeCalls = 0;
  const tBase = traceBase();

  const mockSpawn = (_exe: string, _args: string[]) => {
    spawnCalls++;
    const child = createMockChild();

    queueMicrotask(() => {
      // Send 3 tool starts with maxToolCalls = 2
      const lines = [
        JSON.stringify({
          type: "agent_event",
          event: {
            type: "content_start",
            contentType: "tool",
            toolName: "read_file",
            toolCallId: "c1",
            input: { path: "file1.txt" }
          }
        }),
        JSON.stringify({
          type: "agent_event",
          event: {
            type: "content_end",
            contentType: "tool",
            toolName: "read_file",
            toolCallId: "c1",
            output: "ok"
          }
        }),
        JSON.stringify({
          type: "agent_event",
          event: {
            type: "content_start",
            contentType: "tool",
            toolName: "read_file",
            toolCallId: "c2",
            input: { path: "file2.txt" }
          }
        }),
        JSON.stringify({
          type: "agent_event",
          event: {
            type: "content_end",
            contentType: "tool",
            toolName: "read_file",
            toolCallId: "c2",
            output: "ok"
          }
        }),
        // 3rd tool call -> budget exceeded!
        JSON.stringify({
          type: "agent_event",
          event: {
            type: "content_start",
            contentType: "tool",
            toolName: "read_file",
            toolCallId: "c3",
            input: { path: "file3.txt" }
          }
        })
      ];
      child.stdout.emit("data", Buffer.from(lines.join("\n") + "\n"));
    });

    return child;
  };

  let caughtError: any;
  try {
    await runCline(
      { ...sel, prompt: "budget test" },
      undefined,
      {
        trace: true,
        guard: { maxToolCalls: 2 },
        deps: {
          spawn: mockSpawn as any,
          killTree: () => { killTreeCalls++; },
          entryPath: "fake/path/cline",
          traceBase: tBase,
          access: async () => {}
        }
      }
    );
  } catch (err) {
    caughtError = err;
  }

  assert.ok(caughtError instanceof ClineRunError);
  assert.equal(caughtError.kind, "budget_exceeded");
  assert.equal(caughtError.attempts, 1);
  assert.equal(spawnCalls, 1);
  assert.equal(killTreeCalls, 1);
  assert.match(caughtError.message, /tool-call budget exceeded/);
  assert.equal(caughtError.guard?.kind, "budget_exceeded");
  assert.equal(caughtError.guard?.totalToolCalls, 3);
});

test("tasks: hintFor maps loop_detected and budget_exceeded to crash with error text", () => {
  const dummyTrace = { runId: "r1", dir: "/tmp/d", events: "/tmp/e", status: "/tmp/s" };

  const taskLoop: Task = {
    id: "task-1",
    mode: "ask",
    state: "failed",
    startedAt: 1000,
    endedAt: 6000,
    activeMs: 5000,
    run: 1,
    runs: [dummyTrace],
    trace: dummyTrace,
    controller: new AbortController(),
    settled: Promise.resolve(),
    provider: "p",
    model: "m",
    originalPrompt: "prompt",
    qaHistory: [],
    error: new ClineRunError("loop_detected", "Stopped by the bridge: 3 failed edits on foo.ts within 10 tool calls", {
      attempts: 1
    })
  };

  const hintLoop = hintFor(taskLoop);
  assert.deepEqual(hintLoop, {
    ok: false,
    error_kind: "crash",
    error_text: "Stopped by the bridge: 3 failed edits on foo.ts within 10 tool calls",
    duration_s: 5
  });

  const taskBudget: Task = {
    ...taskLoop,
    error: new ClineRunError("budget_exceeded", "Stopped by the bridge: tool-call budget exceeded (151 > 150 tool calls)", {
      attempts: 1
    })
  };

  const hintBudget = hintFor(taskBudget);
  assert.deepEqual(hintBudget, {
    ok: false,
    error_kind: "crash",
    error_text: "Stopped by the bridge: tool-call budget exceeded (151 > 150 tool calls)",
    duration_s: 5
  });
});

test("tasks: run ending in loop_detected transitions to input_required with bridge question and history", async t => {
  const c = controllable();
  const m = new TaskManager({ runners: { workspace: c.runner }, traceBase: traceBase(), runOptions: { checkoutLockDirectory: path.join(root, "locks") } });
  t.after(() => m.shutdown());

  const started = m.start({
    mode: "workspace",
    prompt: "fix the bug in src/handler.ts",
    cwd: editsRepo,
    ...sel
  });
  assert.equal(started.state, "running");
  await waitForWorkspaceRun(c);

  const guardReport: GuardReport = {
    kind: "loop_detected",
    tool: "replace_in_file",
    target: "src/handler.ts",
    count: 3,
    window: 10,
    lastErrors: ["pattern mismatch 1", "pattern mismatch 2", "pattern mismatch 3"],
    totalToolCalls: 5,
    totalInputTokens: 12000,
    filesTouched: []
  };

  const runErr = new ClineRunError(
    "loop_detected",
    "Stopped by the bridge: 3 failed edits on src/handler.ts within 10 tool calls",
    { attempts: 1, guard: guardReport }
  );

  // Run 1 fails with guard trip
  await c.runs[0].fail(runErr);

  const status = await m.status(started.taskId, 10);
  assert.equal(status.state, "input_required", "task goes to input_required instead of failed");
  assert.ok(status.question, "task has bridge question");
  assert.equal(
    status.question.question,
    "QUESTION: Stopped by the bridge: 3 failed edits on src/handler.ts within 10 tool calls. How should it continue (a different approach, skip this target, or stop)?"
  );
  assert.deepEqual(status.question.options, ["a different approach", "skip this target", "stop"]);

  // Guard report and run history in status view
  assert.deepEqual(status.guard, guardReport);
  assert.ok(status.runHistory && status.runHistory.length === 1);
  assert.equal(status.runHistory[0].run, 1);
  assert.deepEqual(status.runHistory[0].guard, guardReport);
  assert.equal(status.runHistory[0].error, runErr.message);

  // cline_result keeps task in input_required state
  const res = await m.result(started.taskId);
  assert.equal(res.state, "input_required");
  assert.deepEqual(res.guard, guardReport);
  assert.equal(res.log_run_hint, null);

  // Task is preserved in TaskManager
  const statusAgain = await m.status(started.taskId, 0);
  assert.equal(statusAgain.state, "input_required");

  // cline_send resumes the task
  const sent = await m.send(started.taskId, "please skip this file and try src/utils.ts instead");
  assert.equal(sent.state, "running");
  assert.equal(sent.run, 2);
  assert.equal(c.runs.length, 2);

  // Verify the resumed prompt contains the "do not repeat" line
  const resumedPrompt = c.runs[1].input.prompt;
  assert.ok(
    resumedPrompt.includes(
      "Previous run was stopped by the bridge: 3 failed edits on src/handler.ts within 10 tool calls; do not repeat the same failing action."
    ),
    "resumed prompt contains bridge warning"
  );
  assert.ok(resumedPrompt.includes("please skip this file and try src/utils.ts instead"), "contains answer");

  // Run 2 completes successfully
  await c.runs[1].finish("Fixed using src/utils.ts");
  const finalStatus = await m.status(started.taskId, 0);
  assert.equal(finalStatus.state, "done");
  assert.equal(finalStatus.run, 2);
  assert.equal(finalStatus.guard, undefined, "cleared guard on success");

  const finalRes = await m.result(started.taskId);
  assert.equal(finalRes.state, "done");
  assert.equal((finalRes.result as any).text, "Fixed using src/utils.ts");
  assert.equal(finalRes.log_run_hint?.ok, true);
});

test("tasks: second trip in resumed run stops in input_required again without auto-resume", async () => {
  const c = controllable();
  const m = new TaskManager({ runners: { ask: c.runner }, traceBase: traceBase() });

  const started = m.start({
    mode: "ask",
    prompt: "first prompt",
    ...sel
  });

  const trip1Report: GuardReport = {
    kind: "loop_detected",
    tool: "search",
    target: "needle",
    count: 3,
    window: 10,
    lastErrors: ["no match", "no match", "no match"],
    totalToolCalls: 3,
    totalInputTokens: 5000,
    filesTouched: []
  };

  // Run 1 trips
  await c.runs[0].fail(
    new ClineRunError("loop_detected", "Stopped by the bridge: 3 failed search calls on needle within 10 tool calls", {
      guard: trip1Report
    })
  );

  const s1 = await m.status(started.taskId, 0);
  assert.equal(s1.state, "input_required");
  assert.equal(
    s1.question?.question,
    "QUESTION: Stopped by the bridge: 3 failed search calls on needle within 10 tool calls. How should it continue (a different approach, skip this target, or stop)?"
  );
  assert.deepEqual(s1.question?.options, ["a different approach", "skip this target", "stop"]);

  // Resume with cline_send
  await m.send(started.taskId, "try searching for alternative needle");
  assert.equal(c.runs.length, 2);

  const trip2Report: GuardReport = {
    kind: "budget_exceeded",
    window: 10,
    lastErrors: [],
    totalToolCalls: 151,
    totalInputTokens: 50000,
    filesTouched: []
  };

  // Run 2 also trips (budget_exceeded)
  await c.runs[1].fail(
    new ClineRunError("budget_exceeded", "Stopped by the bridge: tool-call budget exceeded (151 > 150 tool calls)", {
      guard: trip2Report
    })
  );

  const s2 = await m.status(started.taskId, 0);
  assert.equal(s2.state, "input_required", "second trip also goes to input_required");
  assert.equal(
    s2.question?.question,
    "QUESTION: Stopped by the bridge: tool-call budget exceeded (151 > 150 tool calls). How should it continue (a narrower scope, or stop)?"
  );
  assert.deepEqual(s2.question?.options, ["a narrower scope", "stop"]);
  assert.deepEqual(s2.guard, trip2Report);
  assert.equal(s2.runHistory?.length, 2);
  assert.equal(s2.runHistory[0].run, 1);
  assert.equal(s2.runHistory[1].run, 2);
  assert.deepEqual(s2.runHistory[1].guard, trip2Report);

  // Third run finishes normally
  await m.send(started.taskId, "stop searching, summarize results");
  assert.equal(c.runs.length, 3);
  await c.runs[2].finish("Summary of search");

  const s3 = await m.status(started.taskId, 0);
  assert.equal(s3.state, "done");
  assert.equal(s3.run, 3);
});

test("tasks: normal task run completes untouched", async () => {
  const c = controllable();
  const m = new TaskManager({ runners: { ask: c.runner }, traceBase: traceBase() });

  const started = m.start({ mode: "ask", prompt: "clean run", ...sel });
  await c.runs[0].finish("All clean without trips.");

  const s = await m.status(started.taskId, 0);
  assert.equal(s.state, "done");
  assert.equal(s.guard, undefined);
  assert.equal(s.runHistory?.length, 1);
  assert.equal(s.runHistory[0].run, 1);
  assert.equal(s.runHistory[0].guard, undefined);

  const r = await m.result(started.taskId);
  assert.equal(r.state, "done");
  assert.equal(r.log_run_hint?.ok, true);
  assert.equal((r.result as any).text, "All clean without trips.");
});

test("P2 resume content: resumed context includes tool + target, last errors (<=3x200), files touched, and last assistant text (<=400)", async t => {
  const c = controllable();
  const m = new TaskManager({ runners: { workspace: c.runner }, traceBase: traceBase(), runOptions: { checkoutLockDirectory: path.join(root, "locks") } });
  t.after(() => m.shutdown());

  const started = m.start({
    mode: "workspace",
    prompt: "update server endpoint",
    cwd: editsRepo,
    ...sel
  });

  await waitForWorkspaceRun(c);

  const tripReport: GuardReport = {
    kind: "loop_detected",
    tool: "apply_patch",
    target: "src/server.ts",
    count: 3,
    window: 10,
    lastErrors: [
      "Hunk #1 failed at 45 (context mismatch)",
      "Hunk #2 failed at 55 (missing delimiter)",
      "Hunk #3 failed at 65 (unexpected token)"
    ],
    totalToolCalls: 5,
    totalInputTokens: 8000,
    filesTouched: ["src/server.ts", "package.json"],
    lastAssistantText: "I tried applying the diff directly to src/server.ts using apply_patch."
  };

  await c.runs[0].fail(
    new ClineRunError("loop_detected", "Stopped by the bridge: 3 failed edits on src/server.ts within 10 tool calls", {
      guard: tripReport
    })
  );

  const status = await m.status(started.taskId, 10);
  assert.equal(status.state, "input_required");
  assert.equal(status.guard?.lastAssistantText, "I tried applying the diff directly to src/server.ts using apply_patch.");

  // Resume the task
  await m.send(started.taskId, "switch to write_to_file and rewrite the file completely");
  assert.equal(c.runs.length, 2);

  const resumedPrompt = c.runs[1].input.prompt;
  assert.ok(resumedPrompt.includes("Previous run was stopped by the bridge:"), "includes guard notice");
  assert.ok(resumedPrompt.includes("Guard report:"), "includes guard report section");
  assert.ok(resumedPrompt.includes("tool: apply_patch"), "includes tool");
  assert.ok(resumedPrompt.includes("target: src/server.ts"), "includes target");
  assert.ok(resumedPrompt.includes("Hunk #1 failed at 45"), "includes error 1");
  assert.ok(resumedPrompt.includes("Hunk #2 failed at 55"), "includes error 2");
  assert.ok(resumedPrompt.includes("Hunk #3 failed at 65"), "includes error 3");
  assert.ok(resumedPrompt.includes("src/server.ts, package.json"), "includes files touched");
  assert.ok(
    resumedPrompt.includes("I tried applying the diff directly to src/server.ts using apply_patch."),
    "includes last assistant text excerpt"
  );
});

test("P2 resume budget: reserves room for guard notice in minimum check and compacts guard report when prompt is tight", async () => {
  const c = controllable();
  const m = new TaskManager({ runners: { ask: c.runner }, traceBase: traceBase() });

  // Start with a large original prompt
  const started = m.start({
    mode: "ask",
    prompt: "A".repeat(19_000),
    ...sel
  });

  const tripReport: GuardReport = {
    kind: "loop_detected",
    tool: "replace_in_file",
    target: "src/big.ts",
    count: 3,
    window: 10,
    lastErrors: [
      "E".repeat(180),
      "F".repeat(180),
      "G".repeat(180)
    ],
    totalToolCalls: 10,
    totalInputTokens: 50_000,
    filesTouched: ["src/big.ts"],
    lastAssistantText: "T".repeat(350)
  };

  await c.runs[0].fail(
    new ClineRunError("loop_detected", "Stopped by the bridge: 3 failed edits on src/big.ts within 10 tool calls", {
      guard: tripReport
    })
  );

  // Send answer of moderate size that, together with 19,000 prompt + full guard report, would exceed 20,000
  // buildResumedPrompt must compact the prompt and guard context instead of throwing launch_failed!
  await m.send(started.taskId, "continue with plan B");
  assert.equal(c.runs.length, 2);

  const resumedPrompt = c.runs[1].input.prompt;
  assert.ok(resumedPrompt.length <= 20_000, "resumed prompt fits within 20,000 limit");
  assert.ok(resumedPrompt.includes("Previous run was stopped by the bridge:"), "includes mandatory notice");
  assert.ok(resumedPrompt.includes("continue with plan B"), "includes caller answer");

  // Rejection when latestQA + reserved room for guard notice exceeds 20,000
  const started2 = m.start({ mode: "ask", prompt: "prompt2", ...sel });
  await c.runs[2].fail(
    new ClineRunError("loop_detected", "Stopped by the bridge: 3 failed edits on foo.ts within 10 tool calls", {
      guard: tripReport
    })
  );
  // Answer that alone is 19,950 chars (with question + mandatory notice > 20,000)
  await assert.rejects(
    m.send(started2.taskId, "X".repeat(19_950)),
    (e: unknown) => e instanceof ClineRunError && e.kind === "launch_failed",
    "rejects upfront because room for mandatory guard notice was reserved"
  );
});
