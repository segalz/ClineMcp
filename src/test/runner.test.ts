import assert from "node:assert/strict";
import test, { after } from "node:test";
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
  redactSecrets,
  defaultKillTree
} from "../runner.js";
import {
  restoreProviderSettingsSnapshot,
  readProviderSettingsSnapshot
} from "../settings.js";

const isolatedSettingsDir = await mkdtemp(path.join(os.tmpdir(), "cline-runner-isolated-"));
process.env.CLINE_PROVIDER_SETTINGS_PATH = path.join(isolatedSettingsDir, "providers.json");
after(() => rm(isolatedSettingsDir, { recursive: true, force: true }));

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
  // Without any changes, restore returns unchanged without writing.
  const restored = await restoreProviderSettingsSnapshot(snapshot);
  assert.equal(restored, "unchanged");

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
  assert.equal(restored, "failed");

  const afterContent = await readFile(settingsPath, "utf8");
  assert.equal(afterContent, badContent);

  await rm(tmpDir, { recursive: true, force: true });
});

test("provider block created by Cline: removes temporary model and preserves auth", async () => {
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
    assert.equal(restored.providers["new-provider"].settings.model, undefined);
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

test("timeout with timeoutSeconds > 120 retries within budget", async () => {
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
      return true;
    }
  );

  assert.equal(callCount, 2);
});

test("timeout with insufficient budget does not retry", async () => {
  let callCount = 0;
  const mockSpawn = () => {
    callCount++;
    return createMockChild();
  };

  await assert.rejects(
    async () => {
      await runCline(
        { prompt: "test", timeoutSeconds: 40 },
        undefined,
        {
          deps: {
            spawn: mockSpawn as any,
            entryPath: "mock/cline",
            access: async () => {},
            backoffMs: 0,
            timeoutMs: 15,
            minRetryBudgetMs: 30_000,
            totalBudgetMs: 20_000
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
test("plain-stderr classification for transient errors: Overloaded, Too many requests, HTTP 503, rate limit, ECONNRESET, ETIMEDOUT", async () => {
  const transientPhrases = [
    "Overloaded",
    "Too many requests",
    "HTTP 503 Service Unavailable",
    "rate limit exceeded",
    "ECONNRESET: socket hang up",
    "ETIMEDOUT: connection timed out"
  ];

  for (const phrase of transientPhrases) {
    let callCount = 0;
    const mockSpawn = () => {
      callCount++;
      const child = createMockChild();
      queueMicrotask(() => {
        if (callCount === 1) {
          // Plain non-JSON stderr line
          child.stderr.emit("data", Buffer.from(`${phrase}\n`));
          child.emit("close", 1);
        } else {
          child.stdout.emit("data", Buffer.from(JSON.stringify({
            type: "run_result",
            finishReason: "completed",
            text: `Recovered after ${phrase}`
          }) + "\n"));
          child.emit("close", 0);
        }
      });
      return child;
    };

    const res = await runCline(
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
    assert.equal(res.text, `Recovered after ${phrase}`);
  }
});

test("forced kill settlement with a fake child that ignores kill and never closes", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "cline-forced-settle-"));
  const settingsPath = path.join(tmpDir, "providers.json");

  const initialSettings = {
    lastUsedProvider: "orig-prov",
    providers: {
      "target-prov": {
        settings: {
          model: "orig-model"
        }
      }
    }
  };
  await writeFile(settingsPath, JSON.stringify(initialSettings, null, 2), "utf8");

  let killCount = 0;
  let killedTreePid: number | undefined;
  const mockSpawn = () => {
    const child = new EventEmitter() as any;
    child.pid = 12345;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdout.destroy = () => {};
    child.stderr.destroy = () => {};
    // Fake child ignores kill: does not emit exit or close!
    child.kill = () => {
      killCount++;
    };
    return child;
  };

  try {
    await assert.rejects(
      async () => {
        await runCline(
          { prompt: "test", provider: "target-prov", model: "new-model", timeoutSeconds: 5 },
          undefined,
          {
            deps: {
              spawn: mockSpawn as any,
              entryPath: "mock/cline",
              access: async () => {},
              providerSettingsPath: settingsPath,
              timeoutMs: 15,
              closeGracePeriodMs: 10,
              killGracePeriodMs: 10,
              settlementDeadlineMs: 25,
              backoffMs: 0,
              killTree: (pid) => {
                killedTreePid = pid;
              }
            }
          }
        );
      },
      (err: unknown) => {
        assert.ok(err instanceof ClineRunError);
        assert.equal(err.kind, "timeout");
        return true;
      }
    );

    assert.equal(killCount, 0); // Signal the tree instead of killing only its root.
    assert.equal(killedTreePid, 12345);

    // Verify settings restore executed despite fake child hanging
    const restored = JSON.parse(await readFile(settingsPath, "utf8"));
    assert.equal(restored.lastUsedProvider, "orig-prov");
    assert.equal(restored.providers["target-prov"].settings.model, "orig-model");
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test("cancellation includes captured stdout/stderr tails and exit status", async () => {
  const controller = new AbortController();

  const mockSpawn = () => {
    const child = createMockChild();
    queueMicrotask(() => {
      child.stdout.emit("data", Buffer.from("stdout before cancel\n"));
      child.stderr.emit("data", Buffer.from("stderr before cancel\n"));
      controller.abort();
    });
    return child;
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
            access: async () => {},
            backoffMs: 0
          }
        }
      );
    },
    (err: unknown) => {
      assert.ok(err instanceof ClineRunError);
      assert.equal(err.kind, "cancelled");
      assert.ok(err.stdoutTail?.includes("stdout before cancel"));
      assert.ok(err.stderrTail?.includes("stderr before cancel"));
      assert.ok(err.message.includes("Stdout tail:"));
      assert.ok(err.message.includes("Stderr tail:"));
      return true;
    }
  );
});

test("timeout reports numeric exit code when child exits with a code", async () => {
  const mockSpawn = () => {
    const child = createMockChild();
    child.kill = () => {
      child.killed = true;
      queueMicrotask(() => {
        child.emit("exit", 143, null);
        child.emit("close", 143, null);
      });
    };
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
            timeoutMs: 15,
            minRetryBudgetMs: 30_000,
            totalBudgetMs: 5000
          }
        }
      );
    },
    (err: unknown) => {
      assert.ok(err instanceof ClineRunError);
      assert.equal(err.kind, "timeout");
      assert.equal(err.exitCode, 143);
      return true;
    }
  );
});

