import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import test, { after } from "node:test";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  attachCliToObject,
  attachCliToText,
  CliStateManager,
  compareSemver,
  DAILY_CHECK_INTERVAL_MS,
  formatCliReplyStatus,
  isStaleUpdating,
  isVersionOfferable,
  MAX_STATE_ERROR_CHARS,
  mutateStateFile,
  readStateFile,
  resolveStatePath,
  sanitizeStateReason,
  selectSelfCheckCandidates,
  setSyncHook,
  STALE_UPDATING_MS,
  syncHook,
  writeStateFile,
  type BridgeStateFile
} from "../clistate.js";
import { clearVersionCache, listFreeModels, writeCatalogSnapshot, type FreeModelList } from "../models.js";
import { pingAllModels, runPingAllCli, TOTAL_PING_ALL_CAP_MS } from "../pingall.js";
import { ClineRunError } from "../runner.js";
import { acquireSettingsMutex, DEFAULT_LOCK_TIMEOUT_MS, withProviderOverride } from "../settings.js";
import { buildEntry, readStatusEntry, resolveCatalogPath, resolveStatusPath, writeStatusEntry } from "../status.js";

const root = await mkdtemp(path.join(os.tmpdir(), "cline-clistate-test-"));
process.env.CLINE_MCP_STATE_PATH = path.join(root, "default-state.json");
process.env.CLINE_MCP_CATALOG_PATH = path.join(root, "default-catalog.json");
process.env.CLINE_MCP_STATUS_PATH = path.join(root, "default-status.json");
process.env.CLINE_PROVIDER_SETTINGS_PATH = path.join(root, "default-providers.json");
process.env.CLINE_MCP_TRACE_DIR = path.join(root, "default-traces");
after(() => rm(root, { recursive: true, force: true }));

let counter = 0;
function nextPaths() {
  const id = ++counter;
  const dir = path.join(root, `case-${id}`);
  return {
    dir,
    statePath: path.join(dir, "state.json"),
    catalogPath: path.join(dir, "catalog.json"),
    statusPath: path.join(dir, "status.json"),
    settingsPath: path.join(dir, "providers.json")
  };
}

async function createFakeCliInstall(cliVersion = "3.0.74", llmsVersion = "0.2.0") {
  const cliDir = path.join(root, `fake-cli-${++counter}`);
  const llmsDir = path.join(cliDir, "node_modules", "@cline", "llms");
  await mkdir(path.join(cliDir, "bin"), { recursive: true });
  await mkdir(llmsDir, { recursive: true });
  await writeFile(path.join(cliDir, "package.json"), JSON.stringify({ version: cliVersion }));
  await writeFile(path.join(llmsDir, "package.json"), JSON.stringify({ version: llmsVersion }));
  await writeFile(path.join(cliDir, "bin", "cline"), "// fake cline entry");
  return {
    cliDir,
    llmsDir,
    entryPath: path.join(cliDir, "bin", "cline"),
    cliPkg: path.join(cliDir, "package.json"),
    llmsPkg: path.join(llmsDir, "package.json")
  };
}

function makeCatalogModule(modelIds: string[]) {
  return {
    GENERATED_CLINE_RECOMMENDED_MODELS: {
      free: modelIds.map((id) => ({ id, name: `Model ${id}` }))
    },
    getGeneratedModelsForProvider: () =>
      Object.fromEntries(
        modelIds.map((id) => [id, { name: `Model ${id}`, contextWindow: 128000, capabilities: ["tools"] }])
      )
  };
}

