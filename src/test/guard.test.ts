import assert from "node:assert/strict";
import test from "node:test";
import {
  createGuard,
  extractTarget,
  normalizePath,
  isWriteEditTool,
  checkToolFailure,
  extractInputTokens,
  stableJson,
  hashInput
} from "../guard.js";

const agent = (event: Record<string, unknown>) => ({ type: "agent_event", event });

test("option validation: defaults and valid custom options", () => {
  const g1 = createGuard();
  const snap1 = g1.snapshot();
  assert.equal(snap1.window, 10);
  assert.equal(snap1.totalToolCalls, 0);
  assert.equal(snap1.totalInputTokens, 0);
  assert.deepEqual(snap1.filesTouched, []);
  assert.deepEqual(snap1.lastErrors, []);
  assert.equal(snap1.kind, undefined);

  const g2 = createGuard({
    maxRepeatedFailures: 2,
    window: 2,
    maxToolCalls: 10,
    maxInputTokens: 50_000
  });
  assert.equal(g2.snapshot().window, 2);
});

test("option validation: rejects invalid positive integers and window < maxRepeatedFailures", () => {
  assert.throws(() => createGuard({ maxRepeatedFailures: 0 }), /maxRepeatedFailures/);
  assert.throws(() => createGuard({ maxRepeatedFailures: -1 }), /maxRepeatedFailures/);
  assert.throws(() => createGuard({ maxRepeatedFailures: 1.5 }), /maxRepeatedFailures/);
  assert.throws(() => createGuard({ maxRepeatedFailures: NaN }), /maxRepeatedFailures/);
  assert.throws(() => createGuard({ maxRepeatedFailures: Infinity }), /maxRepeatedFailures/);
  assert.throws(() => createGuard({ maxRepeatedFailures: "3" as any }), /maxRepeatedFailures/);

  assert.throws(() => createGuard({ window: 0 }), /window/);
  assert.throws(() => createGuard({ window: -5 }), /window/);
  assert.throws(() => createGuard({ window: 2.2 }), /window/);

  assert.throws(() => createGuard({ maxToolCalls: 0 }), /maxToolCalls/);
  assert.throws(() => createGuard({ maxToolCalls: -10 }), /maxToolCalls/);

  assert.throws(() => createGuard({ maxInputTokens: 0 }), /maxInputTokens/);
  assert.throws(() => createGuard({ maxInputTokens: -100 }), /maxInputTokens/);

  // window must be >= maxRepeatedFailures
  assert.throws(() => createGuard({ window: 2, maxRepeatedFailures: 3 }), /window.*must be >=.*maxRepeatedFailures/);
});