test("redactSecrets covers Basic, arbitrary schemes, x-api-key, api-key, cookies, and tokens in any form", () => {
  const inputs = [
    'Authorization: Basic dXNlcjpwYXNzMTIz',
    'Authorization: CustomAuthScheme mySecretVal99',
    'Authorization: secretTokenWithoutScheme',
    'x-api-key: my-secret-x-api-key',
    'x-api-key=unspaced-x-key',
    'api-key: my-secret-api-key',
    'api-key = spaced-api-key',
    'Cookie: session_id=topsecret12345; user=john',
    'Set-Cookie: auth_token=cookie_secret_99; Path=/; Secure; HttpOnly',
    '{"cookie": "my-secret-cookie", "set-cookie": "my-secret-set-cookie"}',
    'key: 4f53c8a901b23d4e5f6a7b8c9d0e1f2a3b4c',
    'token: eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0',
    'secret = aGVsbG9fd29ybGRfc2VjcmV0X3ZhbHVlXzEyMzQ1',
    'password: superSecretPassword99!',
    'secret is 4f53c8a901b23d4e5f6a7b8c9d0e1f2a',
    'token: sk-proj-1234567890abcdefghijklmn'
  ];

  for (const raw of inputs) {
    const redacted = redactSecrets(raw);
    assert.ok(!redacted.includes("dXNlcjpwYXNzMTIz"), `Failed on ${raw}`);
    assert.ok(!redacted.includes("mySecretVal99"), `Failed on ${raw}`);
    assert.ok(!redacted.includes("secretTokenWithoutScheme"), `Failed on ${raw}`);
    assert.ok(!redacted.includes("my-secret-x-api-key"), `Failed on ${raw}`);
    assert.ok(!redacted.includes("unspaced-x-key"), `Failed on ${raw}`);
    assert.ok(!redacted.includes("my-secret-api-key"), `Failed on ${raw}`);
    assert.ok(!redacted.includes("spaced-api-key"), `Failed on ${raw}`);
    assert.ok(!redacted.includes("topsecret12345"), `Failed on ${raw}`);
    assert.ok(!redacted.includes("cookie_secret_99"), `Failed on ${raw}`);
    assert.ok(!redacted.includes("my-secret-cookie"), `Failed on ${raw}`);
    assert.ok(!redacted.includes("my-secret-set-cookie"), `Failed on ${raw}`);
    assert.ok(!redacted.includes("4f53c8a901b23d4e5f6a7b8c9d0e1f2a3b4c"), `Failed on ${raw}`);
    assert.ok(!redacted.includes("eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9"), `Failed on ${raw}`);
    assert.ok(!redacted.includes("aGVsbG9fd29ybGRfc2VjcmV0X3ZhbHVlXzEyMzQ1"), `Failed on ${raw}`);
    assert.ok(!redacted.includes("superSecretPassword99!"), `Failed on ${raw}`);
    assert.ok(!redacted.includes("sk-proj-1234567890abcdefghijklmn"), `Failed on ${raw}`);
  }

  assert.match(redactSecrets('Authorization: Basic dXNlcjpwYXNzMTIz'), /Authorization: Basic <redacted>/);
  assert.match(redactSecrets('Authorization: CustomAuthScheme mySecretVal99'), /Authorization: CustomAuthScheme <redacted>/);
  assert.match(redactSecrets('Cookie: session_id=topsecret12345'), /Cookie: <redacted>/);
  assert.match(redactSecrets('Set-Cookie: auth=secret; Secure'), /Set-Cookie: <redacted>/);

  // Requirement: "Basic configuration error unchanged; full JWT redacted"
  assert.equal(redactSecrets("Basic configuration error"), "Basic configuration error");
  assert.equal(redactSecrets("A Basic configuration error occurred"), "A Basic configuration error occurred");

  const fullJwt = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";
  const jwtRedacted = redactSecrets(`token: ${fullJwt}`);
  assert.equal(jwtRedacted, "token: <redacted>");
  assert.ok(!jwtRedacted.includes("eyJhbGci"));
  assert.ok(!jwtRedacted.includes("SflKxw"));

  const bearerJwtRedacted = redactSecrets(`Authorization: Bearer ${fullJwt}`);
  assert.equal(bearerJwtRedacted, "Authorization: Bearer <redacted>");
  assert.ok(!bearerJwtRedacted.includes("eyJhbGci"));
});


