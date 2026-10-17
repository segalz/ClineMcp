import assert from "node:assert/strict";
import test from "node:test";
import {
  parseClineJsonl,
  parseUsableResult,
  extractLastJsonlError,
  JsonlParseError
} from "../parser.js";

test("extracts only the final run_result from JSONL", () => {
  const output = [
    JSON.stringify({ type: "assistant_text_delta", text: "hidden streamed text" }),
    JSON.stringify({ type: "reasoning_delta", text: "hidden reasoning" }),
    JSON.stringify({ type: "run_result", text: "Cline bridge test successful.", model: { provider: "cline", id: "z-ai/glm-5.3-flash" }, usage: { inputTokens: 12, outputTokens: 6 }, totalCost: 0.001, durationMs: 42 })
  ].join("\n");

  assert.deepEqual(parseClineJsonl(output), {
    text: "Cline bridge test successful.",
    model: "cline/z-ai/glm-5.3-flash",
    usage: { inputTokens: 12, outputTokens: 6 },
    cost: 0.001,
    durationMs: 42
  });
});

test("extracts agent_event done when no run_result is emitted", () => {
  const output = [
    JSON.stringify({ type: "assistant_text_delta", text: "streamed delta" }),
    JSON.stringify({ type: "agent_event", event: { type: "done", reason: "completed", text: "Agent completed task." } })
  ].join("\n");

  assert.deepEqual(parseClineJsonl(output), {
    text: "Agent completed task.",
    model: undefined,
    usage: undefined,
    cost: undefined,
    durationMs: undefined
  });
});

test("ignores run_result with finishReason error", () => {
  const output = [
    JSON.stringify({ type: "run_result", finishReason: "error", text: "Upstream error from Nvidia: Service temporarily overloaded" })
  ].join("\n");

  assert.throws(() => parseClineJsonl(output), JsonlParseError);
});

test("extractLastJsonlError extracts error message from stderr or stdout JSONL", () => {
  const stderr = JSON.stringify({ type: "error", message: "session not found: abc-123" });
  assert.equal(extractLastJsonlError("", stderr), "session not found: abc-123");

  const stdout = JSON.stringify({ type: "run_result", finishReason: "error", text: "Service temporarily overloaded" });
  assert.equal(extractLastJsonlError(stdout, ""), "Service temporarily overloaded");
});

test("parseUsableResult checks finishReason for non-zero exit codes", () => {
  const completedOutput = JSON.stringify({ type: "run_result", finishReason: "completed", text: "OK" });
  assert.ok(parseUsableResult(completedOutput, 1));

  const uncompletedOutput = JSON.stringify({ type: "run_result", text: "OK" });
  // Non-completed run_result is rejected on non-zero exit
  assert.equal(parseUsableResult(uncompletedOutput, 1), undefined);
  // But accepted on exit 0
  assert.ok(parseUsableResult(uncompletedOutput, 0));
});
