import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, writeFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  askCline,
  runCline,
  ClineRunError,
  MAX_PROMPT_CHARACTERS,
  MAX_SYSTEM_PROMPT_CHARACTERS,
  MAX_TOTAL_TEXT_CHARACTERS,
  validateInputLimits,
  redactSecrets
} from "../runner.js";
import {
  restoreProviderSettingsSnapshot,
  readProviderSettingsSnapshot,
  providerSettingsMutex,
  providerSettingsLock,
  AsyncRwLock
} from "../settings.js";

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
  child.kill = () => {
    child.killed = true;
    queueMicrotask(() => {
      child.emit("close", null, "SIGTERM");
    });
  };
  return child;
}

test("accepts the maximum prompt size without a system prompt", () => {
  assert.doesNotThrow(() => validateInputLimits({ prompt: "x".repeat(MAX_PROMPT_CHARACTERS) }));
});

test("rejects a prompt beyond the Windows-safe limit", () => {
  assert.throws(
    () => validateInputLimits({ prompt: "x".repeat(MAX_PROMPT_CHARACTERS + 1) }),
    (error: unknown) => error instanceof ClineRunError && error.message.includes("prompt must not exceed")
  );
});

test("rejects oversized combined prompt text", () => {
  assert.throws(
    () => validateInputLimits({
      prompt: "x".repeat(MAX_PROMPT_CHARACTERS),
      systemPrompt: "x".repeat(MAX_TOTAL_TEXT_CHARACTERS - MAX_PROMPT_CHARACTERS + 1)
    }),
    (error: unknown) => error instanceof ClineRunError && error.message.includes("together must not exceed")
  );
  assert.doesNotThrow(() => validateInputLimits({
    prompt: "x".repeat(MAX_PROMPT_CHARACTERS),
    systemPrompt: "x".repeat(Math.min(MAX_SYSTEM_PROMPT_CHARACTERS, MAX_TOTAL_TEXT_CHARACTERS - MAX_PROMPT_CHARACTERS))
  }));
});

test("non-zero exit with tails", async () => {
  const stderrContent = "E".repeat(2500);
  const stdoutContent = "O".repeat(2500);

  const mockSpawn = () => {
    const child = createMockChild();
    queueMicrotask(() => {
      child.stderr.emit("data", Buffer.from(stderrContent));
      child.stdout.emit("data", Buffer.from(stdoutContent));
      child.emit("close", 1);
    });
    return child;
  };

  await assert.rejects(
    async () => {
      await runCline(
        { prompt: "hello" },
        undefined,
        {
          deps: {
            spawn: mockSpawn as any,
            entryPath: "mock/cline",
            access: async () => {},
            backoffMs: 0
          }
        }
      );
    },
    (err: unknown) => {
      assert.ok(err instanceof ClineRunError);
      assert.equal(err.kind, "non_zero_exit");
      assert.equal(err.exitCode, 1);
      assert.equal(err.attempts, 1);
      assert.equal(err.stderrTail?.length, 2000);
      assert.equal(err.stdoutTail?.length, 2000);
      assert.ok(err.message.includes("exited with code 1"));
      assert.ok(err.message.includes("Stderr tail:"));
      assert.ok(err.message.includes("Stdout tail:"));
      return true;
    }
  );
});

test("completed run_result + exit 1 → success + warning", async () => {
  const mockSpawn = () => {
    const child = createMockChild();
    queueMicrotask(() => {
      child.stdout.emit("data", Buffer.from(JSON.stringify({
        type: "run_result",
        finishReason: "completed",
        text: "Result completed successfully.",
        model: "cline/test-model"
      }) + "\n"));
      child.stderr.emit("data", Buffer.from(JSON.stringify({
        type: "error",
        message: "session not found: 12345"
      }) + "\n"));
      child.emit("close", 1);
    });
    return child;
  };

  const result = await runCline(
    { prompt: "test" },
    undefined,
    {
      deps: {
        spawn: mockSpawn as any,
        entryPath: "mock/cline",
        access: async () => {},
        backoffMs: 0
      }
    }
  );

  assert.equal(result.text, "Result completed successfully.");
  assert.equal(result.model, "cline/test-model");
  assert.ok(result.warnings && result.warnings.length === 1);
  assert.match(result.warnings[0], /cline exited with code 1 after a completed result: session not found: 12345/);
});

test("done-only + exit 1 → success + warning", async () => {
  const mockSpawn = () => {
    const child = createMockChild();
    queueMicrotask(() => {
      child.stdout.emit("data", Buffer.from(JSON.stringify({
        type: "agent_event",
        event: {
          type: "done",
          reason: "completed",
          text: "Agent done text result."
        }
      }) + "\n"));
      child.stderr.emit("data", Buffer.from(JSON.stringify({
        type: "error",
        message: "session not found: 67890"
      }) + "\n"));
      child.emit("close", 1);
    });
    return child;
  };

  const result = await runCline(
    { prompt: "test" },
    undefined,
    {
      deps: {
        spawn: mockSpawn as any,
        entryPath: "mock/cline",
        access: async () => {},
        backoffMs: 0
      }
    }
  );

  assert.equal(result.text, "Agent done text result.");
  assert.ok(result.warnings && result.warnings.length === 1);
  assert.match(result.warnings[0], /cline exited with code 1 after a completed result: session not found: 67890/);
});