test("retry is skipped if remaining budget < minRetryBudgetMs", async () => {
  let simulatedTime = 1000;
  const fakeNow = () => simulatedTime;

  let spawnCalls = 0;
  const mockSpawn = () => {
    spawnCalls++;
    const child = createMockChild();
    queueMicrotask(() => {
      // Advance clock so remaining budget becomes less than minRetryBudgetMs
      simulatedTime += 25_000;
    });
    return child;
  };

  // Total budget 30s, minRetry 15s. After 25s elapsed, remaining is 5s < 15s -> no retry!
  await assert.rejects(
    async () => {
      await runCline(
        { prompt: "test", timeoutSeconds: 30 },
        undefined,
        {
          deps: {
            spawn: mockSpawn as any,
            entryPath: "mock/cline",
            access: async () => {},
            now: fakeNow,
            totalBudgetMs: 30_000,
            timeoutMs: 15,
            backoffMs: 0,
            closeGracePeriodMs: 5,
            killGracePeriodMs: 5,
            settlementDeadlineMs: 10,
            minRetryBudgetMs: 15_000
          }
        }
      );
    },
    (err: unknown) => {
      assert.ok(err instanceof ClineRunError);
      assert.equal(err.kind, "timeout");
      return true;
    }
  );

  assert.equal(spawnCalls, 1);
});


