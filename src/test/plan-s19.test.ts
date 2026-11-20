import assert from "node:assert/strict";
import test, { after } from "node:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resolveVerificationCommand, VerificationError } from "../verify.js";
import { subfolderOf } from "../finalcheck.js";
import { classifyErrorText } from "../status.js";
import { redactSecrets } from "../runner.js";

// Plan S19: the small findings of the S17 final audit (Cline side).

const base = await mkdtemp(path.join(os.tmpdir(), "cline-s19-"));
after(() => rm(base, { recursive: true, force: true, maxRetries: 5 }));
const windowsOnly = { skip: process.platform !== "win32" ? "Windows shim resolution" : false };
const nodeShim = (target: string) => [
  "@ECHO off", "GOTO start", ":find_dp0", "SET dp0=%~dp0", "EXIT /b", ":start", "SETLOCAL", "CALL :find_dp0", "",
  String.raw`IF EXIST "%dp0%\node.exe" (`, String.raw`  SET "_prog=%dp0%\node.exe"`, ") ELSE (", "  SET \"_prog=node\"", "  SET PATHEXT=%PATHEXT:;.JS;=;%", ")", "",
  `endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%` + "\\" + target + `" %*`, "",
].join("\r\n");

test("S19 A3: an explicit node_modules/.bin path to a shim resolves like the bare name", windowsOnly, async () => {
  const root = await mkdtemp(path.join(base, "shim-"));
  await mkdir(path.join(root, "node_modules", ".bin"), { recursive: true });
  await mkdir(path.join(root, "node_modules", "vitest"), { recursive: true });
  const entry = path.join(root, "node_modules", "vitest", "vitest.mjs");
  await writeFile(entry, "process.exit(0)");
  await writeFile(path.join(root, "node_modules", ".bin", "vitest.cmd"), nodeShim(String.raw`..\vitest\vitest.mjs`));
  for (const command of [String.raw`node_modules\.bin\vitest`, String.raw`.\node_modules\.bin\vitest`, "node_modules/.bin/vitest",
    path.join(root, "node_modules", ".bin", "vitest")]) {
    const resolved = await resolveVerificationCommand(command, ["run"], root);
    assert.equal(resolved.command, process.execPath, command);
    assert.equal(path.resolve(resolved.args[0]), entry, command);
    assert.equal(resolved.args.at(-1), "run");
  }
});

test("S19 A3: a directory named like the check command is refused up front", async () => {
  const root = await mkdtemp(path.join(base, "dir-"));
  await mkdir(path.join(root, "check.exe"));
  await assert.rejects(resolveVerificationCommand(path.join(root, "check.exe"), [], root), VerificationError);
});

test("S19 A6: a folder whose name starts with '..' is inside the checkout", async () => {
  const root = await mkdtemp(path.join(base, "root-"));
  await mkdir(path.join(root, "..tools"));
  assert.equal(await subfolderOf(root, path.join(root, "..tools")), path.join(root, "..tools"));
  assert.equal(await subfolderOf(root, path.join(root, "..")), undefined);
  assert.equal(await subfolderOf(root, path.join(root, "..", "elsewhere")), undefined);
});

test("S19 B2: a non-zero exit whose text starts with a count of 429 is not a rate limit", () => {
  assert.notEqual(classifyErrorText("429 files could not be indexed", Date.now()).state, "rate_limited");
  for (const text of ["429 Too Many Requests", "HTTP 429", "status: 429", "rate limit exceeded"]) {
    assert.equal(classifyErrorText(text, Date.now()).state, "rate_limited", text);
  }
});

test("S19 C5: parameter type annotations are not redacted", () => {
  for (const text of ["function f(key: string) {}", "f(token: string, password: number)", "type T = { secret: boolean }"]) {
    assert.equal(redactSecrets(text), text);
  }
  assert.ok(!redactSecrets("token: abc123def456ghi").includes("abc123def456ghi"));
});

test("S19 review: real 429 messages followed by plain words are still rate limits", () => {
  for (const text of ["429 status code (no body)", "429 Provider returned error", "429 Resource has been exhausted (e.g. check quota).",
    "429 Quota exceeded for quota metric", "429 Request rate exceeded"]) {
    assert.equal(classifyErrorText(text, Date.now()).state, "rate_limited", text);
  }
  for (const text of ["429 files could not be indexed", "429 tests passed", "429 lines changed"]) {
    assert.notEqual(classifyErrorText(text, Date.now()).state, "rate_limited", text);
  }
});
