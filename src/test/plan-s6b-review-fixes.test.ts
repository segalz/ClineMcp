import assert from "node:assert/strict";
import test, { after } from "node:test";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runCline, ClineRunError, stopDedicatedHub } from "../runner.js";
import { hasEmptyWorktreeFolder } from "../workspace.js";

// Plan S6b: fixes for what the stronger reviewers (Codex GPT-6.2-Astra, Gemini 4 Neon/Hydrogen) found in S6.
// Each claim was checked against the code before this test was written.

const dir = await mkdtemp(path.join(os.tmpdir(), "cline-s6b-test-"));
after(() => rm(dir, { recursive: true, force: true }));
const settingsPath = path.join(dir, "providers.json");
await writeFile(settingsPath, JSON.stringify({ lastUsedProvider: "cline", providers: {} }));

type Script = (child: any) => void;

function fakeCline(scripts: Script[]) {
  const spawns: string[][] = [];
  const spawn = ((_exe: string, args: string[]) => {
    const child = new EventEmitter() as any;
    child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
    child.stdout.destroy = () => {}; child.stderr.destroy = () => {};
    child.kill = () => { queueMicrotask(() => child.emit("close", null, "SIGTERM")); };
    const script = scripts[spawns.length] ?? scripts.at(-1)!;
    spawns.push(args);
    queueMicrotask(() => script(child));
    return child;
  }) as any;
  return { spawn, spawns };
}

const line = (event: unknown) => Buffer.from(JSON.stringify(event) + "\n");
const answer = (child: any, text = "done") => { child.stdout.emit("data", line({ type: "run_result", finishReason: "completed", text })); child.emit("close", 0); };
const transientFailure = (child: any) => { child.stderr.emit("data", Buffer.from(JSON.stringify({ type: "error", message: "upstream error: ECONNRESET" }) + "\n")); child.emit("close", 1); };

function options(spawn: any, extra: Record<string, unknown> = {}, top: Record<string, unknown> = {}) {
  return { maxAttempts: 2, recordStatus: false, respectQuotaLock: false, ...top, deps: {
    entryPath: "mock/cline", access: async () => {}, providerSettingsPath: settingsPath, statusPath: null,
    acquireSettingsMutex: async () => async () => {}, closeGracePeriodMs: 5, killGracePeriodMs: 5, settlementDeadlineMs: 20,
    backoffMs: 0, minRetryBudgetMs: 100, totalBudgetMs: 5_000, spawn, ...extra
  } } as any;
}

// --- Retry after tool activity the guard does not count (Astra finding 1, Hydrogen/Neon finding 5) ---

for (const [name, event] of [
  ["a top-level tool_call event", { type: "tool_call", name: "write_to_file", input: { path: "a.ts" } }],
  ["a nested tool_use event", { type: "agent_event", event: { type: "tool_use", name: "write_to_file" } }]
] as const) {
  test(`S6b: ${name} counts as tool activity, so the attempt is not repeated`, async () => {
    const cline = fakeCline([child => { child.stdout.emit("data", line(event)); transientFailure(child); }, child => answer(child)]);
    await assert.rejects(runCline({ provider: "p", model: "m", prompt: "test" }, undefined, options(cline.spawn)),
      (error: unknown) => error instanceof ClineRunError);
    assert.equal(cline.spawns.length, 1);
  });
}

test("S6b: a tool event too long to parse (dropped by the line splitter) still blocks a retry", async () => {
  const huge = { type: "agent_event", event: { type: "content_start", contentType: "tool", toolName: "write_to_file",
    input: { path: "big.ts", content: "x".repeat(1_100_000) } } };
  const cline = fakeCline([child => { child.stdout.emit("data", line(huge)); transientFailure(child); }, child => answer(child)]);
  await assert.rejects(runCline({ provider: "p", model: "m", prompt: "test" }, undefined, options(cline.spawn)),
    (error: unknown) => error instanceof ClineRunError);
  assert.equal(cline.spawns.length, 1);
});

test("S6b: a plain non-JSON stdout line is not tool activity; the transient failure is still retried", async () => {
  const cline = fakeCline([child => { child.stdout.emit("data", Buffer.from("warning: something noisy\n")); transientFailure(child); },
    child => answer(child, "second attempt")]);
  const result = await runCline({ provider: "p", model: "m", prompt: "test" }, undefined, options(cline.spawn));
  assert.equal(result.text, "second attempt");
  assert.equal(cline.spawns.length, 2);
});

// --- CLI timeout rounding (Astra finding 3) ---

test("S6b: the CLI --timeout is rounded up, never below the time the bridge allows", async () => {
  const cline = fakeCline([child => answer(child)]);
  await runCline({ provider: "p", model: "m", prompt: "test" }, undefined, options(cline.spawn, { totalBudgetMs: 1_990 }, { maxAttempts: 1 }));
  const args = cline.spawns[0];
  assert.equal(args[args.indexOf("--timeout") + 1], "2");
});

// --- Hub start: failure, cancel and deadline (Astra 4 and 7, Hydrogen 4, Neon 4) ---

test("S6b: a hub that fails to start ends the call before Cline is launched", async () => {
  const cline = fakeCline([child => answer(child)]);
  await assert.rejects(runCline({ provider: "p", model: "m", prompt: "test" }, undefined,
    options(cline.spawn, { startHub: async () => { throw new Error("no free port"); } })),
  (error: unknown) => error instanceof ClineRunError && error.kind === "launch_failed");
  assert.equal(cline.spawns.length, 0, "without its own hub Cline could resolve relative paths in another folder");
});

