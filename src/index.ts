import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { askCline, ClineRunError, formatErrorAsText, guardOptionsSchema } from "./runner.js";
import { applyClineEdits, editFailurePayload } from "./edits.js";
import { sweepOldSnapshots } from "./snapshot.js";
import { askClineWorkspace } from "./workspace.js";
import { clinePing } from "./ping.js";
import { listFreeModels, writeCatalogSnapshot } from "./models.js";
import { cleanupTraces } from "./trace.js";
import { shutdownJobObjects } from "./jobobject.js";
import { TaskManager, MAX_TASK_TIMEOUT_SECONDS, MAX_WAIT_SECONDS } from "./tasks.js";
import { startTaskObjectSchema, startTaskSchema, verificationSchema, maxFixRunsSchema, editActionSchema } from "./finalcheck.js";
import { PROHIBITED_NAMES, resolveProviderSettingsPath, recoverProviderSettingsJournal } from "./settings.js";
import { withProgressHeartbeat } from "./progress.js";
import {
  attachCliToObject,
  attachCliToText,
  beginCliCall,
  mutateStateFile,
  notifyCliStateShutdown,
  onToolCall,
  readStateFile,
  resolveStatePath,
  waitForActiveCliUpdate
} from "./clistate.js";

const server = new McpServer({ name: "cline-local-bridge", version: "1.0.0" });

async function beforeToolCall(): Promise<void> {
  // Hold a call while the hook runs, so the hook itself never starts a CLI install; release one tick later,
  // after a Cline-running handler has taken its own hold in track() / cline_start / cline_send.
  const endHookCall = beginCliCall();
  try {
    await onToolCall().catch(() => {});
  } finally {
    setImmediate(endHookCall);
  }
}

async function replyJson(
  payload: Record<string, unknown>,
  options?: { alwaysIncludeCli?: boolean; isError?: boolean }
) {
  const state = await readStateFile().catch(() => undefined);
  const body = attachCliToObject(payload, state, { always: options?.alwaysIncludeCli });
  return {
    content: [{ type: "text" as const, text: JSON.stringify(body, null, 2) }],
    ...(options?.isError ? { isError: true } : {})
  };
}

async function replyErrorText(error: unknown, fallback: string) {
  const state = await readStateFile().catch(() => undefined);
  const message = attachCliToText(formatErrorAsText(error, fallback), state);
  return {
    content: [{ type: "text" as const, text: message }],
    isError: true
  };
}

/**
 * Synchronous tool calls in flight. On shutdown each is aborted (killing its Cline process tree) and awaited,
 * so the worktree and the settings journal are cleaned up before the bridge exits.
 */
const activeCalls = new Set<{ controller: AbortController; done: Promise<unknown> }>();
let shuttingDown = false;
function track<T>(clientSignal: AbortSignal, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
  if (shuttingDown) {
    return Promise.reject(new ClineRunError("cancelled", "The bridge is shutting down; no new Cline runs start.", { attempts: 0 }));
  }
  // Hold a call for the whole preparation + run so no CLI update starts in between; released in finally.
  const endCliCall = beginCliCall();
  const controller = new AbortController();
  const onClientAbort = () => controller.abort();
  if (clientSignal.aborted) controller.abort(); else clientSignal.addEventListener("abort", onClientAbort, { once: true });
  // A call that arrives mid-install waits for it instead of failing on the settings lock.
  const done = waitForActiveCliUpdate().then(() => work(controller.signal));
  const entry = { controller, done };
  activeCalls.add(entry);
  return done.finally(() => { activeCalls.delete(entry); clientSignal.removeEventListener("abort", onClientAbort); endCliCall(); });
}

// Required on every tool: the bridge never runs on Cline's saved default selection.
const providerModelSchema = z
  .string()
  .regex(/^[A-Za-z0-9._:/@-]{1,120}$/)
  .refine((val) => !PROHIBITED_NAMES.has(val.toLowerCase()), {
    message: "Prohibited provider or model name"
  })
  .describe("Required. Provider \"cline\" with a model id from cline_list_models (free models), or another configured provider/model.");

export { formatErrorAsText, guardOptionsSchema };

