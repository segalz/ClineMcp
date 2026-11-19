import assert from "node:assert/strict";
import test, { after } from "node:test";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runCline, ClineRunError, defaultKillTree } from "../runner.js";

// Plan S3 (review items A2 + D2): when a run times out, the bridge must not report the run as finished
// (which lets the caller restore the snapshot) while any process of the CLI tree is still alive. A child
// that survives the first kill and writes a tracked file 250 ms after the deadline must be dead before the
// run settles, so the write never lands after the restore.

const root = await mkdtemp(path.join(os.tmpdir(), "cline-s3-test-"));
const spawnedProcesses: { pid: number; beat: string }[] = [];

async function heartbeatGrowing(beat: string): Promise<boolean> {
  const before = await stat(beat).catch(() => undefined);
  if (!before) return false;
  await sleep(150);
  const after = await stat(beat).catch(() => undefined);
  return after !== undefined && after.size > before.size;
}

after(async () => {
  // Check each heartbeat after the previous taskkill: killing a root can also stop its child.
  for (const { pid, beat } of spawnedProcesses) {
    if (!await heartbeatGrowing(beat)) continue;
    if (process.platform === "win32") {
      const stopped = spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
      if (stopped.status === 0 || !await heartbeatGrowing(beat)) continue;
    }
    try { process.kill(pid, "SIGKILL"); } catch { /* gone */ }
  }
  await rm(root, { recursive: true, force: true }).catch(() => {});
});

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}

function assertNoWriteAfter(file: string, settledAt: number, message: string): void {
  if (!existsSync(file)) return;
  const writtenAt = Number(readFileSync(file, "utf8"));
  assert.ok(writtenAt <= settledAt, `${message} (written ${writtenAt - settledAt} ms after)`);
}