test("overloaded → one retry then success", async () => {
  let callCount = 0;

  const mockSpawn = () => {
    callCount++;
    const child = createMockChild();
    const currentCall = callCount;
    queueMicrotask(() => {
      if (currentCall === 1) {
        child.stdout.emit("data", Buffer.from(JSON.stringify({
          type: "run_result",
          finishReason: "error",
          text: "Upstream error from Nvidia: Service temporarily overloaded"
        }) + "\n"));
        child.stderr.emit("data", Buffer.from(JSON.stringify({
          type: "error",
          message: "Upstream error from Nvidia: Service temporarily overloaded"
        }) + "\n"));
        child.emit("close", 1);
      } else {
        child.stdout.emit("data", Buffer.from(JSON.stringify({
          type: "run_result",
          finishReason: "completed",
          text: "Recovered successfully on retry."
        }) + "\n"));
        child.emit("close", 0);
      }
    });
    return child;
  };

  const result = await runCline(
    { prompt: "test" },
    undefined,
    {
      deps: {
        spawn: mockSpawn as any,
        entryPath: "mock/cline",
        access: async () => {},
        backoffMs: 0
      }
    }
  );

  assert.equal(callCount, 2);
  assert.equal(result.text, "Recovered successfully on retry.");
});

test("overloaded twice → transient_provider_error with exactly 2 attempts", async () => {
  let callCount = 0;

  const mockSpawn = () => {
    callCount++;
    const child = createMockChild();
    queueMicrotask(() => {
      child.stderr.emit("data", Buffer.from(JSON.stringify({
        type: "error",
        message: "Service temporarily overloaded (rate limit 429)"
      }) + "\n"));
      child.emit("close", 1);
    });
    return child;
  };

  await assert.rejects(
    async () => {
      await runCline(
        { prompt: "test" },
        undefined,
        {
          deps: {
            spawn: mockSpawn as any,
            entryPath: "mock/cline",
            access: async () => {},
            backoffMs: 0
          }
        }
      );
    },
    (err: unknown) => {
      assert.ok(err instanceof ClineRunError);
      assert.equal(err.kind, "transient_provider_error");
      assert.equal(err.attempts, 2);
      assert.equal(err.exitCode, 1);
      assert.ok(err.message.includes("Service temporarily overloaded"));
      return true;
    }
  );

  assert.equal(callCount, 2);
});

test("non-transient → no retry", async () => {
  let callCount = 0;

  const mockSpawn = () => {
    callCount++;
    const child = createMockChild();
    queueMicrotask(() => {
      child.stderr.emit("data", Buffer.from("Syntax error: unexpected argument\n"));
      child.emit("close", 1);
    });
    return child;
  };

  await assert.rejects(
    async () => {
      await runCline(
        { prompt: "test" },
        undefined,
        {
          deps: {
            spawn: mockSpawn as any,
            entryPath: "mock/cline",
            access: async () => {},
            backoffMs: 0
          }
        }
      );
    },
    (err: unknown) => {
      assert.ok(err instanceof ClineRunError);
      assert.equal(err.kind, "non_zero_exit");
      assert.equal(err.attempts, 1);
      assert.equal(err.exitCode, 1);
      return true;
    }
  );

  assert.equal(callCount, 1);
});

test("timeout message with elapsed", async () => {
  let callCount = 0;

  const mockSpawn = () => {
    callCount++;
    const child = createMockChild();
    // Do not emit close until kill is invoked
    return child;
  };

  await assert.rejects(
    async () => {
      await runCline(
        { prompt: "test", timeoutSeconds: 5 },
        undefined,
        {
          deps: {
            spawn: mockSpawn as any,
            entryPath: "mock/cline",
            access: async () => {},
            backoffMs: 0,
            timeoutMs: 15
          }
        }
      );
    },
    (err: unknown) => {
      assert.ok(err instanceof ClineRunError);
      assert.equal(err.kind, "timeout");
      assert.equal(err.attempts, 2);
      assert.match(err.message, /Cline exceeded the 5-second timeout/);
      assert.match(err.message, /elapsed: \d+(\.\d+)?s/);
      return true;
    }
  );

  assert.equal(callCount, 2);
});

test("missing entry → cline_updating", async () => {
  let accessCalls = 0;

  await assert.rejects(
    async () => {
      await runCline(
        { prompt: "test" },
        undefined,
        {
          deps: {
            entryPath: "missing/cline/path",
            access: async () => {
              accessCalls++;
              throw new Error("ENOENT: no such file or directory");
            },
            updateBackoffMs: 0
          }
        }
      );
    },
    (err: unknown) => {
      assert.ok(err instanceof ClineRunError);
      assert.equal(err.kind, "cline_updating");
      assert.equal(err.message, "Cline CLI is missing or being updated; retry in ~30 s");
      assert.equal(err.attempts, 2);
      return true;
    }
  );

  assert.equal(accessCalls, 2);
});

