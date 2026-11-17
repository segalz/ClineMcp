import assert from "node:assert/strict";
import "./git-test-serial.js";
import test, { after } from "node:test";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { headAndIndexIdentity } from "../snapshot.js";

const root = await mkdtemp(path.join(os.tmpdir(), "cline-identity-test-"));
const git = (...args: string[]) => spawnSync("git", ["-C", root, "-c", "user.name=t", "-c", "user.email=t@example.com", ...args]);
git("init", "-q");
await writeFile(path.join(root, "a.ts"), "export const a = 1;\n");
git("add", ".");
git("commit", "-qm", "init");

after(async () => { await rm(root, { recursive: true, force: true }).catch(() => {}); });

test("a stat-only index refresh (git status after touching a file) keeps the identity", async () => {
  const before = await headAndIndexIdentity(root);
  const later = new Date(Date.now() + 60_000);
  await utimes(path.join(root, "a.ts"), later, later);
  git("status", "--short");
  const after = await headAndIndexIdentity(root);
  assert.deepEqual(after, before);
});

test("staging a real change does change the identity", async () => {
  const before = await headAndIndexIdentity(root);
  await writeFile(path.join(root, "a.ts"), "export const a = 2;\n");
  git("add", "a.ts");
  const after = await headAndIndexIdentity(root);
  assert.equal(after.head, before.head);
  assert.notEqual(after.indexHash, before.indexHash);
});
