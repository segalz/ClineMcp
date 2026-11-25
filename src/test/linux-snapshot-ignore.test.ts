import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathsNotBeyondLinks } from "../snapshot.js";

// Plan S7 (baseline #6, G8): `git check-ignore` exits 128 ("beyond a symbolic link") for a path under a linked
// directory, so restore must not hand such paths to it. Restore refuses them later as links instead.
test("pathsNotBeyondLinks drops paths under a linked directory and keeps the rest in order", async (t) => {
  const base = await mkdtemp(path.join(os.tmpdir(), "snap-ignore-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = path.join(base, "root");
  const outside = path.join(base, "outside");
  await mkdir(path.join(root, "real", "sub"), { recursive: true });
  await mkdir(outside);
  await writeFile(path.join(root, "top"), "x");
  await writeFile(path.join(root, "real", "sub", "f"), "x");
  await writeFile(path.join(outside, "file"), "outside");
  await symlink(outside, path.join(root, "link"), process.platform === "win32" ? "junction" : "dir");
  const paths = ["top", "link/file", "real/sub/f", "link/deep/x", "missing/x", "link"];
  assert.deepEqual(await pathsNotBeyondLinks(root, paths), ["top", "real/sub/f", "missing/x", "link"]);
  assert.deepEqual(await pathsNotBeyondLinks(root, []), []);
});
