import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, renameSync } from "node:fs";
import fs, { mkdir, mkdtemp, rm, symlink, truncate, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import test, { after } from "node:test";
import { FinalCheckLifecycle } from "../finalcheck.js";
import { extractLastJsonlError } from "../parser.js";
import { ClineRunError, runCline, stopDedicatedHub } from "../runner.js";
import { restoreSnapshot, takeSnapshot } from "../snapshot.js";
import { readStatusEntry } from "../status.js";
import { TaskManager } from "../tasks.js";
import { runVerification } from "../verify.js";
import { askClineWorkspace } from "../workspace.js";

const base = await mkdtemp(path.join(os.tmpdir(), "cline-s20-extra-"));
after(() => rm(base, { recursive: true, force: true, maxRetries: 5 }));

function child() {
  return Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() });
}

// Supply a stable index and HEAD. The worktree, snapshot bytes, links and locks use the filesystem.
async function checkout(t: test.TestContext, stage = "", addWorktree?: (folder: string) => void) {
  const root = await mkdtemp(path.join(base, "repo-"));
  const mock = t.mock.method(childProcess, "spawn", (file: string, args: string[]) => {
    assert.match(path.basename(file), /^git(?:\.exe)?$/i);
    const [, , cmd, arg] = args;
    let output = "";
    if (cmd === "rev-parse") output = arg === "--show-toplevel" ? root : arg === "--git-path" ? ".git/info/exclude" : "a".repeat(40);
    else if (cmd === "ls-files" && arg === "--stage") output = stage;
    else if (cmd === "worktree" && arg === "add") { mkdirSync(args[5]); addWorktree?.(args[5]); }
    else assert.ok(["ls-files", "worktree", "diff", "status", "--no-optional-locks", "check-ignore"].includes(cmd), args.join(" "));
    const proc = child();
    queueMicrotask(() => { proc.stdout.end(output); proc.emit("close", 0); });
    return proc;
  });
  syncBuiltinESMExports();
  t.after(() => { mock.mock.restore(); syncBuiltinESMExports(); });
  return root;
}

for (const stage of ["before check", "after pass", "explicit opt-out"] as const) {
  test(`S20 (2): an unconfirmed hub stop ${stage} retains recovery and prevents another run`, async t => {
    const root = await checkout(t);
    let runs = 0, checks = 0;
    const lifecycle = new FinalCheckLifecycle({ prompt: "Edit", cwd: root, maxFixRuns: 2,
      verify: stage === "explicit opt-out" ? { none: true, reason: "Test opt-out" } : { command: process.execPath } }, {
      resolveRoot: async () => root, fits: () => true, question: () => undefined, lockDirectory: path.join(base, "locks"),
      snapshotOptions: { snapshotBase: path.join(base, "snapshots") },
      run: async (_prompt, _signal, _lock, _guard, _remaining, _run, hub) => {
        runs++;
        await hub.environment(root, { deps: { startHub: async () => ({ env: {}, stop: () => stopDedicatedHub(4321, {
          hubStarted: async () => true, runHubStop: async () => false, isListening: async () => true, listProcesses: async () => []
        }) }) } });
        hub.launched = true;
        return { text: "done", durationMs: 0, guard: { window: 10, totalToolCalls: 0, totalInputTokens: 0,
          filesTouched: [], lastErrors: [], processToolCalls: stage === "before check" ? 1 : 0 } };
      },
      verify: async () => { checks++; return { passed: stage === "after pass", exitCode: stage === "after pass" ? 0 : 1,
        signal: null, timedOut: false, killedForOutput: false, durationMs: 1, stdoutTail: "", stderrTail: "" }; }
    });
    t.after(() => lifecycle.release());
    const signal = new AbortController().signal;
    await lifecycle.execute(signal);
    assert.deepEqual([runs, checks], [1, stage === "after pass" ? 1 : 0]);
    // A passing check (or an explicit opt-out answer) is the commit point (final Codex check): the edit stays done,
    // the unconfirmed stop is evidence and the recovery snapshot is kept. Before the check it is a wait.
    const committed = stage !== "before check";
    assert.equal(lifecycle.phase, committed ? "done" : "waiting");
    assert.deepEqual(lifecycle.evidence.processesStillAlive, []);
    assert.equal(lifecycle.evidence.killUnverified, true);
    await lifecycle.execute(signal, "try again");
    assert.equal(runs, 1);
    if (committed) {
      const kept = lifecycle.evidence.snapshotDirectory as string;
      assert.ok(kept && existsSync(kept), JSON.stringify(lifecycle.evidence));
      return;
    }
    const directory = lifecycle.snapshot!.directory;
    assert.equal(await lifecycle.restore(), true);
    assert.ok(existsSync(directory));
    assert.equal(lifecycle.evidence.snapshotDirectory, directory);
  });
}