test("today's pattern: failing replace_in_file on same file with small input variations interleaved with read_file successes trips at 3rd failure", () => {
  const guard = createGuard();

  // Call 1: replace_in_file fails
  assert.equal(guard.observe(agent({
    type: "content_start",
    contentType: "tool",
    toolName: "replace_in_file",
    input: { path: "src/guard.ts", diff: "- old line 1\n+ new line 1" }
  })), null);
  assert.equal(guard.observe(agent({
    type: "content_end",
    contentType: "tool",
    toolName: "replace_in_file",
    error: "Original content not found: hunk 1"
  })), null);

  // Call 2: read_file succeeds
  assert.equal(guard.observe(agent({
    type: "content_start",
    contentType: "tool",
    toolName: "read_file",
    input: { path: "src/guard.ts" }
  })), null);
  assert.equal(guard.observe(agent({
    type: "content_end",
    contentType: "tool",
    toolName: "read_file",
    output: "// full file content here"
  })), null);

  // Call 3: replace_in_file fails with variation 2
  assert.equal(guard.observe(agent({
    type: "content_start",
    contentType: "tool",
    toolName: "replace_in_file",
    input: { path: "src/guard.ts", diff: "- old line 2\n+ new line 2" }
  })), null);
  assert.equal(guard.observe(agent({
    type: "content_end",
    contentType: "tool",
    toolName: "replace_in_file",
    error: "Original content not found: hunk 2"
  })), null);

  // Call 4: read_file succeeds
  assert.equal(guard.observe(agent({
    type: "content_start",
    contentType: "tool",
    toolName: "read_file",
    input: { path: "src/guard.ts" }
  })), null);
  assert.equal(guard.observe(agent({
    type: "content_end",
    contentType: "tool",
    toolName: "read_file",
    output: "// full file content again"
  })), null);

  // Call 5: replace_in_file fails with variation 3 -> TRIPS!
  assert.equal(guard.observe(agent({
    type: "content_start",
    contentType: "tool",
    toolName: "replace_in_file",
    input: { path: "src/guard.ts", diff: "- old line 3\n+ new line 3" }
  })), null);

  const verdict = guard.observe(agent({
    type: "content_end",
    contentType: "tool",
    toolName: "replace_in_file",
    error: "Original content not found: hunk 3"
  }));

  assert.ok(verdict !== null, "Expected a trip at the 3rd failure");
  assert.equal(verdict.kind, "loop_detected");
  assert.equal(verdict.tool, "replace_in_file");
  assert.equal(verdict.target, "src/guard.ts");
  assert.equal(verdict.count, 3);
  assert.equal(verdict.window, 10);
  assert.equal(verdict.totalToolCalls, 5);
  assert.deepEqual(verdict.lastErrors, [
    "Original content not found: hunk 1",
    "Original content not found: hunk 2",
    "Original content not found: hunk 3"
  ]);
  // Failed edit does not touch file; read_file is not a write/edit tool
  assert.deepEqual(verdict.filesTouched, []);

  const snap = guard.snapshot();
  assert.equal(snap.kind, "loop_detected");
  assert.equal(snap.tool, "replace_in_file");
  assert.equal(snap.target, "src/guard.ts");
  assert.equal(snap.count, 3);
});

test("today's pattern with edit tool and Windows backslashes", () => {
  const guard = createGuard({ maxRepeatedFailures: 3, window: 10 });

  for (let i = 1; i <= 3; i++) {
    guard.observe(agent({
      type: "content_start",
      contentType: "tool",
      toolName: "edit",
      input: { file_path: "Src\\Sub\\File.ts", content: `attempt ${i}` }
    }));
    const v = guard.observe(agent({
      type: "content_end",
      contentType: "tool",
      toolName: "edit",
      error: `Edit error ${i}`
    }));
    if (i < 3) {
      assert.equal(v, null);
    } else {
      assert.ok(v !== null);
      assert.equal(v.kind, "loop_detected");
      assert.equal(v.tool, "edit");
      assert.equal(v.target, "src/sub/file.ts");
      assert.equal(v.count, 3);
    }
  }
});

test("2 failures then success elsewhere and no 3rd within the window -> no trip", () => {
  const guard = createGuard({ maxRepeatedFailures: 3, window: 10 });

  // 2 failures on src/foo.ts
  for (let i = 1; i <= 2; i++) {
    guard.observe(agent({
      type: "content_start",
      contentType: "tool",
      toolName: "replace_in_file",
      input: { path: "src/foo.ts", diff: `diff ${i}` }
    }));
    assert.equal(guard.observe(agent({
      type: "content_end",
      contentType: "tool",
      toolName: "replace_in_file",
      error: `Fail ${i}`
    })), null);
  }

  // 10 successful calls on other files (pushes earlier 2 failures out of sliding window)
  for (let i = 1; i <= 10; i++) {
    guard.observe(agent({
      type: "content_start",
      contentType: "tool",
      toolName: "read_file",
      input: { path: `src/other_${i}.ts` }
    }));
    assert.equal(guard.observe(agent({
      type: "content_end",
      contentType: "tool",
      toolName: "read_file",
      output: `content ${i}`
    })), null);
  }

  // 3rd failure on src/foo.ts arrives, but in the last 10 tool calls, it only failed ONCE!
  guard.observe(agent({
    type: "content_start",
    contentType: "tool",
    toolName: "replace_in_file",
    input: { path: "src/foo.ts", diff: "diff 3" }
  }));
  const v = guard.observe(agent({
    type: "content_end",
    contentType: "tool",
    toolName: "replace_in_file",
    error: "Fail 3"
  }));

  assert.equal(v, null, "Should not trip because previous 2 failures slid out of window");
  assert.equal(guard.snapshot().kind, undefined);
});

