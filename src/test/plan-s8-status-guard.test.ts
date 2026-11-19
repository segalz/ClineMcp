import assert from "node:assert/strict";
import test, { after } from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ClineRunError, runCline } from "../runner.js";
import { clinePing } from "../ping.js";
import { buildGuardTripMessage, createGuard } from "../guard.js";
import * as status from "../status.js";
import { buildEntry, classifyErrorText, classifyRunError, readStatusEntry, writeStatusEntry } from "../status.js";

// Read through the namespace so this file loads before the new exports exist (the tests then fail, not the import).
const { RATE_LIMITED_TTL_MS, RATE_LIMIT_LADDER_MS, RATE_LIMIT_STRIKE_WINDOW_MS } = status as any as
  { RATE_LIMITED_TTL_MS: number; RATE_LIMIT_LADDER_MS: number[]; RATE_LIMIT_STRIKE_WINDOW_MS: number };

// Plan S8 (B2, D3, B11): 429 classification, a cooldown ladder for rate limits, local failures mark
// nothing, and a Cline input budget that does not count cache reads.

const dir = await mkdtemp(path.join(os.tmpdir(), "cline-s8-test-"));
after(() => rm(dir, { recursive: true, force: true }));
const settingsPath = path.join(dir, "providers.json");
await writeFile(settingsPath, JSON.stringify({ lastUsedProvider: "cline", providers: {} }));
const NOW = Date.parse("2026-11-19T10:00:00.000Z");
let counter = 0;
const freshStatusPath = () => path.join(dir, `status-${++counter}`, "status.json");

// --- B2: a bare 429 is not a rate limit -----------------------------------

test("S8: a 429 that is not an HTTP status (a line number) is not a rate limit", () => {
  assert.notEqual(classifyErrorText("Error at line 429: unexpected token in settings.json", NOW).state, "rate_limited");
  assert.notEqual(classifyErrorText("parsed 429 files", NOW).state, "rate_limited");
  assert.equal(classifyRunError(new ClineRunError("non_zero_exit", "Error at line 429: unexpected token"), NOW), undefined,
    "an unrecognised non-zero exit says nothing about the provider");
});

test("S8: a 429 given as an HTTP status is still a rate limit", () => {
  for (const text of ["HTTP 429", "Request failed with status code 429", '{"status":429}', "Error 429: slow down",
    "429 Too Many Requests", "429 {\"error\":\"busy\"}", "API error (429)"]) {
    assert.equal(classifyErrorText(text, NOW).state, "rate_limited", text);
  }
});

test("S8: a non-zero exit that names a provider failure is still unreachable", () => {
  assert.equal(classifyRunError(new ClineRunError("non_zero_exit", "Upstream 502"), NOW)?.state, "unreachable");
  assert.equal(classifyRunError(new ClineRunError("transient_provider_error", "x", { extractedMessage: "ECONNRESET" }), NOW)?.state, "unreachable");
});

test("S8: launch_failed and cline_updating are local failures and mark nothing", () => {
  assert.equal(classifyRunError(new ClineRunError("launch_failed", "ENOENT"), NOW), undefined);
  assert.equal(classifyRunError(new ClineRunError("cline_updating", "updating"), NOW), undefined);
});

test("S8: a run whose launch fails (no hub) writes no status entry", async () => {
  const statusPath = freshStatusPath();
  await assert.rejects(runCline({ provider: "p", model: "m", prompt: "test" }, undefined, {
    maxAttempts: 1, respectQuotaLock: false,
    deps: { entryPath: "mock/cline", access: async () => {}, providerSettingsPath: settingsPath, statusPath, backoffMs: 0,
      acquireSettingsMutex: async () => async () => {}, startHub: async () => { throw new Error("no free port"); },
      spawn: (() => { throw new Error("must not launch"); }) as any }
  } as any), (error: unknown) => error instanceof ClineRunError && error.kind === "launch_failed");
  assert.equal(await readStatusEntry(statusPath, "p", "m"), undefined);
});

test("S8: a ping whose CLI cannot launch throws the local error and records nothing", async () => {
  const statusPath = freshStatusPath();
  await assert.rejects(clinePing({ provider: "p", model: "m" }, undefined, {
    entryPath: "mock/cline", providerSettingsPath: settingsPath, statusPath, backoffMs: 0, wallNow: () => NOW,
    acquireSettingsMutex: async () => async () => {},
    access: async () => {}, startHub: async () => { throw new Error("no free port"); },
    spawn: (() => { throw new Error("must not launch"); }) as any
  } as any), (error: unknown) => error instanceof ClineRunError && error.kind === "launch_failed");
  assert.equal(await readStatusEntry(statusPath, "p", "m"), undefined);
});

