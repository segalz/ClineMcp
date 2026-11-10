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

Have Cline implement a development task directly in the current Git checkout. Files may change, but commits are forbidden and the resulting diff is returned.

```ts
apply_cline_edits({
  prompt: string,
  cwd: string,
  provider: string,
  model: string,
  thinking?: "none" | "low" | "medium" | "high" | "xhigh",
  timeoutSeconds?: number
})
```

- `provider`, `model`, and `cwd` (path inside a Git checkout) are required; there is no saved-default fallback.
- Runs with `--auto-approve true` and `EDIT_SYSTEM_PROMPT`; Git commits and branch/history changes are forbidden (an accidental commit is soft-reset and rejected with `commit_created`).
- `prompt` is `1`–`20,000` characters (subject to the `32,000` UTF-16 unit Windows command-line limit); `timeoutSeconds` defaults to `180` (`1`–`300`); `thinking` defaults to `"none"`.
- Returns `{ text, model?, durationMs, usage?, cost?, gitDiff, status, headBefore, headAfter, commitWasReverted, warnings?, trace? }` (`gitDiff` is truncated at `48,000` characters).
- Errors return structured JSON with `kind`, `message`, `exitCode`, `attempts`, `resetAt`, `retryAfterSeconds`, `stderrTail`, `stdoutTail`, `trace`, `notes`, and Git evidence.

### 3. `ask_cline_workspace`

Analyze a Git workspace through Cline in a disposable detached worktree that is always removed after the request.

```ts
ask_cline_workspace({
  prompt: string,
  cwd: string,
  provider: string,
  model: string,
  thinking?: "none" | "low" | "medium" | "high" | "xhigh",
  timeoutSeconds?: number
})
```

- `provider`, `model`, and `cwd` (path inside a Git repository with at least one commit) are required; there is no saved-default fallback.
- Creates a detached worktree at `HEAD` under `%TEMP%\cline-mcp-worktrees\review-<uuid>` and runs Cline with `--auto-approve true` and `WORKSPACE_SYSTEM_PROMPT` (read/search/inspection only).
- Always removes and prunes the temporary worktree after the run completes or fails.
- `prompt` is `1`–`20,000` characters (subject to the `32,000` UTF-16 unit Windows command-line limit); `timeoutSeconds` defaults to `180` (`1`–`300`); `thinking` defaults to `"none"`.
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

Start a Cline task asynchronously in the background and return its initial `TaskStatusView`.

```ts
cline_start({
  mode: "ask" | "workspace" | "edits",
  prompt: string,
  provider: string,
  model: string,
  cwd?: string,
  thinking?: "none" | "low" | "medium" | "high" | "xhigh",
  timeoutSeconds?: number,
  waitSeconds?: number
})
```

- `mode`, `prompt` (`1`–`20,000` chars), `provider`, and `model` are required (no saved-default fallback; `cwd` is required for `"workspace"` and `"edits"`).
- Runs a single attempt (`maxAttempts: 1`, no automatic retry) with `timeoutSeconds` defaulting to `600` (`1`–`1800`); waits up to `waitSeconds` (default `3`, `0`–`30`) for first progress before returning.
- Caps and retention: at most `2` concurrent active (`"running"` or `"resuming"`) tasks (`MAX_RUNNING_TASKS`; exceeding throws `task_limit`), a `1 hour` TTL (`UNCOLLECTED_TTL_MS`) for settled uncollected tasks, and at most `20` retained settled tasks (`MAX_SETTLED_TASKS`).
- Task states: `"running"`, `"resuming"`, `"input_required"`, `"done"`, `"failed"`, and `"cancelled"`.
- Prepends `TASK_QUESTION_PREAMBLE` instructing Cline never to call `ask_question` and instead to stop and end its response with `QUESTION: <one question>` and an optional following line `OPTIONS: a | b | c` (matched only on the final non-empty lines with at most 3 leading spaces and no tabs, up to 5 options), which places the task in `"input_required"`.

### 7. `cline_status`

Long-poll a task's live status and trace progress.