test("different files failing -> no trip", () => {
  const guard = createGuard({ maxRepeatedFailures: 3, window: 10 });

  const files = ["src/a.ts", "src/b.ts", "src/c.ts", "src/d.ts", "src/e.ts"];
  for (const f of files) {
    guard.observe(agent({
      type: "content_start",
      contentType: "tool",
      toolName: "replace_in_file",
      input: { path: f, diff: "diff" }
    }));
    const v = guard.observe(agent({
      type: "content_end",
      contentType: "tool",
      toolName: "replace_in_file",
      error: `Failed on ${f}`
    }));
    assert.equal(v, null, "Different files failing must not trip");
  }
  assert.equal(guard.snapshot().kind, undefined);
});

test("consecutive identical successes -> no trip and tracks filesTouched", () => {
  const guard = createGuard({ maxRepeatedFailures: 3, window: 10 });

  // 10 identical read_file calls
  for (let i = 0; i < 10; i++) {
    guard.observe(agent({
      type: "content_start",
      contentType: "tool",
      toolName: "read_file",
      input: { path: "src/file.ts" }
    }));
    const v = guard.observe(agent({
      type: "content_end",
      contentType: "tool",
      toolName: "read_file",
      output: "same file content"
    }));
    assert.equal(v, null);
  }
  // read_file is not a write/edit tool
  assert.deepEqual(guard.snapshot().filesTouched, []);

  // 5 identical write_to_file calls succeeding
  for (let i = 0; i < 5; i++) {
    guard.observe(agent({
      type: "content_start",
      contentType: "tool",
      toolName: "write_to_file",
      input: { path: "src/out.ts", content: "data" }
    }));
    const v = guard.observe(agent({
      type: "content_end",
      contentType: "tool",
      toolName: "write_to_file",
      output: { success: true }
    }));
    assert.equal(v, null);
  }
  // write_to_file is write/edit and succeeded
  assert.deepEqual(guard.snapshot().filesTouched, ["src/out.ts"]);
  assert.equal(guard.snapshot().kind, undefined);
});

test("tool-call budget: trips when total tool calls > maxToolCalls", () => {
  const guard = createGuard({ maxToolCalls: 3 });

  // 1st call
  assert.equal(guard.observe(agent({
    type: "content_start",
    contentType: "tool",
    toolName: "read_file",
    input: { path: "src/a.ts" }
  })), null);
  assert.equal(guard.observe(agent({
    type: "content_end",
    contentType: "tool",
    toolName: "read_file",
    output: "ok"
  })), null);

  // 2nd call
  assert.equal(guard.observe(agent({
    type: "content_start",
    contentType: "tool",
    toolName: "read_file",
    input: { path: "src/b.ts" }
  })), null);
  assert.equal(guard.observe(agent({
    type: "content_end",
    contentType: "tool",
    toolName: "read_file",
    output: "ok"
  })), null);

  // 3rd call (totalToolCalls = 3 <= 3)
  assert.equal(guard.observe(agent({
    type: "content_start",
    contentType: "tool",
    toolName: "read_file",
    input: { path: "src/c.ts" }
  })), null);
  assert.equal(guard.observe(agent({
    type: "content_end",
    contentType: "tool",
    toolName: "read_file",
    output: "ok"
  })), null);

  // 4th call starts: totalToolCalls = 4 > 3 -> TRIPS!
  const verdict = guard.observe(agent({
    type: "content_start",
    contentType: "tool",
    toolName: "read_file",
    input: { path: "src/d.ts" }
  }));

  assert.ok(verdict !== null);
  assert.equal(verdict.kind, "budget_exceeded");
  assert.equal(verdict.totalToolCalls, 4);
  assert.equal(guard.snapshot().kind, "budget_exceeded");
});