server.registerTool(
  "ask_cline",
  {
    description: "Ask the locally installed Cline CLI for an analysis/chat answer from the text you send. Cline has NO tools " +
      "here (it cannot read files, list directories or run commands); put the code or text in the prompt. To let Cline " +
      "read a repository use ask_cline_workspace; to have it change files use apply_cline_edits.",
    inputSchema: {
      prompt: z.string().min(1).max(20_000),
      cwd: z.string().min(1).optional(),
      thinking: z.enum(["none", "low", "medium", "high", "xhigh"]).optional(),
      timeoutSeconds: z.number().int().min(1).max(300).optional(),
      systemPrompt: z.string().min(1).max(8_000).optional(),
      provider: providerModelSchema,
      model: providerModelSchema
    }
  },
  // The heartbeat covers the whole call, preflight (catalog sync) included.
  async (input, extra) => withProgressHeartbeat(extra, async () => {
    await beforeToolCall();
    try {
      const result = await track(extra.signal, signal => askCline(input, signal, { trace: true }));
      const response = {
        text: result.text,
        ...(result.model ? { model: result.model } : {}),
        durationMs: result.durationMs,
        ...(result.guard ? { guard: result.guard } : {}),
        ...(result.codeMapSource ? { codeMapSource: result.codeMapSource } : {}),
        ...(result.usage ? { usage: result.usage } : {}),
        ...(result.cost !== undefined ? { cost: result.cost } : {}),
        ...(result.warnings && result.warnings.length > 0 ? { warnings: result.warnings } : {}),
        ...(result.trace ? { trace: result.trace } : {})
      };
      return await replyJson(response);
    } catch (error) {
      return await replyErrorText(error, "The local Cline bridge failed unexpectedly.");
    }
  })
);

server.registerTool(
  "apply_cline_edits",
  {
    description: "Have Cline implement a development task directly in the current Git checkout. Files may change, but commits are forbidden and the resulting diff is returned. " +
      "verify is required: a shell-free command or explicit {none:true, reason}. Up to maxFixRuns automatic repairs (0-3, default 2) share cumulative guard and active-time budgets. " +
      "Failure restores the original dirty baseline unless keepOnFailure; HEAD/index changes refuse restoration and retain a recovery snapshot. " +
      "The bridge stops on repeated failures or budget. codeMap defaults to true. " +
      "verify is checked before the run (a missing command is refused at once, with no model use) and runs in the requested cwd " +
      "(e.g. a monorepo package), not the repository root. A passing check is final: nothing after it restores the edit. " +
      "If a stopped process may still be running, no repair runs, nothing is restored automatically, and the recovery snapshot is kept (evidence.snapshotDirectory). " +
      "Edits share machine-wide FIFO slots. If waiting leaves too little time for a run and check, the call returns machine_busy. " +
      "The check's timeout plus 10 s is reserved from timeoutSeconds; if less than 60 s would be left for Cline, the call is refused before the model starts. " +
      "With an MCP progressToken the call sends notifications/progress every 15 s. " +
      "For model-picker log_run pass the returned usage as tokens and write=true.",
    inputSchema: {
      prompt: z.string().min(1).max(20_000),
      cwd: z.string().min(1),
      thinking: z.enum(["none", "low", "medium", "high", "xhigh"]).optional(),
      timeoutSeconds: z.number().int().min(1).max(300).optional(),
      provider: providerModelSchema,
      model: providerModelSchema,
      codeMap: z.boolean().optional().describe("Include a bounded code map before the prompt (default true)."),
      guard: guardOptionsSchema.optional(),
      verify: verificationSchema,
      maxFixRuns: maxFixRunsSchema.optional(),
      keepOnFailure: z.boolean().optional()
    }
  },
  async (input, extra) => withProgressHeartbeat(extra, async (onHeavyQueue) => {
    await beforeToolCall();
    try {
      const { guard, ...rest } = input;
      const result = await track(extra.signal, signal => applyClineEdits(rest, signal, { trace: true, onHeavyQueue, ...(guard ? { guard } : {}) }));
      return await replyJson({
        text: result.text,
        ...(result.model ? { model: result.model } : {}),
        durationMs: result.durationMs,
        ...(result.guard ? { guard: result.guard } : {}),
        ...(result.codeMapSource ? { codeMapSource: result.codeMapSource } : {}),
        ...(result.usage ? { usage: result.usage } : {}),
        ...(result.cost !== undefined ? { cost: result.cost } : {}),
        gitDiff: result.gitDiff,
        status: result.status,
        headBefore: result.headBefore,
        ...(result.headAfter !== undefined ? { headAfter: result.headAfter } : {}),
        commitWasReverted: result.commitWasReverted,
        verification: result.verification,
        ...(result.warnings && result.warnings.length > 0 ? { warnings: result.warnings } : {}),
        ...(result.trace ? { trace: result.trace } : {})
      });
    } catch (error) {
      return await replyJson(editFailurePayload(error), { isError: true });
    }
  })
);