test("env has CLINE_NO_AUTO_UPDATE=1", async () => {
  let capturedEnv: any;

  const mockSpawn = (_exe: string, _args: string[], options: any) => {
    capturedEnv = options.env;
    const child = createMockChild();
    queueMicrotask(() => {
      child.stdout.emit("data", Buffer.from(JSON.stringify({
        type: "run_result",
        finishReason: "completed",
        text: "ok"
      }) + "\n"));
      child.emit("close", 0);
    });
    return child;
  };

  await runCline(
    { prompt: "test" },
    undefined,
    {
      deps: {
        spawn: mockSpawn as any,
        entryPath: "mock/cline",
        access: async () => {}
      }
    }
  );

  assert.ok(capturedEnv);
  assert.equal(capturedEnv.CLINE_NO_AUTO_UPDATE, "1");
});

test("-P/-m passed", async () => {
  let capturedArgs: string[] = [];

  const mockSpawn = (_exe: string, args: string[]) => {
    capturedArgs = args;
    const child = createMockChild();
    queueMicrotask(() => {
      child.stdout.emit("data", Buffer.from(JSON.stringify({
        type: "run_result",
        finishReason: "completed",
        text: "ok"
      }) + "\n"));
      child.emit("close", 0);
    });
    return child;
  };

  await runCline(
    { prompt: "test", provider: "openrouter", model: "anthropic/claude-3.5-sonnet" },
    undefined,
    {
      deps: {
        spawn: mockSpawn as any,
        entryPath: "mock/cline",
        access: async () => {}
      }
    }
  );

  assert.ok(capturedArgs.includes("-P"));
  assert.equal(capturedArgs[capturedArgs.indexOf("-P") + 1], "openrouter");
  assert.ok(capturedArgs.includes("-m"));
  assert.equal(capturedArgs[capturedArgs.indexOf("-m") + 1], "anthropic/claude-3.5-sonnet");
});

test("settings restored when changed with token fields preserved", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "cline-settings-test-"));
  const settingsPath = path.join(tmpDir, "providers.json");

  const initialSettings = {
    lastUsedProvider: "original-provider",
    providers: {
      "target-provider": {
        settings: {
          model: "original-model",
          reasoning: "low",
          apiKey: "initial-api-key",
          oauthTokens: { accessToken: "initial-token" }
        }
      }
    }
  };

  await writeFile(settingsPath, JSON.stringify(initialSettings, null, 2), "utf8");

  const mockSpawn = () => {
    const child = createMockChild();
    queueMicrotask(async () => {
      // Simulate Cline modifying settings during the run:
      // changes lastUsedProvider, target provider's model & reasoning,
      // and refreshes oauthTokens!
      const modifiedSettings = {
        lastUsedProvider: "target-provider",
        providers: {
          "target-provider": {
            settings: {
              model: "overridden-model",
              reasoning: "high",
              apiKey: "initial-api-key",
              oauthTokens: { accessToken: "refreshed-oauth-token-9999" }
            }
          }
        }
      };
      await writeFile(settingsPath, JSON.stringify(modifiedSettings, null, 2), "utf8");

      child.stdout.emit("data", Buffer.from(JSON.stringify({
        type: "run_result",
        finishReason: "completed",
        text: "ok",
        model: "target-provider/overridden-model"
      }) + "\n"));
      child.emit("close", 0);
    });
    return child;
  };

  try {
    const result = await runCline(
      { prompt: "test", provider: "target-provider", model: "overridden-model" },
      undefined,
      {
        deps: {
          spawn: mockSpawn as any,
          entryPath: "mock/cline",
          access: async () => {},
          providerSettingsPath: settingsPath
        }
      }
    );

    assert.equal(result.model, "target-provider/overridden-model");

    const restored = JSON.parse(await readFile(settingsPath, "utf8"));
    assert.equal(restored.lastUsedProvider, "original-provider");
    assert.equal(restored.providers["target-provider"].settings.model, "original-model");
    assert.equal(restored.providers["target-provider"].settings.reasoning, "low");
    assert.equal(restored.providers["target-provider"].settings.oauthTokens.accessToken, "refreshed-oauth-token-9999");
    assert.equal(restored.providers["target-provider"].settings.apiKey, "initial-api-key");
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test("no write when unchanged", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "cline-settings-unchanged-"));
  const settingsPath = path.join(tmpDir, "providers.json");

  const initialSettings = {
    lastUsedProvider: "target-provider",
    providers: {
      "target-provider": {
        settings: {
          model: "target-model",
          reasoning: "low"
        }
      }
    }
  };

  await writeFile(settingsPath, JSON.stringify(initialSettings, null, 2), "utf8");

  const snapshot = await readProviderSettingsSnapshot(settingsPath, "target-provider");
  // Without any changes, restoreProviderSettingsSnapshot must return false and not write
  const restored = await restoreProviderSettingsSnapshot(snapshot);
  assert.equal(restored, false);

  await rm(tmpDir, { recursive: true, force: true });
});

