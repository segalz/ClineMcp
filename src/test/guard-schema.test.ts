import assert from "node:assert/strict";
import test, { after } from "node:test";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { guardOptionsSchema, runCline, ClineRunError, type AskClineInput, type ClineInvocationOptions, type ClineResponse } from "../runner.js";
import { TaskManager } from "../tasks.js";
import type { GuardOptions } from "../guard.js";

const root = await mkdtemp(path.join(os.tmpdir(), "cline-guard-schema-test-"));
process.env.CLINE_MCP_STATUS_PATH = path.join(root, "status.json");
process.env.CLINE_PROVIDER_SETTINGS_PATH = path.join(root, "providers.json");
process.env.CLINE_MCP_CATALOG_PATH = path.join(root, "catalog.json");
process.env.CLINE_MCP_STATE_PATH = path.join(root, "state.json");
process.env.CLINE_MCP_TRACE_DIR = path.join(root, "traces");
after(() => rm(root, { recursive: true, force: true }));

let counter = 0;
const traceBase = () => path.join(root, `traces-${++counter}`);
const sel = { provider: "test-provider", model: "test-model" };

function createMockChild() {
  const child = new EventEmitter() as any;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdout.destroyed = false;
  child.stderr.destroyed = false;
  child.stdout.destroy = () => {
    child.stdout.destroyed = true;
  };
  child.stderr.destroy = () => {
    child.stderr.destroyed = true;
  };
  child.killed = false;
  child.pid = 12345;
  child.kill = (sig?: NodeJS.Signals) => {
    child.killed = true;
    queueMicrotask(() => {
      child.emit("close", null, sig ?? "SIGKILL");
    });
  };
  return child;
}

test("guardOptionsSchema: accepts valid configurations within bounds", () => {
  // All fields valid
  const full = guardOptionsSchema.parse({
    maxRepeatedFailures: 5,
    window: 15,
    maxToolCalls: 200,
    maxInputTokens: 500_000
  });
  assert.equal(full.maxRepeatedFailures, 5);
  assert.equal(full.window, 15);
  assert.equal(full.maxToolCalls, 200);
  assert.equal(full.maxInputTokens, 500_000);

  // Partial configurations
  assert.deepEqual(guardOptionsSchema.parse({}), {});
  assert.equal(guardOptionsSchema.parse({ maxRepeatedFailures: 2 }).maxRepeatedFailures, 2);
  assert.equal(guardOptionsSchema.parse({ window: 5 }).window, 5);
  assert.equal(guardOptionsSchema.parse({ maxToolCalls: 10 }).maxToolCalls, 10);
  assert.equal(guardOptionsSchema.parse({ maxInputTokens: 10_000 }).maxInputTokens, 10_000);

  // Exact boundary values
  assert.deepEqual(guardOptionsSchema.parse({
    maxRepeatedFailures: 2,
    window: 3,
    maxToolCalls: 10,
    maxInputTokens: 10_000
  }), {
    maxRepeatedFailures: 2,
    window: 3,
    maxToolCalls: 10,
    maxInputTokens: 10_000
  });

  assert.deepEqual(guardOptionsSchema.parse({
    maxRepeatedFailures: 20,
    window: 50,
    maxToolCalls: 1000,
    maxInputTokens: 20_000_000
  }), {
    maxRepeatedFailures: 20,
    window: 50,
    maxToolCalls: 1000,
    maxInputTokens: 20_000_000
  });
});

test("guardOptionsSchema: rejects non-integers and non-numbers", () => {
  assert.throws(() => guardOptionsSchema.parse({ maxRepeatedFailures: 2.5 }));
  assert.throws(() => guardOptionsSchema.parse({ window: 10.5 }));
  assert.throws(() => guardOptionsSchema.parse({ maxToolCalls: 50.1 }));
  assert.throws(() => guardOptionsSchema.parse({ maxInputTokens: 15000.9 }));
  assert.throws(() => guardOptionsSchema.parse({ maxRepeatedFailures: "3" as any }));
});

test("guardOptionsSchema: rejects values below minimum bounds", () => {
  assert.throws(() => guardOptionsSchema.parse({ maxRepeatedFailures: 1 }));
  assert.throws(() => guardOptionsSchema.parse({ window: 2 }));
  assert.throws(() => guardOptionsSchema.parse({ maxToolCalls: 9 }));
  assert.throws(() => guardOptionsSchema.parse({ maxInputTokens: 9_999 }));
});

test("guardOptionsSchema: rejects values above maximum bounds", () => {
  assert.throws(() => guardOptionsSchema.parse({ maxRepeatedFailures: 21 }));
  assert.throws(() => guardOptionsSchema.parse({ window: 51 }));
  assert.throws(() => guardOptionsSchema.parse({ maxToolCalls: 1001 }));
  assert.throws(() => guardOptionsSchema.parse({ maxInputTokens: 20_000_001 }));
});

test("guardOptionsSchema: enforces window >= maxRepeatedFailures refinement", () => {
  // Explicit window < maxRepeatedFailures
  assert.throws(
    () => guardOptionsSchema.parse({ maxRepeatedFailures: 5, window: 4 }),
    (e: any) => e.errors?.[0]?.message?.includes("window must be greater than or equal to maxRepeatedFailures")
  );

  // Equal is allowed (window === maxRepeatedFailures)
  assert.doesNotThrow(() => guardOptionsSchema.parse({ maxRepeatedFailures: 5, window: 5 }));

  // Default window (10) violated by high maxRepeatedFailures without explicit window
  assert.throws(
    () => guardOptionsSchema.parse({ maxRepeatedFailures: 15 }),
    (e: any) => e.errors?.[0]?.message?.includes("window must be greater than or equal to maxRepeatedFailures")
  );

  // Default maxRepeatedFailures (3) with explicit window >= 3 is allowed
  assert.doesNotThrow(() => guardOptionsSchema.parse({ window: 3 }));
});

