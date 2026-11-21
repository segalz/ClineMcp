import assert from "node:assert/strict";
import "./git-test-serial.js";
import { TEST_WAIT_MS } from "./test-waits.js";
import test, { after } from "node:test";
import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseClineJsonl, parseUsableResult, JsonlParseError } from "../parser.js";
import { createGuard } from "../guard.js";
import { runCline, ClineRunError } from "../runner.js";
import { applyClineEdits } from "../edits.js";
import { CODE_MAP_HEADER } from "../codemap.js";
import { TaskManager, type TaskStatusView } from "../tasks.js";
import { takeSnapshot, discardSnapshot } from "../snapshot.js";
import { getJournalPath, withProviderOverride, type acquireSettingsMutex, type ReleaseSettingsMutex } from "../settings.js";
import { withProgressHeartbeat } from "../progress.js";

// Plan S15 (review items C7, D4, D5 and the leftovers recorded for S15 in S9-S14 and Gate 2).

const envDir = await mkdtemp(path.join(os.tmpdir(), `cline-s15-env-${process.pid}-`));
process.env.CLINE_PROVIDER_SETTINGS_PATH = path.join(envDir, "providers.json");
process.env.CLINE_MCP_STATUS_PATH = path.join(envDir, "status.json");
process.env.CLINE_MCP_CATALOG_PATH = path.join(envDir, "catalog.json");
process.env.CLINE_MCP_STATE_PATH = path.join(envDir, "state.json");
process.env.CLINE_MCP_TRACE_DIR = path.join(envDir, "traces");
after(() => rm(envDir, { recursive: true, force: true, maxRetries: 5 }));
// The code-map test expects the built-in regex map, not a configured codeindex adapter.
delete process.env.CODEINDEX_CLI;

const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const agent = (event: Record<string, unknown>) => ({ type: "agent_event", event });
const line = (value: unknown) => JSON.stringify(value);

function git(cwd: string, ...args: string[]): string {
  const r = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8", windowsHide: true, env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" } });
  assert.equal(r.status, 0, r.stderr); return r.stdout.trim();
}
function mockChild(stdout: string, code = 0) {
  const child = new EventEmitter() as any;
  child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.pid = 999;
  child.stdout.destroy = () => {}; child.stderr.destroy = () => {}; child.kill = () => {};
  queueMicrotask(() => { child.stdout.emit("data", Buffer.from(stdout)); child.emit("close", code); });
  return child;
}

// ---- C7: a terminal run_result error after an earlier "done" is an error, not the early text ----

const earlyDoneThenError = [
  line(agent({ type: "done", reason: "completed", text: "EARLY partial answer" })),
  line({ type: "run_result", finishReason: "error", text: "invalid request: context window exceeded" })
].join("\n");

test("S15 C7: done followed by run_result finishReason error yields no usable result", () => {
  assert.equal(parseUsableResult(earlyDoneThenError, 0), undefined);
  assert.equal(parseUsableResult(earlyDoneThenError, 1), undefined);
  assert.throws(() => parseClineJsonl(earlyDoneThenError), JsonlParseError);
  // The order matters: a completed run_result after an earlier error is still a result.
  const recovered = [line({ type: "run_result", finishReason: "error", text: "transient" }),
    line({ type: "run_result", finishReason: "completed", text: "final answer" })].join("\n");
  assert.equal(parseUsableResult(recovered, 0)?.text, "final answer");
  assert.equal(parseClineJsonl(recovered).text, "final answer");
});