test("invalid provider rejected", () => {
  assert.throws(
    () => validateInputLimits({ prompt: "test", provider: "invalid provider with spaces!" }),
    (err: unknown) => err instanceof ClineRunError && err.message.includes("provider must match")
  );
  assert.throws(
    () => validateInputLimits({ prompt: "test", model: "invalid model with spaces!" }),
    (err: unknown) => err instanceof ClineRunError && err.message.includes("model must match")
  );
  assert.throws(
    () => validateInputLimits({ prompt: "test", provider: "a".repeat(121) }),
    (err: unknown) => err instanceof ClineRunError && err.message.includes("provider must match")
  );
});

test("stdout containing durationMs:512 or inputTokens:503 on non-transient failure is NOT retried", async () => {
  let callCount = 0;
  const mockSpawn = () => {
    callCount++;
    const child = createMockChild();
    queueMicrotask(() => {
      child.stdout.emit("data", Buffer.from(JSON.stringify({
        type: "agent_event",
        durationMs: 512,
        usage: { inputTokens: 503 }
      }) + "\n"));
      child.stderr.emit("data", Buffer.from("Fatal syntax error: invalid configuration\n"));
      child.emit("close", 1);
    });
    return child;
  };

  await assert.rejects(
    async () => {
      await runCline(
        { prompt: "test" },
        undefined,
        {
          deps: {
            spawn: mockSpawn as any,
            entryPath: "mock/cline",
            access: async () => {},
            backoffMs: 0
          }
        }
      );
    },
    (err: unknown) => {
      assert.ok(err instanceof ClineRunError);
      assert.equal(err.kind, "non_zero_exit");
      assert.equal(err.attempts, 1);
      return true;
    }
  );

  assert.equal(callCount, 1);
});

test("unparseable file -> no write", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "cline-settings-unparseable-"));
  const settingsPath = path.join(tmpDir, "providers.json");
  const badContent = "{ invalid: json ::: ";
  await writeFile(settingsPath, badContent, "utf8");

  const snapshot = await readProviderSettingsSnapshot(settingsPath, "target-provider");
  assert.equal(snapshot.skipRestore, true);
  assert.ok(snapshot.warning);

  const restored = await restoreProviderSettingsSnapshot(snapshot);
  assert.equal(restored, false);

  const afterContent = await readFile(settingsPath, "utf8");
  assert.equal(afterContent, badContent);

  await rm(tmpDir, { recursive: true, force: true });
});

test("provider block absent before run but created by Cline: restores only lastUsedProvider", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "cline-settings-new-provider-"));
  const settingsPath = path.join(tmpDir, "providers.json");

  const initialSettings = {
    lastUsedProvider: "old-default",
    providers: {}
  };
  await writeFile(settingsPath, JSON.stringify(initialSettings, null, 2), "utf8");

  const mockSpawn = () => {
    const child = createMockChild();
    queueMicrotask(async () => {
      const modifiedSettings = {
        lastUsedProvider: "new-provider",
        providers: {
          "new-provider": {
            settings: {
              model: "created-model",
              apiKey: "created-api-key"
            }
          }
        }
      };
      await writeFile(settingsPath, JSON.stringify(modifiedSettings, null, 2), "utf8");
      child.stdout.emit("data", Buffer.from(JSON.stringify({
        type: "run_result",
        finishReason: "completed",
        text: "ok"
      }) + "\n"));
      child.emit("close", 0);
    });
    return child;
  };

  try {
    await runCline(
      { prompt: "test", provider: "new-provider" },
      undefined,
      {
        deps: {
          spawn: mockSpawn as any,
          entryPath: "mock/cline",
          access: async () => {},
          providerSettingsPath: settingsPath
        }
      }
    );

    const restored = JSON.parse(await readFile(settingsPath, "utf8"));
    assert.equal(restored.lastUsedProvider, "old-default");
    assert.ok(restored.providers["new-provider"]);
    assert.equal(restored.providers["new-provider"].settings.model, "created-model");
    assert.equal(restored.providers["new-provider"].settings.apiKey, "created-api-key");
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test("prototype provider and model names rejected in validation", () => {
  for (const name of ["__proto__", "constructor", "prototype", "__PROTO__"]) {
    assert.throws(
      () => validateInputLimits({ prompt: "test", provider: name }),
      (err: unknown) => err instanceof ClineRunError && err.message.includes("prohibited")
    );
    assert.throws(
      () => validateInputLimits({ prompt: "test", model: name }),
      (err: unknown) => err instanceof ClineRunError && err.message.includes("prohibited")
    );
  }
});

test("MODULE_NOT_FOUND does not retry if canRetry returns false", async () => {
  let callCount = 0;
  const mockSpawn = () => {
    callCount++;
    const child = createMockChild();
    queueMicrotask(() => {
      child.stderr.emit("data", Buffer.from("Error: Cannot find module 'cline'\n"));
      child.emit("close", 1);
    });
    return child;
  };

  await assert.rejects(
    async () => {
      await runCline(
        { prompt: "test" },
        undefined,
        {
          canRetry: () => false,
          deps: {
            spawn: mockSpawn as any,
            entryPath: "mock/cline",
            access: async () => {},
            updateBackoffMs: 0
          }
        }
      );
    },
    (err: unknown) => {
      assert.ok(err instanceof ClineRunError);
      assert.equal(err.kind, "cline_updating");
      assert.equal(err.attempts, 1);
      return true;
    }
  );

  assert.equal(callCount, 1);
});

test("MODULE_NOT_FOUND in stderr does not prevent returning completed result", async () => {
  const mockSpawn = () => {
    const child = createMockChild();
    queueMicrotask(() => {
      child.stdout.emit("data", Buffer.from(JSON.stringify({
        type: "run_result",
        finishReason: "completed",
        text: "completed text"
      }) + "\n"));
      child.stderr.emit("data", Buffer.from("Cannot find module 'foo'\n"));
      child.emit("close", 1);
    });
    return child;
  };

  const result = await runCline(
    { prompt: "test" },
    undefined,
    {
      deps: {
        spawn: mockSpawn as any,
        entryPath: "mock/cline",
        access: async () => {}
      }
    }
  );

  assert.equal(result.text, "completed text");
  assert.ok(result.warnings && result.warnings.length === 1);
});

test("non-override call waits for in-flight override to finish restore before spawning", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "cline-mutex-test-"));
  const settingsPath = path.join(tmpDir, "providers.json");
  await writeFile(settingsPath, JSON.stringify({ lastUsedProvider: "orig" }, null, 2), "utf8");

  let overrideRunning = true;
  let nonOverrideStartedWhileOverrideRunning = false;

  const overridePromise = providerSettingsMutex.runExclusive(async () => {
    await new Promise((r) => setTimeout(r, 40));
    overrideRunning = false;
  });

  const mockSpawn = () => {
    if (overrideRunning) {
      nonOverrideStartedWhileOverrideRunning = true;
    }
    const child = createMockChild();
    queueMicrotask(() => {
      child.stdout.emit("data", Buffer.from(JSON.stringify({
        type: "run_result",
        finishReason: "completed",
        text: "ok"
      }) + "\n"));
      child.emit("close", 0);
    });
    return child;
  };

  const nonOverridePromise = runCline(
    { prompt: "test" },
    undefined,
    {
      deps: {
        spawn: mockSpawn as any,
        entryPath: "mock/cline",
        access: async () => {},
        providerSettingsPath: settingsPath
      }
    }
  );

  await Promise.all([overridePromise, nonOverridePromise]);
  assert.equal(nonOverrideStartedWhileOverrideRunning, false);

  await rm(tmpDir, { recursive: true, force: true });
});