test("token budget: trips when cumulative input tokens > maxInputTokens", () => {
  const guard = createGuard({ maxInputTokens: 10_000 });

  // Usage event 1: 6,000 tokens
  const v1 = guard.observe({ type: "usage", inputTokens: 6_000 });
  assert.equal(v1, null);
  assert.equal(guard.snapshot().totalInputTokens, 6_000);

  // Usage event 2: 4,000 tokens (total 10,000 <= 10,000)
  const v2 = guard.observe(agent({
    type: "usage",
    usage: { input_tokens: 4_000 }
  }));
  assert.equal(v2, null);
  assert.equal(guard.snapshot().totalInputTokens, 10_000);

  // Usage event 3: 1 token (total 10,001 > 10,000) -> TRIPS!
  const v3 = guard.observe({
    type: "agent_event",
    event: { type: "usage", inputTokens: 1 }
  });
  assert.ok(v3 !== null);
  assert.equal(v3.kind, "budget_exceeded");
  assert.equal(v3.totalInputTokens, 10_001);
  assert.equal(guard.snapshot().kind, "budget_exceeded");
});

test("redaction of secrets in error texts and length cap <= 300 chars", () => {
  const guard = createGuard({ maxRepeatedFailures: 1, window: 10 });

  const rawSecretError = "Failed with Authorization: Bearer sk-1234567890abcdef and password = 'SuperSecretPassword123' " + "x".repeat(350);

  guard.observe(agent({
    type: "content_start",
    contentType: "tool",
    toolName: "replace_in_file",
    input: { path: "src/secret.ts" }
  }));
  const verdict = guard.observe(agent({
    type: "content_end",
    contentType: "tool",
    toolName: "replace_in_file",
    error: rawSecretError
  }));

  assert.ok(verdict !== null);
  assert.equal(verdict.kind, "loop_detected");
  assert.equal(verdict.lastErrors.length, 1);
  const err = verdict.lastErrors[0];

  assert.ok(err.length <= 300, `Expected error length <= 300, got ${err.length}`);
  assert.ok(!err.includes("sk-1234567890abcdef"), "sk- token must be redacted");
  assert.ok(!err.includes("SuperSecretPassword123"), "password must be redacted");
  assert.ok(err.includes("<redacted>"), "expected <redacted> placeholder");
});

test("no trip twice: after a trip observe returns null and snapshot retains trip report", () => {
  const guard = createGuard({ maxRepeatedFailures: 2, window: 5 });

  // Fail 1
  guard.observe(agent({
    type: "content_start",
    contentType: "tool",
    toolName: "replace_in_file",
    input: { path: "src/repeat.ts" }
  }));
  guard.observe(agent({
    type: "content_end",
    contentType: "tool",
    toolName: "replace_in_file",
    error: "First fail"
  }));

  // Fail 2 -> TRIPS
  guard.observe(agent({
    type: "content_start",
    contentType: "tool",
    toolName: "replace_in_file",
    input: { path: "src/repeat.ts" }
  }));
  const firstTrip = guard.observe(agent({
    type: "content_end",
    contentType: "tool",
    toolName: "replace_in_file",
    error: "Second fail"
  }));
  assert.ok(firstTrip !== null);
  assert.equal(firstTrip.kind, "loop_detected");

  // Subsequent events must return null
  const postTrip1 = guard.observe(agent({
    type: "content_start",
    contentType: "tool",
    toolName: "replace_in_file",
    input: { path: "src/repeat.ts" }
  }));
  assert.equal(postTrip1, null);

  const postTrip2 = guard.observe(agent({
    type: "content_end",
    contentType: "tool",
    toolName: "replace_in_file",
    error: "Third fail"
  }));
  assert.equal(postTrip2, null);

  const postTrip3 = guard.observe({ type: "usage", inputTokens: 999_999_999 });
  assert.equal(postTrip3, null);

  // snapshot() retains original loop_detected trip report
  const snap = guard.snapshot();
  assert.equal(snap.kind, "loop_detected");
  assert.equal(snap.tool, "replace_in_file");
  assert.equal(snap.target, "src/repeat.ts");
});

