export interface ClineFinalResult {
  text: string;
  model?: string;
  usage?: Record<string, unknown>;
  cost?: unknown;
  durationMs?: number;
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
    if (typeof value[key] === "string" && value[key].trim()) return value[key] as string;
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
 * Extracts only a terminal Cline result. Streamed assistant/reasoning events are
 * deliberately ignored so they can never be returned to an MCP client.
 */
export function parseClineJsonl(jsonl: string): ClineFinalResult {
  let finalResult: ClineFinalResult | undefined;

  for (const rawLine of jsonl.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;

    let event: JsonObject;
    try {
      event = object(JSON.parse(line)) ?? (() => { throw new Error("not an object"); })();
    } catch {
      throw new JsonlParseError("Cline emitted malformed JSONL output.");
    }

    // `run_result` is the Cline CLI terminal event. The aliases make this
    // bridge tolerant of adjacent CLI releases without accepting stream deltas.
    if (!['run_result', 'run-finished', 'run_completed'].includes(String(event.type))) continue;

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
  }

  if (!finalResult) throw new JsonlParseError("Cline did not emit a final run_result.");
  return finalResult;
}