test("abort signal prevents attempt from starting", async () => {
  const controller = new AbortController();
  controller.abort();

  let spawned = false;
  const mockSpawn = () => {
    spawned = true;
    return createMockChild();
  };

  await assert.rejects(
    async () => {
      await runCline(
        { prompt: "test" },
        controller.signal,
        {
          deps: {
            spawn: mockSpawn as any,
            entryPath: "mock/cline",
            access: async () => {}
          }
        }
      );
    },
    (err: unknown) => {
      assert.ok(err instanceof ClineRunError);
      assert.equal(err.kind, "cancelled");
      return true;
    }
  );

  assert.equal(spawned, false);
});

test("spawn error event returns launch_failed with error code", async () => {
  const mockSpawn = () => {
    const child = createMockChild();
    queueMicrotask(() => {
      const err = new Error("spawn ENOENT") as any;
      err.code = "ENOENT";
      child.emit("error", err);
      child.emit("close", null);
    });
    return child;
  };

  await assert.rejects(
    async () => {
      await runCline(
        { prompt: "test" },
        undefined,
        {
          deps: {
            spawn: mockSpawn as any,
            entryPath: "mock/cline",
            access: async () => {}
          }
        }
      );
    },
    (err: unknown) => {
      assert.ok(err instanceof ClineRunError);
      assert.equal(err.kind, "launch_failed");
      assert.match(err.message, /ENOENT/);
      return true;
    }
  );
});

test("timeout with timeoutSeconds > 120 is not retried", async () => {
  let callCount = 0;
  const mockSpawn = () => {
    callCount++;
    return createMockChild();
  };

  await assert.rejects(
    async () => {
      await runCline(
        { prompt: "test", timeoutSeconds: 150 },
        undefined,
        {
          deps: {
            spawn: mockSpawn as any,
            entryPath: "mock/cline",
            access: async () => {},
            timeoutMs: 15
          }
        }
      );
    },
    (err: unknown) => {
      assert.ok(err instanceof ClineRunError);
      assert.equal(err.kind, "timeout");
      assert.equal(err.attempts, 1);
      return true;
    }
  );

  assert.equal(callCount, 1);
});