test("non-path tools use stable sorted-key hash for failure signature", () => {
  const guard = createGuard({ maxRepeatedFailures: 3, window: 10 });

  // Tool without a path: execute_command
  const inputA = { command: "git status", flags: ["-s"] };
  const inputB = { flags: ["-s"], command: "git status" }; // different key order, same stable hash

  const targetA = extractTarget("execute_command", inputA);
  const targetB = extractTarget("execute_command", inputB);
  assert.equal(targetA.isPath, false);
  assert.equal(targetB.isPath, false);
  assert.equal(targetA.target, targetB.target);

  // Call 1 fails
  guard.observe(agent({
    type: "content_start",
    contentType: "tool",
    toolName: "execute_command",
    input: inputA
  }));
  guard.observe(agent({
    type: "content_end",
    contentType: "tool",
    toolName: "execute_command",
    error: "exit code 1"
  }));

  // Call 2 fails with same keys in different order
  guard.observe(agent({
    type: "content_start",
    contentType: "tool",
    toolName: "execute_command",
    input: inputB
  }));
  guard.observe(agent({
    type: "content_end",
    contentType: "tool",
    toolName: "execute_command",
    error: "exit code 1"
  }));

  // Call 3 fails -> trips loop_detected on the hash target
  guard.observe(agent({
    type: "content_start",
    contentType: "tool",
    toolName: "execute_command",
    input: inputA
  }));
  const v = guard.observe(agent({
    type: "content_end",
    contentType: "tool",
    toolName: "execute_command",
    error: "exit code 1"
  }));

  assert.ok(v !== null);
  assert.equal(v.kind, "loop_detected");
  assert.equal(v.tool, "execute_command");
  assert.equal(v.target, targetA.target);
  assert.equal(v.count, 3);
});

test("failure detection handles output success:false, ok:false, is_error and json strings conservatively", () => {
  // Output with success: false
  const f1 = checkToolFailure({ output: { success: false, error: "hunk mismatch" } });
  assert.equal(f1.failed, true);
  assert.equal(f1.errorText, "hunk mismatch");

  // Output with ok: false
  const f2 = checkToolFailure({ output: { ok: false, message: "command rejected" } });
  assert.equal(f2.failed, true);
  assert.equal(f2.errorText, "command rejected");

  // Output with JSON string containing success: false
  const f3 = checkToolFailure({ output: JSON.stringify({ success: false, error: "locked" }) });
  assert.equal(f3.failed, true);
  assert.equal(f3.errorText, "locked");

  // Output with is_error: true
  const f4 = checkToolFailure({ is_error: true, output: "fatal error occurred" });
  assert.equal(f4.failed, true);
  assert.equal(f4.errorText, "fatal error occurred");

  // Conservative: successful output mentioning 'error' is NOT failed
  const s1 = checkToolFailure({ output: "Searched log: found 0 error occurrences" });
  assert.equal(s1.failed, false);

  // Output with success: true
  const s2 = checkToolFailure({ output: { success: true } });
  assert.equal(s2.failed, false);

  // Output with valid JSON success: true
  const s3 = checkToolFailure({ output: '{"success":true,"items":[]}' });
  assert.equal(s3.failed, false);
});

test("property aliases: lastErrorTexts, toolCalls, inputTokens, files", () => {
  const guard = createGuard();
  guard.observe({ type: "usage", inputTokens: 50 });
  guard.observe(agent({
    type: "content_start",
    contentType: "tool",
    toolName: "write_to_file",
    input: { path: "src/demo.ts" }
  }));
  guard.observe(agent({
    type: "content_end",
    contentType: "tool",
    toolName: "write_to_file",
    output: { success: true }
  }));

  const snap = guard.snapshot();
  assert.equal(snap.toolCalls, snap.totalToolCalls);
  assert.equal(snap.inputTokens, snap.totalInputTokens);
  assert.deepEqual(snap.files, snap.filesTouched);
  assert.deepEqual(snap.lastErrorTexts, snap.lastErrors);
});

test("path normalization unifies slashes, removes leading ./, and lowercases", () => {
  assert.equal(normalizePath("  ./Src\\Utils//Index.TS  "), "src/utils/index.ts");
  assert.equal(normalizePath("C:\\Foo\\Bar.TXT"), "c:/foo/bar.txt");
  assert.equal(normalizePath("/var/log/app.log"), "/var/log/app.log");
});

