import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readdir, readFile, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import { redactSecrets } from "./runner.js";
/**
 * Atomic JSON write that never creates directories (unlike status.ts atomicWriteJson): a write that lands
 * after the trace folder was removed fails instead of recreating it. Retries briefly on Windows locks.
 */
async function writeJsonNoMkdir(destination: string, data: unknown): Promise<void> {
  const temp = `${destination}.${randomUUID()}.tmp`;
  await writeFile(temp, JSON.stringify(data, null, 2) + "\n", { encoding: "utf8", mode: 0o600, flag: "wx" });
  try {
    for (let attempt = 0; ; attempt++) {
      try { await rename(temp, destination); return; }
      catch (err: any) {
        if (attempt >= 4 || !["EPERM", "EBUSY", "EACCES"].includes(err?.code)) throw err;
        await new Promise(resolve => setTimeout(resolve, 20 * (attempt + 1)));
      }
    }
  } finally {
    await unlink(temp).catch(() => {});
  }
}

/** Where per-run traces live. One folder per run: events.ndjson + status.json. */
export function resolveTraceBase(override?: string): string {
  if (override) return path.resolve(override);
  if (process.env.CLINE_MCP_TRACE_DIR) return path.resolve(process.env.CLINE_MCP_TRACE_DIR);
  return path.join(os.tmpdir(), "cline-tasks");
}

export const MAX_EVENT_FILE_BYTES = 5 * 1024 * 1024;
export const MAX_PENDING_BYTES = 1024 * 1024;
export const TRACE_TTL_MS = 24 * 60 * 60 * 1000;
/** A run whose PID is still alive is kept this long since its last heartbeat (covers machine sleep). */
export const LIVE_TRACE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const HEARTBEAT_MS = 30_000;
/** finish() waits at most this long for queued disk writes; they continue in the background. */
export const FINISH_WAIT_MS = 2_000;
const MAX_REDACT_DEPTH = 40;
const STATUS_WRITE_INTERVAL_MS = 500;
const REASONING_SNIPPET = 300;
const MAX_FILES = 50;

export interface TraceInfo { runId: string; dir: string; events: string; status: string; }

export type TraceState = "starting" | "running" | "done" | "failed";

export interface TraceStatus {
  runId: string;
  /** The bridge process that owns this run. */
  pid: number;
  /** The Cline process of the current attempt. */
  childPid?: number;
  state: TraceState;
  startedAt: string;
  updatedAt: string;
  elapsedMs: number;
  attempt: number;
  iteration: number;
  clineTaskId?: string;
  currentTool?: { name: string; target?: string };
  toolCalls: number;
  /** Tail of the last COMPLETE reasoning block (redacted). Never built from partial deltas. */
  lastReasoning?: string;
  lastText?: string;
  /** Characters streamed in the block in progress: shows activity without exposing partial text. */
  streamingChars?: number;
  files: string[];
  /** A question Cline asked through its ask_question tool; headless Cline answers it itself (autoAnswer). */
  question?: { question: string; options?: string[]; autoAnswer?: string };
  eventsWritten: number;
  eventsDropped: number;
  finish?: { ok: boolean; kind?: string; message?: string };
}

const SENSITIVE_KEY = /token|secret|password|passwd|passphrase|api[-_]?key|^key$|private[-_]?key|authorization|cookie|credential|session[-_]?id/i;

/**
 * Best-effort redaction of decoded values (see D-18: the trace is local and owner-only, like Cline's own
 * session files; this is defense in depth, not a security boundary). A sensitive key redacts its whole
 * subtree, whatever the value type. Secrets inside JSON embedded as text in free-form reasoning are only
 * caught by the text patterns.
 */
export function redactValue(value: unknown, key = "", depth = 0, sensitive = false): unknown {
  const hidden = sensitive || SENSITIVE_KEY.test(key);
  if (hidden && value !== null && typeof value !== "object") return "[REDACTED]";
  if (typeof value === "string") return redactSecrets(value);
  if (depth >= MAX_REDACT_DEPTH && value && typeof value === "object") return "[TRUNCATED: nested too deeply]";
  if (Array.isArray(value)) return value.map(v => redactValue(v, key, depth + 1, hidden));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = redactValue(v, k, depth + 1, hidden);
    return out;
  }
  return value;
}

