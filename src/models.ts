import path from "node:path";
import { readFile, realpath } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { ClineRunError, resolveClineEntry } from "./runner.js";
import { PROHIBITED_NAMES } from "./settings.js";
import { atomicWriteJson, readStatusEntry, resolveCatalogPath, resolveStatusPath, type StatusEntry } from "./status.js";

export { resolveCatalogPath };

/** Provider id the CLI uses for Cline's own models, free ones included (`cline -P cline -m <id>`). */
export const CLINE_PROVIDER = "cline";

export interface FreeModel {
  provider: string;
  id: string;
  name: string;
  description?: string;
  contextWindow?: number;
  capabilities?: string[];
  /** Last result the bridge recorded for this provider+model (cline_ping or a real run), if any. */
  last_status?: Pick<StatusEntry, "state" | "reason" | "checked_at" | "expires_at" | "source">;
}

export interface FreeModelList {
  provider: string;
  models: FreeModel[];
  source: { package: string; version?: string; cliVersion?: string };
  note: string;
}

export interface ModelCatalogDeps {
  /** Cline CLI entry script (`<install>/bin/cline`); defaults to the npm global install on Windows. */
  entryPath?: string;
  /** Test seam: replaces the dynamic import of the catalog module. */
  importModule?: (url: string) => Promise<unknown>;
  statusPath?: string;
}

function unavailable(message: string): ClineRunError {
  return new ClineRunError("catalog_unavailable",
    `Cline's model catalog could not be read: ${message} The bridge does not guess model ids.`, { attempts: 0 });
}

const isObject = (v: unknown): v is Record<string, any> => typeof v === "object" && v !== null && !Array.isArray(v);

async function readVersion(packageJson: string): Promise<string | undefined> {
  try { const v = JSON.parse(await readFile(packageJson, "utf8")).version; return typeof v === "string" ? v : undefined; }
  catch { return undefined; }
}

/**
 * Lists the models Cline itself advertises as free, read from the installed CLI's catalog package
 * (`@cline/llms`: `GENERATED_CLINE_RECOMMENDED_MODELS.free`, enriched from `getGeneratedModelsForProvider("cline")`).
 * Zero pricing alone is not treated as "free" (it includes routers such as openrouter/auto).
 */
export async function listFreeModels(deps: ModelCatalogDeps = {}): Promise<FreeModelList> {
  const configured = resolveClineEntry(deps.entryPath);
  if (!configured) throw unavailable("the Cline CLI install was not found.");
  // Node runs the entry script from its real path, so the catalog must come from that same install,
  // not from a directory next to a symlink.
  let entry: string;
  try { entry = await realpath(configured); }
  catch (err: any) { throw unavailable(`the Cline CLI entry ${configured} is not readable (${err?.code ?? err?.message ?? String(err)}).`); }
  const cliRoot = path.dirname(path.dirname(entry));
  const packageRoot = path.join(cliRoot, "node_modules", "@cline", "llms");
  const moduleUrl = pathToFileURL(path.join(packageRoot, "dist", "index.js")).href;

  let mod: unknown;
  try { mod = await (deps.importModule ?? (url => import(url)))(moduleUrl); }
  catch (err: any) { throw unavailable(`importing ${packageRoot} failed (${err?.message ?? String(err)}).`); }
  if (!isObject(mod)) throw unavailable("the catalog module has no exports.");

  const recommended = mod.GENERATED_CLINE_RECOMMENDED_MODELS;
  const free = isObject(recommended) ? recommended.free : undefined;
  if (!Array.isArray(free)) throw unavailable("GENERATED_CLINE_RECOMMENDED_MODELS.free is missing or not a list.");
  let catalog: Record<string, any> = {};
  if (typeof mod.getGeneratedModelsForProvider === "function") {
    try { const c = mod.getGeneratedModelsForProvider(CLINE_PROVIDER); if (isObject(c)) catalog = c; } catch { /* enrichment only */ }
  }

  const models: FreeModel[] = [];
  for (const item of free) {
    const id = isObject(item) ? item.id : item;
    // Same rules the tools apply to `model`, so every listed id is one the bridge accepts.
    if (typeof id !== "string" || !/^[A-Za-z0-9._:/@-]{1,120}$/.test(id) || PROHIBITED_NAMES.has(id.toLowerCase())) {
      throw unavailable("a free model entry has no valid id.");
    }
    const info = isObject(catalog[id]) ? catalog[id] : {};
    const name = typeof info.name === "string" ? info.name : isObject(item) && typeof item.name === "string" ? item.name : id;
    const description = isObject(item) && typeof item.description === "string" && item.description ? item.description : undefined;
    models.push({
      provider: CLINE_PROVIDER, id, name,
      ...(description ? { description } : {}),
      ...(typeof info.contextWindow === "number" ? { contextWindow: info.contextWindow } : {}),
      ...(Array.isArray(info.capabilities) ? { capabilities: info.capabilities.filter((c: unknown) => typeof c === "string") } : {})
    });
  }

  const statusPath = resolveStatusPath(deps.statusPath);
  if (statusPath) {
    for (const model of models) {
      const s = await readStatusEntry(statusPath, model.provider, model.id).catch(() => undefined);
      if (s) model.last_status = { state: s.state, reason: s.reason, checked_at: s.checked_at, expires_at: s.expires_at, source: s.source };
    }
  }

  return {
    provider: CLINE_PROVIDER,
    models,
    source: {
      package: packageRoot,
      version: await readVersion(path.join(packageRoot, "package.json")),
      cliVersion: await readVersion(path.join(cliRoot, "package.json"))
    },
    note: "Free models as advertised by the installed Cline CLI. The list rotates; being listed does not prove the " +
      "model answers right now - check with cline_ping."
  };
}

export interface CatalogSnapshotModel {
  id: string;
  name: string;
  contextWindow?: number;
  capabilities?: string[];
}

export interface CatalogSnapshot {
  version: 1;
  generated_at: string;
  provider: string;
  models: CatalogSnapshotModel[];
  source: {
    package: string;
    version?: string;
    cliVersion?: string;
  };
}

/**
 * Writes an atomic JSON snapshot of the free-model catalog to disk.
 * Omits last_status and descriptions; directory is created if missing, and
 * any temporary file is cleaned up on failure.
 */
export async function writeCatalogSnapshot(
  list: FreeModelList,
  catalogPath?: string,
  now?: number | Date | string
): Promise<void> {
  const dest = catalogPath ? path.resolve(catalogPath) : resolveCatalogPath();
  if (!dest) {
    throw new Error("Catalog path could not be resolved.");
  }
  const iso = now instanceof Date
    ? now.toISOString()
    : (typeof now === "number" || typeof now === "string")
      ? new Date(now).toISOString()
      : new Date().toISOString();

  const snapshot: CatalogSnapshot = {
    version: 1,
    generated_at: iso,
    provider: list.provider || CLINE_PROVIDER,
    models: list.models.map((m) => {
      const model: CatalogSnapshotModel = {
        id: m.id,
        name: m.name
      };
      if (typeof m.contextWindow === "number") {
        model.contextWindow = m.contextWindow;
      }
      if (Array.isArray(m.capabilities)) {
        model.capabilities = m.capabilities;
      }
      return model;
    }),
    source: {
      package: list.source.package,
      ...(list.source.version !== undefined ? { version: list.source.version } : {}),
      ...(list.source.cliVersion !== undefined ? { cliVersion: list.source.cliVersion } : {})
    }
  };

  await atomicWriteJson(dest, snapshot);
}