test("pass-through: TaskManager stores guard in task and forwards to runner options and input", async () => {
  let capturedOptions: Partial<ClineInvocationOptions> | undefined;
  let capturedInput: AskClineInput | undefined;

  const mockRunner = async (input: any, signal: AbortSignal, options: Partial<ClineInvocationOptions>) => {
    capturedInput = input;
    capturedOptions = options;
    return {
      text: "Task completed successfully",
      durationMs: 100
    } as ClineResponse & Record<string, unknown>;
  };

  const customGuard: GuardOptions = {
    maxRepeatedFailures: 2,
    window: 5,
    maxToolCalls: 20,
    maxInputTokens: 25_000
  };

  const m = new TaskManager({
    traceBase: traceBase(),
    runners: { ask: mockRunner as any }
  });

  const started = m.start({
    mode: "ask",
    prompt: "Test guard pass-through",
    guard: customGuard,
    ...sel
  });

  assert.ok(started.taskId);
  assert.deepEqual(capturedOptions?.guard, customGuard, "forwarded to options.guard");
  assert.deepEqual(capturedInput?.guard, customGuard, "forwarded to input.guard");
});

test("pass-through: custom guard options take effect during execution (2 failures trip instead of 3)", async () => {
  const child = createMockChild();
  let killed = false;
  const killTree = (_pid: number) => {
    killed = true;
    child.kill();
  };

  const spawnMock = () => {
    queueMicrotask(() => {
      const events = [
        // 1st failure
        JSON.stringify({
          type: "agent_event",
          event: {
            type: "content_start",
            contentType: "tool",
            toolName: "replace_in_file",
            toolCallId: "call_1",
            input: { path: "src/app.ts", find: "a", replace: "b" }
          }
        }),
        JSON.stringify({
          type: "agent_event",
          event: {
            type: "content_end",
            contentType: "tool",
            toolName: "replace_in_file",
            toolCallId: "call_1",
            error: "String not found"
          }
        }),
        // 2nd failure on same file
        JSON.stringify({
          type: "agent_event",
          event: {
            type: "content_start",
            contentType: "tool",
            toolName: "replace_in_file",
            toolCallId: "call_2",
            input: { path: "src/app.ts", find: "c", replace: "d" }
          }
        }),
        JSON.stringify({
          type: "agent_event",
          event: {
            type: "content_end",
            contentType: "tool",
            toolName: "replace_in_file",
            toolCallId: "call_2",
            error: "String not found"
          }
        })
      ];
      child.stdout.emit("data", Buffer.from(events.join("\n") + "\n"));
    });
    return child;
  };

  // With default guard, 2 failures would NOT trip.
  // With custom maxRepeatedFailures: 2, it MUST trip immediately!
  await assert.rejects(
    runCline(
      { prompt: "Edit app.ts", ...sel },
      undefined,
      {
        guard: { maxRepeatedFailures: 2, window: 5 },
        deps: {
          spawn: spawnMock as any,
          killTree,
          access: async () => {},
          entryPath: "fake/cline.js",
          traceBase: traceBase(),
          statusPath: null
        }
      }
    ),
    (e: unknown) => {
      assert.ok(e instanceof ClineRunError);
      assert.equal(e.kind, "loop_detected");
      assert.equal(e.guard?.count, 2);
      assert.equal(e.guard?.window, 5);
      return true;
    }
  );

  assert.ok(killed, "process tree killed when guard tripped on 2nd failure");
});

test("pass-through: custom maxToolCalls takes effect during execution", async () => {
  const child = createMockChild();
  let killed = false;
  const killTree = (_pid: number) => {
    killed = true;
    child.kill();
  };

  const spawnMock = () => {
    queueMicrotask(() => {
      const events: string[] = [];
      // Emit 10 successful tool calls, then 11th should trip maxToolCalls: 10
      for (let i = 1; i <= 11; i++) {
        events.push(
          JSON.stringify({
            type: "agent_event",
            event: {
              type: "content_start",
              contentType: "tool",
              toolName: "read_file",
              toolCallId: `call_${i}`,
              input: { path: `src/file${i}.ts` }
            }
          }),
          JSON.stringify({
            type: "agent_event",
            event: {
              type: "content_end",
              contentType: "tool",
              toolName: "read_file",
              toolCallId: `call_${i}`,
              output: "content"
            }
          })
        );
      }
      child.stdout.emit("data", Buffer.from(events.join("\n") + "\n"));
    });
    return child;
  };

  await assert.rejects(
    runCline(
      { prompt: "Read files", ...sel },
      undefined,
      {
        guard: { maxToolCalls: 10 },
        deps: {
          spawn: spawnMock as any,
          killTree,
          access: async () => {},
          entryPath: "fake/cline.js",
          traceBase: traceBase(),
          statusPath: null
        }
      }
    ),
    (e: unknown) => {
      assert.ok(e instanceof ClineRunError);
      assert.equal(e.kind, "budget_exceeded");
      assert.equal(e.guard?.totalToolCalls, 11);
      return true;
    }
  );

  assert.ok(killed, "process tree killed when tool call budget was exceeded");
});