const isObject = (v: unknown): v is Record<string, any> => typeof v === "object" && v !== null && !Array.isArray(v);
const short = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

/** Best short description of what a tool call works on (path, command, query). */
function toolTarget(input: unknown): { target?: string; files: string[] } {
  if (!isObject(input)) return { files: [] };
  const files: string[] = [];
  const add = (p: unknown) => { if (typeof p === "string" && p) files.push(p); };
  add(input.path); add(input.file); add(input.filePath);
  if (Array.isArray(input.files)) for (const f of input.files) add(isObject(f) ? f.path : f);
  if (Array.isArray(input.paths)) for (const p of input.paths) add(p);
  const commands = Array.isArray(input.commands) ? input.commands.join(" && ") : input.commands ?? input.command;
  const target = files[0] ?? (typeof commands === "string" ? commands : undefined) ??
    (typeof input.query === "string" ? input.query : undefined) ?? (typeof input.question === "string" ? input.question : undefined);
  return { target: target ? short(redactSecrets(target), 160) : undefined, files };
}

interface ReducerScratch { reasoning: string; text: string; }

/**
 * Folds one parsed Cline event into the live status. Deltas only update the in-memory buffers and the
 * redacted snippet; the full redacted block arrives with content_end.
 */
export function reduceEvent(status: TraceStatus, scratch: ReducerScratch, event: Record<string, any>): void {
  if (event.type === "hook_event" && typeof event.taskId === "string" && !status.clineTaskId) status.clineTaskId = event.taskId;
  if (event.type !== "agent_event" || !isObject(event.event)) return;
  const e = event.event;
  switch (e.type) {
    case "iteration_start":
      if (typeof e.iteration === "number") status.iteration = e.iteration;
      status.currentTool = undefined;
      break;
    case "content_start":
      // Deltas are only counted: a secret split across deltas cannot be recognised until its block is complete.
      if (e.contentType === "reasoning" && typeof e.reasoning === "string") {
        status.streamingChars = (status.streamingChars ?? 0) + e.reasoning.length;
      } else if (e.contentType === "text" && typeof e.text === "string") {
        status.streamingChars = (status.streamingChars ?? 0) + e.text.length;
      } else if (e.contentType === "tool" && typeof e.toolName === "string") {
        const { target, files } = toolTarget(e.input);
        status.currentTool = { name: e.toolName, ...(target ? { target } : {}) };
        status.toolCalls++;
        for (const f of files) {
          const clean = short(redactSecrets(f), 300);
          if (!status.files.includes(clean) && status.files.length < MAX_FILES) status.files.push(clean);
        }
        if (e.toolName === "ask_question" && isObject(e.input) && typeof e.input.question === "string") {
          const options = Array.isArray(e.input.options) ? e.input.options.filter((o: unknown) => typeof o === "string").map((o: string) => short(redactSecrets(o), 200)) : undefined;
          status.question = { question: short(redactSecrets(e.input.question), 500), ...(options ? { options } : {}) };
        }
      }
      break;
    case "content_end":
      if (e.contentType === "reasoning" && typeof e.reasoning === "string") {
        status.lastReasoning = redactSecrets(e.reasoning).slice(-REASONING_SNIPPET);
        status.streamingChars = 0;
      } else if (e.contentType === "text" && typeof e.text === "string") {
        status.lastText = redactSecrets(e.text).slice(-REASONING_SNIPPET);
        status.streamingChars = 0;
      } else if (e.contentType === "tool" && e.toolName === "ask_question" && status.question && typeof e.output === "string") {
        status.question.autoAnswer = short(redactSecrets(e.output), 200);
      }
      break;
  }
}

export interface TraceOptions {
  base?: string;
  runId?: string;
  maxEventBytes?: number;
  maxPendingBytes?: number;
  statusIntervalMs?: number;
  heartbeatMs?: number;
  finishWaitMs?: number;
  wallNow?: () => number;
  /** Test seam for the event append. */
  appendFile?: typeof appendFile;
}