server.registerTool(
  "ask_cline_workspace",
  {
    description: "Analyze a Git workspace through Cline in a disposable worktree. The worktree is always removed after the request. " +
      "The bridge automatically stops a run on repeated failures or budget. codeMap defaults to true; set false to omit the generated code map. " +
      "Cline sees committed HEAD only (uncommitted work is not in the worktree); a cwd inside the repository runs in the same " +
      "subfolder of the worktree. A quota-locked model is refused before any worktree is created. " +
      "With an MCP progressToken the call sends notifications/progress every 15 s.",
    inputSchema: {
      prompt: z.string().min(1).max(20_000),
      cwd: z.string().min(1),
      thinking: z.enum(["none", "low", "medium", "high", "xhigh"]).optional(),
      timeoutSeconds: z.number().int().min(1).max(300).optional(),
      provider: providerModelSchema,
      model: providerModelSchema,
      codeMap: z.boolean().optional().describe("Include a bounded code map before the prompt (default true)."),
      guard: guardOptionsSchema.optional()
    }
  },
  async (input, extra) => withProgressHeartbeat(extra, async () => {
    await beforeToolCall();
    try {
      const { guard, ...rest } = input;
      const result = await track(extra.signal, signal => askClineWorkspace(rest, signal, { trace: true, ...(guard ? { guard } : {}) }));
      return await replyJson({
        text: result.text,
        ...(result.model ? { model: result.model } : {}),
        durationMs: result.durationMs,
        ...(result.guard ? { guard: result.guard } : {}),
        ...(result.codeMapSource ? { codeMapSource: result.codeMapSource } : {}),
        ...(result.usage ? { usage: result.usage } : {}),
        ...(result.cost !== undefined ? { cost: result.cost } : {}),
        ...(result.warnings && result.warnings.length > 0 ? { warnings: result.warnings } : {}),
        ...(result.trace ? { trace: result.trace } : {})
      });
    } catch (error) {
      return await replyErrorText(error, "The isolated Cline workspace review failed unexpectedly.");
    }
  })
);

server.registerTool(
  "cline_ping",
  {
    description: "Check whether the configured Cline provider/model can answer right now with a one-word, single-attempt request. " +
      "Returns available, rate_limited, quota_exhausted (with reset time) or unreachable; results are cached per provider+model.",
    inputSchema: {
      provider: providerModelSchema,
      model: providerModelSchema,
      force: z.boolean().optional(),
      timeoutSeconds: z.number().int().min(5).max(60).optional()
    }
  },
  async (input, extra) => {
    await beforeToolCall();
    try {
      const result = await track(extra.signal, signal => clinePing(input, signal));
      return await replyJson({ ...result });
    } catch (error) {
      return await replyErrorText(error, "The Cline ping failed unexpectedly.");
    }
  }
);

server.registerTool(
  "cline_list_models",
  {
    description: "List the models the installed Cline CLI advertises as free right now (provider \"cline\"), read from " +
      "its own catalog, with the bridge's last recorded status per model. Use an id from here as `model` for the other " +
      "tools. The list rotates with Cline releases; check a model with cline_ping before relying on it.",
    inputSchema: {}
  },
  async () => {
    await beforeToolCall();
    try {
      const list = await listFreeModels();
      try {
        await writeCatalogSnapshot(list);
      } catch (err: any) {
        console.error(`Failed to write catalog snapshot: ${(err?.message ?? String(err)).split(/\r?\n/)[0]}`);
      }
      await mutateStateFile(resolveStatePath(), (curr) => {
        if (list.source.cliVersion) curr.cli.version = list.source.cliVersion;
        if (list.source.version) curr.cli.catalog_version = list.source.version;
        return curr;
      }).catch(() => {});
      return await replyJson({ ...list }, { alwaysIncludeCli: true });
    } catch (error) {
      return await replyErrorText(error, "Listing Cline models failed unexpectedly.");
    }
  }
);

