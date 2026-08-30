import assert from "node:assert/strict";
import test from "node:test";
import {
  ClineRunError,
  MAX_PROMPT_CHARACTERS,
  MAX_SYSTEM_PROMPT_CHARACTERS,
  MAX_TOTAL_TEXT_CHARACTERS,
  validateInputLimits
} from "../runner.js";

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