/**
 * Records one bridge run: every Cline event (deltas excluded, values redacted) appended to events.ndjson in
 * order, and a coalesced status.json. Writes are asynchronous and bounded so stdout handling, timeouts and
 * kills are never delayed by disk I/O.
 */
export class TraceRecorder {
  readonly info: TraceInfo;
  private readonly status: TraceStatus;
  private readonly scratch: ReducerScratch = { reasoning: "", text: "" };
  private readonly wallNow: () => number;
  private readonly started: number;
  private chain: Promise<void>;
  private pendingBytes = 0;
  private writtenBytes = 0;
  private statusTimer: NodeJS.Timeout | undefined;
  private finished = false;
  private closed = false;
  private readonly maxEventBytes: number;
  private readonly maxPendingBytes: number;
  private readonly statusIntervalMs: number;
  private readonly finishWaitMs: number;
  private readonly append: typeof appendFile;
  private heartbeat: NodeJS.Timeout | undefined;

  constructor(options: TraceOptions = {}) {
    const runId = options.runId ?? randomUUID();
    const dir = path.join(resolveTraceBase(options.base), runId);
    this.info = { runId, dir, events: path.join(dir, "events.ndjson"), status: path.join(dir, "status.json") };
    this.wallNow = options.wallNow ?? Date.now;
    this.started = this.wallNow();
    this.maxEventBytes = options.maxEventBytes ?? MAX_EVENT_FILE_BYTES;
    this.maxPendingBytes = options.maxPendingBytes ?? MAX_PENDING_BYTES;
    this.statusIntervalMs = options.statusIntervalMs ?? STATUS_WRITE_INTERVAL_MS;
    this.finishWaitMs = options.finishWaitMs ?? FINISH_WAIT_MS;
    this.append = options.appendFile ?? appendFile;
    const now = new Date(this.started).toISOString();
    this.status = { runId, pid: process.pid, state: "starting", startedAt: now, updatedAt: now, elapsedMs: 0,
      attempt: 0, iteration: 0, toolCalls: 0, files: [], eventsWritten: 0, eventsDropped: 0 };
    // Failures to create the folder must never break the run; later writes just fail quietly.
    this.chain = mkdir(dir, { recursive: true }).then(() => this.writeStatus()).catch(() => {});
    // Heartbeat keeps updatedAt fresh during long quiet steps, so cleanup can tell a live run from a dead one.
    this.heartbeat = setInterval(() => {
      this.chain = this.chain.then(() => this.writeStatus()).catch(() => {});
    }, options.heartbeatMs ?? HEARTBEAT_MS);
    this.heartbeat.unref?.();
  }

  /**
   * Stops all further writes, including ones still queued. Call before deleting the trace folder; a write that
   * is already in progress may still finish, so wait for idle() first.
   */
  close(): void {
    this.closed = true;
    this.finished = true;
    if (this.statusTimer) { clearTimeout(this.statusTimer); this.statusTimer = undefined; }
    if (this.heartbeat) { clearInterval(this.heartbeat); this.heartbeat = undefined; }
  }

