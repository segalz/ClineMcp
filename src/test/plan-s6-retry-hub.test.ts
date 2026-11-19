import assert from "node:assert/strict";
import test, { after } from "node:test";
import { EventEmitter } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { mkdir } from "node:fs/promises";
import { runCline, ClineRunError, stopDedicatedHub } from "../runner.js";
import { hasEmptyWorktreeFolder } from "../workspace.js";

// Plan S6 (review items B1, B6): a sync call gives its first attempt the whole budget (no 60/40 split), never
// repeats an attempt whose model already ran tools, starts no hub for a call refused before launch, and runs
// the ~1 s process scan only when a hub is still listening after `hub stop`.

const dir = await mkdtemp(path.join(os.tmpdir(), "cline-s6-test-"));
after(() => rm(dir, { recursive: true, force: true }));
const settingsPath = path.join(dir, "providers.json");
await writeFile(settingsPath, JSON.stringify({ lastUsedProvider: "cline", providers: {} }));

type Script = (child: any) => void;

/** A fake Cline: each spawn runs the next script; the test counts spawns. */
function fakeCline(scripts: Script[]) {
  const spawns: number[] = [];
  const spawn = (() => {
    const child = new EventEmitter() as any;
    child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
    child.stdout.destroy = () => {}; child.stderr.destroy = () => {};
    child.kill = () => { queueMicrotask(() => child.emit("close", null, "SIGTERM")); };
    const script = scripts[spawns.length] ?? scripts.at(-1)!;
    spawns.push(Date.now());
    queueMicrotask(() => script(child));
    return child;
  }) as any;
  return { spawn, spawns };
}

const line = (event: unknown) => Buffer.from(JSON.stringify(event) + "\n");
const answer = (child: any, text = "done") => { child.stdout.emit("data", line({ type: "run_result", finishReason: "completed", text })); child.emit("close", 0); };
const toolCall = (child: any) => child.stdout.emit("data", line({ type: "agent_event", event: { type: "content_start", contentType: "tool", toolName: "read_file", input: { path: "a.ts" } } }));
const transientFailure = (child: any) => { child.stderr.emit("data", Buffer.from(JSON.stringify({ type: "error", message: "upstream error: ECONNRESET" }) + "\n")); child.emit("close", 1); };

function options(spawn: any, extra: Record<string, unknown> = {}) {
  return { maxAttempts: 2, recordStatus: false, respectQuotaLock: false, deps: {
    entryPath: "mock/cline", access: async () => {}, providerSettingsPath: settingsPath, statusPath: null,
    acquireSettingsMutex: async () => async () => {}, closeGracePeriodMs: 5, killGracePeriodMs: 5, settlementDeadlineMs: 20,
    backoffMs: 0, spawn, ...extra
  } } as any;
}

test("S6: a first attempt that answers at 75% of the budget succeeds; it is not killed at 60%", async () => {
  const cline = fakeCline([child => setTimeout(() => answer(child, "slow but fine"), 1_500)]);
  const result = await runCline({ provider: "p", model: "m", prompt: "test" }, undefined,
    options(cline.spawn, { totalBudgetMs: 2_000, minRetryBudgetMs: 100 }));
  assert.equal(result.text, "slow but fine");
  assert.equal(cline.spawns.length, 1);
});

test("S6: an attempt whose model already ran tools is not repeated after a transient failure", async () => {
  const cline = fakeCline([child => { toolCall(child); transientFailure(child); }, child => answer(child, "second attempt")]);
  await assert.rejects(runCline({ provider: "p", model: "m", prompt: "test" }, undefined,
    options(cline.spawn, { totalBudgetMs: 5_000, minRetryBudgetMs: 100 })), (error: unknown) => error instanceof ClineRunError);
  assert.equal(cline.spawns.length, 1, "tools already ran: a second attempt could repeat their work");
});

test("S6: a transient failure before any tool call is still retried", async () => {
  const cline = fakeCline([transientFailure, child => answer(child, "second attempt")]);
  const result = await runCline({ provider: "p", model: "m", prompt: "test" }, undefined,
    options(cline.spawn, { totalBudgetMs: 5_000, minRetryBudgetMs: 100 }));
  assert.equal(result.text, "second attempt");
  assert.equal(cline.spawns.length, 2);
});