test("secrets in tails and error output are redacted", () => {
  const raw = [
    'Authorization: Bearer mySecretToken12345',
    'sk-ant-api03-abcdef1234567890abcdef',
    '{"apiKey": "secret-api-key", "accessToken": "token-xyz", "password": "super-secret-password"}'
  ].join("\n");

  const redacted = redactSecrets(raw);
  assert.ok(!redacted.includes("mySecretToken12345"));
  assert.ok(!redacted.includes("abcdef1234567890abcdef"));
  assert.ok(!redacted.includes("secret-api-key"));
  assert.ok(!redacted.includes("token-xyz"));
  assert.ok(!redacted.includes("super-secret-password"));

  assert.match(redacted, /Bearer <redacted>/);
  assert.match(redacted, /<redacted>/);
  assert.match(redacted, /"apiKey":\s*"<redacted>"/);
  assert.match(redacted, /"accessToken":\s*"<redacted>"/);
  assert.match(redacted, /"password":\s*"<redacted>"/);
});

test("exit code 0 with transient overload error retries once then succeeds", async () => {
  let attempts = 0;
  const mockSpawn = () => {
    attempts++;
    const child = createMockChild();
    queueMicrotask(() => {
      if (attempts === 1) {
        child.stdout.emit(
          "data",
          Buffer.from(
            JSON.stringify({
              type: "run_result",
              finishReason: "error",
              text: "Upstream error from Nvidia: Service temporarily overloaded"
            }) + "\n"
          )
        );
        child.emit("close", 0);
      } else {
        child.stdout.emit(
          "data",
          Buffer.from(
            JSON.stringify({
              type: "run_result",
              finishReason: "completed",
              text: "Success on retry"
            }) + "\n"
          )
        );
        child.emit("close", 0);
      }
    });
    return child;
  };

  const result = await runCline(
    { prompt: "hello" },
    undefined,
    {
      deps: {
        spawn: mockSpawn as any,
        entryPath: "mock/cline",
        access: async () => {},
        backoffMs: 0
      }
    }
  );

  assert.equal(attempts, 2);
  assert.equal(result.text, "Success on retry");
});

test("exit code 0 with non-transient error in run_result is not retried and reports error", async () => {
  let attempts = 0;
  const mockSpawn = () => {
    attempts++;
    const child = createMockChild();
    queueMicrotask(() => {
      child.stdout.emit(
        "data",
        Buffer.from(
          JSON.stringify({
            type: "run_result",
            finishReason: "error",
            text: "Request rejected: Prompt violates system policy"
          }) + "\n"
        )
      );
      child.emit("close", 0);
    });
    return child;
  };

  await assert.rejects(
    async () => {
      await runCline(
        { prompt: "hello" },
        undefined,
        {
          deps: {
            spawn: mockSpawn as any,
            entryPath: "mock/cline",
            access: async () => {},
            backoffMs: 0
          }
        }
      );
    },
    (err: unknown) => {
      assert.ok(err instanceof ClineRunError);
      assert.equal(err.attempts, 1);
      assert.match(err.message, /Prompt violates system policy/);
      assert.equal(err.extractedMessage, "Request rejected: Prompt violates system policy");
      return true;
    }
  );

  assert.equal(attempts, 1);
});

test("stderr info JSON with rate limit mention and non-transient exit is NOT retried", async () => {
  let attempts = 0;
  const mockSpawn = () => {
    attempts++;
    const child = createMockChild();
    queueMicrotask(() => {
      child.stderr.emit(
        "data",
        Buffer.from(JSON.stringify({ type: "info", message: "rate limit remaining: 99" }) + "\n")
      );
      child.stdout.emit(
        "data",
        Buffer.from(JSON.stringify({ type: "run_result", finishReason: "error", text: "Invalid user token" }) + "\n")
      );
      child.emit("close", 1);
    });
    return child;
  };

  await assert.rejects(
    async () => {
      await runCline(
        { prompt: "hello" },
        undefined,
        {
          deps: {
            spawn: mockSpawn as any,
            entryPath: "mock/cline",
            access: async () => {},
            backoffMs: 0
          }
        }
      );
    },
    (err: unknown) => {
      assert.ok(err instanceof ClineRunError);
      assert.equal(err.kind, "non_zero_exit");
      assert.equal(err.attempts, 1);
      return true;
    }
  );

  assert.equal(attempts, 1);
});

test("override call waits for in-flight default run before acquiring lock", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "cline-rwlock-test-"));
  const settingsPath = path.join(tmpDir, "providers.json");
  await writeFile(settingsPath, JSON.stringify({ lastUsedProvider: "orig" }, null, 2), "utf8");

  let defaultRunActive = true;
  let overrideStartedWhileDefaultRunning = false;

  const defaultPromise = providerSettingsLock.acquireRead().then(async (release) => {
    try {
      await new Promise((r) => setTimeout(r, 40));
      defaultRunActive = false;
    } finally {
      release();
    }
  });

  const mockSpawn = () => {
    if (defaultRunActive) {
      overrideStartedWhileDefaultRunning = true;
    }
    const child = createMockChild();
    queueMicrotask(() => {
      child.stdout.emit("data", Buffer.from(JSON.stringify({
        type: "run_result",
        finishReason: "completed",
        text: "ok"
      }) + "\n"));
      child.emit("close", 0);
    });
    return child;
  };

  const overridePromise = runCline(
    { prompt: "test", provider: "custom-provider" },
    undefined,
    {
      deps: {
        spawn: mockSpawn as any,
        entryPath: "mock/cline",
        access: async () => {},
        providerSettingsPath: settingsPath
      }
    }
  );

  await Promise.all([defaultPromise, overridePromise]);
  assert.equal(overrideStartedWhileDefaultRunning, false);

  await rm(tmpDir, { recursive: true, force: true });
});

