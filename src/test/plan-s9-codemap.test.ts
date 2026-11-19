import assert from "node:assert/strict";
import "./git-test-serial.js";
import test, { after } from "node:test";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildCodeMap, buildCodeMapWithSource } from "../codemap.js";

// Plan S9 (B7, B8): one deleted tracked file must not drop the whole map, and a structural map that fits
// its budget is kept even when its JSON envelope is longer than the budget.

const root = await mkdtemp(path.join(os.tmpdir(), "cline-s9-codemap-"));
after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));

function git(cwd: string, args: string[], input?: string): string {
  const result = spawnSync(process.platform === "win32" ? "git.exe" : "git", ["-C", cwd, ...args], { input, encoding: "utf8", windowsHide: true, timeout: 10_000 });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  return result.stdout.trim();
}

async function repository(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(path.join(root, "repo-"));
  git(dir, ["init", "--quiet"]);
  const index: string[] = [];
  for (const [file, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(dir, file)), { recursive: true });
    await writeFile(path.join(dir, file), content);
    index.push(`100644 ${git(dir, ["hash-object", "-w", "--stdin"], content)}\t${file}\n`);
  }
  git(dir, ["update-index", "--index-info"], index.join(""));
  const tree = git(dir, ["write-tree"]);
  git(dir, ["update-ref", "HEAD", git(dir, ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit-tree", tree], "fixture\n")]);
  return dir;
}

async function withoutCodeindex<T>(action: () => Promise<T>): Promise<T> {
  const previous = process.env.CODEINDEX_CLI;
  delete process.env.CODEINDEX_CLI;
  try { return await action(); } finally { if (previous !== undefined) process.env.CODEINDEX_CLI = previous; }
}

test("S9 B7: a tracked file deleted from the working tree is skipped; the rest of the map is built", async () => {
  const repo = await repository({ "a.ts": "export const kept = 1;\n", "b.ts": "export const gone = 1;\n", "c.ts": "export const alsoKept = 1;\n" });
  await rm(path.join(repo, "b.ts"));
  const map = await withoutCodeindex(() => buildCodeMap(repo));
  assert.ok(map, "the map must not be dropped");
  assert.match(map, /a\.ts/);
  assert.match(map, /c\.ts/);
  assert.doesNotMatch(map, /b\.ts/);
});

test("S9 B7: a tracked path whose parent became a file is skipped too", async () => {
  const repo = await repository({ "a.ts": "export const kept = 1;\n", "dir/inner.ts": "export const inner = 1;\n" });
  await rm(path.join(repo, "dir"), { recursive: true });
  await writeFile(path.join(repo, "dir"), "a file where Git expects a folder\n");
  const map = await withoutCodeindex(() => buildCodeMap(repo));
  assert.match(map ?? "", /a\.ts/);
});

const envelope = (map: string) => ({ schemaVersion: 2, command: "map", referencesAreCandidates: true, truncated: false, anchors: [], map });

async function withCodeindex<T>(reply: string, action: () => Promise<T>): Promise<T> {
  const cli = path.join(root, `fake codeindex ${Math.random().toString(36).slice(2)}.cjs`);
  await writeFile(cli, `process.stdout.write(${JSON.stringify(reply)} + "\\n");`);
  const previous = process.env.CODEINDEX_CLI;
  process.env.CODEINDEX_CLI = cli;
  try { return await action(); } finally { if (previous === undefined) delete process.env.CODEINDEX_CLI; else process.env.CODEINDEX_CLI = previous; }
}

test("S9 B8: a 5,990-char structural map in a longer JSON envelope fits a 6,000 budget and is kept", async () => {
  const repo = await repository({ "a.ts": "export const first = 1;\n" });
  const reply = JSON.stringify(envelope("x".repeat(5_990)));
  assert.ok(reply.length > 6_000, "the envelope itself is over the budget");
  const result = await withCodeindex(reply, () => buildCodeMapWithSource(repo));
  assert.equal(result.source, "codeindex");
  assert.equal(result.map?.length, 5_990);
});

test("S9 B8: a structural map longer than the budget is still refused (regex fallback)", async () => {
  const repo = await repository({ "a.ts": "export const first = 1;\n" });
  const result = await withCodeindex(JSON.stringify(envelope("x".repeat(6_001))), () => buildCodeMapWithSource(repo));
  assert.equal(result.source, "regex");
});
