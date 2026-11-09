import assert from "node:assert/strict";
import test, { after } from "node:test";
import { EventEmitter } from "node:events";
import { spawn as spawnProcess } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ClineRunError, runCline } from "../runner.js";
import { clinePing, PING_PROMPT, shouldReuse } from "../ping.js";
import {
  AVAILABLE_TTL_MS,
  RATE_LIMITED_TTL_MS,
  UNREACHABLE_TTL_MS,
  activeQuotaLock,
  buildEntry,
  classifyErrorText,
  classifyRunError,
  isFresh,
  parseRetryDelaySeconds,
  readStatusEntry,
  readStatusFile,
  statusKey,
  writeStatusEntry
} from "../status.js";

const root = await mkdtemp(path.join(os.tmpdir(), "cline-status-test-"));
process.env.CLINE_PROVIDER_SETTINGS_PATH = path.join(root, "providers.json");
process.env.CLINE_MCP_STATUS_PATH = path.join(root, "shared-status.json");
after(() => rm(root, { recursive: true, force: true }));

const NOW = Date.parse("2026-11-09T10:00:00.000Z");
let counter = 0;
const freshStatusPath = () => path.join(root, `status-${++counter}`, "status.json");

function createMockChild() {
  const child = new EventEmitter() as any;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdout.destroy = () => {};
  child.stderr.destroy = () => {};
  child.kill = () => queueMicrotask(() => child.emit("close", null, "SIGTERM"));
  return child;
}

type Reply = { stdout?: string; stderr?: string; code?: number | null; hang?: boolean };

function mockSpawn(replies: Reply[]) {
  const calls: string[][] = [];
  const spawn = (_exe: string, args: string[]) => {
    calls.push(args);
    const reply = replies[Math.min(calls.length - 1, replies.length - 1)];
    const child = createMockChild();
    if (!reply.hang) {
      queueMicrotask(() => {
        if (reply.stdout) child.stdout.emit("data", Buffer.from(reply.stdout));
        if (reply.stderr) child.stderr.emit("data", Buffer.from(reply.stderr));
        child.emit("close", reply.code ?? 0);
      });
    }
    return child;
  };
  return { spawn, calls };
}

const completed = (text: string) => JSON.stringify({ type: "run_result", finishReason: "completed", text }) + "\n";
const errorLine = (message: string) => JSON.stringify({ type: "error", message }) + "\n";
const QUOTA_MESSAGE = "Daily free model limit reached. Try again in 23h 59m.";

function deps(statusPath: string, spawn: unknown, extra: Record<string, unknown> = {}) {
  return {
    spawn: spawn as any,
    entryPath: "mock/cline",
    access: async () => {},
    backoffMs: 0,
    statusPath,
    providerSettingsPath: path.join(root, "missing-providers.json"),
    wallNow: () => NOW,
    ...extra
  };
}

// --- classification -------------------------------------------------------

test("daily quota with 'Try again in 23h 59m' locks until that instant", () => {
  const result = classifyErrorText(QUOTA_MESSAGE, NOW);
  assert.equal(result.state, "quota_exhausted");
  assert.equal(result.resetAtMs, NOW + (23 * 3600 + 59 * 60) * 1000);
  assert.equal(result.assumedReset, undefined);
});

test("quota phrasings are all recognised", () => {
  for (const text of [
    "Daily free limit reached",
    "Rate limit exceeded: free-models-per-day. Add 10 credits to unlock 1000 free model requests per day",
    "429: daily request quota exceeded"
  ]) {
    assert.equal(classifyErrorText(text, NOW).state, "quota_exhausted", text);
  }
});

test("quota reset from an epoch header, and assumed UTC midnight when absent", () => {
  const epoch = classifyErrorText('free-models-per-day "X-RateLimit-Reset":"1794787200000"', NOW);
  assert.equal(epoch.resetAtMs, 1794787200000);
  const iso = classifyErrorText("Daily free limit reached; resets at 2026-11-09T18:30:00Z", NOW);
  assert.equal(iso.resetAtMs, Date.parse("2026-11-09T18:30:00Z"));
  const assumed = classifyErrorText("Daily free limit reached", NOW);
  assert.equal(assumed.resetAtMs, Date.parse("2026-11-10T00:00:00Z"));
  assert.equal(assumed.assumedReset, true);
});

test("rate limits carry retry_after; other failures are unreachable", () => {
  assert.deepEqual(classifyErrorText("429 Too Many Requests, retry after 30s", NOW), { state: "rate_limited", retryAfterSeconds: 30 });
  assert.deepEqual(classifyErrorText("Rate limit reached. Try again in 1m 30s", NOW), { state: "rate_limited", retryAfterSeconds: 90 });
  assert.deepEqual(classifyErrorText('{"Retry-After": "12"} too many requests', NOW), { state: "rate_limited", retryAfterSeconds: 12 });
  assert.deepEqual(classifyErrorText("rate limit", NOW), { state: "rate_limited" });
  assert.equal(classifyErrorText("HTTP 503 Service Unavailable", NOW).state, "unreachable");
  assert.equal(parseRetryDelaySeconds("try again in 2 hours and 5 minutes"), 7500);
});