test("S15 C7 review: the last usable terminal event wins; a done error cancels an earlier answer", () => {
  const runThenDone = [line({ type: "run_result", finishReason: "completed", text: "answer A" }),
    line(agent({ type: "done", reason: "completed", text: "answer B" }))].join("\n");
  for (const code of [0, 1]) assert.equal(parseUsableResult(runThenDone, code)?.text, "answer B");
  assert.equal(parseClineJsonl(runThenDone).text, "answer B");
  const twoDone = [line(agent({ type: "done", reason: "completed", text: "first" })),
    line(agent({ type: "done", reason: "completed", text: "second" }))].join("\n");
  assert.equal(parseUsableResult(twoDone, 0)?.text, "second");
  assert.equal(parseClineJsonl(twoDone).text, "second");
  const thenDoneError = [line({ type: "run_result", finishReason: "completed", text: "answer A" }),
    line(agent({ type: "done", reason: "error", text: "provider failed" }))].join("\n");
  for (const code of [0, 1]) assert.equal(parseUsableResult(thenDoneError, code), undefined);
  assert.throws(() => parseClineJsonl(thenDoneError), JsonlParseError);
  // The normal order (done, then the run_result with usage) still returns the run_result.
  const normal = [line(agent({ type: "done", reason: "completed", text: "same" })),
    line({ type: "run_result", finishReason: "completed", text: "same", usage: { inputTokens: 5 } })].join("\n");
  assert.deepEqual(parseUsableResult(normal, 0)?.usage, { inputTokens: 5 });
});

const runnerOptions = (stdout: string, code = 0) => ({ maxAttempts: 1, recordStatus: false, respectQuotaLock: false, deps: {
  entryPath: "mock/cline", access: async () => {}, timeoutMs: 2_000, closeGracePeriodMs: 1, killGracePeriodMs: 1,
  settlementDeadlineMs: 50, acquireSettingsMutex: async () => async () => {},
  spawn: (() => mockChild(stdout + "\n", code)) as any } });

test("S15 C7: runCline reports the run_result error instead of returning the early done text", async () => {
  await assert.rejects(runCline({ provider: "p", model: "m", prompt: "test" }, undefined, runnerOptions(earlyDoneThenError) as any), (error: unknown) => {
    assert.ok(error instanceof ClineRunError);
    assert.equal(error.kind, "non_zero_exit");
    assert.match(error.message, /context window exceeded/);
    return true;
  });
});

test("S15 C7 review: an earlier quota error does not decide a run whose last error is different", async () => {
  const stdout = [line({ type: "run_result", finishReason: "error", text: "Daily free quota exhausted for this model" }),
    line({ type: "run_result", finishReason: "completed", text: "answer" }),
    line({ type: "run_result", finishReason: "error", text: "invalid request: bad tool schema" })].join("\n");
  await assert.rejects(runCline({ provider: "p", model: "m", prompt: "test" }, undefined, runnerOptions(stdout) as any), (error: unknown) => {
    assert.ok(error instanceof ClineRunError);
    assert.notEqual(error.kind, "quota_exhausted");
    assert.match(error.message, /bad tool schema/);
    return true;
  });
});

test("S15 C7 review: a wrapped run-finished error keeps its diagnostic text", async () => {
  const stdout = line({ type: "run-finished", result: { finishReason: "error", text: "invalid nested request" } });
  await assert.rejects(runCline({ provider: "p", model: "m", prompt: "test" }, undefined, runnerOptions(stdout) as any), (error: unknown) => {
    assert.ok(error instanceof ClineRunError);
    assert.notEqual(error.kind, "missing_final_result");
    assert.match(error.message, /invalid nested request/);
    return true;
  });
});

// ---- C7: the guard's last assistant text comes only from assistant text ----

function tripped(guard: ReturnType<typeof createGuard>) {
  const verdict = guard.observe(agent({ type: "usage", inputTokens: 10_001 }));
  assert.ok(verdict); assert.equal(verdict.kind, "budget_exceeded");
  return verdict;
}

test("S15 C7: reasoning, tool output and error events never become lastAssistantText", () => {
  const guard = createGuard({ maxInputTokens: 10_000 });
  guard.observe(agent({ type: "content_end", contentType: "text", text: "Visible answer block." }));
  guard.observe(agent({ type: "content_start", contentType: "reasoning", text: "PRIVATE reasoning text" }));
  guard.observe(agent({ type: "content_end", contentType: "reasoning", text: "PRIVATE reasoning text", reasoning: "PRIVATE" }));
  guard.observe(agent({ type: "content_end", contentType: "tool", toolName: "read_file", text: "TOOL OUTPUT file body" }));
  guard.observe(agent({ type: "content_end", contentType: "tool", toolName: "read_file", content: "TOOL OUTPUT file body" }));
  guard.observe(agent({ type: "error", text: "ERROR event text" }));
  guard.observe(agent({ type: "error", contentType: "text", accumulated: "ERROR detail", text: "ERROR detail" }));
  guard.observe({ type: "error", contentType: "text", accumulated: "ERROR top-level", text: "ERROR top-level" });
  assert.equal(tripped(guard).lastAssistantText, "Visible answer block.");
});

