import assert from "node:assert/strict";
import test from "node:test";
import { ClineEditsError, truncateGitDiff } from "../edits.js";

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