test("S6: a call refused by a quota lock starts no hub; a launched call starts and stops one", async () => {
  const statusPath = path.join(dir, "status.json");
  let started = 0, stopped = 0;
  const startHub = async () => { started++; return { env: { CLINE_HUB_PORT: "1" }, stop: async () => { stopped++; } }; };
  const exhausted = fakeCline([child => {
    child.stdout.emit("data", line({ type: "run_result", finishReason: "error", text: "Daily free limit reached for this model." }));
    child.emit("close", 1);
  }]);
  const quotaOptions = (spawn: any) => ({ maxAttempts: 1, deps: { ...options(spawn).deps, statusPath, startHub } });
  await assert.rejects(runCline({ provider: "p", model: "m", prompt: "test" }, undefined, quotaOptions(exhausted.spawn)),
    (error: unknown) => error instanceof ClineRunError && error.kind === "quota_exhausted");
  assert.deepEqual([started, stopped], [1, 1], "a launched call uses one hub and stops it");

  const refused = fakeCline([answer]);
  await assert.rejects(runCline({ provider: "p", model: "m", prompt: "test" }, undefined, quotaOptions(refused.spawn)),
    (error: unknown) => error instanceof ClineRunError && error.kind === "quota_exhausted" && /was not launched/.test(error.message));
  assert.equal(refused.spawns.length, 0);
  assert.deepEqual([started, stopped], [1, 1], "the refused call started no hub");
});

test("S6: stopping a hub that never listened runs neither `hub stop` nor the process scan", async () => {
  const calls: string[] = [];
  await stopDedicatedHub(4321, {
    isListening: async () => false,
    runHubStop: async () => { calls.push("hub stop"); },
    listProcesses: async () => { calls.push("scan"); return []; },
    removeFiles: async () => { calls.push("remove files"); }
  });
  assert.deepEqual(calls, ["remove files"]);
});

test("S6: the process scan runs only when the hub still listens after `hub stop`", async () => {
  for (const stillListening of [false, true]) {
    const calls: string[] = [];
    let probes = 0;
    await stopDedicatedHub(4321, {
      isListening: async () => (probes++ === 0 ? true : stillListening),
      runHubStop: async () => { calls.push("hub stop"); },
      listProcesses: async () => { calls.push("scan"); return []; },
      removeFiles: async () => { calls.push("remove files"); }
    });
    const expected = stillListening && process.platform === "win32" ? ["hub stop", "scan", "remove files"] : ["hub stop", "remove files"];
    assert.deepEqual(calls, expected, `still listening after hub stop: ${stillListening}`);
  }
});

test("S6 review: an explicit canRetry still decides, even after tool calls", async () => {
  const cline = fakeCline([child => { toolCall(child); transientFailure(child); }, child => answer(child, "second attempt")]);
  const result = await runCline({ provider: "p", model: "m", prompt: "test" }, undefined,
    { ...options(cline.spawn, { totalBudgetMs: 5_000, minRetryBudgetMs: 100 }), canRetry: () => true });
  assert.equal(result.text, "second attempt");
  assert.equal(cline.spawns.length, 2);
});

test("S6 review: a hub that wrote its discovery record is stopped even when the port probe misses it", async () => {
  const calls: string[] = [];
  await stopDedicatedHub(4321, {
    hubStarted: async () => true,
    isListening: async () => false,
    runHubStop: async () => { calls.push("hub stop"); },
    listProcesses: async () => { calls.push("scan"); return []; },
    removeFiles: async () => { calls.push("remove files"); }
  });
  assert.deepEqual(calls, ["hub stop", "remove files"]);
});

test("S6 review: the neutral-hub scan is triggered only by an emptied worktree folder", async () => {
  const base = await mkdtemp(path.join(dir, "worktrees-"));
  assert.equal(await hasEmptyWorktreeFolder(base, 0), false, "no folders");
  await mkdir(path.join(base, "review-busy", "src"), { recursive: true });
  await writeFile(path.join(base, "review-busy", "src", "index.ts"), "export {};"); // in use = holds a file (S6b)
  assert.equal(await hasEmptyWorktreeFolder(base, 0), false, "a folder in use is not a leftover");
  await mkdir(path.join(base, "review-left"));
  assert.equal(await hasEmptyWorktreeFolder(base, 0), true);
  assert.equal(await hasEmptyWorktreeFolder(path.join(base, "missing"), 0), false);
});