/** A process that is dead writes no more heartbeats: sizes stay the same over a few hundred ms. */
async function assertSilent(files: string[], message: string): Promise<void> {
  const size = (file: string) => (existsSync(file) ? readFileSync(file).length : 0);
  assert.ok(files.every(file => size(file) > 0), `${message}: the heartbeat never started`);
  const before = files.map(size);
  await sleep(400);
  assert.deepEqual(files.map(size), before, message);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A fake CLI: the root stays alive and starts a child that writes `tracked.txt` after `writeAfterMs`. */
async function fakeCli(dir: string, writeAfterMs: number, rootExitsAfterMs?: number) {
  const pidsPath = path.join(dir, "pids.json");
  const trackedPath = path.join(dir, "tracked.txt");
  const childPath = path.join(dir, "child.cjs");
  const entryPath = path.join(dir, "cli.cjs");
  // Heartbeats prove a process is alive without trusting its PID, which Windows may reuse quickly under load.
  const rootBeat = path.join(dir, "root.beat"), childBeat = path.join(dir, "child.beat");
  await writeFile(childPath, [
    `const fs = require("node:fs");`,
    `setTimeout(() => fs.writeFileSync(${JSON.stringify(trackedPath)}, String(Date.now())), ${writeAfterMs});`,
    `setInterval(() => fs.appendFileSync(${JSON.stringify(childBeat)}, "."), 25);`
  ].join("\n"));
  await writeFile(entryPath, [
    `const { spawn } = require("node:child_process");`,
    `const fs = require("node:fs");`,
    // An early-exiting root leaves its child holding the output pipes, so no `close` arrives until it dies.
    `const child = spawn(process.execPath, [${JSON.stringify(childPath)}], { stdio: ${rootExitsAfterMs === undefined ? `"ignore"` : `["ignore", "inherit", "inherit"]`}, windowsHide: true });`,
    `fs.writeFileSync(${JSON.stringify(pidsPath)}, JSON.stringify({ root: process.pid, child: child.pid }));`,
    rootExitsAfterMs === undefined ? `setInterval(() => fs.appendFileSync(${JSON.stringify(rootBeat)}, "."), 25);` : `setInterval(() => { if (fs.existsSync(${JSON.stringify(childBeat)})) process.exit(0); }, 20);`
  ].join("\n"));
  return { entryPath, pidsPath, trackedPath, rootBeat, childBeat };
}

async function readPids(pidsPath: string, rootBeat: string, childBeat: string): Promise<{ root: number; child: number }> {
  const pids = JSON.parse(await readFile(pidsPath, "utf8"));
  spawnedProcesses.push({ pid: pids.root, beat: rootBeat }, { pid: pids.child, beat: childBeat });
  return pids;
}

test("S3: a timed-out run settles only after the whole CLI tree is dead, even when the first kill is ignored", { timeout: 60_000 }, async () => {
  const dir = await mkdtemp(path.join(root, "case-"));
  const timeoutMs = 6_000; // startup alone can take seconds under full-suite load
  const { entryPath, pidsPath, trackedPath, rootBeat, childBeat } = await fakeCli(dir, timeoutMs + 250);
  const settingsPath = path.join(dir, "providers.json");
  await writeFile(settingsPath, JSON.stringify({ lastUsedProvider: "cline", providers: {} }));
  let killCalls = 0;

  const work = runCline({ provider: "test-provider", model: "test-model", prompt: "test" }, undefined, {
    maxAttempts: 1, recordStatus: false, respectQuotaLock: false,
    deps: {
      entryPath, providerSettingsPath: settingsPath, statusPath: null,
      acquireSettingsMutex: async () => async () => {},
      // The budget ends with the deadline, as in a real edit run that used all of its time.
      timeoutMs, totalBudgetMs: timeoutMs,
      // The first kill attempt does nothing (a child that survives it); later attempts are real.
      killTree: (pid, signal) => { if (killCalls++ === 0) return; defaultKillTree(pid, signal); }
    }
  });
  await assert.rejects(work, (error: unknown) => error instanceof ClineRunError && error.kind === "timeout");
  const settledAt = Date.now();

  const pids = await readPids(pidsPath, rootBeat, childBeat);
  await assertSilent([rootBeat, childBeat], "the CLI tree must be dead when the run settles");
  assert.ok(killCalls >= 2, "an ignored kill must be retried until the tree is confirmed dead");

  // A restore would run now. Nothing of the old tree may write after this point.
  await sleep(timeoutMs);
  assertNoWriteAfter(trackedPath, settledAt, "no write may land after the run settled");
});

test("S3: a timed-out run with budget to spare still confirms the tree is dead before it settles", { timeout: 60_000 }, async () => {
  const dir = await mkdtemp(path.join(root, "case-"));
  const timeoutMs = 6_000; // startup alone can take seconds under full-suite load
  const { entryPath, pidsPath, trackedPath, rootBeat, childBeat } = await fakeCli(dir, timeoutMs + 250);
  const settingsPath = path.join(dir, "providers.json");
  await writeFile(settingsPath, JSON.stringify({ lastUsedProvider: "cline", providers: {} }));
  let killCalls = 0;

  const work = runCline({ provider: "test-provider", model: "test-model", prompt: "test" }, undefined, {
    maxAttempts: 1, recordStatus: false, respectQuotaLock: false,
    deps: {
      entryPath, providerSettingsPath: settingsPath, statusPath: null,
      acquireSettingsMutex: async () => async () => {},
      timeoutMs, totalBudgetMs: 60_000, settlementDeadlineMs: 100,
      killTree: (pid, signal) => { if (killCalls++ === 0) return; defaultKillTree(pid, signal); }
    }
  });
  await assert.rejects(work, (error: unknown) => error instanceof ClineRunError && error.kind === "timeout");
  const settledAt = Date.now();

  const pids = await readPids(pidsPath, rootBeat, childBeat);
  await assertSilent([rootBeat, childBeat], "the CLI tree must be dead when the run settles");
  await sleep(timeoutMs);
  assertNoWriteAfter(trackedPath, settledAt, "no write may land after the run settled");
});

test("S3 review: a child left behind by an exited root is found and killed; the exited root's PID is never killed", { timeout: 60_000 }, async () => {
  const dir = await mkdtemp(path.join(root, "case-"));
  const timeoutMs = 6_000; // startup alone can take seconds under full-suite load
  const { entryPath, pidsPath, trackedPath, rootBeat, childBeat } = await fakeCli(dir, timeoutMs + 250, 300);
  const settingsPath = path.join(dir, "providers.json");
  await writeFile(settingsPath, JSON.stringify({ lastUsedProvider: "cline", providers: {} }));
  let killCalls = 0;

  const work = runCline({ provider: "test-provider", model: "test-model", prompt: "test" }, undefined, {
    maxAttempts: 1, recordStatus: false, respectQuotaLock: false,
    deps: {
      entryPath, providerSettingsPath: settingsPath, statusPath: null,
      acquireSettingsMutex: async () => async () => {},
      timeoutMs, totalBudgetMs: timeoutMs,
      killTree: (pid, signal) => { killCalls++; defaultKillTree(pid, signal); }
    }
  });
  // The root exits without a final answer; the run ends with an error, but only after its child is dead.
  await assert.rejects(work, (error: unknown) => error instanceof ClineRunError);
  const settledAt = Date.now();

  const pids = await readPids(pidsPath, rootBeat, childBeat);
  await assertSilent([childBeat], "the orphaned child must be dead when the run settles");
  if (process.platform === "win32") assert.equal(killCalls, 0, "the root had exited: its PID may belong to another process now");
  await sleep(timeoutMs);
  assertNoWriteAfter(trackedPath, settledAt, "no write may land after the run settled");
});