test("AsyncRwLock: concurrent readers, queued writers, fair draining", async () => {
  const lock = new AsyncRwLock();
  const order: string[] = [];

  const r1Release = await lock.acquireRead();
  order.push("r1 acquired");

  const r2Release = await lock.acquireRead();
  order.push("r2 acquired");

  let w1Released = false;
  const w1Promise = lock.acquireWrite().then((release) => {
    order.push("w1 acquired");
    release();
    w1Released = true;
  });

  const r3Promise = lock.acquireRead().then((release) => {
    order.push("r3 acquired");
    release();
  });

  assert.equal(lock.getState().activeReaders, 2);
  assert.equal(lock.getState().queueLength, 2);

  r1Release();
  assert.equal(lock.getState().activeReaders, 1);
  assert.equal(w1Released, false);

  r2Release();
  await w1Promise;
  await r3Promise;

  assert.deepEqual(order, ["r1 acquired", "r2 acquired", "w1 acquired", "r3 acquired"]);
});

test("redactSecrets redacts nvapi, api_key, and KEY=value forms", () => {
  const raw = [
    'nvapi-1234567890abcdef',
    '{"api_key": "my-secret-key-123"}',
    'MY_API_KEY=supersecret123',
    'AUTH_TOKEN="token-with-quotes"',
    'DATABASE_PASSWORD=\'pass-with-single-quotes\'',
    'APP_SECRET=sec999'
  ].join("\n");

  const redacted = redactSecrets(raw);
  assert.ok(!redacted.includes("1234567890abcdef"));
  assert.ok(!redacted.includes("my-secret-key-123"));
  assert.ok(!redacted.includes("supersecret123"));
  assert.ok(!redacted.includes("token-with-quotes"));
  assert.ok(!redacted.includes("pass-with-single-quotes"));
  assert.ok(!redacted.includes("sec999"));

  assert.match(redacted, /<redacted>/);
  assert.match(redacted, /"api_key":\s*"<redacted>"/);
  assert.match(redacted, /MY_API_KEY=<redacted>/);
  assert.match(redacted, /AUTH_TOKEN=<redacted>/);
  assert.match(redacted, /DATABASE_PASSWORD=<redacted>/);
  assert.match(redacted, /APP_SECRET=<redacted>/);
});

test("redacts full output before taking tail to preserve tokens near tail boundary", async () => {
  const filler = "x".repeat(1980);
  const secretLine = "CLINE_API_KEY=extremely-long-secret-key-1234567890\n";
  const output = filler + secretLine;

  const mockSpawn = () => {
    const child = createMockChild();
    queueMicrotask(() => {
      child.stderr.emit("data", Buffer.from(output));
      child.emit("close", 1);
    });
    return child;
  };

  await assert.rejects(
    async () => {
      await runCline(
        { prompt: "test" },
        undefined,
        {
          deps: {
            spawn: mockSpawn as any,
            entryPath: "mock/cline",
            access: async () => {}
          }
        }
      );
    },
    (err: unknown) => {
      assert.ok(err instanceof ClineRunError);
      assert.ok(!err.stderrTail?.includes("extremely-long-secret-key-1234567890"));
      assert.match(err.stderrTail ?? "", /CLINE_API_KEY=<redacted>/);
      return true;
    }
  );
});

test("child killed by outside signal without completed result is treated as non-zero exit with signal name", async () => {
  const mockSpawn = () => {
    const child = createMockChild();
    queueMicrotask(() => {
      child.emit("close", null, "SIGKILL");
    });
    return child;
  };

  await assert.rejects(
    async () => {
      await runCline(
        { prompt: "test" },
        undefined,
        {
          deps: {
            spawn: mockSpawn as any,
            entryPath: "mock/cline",
            access: async () => {}
          }
        }
      );
    },
    (err: unknown) => {
      assert.ok(err instanceof ClineRunError);
      assert.equal(err.kind, "non_zero_exit");
      assert.equal(err.exitCode, null);
      assert.match(err.message, /killed by signal SIGKILL/);
      return true;
    }
  );
});

test("child killed by outside signal with completed result succeeds with warning containing signal name", async () => {
  const mockSpawn = () => {
    const child = createMockChild();
    queueMicrotask(() => {
      child.stdout.emit(
        "data",
        Buffer.from(
          JSON.stringify({
            type: "run_result",
            finishReason: "completed",
            text: "Completed before signal"
          }) + "\n"
        )
      );
      child.emit("close", null, "SIGTERM");
    });
    return child;
  };

  const result = await runCline(
    { prompt: "test" },
    undefined,
    {
      deps: {
        spawn: mockSpawn as any,
        entryPath: "mock/cline",
        access: async () => {}
      }
    }
  );

  assert.equal(result.text, "Completed before signal");
  assert.ok(result.warnings && result.warnings.length === 1);
  assert.match(result.warnings[0], /exited with signal SIGTERM after a completed result/);
});