```ts
cline_status({
  taskId: string,
  waitSeconds?: number
})
```

- `taskId` (UUID) is required; `waitSeconds` defaults to `20` (`0`–`60`, where `0` returns immediately).
- Long-polls until the task settles (`"done"`, `"input_required"`, `"failed"`, `"cancelled"`), Cline emits a new unreported question in the trace, or `waitSeconds` elapses.
- Returns `TaskStatusView`: `{ taskId, mode, state, elapsedMs, run, runs, progress?, question?, autoAnswered?, error?, resultReady, trace }`.
- `progress` exposes live trace fields (`attempt`, `iteration`, `clineTaskId`, `currentTool`, `toolCalls`, `lastReasoning`, `lastText`, `streamingChars`, `files`, `question`, `eventsWritten`, `eventsDropped`, `finish`).

### 8. `cline_send`

Send an answer to a task waiting in `"input_required"` state, starting a fresh Cline run with accumulated context under the same `taskId`.

```ts
cline_send({
  taskId: string,
  message: string,
  waitSeconds?: number
})
```

- Requires the task to be in `"input_required"` state (otherwise throws `task_not_waiting`) and counts toward the `2`-running-task limit while `"resuming"`/`"running"`.
- `message` is `1`–`20,000` characters; `waitSeconds` defaults to `3` (`0`–`30`) before returning the updated `TaskStatusView`.
- Starts a new run (`run` incremented, trace `<taskId>-run-<N>`) with a prompt combining `Original task`, `Previous answer`, `Working directory diff stat` (`git diff --stat` for `"workspace"`/`"edits"`), prior Q&A pairs, and the latest `Cline question` / `Options` / `Caller answer`.
- If the assembled prompt exceeds `20,000` characters or the `32,000`-unit Windows command-line limit, it trims `diffStat`, then `previousAnswer` (keeping the tail), then oldest Q&A pairs, then `originalPrompt` (keeping the head); if the latest question + answer alone cannot fit, it throws `launch_failed` and keeps the task in `"input_required"`.

### 9. `cline_cancel`

Stop a running or waiting Cline task.

```ts
cline_cancel({
  taskId: string
})
```

- Aborts a `"running"` or `"resuming"` task (killing its Cline process tree and waiting up to `5 s` to settle) or transitions an `"input_required"` task to `"cancelled"`.
- Returns the `TaskStatusView` with `state: "cancelled"`.
- Does not remove the task; call `cline_result` afterwards to collect it and clean up its traces.

### 10. `cline_result`

Collect the final result of a finished task (or partial result of an `"input_required"` task) and its `model-picker` logging hint.

```ts
cline_result({
  taskId: string,
  keepTrace?: boolean
})
```

- Fails with `task_running` if the task is still `"running"` or `"resuming"`.
- Returns `{ state, result?, error?, log_run_hint, log_run_note?, trace? }`.
- `log_run_hint` is `{ ok, error_kind?: "timeout" | "quota" | "crash", retry_after_s?, error_text?, duration_s }` for `model-picker`'s `log_run`, or `null` (with `log_run_note`) when the task was `"cancelled"`, is in `"input_required"`, or failed locally before/around the model run (`workspace_not_git`, `workspace_setup_failed`, `workspace_cleanup_failed`, `settings_lock_timeout`, `settings_restore_failed`, `launch_failed`, `catalog_unavailable`, `edits_inspection_failed`, `cline_updating`, `task_*`).
- For settled tasks (`"done"`, `"failed"`, `"cancelled"`), removes the task from memory and deletes its trace directories unless `keepTrace: true` (default `false`); for `"input_required"`, keeps the task and traces so it can be resumed with `cline_send`.

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
- `cline_updating`: Cline CLI entry file is missing or stderr indicated `MODULE_NOT_FOUND` / `Cannot find module` during an update. The bridge retries once and reports `"Cline CLI is missing or being updated; retry in ~30 s"`.
- `cancelled`: Request cancelled via client abort signal before execution, during backoff, or while waiting in the lock queue.
- `launch_failed`: Invalid input arguments, missing executable, process spawn errors (`ENOENT`, `EACCES`), or process launch failure.
- `malformed_json` / `missing_final_result`: Process completed with code 0 but stdout did not produce a valid terminal result.
- `workspace_not_git`, `workspace_setup_failed`, `workspace_cleanup_failed`: Worktree management failures.
- `commit_created`, `edits_inspection_failed`: Git checkout modification failures.

