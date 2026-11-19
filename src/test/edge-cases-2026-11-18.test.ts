import assert from "node:assert/strict";
import "./git-test-serial.js";
import test, { after } from "node:test";
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createdFiles, discardSnapshot, restoreSnapshot, takeSnapshot } from "../snapshot.js";
import { holderIsDead, processStartMs } from "../checkoutlock.js";
import { hubDaemonPidsOnPort } from "../procs.js";
import { killTreeAndWait } from "../runner.js";

const roots: string[] = [];
after(async () => { for (const root of roots) await rm(root, { recursive: true, force: true }).catch(() => {}); });

async function repo(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "cline-edge-test-"));
  roots.push(root);
  const git = (...args: string[]) => spawnSync("git", ["-C", root, "-c", "user.name=t", "-c", "user.email=t@example.com", ...args]);
  git("init", "-q");
  await writeFile(path.join(root, ".gitignore"), "dist/\n");
  await writeFile(path.join(root, "a.ts"), "export const a = 1;\n");
  git("add", ".");
  git("commit", "-qm", "init");
  await writeFile(path.join(root, "notes.txt"), "untracked baseline\n");
  return root;
}
const snapshotBase = () => path.join(os.tmpdir(), "cline-edge-snapshots");

test("restore undoes a .gitignore edit that hid a new file and a changed baseline file", async () => {
  const root = await repo();
  const handle = await takeSnapshot(root, { snapshotBase: snapshotBase() });
  await writeFile(path.join(root, ".gitignore"), "dist/\nsecret.txt\nnotes.txt\n");
  await writeFile(path.join(root, "secret.txt"), "new file the model hid\n");
  await writeFile(path.join(root, "notes.txt"), "changed by the model\n");
  const report = await restoreSnapshot(handle);
  await discardSnapshot(handle);
  assert.deepEqual(report.failed, []);
  assert.equal(existsSync(path.join(root, "secret.txt")), false);
  assert.equal(await readFile(path.join(root, "notes.txt"), "utf8"), "untracked baseline\n");
  assert.equal(await readFile(path.join(root, ".gitignore"), "utf8"), "dist/\n");
});

test("restore removes a self-ignoring .gitignore the model created, and the files it hid", async () => {
  const root = await repo();
  const handle = await takeSnapshot(root, { snapshotBase: snapshotBase() });
  await mkdir(path.join(root, "scratch"));
  await writeFile(path.join(root, "scratch", ".gitignore"), "*\n");
  await writeFile(path.join(root, "scratch", "debug_test.py"), "print(1)\n");
  const report = await restoreSnapshot(handle);
  await discardSnapshot(handle);
  assert.deepEqual(report.failed, []);
  assert.equal(existsSync(path.join(root, "scratch")), false);
});

test("restore keeps .gitignore files that were already present inside ignored folders", async () => {
  const root = await repo();
  await mkdir(path.join(root, "dist", "pkg"), { recursive: true });
  await writeFile(path.join(root, "dist", "pkg", ".gitignore"), "*.log\n");
  const handle = await takeSnapshot(root, { snapshotBase: snapshotBase() });
  const report = await restoreSnapshot(handle);
  await discardSnapshot(handle);
  assert.deepEqual(report.failed, []);
  assert.equal(existsSync(path.join(root, "dist", "pkg", ".gitignore")), true);
});

test("restore undoes an info/exclude edit and removes the file it hid", async () => {
  const root = await repo();
  const exclude = path.join(root, ".git", "info", "exclude");
  const before = existsSync(exclude) ? await readFile(exclude, "utf8") : null;
  const handle = await takeSnapshot(root, { snapshotBase: snapshotBase() });
  await mkdir(path.dirname(exclude), { recursive: true });
  await writeFile(exclude, "hidden.txt\n");
  await writeFile(path.join(root, "hidden.txt"), "x\n");
  const report = await restoreSnapshot(handle);
  await discardSnapshot(handle);
  assert.deepEqual(report.failed, []);
  assert.equal(existsSync(path.join(root, "hidden.txt")), false);
  assert.equal(existsSync(exclude) ? await readFile(exclude, "utf8") : null, before);
});

test("createdFiles lists new files and skips ignored build output", async () => {
  const root = await repo();
  const handle = await takeSnapshot(root, { snapshotBase: snapshotBase() });
  await writeFile(path.join(root, "debug_test.py"), "print(1)\n");
  await mkdir(path.join(root, "dist"));
  await writeFile(path.join(root, "dist", "out.js"), "1\n");
  await writeFile(path.join(root, "a.ts"), "export const a = 2;\n");
  assert.deepEqual(await createdFiles(handle), ["debug_test.py"]);
  await discardSnapshot(handle);
});

test("a lock whose PID now belongs to a newer process is dead; unknown start time stays busy", async () => {
  const pid = process.ppid;
  const written = new Date(Date.now() - 60_000).toISOString();
  assert.equal(await holderIsDead({ pid, time: written }, () => Date.now()), true);
  assert.equal(await holderIsDead({ pid, time: written }, () => Date.now() - 3_600_000), false);
  assert.equal(await holderIsDead({ pid, time: written }, () => undefined), false);
  assert.equal(await holderIsDead({ pid }, () => Date.now()), false);
  assert.equal(await holderIsDead({ pid: process.pid, time: written }, () => Date.now()), false);
});

test("processStartMs reads this process's real start time", { skip: !["win32", "linux"].includes(process.platform) }, async () => {
  const started = await processStartMs(process.pid);
  assert.ok(started !== undefined);
  assert.ok(Math.abs(started! - (Date.now() - process.uptime() * 1000)) < 10_000, String(started));
});

test("hubDaemonPidsOnPort matches only the hub on that exact port", () => {
  const processes = [
    { pid: 1, commandLine: "cline.exe --cline-hub-daemon --cwd C:/x --host 127.0.0.1 --port 25463 --pathname /hub" },
    { pid: 2, commandLine: "cline.exe --cline-hub-daemon --cwd C:/x --port 254630" },
    { pid: 3, commandLine: "cline.exe task --port 25463" },
    { pid: 4, commandLine: "cline.exe --cline-hub-daemon --port=25463" },
  ];
  assert.deepEqual(hubDaemonPidsOnPort(25463, processes), [1, 4]);
});

test("killTreeAndWait returns only after the process is gone", async () => {
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore", windowsHide: true });
  await new Promise((resolve) => child.once("spawn", resolve));
  assert.equal(await killTreeAndWait(child.pid!), true);
  assert.throws(() => process.kill(child.pid!, 0));
});
