import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resolveVerificationCommand, runVerification, VerificationError } from "../verify.js";

async function fixture(t: test.TestContext) {
  const root = await mkdtemp(path.join(os.tmpdir(), "cline-verify-test-"));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5 }));
  return root;
}
const node = (source: string, timeoutSeconds?: number) => ({ command: process.execPath, args: ["-e", source], timeoutSeconds });

test("verification passes only on exit zero, uses cwd, closes stdin, and preserves literal args", async t => {
  const root = await fixture(t);
  const source = 'process.stdin.resume(); process.stdin.on("end", () => { console.log(process.cwd()); console.log(process.argv[1]); console.error("err"); });';
  const result = await runVerification({ command: process.execPath, args: ["-e", source, "a & echo NO | <> $(bad)"] }, root);
  assert.equal(result.passed, true); assert.equal(result.exitCode, 0); assert.equal(result.signal, null);
  assert.equal(result.timedOut, false); assert.equal(result.killedForOutput, false);
  assert.ok(result.stdoutTail.includes(root)); assert.ok(result.stdoutTail.includes("a & echo NO | <> $(bad)"));
  assert.match(result.stderrTail, /err/); assert.ok(result.durationMs >= 0);
  const failed = await runVerification(node('console.error("failed"); process.exit(7)'), root);
  assert.equal(failed.passed, false); assert.equal(failed.exitCode, 7); assert.match(failed.stderrTail, /failed/);
});

test("timeout and abort stop verification without a passing result", async t => {
  const root = await fixture(t);
  const result = await runVerification(node("setInterval(() => {}, 1000)", 1), root);
  assert.equal(result.timedOut, true); assert.equal(result.passed, false); assert.ok(result.durationMs < 8000);
  const controller = new AbortController();
  const pending = runVerification(node("setInterval(() => {}, 1000)"), root, controller.signal);
  setTimeout(() => controller.abort(), 200);
  const aborted = await pending;
  assert.equal(aborted.passed, false); assert.equal(aborted.timedOut, false);
  assert.equal((await runVerification(node("process.exit(0)"), root, controller.signal)).passed, false);
});

test("verification kills the tree on combined output above 1 MiB; tails stay under 8 KiB", async t => {
  const root = await fixture(t);
  const result = await runVerification(node('process.stdout.write("o".repeat(600000)); process.stderr.write("e".repeat(600000)); setInterval(() => {}, 1000);'), root);
  assert.equal(result.passed, false); assert.equal(result.killedForOutput, true); assert.equal(result.timedOut, false);
  assert.ok(Buffer.byteLength(result.stdoutTail) <= 8192); assert.ok(Buffer.byteLength(result.stderrTail) <= 8192);
});

test("tails redact secrets before byte truncation, including secrets split across writes", async t => {
  const root = await fixture(t);
  const result = await runVerification(node('process.stdout.write("x".repeat(10000) + "\\nAPI_TO"); setTimeout(() => { process.stdout.write("KEN=private-value\\n" + "😀".repeat(2040)); process.stderr.write("password=other-private"); }, 20);'), root);
  assert.equal(result.passed, true);
  assert.ok(Buffer.byteLength(result.stdoutTail) <= 8192); assert.ok(Buffer.byteLength(result.stderrTail) <= 8192);
  assert.doesNotMatch(result.stdoutTail, /private-value/); assert.doesNotMatch(result.stderrTail, /other-private/);
  assert.match(result.stdoutTail, /redacted/); assert.match(result.stderrTail, /redacted/);
});

test("invalid timeouts and missing executables fail with typed errors", async t => {
  const root = await fixture(t);
  for (const timeout of [0, 301, 1.5, NaN]) {
    await assert.rejects(runVerification(node("", timeout), root), (err: unknown) => err instanceof VerificationError && err.kind === "verification_refused");
  }
  await assert.rejects(runVerification({ command: "no-such-cline-verification-executable" }, root), (err: unknown) => err instanceof VerificationError && err.kind === "verification_launch_failed");
});

test("Windows npm/npx shims resolve to node and npm CLI scripts; other batch files are refused", { skip: process.platform !== "win32" }, async t => {
  const root = await fixture(t);
  for (const command of ["npm", "npm.cmd", "npx", "npx.cmd"]) {
    const resolved = await resolveVerificationCommand(command, ["--version"]);
    assert.equal(resolved.command, process.execPath); assert.match(resolved.args[0], /(?:npm|npx)-cli\.js$/);
    const result = await runVerification({ command, args: ["--version"] }, root);
    assert.equal(result.passed, true, result.stderrTail); assert.match(result.stdoutTail, /\d+\.\d+/);
  }
  for (const command of ["build.cmd", "build.bat", "BUILD.CMD"]) {
    await assert.rejects(runVerification({ command }, root), (err: unknown) => err instanceof VerificationError && err.kind === "verification_refused");
  }
  await writeFile(path.join(root, "should-not-run.cmd"), "@echo unsafe");
  await assert.rejects(runVerification({ command: path.join(root, "should-not-run.cmd") }, root), VerificationError);
  assert.equal((await runVerification({ command: "node", args: ["--version"] }, root)).passed, true);
});
