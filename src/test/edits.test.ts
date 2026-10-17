import assert from "node:assert/strict";
import test from "node:test";
import { ClineEditsError, truncateGitDiff } from "../edits.js";
import { ClineRunError, formatErrorAsText, hasMadeToolCallsOrModifications } from "../runner.js";

test("keeps a diff at or below the response limit", () => {
  const diff = "x".repeat(48_000);
  assert.equal(truncateGitDiff(diff), diff);
});

test("marks an oversized diff as truncated", () => {
  const result = truncateGitDiff("x".repeat(48_001));
  assert.match(result, /Diff truncated at 48000 characters/);
  assert.ok(result.length > 48_000);
});

test("preserves Git evidence for a prohibited commit", () => {
  const error = new ClineEditsError("commit_created", "commit detected", {
    headBefore: "before",
    headAfter: "after",
    gitDiff: "diff",
    status: "M file.ts"
  });
  assert.equal(error.kind, "commit_created");
  assert.deepEqual(error.evidence, {
    headBefore: "before",
    headAfter: "after",
    gitDiff: "diff",
    status: "M file.ts"
  });
});

test("detects tool calls and modifications in stdout", () => {
  assert.equal(
    hasMadeToolCallsOrModifications(JSON.stringify({ type: "tool_call", name: "write_to_file" })),
    true
  );
  assert.equal(
    hasMadeToolCallsOrModifications(JSON.stringify({ type: "agent_event", event: { type: "tool_use" } })),
    true
  );
  assert.equal(
    hasMadeToolCallsOrModifications(JSON.stringify({ type: "run_result", finishReason: "error", text: "overloaded" })),
    false
  );
});

test("formats ClineRunError and ClineEditsError as readable text with kind, message, exit code, tails, attempts", () => {
  const err = new ClineRunError("transient_provider_error", "Service overloaded", {
    exitCode: 1,
    attempts: 2,
    stderrTail: "tail-stderr",
    stdoutTail: "tail-stdout"
  });
  const text = formatErrorAsText(err, "fallback");
  assert.match(text, /Kind: transient_provider_error/);
  assert.match(text, /Message: Service overloaded/);
  assert.match(text, /Exit code: 1/);
  assert.match(text, /Attempts: 2/);
  assert.match(text, /Stderr tail:\ntail-stderr/);
  assert.match(text, /Stdout tail:\ntail-stdout/);

  const editsErr = new ClineEditsError("commit_created", "HEAD changed", {
    headBefore: "h1",
    headAfter: "h2"
  });
  const editsText = formatErrorAsText(editsErr, "fallback");
  assert.match(editsText, /Kind: commit_created/);
  assert.match(editsText, /Evidence:/);
  assert.match(editsText, /"headBefore": "h1"/);
});

