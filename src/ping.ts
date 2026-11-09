import { ClineRunError, runCline, redactSecrets, type ClineDependencies } from "./runner.js";
import { readProviderSettingsSnapshot, resolveProviderSettingsPath, resolveSavedSelection } from "./settings.js";
import {
  buildEntry,
  classifyRunError,
  isFresh,
  readStatusEntry,
  recordStatusSafely,
  resolveStatusPath,
  type ProviderState,
  type StatusEntry
} from "./status.js";

export const PING_PROMPT = "Reply with exactly the word PONG.";
export const DEFAULT_PING_TIMEOUT_SECONDS = 25;

export interface ClinePingInput {
  provider?: string;
  model?: string;
  force?: boolean;
  timeoutSeconds?: number;
}

export interface ClinePingResult {
  state: ProviderState;
  provider: string;
  model: string;
  latency_ms?: number;
  checked_at: string;
  expires_at: string;
  reason: string;
  retry_after_s?: number;
  reset_at?: string;
  source: StatusEntry["source"];
  cached: boolean;
}

/** The provider/model a run would use, resolved read-only so the cache can be consulted first. */
export async function resolvePingSelection(
  input: { provider?: string; model?: string },
  settingsPath: string
): Promise<{ provider?: string; model?: string }> {
  if (input.provider && input.model) return { provider: input.provider, model: input.model };
  const saved = await resolveSavedSelection(settingsPath).catch(() => ({} as { provider?: string; model?: string }));
  if (!input.provider && !input.model) return saved;
  if (input.model) return { provider: saved.provider ?? "cline", model: input.model };
  const snapshot = await readProviderSettingsSnapshot(settingsPath, input.provider).catch(() => undefined);
  return {
    provider: input.provider,
    model: typeof snapshot?.originalModel === "string" ? snapshot.originalModel : undefined
  };
}

/**
 * Cached entries are reused while fresh. A failure recorded by a real run is
 * re-checked, except a daily-quota lock, which holds until its reset time.
 */
export function shouldReuse(entry: StatusEntry | undefined, nowMs: number, force?: boolean): entry is StatusEntry {
  if (force || !isFresh(entry, nowMs)) return false;
  return !(entry.source === "run" && entry.state !== "available" && entry.state !== "quota_exhausted");
}

function toResult(entry: StatusEntry, cached: boolean): ClinePingResult {
  return { ...entry, cached };
}

export async function clinePing(
  input: ClinePingInput,
  signal?: AbortSignal,
  deps: ClineDependencies = {}
): Promise<ClinePingResult> {
  const wallNow = deps.wallNow ?? Date.now;
  const statusPath = resolveStatusPath(deps.statusPath);
  const selection = await resolvePingSelection(input, resolveProviderSettingsPath(deps.providerSettingsPath));

  if (statusPath) {
    const cached = await readStatusEntry(statusPath, selection.provider, selection.model).catch(() => undefined);
    if (shouldReuse(cached, wallNow(), input.force)) return toResult(cached, true);
  }

  const started = wallNow();
  let entry: StatusEntry;
  try {
    const response = await runCline(
      {
        prompt: PING_PROMPT,
        thinking: "none",
        timeoutSeconds: input.timeoutSeconds ?? DEFAULT_PING_TIMEOUT_SECONDS,
        provider: input.provider,
        model: input.model
      },
      signal,
      { autoApprove: false, maxAttempts: 1, recordStatus: false, respectQuotaLock: false, deps }
    );
    const reply = response.text.trim();
    const reason = /\bPONG\b/i.test(reply)
      ? "replied PONG"
      : `replied without PONG: ${JSON.stringify(redactSecrets(reply).slice(0, 60))}`;
    entry = buildEntry({
      ...selection,
      classification: { state: "available" },
      reason,
      source: "ping",
      latencyMs: wallNow() - started
    }, wallNow());
  } catch (error) {
    if (error instanceof ClineRunError && error.kind === "cancelled") throw error;
    const classified = classifyRunError(error, wallNow()) ?? {
      state: "unreachable" as const,
      reason: error instanceof ClineRunError ? `${error.kind}: ${error.message.split(/\r?\n/)[0]}` : "ping failed unexpectedly"
    };
    entry = buildEntry({
      ...selection,
      classification: classified,
      reason: redactSecrets(classified.reason),
      source: "ping",
      latencyMs: wallNow() - started
    }, wallNow());
  }
  await recordStatusSafely(statusPath, entry);
  return toResult(entry, false);
}
