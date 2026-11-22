import "./heavy-test-dir.js";
import assert from "node:assert/strict";
import childProcess, { type SpawnOptions } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import test, { after } from "node:test";
import { applyClineEdits } from "../edits.js";
import { askCline, ClineRunError, type ClineInvocationOptions } from "../runner.js";
import { TaskManager, type TaskManagerDeps } from "../tasks.js";
import { askClineWorkspace } from "../workspace.js";

const base = await mkdtemp(path.join(os.tmpdir(), "cline-s16-"));
process.env.CLINE_MCP_SNAPSHOT_DIR = path.join(base, "snapshots");
after(() => rm(base, { recursive: true, force: true, maxRetries: 5 }));

function childWithOutput(output: string, code = 0) {
  const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() });
  queueMicrotask(() => { child.stdout.end(output); child.emit("close", code); });
  return child;
}

// Only the checkout identity matters here. Keep Git, Cline and hub I/O out of these tests.
function mockCheckout(t: test.TestContext, root: string) {
  const spawn = childProcess.spawn;
  const stub = t.mock.method(childProcess, "spawn", (file: string, args: string[], options: SpawnOptions) => {
    if (!/^git(?:\.exe)?$/i.test(path.basename(file))) return spawn(file, args, options);
    const [, , command, arg, value] = args;
    if (command === "rev-parse") {
      return childWithOutput(arg === "--show-toplevel" ? root : arg === "--git-path" ? path.join(".git", value) : "a".repeat(40));
    }
    if (command === "worktree" && arg === "add") mkdirSync(args[5]);
    else assert.ok(["worktree", "ls-files", "diff", "--no-optional-locks", "check-ignore", "status"].includes(command), args.join(" "));
    return childWithOutput("");
  });
  syncBuiltinESMExports();
  t.after(() => { stub.mock.restore(); syncBuiltinESMExports(); });
}

async function fixture(t: test.TestContext) {
  const root = await mkdtemp(path.join(base, "repo-")), cwd = path.join(root, "pkg");
  await mkdir(cwd);
  mockCheckout(t, root);
  const events: string[] = [];
  const launches: Array<{ port?: string; discovery?: string; cwd?: string | URL; cliCwd: string }> = [];
  const live = new Set<number>();
  const hooks: { onRun?: (n: number) => void; onStop?: () => Promise<void>; failRun?: number; output?: (n: number) => string } = {};
  let starts = 0;
  const spawn = ((_file: string, args: string[], options: SpawnOptions) => {
    const port = options.env?.CLINE_HUB_PORT, discovery = options.env?.CLINE_HUB_DISCOVERY_PATH;
    const id = Number(port) - 14000;
    launches.push({ port, discovery, cwd: options.cwd, cliCwd: args[args.indexOf("--cwd") + 1] });
    events.push("run " + id); live.add(id); hooks.onRun?.(launches.length);
    if (hooks.failRun === launches.length) return childWithOutput("", 1);
    return childWithOutput((hooks.output?.(launches.length) ?? "") + '{"type":"run_result","finishReason":"completed","text":"done"}\n');
  }) as unknown as typeof childProcess.spawn;
  const deps = {
    entryPath: "fake-cline", access: async () => {}, providerSettingsPath: path.join(root, "providers.json"),
    acquireSettingsMutex: async () => async () => {}, statusPath: null, spawn,
    startHub: async () => {
      const id = ++starts;
      events.push("start " + id);
      return {
        env: { CLINE_HUB_PORT: String(14000 + id), CLINE_HUB_DISCOVERY_PATH: path.join(base, "hub-" + id + ".json") },
        isListening: async () => live.has(id),
        stop: async () => { await hooks.onStop?.(); live.delete(id); events.push("stop " + id); }
      };
    }
  };
  const options: ClineInvocationOptions = { deps, checkoutLockDirectory: path.join(base, "locks"), recordStatus: false, respectQuotaLock: false };
  const input = { cwd, prompt: "Implement", provider: "p", model: "m", codeMap: false, maxFixRuns: 2,
    verify: { command: process.execPath, args: ["-e", "process.exit(require('fs').existsSync('ready') ? 0 : 1)"] } };
  const manager = (runVerification: NonNullable<TaskManagerDeps["runVerification"]>) =>
    new TaskManager({ traceBase: path.join(base, "traces"), runOptions: options, runVerification });
  return { root, cwd, hooks, events, launches, live, deps, options, input, manager };
}

