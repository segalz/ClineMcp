import assert from "node:assert/strict";
import test, { after } from "node:test";
import { access, mkdir, mkdtemp, readdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import os from "node:os";
import path from "node:path";
import { listFreeModels, writeCatalogSnapshot, CLINE_PROVIDER, type FreeModelList } from "../models.js";
import { ClineRunError, resolveClineEntry } from "../runner.js";
import { buildEntry, writeStatusEntry, resolveCatalogPath } from "../status.js";

const root = await mkdtemp(path.join(os.tmpdir(), "cline-models-"));
process.env.CLINE_MCP_STATUS_PATH = path.join(root, "default-status.json");
process.env.CLINE_MCP_CATALOG_PATH = path.join(root, "default-catalog.json");
process.env.CLINE_MCP_STATE_PATH = path.join(root, "default-state.json");
process.env.CLINE_PROVIDER_SETTINGS_PATH = path.join(root, "default-providers.json");
process.env.CLINE_MCP_TRACE_DIR = path.join(root, "traces");
after(() => rm(root, { recursive: true, force: true }));
let counter = 0;

/** A fake Cline install: <cli>/bin/cline, <cli>/package.json, <cli>/node_modules/@cline/llms/package.json. */
async function fakeInstall(cliVersion = "3.0.74", llmsVersion = "0.2.0") {
  const cli = path.join(root, `cli-${++counter}`);
  const llms = path.join(cli, "node_modules", "@cline", "llms");
  await mkdir(path.join(cli, "bin"), { recursive: true });
  await mkdir(llms, { recursive: true });
  await writeFile(path.join(cli, "package.json"), JSON.stringify({ version: cliVersion }));
  await writeFile(path.join(llms, "package.json"), JSON.stringify({ version: llmsVersion }));
  await writeFile(path.join(cli, "bin", "cline"), "// fake entry");
  return {
    cli,
    entryPath: path.join(cli, "bin", "cline"),
    llms,
    statusPath: path.join(cli, "status.json"),
    statePath: path.join(cli, "state.json")
  };
}

const catalogModule = {
  GENERATED_CLINE_RECOMMENDED_MODELS: {
    recommended: [{ id: "paid/model" }],
    free: [
      { id: "cline-free/nemotron-3.5-super-vl", name: "short", description: "NVIDIA model", tags: [] },
      { id: "reflection/beam-free", name: "Beam", description: "", tags: [] },
      "plain/string-id"
    ]
  },
  getGeneratedModelsForProvider: (provider: string) => provider === "cline" ? {
    "cline-free/nemotron-3.5-super-vl": { name: "Nemotron 3.5 Super VL (free)", contextWindow: 1048576, capabilities: ["tools", "reasoning", 7] },
    "reflection/beam-free": { name: "Beam 1.0 (Free)", contextWindow: 1048576 }
  } : {}
};

test("lists Cline's advertised free models, enriched from the provider catalog", async () => {
  const install = await fakeInstall();
  let importedUrl = "";
  const result = await listFreeModels({ entryPath: install.entryPath, statusPath: install.statusPath, statePath: install.statePath,
    importModule: async url => { importedUrl = url; return catalogModule; } });
  assert.equal(importedUrl, pathToFileURL(path.join(await realpath(install.cli), "node_modules", "@cline", "llms", "dist", "index.js")).href);
  assert.equal(result.provider, CLINE_PROVIDER);
  assert.deepEqual(result.models.map(m => m.id), ["cline-free/nemotron-3.5-super-vl", "reflection/beam-free", "plain/string-id"]);
  assert.ok(result.models.every(m => m.provider === "cline"));
  assert.deepEqual(result.models[0], {
    provider: "cline", id: "cline-free/nemotron-3.5-super-vl", name: "Nemotron 3.5 Super VL (free)",
    description: "NVIDIA model", contextWindow: 1048576, capabilities: ["tools", "reasoning"]
  });
  assert.equal(result.models[2].name, "plain/string-id");
  assert.equal(result.source.version, "0.2.0");
  assert.equal(result.source.cliVersion, "3.0.74");
  assert.ok(!result.models.some(m => m.id === "paid/model"), "only the free list is returned");
});

test("joins the bridge's last recorded status per model", async () => {
  const install = await fakeInstall();
  const now = Date.now();
  await writeStatusEntry(install.statusPath, buildEntry({ provider: "cline", model: "reflection/beam-free",
    classification: { state: "available" }, reason: "replied PONG", source: "ping" }, now));
  const result = await listFreeModels({ entryPath: install.entryPath, statusPath: install.statusPath, statePath: install.statePath, importModule: async () => catalogModule });
  const beam = result.models.find(m => m.id === "reflection/beam-free");
  assert.equal(beam?.last_status?.state, "available");
  assert.equal(beam?.last_status?.source, "ping");
  assert.equal(result.models[0].last_status, undefined);
});

test("catalog enrichment failure still lists the free ids", async () => {
  const install = await fakeInstall();
  const result = await listFreeModels({ entryPath: install.entryPath, statusPath: install.statusPath, statePath: install.statePath, importModule: async () => ({
    ...catalogModule, getGeneratedModelsForProvider: () => { throw new Error("registry not ready"); }
  }) });
  assert.equal(result.models.length, 3);
  assert.equal(result.models[1].name, "Beam");
});

test("an unreadable or changed catalog fails with catalog_unavailable and never guesses ids", async () => {
  const install = await fakeInstall();
  const cases: Array<() => Promise<unknown>> = [
    async () => { throw new Error("Cannot find module"); },
    async () => ({}),
    async () => ({ GENERATED_CLINE_RECOMMENDED_MODELS: { free: "not-a-list" } }),
    async () => ({ GENERATED_CLINE_RECOMMENDED_MODELS: { free: [{ name: "no id" }] } }),
    async () => ({ GENERATED_CLINE_RECOMMENDED_MODELS: { free: [{ id: "bad id with spaces" }] } }),
    ...["__proto__", "constructor", "PROTOTYPE"].map(id => async () => ({ GENERATED_CLINE_RECOMMENDED_MODELS: { free: [{ id }] } }))
  ];
  for (const importModule of cases) {
    await assert.rejects(listFreeModels({ entryPath: install.entryPath, statusPath: install.statusPath, statePath: install.statePath, importModule }),
      (err: unknown) => err instanceof ClineRunError && err.kind === "catalog_unavailable" && /does not guess/.test(err.message));
  }
});

test("a missing CLI entry fails with catalog_unavailable before importing anything", async () => {
  await assert.rejects(listFreeModels({ entryPath: path.join(root, "nowhere", "bin", "cline"),
    statusPath: path.join(root, "nowhere-status.json"), statePath: path.join(root, "nowhere-state.json"),
    importModule: async () => assert.fail("must not import") }),
    (err: unknown) => err instanceof ClineRunError && err.kind === "catalog_unavailable");
});

test("a symlinked CLI entry loads the catalog from the real install, not the link's directory", async t => {
  const real = await fakeInstall();
  const linkDir = path.join(root, `link-${++counter}`, "bin");
  await mkdir(linkDir, { recursive: true });
  const link = path.join(linkDir, "cline");
  try { await symlink(real.entryPath, link, "file"); }
  catch (err: any) { return t.skip(`symlinks not permitted here (${err.code})`); }
  let importedUrl = "";
  await listFreeModels({ entryPath: link, statusPath: real.statusPath, statePath: real.statePath, importModule: async url => { importedUrl = url; return catalogModule; } });
  assert.equal(importedUrl, pathToFileURL(path.join(await realpath(real.cli), "node_modules", "@cline", "llms", "dist", "index.js")).href);
});

test("installed Cline CLI exposes a non-empty free list (skipped when Cline is not installed)", async t => {
  const entry = resolveClineEntry();
  if (!entry) return t.skip("no Cline install path on this platform");
  try { await access(path.join(path.dirname(path.dirname(entry)), "node_modules", "@cline", "llms", "dist", "index.js")); }
  catch { return t.skip("Cline CLI not installed"); }
  const result = await listFreeModels({ statusPath: path.join(root, "real-status.json"), statePath: path.join(root, "real-state.json") });
  assert.ok(result.models.length > 0);
  assert.ok(result.models.every(m => m.provider === "cline" && /^[A-Za-z0-9._:/@-]+$/.test(m.id)));
});

test("snapshot content: writes catalog snapshot without last_status or descriptions", async () => {
  const targetPath = path.join(root, `catalog-content-${++counter}.json`);
  const now = "2026-11-10T07:00:00.000Z";
  const list: FreeModelList = {
    provider: CLINE_PROVIDER,
    models: [
      {
        provider: "cline",
        id: "cline-free/test-model-1",
        name: "Test Model 1",
        description: "A description that must not appear in snapshot",
        contextWindow: 1048576,
        capabilities: ["tools", "reasoning"],
        last_status: {
          state: "available",
          reason: "replied PONG",
          checked_at: "2026-11-10T06:55:00.000Z",
          expires_at: "2026-11-10T06:56:00.000Z",
          source: "ping"
        }
      },
      {
        provider: "cline",
        id: "cline-free/test-model-2",
        name: "Test Model 2",
        description: "Another description that must not appear in snapshot",
        last_status: {
          state: "rate_limited",
          reason: "429 Too many requests",
          checked_at: "2026-11-10T06:55:00.000Z",
          expires_at: "2026-11-10T06:58:00.000Z",
          source: "run"
        }
      }
    ],
    source: {
      package: path.join(root, "node_modules", "@cline", "llms"),
      version: "0.2.0",
      cliVersion: "3.0.74"
    },
    note: "Free models as advertised by the installed Cline CLI"
  };

  await writeCatalogSnapshot(list, targetPath, now);

  const raw = await readFile(targetPath, "utf8");
  const data = JSON.parse(raw);

  assert.equal(data.version, 1);
  assert.equal(data.generated_at, now);
  assert.equal(data.provider, "cline");
  assert.deepEqual(data.source, {
    package: path.join(root, "node_modules", "@cline", "llms"),
    version: "0.2.0",
    cliVersion: "3.0.74"
  });
  assert.equal("note" in data, false, "note must not be included");
  assert.equal("last_status" in data, false, "last_status must not be included at top level");

  assert.equal(data.models.length, 2);

  // Model 1: preserves contextWindow and capabilities, omits description and last_status
  assert.deepEqual(data.models[0], {
    id: "cline-free/test-model-1",
    name: "Test Model 1",
    contextWindow: 1048576,
    capabilities: ["tools", "reasoning"]
  });
  assert.equal("last_status" in data.models[0], false);
  assert.equal("description" in data.models[0], false);
  assert.equal("provider" in data.models[0], false);

  // Model 2: omits optional fields, omits description and last_status
  assert.deepEqual(data.models[1], {
    id: "cline-free/test-model-2",
    name: "Test Model 2"
  });
  assert.equal("last_status" in data.models[1], false);
  assert.equal("description" in data.models[1], false);
  assert.equal("contextWindow" in data.models[1], false);
  assert.equal("capabilities" in data.models[1], false);
  assert.equal("provider" in data.models[1], false);
});

test("atomic write into a temp dir: creates missing directory and cleans temp on failure", async () => {
  const targetDir = path.join(root, `atomic-test-${++counter}`, "sub");
  const targetPath = path.join(targetDir, "catalog.json");
  const list: FreeModelList = {
    provider: "cline",
    models: [{ provider: "cline", id: "atomic-model", name: "Atomic Model" }],
    source: { package: "/pkg" },
    note: "note"
  };

  // 1. Target directory does not exist initially; write creates directory and writes file atomically
  await writeCatalogSnapshot(list, targetPath);
  const data = JSON.parse(await readFile(targetPath, "utf8"));
  assert.equal(data.version, 1);
  assert.equal(data.models[0].id, "atomic-model");

  // Verify only catalog.json exists and no leftover .tmp files
  const files = await readdir(targetDir);
  assert.deepEqual(files, ["catalog.json"]);

  // 2. Failure case: rename over a directory fails, and temporary file is unlinked in finally
  const conflictDir = path.join(root, `conflict-${++counter}`);
  await mkdir(conflictDir, { recursive: true });
  await assert.rejects(writeCatalogSnapshot(list, conflictDir));

  const parentEntries = await readdir(root);
  const strayTemps = parentEntries.filter(f => f.startsWith(`conflict-${counter}`) && f.endsWith(".tmp"));
  assert.equal(strayTemps.length, 0, "temporary file must be removed on failure");
});

test("resolveCatalogPath respects CLINE_MCP_CATALOG_PATH override and defaults to ~/.cline-mcp/catalog.json", async () => {
  const originalEnv = process.env.CLINE_MCP_CATALOG_PATH;
  try {
    delete process.env.CLINE_MCP_CATALOG_PATH;
    assert.equal(resolveCatalogPath(), path.join(os.homedir(), ".cline-mcp", "catalog.json"));
    assert.equal(resolveCatalogPath(null), undefined);
    assert.equal(resolveCatalogPath("custom/sub/catalog.json"), path.resolve("custom/sub/catalog.json"));

    const overridePath = path.join(root, `env-catalog-${++counter}.json`);
    process.env.CLINE_MCP_CATALOG_PATH = overridePath;
    assert.equal(resolveCatalogPath(), path.resolve(overridePath));

    // writeCatalogSnapshot writes to CLINE_MCP_CATALOG_PATH when path argument is omitted
    const list: FreeModelList = {
      provider: "cline",
      models: [{ provider: "cline", id: "env-model", name: "Env Model" }],
      source: { package: "/pkg" },
      note: "note"
    };
    await writeCatalogSnapshot(list);
    const data = JSON.parse(await readFile(overridePath, "utf8"));
    assert.equal(data.models[0].id, "env-model");
  } finally {
    if (originalEnv !== undefined) {
      process.env.CLINE_MCP_CATALOG_PATH = originalEnv;
    } else {
      delete process.env.CLINE_MCP_CATALOG_PATH;
    }
  }
});
