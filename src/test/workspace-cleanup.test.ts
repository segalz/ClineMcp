import assert from "node:assert/strict";
import "./git-test-serial.js";
import test, { after } from "node:test";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { askClineWorkspace, hubDaemonPidsFor } from "../workspace.js";
import type { ClineInvocationOptions } from "../runner.js";

const root = await mkdtemp(path.join(os.tmpdir(), "cline-cleanup-test-"));
const repo = path.join(root, "repo");
const selection = { provider: "cline", model: "cline-free/nemotron-3.5-super-vl" };
const holders: ChildProcess[] = [];
const worktrees: string[] = [];

spawnSync("git", ["init", "-q", repo]);
await writeFile(path.join(repo, "main.ts"), "export const x = 1;\n");
spawnSync("git", ["-C", repo, "add", "."]);
spawnSync("git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-qm", "init"]);

after(async () => {
  for (const child of holders) {
    try { child.kill("SIGKILL"); } catch { /* gone */ }
  }
  await new Promise((resolve) => setTimeout(resolve, 500));
  // The locked worktree lives in the real WORKTREE_BASE: remove it so the test leaves nothing behind.
  for (const folder of worktrees) await rm(folder, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }).catch(() => {});
  spawnSync("git", ["-C", repo, "worktree", "prune"]);
  await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }).catch(() => {});
});

/** A fake Cline that answers, and leaves a live process whose cwd is the worktree (like the hub daemon). */
function lockingFake(answer: string) {
  const options: Partial<ClineInvocationOptions> = {
    promptPreamble: "", maxAttempts: 1, recordStatus: false, respectQuotaLock: false,
    checkoutLockDirectory: path.join(root, "locks"),
    deps: {
      providerSettingsPath: path.join(root, "providers.json"),
      entryPath: "mock/cline", access: async () => {},
      spawn: ((_executable: string, args: string[]) => {
        const worktree = args[args.indexOf("--cwd") + 1];
        worktrees.push(worktree);
        holders.push(spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], {
          cwd: worktree, stdio: "ignore", windowsHide: true
        }));
        const child = new EventEmitter() as any;
        child.stdout = new EventEmitter();
        child.stderr = new EventEmitter();
        child.stdout.destroy = () => {};
        child.stderr.destroy = () => {};
        child.kill = () => {};
        queueMicrotask(() => {
          child.stdout.emit("data", Buffer.from(JSON.stringify({ type: "run_result", finishReason: "completed", text: answer }) + "\n"));
          child.emit("close", 0);
        });
        return child;
      }) as any
    }
  };
  return options;
}

test("a finished answer survives a worktree that cannot be removed", { skip: process.platform !== "win32" }, async () => {
  const result = await askClineWorkspace(
    { cwd: repo, prompt: "Inspect", codeMap: false, ...selection }, undefined, lockingFake("## Result\nreview done")
  );
  assert.match(result.text ?? "", /review done/);
  assert.ok(result.warnings?.some((w) => w.includes("could not be removed")), JSON.stringify(result.warnings));
});

test("hubDaemonPidsFor matches only hub daemons started in that worktree", () => {
  const worktree = "C:\\Users\\me\\AppData\\Local\\Temp\\cline-mcp-worktrees\\review-1";
  const processes = [
    { pid: 11, commandLine: "C:\\x\\cline.exe --cline-hub-daemon --cwd C:/Users/me/AppData/Local/Temp/cline-mcp-worktrees/review-1 --host 127.0.0.1 --port 1 --pathname /hub" },
    { pid: 12, commandLine: "cline.exe --cline-hub-daemon --cwd \"C:\\Users\\me\\AppData\\Local\\Temp\\cline-mcp-worktrees\\REVIEW-1\\\" --port 2" },
    { pid: 13, commandLine: "cline.exe --cline-hub-daemon --cwd C:/Users/me/AppData/Local/Temp/cline-mcp-worktrees/review-10 --port 3" },
    { pid: 14, commandLine: "cline.exe --cwd C:/Users/me/AppData/Local/Temp/cline-mcp-worktrees/review-1 task" },
    { pid: 15, commandLine: "cline.exe --cline-hub-daemon --port 4" },
  ];
  assert.deepEqual(hubDaemonPidsFor(worktree, processes), [11, 12]);
});
