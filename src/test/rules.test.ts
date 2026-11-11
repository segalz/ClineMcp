import assert from "node:assert/strict";
import test from "node:test";
import { WORKING_RULES } from "../rules.js";
import { buildWorkspaceSystemPrompt, WORKSPACE_SYSTEM_PROMPT } from "../workspace.js";
import { buildEditSystemPrompt, EDIT_SYSTEM_PROMPT } from "../edits.js";
import { MAX_SYSTEM_PROMPT_CHARACTERS, NO_TOOLS_PREAMBLE } from "../runner.js";

test("workspace and edits retain shared working rules within the system prompt limit", () => {
  for (const prompt of [WORKSPACE_SYSTEM_PROMPT, EDIT_SYSTEM_PROMPT]) {
    assert.ok(prompt.endsWith(WORKING_RULES));
    assert.ok(prompt.length <= MAX_SYSTEM_PROMPT_CHARACTERS);
  }
  assert.match(WORKSPACE_SYSTEM_PROMPT, /analysis-only/);
  assert.match(EDIT_SYSTEM_PROMPT, /summarize the changed files and verification/);
  assert.ok(!NO_TOOLS_PREAMBLE.includes(WORKING_RULES));
});

test("working rules match the measured rule text exactly, separated by newlines", () => {
  assert.equal(WORKING_RULES, [
    "Working rules (each tool step resends the whole conversation, so fewer, larger steps cost less):",
    "1. Batch: put all independent reads and searches into one step.",
    "2. To find or list a pattern across files, use one search_codebase call with all the regexes you need instead of reading files.",
    "3. If a Code map is given, its names and line numbers are exact for HEAD: use them directly and do not re-verify them.",
    "4. When you must read, read a file under about 600 lines whole in one call; for a longer file read only the ranges you need, each at least 200 lines. Never page through a file in small slices and never re-read lines you already have.",
    "5. Never repeat a failing call. After 2 failures on the same file or command, change approach or stop and report what failed.",
    "6. Stop as soon as the requested output is complete and follow the requested output format exactly."
  ].join("\n"));
});

test("both prompt builders prepend the run cwd and OS before mode instructions and rules", () => {
  const cwd = "C:\\Test Repo\\current-run";
  for (const [build, modeText, location] of [
    [buildWorkspaceSystemPrompt, WORKSPACE_SYSTEM_PROMPT, "a disposable Git worktree of the repository"],
    [buildEditSystemPrompt, EDIT_SYSTEM_PROMPT, "the repository checkout"]
  ] as const) {
    const environment = `Environment: the working directory is ${cwd} (${location}). Use paths relative to it, or absolute paths under it. `;
    const windows = build(cwd, "win32");
    assert.equal(windows, environment + "The OS is Windows; shell commands run on Windows, so do not use Unix-only tools such as find, grep or sed.\n" + modeText);
    assert.equal(build(cwd, "linux"), environment + "The OS is linux.\n" + modeText);
    assert.equal(build(cwd, "darwin"), environment + "The OS is darwin.\n" + modeText);
    assert.ok(windows.length <= MAX_SYSTEM_PROMPT_CHARACTERS);
    assert.ok(windows.endsWith(WORKING_RULES));
  }
});
