import assert from "node:assert/strict";
import test, { after } from "node:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CliStateManager, readStateFile } from "../clistate.js";

// Plan S1 (review item A1): a Cline CLI auto-update must never start while a tool call of this bridge is
// still preparing or running (before it registers in the settings journal), and a deferred update must run
// once the bridge is idle again.

const root = await mkdtemp(path.join(os.tmpdir(), "cline-s1-test-"));
after(async () => { await rm(root, { recursive: true, force: true }).catch(() => {}); });

async function setup() {
  const dir = await mkdtemp(path.join(root, "case-"));
  const cliDir = path.join(dir, "fake-cli");
  const llmsDir = path.join(cliDir, "node_modules", "@cline", "llms");
  await mkdir(path.join(cliDir, "bin"), { recursive: true });
  await mkdir(llmsDir, { recursive: true });
  const cliPkg = path.join(cliDir, "package.json");
  await writeFile(cliPkg, JSON.stringify({ version: "3.0.74" }));
  await writeFile(path.join(llmsDir, "package.json"), JSON.stringify({ version: "0.2.0" }));
  const entryPath = path.join(cliDir, "bin", "cline");
  await writeFile(entryPath, "// fake cline entry");
  const settingsPath = path.join(dir, "providers.json");
  await writeFile(settingsPath, JSON.stringify({ lastUsedProvider: "cline", providers: {} }));
  const now = Date.parse("2026-11-18T11:00:00.000Z");
  const installed: string[] = [];
  const manager = new CliStateManager({
    statePath: path.join(dir, "state.json"),
    catalogPath: path.join(dir, "catalog.json"),
    statusPath: path.join(dir, "status.json"),
    providerSettingsPath: settingsPath,
    entryPath,
    wallNow: () => now,
    importModule: async () => ({
      GENERATED_CLINE_RECOMMENDED_MODELS: { free: [{ id: "cline-free/first-model", name: "First" }] },
      getGeneratedModelsForProvider: () => ({ "cline-free/first-model": { name: "First", contextWindow: 128000, capabilities: ["tools"] } })
    }),
    checkLatestVersion: async () => "3.0.75",
    installCli: async (version: string) => { installed.push(version); await writeFile(cliPkg, JSON.stringify({ version })); },
    pingModel: async (input: { provider?: string; model?: string }) => ({
      state: "available", provider: input.provider!, model: input.model!,
      checked_at: new Date(now).toISOString(), expires_at: new Date(now + 60_000).toISOString(),
      reason: "replied PONG", source: "ping", cached: false
    })
  } as ConstructorParameters<typeof CliStateManager>[0]);
  return { manager, installed, statePath: path.join(dir, "state.json") };
}

test("S1: no CLI update starts while a tool call is preparing; it runs once the bridge is idle", async () => {
  const { manager, installed, statePath } = await setup();

  // A tool call begins: the hook runs, then the call spends time preparing (worktree, snapshot, lock)
  // before it registers in the settings journal.
  const endCall = manager.beginCall();
  await manager.onToolCall();
  await manager.waitForBackgroundWork();
  assert.deepEqual(installed, [], "must not install while a tool call of this bridge is active");
  assert.equal((await readStateFile(statePath)).cli.update_state, "update_available");

  // A second call overlaps the first; the first ends while the second is still active.
  const endSecond = manager.beginCall();
  await manager.onToolCall();
  endCall();
  await manager.waitForBackgroundWork();
  assert.deepEqual(installed, [], "must not install while another call is still active");

  // The last call ends: the deferred update runs in the background without another tool call.
  endSecond();
  await manager.waitForBackgroundWork();
  assert.deepEqual(installed, ["3.0.75"]);
  assert.equal((await readStateFile(statePath)).cli.version, "3.0.75");
});

test("S1: ending a call twice is harmless and the counter never goes negative", async () => {
  const { manager, installed } = await setup();
  const end = manager.beginCall();
  end();
  end();
  const endNext = manager.beginCall();
  await manager.onToolCall();
  await manager.waitForBackgroundWork();
  assert.deepEqual(installed, [], "a second end() must not release another active call");
  endNext();
  await manager.waitForBackgroundWork();
  assert.deepEqual(installed, ["3.0.75"]);
});

test("S1: a call that arrives during an install waits for it to finish", async () => {
  const { manager, installed } = await setup();
  let releaseInstall!: () => void;
  const installGate = new Promise<void>((resolve) => { releaseInstall = resolve; });
  let installStarted!: () => void;
  const started = new Promise<void>((resolve) => { installStarted = resolve; });
  await manager.onToolCall({
    installCli: async (version: string) => { installed.push(version); installStarted(); await installGate; }
  });
  await started;
  let waited = false;
  const waiting = manager.waitForActiveUpdate().then(() => { waited = true; });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(waited, false, "the waiting call does not start while the install runs");
  releaseInstall();
  await waiting;
  assert.equal(waited, true);
  await manager.waitForBackgroundWork();
});
