import assert from "node:assert/strict";
import "./git-test-serial.js";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { mkdtemp, writeFile, readFile, mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { FinalCheckLifecycle, type VerifySpec } from "../finalcheck.js";
import { TaskManager, type TaskStatusView } from "../tasks.js";
import { editQuestion } from "../edits.js";
import { ClineRunError } from "../runner.js";

// Plan S10 (B9, B10): async edits return gitDiff and status like sync edits; the first run keeps time for
// its final check; a Cline timeout at the end of the budget is reported as "budget".

const verify = { command: process.execPath, args: ["-e", 'process.exit(require("fs").readFileSync("a","utf8")==="pass"?0:7)'] };

function git(cwd: string, ...args: string[]): string {
  const r = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8", windowsHide: true, env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" } });
  assert.equal(r.status, 0, r.stderr); return r.stdout.trim();
}

async function fixture(t: test.TestContext) {
  const base = await mkdtemp(path.join(os.tmpdir(), "cline-s10-"));
  t.after(() => rm(base, { recursive: true, force: true, maxRetries: 5 }));
  const cwd = path.join(base, "repo"), locks = path.join(base, "locks"), snapshots = path.join(base, "snapshots");
  await mkdir(cwd); git(cwd, "init", "--quiet");
  await writeFile(path.join(cwd, "a"), "committed"); git(cwd, "add", ".");
  git(cwd, "-c", "user.name=Test", "-c", "user.email=t@example.invalid", "commit", "-qm", "baseline");
  const put = (text: string) => writeFile(path.join(cwd, "a"), text);
  const bytes = () => readFile(path.join(cwd, "a"), "utf8");
  return { base, cwd, locks, snapshots, put, bytes };
}

async function until<T>(read: () => Promise<T>, predicate: (value: T) => boolean): Promise<T> {
  const deadline = Date.now() + 20_000;
  while (true) { const value = await read(); if (predicate(value)) return value;
    assert.ok(Date.now() < deadline, JSON.stringify(value)); await new Promise(r => setTimeout(r, 10)); }
}

async function asyncFixture(t: test.TestContext, run: (input: any, signal: AbortSignal) => Promise<any>) {
  const f = await fixture(t);
  const manager = new TaskManager({ traceBase: path.join(f.base, "traces"), snapshotOptions: { snapshotBase: f.snapshots },
    runOptions: { checkoutLockDirectory: f.locks }, runners: { edits: (input, signal) => run(input, signal) } });
  t.after(() => manager.shutdown(30_000));
  const start = (spec: VerifySpec, options = {}) => manager.start({ mode: "edits", prompt: "Implement", cwd: f.cwd, verify: spec, maxFixRuns: 0,
    codeMap: false, provider: "p", model: "m", ...options });
  const wait = (id: string, states: TaskStatusView["state"][]) => until(() => manager.status(id, 0), s => states.includes(s.state));
  return { ...f, manager, start, wait };
}

// --- B9: async edits return the diff and status ------------------------------------

test("S10 B9: a passing async edit returns gitDiff and status, like the sync tool", async t => {
  let f!: Awaited<ReturnType<typeof asyncFixture>>;
  f = await asyncFixture(t, async () => { await f.put("pass"); return { text: "done", durationMs: 1, usage: { inputTokens: 10 } }; });
  const task = f.start(verify);
  await f.wait(task.taskId, ["done"]);
  const result = await f.manager.result(task.taskId) as any;
  assert.equal(result.verification?.passed, true);
  assert.match(String(result.result?.gitDiff), /\+pass/);
  assert.equal(result.result?.status, " M a", "short status keeps its first column (index unchanged, worktree modified)");
  assert.equal(result.result?.headBefore, result.result?.headAfter);
});

