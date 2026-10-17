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

### 1. `ask_cline`

Ask the locally installed Cline CLI for an analysis/chat response. File edits are not approved (`--auto-approve false`).

```ts
ask_cline({
  prompt: string,
  cwd?: string,
  thinking?: "none" | "low" | "medium" | "high" | "xhigh",
  timeoutSeconds?: number,
  systemPrompt?: string,
  provider?: string,
  model?: string
})
```

- `timeoutSeconds` defaults to `180` and is limited to `300`.
- `thinking` defaults to `none`.
- `provider`: Optional provider identifier (regex: `^[A-Za-z0-9._:/@-]{1,120}$`), passed to Cline as `-P <provider>`.
- `model`: Optional model identifier (regex: `^[A-Za-z0-9._:/@-]{1,120}$`), passed to Cline as `-m <model>`.
- Reserved object property names (`__proto__`, `constructor`, `prototype`) are rejected.
- On Windows, `prompt` is limited to 20,000 characters and `systemPrompt` to 8,000. Together they may not exceed 24,000 characters.
- The bridge always spawns the CLI with `shell: false` and merges `CLINE_NO_AUTO_UPDATE=1` into `process.env`.

### 2. `apply_cline_edits`

Have Cline implement a development task directly in the current Git checkout. Files may change, but commits are forbidden and the resulting diff is returned.

```ts
apply_cline_edits({
  prompt: string,
  cwd: string,
  thinking?: "none" | "low" | "medium" | "high" | "xhigh",
  timeoutSeconds?: number,
  provider?: string,
  model?: string
})
```

Errors from `apply_cline_edits` return structured JSON output with `kind`, `message`, `exitCode`, `attempts`, `stderrTail`, `stdoutTail`, and Git evidence.

### 3. `ask_cline_workspace`

Analyze a Git repository in a disposable detached worktree. The worktree is always cleaned up after execution.

```ts
ask_cline_workspace({
  prompt: string,
  cwd: string,
  thinking?: "none" | "low" | "medium" | "high" | "xhigh",
  timeoutSeconds?: number,
  provider?: string,
  model?: string
})
```

## Provider and Model Settings Coordination

Configuration file access and override runs are coordinated using a fair readers-writer lock (`AsyncRwLock`):
- Calls without an override take a shared read lock for their run, allowing multiple default runs to execute concurrently while ensuring no override run modifies the underlying configuration file during their execution.
- Calls with a `provider` or `model` override take an exclusive write lock for their execution and restore lifecycle.
- Writers are queued fairly without starvation.
- If a call is aborted while waiting for the lock, it is immediately dequeued and cancelled with kind `cancelled`.
- Before spawning an override run, the bridge snapshots the current default settings (`lastUsedProvider`, and the target provider's `settings.model` and `settings.reasoning`) from the providers configuration file (`CLINE_PROVIDER_SETTINGS_PATH`, `CLINE_DATA_DIR/settings/providers.json`, or `~/.cline/data/settings/providers.json`).
- If the provider block was absent before the run and created by Cline, only `lastUsedProvider` is restored; fields in the newly created block are never deleted.
- After the run (success or failure), the bridge re-reads the configuration file and restores *only* those specific fields if they were modified, preserving refreshed OAuth tokens, credentials, and all other provider configurations.
- Restoration is performed via an atomic write (temporary file with mode `0o600` + atomic rename, with Windows retry on `EPERM`/`EBUSY`). If no tracked fields were modified, no disk write occurs.
- On unparseable or read-failing settings files, restoration is skipped with a warning to prevent corrupting disk state.

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
- Transient errors trigger a single automatic retry with a short backoff.
- Timeouts are retried once if `timeoutSeconds <= 120`. Runs with `timeoutSeconds > 120` are not retried to prevent exceeding client-side timeouts.
- Non-transient errors (syntax errors, invalid flags, authentication rejections) are never retried.
- For `apply_cline_edits`, a retry is only attempted if the first attempt produced no tool calls and no working tree / HEAD modifications; if any change occurred or if uncertain, edits are not retried.
