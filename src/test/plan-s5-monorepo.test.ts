import assert from "node:assert/strict";
import "./git-test-serial.js";
import { TEST_WAIT_MS } from "./test-waits.js";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { FinalCheckLifecycle, subfolderOf } from "../finalcheck.js";
import { TaskManager, type TaskStatusView } from "../tasks.js";
import { editQuestion } from "../edits.js";
import { ClineRunError, type ClineInvocationOptions } from "../runner.js";
import { askClineWorkspace } from "../workspace.js";
import { EventEmitter } from "node:events";

// Plan S5 (review item A6): when `cwd` is a monorepo subfolder, the checkout lock, identity and snapshot stay at
// the repository root, but the Cline run and the final check run in the requested subfolder.
// Mirrors openCodeHelperMcp test/plan-s5-monorepo.test.js.

function git(cwd: string, ...args: string[]): void {
  const r = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8", windowsHide: true, env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" } });
  assert.equal(r.status, 0, r.stderr);
}

async function monorepo(t: test.TestContext) {
  const base = await realpath(await mkdtemp(path.join(os.tmpdir(), "cline-s5-")));
  t.after(() => rm(base, { recursive: true, force: true, maxRetries: 5 }));
  const root = path.join(base, "repo"), app = path.join(root, "packages", "app");
  await mkdir(app, { recursive: true });
  git(root, "init", "--quiet");
  await writeFile(path.join(root, "top.txt"), "top baseline");
  await writeFile(path.join(app, "a.txt"), "app baseline");
  git(root, "add", ".");
  git(root, "-c", "user.name=Test", "-c", "user.email=t@example.invalid", "commit", "-qm", "baseline");
  return { base, root, app, locks: path.join(base, "locks"), snapshots: path.join(base, "snapshots") };
}

/** A check that passes only when it runs in `dir`. */
const runsIn = (dir: string) => ({ command: process.execPath, args: ["-e", `process.exit(process.cwd() === ${JSON.stringify(dir)} ? 0 : 9)`] });

test("S5: the final check runs in the requested subfolder while the snapshot covers the whole repository", async t => {
  const f = await monorepo(t);
  const lifecycle = new FinalCheckLifecycle({ prompt: "Implement", cwd: f.app, verify: runsIn(f.app), maxFixRuns: 0 }, {
    resolveRoot: async () => f.root, fits: () => true, question: editQuestion, lockDirectory: f.locks,
    snapshotOptions: { snapshotBase: f.snapshots },
    run: async () => { await writeFile(path.join(f.app, "a.txt"), "app edited"); return { text: "done", durationMs: 1 } as any; }
  });
  await lifecycle.execute(new AbortController().signal);
  assert.equal(lifecycle.root, f.root, "lock, identity and snapshot stay at the repository root");
  assert.equal(lifecycle.workDir, f.app, "the run and the check use the requested subfolder");
  assert.equal(lifecycle.verification.attempts[0]?.exitCode, 0, "the check must run in packages/app");
  assert.equal(lifecycle.phase, "done");
  lifecycle.release();
});

test("S5: a failed check in a subfolder restores files outside the subfolder too", async t => {
  const f = await monorepo(t);
  const lifecycle = new FinalCheckLifecycle({ prompt: "Implement", cwd: f.app,
    verify: { command: process.execPath, args: ["-e", "process.exit(1)"] }, maxFixRuns: 0 }, {
    resolveRoot: async () => f.root, fits: () => true, question: editQuestion, lockDirectory: f.locks,
    snapshotOptions: { snapshotBase: f.snapshots },
    run: async () => {
      await writeFile(path.join(f.app, "a.txt"), "app edited");
      await writeFile(path.join(f.root, "top.txt"), "top edited");
      return { text: "done", durationMs: 1 } as any;
    }
  });
  await lifecycle.execute(new AbortController().signal);
  assert.equal(lifecycle.waitReason, "verify_failed");
  assert.equal(await lifecycle.restore(), true);
  assert.equal(await readFile(path.join(f.root, "top.txt"), "utf8"), "top baseline");
  assert.equal(await readFile(path.join(f.app, "a.txt"), "utf8"), "app baseline");
  lifecycle.release();
});

