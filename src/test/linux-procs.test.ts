import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import test from "node:test";
import { hubDaemonPidsOnPort, listClineProcesses } from "../procs.js";
import { hubDaemonPidsFor } from "../workspace.js";

const files: Record<string, string> = {
  "/proc/42/cmdline": "node\0/x/cline/bin/cline\0--cline-hub-daemon\0--cwd\0/tmp/my dir\0--port\x00123\0",
  "/proc/42/status": "Name:\tnode\nUid:\t1000\t1000\t1000\t1000\n",
  "/proc/43/cmdline": "node\0/x/cline/bin/cline\0--cline-hub-daemon\0--port\x00124\0",
  "/proc/43/status": "Name:\tnode\nUid:\t0\t0\t0\t0\n",
  "/proc/1/cmdline": "/sbin/init\0",
  "/proc/1/status": "Name:\tinit\nUid:\t0\t0\t0\t0\n"
};
const readFile = async (file: string) => {
  if (file in files) return files[file];
  throw Object.assign(new Error("gone"), { code: "ENOENT" });
};

test("linux listing: own-user cline processes only, quoted cwd", async () => {
  const list = await listClineProcesses(5000, undefined, { platform: "linux", selfPid: 7, uid: 1000,
    readdir: async () => ["1", "7", "42", "43", "self", "abc", "99"], readFile });
  assert.deepEqual(list, [{ pid: 42, commandLine: 'node /x/cline/bin/cline --cline-hub-daemon --cwd "/tmp/my dir" --port 123' }]);
  assert.deepEqual(hubDaemonPidsOnPort(123, list!), [42]);
  assert.deepEqual(hubDaemonPidsFor("/tmp/my dir", list!), [42]);
});
test("linux listing: unreadable /proc or no time left is unknown (undefined)", async () => {
  assert.equal(await listClineProcesses(5000, undefined, { platform: "linux", readdir: async () => { throw new Error("EACCES"); }, readFile }), undefined);
  assert.equal(await listClineProcesses(0, undefined, { platform: "linux", readdir: async () => [], readFile }), undefined);
});
test("darwin stays an empty list", async () => {
  assert.deepEqual(await listClineProcesses(5000, undefined, { platform: "darwin" }), []);
});
test("linux real /proc: a live process with a hub-like argv is listed", { skip: process.platform !== "linux" && "Linux only" }, async () => {
  const child = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)", "--", "--cline-hub-daemon", "--cwd", "/tmp/x", "--port", "54321"], { stdio: "ignore" });
  await new Promise<void>((resolve, reject) => { child.once("spawn", () => resolve()); child.once("error", reject); });
  try {
    let pids: number[] = [];
    for (let i = 0; i < 20 && pids.length === 0; i++) {
      pids = hubDaemonPidsOnPort(54321, (await listClineProcesses()) ?? []);
      if (pids.length === 0) await new Promise(r => setTimeout(r, 100));
    }
    assert.deepEqual(pids, [child.pid]);
  } finally { child.kill("SIGKILL"); }
});