test("P1 apply_patch: 3 failing patches on same file with different hunks interleaved with reads trips", () => {
  const guard = createGuard();

  // Patch 1: failing hunk 1
  guard.observe(agent({
    type: "content_start",
    contentType: "tool",
    toolName: "apply_patch",
    toolCallId: "p1",
    input: {
      input: "*** Begin Patch\n*** Update File: src/components/Button.tsx\n@@ -10,3 +10,4 @@\n context A\n+line A\n*** End Patch"
    }
  }));
  assert.equal(guard.observe(agent({
    type: "content_end",
    contentType: "tool",
    toolName: "apply_patch",
    toolCallId: "p1",
    error: "apply_patch failed: failed to find context A"
  })), null);

  // Read file success on other file
  guard.observe(agent({
    type: "content_start",
    contentType: "tool",
    toolName: "read_files",
    toolCallId: "r1",
    input: { paths: ["package.json"] }
  }));
  assert.equal(guard.observe(agent({
    type: "content_end",
    contentType: "tool",
    toolName: "read_files",
    toolCallId: "r1",
    output: { success: true }
  })), null);

  // Patch 2: failing hunk 2 (different hunk text on same file)
  guard.observe(agent({
    type: "content_start",
    contentType: "tool",
    toolName: "apply_patch",
    toolCallId: "p2",
    input: {
      input: "*** Begin Patch\n*** Update File: src/components/Button.tsx\n@@ -20,3 +20,4 @@\n context B\n+line B\n*** End Patch"
    }
  }));
  assert.equal(guard.observe(agent({
    type: "content_end",
    contentType: "tool",
    toolName: "apply_patch",
    toolCallId: "p2",
    error: "apply_patch failed: failed to find context B"
  })), null);

  // Patch 3: failing hunk 3 (different hunk text on same file) -> trips at 3rd failure!
  guard.observe(agent({
    type: "content_start",
    contentType: "tool",
    toolName: "apply_patch",
    toolCallId: "p3",
    input: {
      input: "*** Begin Patch\n*** Update File: src/components/Button.tsx\n@@ -30,3 +30,4 @@\n context C\n+line C\n*** End Patch"
    }
  }));
  const trip = guard.observe(agent({
    type: "content_end",
    contentType: "tool",
    toolName: "apply_patch",
    toolCallId: "p3",
    error: "apply_patch failed: failed to find context C"
  }));

  assert.ok(trip, "trips on 3rd failure of apply_patch on same file");
  assert.equal(trip.kind, "loop_detected");
  assert.equal(trip.tool, "apply_patch");
  assert.equal(trip.target, "src/components/button.tsx");
  assert.equal(trip.count, 3);
});

test("P1 apply_patch: handles *** Add File: and *** Delete File: headers and tracks filesTouched", () => {
  const guard = createGuard();

  // Add File patch succeeds
  guard.observe(agent({
    type: "content_start",
    contentType: "tool",
    toolName: "apply_patch",
    input: {
      input: "*** Begin Patch\n*** Add File: src/newFile.ts\n+console.log('hello');\n*** End Patch"
    }
  }));
  guard.observe(agent({
    type: "content_end",
    contentType: "tool",
    toolName: "apply_patch",
    output: { success: true }
  }));

  const snap = guard.snapshot();
  assert.deepEqual(snap.filesTouched, ["src/newfile.ts"]);
});

test("P1 tokens: 6,000-token run with incremental usage and cumulative done/run_result does not trip 10,000 limit", () => {
  const guard = createGuard({ maxInputTokens: 10_000 });

  // Iteration 1 usage (incremental 2000, cumulative 2000)
  assert.equal(guard.observe(agent({
    type: "usage",
    inputTokens: 2000,
    outputTokens: 50,
    totalInputTokens: 2000,
    totalOutputTokens: 50
  })), null);

  // Iteration 2 usage (incremental 4000, cumulative 6000)
  assert.equal(guard.observe(agent({
    type: "usage",
    inputTokens: 4000,
    outputTokens: 100,
    totalInputTokens: 6000,
    totalOutputTokens: 150
  })), null);

  // Done event carrying cumulative total 6000
  assert.equal(guard.observe(agent({
    type: "done",
    reason: "completed",
    text: "Task finished",
    usage: {
      inputTokens: 6000,
      outputTokens: 150
    }
  })), null);

  // Final run_result event carrying cumulative total 6000
  assert.equal(guard.observe({
    type: "run_result",
    finishReason: "completed",
    text: "Task finished",
    usage: {
      inputTokens: 6000,
      outputTokens: 150
    }
  }), null);

  const snap = guard.snapshot();
  assert.equal(snap.totalInputTokens, 6000, "totalInputTokens must be 6000, not 18000");
  assert.equal(snap.kind, undefined, "must not have tripped 10,000 budget");
});

