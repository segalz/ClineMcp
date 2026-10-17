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

/**
 * Extracts a usable final result from stdout.
 * For exitCode !== 0: accepts only run_result with finishReason:"completed" or agent_event done with reason:"completed".
 * For exitCode === 0: accepts run_result (unless finishReason is "error") or agent_event done with reason:"completed".
 */
export function parseUsableResult(stdout: string, exitCode: number): ClineFinalResult | undefined {
  let runResultFound: ClineFinalResult | undefined;
  let doneResultFound: ClineFinalResult | undefined;

  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;

    let event: JsonObject;
    try {
      const parsed = JSON.parse(line);
      if (!object(parsed)) continue;
      event = parsed as JsonObject;
    } catch {
      continue;
    }

    if (["run_result", "run-finished", "run_completed"].includes(String(event.type))) {
      const finishReason = String(event.finishReason ?? "");
      if (finishReason === "error") {
        continue;
      }
      if (exitCode !== 0 && finishReason !== "completed") {
        continue;
      }

      const eventRun = object(event.run);
      const result = event.type === "run_result"
        ? event
        : object(event.result) ?? object(event.run_result) ?? (eventRun ? object(eventRun.resultSummary) : undefined);
      if (!result) continue;
      const text = textFrom(result);
      if (!text) continue;

      runResultFound = {
        text,
        model: modelFrom(result) ?? modelFrom(event) ?? (eventRun ? modelFrom(eventRun) : undefined),
        usage: object(result.usage) ?? (eventRun ? object(eventRun.usage) : undefined),
        cost: result.cost ?? result.costUsd ?? result.totalCost ?? (eventRun?.cost ?? eventRun?.costUsd ?? eventRun?.totalCost),
        durationMs: typeof result.durationMs === "number" ? result.durationMs : undefined
      };
    } else if (event.type === "agent_event") {
      const inner = object(event.event);
      if (inner && inner.type === "done" && inner.reason === "completed") {
        const text = textFrom(inner) ?? (typeof inner.text === "string" ? inner.text : undefined);
        if (text) {
          doneResultFound = {
            text,
            model: modelFrom(inner) ?? modelFrom(event),
            usage: object(inner.usage) ?? object(event.usage),
            cost: inner.cost ?? inner.costUsd ?? inner.totalCost ?? event.cost ?? event.costUsd ?? event.totalCost,
            durationMs: typeof inner.durationMs === "number" ? inner.durationMs : typeof event.durationMs === "number" ? event.durationMs : undefined
          };
        }
      }
    }
  }

  return runResultFound ?? doneResultFound;
}

/**
 * Extracts the last JSONL error message from stderr or stdout.
 */
export function extractLastJsonlError(stdout: string, stderr: string): string | undefined {
  const sources = [stderr, stdout];
  for (const src of sources) {
    if (!src) continue;
    const lines = src.split(/\r?\n/).filter((l) => l.trim().length > 0);
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].trim();
      try {
        const parsed = JSON.parse(line);
        if (!parsed || typeof parsed !== "object") continue;
        if (parsed.type === "error" && typeof parsed.message === "string") {
          return parsed.message.trim();
        }
        if (parsed.type === "run_result" && parsed.finishReason === "error" && typeof parsed.text === "string") {
          return parsed.text.trim();
        }
        if (parsed.event && typeof parsed.event === "object") {
          if (parsed.event.type === "error" && typeof parsed.event.message === "string") {
            return parsed.event.message.trim();
          }
          if (parsed.event.reason === "error" && typeof parsed.event.text === "string") {
            return parsed.event.text.trim();
          }
        }
        if (typeof parsed.error === "string") {
          return parsed.error.trim();
        }
        if (parsed.error && typeof parsed.error === "object" && typeof parsed.error.message === "string") {
          return parsed.error.message.trim();
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
 * deliberately ignored so they can never be returned to an MCP client.
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

    if (["run_result", "run-finished", "run_completed"].includes(String(event.type))) {
      if (String(event.finishReason ?? "") === "error") continue;
      const eventRun = object(event.run);
      const result = event.type === "run_result"
        ? event
        : object(event.result) ?? object(event.run_result) ?? (eventRun ? object(eventRun.resultSummary) : undefined);
      if (!result) continue;
      const text = textFrom(result);
      if (!text) continue;

      finalResult = {
        text,
        model: modelFrom(result) ?? modelFrom(event) ?? (eventRun ? modelFrom(eventRun) : undefined),
        usage: object(result.usage) ?? (eventRun ? object(eventRun.usage) : undefined),
        cost: result.cost ?? result.costUsd ?? result.totalCost ?? (eventRun?.cost ?? eventRun?.costUsd ?? eventRun?.totalCost),
        durationMs: typeof result.durationMs === "number" ? result.durationMs : undefined
      };
    } else if (event.type === "agent_event") {
      const inner = object(event.event);
      if (inner && inner.type === "done" && inner.reason === "completed") {
        const text = textFrom(inner) ?? (typeof inner.text === "string" ? inner.text : undefined);
        if (text && !finalResult) {
          finalResult = {
            text,
            model: modelFrom(inner) ?? modelFrom(event),
            usage: object(inner.usage) ?? object(event.usage),
            cost: inner.cost ?? inner.costUsd ?? inner.totalCost ?? event.cost ?? event.costUsd ?? event.totalCost,
            durationMs: typeof inner.durationMs === "number" ? inner.durationMs : typeof event.durationMs === "number" ? event.durationMs : undefined
          };
        }
      }
    }
  }

  if (hasMalformed && !finalResult) {
    throw new JsonlParseError("Cline emitted malformed JSONL output.");
  }
  if (!finalResult) {
    throw new JsonlParseError("Cline did not emit a final run_result.");
  }
  return finalResult;
}
