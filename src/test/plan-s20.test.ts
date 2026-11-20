import assert from "node:assert/strict";
import test, { after } from "node:test";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runCline, redactSecrets, ClineRunError } from "../runner.js";
import { classifyErrorText, classifyRunError } from "../status.js";

// Plan S20: the Gate 5 re-audit findings (Cline side). More S20 tests live in plan-s20-extra.test.ts.

const envDir = await mkdtemp(path.join(os.tmpdir(), `cline-s20-env-${process.pid}-`));
process.env.CLINE_PROVIDER_SETTINGS_PATH = path.join(envDir, "providers.json");
process.env.CLINE_MCP_STATUS_PATH = path.join(envDir, "status.json");
process.env.CLINE_MCP_CATALOG_PATH = path.join(envDir, "catalog.json");
process.env.CLINE_MCP_STATE_PATH = path.join(envDir, "state.json");
process.env.CLINE_MCP_TRACE_DIR = path.join(envDir, "traces");
after(() => rm(envDir, { recursive: true, force: true, maxRetries: 5 }));

const line = (value: unknown) => JSON.stringify(value);
function child(stdoutLines: unknown[], stderr = "", code = 1) {
  return () => {
    const c = new EventEmitter() as any;
    c.stdout = new EventEmitter(); c.stderr = new EventEmitter(); c.pid = 4321;
    c.stdout.destroy = () => {}; c.stderr.destroy = () => {}; c.kill = () => {};
    queueMicrotask(() => {
      if (stdoutLines.length) c.stdout.emit("data", Buffer.from(stdoutLines.map(v => line(v)).join("\n") + "\n"));
      if (stderr) c.stderr.emit("data", Buffer.from(stderr));
      c.emit("close", code);
    });
    return c;
  };
}
async function failure(spawn: () => unknown): Promise<ClineRunError> {
  try {
    await runCline({ provider: "p", model: "m", prompt: "x" }, undefined, { maxAttempts: 1, recordStatus: false, respectQuotaLock: false,
      deps: { entryPath: "mock/cline", access: async () => {}, timeoutMs: 5_000, closeGracePeriodMs: 1, killGracePeriodMs: 1,
        settlementDeadlineMs: 50, acquireSettingsMutex: async () => async () => {}, spawn } } as any);
  } catch (error) {
    assert.ok(error instanceof ClineRunError, String(error));
    return error;
  }
  assert.fail("the run must fail");
}

test("S20 (1): a Bearer value after an assignment is redacted", () => {
  for (const text of ["token = Bearer sample-value-123", "api_key = Bearer sample-value-123", "API_KEY=Bearer sample-value-123",
    "MY_TOKEN = Basic sample-value-123", "secret=Bearer sample-value-123"]) {
    assert.ok(!redactSecrets(text).includes("sample-value-123"), `${text} -> ${redactSecrets(text)}`);
  }
});

test("S20 (4): a stdout tool error does not hide a 429 on stderr from the provider state", async () => {
  const error = await failure(child([{ type: "tool_result", error: "ENOENT: no such file" }], "HTTP 429 Too Many Requests\n"));
  assert.equal(classifyRunError(error, Date.now())?.state, "rate_limited", `${error.kind}: ${error.message}`);
});

test("S20 (4): an empty wrapped terminal error does not hide an earlier quota error", async () => {
  const error = await failure(child([{ type: "error", message: "Daily free quota exhausted for this model" },
    { type: "run-finished", result: { finishReason: "error" } }]));
  assert.equal(error.kind, "quota_exhausted", error.message);
});

test("S20 (6): '429 warnings emitted' is not a rate limit", () => {
  assert.notEqual(classifyErrorText("429 warnings emitted", Date.now()).state, "rate_limited");
  assert.equal(classifyErrorText("429 Provider returned error", Date.now()).state, "rate_limited");
});

test("S20 review: a line inside a multi-line error that starts with 429 is not a rate limit", async () => {
  for (const text of ["SyntaxError in src/app.ts\n  429 | const x = ;", "Check failed:\n429 assertions failed"]) {
    const error = await failure(child([{ type: "run_result", finishReason: "error", text }]));
    assert.notEqual(classifyRunError(error, Date.now())?.state, "rate_limited", text);
  }
});

test("S20 review: a quoted value after a Bearer scheme is redacted and the scheme never crosses a line", () => {
  for (const text of ['token: Bearer "sample-value-123"', 'api_key: Bearer "sample-value-123"', "token = Bearer 'sample-value-123'"]) {
    assert.ok(!redactSecrets(text).includes("sample-value-123"), `${text} -> ${redactSecrets(text)}`);
  }
  assert.ok(redactSecrets("token: Bearer\nnext = public").includes("next = public"));
});