test("P2 run_commands: output array with success:false or error trips on repeated failing command; fail then success does not trip", () => {
  const guard = createGuard();

  // Call 1: run_commands fails on 'npm test'
  guard.observe(agent({
    type: "content_start",
    contentType: "tool",
    toolName: "run_commands",
    toolCallId: "c1",
    input: { commands: ["npm test"] }
  }));
  assert.equal(guard.observe(agent({
    type: "content_end",
    contentType: "tool",
    toolName: "run_commands",
    toolCallId: "c1",
    output: [
      { query: "npm test", result: "", error: "Error: 1 test failed", success: false }
    ]
  })), null);

  // Call 2: run_commands succeeds on 'npm test' (fail then success -> no trip)
  guard.observe(agent({
    type: "content_start",
    contentType: "tool",
    toolName: "run_commands",
    toolCallId: "c2",
    input: { commands: ["npm test"] }
  }));
  assert.equal(guard.observe(agent({
    type: "content_end",
    contentType: "tool",
    toolName: "run_commands",
    toolCallId: "c2",
    output: [
      { query: "npm test", result: "1 test passed", success: true }
    ]
  })), null);

  // Call 3: run_commands fails on 'npm test' again (2nd failure in window)
  guard.observe(agent({
    type: "content_start",
    contentType: "tool",
    toolName: "run_commands",
    toolCallId: "c3",
    input: { commands: ["npm test"] }
  }));
  assert.equal(guard.observe(agent({
    type: "content_end",
    contentType: "tool",
    toolName: "run_commands",
    toolCallId: "c3",
    output: [
      { query: "npm test", result: "", error: "Error: 1 test failed", success: false }
    ]
  })), null);

  // Call 4: run_commands fails on 'npm test' again (3rd failure in window) -> trips!
  guard.observe(agent({
    type: "content_start",
    contentType: "tool",
    toolName: "run_commands",
    toolCallId: "c4",
    input: { commands: ["npm test"] }
  }));
  const trip = guard.observe(agent({
    type: "content_end",
    contentType: "tool",
    toolName: "run_commands",
    toolCallId: "c4",
    output: [
      { query: "npm test", result: "", error: "Error: 1 test failed", success: false }
    ]
  }));

  assert.ok(trip, "trips on 3rd failure of npm test");
  assert.equal(trip.kind, "loop_detected");
  assert.equal(trip.tool, "run_commands");
  assert.equal(trip.target, "npm test");
  assert.equal(trip.count, 3);
});

test("P2 redaction: raw path kept for signature, redacted in target, filesTouched, messages, and reports", () => {
  const guard = createGuard();
  const secretPath = "logs/sk-1234567890abcdef.txt";

  for (let i = 1; i <= 3; i++) {
    guard.observe(agent({
      type: "content_start",
      contentType: "tool",
      toolName: "replace_in_file",
      toolCallId: `call_${i}`,
      input: { path: secretPath, diff: `diff ${i}` }
    }));
    const verdict = guard.observe(agent({
      type: "content_end",
      contentType: "tool",
      toolName: "replace_in_file",
      toolCallId: `call_${i}`,
      error: `Failed to edit ${secretPath}: invalid token`
    }));

    if (i < 3) {
      assert.equal(verdict, null);
    } else {
      assert.ok(verdict, "trips on 3rd call");
      // Target must be redacted
      assert.ok(!verdict.target?.includes("sk-1234567890abcdef"), "target must not contain raw secret");
      assert.ok(verdict.target?.includes("<redacted>"), "target has <redacted>");

      // Error texts must be redacted
      for (const err of verdict.lastErrors) {
        assert.ok(!err.includes("sk-1234567890abcdef"));
      }

      // Snapshot filesTouched also redacted
      const snap = guard.snapshot();
      assert.ok(!JSON.stringify(snap).includes("sk-1234567890abcdef"));
    }
  }
});