test("S5: an async edit task runs Cline in the subfolder and holds the lock of the repository root", async t => {
  const f = await monorepo(t);
  const runs: Array<{ input: any; options: any }> = [];
  const manager = new TaskManager({ traceBase: path.join(f.base, "traces"), snapshotOptions: { snapshotBase: f.snapshots },
    runOptions: { checkoutLockDirectory: f.locks }, runners: { edits: async (input, signal, options) => {
      runs.push({ input, options });
      if (signal.aborted) throw new ClineRunError("cancelled", "cancelled");
      return { text: "done", durationMs: 1 } as any;
    } } });
  t.after(() => manager.shutdown(30_000));
  const task = manager.start({ mode: "edits", prompt: "Implement", cwd: f.app, verify: runsIn(f.app), maxFixRuns: 0,
    codeMap: false, provider: "p", model: "m" });
  const deadline = Date.now() + TEST_WAIT_MS;
  let view: TaskStatusView;
  while (true) {
    view = await manager.status(task.taskId, 0);
    if (view.state === "done" || view.state === "failed" || view.state === "input_required") break;
    assert.ok(Date.now() < deadline, JSON.stringify(view));
    await new Promise(r => setTimeout(r, 20));
  }
  assert.equal(runs.length, 1);
  assert.equal(path.resolve(runs[0].input.cwd), f.app, "Cline runs in the requested subfolder");
  assert.equal(path.resolve(runs[0].options.checkoutRoot), f.root, "the run is told the checkout root it holds the lock for");
  assert.equal(view.state, "done", JSON.stringify(view));
});

function cwdCapturingFake(seen: string[], base: string): Partial<ClineInvocationOptions> {
  return {
    promptPreamble: "", maxAttempts: 1, recordStatus: false, respectQuotaLock: false,
    deps: {
      providerSettingsPath: path.join(base, "providers.json"), entryPath: "mock/cline", access: async () => {},
      spawn: ((_executable: string, args: string[]) => {
        seen.push(args[args.indexOf("--cwd") + 1]);
        const child = new EventEmitter() as any;
        child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
        child.stdout.destroy = () => {}; child.stderr.destroy = () => {}; child.kill = () => {};
        queueMicrotask(() => {
          child.stdout.emit("data", Buffer.from(JSON.stringify({ type: "run_result", finishReason: "completed", text: "review done" }) + "\n"));
          child.emit("close", 0);
        });
        return child;
      }) as any
    }
  };
}

test("S5: ask_cline_workspace runs in the same subfolder of its worktree", async t => {
  const f = await monorepo(t);
  const seen: string[] = [];
  const result = await askClineWorkspace({ cwd: f.app, prompt: "Inspect", codeMap: false, provider: "cline", model: "m" },
    undefined, cwdCapturingFake(seen, f.base));
  assert.match(result.text ?? "", /review done/);
  assert.equal(seen.length, 1);
  assert.match(seen[0].replaceAll("\\", "/"), /\/review-[^/]+\/packages\/app$/, seen[0]);
  assert.equal(result.warnings?.some(w => w.includes("does not exist at HEAD")) ?? false, false);
});

test("S5: an uncommitted subfolder runs at the worktree root and says so", async t => {
  const f = await monorepo(t);
  const fresh = path.join(f.root, "packages", "new");
  await mkdir(fresh, { recursive: true });
  const seen: string[] = [];
  const result = await askClineWorkspace({ cwd: fresh, prompt: "Inspect", codeMap: false, provider: "cline", model: "m" },
    undefined, cwdCapturingFake(seen, f.base));
  assert.match(seen[0].replaceAll("\\", "/"), /\/review-[^/]+$/, seen[0]);
  assert.ok(result.warnings?.some(w => w.includes("does not exist at HEAD")), JSON.stringify(result.warnings));
});

test("S5 review: a folder reached through a junction or symlink is inside its checkout", async t => {
  const f = await monorepo(t);
  const link = path.join(f.base, "link");
  await symlink(f.root, link, process.platform === "win32" ? "junction" : "dir");
  assert.equal(await subfolderOf(f.root, path.join(link, "packages", "app")), f.app);
  assert.equal(await subfolderOf(f.root, link), f.root);
  assert.equal(await subfolderOf(f.app, f.root), undefined, "a parent folder is outside");
});