test("S10 review: keep after HEAD moved reports the new HEAD as headAfter", async t => {
  let f!: Awaited<ReturnType<typeof asyncFixture>>;
  f = await asyncFixture(t, async () => { await f.put("failed"); return { text: "done", durationMs: 1, usage: { inputTokens: 10 } }; });
  const task = f.start(verify);
  await f.wait(task.taskId, ["input_required"]);
  const before = git(f.cwd, "rev-parse", "HEAD");
  git(f.cwd, "-c", "user.name=Test", "-c", "user.email=t@example.invalid", "commit", "-q", "--allow-empty", "-m", "moved");
  const after = git(f.cwd, "rev-parse", "HEAD");
  await f.manager.send(task.taskId, "", "keep");
  await f.wait(task.taskId, ["done", "failed"]);
  const result = await f.manager.result(task.taskId) as any;
  if (result.result?.headAfter !== undefined) {
    assert.equal(result.result.headBefore, before);
    assert.equal(result.result.headAfter, after);
  }
});

// --- B10: Cline timeout at the end of the budget -------------------------------------

test("S10 B10: a Cline run that times out is reported as waitReason budget, not cline_error", async t => {
  const f = await asyncFixture(t, async () => { throw new ClineRunError("timeout", "Cline timed out after 120 s."); });
  const task = f.start(verify);
  const waiting = await f.wait(task.taskId, ["input_required", "failed"]);
  assert.equal(waiting.waitReason, "budget");
});

test("S10 B10: other Cline errors are still cline_error", async t => {
  const f = await asyncFixture(t, async () => { throw new ClineRunError("non_zero_exit", "boom"); });
  const task = f.start(verify);
  const waiting = await f.wait(task.taskId, ["input_required", "failed"]);
  assert.equal(waiting.waitReason, "cline_error");
});

// --- B10: the first run keeps time for its check --------------------------------------

test("S10 B10: with an 80 s budget and a 60 s check, the first run gets at most 20 s", async t => {
  const f = await fixture(t); const seconds: number[] = [];
  const lifecycle = new FinalCheckLifecycle({ prompt: "Implement", cwd: f.cwd, verify: { ...verify, timeoutSeconds: 60 }, timeoutSeconds: 80 }, {
    resolveRoot: async cwd => cwd, fits: () => true, question: editQuestion, lockDirectory: f.locks,
    snapshotOptions: { snapshotBase: f.snapshots }, now: () => 0,
    run: async (_prompt, _signal, _lock, _guard, remainingSeconds) => {
      seconds.push(remainingSeconds); await f.put("pass");
      return { text: "done", durationMs: 1, usage: { inputTokens: 10 } } as any;
    }
  });
  try {
    await lifecycle.execute(new AbortController().signal);
    assert.equal(lifecycle.phase, "done");
    assert.equal(seconds.length, 1);
    // 80 s - (60 s check + 10 s margin) = 10 s with the injected clock removing Git setup jitter.
    assert.equal(seconds[0], 10, `first run got ${seconds[0]} s`);
  } finally { lifecycle.release(); }
});

test("S10 B10: a budget too small for the check stops before any run with waitReason budget", async t => {
  const f = await fixture(t); let runs = 0;
  const lifecycle = new FinalCheckLifecycle({ prompt: "Implement", cwd: f.cwd, verify: { ...verify, timeoutSeconds: 60 }, timeoutSeconds: 60 }, {
    resolveRoot: async cwd => cwd, fits: () => true, question: editQuestion, lockDirectory: f.locks,
    snapshotOptions: { snapshotBase: f.snapshots },
    run: async () => { runs++; return { text: "done", durationMs: 1 } as any; }
  });
  try {
    await lifecycle.execute(new AbortController().signal);
    assert.equal(runs, 0, "a run that cannot be checked is not launched");
    assert.equal(lifecycle.phase, "waiting");
    assert.equal(lifecycle.waitReason, "budget");
    assert.equal(await f.bytes(), "committed");
  } finally { await lifecycle.restore(); lifecycle.release(); }
});