test("S20 (2): a failed daemon kill is unconfirmed even after its port closes", { skip: process.platform !== "win32" }, async () => {
  const result = await stopDedicatedHub(4321, { hubStarted: async () => true, runHubStop: async () => false,
    listProcesses: async () => [{ pid: 123, commandLine: "cline --cline-hub-daemon --port 4321" }],
    killTree: async () => false, isListening: async () => false });
  assert.deepEqual(result, { confirmed: false, alive: [123], unverified: true });
});

test("S20 (2): a child error after stopping a check preserves the pending tree result", async t => {
  const controller = new AbortController();
  const proc = Object.assign(child(), { pid: 123, exitCode: 0, signalCode: null });
  const mock = t.mock.method(childProcess, "spawn", () => {
    queueMicrotask(() => {
      proc.emit("exit", 0, null);
      controller.abort();
      proc.emit("error", new Error("pipe failed during stop"));
    });
    return proc;
  });
  syncBuiltinESMExports();
  t.after(() => { mock.mock.restore(); syncBuiltinESMExports(); });
  const result = await runVerification({ command: process.execPath }, base, controller.signal, {
    createWindowsJob: async () => undefined,
    confirmTreeDead: async () => { await new Promise(resolve => setImmediate(resolve)); return { confirmed: false, alive: [456], unverified: true }; }
  });
  assert.equal(result.passed, false);
  assert.equal(result.killConfirmed, false);
  assert.deepEqual(result.stillAlive, [456]);
  assert.equal(result.killUnverified, true);
});

test("S20 (3): the requested directory at HEAD must resolve inside the worktree", async t => {
  const link = path.join(base, "head-link");
  try { await symlink(base, link, process.platform === "win32" ? "junction" : "dir"); }
  catch (error) {
    if (["EPERM", "EACCES", "ENOTSUP"].includes((error as NodeJS.ErrnoException).code ?? "")) return t.skip(String(error));
    throw error;
  }
  let worktree = "", launched = "";
  const root = await checkout(t, "", folder => { worktree = folder; renameSync(link, path.join(folder, "pkg")); });
  const cwd = path.join(root, "pkg");
  await mkdir(cwd);
  const result = await askClineWorkspace({ cwd, prompt: "Read", provider: "p", model: "m", codeMap: false }, undefined, {
    recordStatus: false, respectQuotaLock: false, deps: {
      entryPath: "mock/cline", access: async () => {}, acquireSettingsMutex: async () => async () => {},
      providerSettingsPath: path.join(base, "providers.json"),
      spawn: ((_file: string, args: string[]) => {
        launched = args[args.indexOf("--cwd") + 1];
        const proc = child();
        queueMicrotask(() => { proc.stdout.end('{"type":"run_result","finishReason":"completed","text":"ok"}\n'); proc.emit("close", 0); });
        return proc;
      }) as unknown as typeof childProcess.spawn
    }
  });
  assert.equal(launched, worktree);
  assert.ok(result.warnings?.some(note => note.includes("repository root of the snapshot")));
});

test("S20 (4): blank error fields on wrapped terminal events preserve the preceding diagnostic", () => {
  const diagnostic = { type: "error", message: "Daily free quota exhausted" };
  for (const event of [
    { type: "run_completed", run: { resultSummary: { finishReason: "error" } }, error: { message: " " } },
    { type: "run-finished", result: { finishReason: "error" }, error: "" },
    { type: "agent_event", event: { type: "done", reason: "error", text: " " } }
  ]) {
    assert.equal(extractLastJsonlError([diagnostic, event].map(v => JSON.stringify(v)).join("\n"), ""), diagnostic.message);
  }
});

test("S20 (4): the saved provider state includes a plain 429 before CLI cleanup diagnostics", async () => {
  const statusPath = path.join(base, "status.json");
  const spawn = () => {
    const proc = child();
    queueMicrotask(() => {
      proc.stdout.end('{"type":"tool_result","error":"missing file"}\n');
      proc.stderr.end("HTTP 429\nError closing the stream\n");
      proc.emit("close", 1);
    });
    return proc;
  };
  await assert.rejects(runCline({ provider: "p", model: "m", prompt: "Read" }, undefined, {
    maxAttempts: 1, respectQuotaLock: false, deps: { statusPath, entryPath: "mock/cline",
      providerSettingsPath: path.join(base, "providers.json"), access: async () => {},
      acquireSettingsMutex: async () => async () => {}, spawn: spawn as unknown as typeof childProcess.spawn }
  }), ClineRunError);
  assert.equal((await readStatusEntry(statusPath, "p", "m"))?.state, "rate_limited");
});

