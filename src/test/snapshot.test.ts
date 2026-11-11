import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { link, mkdtemp, mkdir, readFile, readdir, rename, rm, symlink, truncate, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { discardSnapshot, headAndIndexIdentity, restoreSnapshot, SnapshotError, takeSnapshot } from "../snapshot.js";

function git(root: string, ...args: string[]): string {
  const result = spawnSync(process.platform === "win32" ? "git.exe" : "git", ["-C", root, ...args], { encoding: "utf8", timeout: 10_000, windowsHide: true });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  return result.stdout.trim();
}
async function fixture(t: test.TestContext) {
  const base = await mkdtemp(path.join(os.tmpdir(), "cline-snapshot-test-"));
  t.after(() => rm(base, { recursive: true, force: true, maxRetries: 5 }));
  const root = path.join(base, "repo"), storage = path.join(base, "snapshots");
  await mkdir(root);
  git(root, "init", "--quiet");
  await writeFile(path.join(root, ".gitignore"), "ignored/\n");
  for (const name of ["a", "b", "deleted", "renamed"]) await writeFile(path.join(root, name), name + "\n");
  await writeFile(path.join(root, "binary"), Buffer.from([0, 255, 1, 128, 13, 10]));
  git(root, "add", ".");
  git(root, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "fixture");
  return { root, storage, base };
}
const refused = (kind: string) => (err: unknown) => err instanceof SnapshotError && err.kind === kind;

test("byte restore preserves dirty/staged/binary/untracked state and HEAD/index; ignored content stays untouched", async t => {
  const { root, storage } = await fixture(t);
  const put = (name: string, data: string | Buffer) => writeFile(path.join(root, name), data);
  await put("a", "staged\n"); git(root, "add", "a"); await put("a", "dirty\r\n");
  await unlink(path.join(root, "deleted"));
  await rename(path.join(root, "renamed"), path.join(root, "renamed-before"));
  await mkdir(path.join(root, "dir")); await put("dir/untracked", "untracked baseline");
  await mkdir(path.join(root, "ignored")); await put("ignored/keep", "ignored original");
  const identity = await headAndIndexIdentity(root);
  const snapshot = await takeSnapshot(root, { snapshotBase: storage });
  assert.ok(!snapshot.directory.startsWith(root + path.sep));
  assert.ok(snapshot.manifest.every(entry => entry.sha256.length === 64));
  assert.ok(!snapshot.manifest.some(entry => entry.path === "deleted" || entry.path.startsWith("ignored/")));
  const originals = new Map(await Promise.all(snapshot.manifest.map(async entry => [entry.path, await readFile(path.join(root, entry.path))] as const)));
  await put("a", "changed"); await put("binary", Buffer.from([8, 0, 253]));
  await put("deleted", "recreated by step"); await put("ignored/keep", "ignored new bytes");
  await rename(path.join(root, "b"), path.join(root, "moved"));
  await unlink(path.join(root, "renamed-before")); await put("dir/untracked", "changed");
  await put("new", "added");
  const report = await restoreSnapshot(snapshot);
  assert.deepEqual(report.failed, []);
  assert.deepEqual(report.removed.sort(), ["deleted", "moved", "new"]);
  assert.ok(report.restored.includes("a") && report.restored.includes("b") && report.restored.includes("binary"));
  for (const [file, bytes] of originals) assert.deepEqual(await readFile(path.join(root, file)), bytes, file);
  assert.equal(await readFile(path.join(root, "ignored/keep"), "utf8"), "ignored new bytes");
  await assert.rejects(readFile(path.join(root, "deleted")), { code: "ENOENT" });
  assert.deepEqual(await headAndIndexIdentity(root), identity);
  assert.deepEqual(await restoreSnapshot(snapshot), { restored: [], removed: [], failed: [] });
  await discardSnapshot(snapshot); await discardSnapshot(snapshot);
  await assert.rejects(readdir(snapshot.directory), { code: "ENOENT" });
});

test("all three limits refuse before snapshot storage is created", async t => {
  const { root, storage } = await fixture(t);
  for (const options of [{ maxFiles: 1 }, { maxFileBytes: 1 }, { maxTotalBytes: 1 }]) {
    await assert.rejects(takeSnapshot(root, { snapshotBase: storage, ...options }), refused("snapshot_limit"));
    await assert.rejects(readdir(storage), { code: "ENOENT" });
  }
  await writeFile(path.join(root, "huge"), "");
  await truncate(path.join(root, "huge"), 64 * 1024 * 1024 + 1);
  await assert.rejects(takeSnapshot(root, { snapshotBase: storage }), refused("snapshot_limit"));
  await assert.rejects(readdir(storage), { code: "ENOENT" });
  await unlink(path.join(root, "huge"));
  for (let i = 0; i < 9; i++) {
    await writeFile(path.join(root, `large-${i}`), "");
    await truncate(path.join(root, `large-${i}`), 64 * 1024 * 1024);
  }
  await assert.rejects(takeSnapshot(root, { snapshotBase: storage }), refused("snapshot_limit"));
  await assert.rejects(readdir(storage), { code: "ENOENT" });
});

test("snapshot storage cannot be inside the checkout, including through a junction", async t => {
  const { root, base } = await fixture(t);
  await assert.rejects(takeSnapshot(root, { snapshotBase: path.join(root, "snapshots") }), refused("snapshot_invalid"));
  await symlink(root, path.join(base, "alias"), process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(takeSnapshot(root, { snapshotBase: path.join(base, "alias", "snapshots") }), refused("snapshot_invalid"));
});

test("nested repositories, submodules and linked directories are typed refusals", async t => {
  const { root, storage, base } = await fixture(t);
  await mkdir(path.join(root, "nested")); git(path.join(root, "nested"), "init", "--quiet");
  await writeFile(path.join(root, "nested", "file"), "nested");
  await assert.rejects(takeSnapshot(root, { snapshotBase: storage }), refused("snapshot_unsupported"));
  await rm(path.join(root, "nested"), { recursive: true });
  git(root, "update-index", "--add", "--cacheinfo", `160000,${git(root, "rev-parse", "HEAD")},module`);
  await assert.rejects(takeSnapshot(root, { snapshotBase: storage }), refused("snapshot_unsupported"));
  git(root, "update-index", "--force-remove", "module");
  const outside = path.join(base, "outside"); await mkdir(outside); await writeFile(path.join(outside, "file"), "outside");
  await symlink(outside, path.join(root, "link"), process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(takeSnapshot(root, { snapshotBase: storage }), refused("snapshot_unsupported"));
  assert.equal(await readFile(path.join(outside, "file"), "utf8"), "outside");
});

test("file symlinks are refused when supported by the OS", async t => {
  const { root, storage } = await fixture(t);
  try { await symlink(path.join(root, "a"), path.join(root, "link"), "file"); }
  catch (err) { if ((err as NodeJS.ErrnoException).code === "EPERM") { t.skip("File symlinks require Windows developer mode or privilege"); return; } throw err; }
  await assert.rejects(takeSnapshot(root, { snapshotBase: storage }), refused("snapshot_unsupported"));
});

test("restore reports integrity/link/ignored failures without following links or touching ignored files", async t => {
  const { root, storage, base } = await fixture(t);
  await mkdir(path.join(root, "dir")); await writeFile(path.join(root, "dir/file"), "baseline");
  await writeFile(path.join(root, "will-ignore"), "baseline");
  const snapshot = await takeSnapshot(root, { snapshotBase: storage });
  await writeFile(path.join(root, "a"), "step bytes");
  await writeFile(path.join(snapshot.directory, String(snapshot.manifest.findIndex(e => e.path === "a"))), "corrupt");
  await rm(path.join(root, "dir"), { recursive: true });
  const outside = path.join(base, "outside"); await mkdir(outside); await writeFile(path.join(outside, "file"), "outside");
  await symlink(outside, path.join(root, "dir"), process.platform === "win32" ? "junction" : "dir");
  await writeFile(path.join(root, ".gitignore"), "ignored/\nwill-ignore\n");
  await writeFile(path.join(root, "will-ignore"), "ignored step bytes");
  const report = await restoreSnapshot(snapshot);
  assert.ok(report.failed.some(e => e.path === "a"));
  assert.ok(report.failed.some(e => e.path === "dir/file"));
  assert.ok(report.failed.some(e => e.path === "will-ignore"));
  assert.equal(await readFile(path.join(root, "a"), "utf8"), "step bytes");
  assert.equal(await readFile(path.join(outside, "file"), "utf8"), "outside");
  assert.equal(await readFile(path.join(root, "will-ignore"), "utf8"), "ignored step bytes");
});

test("identity detects index and HEAD changes independently", async t => {
  const { root } = await fixture(t);
  const before = await headAndIndexIdentity(root);
  await writeFile(path.join(root, "a"), "stage me"); git(root, "add", "a");
  const staged = await headAndIndexIdentity(root);
  assert.equal(staged.head, before.head); assert.notEqual(staged.indexHash, before.indexHash);
  git(root, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "next");
  assert.notEqual((await headAndIndexIdentity(root)).head, before.head);
});

test("restore handles file/directory replacements and does not write through hard links to ignored files", async t => {
  const { root, storage } = await fixture(t);
  await mkdir(path.join(root, "dir")); await writeFile(path.join(root, "dir/file"), "baseline");
  const snapshot = await takeSnapshot(root, { snapshotBase: storage });
  await rm(path.join(root, "dir"), { recursive: true });
  await writeFile(path.join(root, "dir"), "replacement file");
  await unlink(path.join(root, "a")); await mkdir(path.join(root, "a"));
  await writeFile(path.join(root, "a/new"), "replacement directory child");
  await mkdir(path.join(root, "ignored")); await writeFile(path.join(root, "ignored/keep"), "ignored content");
  await unlink(path.join(root, "b")); await link(path.join(root, "ignored/keep"), path.join(root, "b"));
  const report = await restoreSnapshot(snapshot);
  assert.deepEqual(report.failed, []);
  assert.equal(await readFile(path.join(root, "dir/file"), "utf8"), "baseline");
  assert.equal(await readFile(path.join(root, "a"), "utf8"), "a\n");
  assert.equal(await readFile(path.join(root, "b"), "utf8"), "b\n");
  assert.equal(await readFile(path.join(root, "ignored/keep"), "utf8"), "ignored content");
});
