import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { acquireSettingsMutex } from "./settings.js";

// Provider availability as seen by the bridge, shared with other local tools
// (model-picker reads it) through a small JSON file outside any worktree.

export type ProviderState = "available" | "rate_limited" | "quota_exhausted" | "unreachable";
export type StatusSource = "ping" | "run";

export interface StatusEntry {
  provider: string;
  model: string;
  state: ProviderState;
  reason: string;
  checked_at: string;
  expires_at: string;
  source: StatusSource;
  latency_ms?: number;
  retry_after_s?: number;
  strikes?: number;
  reset_at?: string;
}

export interface StatusFile {
  version: 1;
  updated_at: string;
  entries: Record<string, StatusEntry>;
}

export interface Classification {
  state: ProviderState;
  retryAfterSeconds?: number;
  resetAtMs?: number;
  assumedReset?: boolean;
}

export const AVAILABLE_TTL_MS = 60_000;
export const RATE_LIMIT_LADDER_MS = [60_000, 180_000, 600_000, 1_800_000] as const;
export const RATE_LIMITED_TTL_MS = RATE_LIMIT_LADDER_MS[0];
export const RATE_LIMIT_STRIKE_WINDOW_MS = 1_800_000;
export const UNREACHABLE_TTL_MS = 60_000;
const PARALLEL_RATE_LIMIT_WINDOW_MS = 2_000;
const MAX_RATE_LIMIT_TTL_MS = 3_600_000;
const MAX_REASON_CHARACTERS = 240;

export function resolveStatusPath(overridePath?: string | null): string | undefined {
  if (overridePath === null) return undefined;
  if (overridePath) return path.resolve(overridePath);
  if (process.env.CLINE_MCP_STATUS_PATH) return path.resolve(process.env.CLINE_MCP_STATUS_PATH);
  return path.join(os.homedir(), ".cline-mcp", "status.json");
}

export function resolveCatalogPath(overridePath: null): undefined;
export function resolveCatalogPath(overridePath?: string): string;
export function resolveCatalogPath(overridePath?: string | null): string | undefined;
export function resolveCatalogPath(overridePath?: string | null): string | undefined {
  if (overridePath === null) return undefined;
  if (overridePath) return path.resolve(overridePath);
  if (process.env.CLINE_MCP_CATALOG_PATH) return path.resolve(process.env.CLINE_MCP_CATALOG_PATH);
  return path.join(os.homedir(), ".cline-mcp", "catalog.json");
}

export function statusKey(provider?: string, model?: string): string {
  return `${provider || "default"}|${model || "default"}`;
}

const QUOTA_PATTERNS = [
  /daily\s+free(?:\s+model)?\s+limit\s+(?:reached|exceeded|exhausted)/i,
  /free[-_\s]models?[-_\s]per[-_\s]day/i,
  /daily\s+(?:request\s+|token\s+|free\s+)?(?:quota|limit)\s+(?:has\s+been\s+)?(?:reached|exceeded|exhausted)/i
];
function httpStatusPattern(code: string): RegExp {
  const status = String.raw`\b(?:http(?:/\d+(?:\.\d+)?)?(?:\s+error)?|status(?:[\s_-]*code)?)\b["']?\s*[:=]?\s*["']?${code}\b`;
  const error = String.raw`\berror\s+${code}\s*:|\bapi\s+error\s*\(\s*${code}\s*\)`;
  return new RegExp(`${status}|${error}`, "i");
}

const RATE_LIMIT_PATTERNS = [
  httpStatusPattern("429"),
  // A leading 429 is a status (`429 Provider returned error`), unless it counts things (`429 files could not be indexed`).
  // A compiler code frame (`429 | const x = ;`) is a source line number, not a status.
  /^\s*429\b(?!\s*\|)(?!\s+(?:files?|items?|lines?|records?|rows?|entries|tests?|objects?|bytes?|chars?|characters?|paths?|modules?|packages?|matches|results?|commits?|warnings?)\b)/i,
  /\brate[\s-]*limit/i,
  /\btoo\s+many\s+requests\b/i
];
const PROVIDER_FAILURE_PATTERNS = [
  httpStatusPattern("5\\d\\d"),
  /\b(?:upstream\s+(?:5\d\d|error)|provider\s+error|bad\s+gateway|gateway\s+timeout|service\s+unavailable|temporarily\s+unavailable|overloaded)\b/i,
  /\b(?:ECONNRESET|ETIMEDOUT|ECONNREFUSED)\b/i
];

