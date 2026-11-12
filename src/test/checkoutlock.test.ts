import assert from "node:assert/strict";
import "./git-test-serial.js";
import test from "node:test";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { acquire, CheckoutBusyError, checkoutLockPath, ownsCheckoutLock } from "../checkoutlock.js";
import { applyClineEdits } from "../edits.js";
import { ClineRunError } from "../runner.js";
import { TaskManager } from "../tasks.js";

async function fixture(t: test.TestContext) {
  const base = await mkdtemp(path.join(os.tmpdir(), "cline-checkoutlock-test-"));
  t.after(() => rm(base, { recursive: true, force: true, maxRetries: 5 }));
  const root = path.join(base, "repo"), locks = path.join(base, "locks");
  await mkdir(root); await mkdir(locks);
  const git = (...args: string[]) => {
    const result = spawnSync(process.platform === "win32" ? "git.exe" : "git", ["-C", root, ...args], { encoding: "utf8", windowsHide: true, timeout: 10_000 });
    assert.equal(result.status, 0, result.stderr);
  };
  git("init", "--quiet"); await writeFile(path.join(root, "a"), "baseline"); git("add", ".");
  git("-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "fixture");
  return { base, root, locks };
}
const busy = (err: unknown) => err instanceof CheckoutBusyError && err.kind === "checkout_busy";

test("orphaned reaper metadata and incomplete dead claims are reclaimed; live reapers remain busy", async t => {
  const { root, locks } = await fixture(t);
  const file = checkoutLockPath(root, locks);
  const orphan = spawnSync(process.execPath, ["--input-type=module", "-e", `
    import { mkdirSync, writeFileSync } from 'node:fs';
    const file = process.argv[1];
    const metadata = JSON.stringify({ pid: process.pid, time: new Date().toISOString(), token: 'orphan' });
    writeFileSync(file, metadata); writeFileSync(file + '.reap', metadata);
    mkdirSync(file + '.reap-claims');
    writeFileSync(file + '.reap-claims/' + process.pid + '-00000000-0000-0000-0000-000000000000.json', '');
  `, file], { encoding: "utf8", windowsHide: true, timeout: 10_000 });
  assert.equal(orphan.status, 0, orphan.stderr);
  const staleMetadata = await readFile(file, "utf8");
  const release = acquire(root, { lockDirectory: locks }); release();
  await assert.rejects(readFile(file + ".reap"), { code: "ENOENT" });
  assert.deepEqual(fs.readdirSync(file + ".reap-claims"), []);
  await writeFile(file, staleMetadata);
  await writeFile(file + ".reap", JSON.stringify({ pid: process.pid, time: new Date().toISOString() }));
  assert.throws(() => acquire(root, { lockDirectory: locks }), busy);
  assert.equal(await readFile(file, "utf8"), staleMetadata);
});

test("failed lock writes close the descriptor before Windows-style unlink cleanup", async t => {
  const { root, locks } = await fixture(t);
  const file = checkoutLockPath(root, locks);
  const originalClose = fs.closeSync, originalUnlink = fs.unlinkSync;
  const injected = Object.assign(new Error("injected write failure"), { code: "ENOSPC" });
  let closed = false, unlinked = false;
  t.mock.method(fs, "writeFileSync", () => { throw injected; });
  t.mock.method(fs, "closeSync", (fd: number) => { originalClose(fd); closed = true; });
  t.mock.method(fs, "unlinkSync", (target: fs.PathLike) => {
    if (!closed) throw Object.assign(new Error("Windows handle is open"), { code: "EBUSY" });
    originalUnlink(target); unlinked = true;
  });
  syncBuiltinESMExports();
  try { assert.throws(() => acquire(root, { lockDirectory: locks }), error => error === injected); }
  finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
  assert.equal(closed, true); assert.equal(unlinked, true);
  await assert.rejects(readFile(file), { code: "ENOENT" });
  const release = acquire(root, { lockDirectory: locks }); release();
});
async function until(check: () => Promise<boolean>) {
  // Whole-suite parallel Git/process work can delay a fake runner before it is scheduled.
  const deadline = Date.now() + 20_000;
  while (!await check()) {
    assert.ok(Date.now() < deadline, "condition did not become true");
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

test("canonical path aliases share one writer, releases are idempotent and replaced locks survive", async t => {
  const { base, root, locks } = await fixture(t);
  const alias = path.join(base, "alias");
  await symlink(root, alias, process.platform === "win32" ? "junction" : "dir");
  const release = acquire(root, { lockDirectory: locks });
  t.after(release);
  assert.equal(ownsCheckoutLock(release, alias), true);
  assert.throws(() => acquire(alias, { lockDirectory: locks }), busy);
  const file = checkoutLockPath(root, locks);
  const holder = JSON.parse(await readFile(file, "utf8"));
  assert.equal(holder.pid, process.pid); assert.ok(Number.isFinite(Date.parse(holder.time)));
  release(); release();
  assert.equal(ownsCheckoutLock(release, root), false);
  const next = acquire(alias, { lockDirectory: locks });
  release(); assert.throws(() => acquire(root, { lockDirectory: locks }), busy);
  await writeFile(file, JSON.stringify({ pid: process.pid, token: "external" }));
  next(); assert.equal(JSON.parse(await readFile(file, "utf8")).token, "external");
});

test("cross-process contention and a dead holder's stale lock", async t => {
  const { root, locks } = await fixture(t);
  const moduleUrl = new URL("../checkoutlock.js", import.meta.url).href;
  const child = (source: string) => spawnSync(process.execPath, ["--input-type=module", "-e", source, root, locks], { encoding: "utf8", windowsHide: true, timeout: 10_000 });
  const release = acquire(root, { lockDirectory: locks });
  const result = child(`import { acquire } from ${JSON.stringify(moduleUrl)}; try { acquire(process.argv[1], {lockDirectory:process.argv[2]}); process.exit(2); } catch(e) { if(e.kind !== 'checkout_busy') throw e; console.log(e.kind); }`);
  assert.equal(result.status, 0, result.stderr); assert.match(result.stdout, /checkout_busy/);
  release();
  const stale = child(`import { acquire } from ${JSON.stringify(moduleUrl)}; acquire(process.argv[1], {lockDirectory:process.argv[2]});`);
  assert.equal(stale.status, 0, stale.stderr);
  const next = acquire(root, { lockDirectory: locks }); next();
  await assert.rejects(readFile(checkoutLockPath(root, locks)), { code: "ENOENT" });
});

test("live and incomplete file locks are busy, regardless of their age", async t => {
  const { root, locks } = await fixture(t);
  const file = checkoutLockPath(root, locks);
  for (const content of [JSON.stringify({ pid: process.pid, time: "1900-01-01" }), "", "{", JSON.stringify({ pid: -1 })]) {
    await writeFile(file, content);
    assert.throws(() => acquire(root, { lockDirectory: locks }), busy);
  }
});

test("sync edits refuses a held checkout before launching Cline", async t => {
  const { root, locks } = await fixture(t);
  const release = acquire(root, { lockDirectory: locks }); t.after(release);
  await mkdir(path.join(root, "subdir"));
  await assert.rejects(applyClineEdits({ cwd: path.join(root, "subdir"), prompt: "edit", provider: "p", model: "m" }, undefined,
    { checkoutLockDirectory: locks }), busy);
});

test("async edits retains its lock across waiting and resume, blocks sync/async writers, and releases on completion", async t => {
  const { root, locks, base } = await fixture(t);
  const runs: Array<{ resolve: (value: any) => void; options: any }> = [];
  const manager = new TaskManager({ traceBase: path.join(base, "traces"), runOptions: { checkoutLockDirectory: locks },
    gitDiffStat: async () => "", runners: { edits: (_input, _signal, options) => new Promise(resolve => runs.push({ resolve, options })) } });
  t.after(() => manager.shutdown());
  const input = { mode: "edits" as const, cwd: root, prompt: "edit", provider: "p", model: "m" };
  const first = manager.start(input);
  await until(async () => runs.length === 1);
  const lease = runs[0].options.checkoutLock;
  assert.ok(ownsCheckoutLock(lease, root));
  runs[0].resolve({ text: "QUESTION: Continue?", durationMs: 1 });
  await until(async () => (await manager.status(first.taskId, 0)).state === "input_required");
  assert.throws(() => acquire(root, { lockDirectory: locks }), busy);
  await assert.rejects(applyClineEdits(input, undefined, { checkoutLockDirectory: locks }), busy);
  const second = manager.start(input);
  await until(async () => (await manager.status(second.taskId, 0)).state === "failed");
  const failed = await manager.result(second.taskId);
  assert.match(failed.error!, /checkout_busy/); assert.equal(failed.log_run_hint, null); assert.equal(runs.length, 1);
  await manager.send(first.taskId, "Continue");
  assert.equal(runs.length, 2); assert.equal(runs[1].options.checkoutLock, lease);
  runs[1].resolve({ text: "done", durationMs: 1 });
  await until(async () => (await manager.status(first.taskId, 0)).state === "done");
  const release = acquire(root, { lockDirectory: locks }); release();
});

test("async edits releases on runner failure, waiting cancellation, shutdown and active abort", async t => {
  const { root, locks, base } = await fixture(t);
  const input = { mode: "edits" as const, cwd: root, prompt: "edit", provider: "p", model: "m" };
  for (const action of ["failure", "cancel-wait", "shutdown-wait", "cancel-active"] as const) {
    let launched = false;
    const manager = new TaskManager({ traceBase: path.join(base, action), runOptions: { checkoutLockDirectory: locks },
      runners: { edits: async (_input, signal) => {
        launched = true;
        if (action === "failure") throw new Error("runner failed");
        if (action !== "cancel-active") return { text: "QUESTION: Continue?", durationMs: 1 } as any;
        return new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new ClineRunError("cancelled", "cancelled")), { once: true }));
      } } });
    t.after(() => manager.shutdown());
    const task = manager.start(input);
    await until(async () => launched);
    if (action === "failure") await until(async () => (await manager.status(task.taskId, 0)).state === "failed");
    else if (action === "cancel-active") await manager.cancel(task.taskId);
    else {
      await until(async () => (await manager.status(task.taskId, 0)).state === "input_required");
      if (action === "shutdown-wait") await manager.shutdown(); else await manager.cancel(task.taskId);
    }
    const release = acquire(root, { lockDirectory: locks }); release();
    await manager.shutdown();
  }
});