function check(passed: boolean) {
  return { passed, exitCode: passed ? 0 : 1, signal: null, timedOut: false, killedForOutput: false, durationMs: 1, stdoutTail: "", stderrTail: "" };
}

function gate() {
  let open!: () => void;
  const promise = new Promise<void>(resolve => { open = resolve; });
  return { open, promise };
}

test("S16: a refused sync edit starts nothing; a launched edit and two fixes share one hub and cwd", async t => {
  const f = await fixture(t);
  await assert.rejects(applyClineEdits(f.input, undefined, { ...f.options, deps: { ...f.deps, access: async file => {
    if (file === f.deps.entryPath) throw new Error("entry missing");
  } } }), { kind: "cline_updating" });
  assert.deepEqual(f.events, []);

  f.hooks.onRun = n => { if (n === 3) writeFileSync(path.join(f.cwd, "ready"), "yes"); };
  const jobEvents: string[] = [];
  const deps = { ...f.deps, platform: "win32" as const, createWindowsJob: async () => {
    jobEvents.push("open");
    const job = { alive: true, assigned: false, assign() {}, close: async () => {
      if (job.alive) jobEvents.push("closed after " + f.events.at(-1));
      job.alive = false;
    } };
    return job;
  } };
  const result = await applyClineEdits(f.input, undefined, { ...f.options, deps });
  assert.equal(result.verification.passed, true);
  assert.equal(result.verification.fixRuns, 2);
  assert.deepEqual(f.events, ["start 1", "run 1", "run 1", "run 1", "stop 1"]);
  const launch = { port: "14001", discovery: path.join(base, "hub-1.json"), cwd: f.cwd, cliCwd: f.cwd };
  assert.deepEqual(f.launches, [launch, launch, launch]);
  assert.deepEqual(jobEvents, ["open", "closed after stop 1"]);
});

test("S16: exhausted async fixes stop before publishing the wait; manual retry uses a fresh hub", async t => {
  const f = await fixture(t), stopping = gate(), finishStop = gate();
  let checks = 0;
  const manager = f.manager(async () => { f.events.push("check"); return check(++checks === 3); });
  f.hooks.onStop = async () => { if (f.launches.length === 2) { stopping.open(); await finishStop.promise; } };
  const { taskId } = manager.start({ ...f.input, mode: "edits", maxFixRuns: 1 });
  try {
    await Promise.race([stopping.promise, manager.status(taskId, 30).then(s => { throw new Error("Expected pending stop, got " + s.state); })]);
    const duringStop = await manager.status(taskId);
    assert.equal(duringStop.state, "running");
    assert.notEqual(duringStop.phase, "waiting");
    finishStop.open();
    const waiting = await manager.status(taskId, 30);
    assert.equal(waiting.state, "input_required");
    assert.equal(waiting.waitReason, "verify_failed");
    assert.equal(f.live.size, 0);
    await manager.send(taskId, "Retry the check", "retry");
    assert.equal((await manager.status(taskId, 30)).state, "done");
    assert.deepEqual(f.events, ["start 1", "run 1", "check", "run 1", "check", "stop 1", "start 2", "run 2", "check", "stop 2"]);
    assert.notEqual(f.launches[1].discovery, f.launches[2].discovery);
  } finally { finishStop.open(); await manager.shutdown(); }
});

test("S16: a dead hub is cleaned up and the remaining automatic fixes share its replacement", async t => {
  const f = await fixture(t);
  const manager = f.manager(async () => {
    if (f.launches.length === 1) { f.live.clear(); f.events.push("hub died"); }
    return check(f.launches.length === 3);
  });
  const { taskId } = manager.start({ ...f.input, mode: "edits" });
  try {
    assert.equal((await manager.status(taskId, 30)).state, "done");
    assert.deepEqual(f.events, ["start 1", "run 1", "hub died", "stop 1", "start 2", "run 2", "run 2", "stop 2"]);
    assert.notEqual(f.launches[0].discovery, f.launches[1].discovery);
    assert.deepEqual(f.launches[1], f.launches[2]);
  } finally { await manager.shutdown(); }
});