function fakeClock() {
  let time = 0;
  const tasks = new Map<object, { at: number; fn: () => void }>();
  const schedule = ((fn: () => void, ms = 0) => {
    const handle = { unref() {} };
    tasks.set(handle, { at: time + ms, fn });
    return handle;
  }) as unknown as typeof setTimeout;
  const clear = ((handle: object) => { tasks.delete(handle); }) as unknown as typeof clearTimeout;
  return {
    now: () => time, advance: (ms: number) => { time += ms; },
    schedule, clear,
    sleep: async (ms: number) => { time += ms; },
    async finish<T>(promise: Promise<T>): Promise<T> {
      let done = false;
      const observed = promise.finally(() => { done = true; });
      // Consume rejection while fake timers and asynchronous filesystem operations settle.
      observed.catch(() => {});
      for (let i = 0; !done && i < 5000; i++) {
        await new Promise<void>(resolve => setImmediate(resolve));
        const next = [...tasks.entries()].sort((a, b) => a[1].at - b[1].at)[0];
        if (next) { tasks.delete(next[0]); time = Math.max(time, next[1].at); next[1].fn(); }
      }
      assert.equal(done, true, "fake-clock request must settle");
      assert.equal(tasks.size, 0, "all timers must be cleared");
      return observed;
    }
  };
}

test("one deadline includes mutex wait, hung child, kill and settlement grace", async () => {
  const clock = fakeClock();
  let killedAt: number | undefined;
  let spawnAt: number | undefined;
  let calls = 0;
  const work = runCline({ prompt: "test", provider: "fake", model: "fake" }, undefined, { deps: {
    entryPath: "fake", access: async () => {}, providerSettingsPath: path.join(isolatedSettingsDir, "deadline.json"),
    now: clock.now, setTimeout: clock.schedule, clearTimeout: clock.clear, sleep: clock.sleep,
    totalBudgetMs: 100, minRetryBudgetMs: 15,
    closeGracePeriodMs: 500, killGracePeriodMs: 500, settlementDeadlineMs: 1500,
    acquireSettingsMutex: async (_file, _signal, opts) => {
      assert.equal(opts?.deadline, 100); await clock.sleep(70); return async () => {};
    },
    killTree: () => { killedAt = clock.now(); },
    spawn: (() => {
      calls++; spawnAt = clock.now();
      const child = createMockChild(); child.pid = 123; child.kill = () => {};
      return child;
    }) as any
  } });
  await assert.rejects(clock.finish(work), (err: unknown) => err instanceof ClineRunError && err.kind === "timeout");
  assert.equal(calls, 1); assert.equal(spawnAt, 70);
  assert.equal(killedAt, 100); assert.equal(clock.now(), 100);
});

test("kill and settlement grace use remaining time when termination starts", async () => {
  const clock = fakeClock();
  let treeKilledAt: number | undefined;
  let calls = 0;
  const work = runCline({ prompt: "test" }, undefined, { deps: {
    platform: "linux", entryPath: "fake", access: async () => {}, now: clock.now,
    setTimeout: clock.schedule, clearTimeout: clock.clear, sleep: clock.sleep,
    totalBudgetMs: 100, minRetryBudgetMs: 50, timeoutMs: 10,
    killGracePeriodMs: 500, settlementDeadlineMs: 1500,
    killTree: () => { treeKilledAt = clock.now(); },
    spawn: (() => {
      calls++; const child = createMockChild(); child.pid = 42; child.kill = () => {};
      queueMicrotask(() => clock.advance(80));
      return child;
    }) as any
  } });
  await assert.rejects(clock.finish(work), (err: unknown) => err instanceof ClineRunError && err.kind === "timeout");
  assert.equal(treeKilledAt, 100); assert.equal(clock.now(), 100); assert.equal(calls, 1);
});

test("exit-without-close grace is clamped when exit arrives near the deadline", async () => {
  const clock = fakeClock();
  const work = runCline({ prompt: "test" }, undefined, { deps: {
    entryPath: "fake", access: async () => {}, now: clock.now,
    setTimeout: clock.schedule, clearTimeout: clock.clear, sleep: clock.sleep,
    totalBudgetMs: 100, minRetryBudgetMs: 1000, closeGracePeriodMs: 500,
    spawn: (() => {
      const child = createMockChild();
      queueMicrotask(() => {
        clock.advance(90);
        child.stdout.emit("data", JSON.stringify({ type: "run_result", finishReason: "completed", text: "done" }));
        child.emit("exit", 0, null);
      });
      return child;
    }) as any
  } });
  assert.equal((await clock.finish(work)).text, "done");
  assert.equal(clock.now(), 100);
});