  /** Resolves when queued writes are done, or after waitMs. */
  async idle(waitMs = FINISH_WAIT_MS): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([this.chain, new Promise<void>(resolve => { timer = setTimeout(resolve, waitMs); })]);
    if (timer) clearTimeout(timer);
  }

  /** The current attempt's Cline process started. */
  processStarted(childPid: number): void {
    if (this.finished) return;
    this.status.childPid = childPid;
    this.scheduleStatus();
  }

  /** A stdout line too long to keep was discarded by the splitter. */
  oversizedLine(attempt: number): void {
    if (this.finished) return;
    this.enqueue(JSON.stringify({ attempt, type: "oversized_line_dropped", maxChars: MAX_LINE_CHARS }) + "\n");
  }

  /** Current status snapshot (a copy). */
  snapshot(): TraceStatus { return structuredClone(this.status); }

  attemptStarted(attempt: number): void {
    if (this.finished) return;
    this.status.attempt = attempt;
    this.status.state = "running";
    // Each attempt is a new Cline process with its own task id and step counter.
    this.status.clineTaskId = undefined;
    this.status.iteration = 0;
    this.status.currentTool = undefined;
    this.status.streamingChars = 0;
    this.scheduleStatus();
  }

  /** One complete stdout line from Cline. Never throws: tracing must not break the run. */
  line(raw: string, attempt: number): void {
    if (this.finished) return;
    try { this.record(raw, attempt); } catch { this.status.eventsDropped++; }
  }

  private record(raw: string, attempt: number): void {
    const text = raw.trim();
    if (!text) return;
    let event: Record<string, any> | undefined;
    try { const parsed = JSON.parse(text); if (isObject(parsed)) event = parsed; } catch { /* raw line */ }
    if (event) {
      try { reduceEvent(this.status, this.scratch, event); } catch { /* status is best effort */ }
      const inner = isObject(event.event) ? event.event : undefined;
      // Streaming deltas are not persisted: a secret split across deltas could evade redaction.
      if (inner?.type === "content_start" && (inner.contentType === "reasoning" || inner.contentType === "text")) {
        this.scheduleStatus();
        return;
      }
    }
    let record: object;
    if (event) record = { attempt, ...(redactValue(event) as object) };
    // A line that looks like JSON but does not parse is a fragment (cut-off or oversized): its escaped
    // content cannot be redacted reliably, so only its size is recorded.
    else if (/^[\[{]/.test(text)) record = { attempt, type: "unparsed_line_dropped", chars: text.length };
    else record = { attempt, type: "raw", line: short(redactSecrets(text), 2000) };
    this.enqueue(JSON.stringify(record) + "\n");
    this.scheduleStatus();
  }

  private enqueue(data: string): void {
    const bytes = Buffer.byteLength(data);
    if (this.writtenBytes + this.pendingBytes + bytes > this.maxEventBytes || this.pendingBytes + bytes > this.maxPendingBytes) {
      this.status.eventsDropped++;
      return;
    }
    this.pendingBytes += bytes;
    this.chain = this.chain.then(async () => {
      if (this.closed) { this.pendingBytes -= bytes; return; }
      try { await this.append(this.info.events, data, { encoding: "utf8", mode: 0o600 }); this.writtenBytes += bytes; this.status.eventsWritten++; }
      catch { this.status.eventsDropped++; }
      finally { this.pendingBytes -= bytes; }
    });
  }

  private scheduleStatus(): void {
    if (this.statusTimer || this.finished) return;
    this.statusTimer = setTimeout(() => {
      this.statusTimer = undefined;
      this.chain = this.chain.then(() => this.writeStatus()).catch(() => {});
    }, this.statusIntervalMs);
    this.statusTimer.unref?.();
  }

  private async writeStatus(): Promise<void> {
    if (this.closed) return;
    const now = this.wallNow();
    this.status.updatedAt = new Date(now).toISOString();
    this.status.elapsedMs = now - this.started;
    await writeJsonNoMkdir(this.info.status, this.status);
  }

  /** Final status. Idempotent; waits for all queued writes. Never throws. */
  async finish(outcome: { ok: boolean; kind?: string; message?: string }): Promise<TraceInfo> {
    if (!this.finished) {
      this.finished = true;
      if (this.statusTimer) { clearTimeout(this.statusTimer); this.statusTimer = undefined; }
      if (this.heartbeat) { clearInterval(this.heartbeat); this.heartbeat = undefined; }
      this.status.state = outcome.ok ? "done" : "failed";
      this.status.currentTool = undefined;
      this.status.finish = { ok: outcome.ok, ...(outcome.kind ? { kind: outcome.kind } : {}),
        ...(outcome.message ? { message: short(redactSecrets(outcome.message), 500) } : {}) };
      this.chain = this.chain.then(() => this.writeStatus()).catch(() => {});
    }
    // A stalled disk (e.g. a disconnected network TEMP) must not hold the run's result.
    let timer: NodeJS.Timeout | undefined;
    // Not unref'd: the caller is awaiting this, so the timer must keep the process alive until it fires.
    await Promise.race([this.chain, new Promise<void>(resolve => { timer = setTimeout(resolve, this.finishWaitMs); })]);
    if (timer) clearTimeout(timer);
    return this.info;
  }
}

/**
 * Splits one attempt's stdout into lines for the recorder. Decodes UTF-8 across chunk boundaries and never
 * joins fragments across attempts.
 */
export const MAX_LINE_CHARS = 1_000_000;

export class LineSplitter {
  private buffer = "";
  private skipping = false;
  private readonly decoder = new TextDecoder("utf-8");
  /**
   * @param onLine a complete line
   * @param onOversized a line longer than MAX_LINE_CHARS was discarded (never forwarded as a fragment,
   *   which could not be parsed and redacted)
   */
  constructor(private readonly onLine: (line: string) => void, private readonly onOversized: () => void = () => {}) {}
  push(chunk: Buffer | string): void {
    this.buffer += typeof chunk === "string" ? chunk : this.decoder.decode(chunk, { stream: true });
    let index: number;
    while ((index = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, index).replace(/\r$/, "");
      this.buffer = this.buffer.slice(index + 1);
      if (this.skipping) { this.skipping = false; continue; } // tail of a discarded oversized line
      if (line.length > MAX_LINE_CHARS) { this.onOversized(); continue; }
      this.onLine(line);
    }
    if (this.buffer.length > MAX_LINE_CHARS) {
      if (!this.skipping) this.onOversized();
      this.skipping = true;
      this.buffer = "";
    }
  }
  flush(): void {
    this.buffer += this.decoder.decode();
    if (this.buffer && !this.skipping) {
      if (this.buffer.length > MAX_LINE_CHARS) this.onOversized();
      else this.onLine(this.buffer);
    }
    this.buffer = "";
    this.skipping = false;
  }
}

function isProcessAlive(pid: number): boolean {
  if (pid === process.pid) return true;
  try { process.kill(pid, 0); return true; } catch (err: any) { return err?.code === "EPERM"; }
}

/**
 * Removes finished traces older than the TTL, and traces whose bridge process died while running (orphans).
 * Folders without a readable status are removed once older than the TTL. Never touches a live run.
 */
export async function cleanupTraces(options: { base?: string; ttlMs?: number; liveTtlMs?: number; wallNow?: () => number;
  isProcessAlive?: (pid: number) => boolean } = {}): Promise<{ removed: string[] }> {
  const base = resolveTraceBase(options.base);
  const now = (options.wallNow ?? Date.now)();
  const ttl = options.ttlMs ?? TRACE_TTL_MS;
  const liveTtl = options.liveTtlMs ?? LIVE_TRACE_TTL_MS;
  const alive = options.isProcessAlive ?? isProcessAlive;
  const removed: string[] = [];
  let names: string[];
  try { names = await readdir(base); } catch { return { removed }; }
  for (const name of names) {
    if (!/^[A-Za-z0-9-]{8,64}$/.test(name)) continue;
    const dir = path.join(base, name);
    let remove = false;
    try {
      const status = JSON.parse(await readFile(path.join(dir, "status.json"), "utf8")) as Partial<TraceStatus>;
      const updated = Date.parse(status.updatedAt ?? "");
      // Live runs heartbeat every 30 s. A live PID silent for LIVE_TRACE_TTL_MS (a week, longer than any sleep)
      // is treated as reused, not live.
      const live = (status.state === "starting" || status.state === "running") && typeof status.pid === "number" &&
        alive(status.pid) && now - updated < liveTtl;
      if (!live) remove = status.state === "done" || status.state === "failed" ? !(now - updated < ttl) : true;
    } catch {
      try { remove = now - (await stat(dir)).mtimeMs >= ttl; } catch { remove = false; }
    }
    if (remove) {
      try { await rm(dir, { recursive: true, force: true, maxRetries: 3 }); removed.push(name); } catch { /* retried next start */ }
    }
  }
  return { removed };
}