test("S16: ask and workspace each own their hub while an edit reuses its hub across checks", async t => {
  const f = await fixture(t);
  let checks = 0;
  const manager = f.manager(async () => {
    await askCline(f.input, undefined, f.options);
    await askClineWorkspace({ ...f.input, cwd: f.root }, undefined, f.options);
    return check(++checks === 2);
  });
  const { taskId } = manager.start({ ...f.input, mode: "edits" });
  try {
    assert.equal((await manager.status(taskId, 30)).state, "done");
    assert.deepEqual(f.events, ["start 1", "run 1", "start 2", "run 2", "stop 2", "start 3", "run 3", "stop 3",
      "run 1", "start 4", "run 4", "stop 4", "start 5", "run 5", "stop 5", "stop 1"]);
    assert.deepEqual(f.launches[0], f.launches[3]);
    assert.notEqual(f.launches[2].cwd, f.launches[5].cwd);
  } finally { await manager.shutdown(); }
});

test("S16: a failed stop is a note on a failed repair and a warning on a fresh successful edit", async t => {
  const f = await fixture(t);
  f.hooks.failRun = 2;
  f.hooks.onStop = async () => { f.events.push("stop failed"); throw new Error("injected stop failure"); };
  await assert.rejects(applyClineEdits(f.input, undefined, f.options), (error: unknown) => {
    assert.ok(error instanceof ClineRunError);
    assert.equal(error.kind, "non_zero_exit");
    assert.deepEqual(error.notes, ["Failed to stop the dedicated Cline hub: injected stop failure"]);
    return true;
  });
  assert.deepEqual(f.events, ["start 1", "run 1", "run 1", "stop failed"]);
  writeFileSync(path.join(f.cwd, "ready"), "yes");
  const result = await applyClineEdits(f.input, undefined, f.options);
  assert.equal(result.verification.passed, true);
  assert.deepEqual(result.warnings?.filter(w => w.includes("injected stop failure")),
    ["Failed to stop the dedicated Cline hub: injected stop failure"]);
  assert.deepEqual(f.events.slice(-3), ["start 2", "run 2", "stop failed"]);
});

test("S16 review: a hub session never reuses its hub for a different cwd and stops the old one", async () => {
  const { DedicatedHubSession } = await import("../runner.js");
  const started: string[] = [], stopped: string[] = [];
  let next = 0;
  const startHub = async () => {
    const id = `hub-${++next}`; started.push(id);
    return { env: { CLINE_HUB_PORT: id }, stop: async () => { stopped.push(id); }, isListening: async () => true };
  };
  const session = new DedicatedHubSession();
  const options = { deps: { startHub } } as unknown as ClineInvocationOptions;
  assert.deepEqual(await session.environment("C:\repo\a", options), { CLINE_HUB_PORT: "hub-1" });
  session.launched = true;
  assert.deepEqual(await session.environment("C:\repo\a", options), { CLINE_HUB_PORT: "hub-1" });
  assert.deepEqual(await session.environment("C:\repo\b", options), { CLINE_HUB_PORT: "hub-2" });
  assert.deepEqual(started, ["hub-1", "hub-2"]);
  assert.deepEqual(stopped, ["hub-1"], "the first folder's hub is stopped before another folder gets one");
});

test("S16 review: a run that used a command tool stops its hub (and its job) before the check; file-only runs keep it", async t => {
  const f = await fixture(t);
  const tool = (toolName: string, input: Record<string, unknown>) =>
    JSON.stringify({ type: "agent_event", event: { type: "content_start", contentType: "tool", toolName, input } }) + "\n";
  // Run 1 starts a process (it could still run during the check); runs 2 and 3 only read and edit files.
  f.hooks.output = n => n === 1 ? tool("execute_command", { command: "npm run watch" })
    : tool("read_file", { path: "a.ts" }) + tool("replace_in_file", { path: "a.ts" });
  f.hooks.onRun = n => { if (n === 3) writeFileSync(path.join(f.cwd, "ready"), "yes"); };
  const result = await applyClineEdits(f.input, undefined, f.options);
  assert.equal(result.verification.passed, true);
  assert.equal(result.verification.fixRuns, 2);
  assert.deepEqual(f.events, ["start 1", "run 1", "stop 1", "start 2", "run 2", "run 2", "stop 2"]);
});