test("S8 review: a ping that fails on the local settings lock throws and records nothing", async () => {
  const statusPath = freshStatusPath();
  await assert.rejects(clinePing({ provider: "p", model: "m" }, undefined, {
    entryPath: "mock/cline", providerSettingsPath: settingsPath, statusPath, backoffMs: 0, wallNow: () => NOW,
    acquireSettingsMutex: async () => { throw new ClineRunError("settings_lock_timeout", "Timed out waiting for the settings mutex."); },
    access: async () => {}, spawn: (() => { throw new Error("must not launch"); }) as any
  } as any), (error: unknown) => error instanceof ClineRunError && error.kind === "settings_lock_timeout");
  assert.equal(await readStatusEntry(statusPath, "p", "m"), undefined);
});

// --- D3: cooldown ladder for rate limits -----------------------------------

const rateLimited = (atMs: number, retryAfterSeconds?: number) => buildEntry({
  provider: "p", model: "m", reason: "rate limit", source: "run",
  classification: { state: "rate_limited", ...(retryAfterSeconds !== undefined ? { retryAfterSeconds } : {}) }
}, atMs);
const ttlOf = (entry: { checked_at: string; expires_at: string }) => Date.parse(entry.expires_at) - Date.parse(entry.checked_at);

test("S8: the ladder constants", () => {
  assert.deepEqual(RATE_LIMIT_LADDER_MS, [60_000, 180_000, 600_000, 1_800_000]);
  assert.equal(RATE_LIMITED_TTL_MS, RATE_LIMIT_LADDER_MS[0]);
  assert.equal(RATE_LIMIT_STRIKE_WINDOW_MS, 1_800_000);
});

test("S8: repeated rate limits climb the ladder and stop at the top rung", async () => {
  const statusPath = freshStatusPath();
  const ttls: number[] = [], strikes: number[] = [];
  for (let i = 0; i < 5; i++) {
    await writeStatusEntry(statusPath, rateLimited(NOW + i * 10_000));
    const stored = (await readStatusEntry(statusPath, "p", "m"))!;
    ttls.push(ttlOf(stored)); strikes.push((stored as any).strikes);
  }
  assert.deepEqual(ttls, [60_000, 180_000, 600_000, 1_800_000, 1_800_000]);
  assert.deepEqual(strikes, [1, 2, 3, 4, 5]);
});

test("S8: rate limits less than 2 s apart (parallel calls) count as one strike", async () => {
  const statusPath = freshStatusPath();
  await writeStatusEntry(statusPath, rateLimited(NOW));
  const first = (await readStatusEntry(statusPath, "p", "m"))!;
  await writeStatusEntry(statusPath, rateLimited(NOW + 1_500));
  const second = (await readStatusEntry(statusPath, "p", "m"))!;
  assert.equal((second as any).strikes, 1);
  assert.ok(Date.parse(second.expires_at) >= Date.parse(first.expires_at));
  assert.ok(Date.parse(second.expires_at) - (NOW + 1_500) <= RATE_LIMIT_LADDER_MS[0]);
});

test("S8: a success resets the ladder", async () => {
  const statusPath = freshStatusPath();
  await writeStatusEntry(statusPath, rateLimited(NOW));
  await writeStatusEntry(statusPath, rateLimited(NOW + 10_000));
  await writeStatusEntry(statusPath, buildEntry({ provider: "p", model: "m", reason: "ok", source: "run", classification: { state: "available" } }, NOW + 20_000));
  await writeStatusEntry(statusPath, rateLimited(NOW + 30_000));
  const stored = (await readStatusEntry(statusPath, "p", "m"))!;
  assert.equal(ttlOf(stored), 60_000);
  assert.equal((stored as any).strikes, 1);
});

test("S8: a rate limit long after the last one starts the ladder again", async () => {
  const statusPath = freshStatusPath();
  await writeStatusEntry(statusPath, rateLimited(NOW));
  await writeStatusEntry(statusPath, rateLimited(NOW + 10_000));
  await writeStatusEntry(statusPath, rateLimited(NOW + 10_000 + RATE_LIMIT_STRIKE_WINDOW_MS + 1));
  const stored = (await readStatusEntry(statusPath, "p", "m"))!;
  assert.equal(ttlOf(stored), 60_000);
  assert.equal((stored as any).strikes, 1);
});

