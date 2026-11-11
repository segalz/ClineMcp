import { createHash } from "node:crypto";
import { redactSecrets } from "./runner.js";

export type GuardVerdictKind = "loop_detected" | "budget_exceeded";

export interface GuardOptions {
  maxRepeatedFailures?: number;
  window?: number;
  maxToolCalls?: number;
  maxInputTokens?: number;
}

export interface GuardReport {
  kind?: GuardVerdictKind;
  tool?: string;
  target?: string;
  count?: number;
  window: number;
  lastErrors: string[];
  lastErrorTexts?: string[];
  totalToolCalls: number;
  toolCalls?: number;
  totalInputTokens: number;
  inputTokens?: number;
  filesTouched: string[];
  files?: string[];
  lastAssistantText?: string;
}

export type GuardVerdict = GuardReport & { kind: GuardVerdictKind };

export interface Guard {
  observe(event: Record<string, any>): GuardVerdict | null;
  snapshot(): GuardReport;
}

function isObject(val: unknown): val is Record<string, any> {
  return val !== null && typeof val === "object" && !Array.isArray(val);
}

export function normalizePath(p: string): string {
  let s = p.trim().replace(/\\/g, "/");
  s = s.replace(/^\.\//, "");
  s = s.replace(/\/+/g, "/");
  return s.toLowerCase();
}

export function isPathLike(val: string): boolean {
  const trimmed = val.trim();
  if (trimmed.length === 0 || trimmed.length > 1024) return false;
  if (trimmed.includes("\n") || trimmed.includes("\r")) return false;
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(trimmed)) return false;
  if (trimmed.includes("/") || trimmed.includes("\\")) return true;
  if (!/\s/.test(trimmed) && /\.[a-zA-Z0-9]{1,8}$/.test(trimmed)) return true;
  if (/^\.[a-zA-Z0-9_\-]+$/.test(trimmed)) return true;
  return false;
}

export function stableJson(val: unknown): string {
  if (val === null || typeof val !== "object") {
    return JSON.stringify(val);
  }
  if (Array.isArray(val)) {
    return "[" + val.map(stableJson).join(",") + "]";
  }
  const obj = val as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return "{" + keys.map(k => JSON.stringify(k) + ":" + stableJson(obj[k])).join(",") + "}";
}

export function hashInput(input: unknown): string {
  const json = stableJson(input ?? {});
  return createHash("sha256").update(json).digest("hex").slice(0, 12);
}

export function extractPatchPaths(text: string): string[] {
  if (typeof text !== "string" || !text.includes("***")) return [];
  const paths: string[] = [];
  const lines = text.split(/\r?\n/);
  for (const line of lines) {
    const match = line.match(/^\*{3}\s*(?:Update|Add|Delete)\s*File:\s*(.+)$/i);
    if (match && match[1]) {
      const p = match[1].trim();
      if (p) {
        const norm = normalizePath(p);
        if (!paths.includes(norm)) {
          paths.push(norm);
        }
      }
    }
  }
  return paths;
}

export function normalizeCommand(cmd: string): string {
  return cmd.trim().toLowerCase().replace(/\s+/g, " ");
}