test("run errors map to states; cancellation and workspace errors are not recorded", () => {
  assert.equal(classifyRunError(new ClineRunError("timeout", "slow"), NOW)?.state, "unreachable");
  assert.equal(classifyRunError(new ClineRunError("launch_failed", "ENOENT"), NOW)?.state, "unreachable");
  assert.equal(classifyRunError(new ClineRunError("transient_provider_error", "x", { extractedMessage: "429 rate limit" }), NOW)?.state, "rate_limited");
  assert.equal(classifyRunError(new ClineRunError("non_zero_exit", "Upstream 502"), NOW)?.state, "unreachable");
  assert.equal(classifyRunError(new ClineRunError("cancelled", "stop"), NOW), undefined);
  assert.equal(classifyRunError(new ClineRunError("workspace_not_git", "no"), NOW), undefined);
  const quota = classifyRunError(new ClineRunError("quota_exhausted", "q", { resetAt: "2026-11-10T00:00:00.000Z" }), NOW);
  assert.equal(quota?.resetAtMs, Date.parse("2026-11-10T00:00:00.000Z"));
});

// --- TTL -------------------------------------------------------------------

test("TTL per state", () => {
  const entry = (classification: any) => buildEntry({ provider: "p", model: "m", classification, reason: "r", source: "ping" }, NOW);
  const ttl = (e: { expires_at: string }) => Date.parse(e.expires_at) - NOW;
  assert.equal(ttl(entry({ state: "available" })), AVAILABLE_TTL_MS);
  assert.equal(ttl(entry({ state: "rate_limited" })), RATE_LIMITED_TTL_MS);
  assert.equal(ttl(entry({ state: "rate_limited", retryAfterSeconds: 30 })), 30_000);
  assert.equal(ttl(entry({ state: "unreachable" })), UNREACHABLE_TTL_MS);
  const quota = entry({ state: "quota_exhausted", resetAtMs: NOW + 3_600_000 });
  assert.equal(ttl(quota), 3_600_000);
  assert.equal(quota.reset_at, new Date(NOW + 3_600_000).toISOString());
  assert.ok(isFresh(quota, NOW + 3_599_999));
  assert.ok(!isFresh(quota, NOW + 3_600_000));
  assert.ok(activeQuotaLock(quota, NOW));
  assert.equal(activeQuotaLock(quota, NOW + 3_600_000), undefined);
});

test("cache reuse: fresh results reused, real-run failures re-checked, quota locks held, force bypasses", () => {
  const make = (state: any, source: any) => buildEntry({ provider: "p", model: "m", classification: { state }, reason: "r", source }, NOW);
  assert.ok(shouldReuse(make("available", "ping"), NOW + 1000));
  assert.ok(!shouldReuse(make("available", "ping"), NOW + AVAILABLE_TTL_MS));
  assert.ok(shouldReuse(make("available", "run"), NOW + 1000));
  assert.ok(!shouldReuse(make("rate_limited", "run"), NOW + 1000));
  assert.ok(shouldReuse(make("rate_limited", "ping"), NOW + 1000));
  assert.ok(shouldReuse(make("quota_exhausted", "run"), NOW + 1000));
  assert.ok(!shouldReuse(make("available", "ping"), NOW + 1000, true));
  assert.ok(!shouldReuse(undefined, NOW));
});

test("status writes are atomic, merged per key and leave no temp files", async () => {
  const statusPath = freshStatusPath();
  const entry = (model: string) => buildEntry({ provider: "cline", model, classification: { state: "available" }, reason: "r", source: "ping" }, NOW);
  await Promise.all([writeStatusEntry(statusPath, entry("a")), writeStatusEntry(statusPath, entry("b/c:free"))]);
  const file = await readStatusFile(statusPath);
  assert.deepEqual(Object.keys(file.entries).sort(), [statusKey("cline", "a"), statusKey("cline", "b/c:free")]);
  assert.deepEqual(await readdir(path.dirname(statusPath)), ["status.json"]);
  await writeFile(statusPath, "{broken");
  assert.deepEqual((await readStatusFile(statusPath)).entries, {});
});

// --- runner integration ----------------------------------------------------

