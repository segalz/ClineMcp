import assert from "node:assert/strict";
import test, { after } from "node:test";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  getJournalPath, readProviderSettingsSnapshot, restoreProviderSettingsSnapshot, withProviderOverride,
  type acquireSettingsMutex, type ReleaseSettingsMutex
} from "../settings.js";

// Plan S12 (review item C2). Cline rewrites providers.json itself while a bridge run is active, and on
// Windows a reader can hold the file open briefly. One truncated read or one refused rename is transient:
// it must be retried instead of failing the run with settings_restore_failed or leaving the journal behind.

const envDir = await mkdtemp(path.join(os.tmpdir(), `cline-s12-env-${process.pid}-`));
process.env.CLINE_MCP_STATUS_PATH = path.join(envDir, "status.json");
process.env.CLINE_MCP_CATALOG_PATH = path.join(envDir, "catalog.json");
process.env.CLINE_MCP_STATE_PATH = path.join(envDir, "state.json");
process.env.CLINE_MCP_TRACE_DIR = path.join(envDir, "traces");
after(() => rm(envDir, { recursive: true, force: true }));

const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const baseline = { lastUsedProvider: "default", providers: {
  default: { settings: { model: "baseline", reasoning: "low", apiKey: "never-journal-this" } }
} };
const overridden = { lastUsedProvider: "default", providers: {
  default: { settings: { model: "override", reasoning: "low", apiKey: "never-journal-this" } }
} };
/** What a reader sees halfway through a non-atomic write by Cline. */
const truncated = (data: unknown) => { const text = JSON.stringify(data, null, 2); return text.slice(0, Math.floor(text.length / 2)); };

async function fixture(fn: (file: string) => Promise<void>) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "cline-s12-"));
  const file = path.join(dir, "providers.json");
  await writeFile(file, JSON.stringify(baseline));
  try { await fn(file); } finally { await rm(dir, { recursive: true, force: true, maxRetries: 5 }); }
}
const json = async (file: string) => JSON.parse(await readFile(file, "utf8"));

function fakeMutex() {
  let owner: ReleaseSettingsMutex | undefined;
  const acquire: typeof acquireSettingsMutex = async () => {
    while (owner) await delay(1);
    const release = async () => { if (owner === release) owner = undefined; };
    owner = release;
    return release;
  };
  return acquire;
}

test("S12: a truncated providers.json read at override start is retried and the run goes ahead", async () => fixture(async file => {
  await writeFile(file, truncated(baseline));
  const finishWrite = delay(80).then(() => writeFile(file, JSON.stringify(baseline)));
  let ran = false;
  const result = await withProviderOverride({ provider: "default", model: "override" }, file, undefined,
    async () => { ran = true; return { warnings: [] as string[] }; }, { acquireSettingsMutex: fakeMutex() });
  await finishWrite;
  assert.equal(ran, true);
  assert.deepEqual(result.warnings, []);
  await assert.rejects(readFile(getJournalPath(file)), { code: "ENOENT" });
  assert.equal((await json(file)).providers.default.settings.model, "baseline");
}));

test("S12: a truncated providers.json read during the end-of-run restore is retried; no warning, no journal left",
  async () => fixture(async file => {
  let finishWrite: Promise<void> | undefined;
  const result = await withProviderOverride({ provider: "default", model: "override" }, file, undefined, async () => {
    // Cline is still writing its override when the run returns.
    await writeFile(file, truncated(overridden));
    finishWrite = delay(80).then(() => writeFile(file, JSON.stringify(overridden)));
    return { warnings: [] as string[] };
  }, { acquireSettingsMutex: fakeMutex() });
  await finishWrite;
  assert.deepEqual(result.warnings, []);
  await assert.rejects(readFile(getJournalPath(file)), { code: "ENOENT" });
  const restored = await json(file);
  assert.equal(restored.providers.default.settings.model, "baseline");
  assert.equal(restored.providers.default.settings.apiKey, "never-journal-this");
}));

test("S12: a run joining a live run whose baseline is already journaled does not re-read providers.json",
  async () => fixture(async file => {
  await writeFile(getJournalPath(file), JSON.stringify({ version: 2,
    base: { hadLastUsedProvider: true, originalLastUsedProvider: "default",
      providers: { default: { hadEntry: true, hadModel: true, originalModel: "baseline", hadReasoning: true, originalReasoning: "low" } } },
    runs: { other: { pid: 424_242, provider: "default", startedAtMs: Date.now() } } }));
  // The other live run's Cline is mid-write for the whole of this run.
  await writeFile(file, truncated(overridden));
  let ran = false;
  const result = await withProviderOverride({ provider: "default", model: "override" }, file, undefined,
    async () => { ran = true; return { warnings: [] as string[] }; },
    { acquireSettingsMutex: fakeMutex(), isProcessAlive: () => true });
  assert.equal(ran, true);
  assert.deepEqual(result.warnings, []);
  const journal = await json(getJournalPath(file));
  assert.deepEqual(Object.keys(journal.runs), ["other"]);
}));

test("S12: a persistently malformed providers.json still fails the override, within a bounded retry", async () => fixture(async file => {
  await writeFile(file, "{ not json");
  let ran = false;
  const started = performance.now();
  await assert.rejects(withProviderOverride({ provider: "default", model: "override" }, file, undefined,
    async () => { ran = true; return { warnings: [] as string[] }; }, { acquireSettingsMutex: fakeMutex() }),
    { kind: "settings_restore_failed" });
  assert.equal(ran, false);
  assert.ok(performance.now() - started < 5_000, "the retry must be bounded");
}));

test("S12: a restore whose rename is refused while a reader holds providers.json open is retried",
  { skip: process.platform !== "win32", timeout: 30_000 }, async () => fixture(async file => {
  const snapshot = await readProviderSettingsSnapshot(file, "default");
  await writeFile(file, JSON.stringify(overridden));
  // Open without FILE_SHARE_DELETE, as a Windows reader may: replacing the file fails until it closes.
  const holder = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
    `$f = [IO.File]::Open('${file.replace(/'/g, "''")}', 'Open', 'Read', 'Read'); 'open'; Start-Sleep -Milliseconds 300; $f.Close()`],
    { stdio: ["ignore", "pipe", "inherit"], windowsHide: true });
  const exited = new Promise<void>(resolve => holder.once("exit", () => resolve()));
  await new Promise<void>((resolve, reject) => {
    holder.stdout.setEncoding("utf8");
    holder.stdout.on("data", (chunk: string) => { if (chunk.includes("open")) resolve(); });
    holder.once("exit", () => reject(new Error("holder exited before opening the file")));
  });
  try {
    assert.equal(await restoreProviderSettingsSnapshot(snapshot), "restored");
  } finally { await exited; }
  assert.equal((await json(file)).providers.default.settings.model, "baseline");
}));
