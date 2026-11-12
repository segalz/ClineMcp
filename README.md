# Local Cline MCP Bridge

This is a local stdio MCP server that exposes tools to interact with the authenticated Cline CLI: `ask_cline` (analysis/chat), `apply_cline_edits` (development tasks in the current Git checkout), and `ask_cline_workspace` (isolated Git workspace analysis in a temporary worktree).

## Requirements

- Node.js 20 or newer
- The Cline CLI already installed and authenticated (`cline.exe` on Windows)

## Install, build, and launch

```powershell
npm install
npm run build
npm test
npm start
```

`npm start` runs a stdio server, so it will appear idle until an MCP client connects. Do not type prompts into that terminal.

## MCP client configuration

Build first, then add this server to an MCP client that supports stdio servers:

```json
{
  "mcpServers": {
    "cline-local": {
      "command": "node",
      "args": ["C:\\Develop\\ClineMcp\\dist\\index.js"]
    }
  }
}
```

## Working rules and code map

Workspace and edits runs keep their instructions in `--system`, beginning with the run's working directory
and OS. Shared working rules batch independent operations, search across files in one call, use code-map
locations directly, read files under about 600 lines whole, and use ranges of at least 200 lines for
longer files. They forbid paging in small slices or repeating reads, require a new approach after two
failures, and stop when the requested output is complete.
Edits still end with a summary of changed files and verification; ask mode is unchanged.

`ask_cline_workspace`, `apply_cline_edits`, and `cline_start` accept `codeMap?: boolean` (default `true`,
ignored for ask mode). A bridge-generated map precedes the caller's prompt, listing tracked paths,
line counts, and regex-detected declarations with 1-based line numbers. Prompt-mentioned paths come first.
The map is built in the disposable worktree for workspace runs and the current checkout for edits,
and rebuilt on resumed runs. In edits mode, dirty tracked files reflect their current contents despite
the map's `line numbers at HEAD` header; untracked files are not included.

Scanning is limited to 3,000 files, 512 KB per file, and 1,500 ms; generated/vendor directories,
minified files, lockfiles, and binaries are skipped. The default map limit is 6,000 characters,
further reduced to leave a 1,000-character Windows command-line margin after escaping. Maps are omitted
if fewer than 800 characters remain or generation fails. Symbols from lower-priority files are dropped
first, then omitted paths are counted in `... and N more files`. This is a navigation hint, not a parser;
set `codeMap: false` to disable it, including subsequent resumes of an async task.

## Tools

Every tool that runs Cline (`ask_cline`, `apply_cline_edits`, `ask_cline_workspace`, `cline_ping`, `cline_start`) **requires** both `provider` and `model` (`^[A-Za-z0-9._:/@-]{1,120}$`, passed as `-P <provider> -m <model>`; `__proto__`, `constructor`, and `prototype` are rejected). There is **no saved-default fallback**: the bridge never runs on Cline's saved default selection. For Cline's free models, pass `provider: "cline"` and a model `id` returned by `cline_list_models`.