const deferred = <T = void>() => {
  let resolve!: (val: T | PromiseLike<T>) => void;
  let reject!: (err?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

// --- 8.1 State file schema, atomic writes, lock, redaction, syncHook --------

test("8.1 state.json exact schema, stable machine_id, redaction, <=240 char limit, and syncHook", async () => {
  const { statePath, dir } = nextPaths();
  const install = await createFakeCliInstall("3.0.74", "0.2.0");
  const now = Date.parse("2026-11-10T09:00:00.000Z");

  const syncedStates: BridgeStateFile[] = [];
  setSyncHook((st) => {
    syncedStates.push(structuredClone(st));
  });

  try {
    const first = await mutateStateFile(
      statePath,
      (curr) => {
        curr.cli.last_error = `Failed with token=sk-1234567890abcdef and ${"x".repeat(300)}`;
        curr.cli.failed_versions.push({
          version: "3.0.75",
          failed_at: new Date(now).toISOString(),
          reason: `Authorization: Bearer super-secret-jwt-token ${"y".repeat(300)}`
        });
        return curr;
      },
      { entryPath: install.entryPath, wallNow: () => now }
    );

    const disk = JSON.parse(await readFile(statePath, "utf8"));
    assert.deepEqual(Object.keys(disk).sort(), ["cli", "machine_id", "updated_at", "version"]);
    assert.equal(disk.version, 1);
    assert.match(disk.machine_id, /^[0-9a-f-]{36}$/i);
    assert.equal(disk.updated_at, "2026-11-10T09:00:00.000Z");

    assert.deepEqual(Object.keys(disk.cli).sort(), [
      "catalog_version",
      "failed_versions",
      "last_check_at",
      "last_error",
      "latest_known_version",
      "previous_version",
      "update_state",
      "version"
    ]);
    assert.equal(disk.cli.version, "3.0.74");
    assert.equal(disk.cli.catalog_version, "0.2.0");
    assert.equal(disk.cli.update_state, "ok");
    assert.equal(disk.cli.latest_known_version, null);
    assert.equal(disk.cli.last_check_at, null);
    assert.equal(disk.cli.previous_version, null);

    // Redaction and <= 240 char limit
    assert.ok(!disk.cli.last_error.includes("sk-1234567890abcdef"));
    assert.ok(disk.cli.last_error.includes("<redacted>"));
    assert.ok(disk.cli.last_error.length <= MAX_STATE_ERROR_CHARS);

    assert.equal(disk.cli.failed_versions.length, 1);
    assert.ok(!disk.cli.failed_versions[0].reason.includes("super-secret-jwt-token"));
    assert.ok(disk.cli.failed_versions[0].reason.includes("<redacted>"));
    assert.ok(disk.cli.failed_versions[0].reason.length <= MAX_STATE_ERROR_CHARS);

    // machine_id is preserved across subsequent writes
    const second = await mutateStateFile(
      statePath,
      (curr) => {
        curr.cli.latest_known_version = "3.0.76";
        return curr;
      },
      { entryPath: install.entryPath, wallNow: () => now + 5000 }
    );
    assert.equal(second.machine_id, first.machine_id);
    assert.equal(syncedStates.length, 2);

    // A throwing syncHook never throws outward
    setSyncHook(() => {
      throw new Error("Supabase offline");
    });
    assert.doesNotThrow(() => syncHook(second));
    await assert.doesNotReject(
      writeStateFile(statePath, second, { entryPath: install.entryPath, wallNow: () => now + 10_000 })
    );

    // No stray .tmp files left behind
    const files = await readdir(dir);
    assert.deepEqual(files, ["state.json"]);
  } finally {
    setSyncHook(undefined);
  }
});

test("8.1 resolveStatePath respects CLINE_MCP_STATE_PATH and defaults to ~/.cline-mcp/state.json", () => {
  const prev = process.env.CLINE_MCP_STATE_PATH;
  try {
    delete process.env.CLINE_MCP_STATE_PATH;
    assert.equal(resolveStatePath(), path.join(os.homedir(), ".cline-mcp", "state.json"));
    assert.equal(resolveStatePath(null), undefined);
    process.env.CLINE_MCP_STATE_PATH = path.join(root, "custom-state.json");
    assert.equal(resolveStatePath(), path.resolve(root, "custom-state.json"));
  } finally {
    if (prev !== undefined) process.env.CLINE_MCP_STATE_PATH = prev;
    else delete process.env.CLINE_MCP_STATE_PATH;
  }
});

// --- 8.2 Catalog follows the CLI without restart ---------------------------

test("8.2 catalog follows the CLI: caches by mtime and reloads with ?v=<version> when package.json changes", async () => {
  clearVersionCache();
  const { statePath, catalogPath, statusPath } = nextPaths();
  const install = await createFakeCliInstall("3.0.74", "0.2.0");
  let currentModels = ["cline-free/model-v1"];
  const importedUrls: string[] = [];
  let pkgReadCount = 0;

  const customReadFile: typeof readFile = (async (p: any, enc?: any) => {
    if (String(p).endsWith("package.json")) pkgReadCount++;
    return readFile(p, enc);
  }) as any;

  const manager = new CliStateManager({
    statePath,
    catalogPath,
    statusPath,
    entryPath: install.entryPath,
    readFile: customReadFile,
    importModule: async (url) => {
      importedUrls.push(url);
      return makeCatalogModule(currentModels);
    }
  });

  // First call initializes state.json and writes catalog.json
  const first = await manager.syncCatalogIfChanged();
  assert.equal(first.reloaded, true);
  assert.equal(first.state.cli.version, "3.0.74");
  assert.equal(first.state.cli.catalog_version, "0.2.0");
  assert.equal(importedUrls.length, 1);
  assert.match(importedUrls[0], /\?v=0\.2\.0$/);
  const readsAfterFirst = pkgReadCount;
  const catalog1 = JSON.parse(await readFile(catalogPath, "utf8"));
  assert.deepEqual(catalog1.models.map((m: any) => m.id), ["cline-free/model-v1"]);
  assert.equal(catalog1.source.cliVersion, "3.0.74");
  assert.equal(catalog1.source.version, "0.2.0");

  // Second call with unchanged files hits the mtime cache: no package.json readFile, no catalog re-import
  const second = await manager.syncCatalogIfChanged();
  assert.equal(second.reloaded, false);
  assert.equal(pkgReadCount, readsAfterFirst, "unchanged package.json files must be served from mtime cache");
  assert.equal(importedUrls.length, 1);

  // Simulate CLI and @cline/llms upgrade on disk without restarting the bridge.
  // Advance mtime explicitly so NTFS 15.6 ms clock tick granularity cannot share the previous mtimeMs.
  currentModels = ["cline-free/model-v1", "cline-free/model-v2"];
  await writeFile(install.cliPkg, JSON.stringify({ version: "3.0.75" }));
  await writeFile(install.llmsPkg, JSON.stringify({ version: "0.3.0" }));
  const bumpedMtime = new Date(Date.now() + 2_000);
  await utimes(install.cliPkg, bumpedMtime, bumpedMtime);
  await utimes(install.llmsPkg, bumpedMtime, bumpedMtime);

  const third = await manager.syncCatalogIfChanged();
  assert.equal(third.reloaded, true);
  assert.equal(third.state.cli.version, "3.0.75");
  assert.equal(third.state.cli.catalog_version, "0.3.0");
  assert.equal(importedUrls.length, 2);
  assert.match(importedUrls[1], /\?v=0\.3\.0$/, "dynamic import URL must be cache-busted with ?v=<version>");

  const catalog2 = JSON.parse(await readFile(catalogPath, "utf8"));
  assert.deepEqual(catalog2.models.map((m: any) => m.id), ["cline-free/model-v1", "cline-free/model-v2"]);
  assert.equal(catalog2.source.cliVersion, "3.0.75");
  assert.equal(catalog2.source.version, "0.3.0");
});

// --- 8.5 Daily check once per 24 h -----------------------------------------

test("8.5 daily check runs only once per 24 h in the background without delaying the tool call", async () => {
  const { statePath, catalogPath, statusPath, settingsPath } = nextPaths();
  const install = await createFakeCliInstall("3.0.74", "0.2.0");
  let now = Date.parse("2026-11-10T10:00:00.000Z");
  let viewCalls = 0;
  const checkEntered = deferred();
  const gate = deferred<string>();

  const manager = new CliStateManager({
    statePath,
    catalogPath,
    statusPath,
    providerSettingsPath: settingsPath,
    entryPath: install.entryPath,
    wallNow: () => now,
    importModule: async () => makeCatalogModule(["cline-free/m1"]),
    checkLatestVersion: async () => {
      viewCalls++;
      checkEntered.resolve();
      return gate.promise;
    },
    installCli: async () => {}
  });

  // First tool call starts background check and returns immediately while gate is still pending
  const stateOnCall = await manager.onToolCall();
  assert.equal(stateOnCall.cli.version, "3.0.74");
  await checkEntered.promise;
  assert.equal(viewCalls, 1);

  // Release the npm view check returning current version (no update needed)
  gate.resolve("3.0.74");
  await manager.waitForBackgroundWork();

  const afterFirstCheck = await readStateFile(statePath);
  assert.equal(afterFirstCheck.cli.last_check_at, new Date(now).toISOString());
  assert.equal(afterFirstCheck.cli.update_state, "ok");

  // Calls at +1h and +23h59m must NOT trigger another check
  now += 60 * 60 * 1000;
  await manager.onToolCall();
  await manager.waitForBackgroundWork();
  assert.equal(viewCalls, 1);

  now += 22 * 60 * 60 * 1000 + 59 * 60 * 1000;
  await manager.onToolCall();
  await manager.waitForBackgroundWork();
  assert.equal(viewCalls, 1);

  // At +24h + 1s, the next tool call triggers a new background check
  now += 61 * 1000;
  const secondGate = deferred<string>();
  await manager.onToolCall({
    checkLatestVersion: async () => {
      viewCalls++;
      return secondGate.promise;
    }
  });
  secondGate.resolve("3.0.74");
  await manager.waitForBackgroundWork();
  assert.equal(viewCalls, 2);
});

// --- 8.6 Busy machine -> deferred; settings mutex held during install ------

test("8.6 busy machine defers update while journal has a live run, then installs on later call and holds settings mutex", async () => {
  const { dir, statePath, catalogPath, statusPath, settingsPath } = nextPaths();
  await mkdir(dir, { recursive: true });
  const install = await createFakeCliInstall("3.0.74", "0.2.0");
  await writeFile(settingsPath, JSON.stringify({ lastUsedProvider: "cline", providers: {} }));
  const now = Date.parse("2026-11-10T11:00:00.000Z");

  const installedVersions: string[] = [];
  const pingedModels: string[] = [];

  const manager = new CliStateManager({
    statePath,
    catalogPath,
    statusPath,
    providerSettingsPath: settingsPath,
    entryPath: install.entryPath,
    wallNow: () => now,
    importModule: async () => makeCatalogModule(["cline-free/first-model", "cline-free/second-model"]),
    checkLatestVersion: async () => "3.0.75",
    installCli: async (v) => {
      installedVersions.push(v);
      await writeFile(install.cliPkg, JSON.stringify({ version: v }));
    },
    pingModel: async (input) => {
      pingedModels.push(`${input.provider}:${input.model}`);
      return {
        state: "available",
        provider: input.provider!,
        model: input.model!,
        checked_at: new Date(now).toISOString(),
        expires_at: new Date(now + 60_000).toISOString(),
        reason: "replied PONG",
        source: "ping",
        cached: false
      };
    }
  });

  // Simulate an active Cline run registered in the settings journal via withProviderOverride
  const activeRunEntered = deferred();
  const finishActiveRun = deferred();
  const activeRun = withProviderOverride(
    { provider: "cline", model: "cline-free/first-model" },
    settingsPath,
    undefined,
    async () => {
      activeRunEntered.resolve();
      await finishActiveRun.promise;
      return {};
    }
  );
  await activeRunEntered.promise;

  // Tool call while run is active: daily check finds 3.0.75 -> update_available, but install is deferred!
  await manager.onToolCall();
  await manager.waitForBackgroundWork();

  const stateWhileBusy = await readStateFile(statePath);
  assert.equal(stateWhileBusy.cli.update_state, "update_available");
  assert.equal(stateWhileBusy.cli.latest_known_version, "3.0.75");
  assert.deepEqual(installedVersions, [] as string[], "must not install while a Cline run is active in the journal");

  // Finish the active run so the journal is clean
  finishActiveRun.resolve();
  await activeRun;

  // Next tool call retries the pending update while holding the settings mutex
  const installStarted = deferred();
  const releaseInstall = deferred();
  let stateDuringInstall: BridgeStateFile | undefined;

  const updatePromise = manager.onToolCall({
    installCli: async (v) => {
      installedVersions.push(v);
      stateDuringInstall = await readStateFile(statePath);
      installStarted.resolve();
      await releaseInstall.promise;
      await writeFile(install.cliPkg, JSON.stringify({ version: v }));
    }
  });
  await updatePromise;
  await installStarted.promise;

  // While install is running: state is "updating" with pid and timestamp, and settings mutex is held
  assert.equal(stateDuringInstall?.cli.update_state, "updating");
  assert.equal(stateDuringInstall?.cli.updating_pid, process.pid);
  assert.equal(DEFAULT_LOCK_TIMEOUT_MS, 60_000);

  // A new caller waiting on the settings mutex with a short timeout gets settings_lock_timeout
  let lockClock = 0;
  await assert.rejects(
    acquireSettingsMutex(settingsPath, undefined, {
      lockTimeoutMs: 30,
      nowFn: () => lockClock,
      sleep: async (ms) => {
        lockClock += ms;
      }
    }),
    (err: unknown) => err instanceof ClineRunError && err.kind === "settings_lock_timeout"
  );

  releaseInstall.resolve();
  await manager.waitForBackgroundWork();

  const finalState = await readStateFile(statePath);
  assert.equal(finalState.cli.update_state, "ok");
  assert.equal(finalState.cli.version, "3.0.75");
  assert.equal(finalState.cli.previous_version, "3.0.74");
  assert.equal(finalState.cli.last_error, null);
  assert.equal("updating_pid" in finalState.cli, false);
  assert.deepEqual(installedVersions, ["3.0.75"]);
  assert.deepEqual(pingedModels, ["cline:cline-free/first-model"]);
});

// --- 8.6 Failure -> rollback; rollback failure -> broken -------------------

test("8.6 self-check failure rolls back to previous version, sets rolled_back, and records failed_versions", async () => {
  const { statePath, catalogPath, statusPath, settingsPath } = nextPaths();
  const install = await createFakeCliInstall("3.0.74", "0.2.0");
  const now = Date.parse("2026-11-10T12:00:00.000Z");
  const installedVersions: string[] = [];

  const manager = new CliStateManager({
    statePath,
    catalogPath,
    statusPath,
    providerSettingsPath: settingsPath,
    entryPath: install.entryPath,
    wallNow: () => now,
    importModule: async () => makeCatalogModule(["cline-free/first-model"]),
    checkLatestVersion: async () => "3.0.75",
    installCli: async (v) => {
      installedVersions.push(v);
      await writeFile(install.cliPkg, JSON.stringify({ version: v }));
    },
    pingModel: async (input) => ({
      state: "unreachable",
      provider: input.provider!,
      model: input.model!,
      checked_at: new Date(now).toISOString(),
      expires_at: new Date(now + 60_000).toISOString(),
      reason: "CLI 3.0.75 crashed with token=sk-secret1234567890",
      source: "ping",
      cached: false
    })
  });

  await manager.onToolCall();
  await manager.waitForBackgroundWork();

  assert.deepEqual(installedVersions, ["3.0.75", "3.0.74"], "must install 3.0.75 then reinstall 3.0.74 on rollback");
  const state = await readStateFile(statePath);
  assert.equal(state.cli.update_state, "rolled_back");
  assert.equal(state.cli.version, "3.0.74");
  assert.equal(state.cli.failed_versions.length, 1);
  assert.equal(state.cli.failed_versions[0].version, "3.0.75");
  assert.match(state.cli.failed_versions[0].reason, /self-check ping failed/);
  assert.ok(!state.cli.failed_versions[0].reason.includes("sk-secret1234567890"), "reason must be redacted");
  assert.ok(state.cli.last_error?.includes("<redacted>"));
});

test("8.6 rollback install failure transitions update_state to broken", async () => {
  const { statePath, catalogPath, statusPath, settingsPath } = nextPaths();
  const install = await createFakeCliInstall("3.0.74", "0.2.0");
  const now = Date.parse("2026-11-10T12:30:00.000Z");
  const attempts: string[] = [];

  const manager = new CliStateManager({
    statePath,
    catalogPath,
    statusPath,
    providerSettingsPath: settingsPath,
    entryPath: install.entryPath,
    wallNow: () => now,
    importModule: async () => makeCatalogModule(["cline-free/first-model"]),
    checkLatestVersion: async () => "3.0.75",
    installCli: async (v) => {
      attempts.push(v);
      throw new Error(`npm install ${v} failed: EACCES permission denied`);
    }
  });

  await manager.onToolCall();
  await manager.waitForBackgroundWork();

  assert.deepEqual(attempts, ["3.0.75", "3.0.74"]);
  const state = await readStateFile(statePath);
  assert.equal(state.cli.update_state, "broken");
  assert.equal(state.cli.failed_versions.length, 1);
  assert.equal(state.cli.failed_versions[0].version, "3.0.75");
  assert.match(state.cli.last_error ?? "", /rollback to 3\.0\.74 failed/);
});

// --- 8.5 & 8.6 Failed version never retried; only newer one is -------------

test("8.5/8.6 versions <= a failed version are never offered; a strictly newer version is installed", async () => {
  const { statePath, catalogPath, statusPath, settingsPath } = nextPaths();
  const install = await createFakeCliInstall("3.0.74", "0.2.0");
  let now = Date.parse("2026-11-10T13:00:00.000Z");
  let registryLatest = "3.0.76";
  let shouldFailPing = true;
  const installedVersions: string[] = [];

  const manager = new CliStateManager({
    statePath,
    catalogPath,
    statusPath,
    providerSettingsPath: settingsPath,
    entryPath: install.entryPath,
    wallNow: () => now,
    importModule: async () => makeCatalogModule(["cline-free/first-model"]),
    checkLatestVersion: async () => registryLatest,
    installCli: async (v) => {
      installedVersions.push(v);
      await writeFile(install.cliPkg, JSON.stringify({ version: v }));
    },
    pingModel: async (input) => ({
      state: shouldFailPing ? "unreachable" : "available",
      provider: input.provider!,
      model: input.model!,
      checked_at: new Date(now).toISOString(),
      expires_at: new Date(now + 60_000).toISOString(),
      reason: shouldFailPing ? "broken release" : "replied PONG",
      source: "ping",
      cached: false
    })
  });

  // Day 1: 3.0.76 fails self-check and rolls back to 3.0.74
  await manager.onToolCall();
  await manager.waitForBackgroundWork();
  assert.deepEqual(installedVersions, ["3.0.76", "3.0.74"]);
  assert.equal((await readStateFile(statePath)).cli.update_state, "rolled_back");

  // Day 2: registry still reports 3.0.76 -> never retried
  shouldFailPing = false;
  now += DAILY_CHECK_INTERVAL_MS + 1000;
  await manager.onToolCall();
  await manager.waitForBackgroundWork();
  assert.deepEqual(installedVersions, ["3.0.76", "3.0.74"], "failed version 3.0.76 must never be retried");
  assert.equal((await readStateFile(statePath)).cli.update_state, "rolled_back");

  // Day 3: registry reports 3.0.75 (< failed version 3.0.76) -> never offered either
  registryLatest = "3.0.75";
  now += DAILY_CHECK_INTERVAL_MS + 1000;
  await manager.onToolCall();
  await manager.waitForBackgroundWork();
  assert.deepEqual(installedVersions, ["3.0.76", "3.0.74"], "version <= failed version must never be offered");
  assert.equal((await readStateFile(statePath)).cli.update_state, "rolled_back");

  // Day 4: registry reports 3.0.77 (> failed version 3.0.76) -> offered and installed!
  registryLatest = "3.0.77";
  now += DAILY_CHECK_INTERVAL_MS + 1000;
  await manager.onToolCall();
  await manager.waitForBackgroundWork();
  assert.deepEqual(installedVersions, ["3.0.76", "3.0.74", "3.0.77"]);

  const state = await readStateFile(statePath);
  assert.equal(state.cli.update_state, "ok");
  assert.equal(state.cli.version, "3.0.77");
  assert.equal(state.cli.previous_version, "3.0.74");
  assert.equal(state.cli.failed_versions.length, 1);
  assert.equal(state.cli.failed_versions[0].version, "3.0.76");
});

// --- 8.6 Two bridges -> one updater ----------------------------------------

test("8.6 two bridges on the same machine: only one runs the update", async () => {
  const { statePath, catalogPath, statusPath, settingsPath } = nextPaths();
  const install = await createFakeCliInstall("3.0.74", "0.2.0");
  const now = Date.parse("2026-11-10T14:00:00.000Z");

  // Pre-seed state.json with update_available for 3.0.75
  await mutateStateFile(
    statePath,
    (curr) => {
      curr.cli.version = "3.0.74";
      curr.cli.catalog_version = "0.2.0";
      curr.cli.update_state = "update_available";
      curr.cli.latest_known_version = "3.0.75";
      curr.cli.last_check_at = new Date(now).toISOString();
      return curr;
    },
    { entryPath: install.entryPath, wallNow: () => now }
  );

  const installEntered = deferred();
  const finishInstall = deferred();
  const installersRan: string[] = [];

  const makeBridge = (name: string, pid: number) =>
    new CliStateManager({
      statePath,
      catalogPath,
      statusPath,
      providerSettingsPath: settingsPath,
      entryPath: install.entryPath,
      wallNow: () => now,
      pid,
      isProcessAlive: () => true,
      importModule: async () => makeCatalogModule(["cline-free/m1"]),
      installCli: async (v) => {
        installersRan.push(`${name}:${v}`);
        installEntered.resolve();
        await finishInstall.promise;
        await writeFile(install.cliPkg, JSON.stringify({ version: v }));
      },
      pingModel: async (input) => ({
        state: "available",
        provider: input.provider!,
        model: input.model!,
        checked_at: new Date(now).toISOString(),
        expires_at: new Date(now + 60_000).toISOString(),
        reason: "replied PONG",
        source: "ping",
        cached: false
      })
    });

  const bridgeA = makeBridge("bridgeA", 1001);
  const bridgeB = makeBridge("bridgeB", 1002);

  const pA = bridgeA.runSafeUpdate();
  await installEntered.promise;

  // Bridge B tries to update while Bridge A is in "updating"
  const stateSeenByB = await bridgeB.runSafeUpdate();
  assert.equal(stateSeenByB.cli.update_state, "updating");
  assert.equal(stateSeenByB.cli.updating_pid, 1001);

  finishInstall.resolve();
  const finalA = await pA;
  assert.equal(finalA.cli.update_state, "ok");
  assert.equal(finalA.cli.version, "3.0.75");
  assert.equal(installersRan.length, 1, "only one bridge may execute the install");
});

// --- 8.6 Stale updating recovered ------------------------------------------

test("8.6 stale updating (>15 min with dead pid) is recovered and update completes", async () => {
  const { statePath, catalogPath, statusPath, settingsPath } = nextPaths();
  const install = await createFakeCliInstall("3.0.74", "0.2.0");
  const startMs = Date.parse("2026-11-10T15:00:00.000Z");
  let now = startMs;

  await mutateStateFile(
    statePath,
    (curr) => {
      curr.cli.version = "3.0.74";
      curr.cli.catalog_version = "0.2.0";
      curr.cli.update_state = "updating";
      curr.cli.latest_known_version = "3.0.75";
      curr.cli.last_check_at = new Date(startMs).toISOString();
      curr.cli.updating_pid = 999999;
      curr.cli.updating_started_at = new Date(startMs).toISOString();
      return curr;
    },
    { entryPath: install.entryPath, wallNow: () => now }
  );

  // At +10 min (not yet 15 min) or with live pid: not stale
  now = startMs + 10 * 60 * 1000;
  assert.equal(isStaleUpdating(await readStateFile(statePath), { wallNow: () => now, isProcessAlive: () => false }), false);
  now = startMs + STALE_UPDATING_MS + 1000;
  assert.equal(isStaleUpdating(await readStateFile(statePath), { wallNow: () => now, isProcessAlive: () => true }), false);
  assert.equal(isStaleUpdating(await readStateFile(statePath), { wallNow: () => now, isProcessAlive: () => false }), true);

  // Bridge recovers the stale updating state and installs 3.0.75
  const installed: string[] = [];
  const manager = new CliStateManager({
    statePath,
    catalogPath,
    statusPath,
    providerSettingsPath: settingsPath,
    entryPath: install.entryPath,
    wallNow: () => now,
    isProcessAlive: (pid) => pid === process.pid,
    importModule: async () => makeCatalogModule(["cline-free/m1"]),
    installCli: async (v) => {
      installed.push(v);
      await writeFile(install.cliPkg, JSON.stringify({ version: v }));
    },
    pingModel: async (input) => ({
      state: "available",
      provider: input.provider!,
      model: input.model!,
      checked_at: new Date(now).toISOString(),
      expires_at: new Date(now + 60_000).toISOString(),
      reason: "replied PONG",
      source: "ping",
      cached: false
    })
  });

  await manager.onToolCall();
  await manager.waitForBackgroundWork();

  assert.deepEqual(installed, ["3.0.75"]);
  const finalState = await readStateFile(statePath);
  assert.equal(finalState.cli.update_state, "ok");
  assert.equal(finalState.cli.version, "3.0.75");
  assert.equal(finalState.cli.previous_version, "3.0.74");
});

// --- 8.6 Shutdown behavior (D-22) ------------------------------------------

test("8.6 shutdown prevents new updates from starting and waits for a running install", async () => {
  const { statePath, catalogPath, statusPath, settingsPath } = nextPaths();
  const install = await createFakeCliInstall("3.0.74", "0.2.0");
  const now = Date.parse("2026-11-10T16:00:00.000Z");

  const installStarted = deferred();
  const finishInstall = deferred();
  let installCompleted = false;

  const manager = new CliStateManager({
    statePath,
    catalogPath,
    statusPath,
    providerSettingsPath: settingsPath,
    entryPath: install.entryPath,
    wallNow: () => now,
    importModule: async () => makeCatalogModule(["cline-free/m1"]),
    checkLatestVersion: async () => "3.0.75",
    installCli: async (v) => {
      installStarted.resolve();
      await finishInstall.promise;
      await writeFile(install.cliPkg, JSON.stringify({ version: v }));
      installCompleted = true;
    },
    pingModel: async (input) => ({
      state: "available",
      provider: input.provider!,
      model: input.model!,
      checked_at: new Date(now).toISOString(),
      expires_at: new Date(now + 60_000).toISOString(),
      reason: "replied PONG",
      source: "ping",
      cached: false
    })
  });

  await manager.onToolCall();
  await installStarted.promise;

  // Trigger shutdown while install is in flight
  manager.notifyShutdown();
  const waitPromise = manager.waitForActiveUpdate();
  assert.equal(installCompleted, false);

  finishInstall.resolve();
  await waitPromise;
  assert.equal(installCompleted, true);
  assert.equal((await readStateFile(statePath)).cli.update_state, "ok");

  // No new update starts after shutdown
  let checkCalledAfterShutdown = false;
  const shutManager = new CliStateManager({
    statePath,
    catalogPath,
    statusPath,
    providerSettingsPath: settingsPath,
    entryPath: install.entryPath,
    wallNow: () => now + DAILY_CHECK_INTERVAL_MS * 2,
    checkLatestVersion: async () => {
      checkCalledAfterShutdown = true;
      return "3.0.76";
    }
  });
  shutManager.notifyShutdown();
  await shutManager.onToolCall();
  await shutManager.waitForBackgroundWork();
  assert.equal(checkCalledAfterShutdown, false);
});

// --- 8.7 Status in replies -------------------------------------------------

test("8.7 cli field is omitted when ok (except cline_list_models) and included in JSON and text replies when not ok", async () => {
  const { statePath, statusPath } = nextPaths();
  const install = await createFakeCliInstall("3.0.74", "0.2.0");
  const now = Date.parse("2026-11-10T17:00:00.000Z");

  const okState = await mutateStateFile(
    statePath,
    (curr) => {
      curr.cli.version = "3.0.74";
      curr.cli.update_state = "ok";
      return curr;
    },
    { entryPath: install.entryPath, wallNow: () => now }
  );

  // Regular replies omit cli when state is "ok"
  assert.deepEqual(attachCliToObject({ text: "hello" }, okState), { text: "hello" });
  assert.equal(attachCliToText("Kind: timeout\n\nMessage: slow", okState), "Kind: timeout\n\nMessage: slow");

  // cline_list_models always includes cli
  assert.deepEqual(attachCliToObject({ models: [] }, okState, { always: true }), {
    models: [],
    cli: { state: "ok", version: "3.0.74" }
  });
  const listResult = await listFreeModels({
    entryPath: install.entryPath,
    statusPath,
    statePath,
    importModule: async () => makeCatalogModule(["cline-free/m1"])
  });
  assert.deepEqual(listResult.cli, { state: "ok", version: "3.0.74" });

  // When rolled_back, cli includes state, version, latest, and failed
  const rolledBackState = await mutateStateFile(
    statePath,
    (curr) => {
      curr.cli.version = "3.0.74";
      curr.cli.update_state = "rolled_back";
      curr.cli.latest_known_version = "3.0.75";
      curr.cli.failed_versions = [
        { version: "3.0.75", failed_at: new Date(now).toISOString(), reason: "self-check ping failed" }
      ];
      return curr;
    },
    { entryPath: install.entryPath, wallNow: () => now }
  );

  const expectedCli = {
    state: "rolled_back" as const,
    version: "3.0.74",
    latest: "3.0.75",
    failed: { version: "3.0.75", reason: "self-check ping failed" }
  };
  assert.deepEqual(formatCliReplyStatus(rolledBackState), expectedCli);
  assert.deepEqual(attachCliToObject({ text: "answer" }, rolledBackState), {
    text: "answer",
    cli: expectedCli
  });
  const errText = attachCliToText("Kind: timeout\n\nMessage: slow", rolledBackState);
  assert.ok(errText.endsWith(`\n\ncli: ${JSON.stringify(expectedCli)}`));
});

// --- 6. Refresh ping script (src/pingall.ts) -------------------------------

test("6. pingall sequentially pings every catalog model, records status.json, outputs one-line JSON summary, and enforces total cap", async () => {
  const { statePath, catalogPath, statusPath, settingsPath } = nextPaths();
  const install = await createFakeCliInstall("3.0.74", "0.2.0");
  const now = Date.parse("2026-11-10T18:00:00.000Z");

  assert.equal(TOTAL_PING_ALL_CAP_MS, 120_000);

  const lines: string[] = [];
  const callOrder: string[] = [];

  const summary = await runPingAllCli({
    catalogPath,
    catalogDeps: {
      entryPath: install.entryPath,
      statusPath,
      statePath,
      importModule: async () => makeCatalogModule(["cline-free/m1", "cline-free/m2", "cline-free/m3"])
    },
    pingDeps: {
      statusPath,
      providerSettingsPath: settingsPath,
      wallNow: () => now
    },
    pingModel: async (input) => {
      callOrder.push(`${input.provider}:${input.model}`);
      const state =
        input.model === "cline-free/m1"
          ? "available"
          : input.model === "cline-free/m2"
            ? "rate_limited"
            : "unreachable";
      return {
        state,
        provider: input.provider!,
        model: input.model!,
        latency_ms: 12,
        checked_at: new Date(now).toISOString(),
        expires_at: new Date(now + 60_000).toISOString(),
        reason: `test ${state}`,
        source: "ping",
        cached: false
      };
    },
    writeLine: (line) => lines.push(line)
  });

  assert.equal(process.exitCode, 0);
  assert.deepEqual(callOrder, ["cline:cline-free/m1", "cline:cline-free/m2", "cline:cline-free/m3"]);
  assert.equal(summary.ok, true);
  assert.equal(summary.total, 3);
  assert.equal(summary.checked, 3);
  assert.equal(summary.available, 1);
  assert.equal(summary.rate_limited, 1);
  assert.equal(summary.unreachable, 1);
  assert.equal(summary.skipped, 0);
  assert.equal(summary.timed_out, false);
  assert.equal(lines.length, 1);
  assert.ok(!lines[0].includes("\n"), "summary must be a single line of JSON");
  assert.deepEqual(JSON.parse(lines[0]), summary);

  // Verify real clinePing integration records into status.json and total cap skips remaining models
  let clock = 0;
  const capped = await pingAllModels({
    totalCapMs: 50,
    now: () => clock,
    catalogPath,
    catalogDeps: {
      entryPath: install.entryPath,
      statusPath,
      statePath,
      importModule: async () => makeCatalogModule(["cline-free/fast", "cline-free/skipped-after-cap"])
    },
    pingModel: async (input) => {
      clock += 60; // Exceeds the 50 ms total cap after the first model
      return {
        state: "available",
        provider: input.provider!,
        model: input.model!,
        checked_at: new Date(now).toISOString(),
        expires_at: new Date(now + 60_000).toISOString(),
        reason: "replied PONG",
        source: "ping",
        cached: false
      };
    }
  });

  assert.equal(capped.ok, true);
  assert.equal(capped.total, 2);
  assert.equal(capped.checked, 1);
  assert.equal(capped.available, 1);
  assert.equal(capped.skipped, 1);
  assert.equal(capped.timed_out, true);
  assert.equal(capped.results[1].state, "skipped");
});

test("semver and sanitize helpers handle edge cases", () => {
  assert.equal(compareSemver("3.0.75", "3.0.74"), 1);
  assert.equal(compareSemver("3.0.74", "3.0.75"), -1);
  assert.equal(compareSemver("3.0.74", "3.0.74"), 0);
  assert.equal(compareSemver("3.0.75", "3.0.75-beta.1"), 1);
  assert.equal(isVersionOfferable("3.0.75", "3.0.74", []), true);
  assert.equal(isVersionOfferable("3.0.74", "3.0.74", []), false);
  assert.equal(
    isVersionOfferable("3.0.75", "3.0.74", [{ version: "3.0.76", failed_at: "2026-11-10T00:00:00Z", reason: "bad" }]),
    false
  );
  assert.equal(sanitizeStateReason(null), null);
  assert.equal(sanitizeStateReason("   "), null);
});

test("8.5/8.6 execNpm runner passes exact npm view (30s) and npm install -g (300s) args and runs default clinePing self-check", async () => {
  const { dir, statePath, catalogPath, statusPath, settingsPath } = nextPaths();
  await mkdir(dir, { recursive: true });
  const install = await createFakeCliInstall("3.0.74", "0.2.0");
  await writeFile(settingsPath, JSON.stringify({ lastUsedProvider: "cline", providers: {} }));
  const now = Date.parse("2026-11-10T19:00:00.000Z");

  const npmCalls: Array<{ args: string[]; timeoutMs: number }> = [];
  const { EventEmitter } = await import("node:events");

  const mockClineSpawn = () => {
    const child = new EventEmitter() as any;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdout.destroy = () => {};
    child.stderr.destroy = () => {};
    child.kill = () => {};
    queueMicrotask(() => {
      child.stdout.emit(
        "data",
        Buffer.from(JSON.stringify({ type: "run_result", finishReason: "completed", text: "PONG" }) + "\n")
      );
      child.emit("close", 0);
    });
    return child;
  };

  const manager = new CliStateManager({
    statePath,
    catalogPath,
    statusPath,
    providerSettingsPath: settingsPath,
    entryPath: install.entryPath,
    wallNow: () => now,
    importModule: async () => makeCatalogModule(["cline-free/self-check-model"]),
    execNpm: async (args, options) => {
      npmCalls.push({ args, timeoutMs: options.timeoutMs });
      if (args[0] === "view") {
        return { stdout: "3.0.75\n", stderr: "", exitCode: 0 };
      }
      if (args[0] === "install") {
        const pkgSpec = args[2];
        const ver = pkgSpec.split("@")[1];
        await writeFile(install.cliPkg, JSON.stringify({ version: ver }));
        return { stdout: "added 1 package\n", stderr: "", exitCode: 0 };
      }
      return { stdout: "", stderr: "unknown command", exitCode: 1 };
    },
    pingDeps: {
      spawn: mockClineSpawn as any,
      access: async () => {},
      entryPath: install.entryPath,
      providerSettingsPath: settingsPath,
      statusPath,
      wallNow: () => now
    }
  });

  await manager.onToolCall();
  await manager.waitForBackgroundWork();

  assert.deepEqual(npmCalls, [
    { args: ["view", "cline", "version"], timeoutMs: 30_000 },
    { args: ["install", "-g", "cline@3.0.75"], timeoutMs: 300_000 }
  ]);

  const state = await readStateFile(statePath);
  assert.equal(state.cli.update_state, "ok");
  assert.equal(state.cli.version, "3.0.75");
  assert.equal(state.cli.previous_version, "3.0.74");

  const statusEntry = await readStatusEntry(statusPath, "cline", "cline-free/self-check-model");
  assert.equal(statusEntry?.state, "available");
  assert.equal(statusEntry?.source, "ping");
});

// --- Review round 1: P1, P2, P3 tests --------------------------------------

test("P1: first catalog model unusable but second available -> self-check passes without rollback", async () => {
  const { statePath, catalogPath, statusPath, settingsPath } = nextPaths();
  const install = await createFakeCliInstall("3.0.74", "0.2.0");
  const now = Date.parse("2026-11-10T20:00:00.000Z");
  const installedVersions: string[] = [];
  const pingedModels: string[] = [];

  const manager = new CliStateManager({
    statePath,
    catalogPath,
    statusPath,
    providerSettingsPath: settingsPath,
    entryPath: install.entryPath,
    wallNow: () => now,
    importModule: async () =>
      makeCatalogModule(["reflection/beam-free", "cline-free/working-model", "cline-free/third-model"]),
    checkLatestVersion: async () => "3.0.75",
    installCli: async (v) => {
      installedVersions.push(v);
      await writeFile(install.cliPkg, JSON.stringify({ version: v }));
    },
    pingModel: async (input) => {
      pingedModels.push(input.model!);
      if (input.model === "reflection/beam-free") {
        return {
          state: "unreachable",
          provider: input.provider!,
          model: input.model!,
          checked_at: new Date(now).toISOString(),
          expires_at: new Date(now + 60_000).toISOString(),
          reason: "Insufficient balance",
          source: "ping",
          cached: false
        };
      }
      return {
        state: "available",
        provider: input.provider!,
        model: input.model!,
        checked_at: new Date(now).toISOString(),
        expires_at: new Date(now + 60_000).toISOString(),
        reason: "replied PONG",
        source: "ping",
        cached: false
      };
    }
  });

  await manager.onToolCall();
  await manager.waitForBackgroundWork();

  assert.deepEqual(installedVersions, ["3.0.75"], "must not roll back when second candidate succeeds");
  assert.deepEqual(
    pingedModels,
    ["reflection/beam-free", "cline-free/working-model"],
    "must stop pinging after the first available candidate"
  );
  const state = await readStateFile(statePath);
  assert.equal(state.cli.update_state, "ok");
  assert.equal(state.cli.version, "3.0.75");
  assert.equal(state.cli.previous_version, "3.0.74");
  assert.equal(state.cli.failed_versions.length, 0);
});

test("P1: all three candidates fail -> rolls back with reason naming each tried model and state", async () => {
  const { statePath, catalogPath, statusPath, settingsPath } = nextPaths();
  const install = await createFakeCliInstall("3.0.74", "0.2.0");
  const now = Date.parse("2026-11-10T20:15:00.000Z");
  const installedVersions: string[] = [];
  const pingedModels: string[] = [];

  const manager = new CliStateManager({
    statePath,
    catalogPath,
    statusPath,
    providerSettingsPath: settingsPath,
    entryPath: install.entryPath,
    wallNow: () => now,
    importModule: async () =>
      makeCatalogModule([
        "reflection/beam-free",
        "cline-free/model-two",
        "cline-free/model-three",
        "cline-free/model-four-untried"
      ]),
    checkLatestVersion: async () => "3.0.75",
    installCli: async (v) => {
      installedVersions.push(v);
      await writeFile(install.cliPkg, JSON.stringify({ version: v }));
    },
    pingModel: async (input) => {
      pingedModels.push(input.model!);
      const stateMap: Record<string, "unreachable" | "rate_limited" | "quota_exhausted"> = {
        "reflection/beam-free": "unreachable",
        "cline-free/model-two": "rate_limited",
        "cline-free/model-three": "quota_exhausted"
      };
      const st = stateMap[input.model!] ?? "unreachable";
      return {
        state: st,
        provider: input.provider!,
        model: input.model!,
        checked_at: new Date(now).toISOString(),
        expires_at: new Date(now + 60_000).toISOString(),
        reason: `${input.model} failed (${st})`,
        source: "ping",
        cached: false
      };
    }
  });

  await manager.onToolCall();
  await manager.waitForBackgroundWork();

  assert.deepEqual(
    pingedModels,
    ["reflection/beam-free", "cline-free/model-two", "cline-free/model-three"],
    "must try up to 3 candidates"
  );
  assert.deepEqual(installedVersions, ["3.0.75", "3.0.74"]);

  const state = await readStateFile(statePath);
  assert.equal(state.cli.update_state, "rolled_back");
  assert.equal(state.cli.version, "3.0.74");
  assert.equal(state.cli.failed_versions.length, 1);
  const reason = state.cli.failed_versions[0].reason;
  assert.match(reason, /reflection\/beam-free:\s*unreachable/);
  assert.match(reason, /cline-free\/model-two:\s*rate_limited/);
  assert.match(reason, /cline-free\/model-three:\s*quota_exhausted/);
});

test("P1: models with last observation 'available' in status.json (ignoring expiry, newest checked_at first) are tried first", async () => {
  const { statePath, catalogPath, statusPath, settingsPath } = nextPaths();
  const install = await createFakeCliInstall("3.0.74", "0.2.0");
  const now = Date.parse("2026-11-10T20:30:00.000Z");

  // Write observations in status.json:
  // - reflection/beam-free: unreachable (newest timestamp, but not available)
  // - cline-free/older-avail: available at now - 2 hours (expired TTL, still counts as last observation available)
  // - cline-free/newer-avail: available at now - 10 minutes (expired TTL, newer checked_at than older-avail)
  await writeStatusEntry(
    statusPath,
    buildEntry(
      {
        provider: "cline",
        model: "reflection/beam-free",
        classification: { state: "unreachable" },
        reason: "Insufficient balance",
        source: "ping"
      },
      now - 60_000
    )
  );
  await writeStatusEntry(
    statusPath,
    buildEntry(
      {
        provider: "cline",
        model: "cline-free/older-avail",
        classification: { state: "available" },
        reason: "replied PONG",
        source: "ping"
      },
      now - 2 * 60 * 60 * 1000
    )
  );
  await writeStatusEntry(
    statusPath,
    buildEntry(
      {
        provider: "cline",
        model: "cline-free/newer-avail",
        classification: { state: "available" },
        reason: "replied PONG",
        source: "run"
      },
      now - 10 * 60 * 1000
    )
  );

  const pingedModels: string[] = [];
  const manager = new CliStateManager({
    statePath,
    catalogPath,
    statusPath,
    providerSettingsPath: settingsPath,
    entryPath: install.entryPath,
    wallNow: () => now,
    importModule: async () =>
      makeCatalogModule([
        "reflection/beam-free",
        "cline-free/older-avail",
        "cline-free/unseen-model",
        "cline-free/newer-avail"
      ]),
    checkLatestVersion: async () => "3.0.75",
    installCli: async (v) => {
      await writeFile(install.cliPkg, JSON.stringify({ version: v }));
    },
    pingModel: async (input) => {
      pingedModels.push(input.model!);
      // Fail the first two so we can observe the exact 3-candidate ordering
      const avail = input.model === "reflection/beam-free";
      return {
        state: avail ? "available" : "rate_limited",
        provider: input.provider!,
        model: input.model!,
        checked_at: new Date(now).toISOString(),
        expires_at: new Date(now + 60_000).toISOString(),
        reason: avail ? "replied PONG" : "429",
        source: "ping",
        cached: false
      };
    }
  });

  await manager.onToolCall();
  await manager.waitForBackgroundWork();

  // Expected candidate order:
  // 1. cline-free/newer-avail (available, newest checked_at)
  // 2. cline-free/older-avail (available, older checked_at)
  // 3. reflection/beam-free (first remaining model in catalog order)
  assert.deepEqual(pingedModels, [
    "cline-free/newer-avail",
    "cline-free/older-avail",
    "reflection/beam-free"
  ]);
  const state = await readStateFile(statePath);
  assert.equal(state.cli.update_state, "ok");
  assert.equal(state.cli.version, "3.0.75");
});

test("P2: install and rollback verify on-disk cline/package.json version with cache cleared", async () => {
  // Part A: installCli reports success for 3.0.75, but on-disk package.json stays 3.0.74 -> treated as failure & rolled back
  {
    const { statePath, catalogPath, statusPath, settingsPath } = nextPaths();
    const install = await createFakeCliInstall("3.0.74", "0.2.0");
    const now = Date.parse("2026-11-10T21:00:00.000Z");
    const installCalls: string[] = [];

    const manager = new CliStateManager({
      statePath,
      catalogPath,
      statusPath,
      providerSettingsPath: settingsPath,
      entryPath: install.entryPath,
      wallNow: () => now,
      importModule: async () => makeCatalogModule(["cline-free/m1"]),
      checkLatestVersion: async () => "3.0.75",
      installCli: async (v) => {
        installCalls.push(v);
        // Intentionally do NOT write 3.0.75 to disk; package.json remains 3.0.74
        if (v === "3.0.74") {
          await writeFile(install.cliPkg, JSON.stringify({ version: "3.0.74" }));
        }
      },
      pingModel: async (input) => ({
        state: "available",
        provider: input.provider!,
        model: input.model!,
        checked_at: new Date(now).toISOString(),
        expires_at: new Date(now + 60_000).toISOString(),
        reason: "replied PONG",
        source: "ping",
        cached: false
      })
    });

    await manager.onToolCall();
    await manager.waitForBackgroundWork();

    assert.deepEqual(installCalls, ["3.0.75", "3.0.74"]);
    const state = await readStateFile(statePath);
    assert.equal(state.cli.update_state, "rolled_back");
    assert.equal(state.cli.version, "3.0.74");
    assert.equal(state.cli.failed_versions.length, 1);
    assert.equal(state.cli.failed_versions[0].version, "3.0.75");
    assert.equal(
      state.cli.failed_versions[0].reason,
      "npm reported success but installed version is 3.0.74"
    );
  }

  // Part B: rollback install reports success, but on-disk package.json is NOT oldVersion -> state becomes broken
  {
    const { statePath, catalogPath, statusPath, settingsPath } = nextPaths();
    const install = await createFakeCliInstall("3.0.74", "0.2.0");
    const now = Date.parse("2026-11-10T21:15:00.000Z");
    const installCalls: string[] = [];

    const manager = new CliStateManager({
      statePath,
      catalogPath,
      statusPath,
      providerSettingsPath: settingsPath,
      entryPath: install.entryPath,
      wallNow: () => now,
      importModule: async () => makeCatalogModule(["cline-free/m1"]),
      checkLatestVersion: async () => "3.0.75",
      installCli: async (v) => {
        installCalls.push(v);
        // Write 3.0.75 on upgrade, but fail to restore 3.0.74 on rollback (leave 3.0.75 on disk)
        await writeFile(install.cliPkg, JSON.stringify({ version: "3.0.75" }));
      },
      pingModel: async (input) => ({
        state: "unreachable",
        provider: input.provider!,
        model: input.model!,
        checked_at: new Date(now).toISOString(),
        expires_at: new Date(now + 60_000).toISOString(),
        reason: "broken release",
        source: "ping",
        cached: false
      })
    });

    await manager.onToolCall();
    await manager.waitForBackgroundWork();

    assert.deepEqual(installCalls, ["3.0.75", "3.0.74"]);
    const state = await readStateFile(statePath);
    assert.equal(state.cli.update_state, "broken");
    assert.match(
      state.cli.last_error ?? "",
      /rollback to 3\.0\.74 failed: npm reported success but installed version is 3\.0\.75/
    );
  }
});

test("P3: unreadable CLI versions default to 'unknown' and never start an update or rollback when old version is 'unknown'", async () => {
  const { dir, statePath, catalogPath, statusPath, settingsPath } = nextPaths();
  await mkdir(dir, { recursive: true });
  const missingEntryPath = path.join(dir, "nonexistent", "bin", "cline");
  const now = Date.parse("2026-11-10T22:00:00.000Z");

  // 1. readStateFile defaults to "unknown" when CLI install is not readable
  const initial = await readStateFile(statePath, { entryPath: missingEntryPath, wallNow: () => now });
  assert.equal(initial.cli.version, "unknown");
  assert.equal(initial.cli.catalog_version, "unknown");
  assert.equal(isVersionOfferable("3.0.75", "unknown", []), false);

  // 2. Daily check with version="unknown" records last_error and never transitions to update_available or calls installCli
  const installCalls: string[] = [];
  const manager = new CliStateManager({
    statePath,
    catalogPath,
    statusPath,
    providerSettingsPath: settingsPath,
    entryPath: missingEntryPath,
    wallNow: () => now,
    checkLatestVersion: async () => "3.0.75",
    installCli: async (v) => {
      installCalls.push(v);
    }
  });

  await manager.onToolCall();
  await manager.waitForBackgroundWork();

  const afterCheck = await readStateFile(statePath, { entryPath: missingEntryPath, wallNow: () => now });
  assert.equal(afterCheck.cli.version, "unknown");
  assert.equal(afterCheck.cli.catalog_version, "unknown");
  assert.equal(afterCheck.cli.update_state, "ok");
  assert.match(afterCheck.cli.last_error ?? "", /unknown/i);
  assert.deepEqual(installCalls, [] as string[]);

  // 3. Even if state.json was externally set to update_available with version="unknown", runSafeUpdate refuses and records last_error
  await mutateStateFile(
    statePath,
    (curr) => {
      curr.cli.version = "unknown";
      curr.cli.update_state = "update_available";
      curr.cli.latest_known_version = "3.0.75";
      curr.cli.last_error = null;
      return curr;
    },
    { entryPath: missingEntryPath, wallNow: () => now }
  );

  const afterForcedSafeUpdate = await manager.runSafeUpdate();
  assert.equal(afterForcedSafeUpdate.cli.version, "unknown");
  assert.equal(afterForcedSafeUpdate.cli.update_state, "ok");
  assert.match(afterForcedSafeUpdate.cli.last_error ?? "", /unknown/i);
  assert.deepEqual(installCalls, [] as string[]);
});

test("guard: representative default paths with HOME/USERPROFILE pointed at a temp dir never touch the real home directory", async () => {
  const realHome = os.homedir();
  const realClineMcpDir = path.join(realHome, ".cline-mcp");

  // Snapshot the real ~/.cline-mcp directory before running representative paths
  const snapshotRealDir = async () => {
    try {
      const entries = (await readdir(realClineMcpDir)).sort();
      const files: Record<string, { mtimeMs: number; content: string }> = {};
      for (const name of entries) {
        const full = path.join(realClineMcpDir, name);
        const st = await stat(full);
        if (st.isFile()) {
          files[name] = { mtimeMs: st.mtimeMs, content: await readFile(full, "utf8") };
        }
      }
      return { exists: true, entries, files };
    } catch (err: any) {
      if (err?.code === "ENOENT") return { exists: false, entries: [] as string[], files: {} };
      throw err;
    }
  };

  const beforeReal = await snapshotRealDir();

  const fakeHome = path.join(root, `guard-home-${++counter}`);
  await mkdir(fakeHome, { recursive: true });
  const install = await createFakeCliInstall("3.0.74", "0.2.0");

  const savedEnv = {
    HOME: process.env.HOME,
    USERPROFILE: process.env.USERPROFILE,
    HOMEDRIVE: process.env.HOMEDRIVE,
    HOMEPATH: process.env.HOMEPATH,
    CLINE_MCP_STATE_PATH: process.env.CLINE_MCP_STATE_PATH,
    CLINE_MCP_CATALOG_PATH: process.env.CLINE_MCP_CATALOG_PATH,
    CLINE_MCP_STATUS_PATH: process.env.CLINE_MCP_STATUS_PATH,
    CLINE_PROVIDER_SETTINGS_PATH: process.env.CLINE_PROVIDER_SETTINGS_PATH,
    CLINE_MCP_TRACE_DIR: process.env.CLINE_MCP_TRACE_DIR
  };

  try {
    process.env.HOME = fakeHome;
    process.env.USERPROFILE = fakeHome;
    if (process.platform === "win32") {
      const parsed = path.parse(fakeHome);
      process.env.HOMEDRIVE = parsed.root.replace(/[\\/]+$/, "");
      process.env.HOMEPATH = fakeHome.slice(process.env.HOMEDRIVE.length) || "\\";
    }
    delete process.env.CLINE_MCP_STATE_PATH;
    delete process.env.CLINE_MCP_CATALOG_PATH;
    delete process.env.CLINE_MCP_STATUS_PATH;
    process.env.CLINE_PROVIDER_SETTINGS_PATH = path.join(fakeHome, "providers.json");
    process.env.CLINE_MCP_TRACE_DIR = path.join(fakeHome, "traces");

    assert.equal(os.homedir(), fakeHome);
    assert.equal(resolveStatePath(), path.join(fakeHome, ".cline-mcp", "state.json"));
    assert.equal(resolveCatalogPath(), path.join(fakeHome, ".cline-mcp", "catalog.json"));
    assert.equal(resolveStatusPath(), path.join(fakeHome, ".cline-mcp", "status.json"));

    const now = Date.parse("2026-11-10T23:00:00.000Z");

    // 1. Default state read/mutate (no explicit path)
    await mutateStateFile(
      undefined,
      (curr) => {
        curr.cli.last_check_at = new Date(now).toISOString();
        return curr;
      },
      { entryPath: install.entryPath, wallNow: () => now }
    );

    // 2. Default status write (via default resolveStatusPath())
    await writeStatusEntry(
      resolveStatusPath()!,
      buildEntry(
        {
          provider: "cline",
          model: "cline-free/guard-model",
          classification: { state: "available" },
          reason: "replied PONG",
          source: "ping"
        },
        now
      )
    );

    // 3. Default listFreeModels + writeCatalogSnapshot (no explicit statePath/statusPath/catalogPath)
    const list = await listFreeModels({
      entryPath: install.entryPath,
      importModule: async () => makeCatalogModule(["cline-free/guard-model"])
    });
    await writeCatalogSnapshot(list);

    // 4. Default CliStateManager.onToolCall (no explicit statePath/catalogPath/statusPath)
    const manager = new CliStateManager({
      entryPath: install.entryPath,
      importModule: async () => makeCatalogModule(["cline-free/guard-model"]),
      wallNow: () => now,
      checkLatestVersion: async () => "3.0.74"
    });
    await manager.onToolCall();
    await manager.waitForBackgroundWork();

    // 5. Spawned dist/index.js bridge with HOME/USERPROFILE pointed at fakeHome
    const spawnResult = await new Promise<{ code: number | null; stderr: string }>((resolve, reject) => {
      const child = spawn(process.execPath, [path.resolve("dist/index.js")], {
        env: { ...process.env },
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true
      });
      let stderr = "";
      const timer = setTimeout(() => {
        child.kill();
        reject(new Error("spawned bridge in guard test did not settle"));
      }, 15_000);
      child.stderr.on("data", (chunk) => {
        stderr += chunk.toString();
      });
      child.once("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
      child.once("close", (code) => {
        clearTimeout(timer);
        resolve({ code, stderr });
      });
      child.stdin.end();
    });
    assert.equal(spawnResult.code, 0);

    // Verify files were created inside fakeHome/.cline-mcp
    const fakeClineMcpEntries = (await readdir(path.join(fakeHome, ".cline-mcp"))).sort();
    assert.deepEqual(fakeClineMcpEntries, ["catalog.json", "state.json", "status.json"]);
  } finally {
    for (const [key, val] of Object.entries(savedEnv)) {
      if (val === undefined) delete process.env[key];
      else process.env[key] = val;
    }
  }

  // Assert nothing was created or modified under the real ~/.cline-mcp
  const afterReal = await snapshotRealDir();
  assert.deepEqual(afterReal, beforeReal, "real ~/.cline-mcp directory must not be created or modified by tests");
});


