import assert from "node:assert/strict";
import test from "node:test";
import { parseClineJsonl } from "../parser.js";

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