test("S8: a Retry-After from the provider wins over the ladder", async () => {
  const statusPath = freshStatusPath();
  await writeStatusEntry(statusPath, rateLimited(NOW));
  await writeStatusEntry(statusPath, rateLimited(NOW + 10_000));
  await writeStatusEntry(statusPath, rateLimited(NOW + 20_000, 30));
  const stored = (await readStatusEntry(statusPath, "p", "m"))!;
  assert.equal(ttlOf(stored), 30_000);
  assert.equal(stored.retry_after_s, 30);
  assert.equal((stored as any).strikes, 3, "strikes are still counted when the provider gives a delay");
});

test("S8: the ladder is per provider and model", async () => {
  const statusPath = freshStatusPath();
  await writeStatusEntry(statusPath, rateLimited(NOW));
  await writeStatusEntry(statusPath, buildEntry({ provider: "p", model: "other", reason: "rate limit", source: "run",
    classification: { state: "rate_limited" } }, NOW + 10_000));
  const other = (await readStatusEntry(statusPath, "p", "other"))!;
  assert.equal(ttlOf(other), 60_000);
});

// --- B11: cache reads do not count toward the input budget -------------------

const usage = (inputTokens: number, cacheReadTokens: number, cacheWriteTokens = 0) =>
  ({ type: "usage", usage: { inputTokens, outputTokens: 10, cacheReadTokens, cacheWriteTokens } });

test("S8 B11: 9k input with 8k cache reads counts 1k toward the budget; the full count is still reported", () => {
  const guard = createGuard({ maxInputTokens: 5_000 });
  for (let i = 0; i < 4; i++) assert.equal(guard.observe(usage(9_000, 8_000)), null, `step ${i + 1} must not trip`);
  const report = guard.snapshot() as any;
  assert.equal(report.totalInputTokens, 36_000);
  assert.equal(report.budgetInputTokens, 4_000);
  assert.equal(report.kind, undefined);
});

test("S8 B11: a provider reporting 1k input plus 8k cache reads also counts 1k", () => {
  const guard = createGuard({ maxInputTokens: 5_000 });
  for (let i = 0; i < 4; i++) assert.equal(guard.observe(usage(1_000, 8_000)), null);
  assert.equal((guard.snapshot() as any).budgetInputTokens, 4_000);
});

test("S8 B11: cache writes count toward the budget", () => {
  const guard = createGuard({ maxInputTokens: 50_000 });
  guard.observe(usage(9_000, 8_000, 2_000));
  assert.equal((guard.snapshot() as any).budgetInputTokens, 3_000);
});

test("S8 B11: the budget still trips on uncached input, and the message names the budget count", () => {
  const guard = createGuard({ maxInputTokens: 5_000 });
  assert.equal(guard.observe(usage(3_000, 0)), null);
  const verdict = guard.observe(usage(3_000, 0));
  assert.equal(verdict?.kind, "budget_exceeded");
  assert.equal((verdict as any).budgetInputTokens, 6_000);
});

test("S8 B11: cumulative done/run_result usage is counted the same way and not added twice", () => {
  const guard = createGuard({ maxInputTokens: 5_000 });
  guard.observe(usage(9_000, 8_000));
  guard.observe(usage(9_000, 8_000));
  assert.equal(guard.observe({ type: "run_result", finishReason: "completed", usage: { inputTokens: 18_000, cacheReadTokens: 16_000, cacheWriteTokens: 0 } }), null);
  const report = guard.snapshot() as any;
  assert.equal(report.totalInputTokens, 18_000);
  assert.equal(report.budgetInputTokens, 2_000);
});

test("S8 B11: usage without cache fields counts in full (no change for providers that do not report cache)", () => {
  const guard = createGuard({ maxInputTokens: 50_000 });
  guard.observe({ type: "usage", usage: { inputTokens: 7_000 } });
  assert.equal((guard.snapshot() as any).budgetInputTokens, 7_000);
});

test("S8 review: a final run_result without cache fields does not undo the cache discount", () => {
  const guard = createGuard({ maxInputTokens: 5_000 });
  guard.observe(usage(9_000, 8_000));
  guard.observe(usage(9_000, 8_000));
  assert.equal(guard.observe({ type: "run_result", finishReason: "completed", usage: { inputTokens: 18_000, outputTokens: 150 } }), null);
  const report = guard.snapshot() as any;
  assert.equal(report.totalInputTokens, 18_000);
  assert.equal(report.budgetInputTokens, 2_000);
});