export function isDailyQuotaText(text: string | undefined): boolean {
  return !!text && QUOTA_PATTERNS.some((pattern) => pattern.test(text));
}

const UNIT_SECONDS: Array<[RegExp, number]> = [
  [/^d(?:ays?)?$/i, 86_400],
  [/^h(?:ours?|rs?)?$/i, 3_600],
  [/^m(?:in(?:ute)?s?)?$/i, 60],
  [/^s(?:ec(?:ond)?s?)?$/i, 1]
];

/** Seconds in "try again in 23h 59m", "retry after 30s", "Retry-After: 30" and similar forms. */
export function parseRetryDelaySeconds(text: string): number | undefined {
  const phrase = /(?:try\s+again|retry|resets?|available\s+again)\s+(?:in|after)\s+((?:\d+(?:\.\d+)?\s*[a-z]*[\s,]*(?:and\s+)?)+)/i.exec(text);
  if (phrase) {
    let total = 0;
    let matched = false;
    for (const part of phrase[1].matchAll(/(\d+(?:\.\d+)?)\s*([a-z]*)/gi)) {
      const unit = part[2] || "s";
      const seconds = UNIT_SECONDS.find(([pattern]) => pattern.test(unit))?.[1];
      if (seconds === undefined) break;
      total += Number(part[1]) * seconds;
      matched = true;
    }
    if (matched) return Math.ceil(total);
  }
  const header = /retry-after["']?\s*[:=]\s*["']?(\d+)/i.exec(text);
  return header ? Number(header[1]) : undefined;
}

/** Absolute reset instants: ISO timestamps or epoch values after "reset". */
export function parseResetInstant(text: string): number | undefined {
  const httpDate = /retry-after["']?\s*[:=]\s*["']?((?:Mon|Tue|Wed|Thu|Fri|Sat|Sun),\s*\d{1,2}\s+[A-Za-z]{3}\s+\d{4}\s+\d{2}:\d{2}:\d{2}\s+GMT)/i.exec(text);
  if (httpDate) {
    const value = Date.parse(httpDate[1]);
    if (Number.isFinite(value)) return value;
  }
  const iso = /reset(?:s|_at|-at)?["']?\s*(?:at|on|:|=)?\s*["']?(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)/i.exec(text);
  if (iso) {
    const value = Date.parse(/Z|[+-]\d{2}:?\d{2}$/.test(iso[1]) ? iso[1] : iso[1] + "Z");
    if (!Number.isNaN(value)) return value;
  }
  const epoch = /reset["']?\s*[:=]\s*["']?(\d{10}|\d{13})\b/i.exec(text);
  if (epoch) return epoch[1].length === 13 ? Number(epoch[1]) : Number(epoch[1]) * 1000;
  return undefined;
}

function nextUtcMidnight(nowMs: number): number {
  const now = new Date(nowMs);
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
}

export function classifyErrorText(text: string, nowMs: number): Classification {
  return classifyErrorMessages([text], nowMs);
}

function classifyErrorMessages(messages: string[], nowMs: number): Classification {
  const text = messages.join("\n");
  const delay = parseRetryDelaySeconds(text);
  const instant = parseResetInstant(text);
  if (isDailyQuotaText(text)) {
    if (instant !== undefined && instant > nowMs) return { state: "quota_exhausted", resetAtMs: instant };
    if (delay !== undefined) return { state: "quota_exhausted", resetAtMs: nowMs + delay * 1000, retryAfterSeconds: delay };
    // Conservative fallback, explicitly marked as assumed in the stored reason.
    return { state: "quota_exhausted", resetAtMs: nextUtcMidnight(nowMs), assumedReset: true };
  }
  if (messages.some(message => RATE_LIMIT_PATTERNS.some(pattern => pattern.test(message)))) {
    if (delay !== undefined) return { state: "rate_limited", retryAfterSeconds: delay };
    if (instant !== undefined && instant > nowMs) {
      return { state: "rate_limited", retryAfterSeconds: Math.ceil((instant - nowMs) / 1000), resetAtMs: instant };
    }
    return { state: "rate_limited" };
  }
  return { state: "unreachable" };
}

interface RunErrorLike {
  kind?: string;
  message?: string;
  extractedMessage?: string;
  diagnostics?: string[];
  resetAt?: string;
  retryAfterSeconds?: number;
}

const UNREACHABLE_KINDS = new Set(["timeout", "malformed_json", "missing_final_result"]);
const TEXT_CLASSIFIED_KINDS = new Set(["transient_provider_error", "non_zero_exit"]);

/** Provider state for a failed run, or undefined when the failure says nothing about the provider. */
export function classifyRunError(error: unknown, nowMs: number): (Classification & { reason: string }) | undefined {
  const err = (error && typeof error === "object" ? error : {}) as RunErrorLike;
  const firstLine = (err.extractedMessage || err.message || "unknown error").split(/\r?\n/)[0];
  const reason = `${err.kind ?? "error"}: ${firstLine}`;
  if (err.kind === "quota_exhausted") {
    const resetAtMs = err.resetAt ? Date.parse(err.resetAt) : undefined;
    return { state: "quota_exhausted", resetAtMs, retryAfterSeconds: err.retryAfterSeconds, reason };
  }
  if (err.kind && UNREACHABLE_KINDS.has(err.kind)) return { state: "unreachable", reason };
  if (err.kind && TEXT_CLASSIFIED_KINDS.has(err.kind)) {
    // Each stderr diagnostic is its own message; a multi-line error is never split, so an inner line such as
    // `429 | const x` cannot pass for a leading HTTP status (plan S20 review).
    const messages = [...(err.diagnostics ?? []), err.extractedMessage, err.message].filter((message): message is string => !!message);
    const classification = classifyErrorMessages(messages, nowMs);
    if (err.kind === "non_zero_exit" && classification.state === "unreachable" &&
        !messages.some(message => PROVIDER_FAILURE_PATTERNS.some(pattern => pattern.test(message)))) return undefined;
    return { ...classification, reason };
  }
  return undefined;
}

function rateLimitTtlMs(strikes: number, retryAfterSeconds?: number): number {
  if (retryAfterSeconds !== undefined) return Math.min(MAX_RATE_LIMIT_TTL_MS, Math.max(5_000, retryAfterSeconds * 1000));
  return RATE_LIMIT_LADDER_MS[Math.min(strikes, RATE_LIMIT_LADDER_MS.length) - 1];
}

export function buildEntry(
  args: {
    provider?: string;
    model?: string;
    classification: Classification;
    reason: string;
    source: StatusSource;
    latencyMs?: number;
  },
  nowMs: number
): StatusEntry {
  const { classification, reason } = args;
  let expiresMs: number;
  switch (classification.state) {
    case "available":
      expiresMs = nowMs + AVAILABLE_TTL_MS;
      break;
    case "rate_limited":
      expiresMs = nowMs + rateLimitTtlMs(1, classification.retryAfterSeconds);
      break;
    case "quota_exhausted":
      expiresMs = classification.resetAtMs && classification.resetAtMs > nowMs
        ? classification.resetAtMs
        : nextUtcMidnight(nowMs);
      break;
    default:
      expiresMs = nowMs + UNREACHABLE_TTL_MS;
  }
  const fullReason = classification.assumedReset ? `${reason} (reset time not given; assumed next UTC midnight)` : reason;
  return {
    provider: args.provider || "default",
    model: args.model || "default",
    state: classification.state,
    reason: fullReason.length > MAX_REASON_CHARACTERS ? fullReason.slice(0, MAX_REASON_CHARACTERS - 1) + "…" : fullReason,
    checked_at: new Date(nowMs).toISOString(),
    expires_at: new Date(expiresMs).toISOString(),
    source: args.source,
    ...(classification.state === "rate_limited" ? { strikes: 1 } : {}),
    ...(args.latencyMs !== undefined ? { latency_ms: Math.round(args.latencyMs) } : {}),
    ...(classification.retryAfterSeconds !== undefined ? { retry_after_s: classification.retryAfterSeconds } : {}),
    ...(classification.state === "quota_exhausted" ? { reset_at: new Date(expiresMs).toISOString() } : {}),
    ...(classification.state === "rate_limited" && classification.resetAtMs ? { reset_at: new Date(classification.resetAtMs).toISOString() } : {})
  };
}

export function isFresh(entry: StatusEntry | undefined, nowMs: number): entry is StatusEntry {
  if (!entry) return false;
  if (!["available", "rate_limited", "quota_exhausted", "unreachable"].includes(entry.state)) return false;
  const checked = Date.parse(entry.checked_at);
  const expires = Date.parse(entry.expires_at);
  return Number.isFinite(checked) && checked <= nowMs && Number.isFinite(expires) && nowMs < expires;
}

/** A cached daily-quota lock that has not reached its reset time yet. */
export function activeQuotaLock(entry: StatusEntry | undefined, nowMs: number): StatusEntry | undefined {
  return entry?.state === "quota_exhausted" && isFresh(entry, nowMs) ? entry : undefined;
}

function emptyFile(nowMs: number): StatusFile {
  return { version: 1, updated_at: new Date(nowMs).toISOString(), entries: {} };
}

export async function readStatusFile(statusPath: string): Promise<StatusFile> {
  try {
    const parsed = JSON.parse((await readFile(statusPath, "utf8")).replace(/^﻿/, ""));
    if (parsed && parsed.version === 1 && typeof parsed === "object" && parsed.entries && typeof parsed.entries === "object" && !Array.isArray(parsed.entries)) {
      return { version: 1, updated_at: String(parsed.updated_at ?? ""), entries: parsed.entries };
    }
  } catch {}
  return emptyFile(Date.now());
}

export async function readStatusEntry(statusPath: string, provider?: string, model?: string): Promise<StatusEntry | undefined> {
  const file = await readStatusFile(statusPath);
  const entry = file.entries[statusKey(provider, model)];
  return entry && typeof entry === "object" && entry.provider === (provider || "default") &&
    entry.model === (model || "default") && typeof entry.reason === "string" &&
    ["available", "rate_limited", "quota_exhausted", "unreachable"].includes(entry.state) &&
    Number.isFinite(Date.parse(entry.checked_at)) && Number.isFinite(Date.parse(entry.expires_at))
    ? entry : undefined;
}

export async function atomicWriteJson(destination: string, data: unknown): Promise<void> {
  await mkdir(path.dirname(destination), { recursive: true });
  const temp = `${destination}.${randomUUID()}.tmp`;
  try {
    await writeFile(temp, JSON.stringify(data, null, 2) + "\n", { encoding: "utf8", mode: 0o600, flag: "wx" });
    // Windows rename fails briefly while a reader holds the destination open.
    for (let attempt = 0; ; attempt++) {
      try {
        await rename(temp, destination);
        return;
      } catch (err: any) {
        if (attempt >= 4 || !["EPERM", "EBUSY", "EACCES"].includes(err?.code)) throw err;
        await new Promise((resolve) => setTimeout(resolve, 25 * (attempt + 1)));
      }
    }
  } finally {
    await unlink(temp).catch(() => {});
  }
}

// Queue locally and serialize read-modify-write across bridge processes.
let writeQueue: Promise<unknown> = Promise.resolve();

function applyRateLimitHistory(entry: StatusEntry, previous?: StatusEntry): StatusEntry {
  if (entry.state !== "rate_limited") return entry;
  const now = Date.parse(entry.checked_at);
  const elapsed = previous?.state === "rate_limited" ? now - Date.parse(previous.checked_at) : Infinity;
  // Parallel writers may acquire the mutex in either order.
  const parallel = Math.abs(elapsed) < PARALLEL_RATE_LIMIT_WINDOW_MS;
  let strikes = 1;
  let earliestExpiry = now;
  if (previous && (parallel || (elapsed >= 0 && elapsed <= RATE_LIMIT_STRIKE_WINDOW_MS))) {
    const priorStrikes = previous.strikes ?? 1; // Entries written by older bridges omit strikes.
    strikes = Number.isSafeInteger(priorStrikes) && priorStrikes > 0 ? priorStrikes : 1;
    if (parallel) {
      const priorExpiry = Date.parse(previous.expires_at);
      if (Number.isFinite(priorExpiry)) earliestExpiry = priorExpiry;
    } else {
      strikes++;
    }
  }
  const expires = Math.max(earliestExpiry, now + rateLimitTtlMs(strikes, entry.retry_after_s));
  return { ...entry, strikes, expires_at: new Date(expires).toISOString() };
}

export function writeStatusEntry(statusPath: string, entry: StatusEntry): Promise<StatusEntry> {
  const task = writeQueue.then(async () => {
    const release = await acquireSettingsMutex(statusPath, undefined, { lockTimeoutMs: 2000 });
    try {
      const file = await readStatusFile(statusPath);
      const key = statusKey(entry.provider, entry.model);
      const stored = applyRateLimitHistory(entry, file.entries[key]);
      file.entries[key] = stored;
      file.updated_at = stored.checked_at;
      await atomicWriteJson(statusPath, file);
      return stored;
    } finally {
      await release();
    }
  });
  writeQueue = task.catch(() => {});
  return task;
}

/** Best-effort status update; status bookkeeping must never fail a Cline request. */
export async function recordStatusSafely(statusPath: string | undefined, entry: StatusEntry): Promise<StatusEntry> {
  if (!statusPath) return entry;
  try {
    return await writeStatusEntry(statusPath, entry);
  } catch { return entry; }
}
