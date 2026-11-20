import assert from "node:assert/strict";
import "./git-test-serial.js";
import test, { after } from "node:test";
import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { FinalCheckLifecycle } from "../finalcheck.js";
import { runCline, redactSecrets, ClineRunError } from "../runner.js";

// Plan S18: the serious findings of the S17 final audit (Cline side).

const envDir = await mkdtemp(path.join(os.tmpdir(), `cline-s18-env-${process.pid}-`));
process.env.CLINE_PROVIDER_SETTINGS_PATH = path.join(envDir, "providers.json");
process.env.CLINE_MCP_STATUS_PATH = path.join(envDir, "status.json");
process.env.CLINE_MCP_CATALOG_PATH = path.join(envDir, "catalog.json");
process.env.CLINE_MCP_STATE_PATH = path.join(envDir, "state.json");
process.env.CLINE_MCP_TRACE_DIR = path.join(envDir, "traces");
process.env.CLINE_MCP_SNAPSHOT_DIR = path.join(envDir, "snapshots");
after(() => rm(envDir, { recursive: true, force: true, maxRetries: 5 }));

const line = (value: unknown) => JSON.stringify(value);
const hex = "0f3a9c41b2d7e85f6a1c0b9d8e7f6a5b4c3d2e1f0a9b8c7d6e5f4a3b2c1d0e9f";