test("S6b: a call cancelled before launch starts no hub", async () => {
  const controller = new AbortController();
  let started = 0;
  const cline = fakeCline([child => answer(child)]);
  // No cwd: the cancel lands during the launch preparation (entry access), after the cwd check.
  await assert.rejects(runCline({ provider: "p", model: "m", prompt: "test" }, controller.signal,
    options(cline.spawn, {
      access: async () => { controller.abort(); },
      startHub: async () => { started++; return { env: {}, stop: async () => {} }; }
    })),
  (error: unknown) => error instanceof ClineRunError && error.kind === "cancelled");
  assert.equal(started, 0);
  assert.equal(cline.spawns.length, 0);
});

test("S6b: a hub start that uses up the budget does not launch Cline", async () => {
  let stops = 0;
  const cline = fakeCline([child => answer(child)]);
  await assert.rejects(runCline({ provider: "p", model: "m", prompt: "test" }, undefined,
    options(cline.spawn, { totalBudgetMs: 200, minRetryBudgetMs: 0,
      startHub: async () => { await new Promise(r => setTimeout(r, 400)); return { env: {}, stop: async () => { stops++; } }; } }, { maxAttempts: 1 })),
  (error: unknown) => error instanceof ClineRunError && error.kind === "timeout");
  assert.equal(cline.spawns.length, 0);
  assert.equal(stops, 0, "Cline never launched, so no hub exists to stop");
});

// --- Hub stop: a failure must not hide the run's outcome (Hydrogen 3) ---

test("S6b: a hub that cannot be stopped does not hide the answer; it is reported as a warning", async () => {
  const cline = fakeCline([child => answer(child, "the answer")]);
  const result = await runCline({ provider: "p", model: "m", prompt: "test" }, undefined,
    options(cline.spawn, { startHub: async () => ({ env: {}, stop: async () => { throw new Error("hub stop crashed"); } }) }));
  assert.equal(result.text, "the answer");
  assert.ok(result.warnings?.some(w => /hub/i.test(w) && /hub stop crashed/.test(w)), JSON.stringify(result.warnings));
});

test("S6b: a hub that cannot be stopped is noted on the run's error too", async () => {
  const cline = fakeCline([transientFailure]);
  await assert.rejects(runCline({ provider: "p", model: "m", prompt: "test" }, undefined,
    options(cline.spawn, { startHub: async () => ({ env: {}, stop: async () => { throw new Error("hub stop crashed"); } }) }, { maxAttempts: 1 })),
  (error: unknown) => error instanceof ClineRunError && (error.notes ?? []).some(n => /hub stop crashed/.test(n)));
});

// --- stopDedicatedHub: failed stop, late-binding hub (Neon 3, Astra 5) ---

test("S6b: when `hub stop` fails for a hub that started, the process scan still runs", { skip: process.platform !== "win32" && process.platform !== "linux" }, async () => {
  const calls: string[] = [];
  await stopDedicatedHub(4321, {
    hubStarted: async () => true,
    isListening: async () => false,
    runHubStop: async () => { calls.push("hub stop"); return false; },
    listProcesses: async () => { calls.push("scan"); return []; },
    removeFiles: async () => { calls.push("remove files"); }
  });
  assert.deepEqual(calls, ["hub stop", "scan", "remove files"]);
});

test("S6b: a hub that binds its port just after the first probe is still stopped", async () => {
  const calls: string[] = [];
  const probes = [false, true, false];
  await stopDedicatedHub(4321, {
    hubStarted: async () => false,
    isListening: async () => probes.shift() ?? false,
    runHubStop: async () => { calls.push("hub stop"); return true; },
    listProcesses: async () => { calls.push("scan"); return []; },
    removeFiles: async () => { calls.push("remove files"); }
  });
  assert.deepEqual(calls, ["hub stop", "remove files"]);
});

// --- Leftover worktree folders (Neon 2, Astra 6, Hydrogen 1) ---

test("S6b: a worktree left with only empty subfolders (a monorepo package) counts as a leftover", async () => {
  const base = await mkdtemp(path.join(dir, "wt-"));
  await mkdir(path.join(base, "review-mono", "packages", "app"), { recursive: true });
  assert.equal(await hasEmptyWorktreeFolder(base, 0), true);
});

test("S6b: a regular file named review-* is not a leftover worktree", async () => {
  const base = await mkdtemp(path.join(dir, "wt-"));
  await writeFile(path.join(base, "review-note"), "not a folder");
  assert.equal(await hasEmptyWorktreeFolder(base, 0), false);
});

test("S6b: a worktree that still holds a file is not a leftover", async () => {
  const base = await mkdtemp(path.join(dir, "wt-"));
  await mkdir(path.join(base, "review-busy", "packages", "app"), { recursive: true });
  await writeFile(path.join(base, "review-busy", "packages", "app", "index.ts"), "export {};");
  assert.equal(await hasEmptyWorktreeFolder(base, 0), false);
});

test("S6b review: a fresh empty worktree folder (maybe still being created) is not a leftover", async () => {
  const base = await mkdtemp(path.join(dir, "wt-"));
  await mkdir(path.join(base, "review-new"));
  assert.equal(await hasEmptyWorktreeFolder(base), false, "younger than LEFTOVER_MIN_AGE_MS");
  assert.equal(await hasEmptyWorktreeFolder(base, 0), true);
});