try {
  const result = await recoverProviderSettingsJournal(resolveProviderSettingsPath(), { lockTimeoutMs: 10_000 });
  if (result === "failed") console.error("Settings startup recovery failed; the restore journal was retained.");
} catch {
  console.error("Settings startup recovery could not acquire the mutex or access settings; the journal was retained.");
}

// --- Async tasks --------------------------------------------------------------------------------------------

const tasks = new TaskManager({ beginCall: beginCliCall });
const asText = (value: unknown) => replyJson((value && typeof value === "object" ? value : { value }) as Record<string, unknown>);
const asError = (error: unknown, fallback: string) => replyErrorText(error, fallback);

server.registerTool(
  "cline_start",
  {
    description: "Start a Cline task in the background and return its taskId at once. mode \"ask\": answer from the prompt, " +
      "no tools; \"workspace\": read a Git repository in a disposable worktree; \"edits\": change files in the checkout " +
      "(no commits). Then follow it with cline_status, cancel it with cline_cancel, and collect it with " +
      `cline_result. timeoutSeconds up to ${MAX_TASK_TIMEOUT_SECONDS}; at most 2 tasks at once. ` +
      "Edits require verify (shell-free command or explicit none/reason), share one snapshot, and run up to maxFixRuns automatic repairs (0-3, default 2). " +
      "Failures/questions wait with their edits and lock retained; retry performs one repair, restore returns to the original baseline, keep ends unverified. " +
      "Their timeoutSeconds is the overall active-time budget, excluding caller waits; guards accumulate across every launch. " +
      "Ask/workspace have one attempt and no automatic retry. " +
      "The bridge stops a run on repeated failures or budget and waits for guidance via cline_send. " +
      "codeMap defaults to true for workspace/edits, including resumed runs; ignored in ask mode. " +
      "HEAD/index changes refuse restoration and retain recovery evidence. Input is strict and at most 64 KiB. " +
      "Edits: verify is checked before the run (a missing command is refused at once) and runs in the requested cwd, not the repository root. " +
      "A passing check followed by the identity re-read is final: nothing after it restores the edit. " +
      "If a stopped process may still be running, the kill is unconfirmed: nothing is restored automatically, retry is refused (restore or keep), " +
      "and the recovery snapshot is kept. A restore is bounded and reports any file it could not reach. " +
      "cline_result's log_run_hint carries tokens and write=true for edits; pass it to model-picker log_run.",
    inputSchema: startTaskObjectSchema.extend({
      provider: providerModelSchema,
      model: providerModelSchema
    })
  },
  async (rawInput) => {
    await beforeToolCall();
    try {
      const { waitSeconds, ...input } = startTaskSchema.parse(rawInput);
      // The task holds its own call from start() on; this one covers the wait for a running install.
      const endCliCall = beginCliCall();
      let started;
      try {
        await waitForActiveCliUpdate();
        started = tasks.start(input);
      } finally { endCliCall(); }
      return await asText(await tasks.status(started.taskId, waitSeconds ?? 3));
    } catch (error) {
      return await asError(error, "Starting the Cline task failed unexpectedly.");
    }
  }
);

server.registerTool(
  "cline_status",
  {
    description: "Where a Cline task is now: state, current tool, last complete reasoning, files, any question Cline " +
      `asked. Long poll: returns as soon as the task finishes, asks a question (input_required), or after waitSeconds (max ${MAX_WAIT_SECONDS}). ` +
      "Edits include lifecycle phase, verification attempts, fixRuns, restored/kept, waitReason and evidence. " +
      "Run history includes final guard counters on every outcome.",
    inputSchema: {
      taskId: z.string().uuid(),
      waitSeconds: z.number().int().min(0).max(MAX_WAIT_SECONDS).optional().describe("Default 20.")
    }
  },
  async ({ taskId, waitSeconds }) => {
    await beforeToolCall();
    try { return await asText(await tasks.status(taskId, waitSeconds ?? 20)); }
    catch (error) { return await asError(error, "Reading the task status failed unexpectedly."); }
  }
);