function git(cwd: string, ...args: string[]) {
  const r = spawnSync("git", ["-C", cwd, "-c", "user.name=t", "-c", "user.email=t@example.invalid", ...args],
    { encoding: "utf8", windowsHide: true, env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" } });
  assert.equal(r.status, 0, r.stderr);
}
async function repo(t: test.TestContext) {
  const base = await mkdtemp(path.join(envDir, "repo-"));
  t.after(() => rm(base, { recursive: true, force: true, maxRetries: 5 }));
  const root = path.join(base, "r"); await mkdir(root); git(root, "init", "-q");
  await writeFile(path.join(root, "a.txt"), "base\n"); git(root, "add", "."); git(root, "commit", "-qm", "base");
  return { base, root };
}
function mockChild(chunks: string[], code = 0) {
  const child = new EventEmitter() as any;
  child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.pid = 4321;
  child.stdout.destroy = () => {}; child.stderr.destroy = () => {}; child.kill = () => {};
  queueMicrotask(() => { for (const c of chunks) child.stdout.emit("data", Buffer.from(c)); child.emit("close", code); });
  return child;
}
const runnerDeps = (spawn: unknown) => ({ maxAttempts: 1, recordStatus: false, respectQuotaLock: false, deps: {
  entryPath: "mock/cline", access: async () => {}, timeoutMs: 5_000, closeGracePeriodMs: 1, killGracePeriodMs: 1,
  settlementDeadlineMs: 50, acquireSettingsMutex: async () => async () => {}, spawn } });

// ---- (1) redaction: Cline never hid `api_key: <value>` (colon form, not JSON) ----

test("S18 (1): colon-form api keys are redacted; type annotations are kept", () => {
  for (const text of [`api_key: "${hex}"`, `api_key: ${hex}`, `apiKey: "sk_live_${hex.slice(0, 20)}"`, `apiKey = ${hex}`,
    `client_secret: ${hex}`, `access_token: "${hex}"`]) {
    assert.ok(!redactSecrets(text).includes(hex.slice(0, 20)), `${text} -> ${redactSecrets(text)}`);
  }
  for (const text of ["apiKey: string", "api_key: string;", "const accessToken: string = read()"]) {
    assert.equal(redactSecrets(text), text);
  }
});

// ---- (2) a final check whose processes could not be confirmed dead stops the lifecycle ----

const unconfirmedCheck = () => ({ passed: false, exitCode: null, signal: "SIGKILL" as const, timedOut: true, killedForOutput: false,
  durationMs: 1, stdoutTail: "", stderrTail: "", killConfirmed: false as const, stillAlive: [4242] });

test("S18 (2): an unconfirmed check kill launches no repair and keeps the recovery snapshot after restore", async t => {
  const f = await repo(t);
  let runs = 0;
  const lifecycle = new FinalCheckLifecycle({ prompt: "Implement", cwd: f.root, maxFixRuns: 2, timeoutSeconds: 600,
    verify: { command: process.execPath, args: ["-e", "0"] } }, {
    resolveRoot: async () => f.root, lockDirectory: path.join(f.base, "locks"),
    fits: () => true, question: () => undefined, verify: async () => unconfirmedCheck(),
    run: async () => { runs++; await writeFile(path.join(f.root, "a.txt"), `edit ${runs}\n`);
      return { text: "done", durationMs: 1, guard: { window: 10, lastErrors: [], totalToolCalls: 0, totalInputTokens: 0, filesTouched: [] } } as any; }
  });
  await lifecycle.execute(new AbortController().signal);
  assert.equal(runs, 1, "no repair may run while the check's processes may still be alive");
  assert.equal(lifecycle.phase, "waiting");
  assert.deepEqual(lifecycle.evidence.processesStillAlive, [4242]);
  const directory = lifecycle.snapshot!.directory;
  await lifecycle.restore();
  assert.ok(existsSync(directory), "the recovery snapshot is kept: the surviving process may still change files");
  lifecycle.release();
});

test("S18 (2): a cancelled run whose tree could not be confirmed dead keeps that evidence", async t => {
  const f = await repo(t);
  const controller = new AbortController();
  const lifecycle = new FinalCheckLifecycle({ prompt: "Implement", cwd: f.root, timeoutSeconds: 600,
    verify: { none: true, reason: "Explicit test opt-out" } }, {
    resolveRoot: async () => f.root, lockDirectory: path.join(f.base, "locks"), fits: () => true, question: () => undefined,
    run: async () => { controller.abort();
      throw new ClineRunError("cancelled", "The Cline request was cancelled.", { processesStillAlive: [77], killUnverified: true } as any); }
  });
  await lifecycle.execute(controller.signal);
  assert.deepEqual(lifecycle.evidence.processesStillAlive, [77]);
  assert.equal(lifecycle.evidence.killUnverified, true);
  lifecycle.release();
});

// ---- (3) every tool-call shape and an oversized line count as able to start a process ----

test("S18 (3): tool_call / tool_use events and oversized lines count as process-capable tool calls", async () => {
  const done = line({ type: "run_result", finishReason: "completed", text: "done" }) + "\n";
  for (const event of [
    { type: "tool_use", name: "execute_command", input: { command: "npm run watch" } },
    { type: "tool_call", toolName: "execute_command", input: { command: "npm run watch" } },
    { type: "agent_event", event: { type: "tool_call", toolName: "run_commands", input: { commands: ["npm run watch"] } } },
  ]) {
    const result = await runCline({ provider: "p", model: "m", prompt: "x" }, undefined,
      runnerDeps(() => mockChild([line(event) + "\n", done])) as any);
    assert.ok((result.guard?.processToolCalls ?? 0) > 0, `${event.type} must count: ${JSON.stringify(result.guard)}`);
  }
  const oversized = "x".repeat(1024 * 1024 + 10) + "\n";
  const result = await runCline({ provider: "p", model: "m", prompt: "x" }, undefined, runnerDeps(() => mockChild([oversized, done])) as any);
  assert.ok((result.guard?.processToolCalls ?? 0) > 0, "an unreadable (oversized) line may hide a command");
  // A file-only run still counts nothing.
  const fileOnly = await runCline({ provider: "p", model: "m", prompt: "x" }, undefined, runnerDeps(() => mockChild([
    line({ type: "agent_event", event: { type: "content_start", contentType: "tool", toolName: "read_file", input: { path: "a" } } }) + "\n", done])) as any);
  assert.equal(fileOnly.guard?.processToolCalls ?? 0, 0);
});

// ---- (4) the last error decides, also for wrapped errors ----

test("S18 (4): an old quota line before a wrapped terminal error is not a quota lock", async () => {
  const stdout = [line({ type: "run_result", finishReason: "error", text: "Daily free quota exhausted for this model" }),
    line({ type: "run-finished", result: { finishReason: "error", text: "invalid tool schema" } })].join("\n") + "\n";
  await assert.rejects(runCline({ provider: "p", model: "m", prompt: "x" }, undefined, runnerDeps(() => mockChild([stdout])) as any),
    (error: unknown) => {
      assert.ok(error instanceof ClineRunError);
      assert.notEqual(error.kind, "quota_exhausted");
      assert.match(error.message, /invalid tool schema/);
      return true;
    });
});

// ---- (7) sync retries share one token budget ----

test("S18 (7): a retried sync attempt gets only the token budget the failed attempt left", async () => {
  let attempt = 0;
  const spawn = () => {
    attempt++;
    const usage = line({ type: "usage", inputTokens: 6_000 }) + "\n";
    return attempt === 1
      ? mockChild([usage, line({ type: "run_result", finishReason: "error", text: "Service temporarily overloaded" }) + "\n"], 1)
      : mockChild([usage, line({ type: "run_result", finishReason: "completed", text: "done" }) + "\n"], 0);
  };
  const options = { ...runnerDeps(spawn), maxAttempts: 2, guard: { maxInputTokens: 10_000 } } as any;
  options.deps = { ...options.deps, backoffMs: 0, minRetryBudgetMs: 0, sleep: async () => {} };
  await assert.rejects(runCline({ provider: "p", model: "m", prompt: "x" }, undefined, options), (error: unknown) => {
    assert.ok(error instanceof ClineRunError);
    assert.equal(attempt, 2, "the transient failure is retried");
    assert.equal(error.kind, "budget_exceeded", `got ${error.kind}: ${error.message}`);
    return true;
  });
});

// ---- review of the S18 writer output ----

test("S18 (2): retry after an unconfirmed kill is refused with a clear error; restore still works", async t => {
  const f = await repo(t);
  const { TaskManager } = await import("../tasks.js");
  let runs = 0;
  const manager = new TaskManager({ traceBase: path.join(f.base, "traces"), snapshotOptions: { snapshotBase: path.join(f.base, "snapshots") },
    runOptions: { checkoutLockDirectory: path.join(f.base, "locks") }, runVerification: async () => unconfirmedCheck() as any,
    runners: { edits: async () => { runs++; await writeFile(path.join(f.root, "a.txt"), "edit\n");
      return { text: "done", durationMs: 1, usage: { inputTokens: 1 } } as any; } } });
  t.after(() => manager.shutdown(30_000));
  const task = manager.start({ mode: "edits", prompt: "Implement", cwd: f.root, maxFixRuns: 2, codeMap: false, provider: "p", model: "m",
    verify: { command: process.execPath, args: ["-e", "0"] } });
  const deadline = Date.now() + 20_000;
  let status = await manager.status(task.taskId, 0);
  while (status.state !== "input_required") { assert.ok(Date.now() < deadline, status.state); await new Promise(r => setTimeout(r, 10)); status = await manager.status(task.taskId, 0); }
  assert.equal(runs, 1);
  assert.deepEqual(status.question?.options, ["restore", "keep"]);
  await assert.rejects(manager.send(task.taskId, "try again", "retry"), (error: unknown) =>
    error instanceof ClineRunError && /still be running|restore|keep/i.test(error.message));
  await manager.send(task.taskId, "", "restore");
  while ((status = await manager.status(task.taskId, 0)).state !== "done") { assert.ok(Date.now() < deadline, status.state); await new Promise(r => setTimeout(r, 10)); }
  assert.equal(runs, 1);
});

test("S18 (6): without an assigned job, a check that closes its pipes still gets the tree check", async t => {
  const { runVerification } = await import("../verify.js");
  const cwd = await mkdtemp(path.join(envDir, "verify-")); t.after(() => rm(cwd, { recursive: true, force: true }));
  let checked = 0;
  const result = await runVerification({ command: process.execPath, args: ["-e", "0"] }, cwd, undefined, {
    createWindowsJob: (async () => ({ alive: true, assigned: false, assign() {}, close: async () => {} })) as any,
    confirmTreeDead: (async () => { checked++; return { confirmed: false, alive: [999], unverified: false }; }) as any });
  assert.equal(checked, 1, "the descendants of an exited check are looked for");
  assert.equal(result.passed, false);
  assert.equal(result.killConfirmed, false);
});

test("S18 (S16 record): failed edit replies carry notes; hub warnings are per execute", async t => {
  const { editFailurePayload } = await import("../edits.js");
  const error = Object.assign(new ClineRunError("non_zero_exit", "failed"), { verification: { passed: false }, notes: ["hub stop failed"] });
  assert.deepEqual(editFailurePayload(error).notes, ["hub stop failed"]);
  const f = await repo(t);
  const lifecycle = new FinalCheckLifecycle({ prompt: "Implement", cwd: f.root, timeoutSeconds: 600, verify: { none: true, reason: "Explicit test opt-out" } }, {
    resolveRoot: async () => f.root, lockDirectory: path.join(f.base, "locks"), fits: () => true, question: () => undefined,
    run: async () => ({ text: "done", durationMs: 1, guard: { window: 10, lastErrors: [], totalToolCalls: 0, totalInputTokens: 0, filesTouched: [] } }) as any });
  lifecycle.hubWarnings.push("a warning from an earlier execute");
  await lifecycle.execute(new AbortController().signal);
  assert.deepEqual(lifecycle.hubWarnings, []);
  lifecycle.release();
});

// ---- Neon review of S18 (Cline) ----

const failing = (stdoutLines: unknown[], stderr = "", code = 1) => () => {
  const child = new EventEmitter() as any;
  child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.pid = 4321;
  child.stdout.destroy = () => {}; child.stderr.destroy = () => {}; child.kill = () => {};
  queueMicrotask(() => {
    child.stdout.emit("data", Buffer.from(stdoutLines.map(v => line(v)).join("\n") + "\n"));
    if (stderr) child.stderr.emit("data", Buffer.from(stderr));
    child.emit("close", code);
  });
  return child;
};
const kindOf = async (spawn: () => unknown) => {
  try { await runCline({ provider: "p", model: "m", prompt: "x" }, undefined, runnerDeps(spawn) as any); return "resolved"; }
  catch (error) { return (error as ClineRunError).kind; }
};

test("S18 review: an empty terminal error never hides an earlier, informative error", async () => {
  assert.equal(await kindOf(failing([{ type: "error", message: "Daily free quota exhausted for this model" },
    { type: "run_result", finishReason: "error" }])), "quota_exhausted");
  assert.equal(await kindOf(failing([{ type: "run_result", finishReason: "error" }], "HTTP 503 Service Unavailable: upstream overloaded\n")),
    "transient_provider_error");
});

test("S18 review: the CLI-update signal comes from stderr only", async () => {
  assert.equal(await kindOf(failing([{ type: "tool_result", error: "ENOENT: no such file" }],
    "Error: Cannot find module '/x/cline/dist/cli.js'\ncode: 'MODULE_NOT_FOUND'\n")), "cline_updating");
  assert.notEqual(await kindOf(failing([{ type: "run_result", finishReason: "error", text: "Cannot find module 'left-pad' in the project" }])),
    "cline_updating");
});

test("S18 review: only tool invocations (and unreadable lines) count as process-capable, not results or catalogs", async () => {
  const { createGuard } = await import("../guard.js");
  const g = createGuard();
  for (const event of [{ type: "tool_result", tool_use_id: "1", content: "file body" }, { type: "tools_loaded", count: 12 },
    { type: "agent_event", event: { type: "tool_result", content: "x" } }, { type: "agent_event", event: { type: "tool_output", text: "x" } },
    { type: "agent_event", event: { type: "tool_end" } }]) g.observe(event);
  assert.equal(g.snapshot().processToolCalls ?? 0, 0);
  g.observe({ type: "tool_use", name: "read_file", input: { path: "a" } });
  assert.equal(g.snapshot().processToolCalls ?? 0, 0, "a file-only invocation counts 0");
  g.observe({ type: "tool_use", name: "execute_command", input: { command: "x" } });
  assert.equal(g.snapshot().processToolCalls, 1);
});

test("S18 review: quoted-key redaction keeps JSON structure and type annotations, and hides a Bearer value", () => {
  for (const text of ['{"token": {"access": "abc"}}', '{"key": ["a", "b"]}', `Type '{ "apiKey": string; }'`]) {
    assert.equal(redactSecrets(text), text);
  }
  assert.ok(!redactSecrets('"api_key": Bearer mysecret123456').includes("mysecret123456"));
});

test("S18 review: a job that closes when the check exits does not trigger a needless tree check", async t => {
  const { runVerification } = await import("../verify.js");
  const cwd = await mkdtemp(path.join(envDir, "verify-job-")); t.after(() => rm(cwd, { recursive: true, force: true }));
  let checked = 0;
  const job = { alive: true, assigned: false, assign() { job.assigned = true; }, close: async () => { job.assigned = false; job.alive = false; } };
  const result = await runVerification({ command: process.execPath, args: ["-e", "0"] }, cwd, undefined, {
    createWindowsJob: (async () => job) as any,
    confirmTreeDead: (async () => { checked++; return { confirmed: false, alive: [1], unverified: true }; }) as any });
  assert.equal(checked, 0);
  assert.equal(result.passed, true);
});

test("S18 review: a check that ended by itself fails only on a real survivor, not on an unreadable process table", async t => {
  const { runVerification } = await import("../verify.js");
  const cwd = await mkdtemp(path.join(envDir, "verify-unreadable-")); t.after(() => rm(cwd, { recursive: true, force: true }));
  const noJob = (async () => ({ alive: true, assigned: false, assign() {}, close: async () => {} })) as any;
  const unreadable = await runVerification({ command: process.execPath, args: ["-e", "0"] }, cwd, undefined, { createWindowsJob: noJob,
    confirmTreeDead: (async () => ({ confirmed: false, alive: [], unverified: true })) as any });
  assert.equal(unreadable.passed, true, JSON.stringify(unreadable));
  assert.equal(unreadable.killConfirmed, undefined);
});