export function extractTarget(toolName: string, input: unknown): { target: string; isPath: boolean } {
  const normTool = toolName.toLowerCase().trim();

  // 1. Check for patch grammar in input (apply_patch tool or any input with canonical patch headers)
  if (isObject(input)) {
    if (typeof input.input === "string") {
      const patchPaths = extractPatchPaths(input.input);
      if (patchPaths.length > 0) {
        return { target: patchPaths.sort().join(","), isPath: true };
      }
    }
    if (typeof input.patch === "string") {
      const patchPaths = extractPatchPaths(input.patch);
      if (patchPaths.length > 0) {
        return { target: patchPaths.sort().join(","), isPath: true };
      }
    }
  } else if (typeof input === "string") {
    const patchPaths = extractPatchPaths(input);
    if (patchPaths.length > 0) {
      return { target: patchPaths.sort().join(","), isPath: true };
    }
  }

  // 2. Command tools: run_commands, bash, execute_command
  if (normTool === "run_commands" || normTool === "bash" || normTool === "execute_command") {
    if (isObject(input)) {
      if (typeof input.command === "string" && input.command.trim().length > 0) {
        return { target: normalizeCommand(input.command), isPath: false };
      }
      if (Array.isArray(input.commands) && input.commands.length > 0 && typeof input.commands[0] === "string" && input.commands[0].trim().length > 0) {
        return { target: normalizeCommand(input.commands[0]), isPath: false };
      }
    } else if (typeof input === "string" && input.trim().length > 0) {
      return { target: normalizeCommand(input), isPath: false };
    }
  }

  // 3. Normal path extraction
  if (isObject(input)) {
    for (const key of ["path", "file_path", "filePath", "target_file", "file"]) {
      const val = input[key];
      if (typeof val === "string" && val.trim().length > 0) {
        return { target: normalizePath(val), isPath: true };
      }
    }
    if (Array.isArray(input.files) && input.files.length > 0) {
      const first = input.files[0];
      if (typeof first === "string" && first.trim().length > 0) {
        return { target: normalizePath(first), isPath: true };
      }
      if (isObject(first)) {
        for (const key of ["path", "file_path", "filePath", "target_file", "file"]) {
          const val = first[key];
          if (typeof val === "string" && val.trim().length > 0) {
            return { target: normalizePath(val), isPath: true };
          }
        }
      }
    }
    if (Array.isArray(input.paths) && input.paths.length > 0) {
      const first = input.paths[0];
      if (typeof first === "string" && first.trim().length > 0) {
        return { target: normalizePath(first), isPath: true };
      }
    }
    for (const val of Object.values(input)) {
      if (typeof val === "string" && isPathLike(val)) {
        return { target: normalizePath(val), isPath: true };
      }
    }
  } else if (typeof input === "string") {
    if (isPathLike(input)) {
      return { target: normalizePath(input), isPath: true };
    }
  }

  return { target: hashInput(input), isPath: false };
}

const WRITE_EDIT_TOOL_NAMES = new Set([
  "replace_in_file",
  "write_to_file",
  "edit",
  "new_file",
  "write_file",
  "edit_file",
  "apply_diff",
  "apply_patch",
  "create_file",
  "append_file",
  "save_file",
  "patch_file"
]);

export function isWriteEditTool(toolName: string): boolean {
  const name = toolName.toLowerCase().trim();
  if (WRITE_EDIT_TOOL_NAMES.has(name)) return true;
  if ((name.includes("write") || name.includes("edit") || name.includes("patch")) && !name.includes("read")) {
    return true;
  }
  return false;
}

export function checkToolFailure(e: Record<string, any>): { failed: boolean; errorText?: string; failingCommand?: string } {
  // Check run_commands array output: array of { query, result, error, success }
  let outputArray: any[] | undefined;
  if (Array.isArray(e.output)) {
    outputArray = e.output;
  } else if (typeof e.output === "string" && e.output.trim().startsWith("[")) {
    try {
      const parsed = JSON.parse(e.output.trim());
      if (Array.isArray(parsed)) outputArray = parsed;
    } catch {}
  }

  if (outputArray) {
    for (const item of outputArray) {
      if (isObject(item)) {
        const isError = item.success === false || item.ok === false ||
          (typeof item.error === "string" && item.error.trim().length > 0) ||
          item.is_error === true || item.isError === true;
        if (isError) {
          const errorText = typeof item.error === "string" && item.error.trim().length > 0
            ? item.error.trim()
            : (typeof item.result === "string" && item.result.trim().length > 0 ? item.result.trim() : "Command execution failed");
          const failingCommand = typeof item.query === "string" && item.query.trim().length > 0
            ? normalizeCommand(item.query)
            : undefined;
          return { failed: true, errorText, failingCommand };
        }
      }
    }
    if (outputArray.length > 0) {
      return { failed: false };
    }
  }

  if (e.error !== undefined && e.error !== null) {
    if (typeof e.error === "string") {
      const trimmed = e.error.trim();
      if (trimmed.length > 0) {
        return { failed: true, errorText: trimmed };
      }
    } else if (typeof e.error === "object") {
      const errObj = e.error as Record<string, any>;
      const msg = typeof errObj.message === "string" ? errObj.message :
                  typeof errObj.error === "string" ? errObj.error :
                  JSON.stringify(errObj);
      if (msg && msg !== "{}") {
        return { failed: true, errorText: msg };
      }
    } else if (e.error === true) {
      return { failed: true, errorText: "Tool execution failed" };
    }
  }

  if (e.is_error === true || e.isError === true) {
    const text = typeof e.output === "string" ? e.output :
                 typeof e.error === "string" ? e.error :
                 "Tool execution failed";
    return { failed: true, errorText: text };
  }

  if (e.output !== undefined && e.output !== null) {
    if (isObject(e.output)) {
      const out = e.output;
      if (out.success === false || out.ok === false || out.is_error === true || out.isError === true) {
        const msg = typeof out.error === "string" ? out.error :
                    typeof out.message === "string" ? out.message :
                    typeof out.reason === "string" ? out.reason :
                    JSON.stringify(out);
        return { failed: true, errorText: msg };
      }
      if (typeof out.error === "string" && out.error.trim().length > 0) {
        return { failed: true, errorText: out.error.trim() };
      }
    } else if (typeof e.output === "string") {
      const trimmed = e.output.trim();
      if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
        try {
          const parsed = JSON.parse(trimmed);
          if (isObject(parsed)) {
            if (parsed.success === false || parsed.ok === false || parsed.is_error === true || parsed.isError === true) {
              const msg = typeof parsed.error === "string" ? parsed.error :
                          typeof parsed.message === "string" ? parsed.message :
                          typeof parsed.reason === "string" ? parsed.reason :
                          trimmed;
              return { failed: true, errorText: msg };
            }
            if (typeof parsed.error === "string" && parsed.error.trim().length > 0) {
              return { failed: true, errorText: parsed.error.trim() };
            }
          }
        } catch {}
      }
    }
  }

  return { failed: false };
}