const linkStage = "120000 " + "a".repeat(40) + " 0\tlink\0";
test("S20 (5): an oversized placeholder uses recorded size and restore detects a size change", async t => {
  const root = await checkout(t, linkStage);
  const file = path.join(root, "link"), size = 64 * 1024 * 1024 + 1;
  await writeFile(file, "");
  await truncate(file, size);
  const snapshot = await takeSnapshot(root, { snapshotBase: path.join(base, "snapshots") });
  assert.equal(snapshot.specialEntries?.[0].state, `file-size:${size}`);
  assert.deepEqual((await restoreSnapshot(snapshot)).failed, []);
  await truncate(file, size + 1);
  assert.deepEqual((await restoreSnapshot(snapshot)).failed.map(entry => entry.path), ["link"]);
});

test("S20 (5): cancellation during the final placeholder read propagates its reason", async t => {
  const root = await checkout(t, linkStage), file = path.join(await fs.realpath(root), "link");
  await writeFile(file, "target");
  const controller = new AbortController(), reason = new Error("cancelled during read");
  const open = fs.open;
  const mock = t.mock.method(fs, "open", async (...args: Parameters<typeof open>) => {
    const handle = await open(...args);
    if (args[0] === file) {
      const read = handle.read.bind(handle);
      t.mock.method(handle, "read", async (...args: Parameters<typeof read>) => {
        const result = await read(...args);
        if (!result.bytesRead) controller.abort(reason);
        return result;
      });
    }
    return handle;
  });
  syncBuiltinESMExports();
  t.after(() => { mock.mock.restore(); syncBuiltinESMExports(); });
  await assert.rejects(takeSnapshot(root, { snapshotBase: path.join(base, "snapshots"), signal: controller.signal }), e => e === reason);
});

test("S20 (7): publishing the same async edit error twice keeps one hub note", async t => {
  const root = await checkout(t), failure = new ClineRunError("non_zero_exit", "edit failed");
  const manager = new TaskManager({ traceBase: path.join(base, "traces"), snapshotOptions: { snapshotBase: path.join(base, "snapshots") },
    runOptions: { checkoutLockDirectory: path.join(base, "locks") },
    runners: { edits: async (_input, _signal, opts) => {
      const hub = opts.editHub!;
      await hub.environment(root, { deps: { startHub: async () => ({ env: {}, stop: async () => { throw new Error("cleanup diagnostic"); } }) } });
      hub.launched = true;
      throw failure;
    } }
  });
  t.after(() => manager.shutdown());
  const { taskId } = manager.start({ mode: "edits", cwd: root, prompt: "Edit", provider: "p", model: "m",
    codeMap: false, verify: { none: true, reason: "Test opt-out" } });
  const note = "Failed to stop the dedicated Cline hub: cleanup diagnostic";
  for (let publication = 1; publication <= 2; publication++) {
    const status = await manager.status(taskId, 30);
    assert.equal(status.state, "input_required", JSON.stringify(status));
    assert.deepEqual(failure.notes, [note]);
    assert.equal((await manager.result(taskId)).error?.split(note).length, 2);
    if (publication === 1) await manager.send(taskId, "retry edit", "retry");
  }
});

test("final check: a passing edit is never restored because its hub stop outlasts the deadline", async t => {
  const root = await checkout(t);
  const lifecycle = new FinalCheckLifecycle({ prompt: "Edit", cwd: root, timeoutSeconds: 2,
    verify: { none: true, reason: "Test opt-out for the commit point" } }, {
    resolveRoot: async () => root, fits: () => true, question: () => undefined, lockDirectory: path.join(base, "locks"),
    snapshotOptions: { snapshotBase: path.join(base, "snapshots") },
    run: async (_prompt, _signal, _lock, _guard, _remaining, _run, hub) => {
      // The hub stop takes longer than the whole 2 s budget, but it stops cleanly (confirmed).
      await hub.environment(root, { deps: { startHub: async () => ({ env: {}, stop: () => new Promise<void>(r => setTimeout(r, 2_500)) }) } } as any);
      hub.launched = true;
      return { text: "done", durationMs: 0, guard: { window: 10, totalToolCalls: 0, totalInputTokens: 0,
        filesTouched: [], lastErrors: [], processToolCalls: 0 } } as any;
    }
  });
  t.after(() => lifecycle.release());
  await lifecycle.execute(new AbortController().signal);
  assert.equal(lifecycle.phase, "done", JSON.stringify({ wait: lifecycle.waitReason, error: String(lifecycle.error) }));
  assert.equal(lifecycle.verification.restored, false);
});