test("S15 C7: a bare text delta never replaces the last complete text block", () => {
  const guard = createGuard({ maxInputTokens: 10_000 });
  guard.observe(agent({ type: "content_end", contentType: "text", text: "First complete block." }));
  guard.observe(agent({ type: "content_start", contentType: "text", text: " frag" }));
  assert.equal(tripped(guard).lastAssistantText, "First complete block.");
  // A delta that carries the accumulated block text is the newest block and wins.
  const g2 = createGuard({ maxInputTokens: 10_000 });
  g2.observe(agent({ type: "content_end", contentType: "text", text: "Old block." }));
  g2.observe(agent({ type: "content_start", contentType: "text", text: "lock", accumulated: "New block" }));
  assert.equal(tripped(g2).lastAssistantText, "New block");
});

// ---- C7: fix prompts keep room for the code map ----

test("S15 C7 (regression, passes before the fix): a fix run with a long objective and full check tails still gets a code map", async t => {
  const base = await mkdtemp(path.join(os.tmpdir(), "cline-s15-map-"));
  t.after(() => rm(base, { recursive: true, force: true, maxRetries: 5 }));
  const cwd = path.join(base, "repo"); await mkdir(path.join(cwd, "src"), { recursive: true });
  git(cwd, "init", "--quiet");
  for (let i = 0; i < 40; i++) await writeFile(path.join(cwd, "src", `module${i}.ts`), `export function handler${i}() { return ${i}; }\n`);
  git(cwd, "add", "."); git(cwd, "-c", "user.name=Test", "-c", "user.email=t@example.invalid", "commit", "-qm", "baseline");
  const prompts: string[] = [];
  const deps = { entryPath: "fake", access: async () => {}, acquireSettingsMutex: async () => async () => {},
    spawn: ((_command: string, args: string[]) => { prompts.push(args.at(-1)!);
      return mockChild(line({ type: "run_result", finishReason: "completed", text: "done" }) + "\n", 0); }) as any };
  const verify = { command: process.execPath, args: ["-e", 'process.stdout.write("o".repeat(8192)); process.stderr.write("e".repeat(8192)); process.exit(1)'] };
  const objective = "Implement the requested change in src. " + "Detail of the objective. ".repeat(640);
  await assert.rejects(applyClineEdits({ prompt: objective, cwd, verify, maxFixRuns: 1, provider: "p", model: "m", codeMap: true },
    undefined, { deps: deps as any, checkoutLockDirectory: path.join(base, "locks") }), (e: any) => {
    assert.equal(e.verification.fixRuns, 1); return true; });
  assert.equal(prompts.length, 2);
  assert.ok(prompts[0].includes(CODE_MAP_HEADER), "the first run has a code map");
  assert.ok(prompts[1].includes(CODE_MAP_HEADER), "the fix run must keep room for the code map");
  assert.match(prompts[1], /stdout tail/);
});

// ---- Gate 2 (1): a resumed async edit does not show the previous run's guard or wait reason ----