test("retry backoff preserves minimum retry budget within the same deadline", async () => {
  const clock = fakeClock();
  const spawnTimes: number[] = [];
  const work = runCline({ prompt: "test" }, undefined, { deps: {
    entryPath: "fake", access: async () => {}, now: clock.now,
    setTimeout: clock.schedule, clearTimeout: clock.clear, sleep: clock.sleep,
    totalBudgetMs: 100, minRetryBudgetMs: 30, backoffMs: 200,
    spawn: (() => {
      spawnTimes.push(clock.now());
      const child = createMockChild();
      queueMicrotask(() => {
        if (spawnTimes.length === 1) {
          clock.advance(40); child.stderr.emit("data", "HTTP 503 overloaded"); child.emit("close", 1);
        } else {
          child.stdout.emit("data", JSON.stringify({ type: "run_result", finishReason: "completed", text: "recovered" }));
          child.emit("close", 0);
        }
      });
      return child;
    }) as any
  } });
  assert.equal((await clock.finish(work)).text, "recovered");
  assert.deepEqual(spawnTimes, [0, 70]);
  assert.ok(clock.now() <= 100);
});


test("attempt timeout is calculated after entry access consumes global budget", async () => {
  const clock = fakeClock();
  let flags: string[] = [];
  const work = runCline({ prompt: "test", timeoutSeconds: 100 }, undefined, { deps: {
    entryPath: "fake", access: async () => { clock.advance(70_000); }, now: clock.now,
    setTimeout: clock.schedule, clearTimeout: clock.clear, sleep: clock.sleep,
    totalBudgetMs: 100_000, minRetryBudgetMs: 15_000,
    killTree: () => {},
    spawn: ((_exe: string, args: string[]) => {
      flags = args; const child = createMockChild(); child.kill = () => {}; return child;
    }) as any
  } });
  await assert.rejects(clock.finish(work), (err: unknown) => err instanceof ClineRunError && err.kind === "timeout");
  assert.equal(flags[flags.indexOf("--timeout") + 1], "30");
  assert.equal(clock.now(), 100_000);
});

test("retry permission check cannot consume the minimum retry budget and still launch again", async () => {
  const clock = fakeClock(); let calls = 0;
  const work = runCline({ prompt: "test" }, undefined, {
    canRetry: async () => { clock.advance(80); return true; },
    deps: {
      entryPath: "fake", access: async () => {}, now: clock.now,
      setTimeout: clock.schedule, clearTimeout: clock.clear, sleep: clock.sleep,
      totalBudgetMs: 100, minRetryBudgetMs: 30,
      spawn: (() => {
        calls++; const child = createMockChild();
        queueMicrotask(() => { child.stderr.emit("data", "HTTP 503 overloaded"); child.emit("close", 1); });
        return child;
      }) as any
    }
  });
  await assert.rejects(clock.finish(work), (err: unknown) => err instanceof ClineRunError && err.kind === "transient_provider_error");
  assert.equal(calls, 1); assert.equal(clock.now(), 80);
});


test("POSIX default tree kill signals the negative process-group PID", t => {
  const calls: unknown[][] = [];
  t.mock.method(process, "kill", (...args: unknown[]) => { calls.push(args); return true; });
  defaultKillTree(4321, "SIGTERM", "linux");
  defaultKillTree(4321, "SIGKILL", "linux");
  assert.deepEqual(calls, [[-4321, "SIGTERM"], [-4321, "SIGKILL"]]);
});

test("Windows kills the live tree first and never kills the root separately", async () => {
  const clock = fakeClock(); const calls: string[] = [];
  let child: any;
  const work = runCline({ prompt: "test" }, undefined, { deps: {
    platform: "win32", entryPath: "fake", access: async () => {}, now: clock.now,
    setTimeout: clock.schedule, clearTimeout: clock.clear,
    totalBudgetMs: 100, timeoutMs: 10, minRetryBudgetMs: 1000,
    killTree: pid => {
      assert.equal(pid, 4321); calls.push("tree");
      child.emit("exit", 143, null); // Root exits while its pipes remain open.
    },
    spawn: ((_exe: string, _args: string[], options: any) => {
      assert.equal(options.detached, false);
      child = createMockChild(); child.pid = 4321;
      child.kill = () => { calls.push("root"); };
      return child;
    }) as any
  } });
  await assert.rejects(clock.finish(work), (err: unknown) => err instanceof ClineRunError && err.kind === "timeout");
  assert.deepEqual(calls, ["tree"]);
});