export function isUsageEvent(event: Record<string, any>): boolean {
  if (!event || typeof event !== "object") return false;
  if (event.type === "usage") return true;
  if (event.type === "agent_event" && isObject(event.event) && event.event.type === "usage") return true;
  return false;
}

export function isCumulativeTokenEvent(event: Record<string, any>): boolean {
  if (!event || typeof event !== "object") return false;
  const t = event.type;
  if (t === "done" || t === "run_result" || t === "run-finished" || t === "run_completed") return true;
  if (event.type === "agent_event" && isObject(event.event)) {
    const et = event.event.type;
    if (et === "done" || et === "run_result" || et === "run-finished" || et === "run_completed") return true;
  }
  return false;
}

export function extractInputTokens(event: Record<string, any>): number | undefined {
  if (!event || typeof event !== "object") return undefined;
  const inner = (event.type === "agent_event" && isObject(event.event)) ? event.event : undefined;
  const obj = inner ?? event;

  const u = isObject(obj.usage) ? obj.usage : (isObject(event.usage) ? event.usage : undefined);
  if (u) {
    const val = u.inputTokens ?? u.input_tokens ?? u.promptTokens ?? u.prompt_tokens;
    if (typeof val === "number" && Number.isFinite(val) && val > 0) return val;
  }

  const direct = obj.inputTokens ?? obj.input_tokens ?? event.inputTokens ?? event.input_tokens;
  if (typeof direct === "number" && Number.isFinite(direct) && direct > 0) return direct;

  return undefined;
}

export function extractTotalInputTokens(event: Record<string, any>): number | undefined {
  if (!event || typeof event !== "object") return undefined;
  const inner = (event.type === "agent_event" && isObject(event.event)) ? event.event : undefined;
  const obj = inner ?? event;

  const u = isObject(obj.usage) ? obj.usage : (isObject(event.usage) ? event.usage : undefined);
  if (u) {
    const val = u.totalInputTokens ?? u.total_input_tokens;
    if (typeof val === "number" && Number.isFinite(val) && val > 0) return val;
  }

  const direct = obj.totalInputTokens ?? obj.total_input_tokens ?? event.totalInputTokens ?? event.total_input_tokens;
  if (typeof direct === "number" && Number.isFinite(direct) && direct > 0) return direct;

  return undefined;
}

function validatePositiveInteger(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new Error(`Guard option '${name}' must be a positive integer, got ${value}`);
  }
  return value;
}

function formatAndRedactError(rawError: string | undefined): string {
  if (!rawError) return "Tool execution failed";
  const redacted = redactSecrets(rawError);
  return redacted.length > 300 ? redacted.slice(0, 300) : redacted;
}

interface InFlightToolCall {
  toolName: string;
  target: string;
  isPath: boolean;
  signature: string;
  toolCallId?: string;
  counted: boolean;
}