test("S15 Gate 2: while a resumed async edit runs, cline_status shows no stale guard or waitReason", async t => {
  const base = await mkdtemp(path.join(os.tmpdir(), "cline-s15-resume-"));
  t.after(() => rm(base, { recursive: true, force: true, maxRetries: 5 }));
  const cwd = path.join(base, "repo"); await mkdir(cwd); git(cwd, "init", "--quiet");
  await writeFile(path.join(cwd, "a"), "committed"); git(cwd, "add", ".");
  git(cwd, "-c", "user.name=Test", "-c", "user.email=t@example.invalid", "commit", "-qm", "baseline");
  const runs: Array<{ finish: () => void; fail: (error: unknown) => void }> = [];
  const manager = new TaskManager({ traceBase: path.join(base, "traces"), snapshotOptions: { snapshotBase: path.join(base, "snapshots") },
    runOptions: { checkoutLockDirectory: path.join(base, "locks") }, runners: { edits: (_input, signal) => new Promise((resolve, reject) => {
      runs.push({ finish: () => resolve({ text: "done", durationMs: 1, usage: { inputTokens: 10 } } as any), fail: reject });
      signal.addEventListener("abort", () => reject(new ClineRunError("cancelled", "cancelled")), { once: true });
    }) } });
  t.after(() => manager.shutdown(30_000));
  const until = async (predicate: () => boolean | Promise<boolean>) => {
    const deadline = Date.now() + TEST_WAIT_MS;
    while (!await predicate()) { assert.ok(Date.now() < deadline); await delay(10); }
  };
  const task = manager.start({ mode: "edits", prompt: "Implement", cwd, verify: { none: true, reason: "Explicit test opt-out" },
    maxFixRuns: 0, codeMap: false, provider: "p", model: "m" });
  await until(() => runs.length >= 1);
  const guard = { kind: "loop_detected", tool: "edit", target: "a", count: 3, window: 10, lastErrors: ["same failure"],
    totalToolCalls: 3, totalInputTokens: 100, budgetInputTokens: 100, filesTouched: ["a"] };
  runs[0].fail(new ClineRunError("loop_detected", "Stopped by the bridge: loop detected", { guard } as any));
  let waiting: TaskStatusView | undefined;
  await until(async () => (waiting = await manager.status(task.taskId, 0)).state === "input_required");
  assert.equal(waiting!.waitReason, "guard"); assert.ok(waiting!.guard);
  await manager.send(task.taskId, "Try a different approach", "retry");
  await until(() => runs.length >= 2);
  const running = await manager.status(task.taskId, 0);
  assert.equal(running.state, "running");
  assert.equal(running.waitReason, undefined, "the previous run's wait reason must not show while the new run runs");
  assert.equal(running.guard, undefined, "the previous run's guard report must not show at the top level while the new run runs");
  assert.equal(running.runHistory?.[0]?.guard?.kind, "loop_detected", "the history keeps it");
  runs[1].finish();
  await until(async () => (await manager.status(task.taskId, 0)).state === "done");
});

// ---- S12 leftover: a join while providers.json is momentarily absent records the real baseline ----

function fakeMutex() {
  let owner: ReleaseSettingsMutex | undefined;
  const acquire: typeof acquireSettingsMutex = async () => {
    while (owner) await delay(1);
    const release = async () => { if (owner === release) owner = undefined; };
    owner = release;
    return release;
  };
  return acquire;
}

test("S15: joining a live run while providers.json is briefly absent waits for it and journals the real entry", async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "cline-s15-join-"));
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 5 }));
  const file = path.join(dir, "providers.json");
  const full = { lastUsedProvider: "default", providers: {
    default: { settings: { model: "override" } }, other: { settings: { model: "other-original", reasoning: "high" } } } };
  await writeFile(getJournalPath(file), line({ version: 2,
    base: { hadLastUsedProvider: true, originalLastUsedProvider: "default",
      providers: { default: { hadEntry: true, hadModel: true, originalModel: "baseline", hadReasoning: false } } },
    runs: { live: { pid: 424_242, provider: "default", startedAtMs: Date.now() } } }));
  await writeFile(file, line(full));
  // The live run's Cline is rewriting the file: it disappears the moment this run holds the mutex and comes
  // back 300 ms later, so the join's read of providers.json always meets the gap.
  const inner = fakeMutex();
  let rewrite: Promise<void> | undefined;
  const acquire: typeof acquireSettingsMutex = async (...args) => {
    const release = await inner(...args);
    if (!rewrite) { await unlink(file); rewrite = delay(300).then(() => writeFile(file, line(full))); }
    return release;
  };
  let journaled: any;
  await withProviderOverride({ provider: "other", model: "override-other" }, file, undefined, async () => {
    journaled = JSON.parse(await readFile(getJournalPath(file), "utf8"));
    return { warnings: [] as string[] };
  }, { acquireSettingsMutex: acquire, isProcessAlive: () => true });
  await rewrite;
  assert.equal(journaled.base.providers.other.hadEntry, true);
  assert.equal(journaled.base.providers.other.originalModel, "other-original");
  assert.equal(journaled.base.providers.other.originalReasoning, "high");
});