### Success Despite Non-Zero Exit or External Signal
When Cline successfully answers but exits with code 1 or an external signal (for example, printing a completed `run_result` or an `agent_event` `done` with `reason:"completed"`, followed by `session not found` on stderr), the bridge recovers the completed text, returns success, and includes a `warnings` array (e.g. `["cline exited with code 1 after a completed result: session not found: <id>"]`).

### Clean Exit 0 Provider Errors
If Cline exits with code 0 but stdout contains a `run_result` with `finishReason: "error"`, the error is extracted and classified prior to clean exit parsing. Transient errors trigger an automatic retry; non-transient errors report the extracted failure message clearly rather than throwing `missing_final_result`.

### Safe Retry Behavior
- Transient errors and timeouts on synchronous tools (`ask_cline`, `apply_cline_edits`, `ask_cline_workspace`) trigger a single automatic retry (`maxAttempts: 2`) with a short backoff when sufficient budget remains (`cline_ping` and async tasks run a single attempt with no automatic retry).
- Non-transient errors (syntax errors, invalid flags, authentication rejections, daily quota exhaustion) are never retried.
- For `apply_cline_edits`, a retry is only attempted if the first attempt produced no tool calls and no working tree / HEAD modifications; if any change occurred or if uncertain, edits are not retried.

## CLI State, Self-Healing Updates, and Dashboard Ping Script

- **State file (`~/.cline-mcp/state.json` or `CLINE_MCP_STATE_PATH`)**: Tracks `machine_id`, installed `cli.version`, `cli.catalog_version`, `cli.update_state` (`"ok"` | `"update_available"` | `"updating"` | `"rolled_back"` | `"broken"`), `latest_known_version`, `last_check_at`, `previous_version`, `last_error` (≤240 chars, redacted), and `failed_versions`. Written atomically under a lock file (`state.json.lock`) and calls `syncHook(state)` after every write.
- **Catalog follows the CLI**: On every tool call, the bridge checks the mtime-cached `cline` and `@cline/llms` `package.json` versions; when either changes, it cache-busts the dynamic `@cline/llms` import (`?v=<version>`), rewrites `catalog.json`, and updates `state.json` without restarting.
- **Daily check & safe background update**: When `last_check_at` is older than 24 h, the first tool call starts a background `npm view cline version` (30 s timeout). If a version newer than installed and newer than all `failed_versions` is found, `update_state` becomes `"update_available"`. When the settings journal has no live runs across the machine, one bridge acquires the settings mutex (`acquireSettingsMutex`, so new runs wait up to 60 s), runs `npm install -g cline@<v>` (300 s timeout), verifies the on-disk `package.json` version, and runs a self-check with `listFreeModels()` + `clinePing` on up to 3 candidate models (preferring models whose last observation in `status.json` is `"available"`, newest `checked_at` first, then catalog order). On failure, it reinstalls and verifies the previous version (`"rolled_back"` and records `failed_versions`, or `"broken"` if rollback also fails). Stale `"updating"` locks (>15 min with a dead PID) are recovered automatically, and bridge shutdown waits for an active install within the 120 s shutdown budget.
- **`cli` status in replies**: `cline_list_models` always includes `cli: { state, version, latest?, failed? }`; all other tools include `cli` whenever `update_state !== "ok"`.
- **Refresh ping script (`node dist/pingall.js`)**: Lists the free model catalog and runs `clinePing` sequentially once per model (`provider: "cline"`, `force: true`) within a 120 s total cap, updating `~/.cline-mcp/status.json`, printing a one-line JSON summary, and exiting `0`.