server.registerTool(
  "cline_send",
  {
    description: "Answer a waiting Cline task. Edits support retry (default), restore and keep, with optional message as guidance. " +
      "After a stopped process that may still be running, retry is refused: only restore or keep (the recovery snapshot is kept). " +
      "Retry retains partial edits and performs one repair or answers a Cline question without resetting automatic-fix capacity or budgets. " +
      "Restore undoes every edit run back to the original dirty baseline; keep ends unverified. " +
      "Ask/workspace require a message and support retry only.",
    inputSchema: z.object({
      taskId: z.string().uuid(),
      message: z.string().max(20_000).optional(),
      action: editActionSchema.optional(),
      waitSeconds: z.number().int().min(0).max(30).optional().describe("Wait this long for first progress before returning (default 3).")
    }).strict()
  },
  async ({ taskId, message, action, waitSeconds }) => {
    await beforeToolCall();
    const endCliCall = beginCliCall();
    try {
      await waitForActiveCliUpdate();
      await tasks.send(taskId, message, action);
      return await asText(await tasks.status(taskId, waitSeconds ?? 3));
    } catch (error) {
      return await asError(error, "Sending message to the Cline task failed unexpectedly.");
    } finally { endCliCall(); }
  }
);

server.registerTool(
  "cline_cancel",
  {
    description: "Cancel a running or waiting Cline task. Edits abort the active process and await baseline restoration and lock release. " +
      "Identity refusal or incomplete restoration retains recovery evidence. Collect the result afterwards with cline_result.",
    inputSchema: { taskId: z.string().uuid() }
  },
  async ({ taskId }) => {
    await beforeToolCall();
    try { return await asText(await tasks.cancel(taskId)); }
    catch (error) { return await asError(error, "Cancelling the task failed unexpectedly."); }
  }
);

server.registerTool(
  "cline_result",
  {
    description: "Final result of a finished Cline task, or partial result of an input_required task (does not remove the task), " +
      "plus verification evidence and summed edit-run usage. log_run_hint for model-picker carries the run's token counts and is null while waiting, cancelled, or on local failure; " +
      "edits are ok only on success with a passing check or explicit none opt-out. " +
      "Removes the task and its trace unless keepTrace.",
    inputSchema: { taskId: z.string().uuid(), keepTrace: z.boolean().optional() }
  },
  async ({ taskId, keepTrace }) => {
    await beforeToolCall();
    try { return await asText(await tasks.result(taskId, keepTrace ?? false)); }
    catch (error) { return await asError(error, "Reading the task result failed unexpectedly."); }
  }
);

// When the client goes away or the bridge is stopped, no Cline task may keep running.
/**
 * Long enough for an aborted run to finish its cleanup: settings unregister (lock wait up to 30 s), then either
 * worktree removal (two Git steps of 20 s plus folder removal) or the edits post-run Git budget (60 s in total).
 */
const SHUTDOWN_WAIT_MS = 120_000;
const shutdown = async () => {
  if (shuttingDown) return;
  shuttingDown = true;
  notifyCliStateShutdown();
  for (const call of activeCalls) call.controller.abort();
  let timer: NodeJS.Timeout | undefined;
  await Promise.race([
    Promise.allSettled([tasks.shutdown(SHUTDOWN_WAIT_MS), waitForActiveCliUpdate(), ...[...activeCalls].map(c => c.done)]),
    new Promise<void>(resolve => { timer = setTimeout(resolve, SHUTDOWN_WAIT_MS); })
  ]);
  if (timer) clearTimeout(timer);
  shutdownJobObjects();
  process.exit(0);
};
process.stdin.on("end", () => { void shutdown(); });
process.stdin.on("close", () => { void shutdown(); });
process.on("SIGINT", () => { void shutdown(); });
process.on("SIGTERM", () => { void shutdown(); });

// Old finished traces and traces of dead bridge processes; never blocks startup.
void cleanupTraces().catch(() => {});

// Write initial free-model catalog snapshot in background; never blocks startup.
void (async () => {
  try {
    const list = await listFreeModels();
    await writeCatalogSnapshot(list);
  } catch (err: any) {
    console.error(`Failed to write catalog snapshot on startup: ${(err?.message ?? String(err)).split(/\r?\n/)[0]}`);
  }
})();

await server.connect(new StdioServerTransport());
void sweepOldSnapshots().catch(() => {});