test("daily quota is not retried, is recorded, and later runs refuse without launching", async () => {
  const statusPath = freshStatusPath();
  const mock = mockSpawn([{ stderr: errorLine(QUOTA_MESSAGE), code: 1 }, { stdout: completed("should not run") }]);
  await assert.rejects(runCline({ prompt: "x" }, undefined, { deps: deps(statusPath, mock.spawn) }), (err: unknown) => {
    assert.ok(err instanceof ClineRunError);
    assert.equal(err.kind, "quota_exhausted");
    assert.equal(err.attempts, 1);
    assert.equal(err.resetAt, new Date(NOW + 86_340_000).toISOString());
    assert.match(err.message, /Not retried/);
    return true;
  });
  assert.equal(mock.calls.length, 1);
  const entry = await readStatusEntry(statusPath);
  assert.equal(entry?.state, "quota_exhausted");
  assert.equal(entry?.reset_at, new Date(NOW + 86_340_000).toISOString());

  await assert.rejects(runCline({ prompt: "x" }, undefined, { deps: deps(statusPath, mock.spawn) }), (err: unknown) =>
    err instanceof ClineRunError && err.kind === "quota_exhausted" && err.attempts === 0 && /not launched/.test(err.message));
  assert.equal(mock.calls.length, 1);

  // After the reset time the lock no longer applies.
  const later = await runCline({ prompt: "x" }, undefined, {
    deps: deps(statusPath, mock.spawn, { wallNow: () => NOW + 86_340_000 })
  });
  assert.equal(later.text, "should not run");
  assert.equal((await readStatusEntry(statusPath))?.state, "available");
});

test("OpenRouter free-models-per-day 429 is not treated as a retryable rate limit", async () => {
  const statusPath = freshStatusPath();
  const mock = mockSpawn([{ stderr: errorLine("429 Rate limit exceeded: free-models-per-day"), code: 1 }]);
  await assert.rejects(runCline({ prompt: "x" }, undefined, { deps: deps(statusPath, mock.spawn) }),
    (err: unknown) => err instanceof ClineRunError && err.kind === "quota_exhausted");
  assert.equal(mock.calls.length, 1);
});

test("transient rate limit still retries once and records rate_limited", async () => {
  const statusPath = freshStatusPath();
  const mock = mockSpawn([{ stderr: errorLine("429 Too many requests, retry after 20s"), code: 1 }]);
  await assert.rejects(runCline({ prompt: "x" }, undefined, { deps: deps(statusPath, mock.spawn) }),
    (err: unknown) => err instanceof ClineRunError && err.kind === "transient_provider_error" && err.attempts === 2);
  assert.equal(mock.calls.length, 2);
  const entry = await readStatusEntry(statusPath);
  assert.equal(entry?.state, "rate_limited");
  assert.equal(entry?.retry_after_s, 20);
  assert.equal(entry?.source, "run");
});

test("successful real run records available under the selected provider and model", async () => {
  const statusPath = freshStatusPath();
  const settingsPath = path.join(root, `providers-${++counter}.json`);
  await writeFile(settingsPath, JSON.stringify({ lastUsedProvider: "cline", providers: { cline: { settings: { model: "vendor/free-model:free" } } } }));
  const mock = mockSpawn([{ stdout: completed("done") }]);
  await runCline({ prompt: "x" }, undefined, { deps: deps(statusPath, mock.spawn, { providerSettingsPath: settingsPath }) });
  const entry = await readStatusEntry(statusPath, "cline", "vendor/free-model:free");
  assert.equal(entry?.state, "available");
  assert.equal(entry?.source, "run");
  assert.equal(Date.parse(entry!.expires_at) - NOW, AVAILABLE_TTL_MS);
});

test("timeout message states the per-attempt budget and total", async () => {
  const mock = mockSpawn([{ hang: true }]);
  await assert.rejects(runCline({ prompt: "x", timeoutSeconds: 5 }, undefined, {
    deps: deps(freshStatusPath(), mock.spawn, { timeoutMs: 15 })
  }), (err: unknown) => {
    assert.ok(err instanceof ClineRunError);
    assert.match(err.message, /attempt 2\/2 killed at [\d.]+s of 0\.015s budget \(total 5s\)/);
    return true;
  });
});

// --- ping ------------------------------------------------------------------

test("ping: single attempt, no approval, no cwd; cached until stale; force re-checks", async () => {
  const statusPath = freshStatusPath();
  let now = NOW;
  const mock = mockSpawn([{ stdout: completed("PONG") }]);
  const pingDeps = deps(statusPath, mock.spawn, { wallNow: () => now });
  const first = await clinePing({}, undefined, pingDeps);
  assert.equal(first.state, "available");
  assert.equal(first.cached, false);
  assert.equal(first.reason, "replied PONG");
  assert.equal(typeof first.latency_ms, "number");
  const args = mock.calls[0];
  assert.equal(args[args.indexOf("--auto-approve") + 1], "false");
  assert.equal(args[args.indexOf("--thinking") + 1], "none");
  assert.match(args[args.indexOf("--timeout") + 1], /^2[45]$/); // floored from the remaining 25s budget
  assert.ok(!args.includes("--cwd"));
  assert.equal(args.at(-1), PING_PROMPT);

  now += 30_000;
  assert.equal((await clinePing({}, undefined, pingDeps)).cached, true);
  assert.equal(mock.calls.length, 1);
  assert.equal((await clinePing({ force: true }, undefined, pingDeps)).cached, false);
  assert.equal(mock.calls.length, 2);
  now += AVAILABLE_TTL_MS;
  assert.equal((await clinePing({}, undefined, pingDeps)).cached, false);
  assert.equal(mock.calls.length, 3);
});

