import assert from "node:assert/strict";
import "./git-test-serial.js";
import test, { after } from "node:test";
import childProcess, { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import { resolveVerificationCommand, VerificationError } from "../verify.js";
import { askClineWorkspace, cleanupLeftoverHubs, LEFTOVER_MIN_AGE_MS } from "../workspace.js";
import { collectEditsGitReport } from "../edits.js";
import { ClineRunError } from "../runner.js";
import { buildEntry, writeStatusEntry } from "../status.js";
import { discardSnapshot, restoreSnapshot, takeSnapshot } from "../snapshot.js";

// Plan S19 extra tests: covers items not in plan-s19.test.ts (plus properly escaped A3 cases).

const base = await mkdtemp(path.join(os.tmpdir(), "cline-s19-extra-"));
after(() => rm(base, { recursive: true, force: true, maxRetries: 5 }));

const windowsOnly = { skip: process.platform !== "win32" ? "Windows shim resolution" : false };
const nodeShim = (target: string) => [
  "@ECHO off", "GOTO start", ":find_dp0", "SET dp0=%~dp0", "EXIT /b", ":start", "SETLOCAL", "CALL :find_dp0", "",
  "IF EXIST \"%dp0%\\node.exe\" (", "  SET \"_prog=%dp0%\\node.exe\"", ") ELSE (", "  SET \"_prog=node\"", "  SET PATHEXT=%PATHEXT:;.JS;=;%", ")", "",
  `endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\${target}" %*`, "",
].join("\r\n");

function git(root: string, args: string[], input?: string): string {
  const result = spawnSync(process.platform === "win32" ? "git.exe" : "git", ["-C", root, ...args], {
    encoding: "utf8", timeout: 60_000, windowsHide: true, input
  });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  return result.stdout.trim();
}

test("S19 extra A3: explicit relative and absolute node_modules/.bin paths resolve via their .cmd shim", windowsOnly, async () => {
  const root = await mkdtemp(path.join(base, "shim-"));
  await mkdir(path.join(root, "node_modules", ".bin"), { recursive: true });
  await mkdir(path.join(root, "node_modules", "vitest"), { recursive: true });
  const entry = path.join(root, "node_modules", "vitest", "vitest.mjs");
  await writeFile(entry, "process.exit(0)");
  await writeFile(path.join(root, "node_modules", ".bin", "vitest"), "#!/bin/sh\nexec node \"$basedir/../vitest/vitest.mjs\" \"$@\"\n");
  await writeFile(path.join(root, "node_modules", ".bin", "vitest.cmd"), nodeShim("..\\vitest\\vitest.mjs"));
  for (const command of [
    "node_modules\\.bin\\vitest",
    ".\\node_modules\\.bin\\vitest",
    "node_modules/.bin/vitest",
    path.join(root, "node_modules", ".bin", "vitest")
  ]) {
    const resolved = await resolveVerificationCommand(command, ["run"], root);
    assert.equal(resolved.command, process.execPath, command);
    assert.equal(path.resolve(resolved.args[0]), entry, command);
    assert.equal(resolved.args.at(-1), "run");
  }
});

test("S19 extra A3: a non-runnable regular file is refused up front with VerificationError", async () => {
  const root = await mkdtemp(path.join(base, "nonrun-"));
  const file = path.join(root, process.platform === "win32" ? "notes.txt" : "plain-script");
  await writeFile(file, "not executable");
  if (process.platform !== "win32") await chmod(file, 0o644);
  await assert.rejects(resolveVerificationCommand(file, [], root), VerificationError);
});

test("S19 extra B6: a quota-locked workspace read refuses before any worktree creation or process scan", async t => {
  const dir = await mkdtemp(path.join(base, "quota-ws-"));
  const statusPath = path.join(dir, "status.json");
  const now = Date.parse("2026-11-20T10:00:00.000Z");
  await writeStatusEntry(statusPath, buildEntry({
    provider: "cline", model: "locked-model",
    classification: { state: "quota_exhausted", resetAtMs: now + 3_600_000 },
    reason: "daily quota exhausted", source: "run"
  }, now));

  const spawned: string[] = [];
  const realSpawn = childProcess.spawn;
  const mock = t.mock.method(childProcess, "spawn", ((file: string, args: readonly string[], opts: any) => {
    spawned.push(file);
    return realSpawn(file, args, opts);
  }) as typeof childProcess.spawn);
  syncBuiltinESMExports();
  t.after(() => { mock.mock.restore(); syncBuiltinESMExports(); });

  await assert.rejects(
    askClineWorkspace(
      { cwd: dir, prompt: "Inspect", provider: "cline", model: "locked-model" },
      undefined,
      { deps: { statusPath, wallNow: () => now } }
    ),
    (err: unknown) => err instanceof ClineRunError && err.kind === "quota_exhausted" && err.attempts === 0
  );
  assert.deepEqual(spawned, [], "neither git worktree setup nor any process scan may run when quota-locked");
});

test("S19 extra B6: leftover-hub cleanup applies LEFTOVER_MIN_AGE_MS to each hub's own cwd folder", async () => {
  const worktrees = await mkdtemp(path.join(base, "hubs-"));
  const oldDir = path.join(worktrees, "review-old");
  const freshDir = path.join(worktrees, "review-fresh");
  const freshNested = path.join(worktrees, "review-fresh-mono", "packages", "app");
  await mkdir(oldDir, { recursive: true });
  await mkdir(freshDir, { recursive: true });
  await mkdir(freshNested, { recursive: true });

  const now = Date.now();
  const oldTime = new Date(now - LEFTOVER_MIN_AGE_MS - 10_000);
  await utimes(oldDir, oldTime, oldTime);

  const killed: number[] = [];
  await cleanupLeftoverHubs({
    base: worktrees,
    minAgeMs: LEFTOVER_MIN_AGE_MS,
    now: () => now,
    listProcesses: async () => [
      { pid: 101, commandLine: `cline.exe --cline-hub-daemon --cwd "${oldDir}" --port 1` },
      { pid: 102, commandLine: `cline.exe --cline-hub-daemon --cwd "${freshDir}" --port 2` },
      { pid: 103, commandLine: `cline.exe --cline-hub-daemon --cwd "${freshNested}" --port 3` }
    ],
    killTree: async pid => { killed.push(pid); }
  });

  assert.deepEqual(killed, [101], "only the hub whose own folder passed LEFTOVER_MIN_AGE_MS may be killed");
});

test("S19 extra S10: collectEditsGitReport omits headAfter with a warning when rev-parse HEAD fails", async () => {
  const notARepo = await mkdtemp(path.join(base, "nogit-"));
  const oldSha = "a".repeat(40);
  const report = await collectEditsGitReport(notARepo, oldSha, "kept edits");
  assert.equal(report.headBefore, oldSha);
  assert.equal(report.headAfter, undefined);
  assert.equal("headAfter" in report, false, "headAfter must be omitted, never filled with headBefore");
  assert.ok(report.warnings.some(w => /rev-parse/i.test(w)), JSON.stringify(report.warnings));
});

test("S19 extra C4: a >1 MiB symlink placeholder is hashed by stream, so a same-length overwrite is detected", async () => {
  const root = await mkdtemp(path.join(base, "large-link-"));
  const storage = path.join(base, "large-link-snapshots");
  git(root, ["init", "--quiet"]);
  git(root, ["config", "core.symlinks", "false"]);
  await writeFile(path.join(root, "a.txt"), "baseline\n");
  git(root, ["add", "a.txt"]);
  const blob = git(root, ["hash-object", "-w", "--stdin"], "a.txt");
  git(root, ["update-index", "--add", "--cacheinfo", `120000,${blob},link`]);
  git(root, ["-c", "user.name=Test", "-c", "user.email=t@example.invalid", "commit", "-qm", "init"]);

  const size = 1024 * 1024 + 128 * 1024;
  const linkPath = path.join(root, "link");
  await writeFile(linkPath, Buffer.alloc(size, 0x61)); // 'a' * 1.125 MiB

  const snapshot = await takeSnapshot(root, { snapshotBase: storage });
  try {
    // Unchanged large placeholder passes restore cleanly.
    assert.deepEqual((await restoreSnapshot(snapshot)).failed, []);

    // Same-length overwrite with different bytes must be reported as changed.
    await writeFile(linkPath, Buffer.alloc(size, 0x62)); // 'b' * 1.125 MiB
    const report = await restoreSnapshot(snapshot);
    assert.ok(report.failed.some(entry => entry.path === "link"), JSON.stringify(report));
    assert.equal((await readFile(linkPath))[0], 0x62, "changed symlink placeholder is left untouched");
  } finally {
    await discardSnapshot(snapshot);
  }
});