test("POSIX spawns a process group then sends TERM and KILL to the injectable tree killer", async () => {
  const clock = fakeClock(); const signals: Array<NodeJS.Signals | undefined> = [];
  const work = runCline({ prompt: "test" }, undefined, { deps: {
    platform: "linux", entryPath: "fake", access: async () => {}, now: clock.now,
    setTimeout: clock.schedule, clearTimeout: clock.clear,
    totalBudgetMs: 100, timeoutMs: 10, minRetryBudgetMs: 1000,
    killGracePeriodMs: 10, settlementDeadlineMs: 30,
    killTree: (pid, signal) => { assert.equal(pid, 4321); signals.push(signal); },
    spawn: ((_exe: string, _args: string[], options: any) => {
      assert.equal(options.detached, true);
      const child = createMockChild(); child.pid = 4321;
      child.kill = () => { assert.fail("must target the whole process group"); };
      return child;
    }) as any
  } });
  await assert.rejects(clock.finish(work), (err: unknown) => err instanceof ClineRunError && err.kind === "timeout");
  assert.deepEqual(signals, ["SIGTERM", "SIGKILL"]);
});

test("POSIX kills the remaining group once after root exit even when stdio never closes", async () => {
  const clock = fakeClock(); const signals: Array<NodeJS.Signals | undefined> = [];
  let child: any;
  const work = runCline({ prompt: "test" }, undefined, { deps: {
    platform: "linux", entryPath: "fake", access: async () => {}, now: clock.now,
    setTimeout: clock.schedule, clearTimeout: clock.clear,
    totalBudgetMs: 100, timeoutMs: 10, minRetryBudgetMs: 1000,
    killGracePeriodMs: 10, settlementDeadlineMs: 30, closeGracePeriodMs: 100,
    killTree: (_pid, signal) => {
      signals.push(signal);
      queueMicrotask(() => child.emit("exit", 143, null));
    },
    spawn: (() => {
      child = createMockChild(); child.pid = 4321; child.kill = () => assert.fail("root kill"); return child;
    }) as any
  } });
  await assert.rejects(clock.finish(work), (err: unknown) => err instanceof ClineRunError && err.kind === "timeout");
  assert.deepEqual(signals, ["SIGTERM", "SIGKILL"]);
});

test("timeout after an observed exit never signals the exited PID", async () => {
  const clock = fakeClock();
  const work = runCline({ prompt: "test" }, undefined, { deps: {
    platform: "win32", entryPath: "fake", access: async () => {}, now: clock.now,
    setTimeout: clock.schedule, clearTimeout: clock.clear,
    totalBudgetMs: 100, timeoutMs: 10, minRetryBudgetMs: 1000, closeGracePeriodMs: 100,
    killTree: () => assert.fail("PID could already have been reused"),
    spawn: (() => {
      const child = createMockChild(); child.pid = 4321; child.kill = () => assert.fail("root kill");
      queueMicrotask(() => child.emit("exit", 1, null)); return child;
    }) as any
  } });
  await assert.rejects(clock.finish(work), (err: unknown) => err instanceof ClineRunError && err.kind === "timeout");
});


test("POSIX kills the group once after normal root exit, without killing the exited root", async () => {
  const clock = fakeClock(); const signals: Array<NodeJS.Signals | undefined> = [];
  const work = runCline({ prompt: "test" }, undefined, { deps: {
    platform: "linux", entryPath: "fake", access: async () => {}, now: clock.now,
    setTimeout: clock.schedule, clearTimeout: clock.clear,
    totalBudgetMs: 100, minRetryBudgetMs: 1000, closeGracePeriodMs: 10,
    killTree: (pid, signal) => { assert.equal(pid, 4321); signals.push(signal); },
    spawn: (() => {
      const child = createMockChild(); child.pid = 4321; child.kill = () => assert.fail("exited root kill");
      queueMicrotask(() => {
        child.stdout.emit("data", JSON.stringify({ type: "run_result", finishReason: "completed", text: "done" }));
        child.emit("exit", 0, null);
        child.emit("exit", 0, null); // Duplicate notifications cannot repeat the group kill.
      });
      return child;
    }) as any
  } });
  assert.equal((await clock.finish(work)).text, "done");
  assert.deepEqual(signals, ["SIGKILL"]);
});