test("attempt promise settles on child error even if close never fires", async () => {
  const mockSpawn = () => {
    const child = createMockChild();
    queueMicrotask(() => {
      const err = new Error("spawn failed immediately") as any;
      err.code = "EACCES";
      child.emit("error", err);
    });
    return child;
  };

  await assert.rejects(
    async () => {
      await runCline(
        { prompt: "test" },
        undefined,
        {
          deps: {
            spawn: mockSpawn as any,
            entryPath: "mock/cline",
            access: async () => {}
          }
        }
      );
    },
    (err: unknown) => {
      assert.ok(err instanceof ClineRunError);
      assert.equal(err.kind, "launch_failed");
      assert.match(err.message, /EACCES/);
      return true;
    }
  );
});

test("abort while waiting for lock cancels waiter and removes from queue", async () => {
  const lock = new AsyncRwLock();
  const releaseWrite = await lock.acquireWrite();

  const controller = new AbortController();
  const waiterPromise = lock.acquireWrite(controller.signal);

  assert.equal(lock.getState().queueLength, 1);

  controller.abort();

  await assert.rejects(
    waiterPromise,
    (err: unknown) => {
      assert.ok(err instanceof ClineRunError);
      assert.equal(err.kind, "cancelled");
      return true;
    }
  );

  assert.equal(lock.getState().queueLength, 0);
  releaseWrite();
  assert.equal(lock.getState().activeWriter, false);
});

test("mock child that emits exit but never close still settles via grace period and returns completed result", async () => {
  let childRef: any;
  const mockSpawn = () => {
    const child = createMockChild();
    childRef = child;
    queueMicrotask(() => {
      child.stdout.emit(
        "data",
        Buffer.from(
          JSON.stringify({
            type: "run_result",
            finishReason: "completed",
            text: "completed despite lingering pipes"
          }) + "\n"
        )
      );
      child.emit("exit", 0, null);
      // Intentionally do NOT emit "close"
    });
    return child;
  };

  const result = await runCline(
    { prompt: "test" },
    undefined,
    {
      deps: {
        spawn: mockSpawn as any,
        entryPath: "mock/cline",
        access: async () => {},
        closeGracePeriodMs: 20
      }
    }
  );

  assert.equal(result.text, "completed despite lingering pipes");
  assert.equal(childRef.stdout.destroyed, true);
  assert.equal(childRef.stderr.destroyed, true);
});

test("redactSecrets covers bare *_KEY=value names and JSON keys key and authorization", () => {
  const raw = [
    'NVIDIA_KEY=nvapi-secret12345678',
    'ANTHROPIC_KEY="sk-ant-secret123"',
    'KEY=bare-secret-value',
    '{"key": "my-secret-key-456"}',
    '{"authorization": "Bearer token123"}',
    '{"key":"unspaced-secret"}',
    "export GEMINI_KEY='secret-gemini-key'"
  ].join("\n");

  const redacted = redactSecrets(raw);
  assert.ok(!redacted.includes("nvapi-secret12345678"));
  assert.ok(!redacted.includes("sk-ant-secret123"));
  assert.ok(!redacted.includes("bare-secret-value"));
  assert.ok(!redacted.includes("my-secret-key-456"));
  assert.ok(!redacted.includes("token123"));
  assert.ok(!redacted.includes("unspaced-secret"));
  assert.ok(!redacted.includes("secret-gemini-key"));

  assert.match(redacted, /NVIDIA_KEY=<redacted>/);
  assert.match(redacted, /ANTHROPIC_KEY=<redacted>/);
  assert.match(redacted, /KEY=<redacted>/);
  assert.match(redacted, /"key":\s*"<redacted>"/);
  assert.match(redacted, /"authorization":\s*"<redacted>"/);
  assert.match(redacted, /GEMINI_KEY=<redacted>/);
});

test("extractedMessage from run_result error text has secrets redacted", async () => {
  const mockSpawn = () => {
    const child = createMockChild();
    queueMicrotask(() => {
      child.stdout.emit(
        "data",
        Buffer.from(
          JSON.stringify({
            type: "run_result",
            finishReason: "error",
            text: "Request failed with NVIDIA_KEY=nvapi-secret12345678 and token: Bearer abc123456"
          }) + "\n"
        )
      );
      child.emit("close", 0);
    });
    return child;
  };

  await assert.rejects(
    async () => {
      await runCline(
        { prompt: "test" },
        undefined,
        {
          deps: {
            spawn: mockSpawn as any,
            entryPath: "mock/cline",
            access: async () => {},
            backoffMs: 0
          }
        }
      );
    },
    (err: unknown) => {
      assert.ok(err instanceof ClineRunError);
      assert.ok(!err.extractedMessage?.includes("nvapi-secret12345678"));
      assert.ok(!err.extractedMessage?.includes("abc123456"));
      assert.match(err.extractedMessage ?? "", /NVIDIA_KEY=<redacted>/);
      assert.match(err.extractedMessage ?? "", /Bearer <redacted>/);
      return true;
    }
  );
});