Each Cline run records a live trace in `%TEMP%\cline-tasks\<runId>\` (or `CLINE_MCP_TRACE_DIR`) containing `events.ndjson` (redacted JSONL events, streaming deltas excluded, capped at 5 MB) and `status.json` (coalesced live status with a 30 s heartbeat). At startup, `cleanupTraces()` removes finished (`done`/`failed`) or orphaned trace folders older than the 24 h TTL (`TRACE_TTL_MS`).

### 1. `ask_cline`

Ask the locally installed Cline CLI for an analysis/chat answer from the text in the prompt.

```ts
ask_cline({
  prompt: string,
  provider: string,
  model: string,
  cwd?: string,
  thinking?: "none" | "low" | "medium" | "high" | "xhigh",
  timeoutSeconds?: number,
  systemPrompt?: string
})
```

- Runs with `--auto-approve false` (**no tools**: Cline cannot read files, list directories, or run commands) and prepends `NO_TOOLS_PREAMBLE` telling Cline up front not to call tools and to answer only from the prompt. Use `ask_cline_workspace` to read a repository or `apply_cline_edits` to modify files.
- `provider` and `model` are required (no saved-default fallback; use `provider: "cline"` with an ID from `cline_list_models` for free models).
- `timeoutSeconds` defaults to `180` (integer `1`–`300`); `thinking` defaults to `"none"`.
- `prompt` is `1`–`20,000` characters, `systemPrompt` is `1`–`8,000` characters, and together they must not exceed `24,000` characters.
- On Windows, the full escaped command line must fit within `32,000` UTF-16 code units (`WINDOWS_COMMAND_LINE_LIMIT`; quotes and backslashes before quotes count extra). The CLI is spawned with `shell: false` and `CLINE_NO_AUTO_UPDATE=1`.
- Returns `{ text, model?, durationMs, usage?, cost?, warnings?, trace? }`.

### 2. `apply_cline_edits`

Implement a task in the current Git checkout, then run the bridge's mandatory [final check](#final-check).

```ts
apply_cline_edits({
  prompt: string,
  cwd: string,
  provider: string,
  model: string,
  verify: VerificationCommand | { none: true; reason: string },
  maxFixRuns?: number,        // integer 0-3; default 2
  keepOnFailure?: boolean,   // sync only; default false
  codeMap?: boolean,
  thinking?: "none" | "low" | "medium" | "high" | "xhigh",
  timeoutSeconds?: number,   // overall active-time budget; default 180, integer 1-300
  guard?: { maxRepeatedFailures?: number; window?: number; maxToolCalls?: number; maxInputTokens?: number }
})
```

- `provider`, `model`, `cwd` and `verify` are required. The checkout must have at least one commit.
- Runs with `--auto-approve true` and `EDIT_SYSTEM_PROMPT`. Commits and branch/history changes are forbidden; HEAD/index changes refuse restoration and retain recovery evidence. The bridge never soft-resets a commit.
- `prompt` is 1-20,000 characters, subject to combined text and escaped Windows command-line limits; `thinking` defaults to `"none"`.
- Failure returns evidence and restores the original dirty baseline unless `keepOnFailure: true` explicitly keeps it unverified. Cancellation restores where identity permits.
- Returns `{ text, model?, durationMs, usage?, cost?, gitDiff, status, headBefore, headAfter, commitWasReverted: false, verification, warnings?, trace? }`; `gitDiff` is truncated at 48,000 characters.
- Failures return structured JSON with `kind`, `message`, `verification`, recovery `evidence` and available trace/guard/usage/cost metrics.

### 3. `ask_cline_workspace`

Analyze a Git workspace through Cline in a disposable detached worktree that is always removed after the request. The bridge automatically stops a run on repeated failures or budget.

```ts
ask_cline_workspace({
  prompt: string,
  codeMap?: boolean,
  cwd: string,
  provider: string,
  model: string,
  thinking?: "none" | "low" | "medium" | "high" | "xhigh",
  timeoutSeconds?: number,
  guard?: {
    maxRepeatedFailures?: number,
    window?: number,
    maxToolCalls?: number,
    maxInputTokens?: number
  }
})
```

- `provider`, `model`, and `cwd` (path inside a Git repository with at least one commit) are required; there is no saved-default fallback.
- Creates a detached worktree at `HEAD` under `%TEMP%\cline-mcp-worktrees\review-<uuid>` and runs Cline with `--auto-approve true` and `WORKSPACE_SYSTEM_PROMPT` (read/search/inspection only).
- Always removes and prunes the temporary worktree after the run completes or fails.
- `prompt` is `1`–`20,000` characters (subject to the `32,000` UTF-16 unit Windows command-line limit); `timeoutSeconds` defaults to `180` (`1`–`300`); `thinking` defaults to `"none"`.
- Optional `guard` configuration overrides default loop/budget detection thresholds.
- Returns `{ text, model?, durationMs, usage?, cost?, warnings?, trace? }`.

### 4. `cline_ping`

Check whether a `provider`/`model` pair can answer right now with a one-word, single-attempt request.

```ts
cline_ping({
  provider: string,
  model: string,
  force?: boolean,
  timeoutSeconds?: number
})
```

- `provider` and `model` are required (validated before checking the cache; no saved-default fallback).
- Sends `"Reply with exactly the word PONG."` with `--auto-approve false`, `--thinking none`, `maxAttempts: 1`, and `timeoutSeconds` defaulting to `25` (`5`–`60`).
- Returns `{ state, provider, model, latency_ms?, checked_at, expires_at, reason, retry_after_s?, reset_at?, source, cached }` where `state` is `"available"`, `"rate_limited"`, `"quota_exhausted"`, or `"unreachable"`.
- Results are cached per `provider|model` in `~/.cline-mcp/status.json` (`CLINE_MCP_STATUS_PATH`): `60 s` TTL for `available`/`unreachable`, `retry_after_s` (clamped to `5 s`–`3600 s`, default `180 s`) for `rate_limited`, and until `reset_at` (or next UTC midnight) for `quota_exhausted`.
- Fresh cached entries are reused unless `force: true` (or when a non-quota error was recorded by a real `"run"`, which is re-checked).

### 5. `cline_list_models`

List the models the installed Cline CLI currently advertises as free (`provider: "cline"`), joined with the bridge's last recorded status per model.

```ts
cline_list_models({})
```

- Reads `GENERATED_CLINE_RECOMMENDED_MODELS.free` (enriched from `getGeneratedModelsForProvider("cline")`) from the installed CLI's `@cline/llms` package; fails with `catalog_unavailable` if unreadable and never guesses model IDs.
- Attaches `last_status` (`state`, `reason`, `checked_at`, `expires_at`, `source`) from `status.json` when available.
- Returns `{ provider: "cline", models: [{ provider, id, name, description?, contextWindow?, capabilities?, last_status? }], source: { package, version?, cliVersion? }, note, cli }`.
- Every successful call atomically refreshes the local catalog snapshot file (`~/.cline-mcp/catalog.json` or `CLINE_MCP_CATALOG_PATH`), which is also written once in the background at bridge startup.

### 6. `cline_start`

Start a background task and return its initial `TaskStatusView`.

```ts
cline_start({
  mode: "ask" | "workspace" | "edits",
  prompt: string,
  provider: string,
  model: string,
  cwd?: string,
  verify?: VerificationCommand | { none: true; reason: string }, // required for edits only
  maxFixRuns?: number,        // edits only; integer 0-3, default 2
  codeMap?: boolean,
  thinking?: "none" | "low" | "medium" | "high" | "xhigh",
  timeoutSeconds?: number,   // default 600; integer 1-1800
  waitSeconds?: number,      // default 3; integer 0-30
  guard?: { maxRepeatedFailures?: number; window?: number; maxToolCalls?: number; maxInputTokens?: number }
})
```

- `mode`, `prompt` (1-20,000 characters), `provider` and `model` are required; workspace/edits also require a Git `cwd`.
- Edits use the shared final-check lifecycle below. `verify` and `maxFixRuns` are rejected for ask/workspace; `keepOnFailure` is sync only.
- Each Cline launch has one attempt. Ask/workspace do not retry automatically; edits may launch bounded automatic repairs after a failing check. For edits, `timeoutSeconds` covers cumulative active time across runs/checks and excludes caller waits.
- At most 2 tasks can be running/resuming. Settled uncollected tasks have a 1-hour TTL and a 20-task retention cap. Waiting tasks retain their snapshot and checkout lock.
- Input is strict, rejects unknown fields, and is limited to 64 KiB of serialized UTF-8 JSON.
- Cline is instructed to end a question with `QUESTION: <question>` and optional `OPTIONS: a | b | c`. Only final non-empty lines with 0-3 leading spaces and no tabs count; at most 5 options are retained. Questions and guard trips pause for caller input.

### 7. `cline_status`

```ts
cline_status({ taskId: string, waitSeconds?: number }) // default 20; integer 0-60
```

Long-polls until settlement, a new trace question, or the requested wait expires; 0 returns immediately.
Returns `{ taskId, mode, state, elapsedMs, run, runs, runHistory?, progress?, question?, autoAnswered?, error?, resultReady, trace, phase?, verification?, waitReason?, evidence? }`.
States are `running | resuming | input_required | done | failed | cancelled`.
Trace progress includes the current tool, reasoning, text, files, question and event counters.
Edit phases are `snapshot | run | verify | restore | waiting | done`.

### 8. `cline_send`

```ts
cline_send({ taskId: string, message?: string, action?: "retry" | "restore" | "keep", waitSeconds?: number })
```

Requires `input_required`; `action` defaults to `retry`, and `waitSeconds` defaults to 3 (0-30).
For edits, message is optional (at most 20,000 characters):

- `retry`: retain partial edits and launch one repair with caller guidance, or resume the Cline question. It does not reset automatic-fix capacity or cumulative budgets. A launch requires a free running-task slot and remaining budget.
- `restore`: return to the original snapshot and finish; refusal or incomplete restoration remains visible with recovery evidence.
- `keep`: finish with current changes explicitly marked unverified. Identity refusal retains the recovery snapshot.

Ask/workspace support only `retry` and require a non-empty message. They rebuild context from the original task, previous answer, workspace diff stat, Q&A and latest answer, trimming older context first. Edit repair prompts preserve the objective, latest guidance, question and check command; optional diagnostics are shortened first. Oversized mandatory content is rejected before changing the waiting state.

### 9. `cline_cancel`

```ts
cline_cancel({ taskId: string })
```

Edits abort the active process and wait for baseline restoration and lock release before publishing cancellation. Identity refusal or incomplete restoration retains recovery evidence. Once completion has committed, cancellation waits for the settled result.
Ask/workspace abort running/resuming work (waiting up to 5 seconds) or cancel a waiting task.
Collect afterwards with `cline_result`; cancellation does not remove the task.

### 10. `cline_result`

```ts
cline_result({ taskId: string, keepTrace?: boolean })
```

Returns `{ state, result?, error?, runHistory?, verification?, waitReason?, evidence?, log_run_hint, log_run_note?, trace? }`.
Running/resuming tasks throw `task_running`. Collecting a waiting task preserves it, its traces and its writer lock; collecting a terminal task removes it and deletes traces unless `keepTrace: true`.
Usage, numeric provider breakdowns and cost are aggregated across edit launches; each run history item retains its available final guard counters.
`log_run_hint` is null while waiting, cancelled, or on local failure. For edits, `ok: true` requires successful completion with a passing check or explicit `none`; restored/kept outcomes are not successful model results.
The hint otherwise contains `{ ok, error_kind?: "timeout" | "quota" | "crash", retry_after_s?, error_text?, duration_s }`.

## Final check

Every edit request requires a strict verification alternative:

```ts
type VerificationCommand = {
  command: string;
  args?: string[];
  timeoutSeconds?: number; // default 60; integer 1-300
};
type Verify = VerificationCommand | { none: true; reason: string }; // nonblank reason, 10-500 characters