test("ping: timeout is unreachable with no retry", async () => {
  const statusPath = freshStatusPath();
  const mock = mockSpawn([{ hang: true }]);
  const result = await clinePing({}, undefined, deps(statusPath, mock.spawn, { timeoutMs: 15 }));
  assert.equal(result.state, "unreachable");
  assert.match(result.reason, /^timeout: .*attempt 1\/1/);
  assert.equal(mock.calls.length, 1);
  assert.equal((await readStatusEntry(statusPath))?.source, "ping");
});

test("ping: quota and rate limit states with reset/retry data, and it bypasses the quota lock", async () => {
  const statusPath = freshStatusPath();
  const quota = mockSpawn([{ stderr: errorLine(QUOTA_MESSAGE), code: 1 }]);
  const locked = await clinePing({}, undefined, deps(statusPath, quota.spawn));
  assert.equal(locked.state, "quota_exhausted");
  assert.equal(locked.reset_at, new Date(NOW + 86_340_000).toISOString());
  // Cached lock is returned without launching; force launches despite the lock.
  assert.equal((await clinePing({}, undefined, deps(statusPath, quota.spawn))).cached, true);
  assert.equal(quota.calls.length, 1);
  const limited = mockSpawn([{ stderr: errorLine("429 Too many requests. Try again in 45s"), code: 1 }]);
  const result = await clinePing({ force: true }, undefined, deps(statusPath, limited.spawn));
  assert.equal(result.state, "rate_limited");
  assert.equal(result.retry_after_s, 45);
  assert.equal(limited.calls.length, 1);
  const file = JSON.parse(await readFile(statusPath, "utf8"));
  assert.equal(file.entries[statusKey()].state, "rate_limited");
});


test("HTTP-date retry-after and malformed cache observations", () => {
  const result = classifyErrorText("429 Retry-After: Mon, 09 Nov 2026 10:02:00 GMT", NOW);
  assert.equal(result.state, "rate_limited");
  assert.equal(result.retryAfterSeconds, 120);
  assert.equal(result.resetAtMs, NOW + 120_000);
  const entry = buildEntry({ classification: { state: "available" }, reason: "r", source: "ping" }, NOW);
  assert.equal(isFresh({ ...entry, checked_at: "invalid" }, NOW), false);
  assert.equal(isFresh({ ...entry, checked_at: new Date(NOW + 1000).toISOString() }, NOW), false);
});

test("quota reported before a timeout is not retried", async () => {
  const mock = mockSpawn([{ hang: true }]);
  const spawn = (exe: string, args: string[]) => {
    const child = mock.spawn(exe, args);
    queueMicrotask(() => child.stderr.emit("data", Buffer.from(errorLine(QUOTA_MESSAGE))));
    return child;
  };
  await assert.rejects(runCline({ prompt: "x" }, undefined, {
    deps: deps(freshStatusPath(), spawn, { timeoutMs: 15 })
  }), (err: unknown) => err instanceof ClineRunError && err.kind === "quota_exhausted" && err.attempts === 1);
  assert.equal(mock.calls.length, 1);
});


test("parallel bridge processes preserve independent provider/model entries", async () => {
  const statusPath = freshStatusPath();
  const moduleUrl = new URL("../status.js", import.meta.url).href;
  await Promise.all(Array.from({ length: 4 }, (_, index) => new Promise<void>((resolve, reject) => {
    const script = `import { writeStatusEntry, buildEntry } from ${JSON.stringify(moduleUrl)};
      await writeStatusEntry(${JSON.stringify(statusPath)}, buildEntry({ provider: 'cline', model: 'parallel-${index}',
        classification: { state: 'available' }, source: 'ping', reason: 'test' }, Date.now()));`;
    const child = spawnProcess(process.execPath, ["--input-type=module", "-e", script], { stdio: "pipe" });
    let stderr = "";
    child.stderr.on("data", chunk => stderr += chunk);
    child.once("error", reject);
    child.once("close", code => code === 0 ? resolve() : reject(new Error(stderr)));
  })));
  assert.equal(Object.keys((await readStatusFile(statusPath)).entries).length, 4);
});