interface WindowItem {
  failed: boolean;
  signature?: string;
  errorText?: string;
}

export function createGuard(options?: GuardOptions): Guard {
  const maxRepeatedFailures = validatePositiveInteger(options?.maxRepeatedFailures ?? 3, "maxRepeatedFailures");
  const windowSize = validatePositiveInteger(options?.window ?? 10, "window");
  const maxToolCalls = validatePositiveInteger(options?.maxToolCalls ?? 150, "maxToolCalls");
  const maxInputTokens = validatePositiveInteger(options?.maxInputTokens ?? 1_500_000, "maxInputTokens");

  if (windowSize < maxRepeatedFailures) {
    throw new Error(`Guard option 'window' (${windowSize}) must be >= 'maxRepeatedFailures' (${maxRepeatedFailures})`);
  }

  let totalToolCalls = 0;
  let incrementalTokens = 0;
  let cumulativeTokens = 0;
  let totalInputTokens = 0;
  let lastAssistantText: string | undefined;

  const filesTouched: string[] = [];
  const windowBuffer: WindowItem[] = [];
  const allErrors: string[] = [];
  const signatureErrors = new Map<string, string[]>();

  const pendingById = new Map<string, InFlightToolCall>();
  const pendingQueue: InFlightToolCall[] = [];

  let trippedVerdict: GuardVerdict | null = null;

  function buildReport(data: {
    kind?: GuardVerdictKind;
    tool?: string;
    target?: string;
    count?: number;
    window: number;
    lastErrors: string[];
    totalToolCalls: number;
    totalInputTokens: number;
    filesTouched: string[];
    lastAssistantText?: string;
  }): GuardReport {
    const report: GuardReport = {
      ...(data.kind !== undefined ? { kind: data.kind } : {}),
      ...(data.tool !== undefined ? { tool: redactSecrets(data.tool) } : {}),
      ...(data.target !== undefined ? { target: redactSecrets(data.target) } : {}),
      ...(data.count !== undefined ? { count: data.count } : {}),
      window: data.window,
      lastErrors: data.lastErrors.map(e => redactSecrets(e)),
      totalToolCalls: data.totalToolCalls,
      totalInputTokens: data.totalInputTokens,
      filesTouched: data.filesTouched.map(p => redactSecrets(p)),
      ...(data.lastAssistantText !== undefined ? { lastAssistantText: redactSecrets(data.lastAssistantText).slice(-400) } : {})
    };
    Object.defineProperty(report, "lastErrorTexts", {
      get() { return this.lastErrors; },
      enumerable: false,
      configurable: true
    });
    Object.defineProperty(report, "toolCalls", {
      get() { return this.totalToolCalls; },
      enumerable: false,
      configurable: true
    });
    Object.defineProperty(report, "inputTokens", {
      get() { return this.totalInputTokens; },
      enumerable: false,
      configurable: true
    });
    Object.defineProperty(report, "files", {
      get() { return this.filesTouched; },
      enumerable: false,
      configurable: true
    });
    return report;
  }

  function trip(
    kind: GuardVerdictKind,
    tool?: string,
    target?: string,
    count?: number,
    errors?: string[]
  ): GuardVerdict | null {
    if (trippedVerdict !== null) return null;
    const reportErrors = errors ?? (allErrors.slice(-3));
    trippedVerdict = buildReport({
      kind,
      tool,
      target,
      count,
      window: windowSize,
      lastErrors: reportErrors,
      totalToolCalls,
      totalInputTokens,
      filesTouched,
      lastAssistantText
    }) as GuardVerdict;
    return trippedVerdict;
  }

  function observe(event: Record<string, any>): GuardVerdict | null {
    if (trippedVerdict !== null) return null;
    if (!event || typeof event !== "object") return null;

    // 0. Capture assistant text excerpt
    const inner = (event.type === "agent_event" && isObject(event.event)) ? event.event : event;
    if (isObject(inner)) {
      if ((inner.contentType === "text" || inner.contentType === undefined) &&
          typeof inner.accumulated === "string" && inner.accumulated.trim()) {
        lastAssistantText = inner.accumulated.trim();
      } else if (inner.contentType === "text" && typeof inner.text === "string" && inner.text.trim()) {
        lastAssistantText = inner.text.trim();
      } else if (inner.type === "text" && typeof inner.text === "string" && inner.text.trim()) {
        lastAssistantText = inner.text.trim();
      } else if (typeof inner.text === "string" && inner.text.trim()) {
        lastAssistantText = inner.text.trim();
      } else if (typeof inner.content === "string" && inner.content.trim()) {
        lastAssistantText = inner.content.trim();
      }
    }

    // 1. Process usage tokens (usage events are incremental; done and run_result are cumulative)
    if (isUsageEvent(event)) {
      const inc = extractInputTokens(event);
      if (inc !== undefined && inc > 0) {
        incrementalTokens += inc;
      }
      const tot = extractTotalInputTokens(event);
      if (tot !== undefined && tot > 0) {
        cumulativeTokens = Math.max(cumulativeTokens, tot);
      }
      totalInputTokens = Math.max(incrementalTokens, cumulativeTokens);
      if (totalInputTokens > maxInputTokens) {
        return trip("budget_exceeded", undefined, undefined, undefined, allErrors.slice(-3));
      }
    } else if (isCumulativeTokenEvent(event)) {
      const cum = extractInputTokens(event);
      if (cum !== undefined && cum > 0) {
        cumulativeTokens = Math.max(cumulativeTokens, cum);
      }
      totalInputTokens = Math.max(incrementalTokens, cumulativeTokens);
      if (totalInputTokens > maxInputTokens) {
        return trip("budget_exceeded", undefined, undefined, undefined, allErrors.slice(-3));
      }
    } else {
      const tokens = extractInputTokens(event);
      if (tokens !== undefined && tokens > 0) {
        const tot = extractTotalInputTokens(event);
        if (tot !== undefined && tot > 0) {
          cumulativeTokens = Math.max(cumulativeTokens, tot);
        } else {
          incrementalTokens += tokens;
        }
        totalInputTokens = Math.max(incrementalTokens, cumulativeTokens);
        if (totalInputTokens > maxInputTokens) {
          return trip("budget_exceeded", undefined, undefined, undefined, allErrors.slice(-3));
        }
      }
    }

    // 2. Process tool calls
    if (!isObject(inner)) return null;

    if (inner.type === "content_start" && inner.contentType === "tool") {
      const toolName = typeof inner.toolName === "string" ? inner.toolName : "tool";
      const toolCallId = typeof inner.toolCallId === "string" ? inner.toolCallId :
                         typeof inner.id === "string" ? inner.id : undefined;
      const { target, isPath } = extractTarget(toolName, inner.input);
      const signature = `${toolName.toLowerCase().trim()}:${target}`;

      totalToolCalls++;
      if (totalToolCalls > maxToolCalls) {
        return trip("budget_exceeded", toolName, target, undefined, allErrors.slice(-3));
      }

      const inFlight: InFlightToolCall = {
        toolName,
        target,
        isPath,
        signature,
        toolCallId,
        counted: true
      };
      if (toolCallId) {
        pendingById.set(toolCallId, inFlight);
      }
      pendingQueue.push(inFlight);
      return null;
    }

    if (inner.type === "content_end" && inner.contentType === "tool") {
      let inFlight: InFlightToolCall | undefined;
      const toolCallId = typeof inner.toolCallId === "string" ? inner.toolCallId :
                         typeof inner.id === "string" ? inner.id : undefined;

      if (toolCallId && pendingById.has(toolCallId)) {
        inFlight = pendingById.get(toolCallId);
        pendingById.delete(toolCallId);
        const idx = pendingQueue.indexOf(inFlight!);
        if (idx >= 0) pendingQueue.splice(idx, 1);
      } else if (pendingQueue.length > 0) {
        const matchIdx = pendingQueue.findIndex(item => !inner.toolName || item.toolName === inner.toolName);
        if (matchIdx >= 0) {
          inFlight = pendingQueue.splice(matchIdx, 1)[0];
          if (inFlight.toolCallId) pendingById.delete(inFlight.toolCallId);
        } else {
          inFlight = pendingQueue.shift();
          if (inFlight?.toolCallId) pendingById.delete(inFlight.toolCallId);
        }
      }

      if (!inFlight) {
        const toolName = typeof inner.toolName === "string" ? inner.toolName : "tool";
        const { target, isPath } = extractTarget(toolName, inner.input);
        const signature = `${toolName.toLowerCase().trim()}:${target}`;
        totalToolCalls++;
        if (totalToolCalls > maxToolCalls) {
          return trip("budget_exceeded", toolName, target, undefined, allErrors.slice(-3));
        }
        inFlight = { toolName, target, isPath, signature, counted: true };
      }

      let { toolName, target, isPath, signature } = inFlight;
      const failure = checkToolFailure(inner);

      if (failure.failed) {
        if (failure.failingCommand) {
          target = failure.failingCommand;
          signature = `${toolName.toLowerCase().trim()}:${target}`;
        }
        const redactedError = formatAndRedactError(failure.errorText);
        allErrors.push(redactedError);
        let sigErrors = signatureErrors.get(signature);
        if (!sigErrors) {
          sigErrors = [];
          signatureErrors.set(signature, sigErrors);
        }
        sigErrors.push(redactedError);

        windowBuffer.push({ failed: true, signature, errorText: redactedError });
        if (windowBuffer.length > windowSize) {
          windowBuffer.shift();
        }

        let failureCount = 0;
        for (const item of windowBuffer) {
          if (item.failed && item.signature === signature) {
            failureCount++;
          }
        }

        if (failureCount >= maxRepeatedFailures) {
          const last3 = sigErrors.slice(-3);
          return trip("loop_detected", toolName, target, failureCount, last3);
        }
      } else {
        windowBuffer.push({ failed: false });
        if (windowBuffer.length > windowSize) {
          windowBuffer.shift();
        }

        if (isPath && isWriteEditTool(toolName)) {
          const targets = target.includes(",") ? target.split(",") : [target];
          for (const t of targets) {
            if (!filesTouched.includes(t)) {
              filesTouched.push(t);
            }
          }
        }
      }

      return null;
    }

    return null;
  }

  function snapshot(): GuardReport {
    if (trippedVerdict !== null) {
      return buildReport(trippedVerdict);
    }
    return buildReport({
      kind: undefined,
      tool: undefined,
      target: undefined,
      count: undefined,
      window: windowSize,
      lastErrors: allErrors.slice(-3),
      totalToolCalls,
      totalInputTokens,
      filesTouched,
      lastAssistantText
    });
  }

  return { observe, snapshot };
}

