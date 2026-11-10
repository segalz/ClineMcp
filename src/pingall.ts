import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  CLINE_PROVIDER,
  listFreeModels,
  writeCatalogSnapshot,
  type FreeModelList,
  type ModelCatalogDeps
} from "./models.js";
import {
  clinePing,
  DEFAULT_PING_TIMEOUT_SECONDS,
  type ClinePingInput,
  type ClinePingResult
} from "./ping.js";
import type { ClineDependencies } from "./runner.js";
import type { ProviderState } from "./status.js";

export const TOTAL_PING_ALL_CAP_MS = 120_000;

export interface PingAllModelSummary {
  provider: string;
  model: string;
  state: ProviderState | "skipped";
  reason: string;
  latency_ms?: number;
  checked_at?: string;
  reset_at?: string;
  retry_after_s?: number;
}

export interface PingAllSummary {
  ok: boolean;
  provider: string;
  total: number;
  checked: number;
  available: number;
  rate_limited: number;
  quota_exhausted: number;
  unreachable: number;
  skipped: number;
  duration_ms: number;
  timed_out: boolean;
  error?: string;
  results: PingAllModelSummary[];
}

export interface PingAllDeps {
  catalogDeps?: ModelCatalogDeps;
  catalogPath?: string;
  pingDeps?: ClineDependencies;
  listModels?: (deps?: ModelCatalogDeps) => Promise<FreeModelList>;
  pingModel?: (input: ClinePingInput, signal?: AbortSignal, deps?: ClineDependencies) => Promise<ClinePingResult>;
  totalCapMs?: number;
  perModelTimeoutSeconds?: number;
  force?: boolean;
  now?: () => number;
  signal?: AbortSignal;
  writeLine?: (line: string) => void;
}

/**
 * Lists the free-model catalog and runs `clinePing` sequentially once per catalog model
 * (provider "cline"), recording each result in `status.json` within a 120 s total cap.
 * Never throws; returns a one-line-serializable summary.
 */
export async function pingAllModels(deps: PingAllDeps = {}): Promise<PingAllSummary> {
  const now = deps.now ?? (() => performance.now());
  const started = now();
  const totalCapMs = deps.totalCapMs ?? TOTAL_PING_ALL_CAP_MS;
  const deadline = started + totalCapMs;
  const listFn = deps.listModels ?? listFreeModels;
  const pingFn = deps.pingModel ?? clinePing;

  let list: FreeModelList;
  try {
    list = await listFn(deps.catalogDeps);
    await writeCatalogSnapshot(list, deps.catalogPath).catch(() => {});
  } catch (err: any) {
    return {
      ok: false,
      provider: CLINE_PROVIDER,
      total: 0,
      checked: 0,
      available: 0,
      rate_limited: 0,
      quota_exhausted: 0,
      unreachable: 0,
      skipped: 0,
      duration_ms: Math.max(0, Math.round(now() - started)),
      timed_out: false,
      error: (err?.message ?? String(err)).split(/\r?\n/)[0],
      results: []
    };
  }

  const results: PingAllModelSummary[] = [];
  let checked = 0;
  let available = 0;
  let rate_limited = 0;
  let quota_exhausted = 0;
  let unreachable = 0;
  let skipped = 0;
  let timedOut = false;

  for (const model of list.models) {
    const remainingMs = deadline - now();
    if (remainingMs <= 0 || deps.signal?.aborted) {
      if (remainingMs <= 0) timedOut = true;
      skipped++;
      results.push({
        provider: CLINE_PROVIDER,
        model: model.id,
        state: "skipped",
        reason: remainingMs <= 0 ? "total 120s cap reached" : "cancelled"
      });
      continue;
    }

    const controller = new AbortController();
    const onParentAbort = () => controller.abort();
    if (deps.signal?.aborted) controller.abort();
    else deps.signal?.addEventListener("abort", onParentAbort, { once: true });

    let capTimer: NodeJS.Timeout | undefined;
    const capPromise = new Promise<"cap_reached">((resolve) => {
      capTimer = setTimeout(() => {
        timedOut = true;
        controller.abort();
        resolve("cap_reached");
      }, Math.max(1, remainingMs));
      capTimer.unref?.();
    });

    const timeoutSeconds = Math.max(
      1,
      Math.min(
        deps.perModelTimeoutSeconds ?? DEFAULT_PING_TIMEOUT_SECONDS,
        Math.ceil(remainingMs / 1000)
      )
    );

    try {
      const outcome = await Promise.race([
        pingFn(
          {
            provider: CLINE_PROVIDER,
            model: model.id,
            force: deps.force ?? true,
            timeoutSeconds
          },
          controller.signal,
          deps.pingDeps
        ),
        capPromise
      ]);

      if (outcome === "cap_reached") {
        timedOut = true;
        skipped++;
        results.push({
          provider: CLINE_PROVIDER,
          model: model.id,
          state: "skipped",
          reason: "total 120s cap reached"
        });
        continue;
      }

      checked++;
      if (outcome.state === "available") available++;
      else if (outcome.state === "rate_limited") rate_limited++;
      else if (outcome.state === "quota_exhausted") quota_exhausted++;
      else unreachable++;

      results.push({
        provider: CLINE_PROVIDER,
        model: model.id,
        state: outcome.state,
        reason: outcome.reason,
        ...(outcome.latency_ms !== undefined ? { latency_ms: outcome.latency_ms } : {}),
        ...(outcome.checked_at ? { checked_at: outcome.checked_at } : {}),
        ...(outcome.reset_at ? { reset_at: outcome.reset_at } : {}),
        ...(outcome.retry_after_s !== undefined ? { retry_after_s: outcome.retry_after_s } : {})
      });
    } catch (err: any) {
      if (now() >= deadline || timedOut) {
        timedOut = true;
        skipped++;
        results.push({
          provider: CLINE_PROVIDER,
          model: model.id,
          state: "skipped",
          reason: "total 120s cap reached"
        });
      } else {
        checked++;
        unreachable++;
        results.push({
          provider: CLINE_PROVIDER,
          model: model.id,
          state: "unreachable",
          reason: (err?.message ?? String(err)).split(/\r?\n/)[0]
        });
      }
    } finally {
      if (capTimer) clearTimeout(capTimer);
      deps.signal?.removeEventListener("abort", onParentAbort);
    }
  }

  return {
    ok: true,
    provider: CLINE_PROVIDER,
    total: list.models.length,
    checked,
    available,
    rate_limited,
    quota_exhausted,
    unreachable,
    skipped,
    duration_ms: Math.max(0, Math.round(now() - started)),
    timed_out: timedOut,
    results
  };
}

export async function runPingAllCli(deps: PingAllDeps = {}): Promise<PingAllSummary> {
  const summary = await pingAllModels(deps);
  const write = deps.writeLine ?? ((line: string) => process.stdout.write(line + "\n"));
  write(JSON.stringify(summary));
  process.exitCode = 0;
  return summary;
}

const isMain = (() => {
  if (!process.argv[1]) return false;
  try {
    return path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();

if (isMain) {
  void runPingAllCli();
}