cline_start({
  mode: "edits", cwd: "C:\\Develop\\example", provider: "cline", model: "<available-model-id>",
  prompt: "Add the requested behavior and its tests",
  verify: { command: "npm", args: ["test"], timeoutSeconds: 120 },
  maxFixRuns: 2
});
```

The shared lifecycle acquires the checkout lock, takes one original snapshot, runs Cline, checks identity, and runs the final check.
A passing check completes the request. A failing check launches up to `maxFixRuns` automatic repairs (0-3, default 2), checking again after each repair. A refused or missing verification executable fails immediately without spending repair runs.
Repair prompts include the objective, latest caller guidance, exact command/arguments/cwd, exit/timeout/output-limit status and redacted tails, instructing Cline to fix the code without weakening or bypassing the check.
They fit the 20,000-character prompt, 8,000-character system, 24,000 combined and 32,000-unit escaped Windows command-line limits; optional context is shortened first.

### Verification and opt-out

Commands use literal arguments, checkout-root cwd, closed stdin and `shell: false`; there is no implicit shell expansion or pipeline interpretation.
On Windows, `npm`, `npx`, `npm.cmd` and `npx.cmd` resolve through Node and installed npm CLI scripts; other batch commands are refused.
Passing requires exit zero without signal, cancellation, timeout or output kill. More than 1 MiB combined output kills the process tree; returned redacted stdout/stderr tails are at most 8 KiB each.
`{none:true, reason}` is an explicit, reported opt-out: `required:false`, `passed:null`, no check attempts and no automatic fixes. It does not turn a Cline error or unresolved question into success.

### Snapshot, lock and recovery

One snapshot is taken before the first Cline run and retained through all repairs and question resumes. It captures working-tree bytes of tracked and untracked non-ignored files, including dirty/binary files and tracked deletions, outside the checkout under the OS temporary directory's `cline-mcp-snapshots`. Existing staging is preserved by requiring unchanged index identity; the index itself is not backed up or restored.
Limits are 20,000 files, 64 MiB per file and 512 MiB total; oversized or unsupported snapshots are refused. Ignored files are excluded and left untouched; submodules, nested repositories, symlinks and reparse points are refused.
Restoration restores modified/deleted baseline files and removes newly created non-ignored files, preserving the owner's pre-run bytes rather than reverting to HEAD. It never stages files or changes HEAD/index.
HEAD/index identity is checked before/after Cline runs, after verification and before restoration. Changes or failed identity inspection refuse restoration and preserve recovery evidence/snapshots; incomplete restoration also retains the snapshot. No Git reset is attempted.
A canonical-checkout writer lock is shared by sync and async edits and retained across async waits. Dead-holder locks can be reclaimed. The lock excludes other bridge writers; use the checkout exclusively to avoid external edits being overwritten during restoration.
Sync failures restore by default; `keepOnFailure:true` keeps failed edits explicitly unverified. Async failures pause with `verify_failed | cline_question | guard | cline_error | head_changed | budget` and permit retry/restore/keep. Questions retain partial edits and defer verification until answered. Cancellation aborts work, restores where identity permits, then releases the lock.

### Budgets and result

`guard.maxToolCalls` (default 150, public range 10-1,000) and `guard.maxInputTokens` (default 1,500,000, range 10,000-20,000,000) are cumulative over the initial run, automatic fixes, question resumes and manual retries. Remaining capacity is passed to each launch and never refunded. Loop/window guard settings still apply per invocation.
Each launch uses one runner attempt, without hidden transient/timeout retries. The overall active-time budget is `timeoutSeconds` (sync default 180/max 300; async default 600/max 1800), shared across launches and checks and retained across caller waits. Per-check timeout is an additional bound. An exhausted budget cannot be reset by retrying.

Successful sync responses and lifecycle failures include `verification`; async status/results expose it as well (also inside the edit result):

```ts
verification: {
  required: boolean,
  passed: boolean | null,        // null for none or before a check ran
  command: VerificationCommand | null,
  reason?: string,               // explicit none reason
  attempts: [{ run, passed, exitCode, signal, timedOut, killedForOutput, durationMs, stdoutTail, stderrTail, error? }],
  fixRuns: number,               // repair launches, including explicit/question continuations
  restored: boolean,
  kept: boolean
}
```

`fixRuns` counts actual repair launches; automatic capacity is capped separately, and manual retries do not reset it. An opt-out returns an empty attempts array. Recovery evidence identifies any retained snapshot and restoration failures. A restored or kept request is not reported as verified success.

### Breaking changes

`verify` is now required for edits (command or reasoned `none`). `steps`, `stepBudget`, and the `skip`/`stop` actions are removed; legacy fields/actions are rejected. The ledger, plan view and plan outcomes are removed. Use one full check suite plus retry/restore/keep. Sync failed edits now restore by default; use `keepOnFailure` explicitly to retain them.

## Loop and Budget Guard

The bridge monitors Cline runs in real time for repetitive failure loops and resource budgets, terminating or pausing problematic executions before wasting tokens or hang time:

### What trips it
- **`loop_detected`**: Triggered when the same failure signature occurs `maxRepeatedFailures` or more times within the sliding `window` of recent tool calls.
  - For file-modifying tools (`replace_in_file`, `write_to_file`, `apply_patch`), the signature is `toolName` + normalized file target path (canonicalized across slashes and patch headers).
  - For `run_commands` / `execute_command`, the signature is `toolName` + normalized command string.
  - For other tools without a file path, the signature is `toolName` + a stable hash of sorted input JSON keys.
  - Successes and calls to other tools in between count toward the sliding window but do not reset the failure counter.
- **`budget_exceeded`**: Triggered when cumulative tool calls exceed `maxToolCalls`, or cumulative input tokens exceed `maxInputTokens`.
  - Token tracking counts incremental `usage` events alongside cumulative `done`/`run_result` totals without double-counting.

### Guard Parameters and Defaults
Available as an optional `guard` object on `apply_cline_edits`, `ask_cline_workspace`, and `cline_start` (`ask_cline` runs with no tools and has no `guard` parameter):
- `maxRepeatedFailures`: Integer between `2` and `20` (default `3`).
- `window`: Integer between `3` and `50` (default `10`). Must be greater than or equal to `maxRepeatedFailures`.
- `maxToolCalls`: Integer between `10` and `1000` (default `150`).
- `maxInputTokens`: Integer between `10,000` and `20,000,000` (default `1,500,000`).

### The Guard Report
Every Cline invocation exports a final `GuardReport` on its response or error, including successful runs.
Task run history retains these reports; a tripped guard is also exposed on the task's waiting status:
- `kind`: `"loop_detected"` or `"budget_exceeded"` when tripped; omitted on an untripped final report.
- `tool`: The tool involved in the loop (e.g. `"replace_in_file"`, `"run_commands"`).
- `target`: The failing file path or command (secrets redacted).
- `count`: Number of times the failure signature appeared in the window.
- `window`: Configured window size.
- `lastErrors`: Up to 3 recent error messages (each ≤ 300 characters, secrets redacted).
- `totalToolCalls`: Total tool calls observed during the run.
- `totalInputTokens`: Total input tokens observed.
- `filesTouched`: Successfully modified/written file paths (secrets redacted).
- `lastAssistantText`: Last assistant text excerpt (≤ 400 characters).

### Task Behavior vs Synchronous Tools

- Async edits pause with `waitReason: "guard"`, retaining partial edits, the original snapshot, lock and run history. Use retry with guidance, restore, keep or `cline_cancel`; consumed budgets remain consumed.
- Async ask/workspace tasks pause with a bridge question and guidance choices. `cline_send` with a message resumes with a bounded, redacted guard warning, tool/target and recent errors. Subsequent trips pause again.
- Synchronous runs terminate the Cline process tree and attach the guard report to the error. Sync edits additionally restore the original baseline unless `keepOnFailure` is set; identity refusal retains recovery evidence instead.
- Guard trips never trigger an automatic repair or hidden runner retry.

## Provider and Model Settings Coordination

- If a call is aborted while waiting for the settings lock, it is cancelled with kind `cancelled`.
- Before spawning a run, the bridge snapshots the baseline settings (`lastUsedProvider`, and the target provider's `settings.model` and `settings.reasoning`) from the providers configuration file (`CLINE_PROVIDER_SETTINGS_PATH`, `CLINE_DATA_DIR/settings/providers.json`, or `~/.cline/data/settings/providers.json`) into a restore journal (`.bridge-restore.json`).
- After the last active run finishes (success or failure), the bridge re-reads the configuration file and restores *only* those specific fields if they were modified, preserving refreshed OAuth tokens, credentials, and all other provider configurations.
- Restoration is performed via an atomic write (temporary file with mode `0o600` + atomic rename). If no tracked fields were modified, no disk write occurs.

## Free Model Catalog Snapshot

The bridge publishes its advertised free models to a local JSON file so that external tools (e.g. `model-picker` or Python scripts) can read current model IDs and capabilities without importing Node packages or querying the Cline CLI directly.

### File Location
- Environment variable: `CLINE_MCP_CATALOG_PATH` (if set, resolved).
- Default location: `~/.cline-mcp/catalog.json` (in the same directory as `status.json`).

### Snapshot Updates
- **Bridge startup**: The bridge queries `listFreeModels()` once in the background and writes the snapshot without blocking startup.
- **`cline_list_models`**: After every successful model listing, the snapshot is updated.
- Failures to update the snapshot are logged to stderr in a single line and never fail tool invocations or server startup.

### File Format
```json
{
  "version": 1,
  "generated_at": "2026-11-10T07:00:00.000Z",
  "provider": "cline",
  "models": [
    {
      "id": "cline-free/nemotron-3.5-super-vl",
      "name": "Nemotron 3.5 Super VL (free)",
      "contextWindow": 1048576,
      "capabilities": ["tools", "reasoning"]
    }
  ],
  "source": {
    "package": ".../node_modules/@cline/llms",
    "version": "0.2.0",
    "cliVersion": "3.0.74"
  }
}
```
All writes are atomic: the directory is created if needed, a temporary file is written in the same directory, and it is renamed into place (with temporary files removed on failure).

## Error Handling, Warnings, and Recovery

The bridge makes failures visible and recoverable rather than returning generic messages:

### Real Errors, Tails, and Secret Redaction
On failure, errors are surfaced as structured text (or JSON for `apply_cline_edits`) containing:
- `Kind`: Machine-readable error code.
- `Message`: Human-readable description, including extracted JSONL error messages where available.
- `Exit code`: The CLI exit code or signal termination detail (if applicable).
- `Attempts`: Total attempts made (initial + retry).
- `Stderr tail`: Last ~2,000 characters of stderr, with sensitive secrets redacted.
- `Stdout tail`: Last ~2,000 characters of stdout, with sensitive secrets redacted.

Secret redaction is applied to full stdout/stderr streams before taking tails to prevent tokens from being split across tail boundaries, and also applies to `extractedMessage` and error summaries. Redaction patterns cover `sk-...`, `nvapi-...`, `Bearer ...`, JSON keys (`"apiKey"`, `"api_key"`, `"accessToken"`, `"refreshToken"`, `"token"`, `"secret"`, `"password"`, `"key"`, `"authorization"`), and environment-style `KEY=value` / `*_KEY=value` definitions (`API_KEY`, `TOKEN`, `SECRET`, `PASSWORD`, `KEY`, `NVIDIA_KEY`, etc.).

### Process Exit and Settlement Grace Period
Settlement listens for process `exit` as well as `close`. If Cline or a child daemon keeps stdio pipes open after exiting, the bridge waits a 500 ms grace period after `exit` before destroying the streams and settling with the collected output, preventing hangs and avoiding holding the settings lock indefinitely.

### Error Kinds
- `non_zero_exit`: CLI exited with a non-zero code on a non-transient error, was terminated by an external signal without a completed result, or failed with an explicit error in `run_result`.
- `transient_provider_error`: Provider overload, rate limit (429), 5xx with HTTP context, "temporarily unavailable", ECONNRESET, ETIMEDOUT, or upstream provider errors that failed after an automatic retry with backoff (~2-3s). Stderr info messages (such as `rate limit remaining: 99`) are ignored when classifying errors.
- `timeout`: CLI exceeded the configured timeout. The error message includes configured limit and actual elapsed seconds, plus output tails.
- `cline_updating`: Cline CLI entry file is missing or stderr indicated `MODULE_NOT_FOUND` / `Cannot find module` during an update. Where retries are enabled, the bridge retries once; otherwise it reports `"Cline CLI is missing or being updated; retry in ~30 s"`.
- `cancelled`: Request cancelled via client abort signal before execution, during backoff, or while waiting in the lock queue.
- `launch_failed`: Invalid input arguments, missing executable, process spawn errors (`ENOENT`, `EACCES`), or process launch failure.
- `malformed_json` / `missing_final_result`: Process completed with code 0 but stdout did not produce a valid terminal result.
- `workspace_not_git`, `workspace_setup_failed`, `workspace_cleanup_failed`: Worktree management failures.
- `edits_inspection_failed`: Git inspection or identity refusal; inspect the returned verification/recovery evidence.
- `loop_detected`: Repeated tool failure on the same target/command tripped the loop detector within the sliding window.
- `budget_exceeded`: Cumulative tool calls or cumulative input tokens exceeded the configured budget.

### Success Despite Non-Zero Exit or External Signal
When Cline successfully answers but exits with code 1 or an external signal (for example, printing a completed `run_result` or an `agent_event` `done` with `reason:"completed"`, followed by `session not found` on stderr), the bridge recovers the completed text, returns success, and includes a `warnings` array (e.g. `["cline exited with code 1 after a completed result: session not found: <id>"]`).

### Clean Exit 0 Provider Errors
If Cline exits with code 0 but stdout contains a `run_result` with `finishReason: "error"`, the error is extracted and classified prior to clean exit parsing. Transient errors are eligible for retry only on the synchronous analysis tools; edit launches report the failure without a hidden retry. Non-transient errors retain the extracted failure message rather than throwing `missing_final_result`.

### Safe Retry Behavior
- Transient errors and timeouts on synchronous analysis tools (`ask_cline`, `ask_cline_workspace`) may trigger one automatic retry (`maxAttempts: 2`) when budget remains. `cline_ping`, async tasks and every edit launch use one runner attempt.
- Non-transient errors (syntax errors, invalid flags, authentication rejections, daily quota exhaustion) are never retried.
- Edits perform only the final-check repairs described above. Cline errors, questions and guard trips do not launch hidden retries; sync restores by default and async waits for caller action.

## CLI State, Self-Healing Updates, and Dashboard Ping Script

- **State file (`~/.cline-mcp/state.json` or `CLINE_MCP_STATE_PATH`)**: Tracks `machine_id`, installed `cli.version`, `cli.catalog_version`, `cli.update_state` (`"ok"` | `"update_available"` | `"updating"` | `"rolled_back"` | `"broken"`), `latest_known_version`, `last_check_at`, `previous_version`, `last_error` (≤240 chars, redacted), and `failed_versions`. Written atomically under a lock file (`state.json.lock`) and calls `syncHook(state)` after every write.
- **Catalog follows the CLI**: On every tool call, the bridge checks the mtime-cached `cline` and `@cline/llms` `package.json` versions; when either changes, it cache-busts the dynamic `@cline/llms` import (`?v=<version>`), rewrites `catalog.json`, and updates `state.json` without restarting.
- **Daily check & safe background update**: When `last_check_at` is older than 24 h, the first tool call starts a background `npm view cline version` (30 s timeout). If a version newer than installed and newer than all `failed_versions` is found, `update_state` becomes `"update_available"`. When the settings journal has no live runs across the machine, one bridge acquires the settings mutex (`acquireSettingsMutex`, so new runs wait up to 60 s), runs `npm install -g cline@<v>` (300 s timeout), verifies the on-disk `package.json` version, and runs a self-check with `listFreeModels()` + `clinePing` on up to 3 candidate models (preferring models whose last observation in `status.json` is `"available"`, newest `checked_at` first, then catalog order). On failure, it reinstalls and verifies the previous version (`"rolled_back"` and records `failed_versions`, or `"broken"` if rollback also fails). Stale `"updating"` locks (>15 min with a dead PID) are recovered automatically, and bridge shutdown waits for an active install within the 120 s shutdown budget.
- **`cli` status in replies**: `cline_list_models` always includes `cli: { state, version, latest?, failed? }`; all other tools include `cli` whenever `update_state !== "ok"`.
- **Refresh ping script (`node dist/pingall.js`)**: Lists the free model catalog and runs `clinePing` sequentially once per model (`provider: "cline"`, `force: true`) within a 120 s total cap, updating `~/.cline-mcp/status.json`, printing a one-line JSON summary, and exiting `0`.