test("S8 review: a final run_result without cache fields still charges input the usage events missed", () => {
  const guard = createGuard({ maxInputTokens: 50_000 });
  guard.observe(usage(9_000, 8_000));
  guard.observe({ type: "run_result", finishReason: "completed", usage: { inputTokens: 12_000 } });
  assert.equal((guard.snapshot() as any).budgetInputTokens, 4_000);
});

test("S8 review: a usage event that also carries a running total is not charged twice", () => {
  const writes = createGuard({ maxInputTokens: 50_000 });
  writes.observe({ type: "usage", usage: { inputTokens: 0, cacheWriteTokens: 4_000, totalInputTokens: 4_000 } });
  assert.equal((writes.snapshot() as any).budgetInputTokens, 4_000);
  const reads = createGuard({ maxInputTokens: 50_000 });
  reads.observe({ type: "usage", usage: { inputTokens: 1_000, cacheReadTokens: 8_000, totalInputTokens: 9_000 } });
  assert.equal((reads.snapshot() as any).budgetInputTokens, 1_000);
});

test("S8 review: the trip message names the budget count, not the full count", () => {
  const guard = createGuard({ maxInputTokens: 5_000 });
  guard.observe(usage(3_000, 0));
  const verdict = guard.observe(usage(9_000, 6_000));
  assert.equal(verdict?.kind, "budget_exceeded");
  const message = buildGuardTripMessage(verdict!, { maxInputTokens: 5_000 });
  assert.match(message, /6000 > 5000/);
});

test("S8 review: usage events that report only a running total still count toward the budget", () => {
  const guard = createGuard({ maxInputTokens: 5_000 });
  assert.equal(guard.observe({ type: "usage", usage: { totalInputTokens: 3_000 } }), null);
  const verdict = guard.observe({ type: "usage", usage: { totalInputTokens: 6_000 } });
  assert.equal(verdict?.kind, "budget_exceeded");
});

test("S8 review 2: a final run_result without cache fields after total-only usage events keeps the discount", () => {
  const guard = createGuard({ maxInputTokens: 5_000 });
  guard.observe({ type: "usage", usage: { totalInputTokens: 9_000, cacheReadTokens: 8_000 } });
  assert.equal(guard.observe({ type: "run_result", finishReason: "completed", usage: { inputTokens: 9_000 } }), null);
  const report = guard.snapshot() as any;
  assert.equal(report.budgetInputTokens, 1_000);
  assert.equal(report.totalInputTokens, 9_000);
});

test("S8 review 3: a step with input and a running total, then a cache-less run_result, keeps the step's budget", () => {
  const guard = createGuard({ maxInputTokens: 5_000 });
  guard.observe({ type: "usage", usage: { inputTokens: 4_000, totalInputTokens: 4_000 } });
  const verdict = guard.observe({ type: "run_result", finishReason: "completed", usage: { inputTokens: 9_000 } });
  assert.equal(verdict?.kind, "budget_exceeded");
  assert.equal((verdict as any).budgetInputTokens, 9_000);
});

test("S8 review 3: a cache-write-only step is kept when a cache-less run_result follows", () => {
  const guard = createGuard({ maxInputTokens: 50_000 });
  guard.observe({ type: "usage", usage: { inputTokens: 0, cacheWriteTokens: 4_000 } });
  guard.observe({ type: "run_result", finishReason: "completed", usage: { inputTokens: 0 } });
  assert.equal((guard.snapshot() as any).budgetInputTokens, 4_000);
});

test("S8 review 3: null cache fields count as absent", () => {
  const guard = createGuard({ maxInputTokens: 5_000 });
  guard.observe(usage(9_000, 8_000));
  assert.equal(guard.observe({ type: "run_result", finishReason: "completed", usage: { inputTokens: 9_000, cacheReadTokens: null } }), null);
  assert.equal((guard.snapshot() as any).budgetInputTokens, 1_000);
});

test("S8 review 3: a non-finite step input is not a step; the running total is charged", () => {
  const guard = createGuard({ maxInputTokens: 5_000 });
  const verdict = guard.observe({ type: "usage", usage: { inputTokens: NaN, totalInputTokens: 6_000 } });
  assert.equal(verdict?.kind, "budget_exceeded");
});
