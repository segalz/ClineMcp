import assert from "node:assert/strict";
import test, { after } from "node:test";
import { access, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import os from "node:os";
import path from "node:path";
import { listFreeModels, CLINE_PROVIDER } from "../models.js";
import { ClineRunError, resolveClineEntry } from "../runner.js";
import { buildEntry, writeStatusEntry } from "../status.js";

const root = await mkdtemp(path.join(os.tmpdir(), "cline-models-"));
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
  return { cli, entryPath: path.join(cli, "bin", "cline"), llms, statusPath: path.join(cli, "status.json") };
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
  const result = await listFreeModels({ entryPath: install.entryPath, statusPath: install.statusPath,
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
  const result = await listFreeModels({ entryPath: install.entryPath, statusPath: install.statusPath, importModule: async () => catalogModule });
  const beam = result.models.find(m => m.id === "reflection/beam-free");
  assert.equal(beam?.last_status?.state, "available");
  assert.equal(beam?.last_status?.source, "ping");
  assert.equal(result.models[0].last_status, undefined);
});

test("catalog enrichment failure still lists the free ids", async () => {
  const install = await fakeInstall();
  const result = await listFreeModels({ entryPath: install.entryPath, statusPath: install.statusPath, importModule: async () => ({
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
    await assert.rejects(listFreeModels({ entryPath: install.entryPath, statusPath: install.statusPath, importModule }),
      (err: unknown) => err instanceof ClineRunError && err.kind === "catalog_unavailable" && /does not guess/.test(err.message));
  }
});

test("a missing CLI entry fails with catalog_unavailable before importing anything", async () => {
  await assert.rejects(listFreeModels({ entryPath: path.join(root, "nowhere", "bin", "cline"),
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
  await listFreeModels({ entryPath: link, statusPath: real.statusPath, importModule: async url => { importedUrl = url; return catalogModule; } });
  assert.equal(importedUrl, pathToFileURL(path.join(await realpath(real.cli), "node_modules", "@cline", "llms", "dist", "index.js")).href);
});

test("installed Cline CLI exposes a non-empty free list (skipped when Cline is not installed)", async t => {
  const entry = resolveClineEntry();
  if (!entry) return t.skip("no Cline install path on this platform");
  try { await access(path.join(path.dirname(path.dirname(entry)), "node_modules", "@cline", "llms", "dist", "index.js")); }
  catch { return t.skip("Cline CLI not installed"); }
  const result = await listFreeModels({ statusPath: path.join(root, "real-status.json") });
  assert.ok(result.models.length > 0);
  assert.ok(result.models.every(m => m.provider === "cline" && /^[A-Za-z0-9._:/@-]+$/.test(m.id)));
});
