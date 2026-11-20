export interface ClineFinalResult {
  text: string;
  model?: string;
  usage?: Record<string, unknown>;
  cost?: unknown;
  durationMs?: number;
  warnings?: string[];
}

export class JsonlParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JsonlParseError";
  }
}

type JsonObject = Record<string, unknown>;

function object(value: unknown): JsonObject | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : undefined;
}

function textFrom(value: JsonObject): string | undefined {
  for (const key of ["text", "outputText", "finalText", "content"]) {
    if (typeof value[key] === "string" && (value[key] as string).trim()) return value[key] as string;
  }
  return undefined;
}

function stringFrom(value: JsonObject, keys: string[]): string | undefined {
  for (const key of keys) if (typeof value[key] === "string") return value[key] as string;
  return undefined;
}

function modelFrom(value: JsonObject): string | undefined {
  const raw = value.model ?? value.modelId;
  if (typeof raw === "string") return raw;
  const model = object(raw);
  if (!model) return undefined;
  const id = stringFrom(model, ["id", "name"]);
  const provider = stringFrom(model, ["provider"]);
  return provider && id ? `${provider}/${id}` : id;
}

type TerminalEvent =
  | { kind: "result"; completed: boolean; result: ClineFinalResult }
  | { kind: "error"; message?: string }
  | undefined;

/**
 * Classifies one JSONL event as a terminal result, a terminal error, or neither. The last terminal event of a
 * run decides its outcome: an error after an earlier answer cancels that answer (plan S15, C7).
 */
function terminalEvent(event: JsonObject): TerminalEvent {
  if (["run_result", "run-finished", "run_completed"].includes(String(event.type))) {
    const eventRun = object(event.run);
    const result = event.type === "run_result"
      ? event
      : object(event.result) ?? object(event.run_result) ?? (eventRun ? object(eventRun.resultSummary) : undefined);
    const finishReason = String(event.finishReason ?? result?.finishReason ?? "");
    if (finishReason === "error") return { kind: "error", message: terminalErrorText(result ?? event, event) };
    if (!result) return undefined;
    const text = textFrom(result);
    if (!text) return undefined;
    return { kind: "result", completed: finishReason === "completed", result: {
      text,
      model: modelFrom(result) ?? modelFrom(event) ?? (eventRun ? modelFrom(eventRun) : undefined),
      usage: object(result.usage) ?? (eventRun ? object(eventRun.usage) : undefined),
      cost: result.cost ?? result.costUsd ?? result.totalCost ?? (eventRun?.cost ?? eventRun?.costUsd ?? eventRun?.totalCost),
      durationMs: typeof result.durationMs === "number" ? result.durationMs : undefined
    } };
  }
  if (event.type === "agent_event") {
    const inner = object(event.event);
    if (!inner || inner.type !== "done") return undefined;
    if (inner.reason === "error") return { kind: "error", message: terminalErrorText(inner, event) };
    if (inner.reason !== "completed") return undefined;
    const text = textFrom(inner) ?? (typeof inner.text === "string" ? inner.text : undefined);
    if (!text) return undefined;
    return { kind: "result", completed: true, result: {
      text,
      model: modelFrom(inner) ?? modelFrom(event),
      usage: object(inner.usage) ?? object(event.usage),
      cost: inner.cost ?? inner.costUsd ?? inner.totalCost ?? event.cost ?? event.costUsd ?? event.totalCost,
      durationMs: typeof inner.durationMs === "number" ? inner.durationMs : typeof event.durationMs === "number" ? event.durationMs : undefined
    } };
  }
  return undefined;
}

/** The message of a terminal error, or undefined when it carries none (then earlier diagnostics must still count). */
function terminalErrorText(result: JsonObject, event: JsonObject): string | undefined {
  for (const source of [result, event]) {
    const error = object(source.error);
    for (const candidate of [textFrom(source), source.error, source.message, error?.message]) {
      if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
    }
  }
  return undefined;
}

/**
 * The message of stdout's LAST terminal event when that event is an error with a message. This decides the run:
 * an earlier quota line or older stderr diagnostics never override it (plan S15/S18, C7).
 */
export function lastTerminalErrorMessage(stdout: string): string | undefined {
  let last: TerminalEvent;
  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    let event: JsonObject | undefined;
    try { event = object(JSON.parse(line)); } catch { continue; }
    if (!event) continue;
    const terminal = terminalEvent(event);
    if (terminal) last = terminal;
  }
  return last?.kind === "error" ? last.message : undefined;
}

/**
 * Extracts a usable final result from stdout. The last terminal event wins; a terminal error clears an earlier result.
 * For exitCode !== 0: accepts only run_result with finishReason:"completed" or agent_event done with reason:"completed".
 * For exitCode === 0: accepts run_result (unless finishReason is "error") or agent_event done with reason:"completed".
 */
export function parseUsableResult(stdout: string, exitCode: number): ClineFinalResult | undefined {
  let found: ClineFinalResult | undefined;
  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    let event: JsonObject | undefined;
    try {
      event = object(JSON.parse(line));
    } catch {
      continue;
    }
    if (!event) continue;
    const terminal = terminalEvent(event);
    if (terminal?.kind === "error") found = undefined;
    else if (terminal?.kind === "result" && (exitCode === 0 || terminal.completed)) found = terminal.result;
  }
  return found;
}

/**
 * Extracts the error that decides a failed run. stdout's last terminal error (with a message) wins; otherwise
 * the most recent diagnostic, stderr first (provider and CLI errors), then stdout (as before S18).
 */
export function extractLastJsonlError(stdout: string, stderr: string): string | undefined {
  const terminalMessage = lastTerminalErrorMessage(stdout);
  if (terminalMessage) return terminalMessage;
  const sources = [stderr, stdout];
  for (const src of sources) {
    if (!src) continue;
    const lines = src.split(/\r?\n/).filter((l) => l.trim().length > 0);
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].trim();
      try {
        const parsed = JSON.parse(line);
        if (!parsed || typeof parsed !== "object") continue;
        const terminal = terminalEvent(parsed);
        // A terminal error without a message must not hide an earlier, informative one: keep looking.
        if (terminal?.kind === "error" && terminal.message) return terminal.message;
        const messages = [parsed.type === "error" && parsed.message,
          parsed.event?.type === "error" && parsed.event.message,
          parsed.event?.reason === "error" && parsed.event.text, parsed.error, parsed.error?.message];
        for (const message of messages) {
          if (typeof message === "string" && message.trim()) return message.trim();
        }
      } catch {
        // Non-JSON line, continue
      }
    }
  }
  return undefined;
}

/**
 * Extracts only a terminal Cline result. Streamed assistant/reasoning events are
 * deliberately ignored so they can never be returned to an MCP client. The last terminal event wins.
 */
export function parseClineJsonl(jsonl: string): ClineFinalResult {
  let finalResult: ClineFinalResult | undefined;
  let hasMalformed = false;

  for (const rawLine of jsonl.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;

    let event: JsonObject;
    try {
      event = object(JSON.parse(line)) ?? (() => { throw new Error("not an object"); })();
    } catch {
      hasMalformed = true;
      continue;
    }
    const terminal = terminalEvent(event);
    if (terminal?.kind === "error") finalResult = undefined;
    else if (terminal?.kind === "result") finalResult = terminal.result;
  }

  if (hasMalformed && !finalResult) {
    throw new JsonlParseError("Cline emitted malformed JSONL output.");
  }
  if (!finalResult) {
    throw new JsonlParseError("Cline did not emit a final run_result.");
  }
  return finalResult;
}