export function buildGuardTripMessage(verdict: GuardVerdict, options?: GuardOptions): string {
  let msg: string;
  if (verdict.kind === "loop_detected") {
    const count = verdict.count ?? 3;
    const window = verdict.window ?? 10;
    const target = redactSecrets(verdict.target ?? "target");
    const tool = redactSecrets(verdict.tool ?? "tool");
    const action = isWriteEditTool(tool) ? "edits" : `${tool} calls`;
    msg = `Stopped by the bridge: ${count} failed ${action} on ${target} within ${window} tool calls`;
  } else if (verdict.totalToolCalls > (options?.maxToolCalls ?? 150)) {
    msg = `Stopped by the bridge: tool-call budget exceeded (${verdict.totalToolCalls} > ${options?.maxToolCalls ?? 150} tool calls)`;
  } else if (verdict.totalInputTokens > (options?.maxInputTokens ?? 1_500_000)) {
    msg = `Stopped by the bridge: input-token budget exceeded (${verdict.totalInputTokens} > ${options?.maxInputTokens ?? 1_500_000} tokens)`;
  } else {
    msg = "Stopped by the bridge: budget exceeded";
  }
  return redactSecrets(msg);
}

export function formatReportSummary(report?: GuardReport, errorMessage?: string): string {
  if (report) {
    if (report.kind === "loop_detected") {
      const count = report.count ?? 3;
      const window = report.window ?? 10;
      const target = redactSecrets(report.target ?? "target");
      const tool = redactSecrets(report.tool ?? "tool");
      const action = isWriteEditTool(tool) ? "edits" : `${tool} calls`;
      return redactSecrets(`${count} failed ${action} on ${target} within ${window} tool calls`);
    }
    if (report.kind === "budget_exceeded") {
      if (report.totalToolCalls > 150) {
        return `tool-call budget exceeded (${report.totalToolCalls} calls)`;
      }
      return `input-token budget exceeded (${report.totalInputTokens} tokens)`;
    }
  }
  if (errorMessage) {
    return redactSecrets(errorMessage.replace(/^Stopped by the bridge:\s*/i, "").replace(/\.\s*$/, ""));
  }
  return "loop or budget exceeded";
}