// ---- Gate 2 (2): snapshot folders of tests stay out of the real %TEMP% ----

test("S15 Gate 2: CLINE_MCP_SNAPSHOT_DIR sets the default snapshot base", async t => {
  const base = await mkdtemp(path.join(os.tmpdir(), "cline-s15-snapdir-"));
  t.after(() => rm(base, { recursive: true, force: true, maxRetries: 5 }));
  const cwd = path.join(base, "repo"); await mkdir(cwd); git(cwd, "init", "--quiet");
  await writeFile(path.join(cwd, "a"), "x"); git(cwd, "add", ".");
  git(cwd, "-c", "user.name=Test", "-c", "user.email=t@example.invalid", "commit", "-qm", "baseline");
  const previous = process.env.CLINE_MCP_SNAPSHOT_DIR;
  process.env.CLINE_MCP_SNAPSHOT_DIR = path.join(base, "snapshots");
  try {
    const handle = await takeSnapshot(cwd);
    assert.equal(path.relative(path.join(base, "snapshots"), handle.directory).startsWith(".."), false, handle.directory);
    await discardSnapshot(handle);
  } finally {
    if (previous === undefined) delete process.env.CLINE_MCP_SNAPSHOT_DIR; else process.env.CLINE_MCP_SNAPSHOT_DIR = previous;
  }
});

// ---- D5: progress heartbeat on long sync calls ----

async function waitFor(predicate: () => boolean, ms = TEST_WAIT_MS) {
  const deadline = Date.now() + ms;
  while (!predicate()) { assert.ok(Date.now() < deadline, "condition not met in time"); await delay(5); }
}

test("S15 D5: a progress token gets a heartbeat while the call runs and none after it ends", async () => {
  for (const progressToken of ["tok-1", "", 0]) {
    const sent: any[] = [];
    const extra = { _meta: { progressToken }, sendNotification: async (n: any) => { sent.push(n); } };
    // The work ends only after two heartbeats arrived, so a slow event loop cannot make this flaky.
    const result = await withProgressHeartbeat(extra, async () => { await waitFor(() => sent.length >= 2); return "value"; }, { intervalMs: 20 });
    assert.equal(result, "value");
    for (const [i, n] of sent.entries()) {
      assert.equal(n.method, "notifications/progress");
      assert.equal(n.params.progressToken, progressToken);
      assert.equal(n.params.progress, i + 1);
      assert.equal(typeof n.params.message, "string");
    }
    const count = sent.length; await delay(80);
    assert.equal(sent.length, count, "no heartbeat after the call settled");
  }
});

test("S15 D5: no progress token means no notifications; a failing send never fails the call", async () => {
  const sent: any[] = [];
  assert.equal(await withProgressHeartbeat({ sendNotification: async (n: any) => { sent.push(n); } },
    async () => { await delay(60); return 1; }, { intervalMs: 10 }), 1);
  assert.equal(sent.length, 0);
  let attempts = 0;
  const rejecting = { _meta: { progressToken: 7 }, sendNotification: async () => { attempts++; throw new Error("transport closed"); } };
  assert.equal(await withProgressHeartbeat(rejecting, async () => { await waitFor(() => attempts >= 2); return 2; }, { intervalMs: 10 }), 2);
  let throws = 0;
  const throwing = { _meta: { progressToken: 8 }, sendNotification: (() => { throws++; throw new Error("sync failure"); }) as any };
  assert.equal(await withProgressHeartbeat(throwing, async () => { await waitFor(() => throws >= 2); return 3; }, { intervalMs: 10 }), 3);
  const before = attempts;
  await assert.rejects(withProgressHeartbeat(rejecting, async () => { await waitFor(() => attempts >= before + 1); throw new Error("work failed"); },
    { intervalMs: 10 }), /work failed/);
});
