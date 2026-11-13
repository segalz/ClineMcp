# Local Cline MCP Bridge

This local stdio MCP server lets an MCP client use an installed, authenticated Cline CLI. It answers from supplied text, analyzes a Git repository in a disposable worktree, or edits the current checkout. Each Cline launch uses an explicitly selected provider and model; background tasks retain that selection when resumed. Edit requests run a final verification command unless the caller supplies a reasoned opt-out.

## What it does

- Requires explicit provider/model selection for Cline work, without falling back to saved defaults.
- Lists Cline's advertised free-model catalog and checks model availability with cached pings.
- Supports ask, workspace analysis in a disposable worktree, and edits in the existing checkout.
- Runs async tasks with status polling, questions, `cline_send` continuations and cancellation.
- Detects repeated tool failures and enforces tool-call/input-token budgets (Stage 9).
- Supplies the working directory/OS, working rules and an optional code map (Stage 10).
- Verifies edits, launches bounded automatic fixes, and uses one recovery snapshot and checkout writer lock (Stage 12).
- Records CLI state, coordinates checked Cline updates/rollback, and provides a dashboard refresh ping script.

## Setup

Requires Node.js 20 or newer and an installed, authenticated Cline CLI.

```powershell
npm install
npm run build
npm test
npm start
```

`npm start` serves MCP over stdio; it does not open an interactive prompt. Build first, then configure your MCP client:

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

## Typical use

Examples use illustrative tool-call notation and parsed MCP JSON replies, not a JavaScript SDK. Replace `<model-id>` with an ID from `cline_list_models({})`; listing does not guarantee availability, so check with `cline_ping` when needed.

### Synchronous edit

```js
const result = await apply_cline_edits({
  provider: "cline", model: "<model-id>", cwd: "C:\\Develop\\example",
  prompt: "Fix the reported bug and add its regression test.",
  verify: { command: "npm", args: ["test"], timeoutSeconds: 120 },
  timeoutSeconds: 300, maxFixRuns: 2
});
// Inspect result.verification as well as result.text and result.gitDiff.
```

A first-run pass includes this `verification` value (timing and output are illustrative):

```json
{
  "required": true, "passed": true,
  "command": { "command": "npm", "args": ["test"], "timeoutSeconds": 120 },
  "attempts": [{
    "run": 1, "passed": true, "exitCode": 0, "signal": null,
    "timedOut": false, "killedForOutput": false, "durationMs": 250,
    "stdoutTail": "Tests passed", "stderrTail": ""
  }],
  "fixRuns": 0, "restored": false, "kept": false
}
```

### Background edit with caller decisions

```js
const task = await cline_start({
  mode: "edits", provider: "cline", model: "<model-id>",
  cwd: "C:\\Develop\\example", prompt: "Implement the requested behavior and tests.",
  verify: { command: "npm", args: ["test"], timeoutSeconds: 120 },
  timeoutSeconds: 900, maxFixRuns: 2, waitSeconds: 0
});
const wait = async () => {
  let status;
  do { status = await cline_status({ taskId: task.taskId, waitSeconds: 20 }); }
  while (["running", "resuming"].includes(status.state));
  return status;
};
let status = await wait();
if (status.state === "input_required") {
  // Inspect status.question, waitReason and evidence, then choose ONE action.
  await cline_send({ taskId: task.taskId, action: "retry", message: "Caller answer or repair guidance" });
  // Alternatives: {taskId: task.taskId, action: "restore"} or action: "keep".
  status = await wait();
}
const final = await cline_result({ taskId: task.taskId });
// final.verification has the same shape as above.
// If still input_required, this is partial: answer again or choose restore/keep.
```

Retry requires remaining budget; use restore or keep to finish without another model launch. A successful restore reports `restored:true, kept:false`; a keep reports `kept:true`. Neither is verified success. Restoration refusal remains recoverable through the retained evidence. Collect a terminal result only once; collecting a waiting result retains the task.

## Tool reference

Every initial Cline request requires `provider` and `model`, matching `^[A-Za-z0-9._:/@-]{1,120}$`; `__proto__`, `constructor` and `prototype` are rejected. Use `provider:"cline"` for Cline's free models. Task-control tools take `taskId` and reuse the selection stored by `cline_start`.

| Tool | Required input | Optional input and defaults |
|---|---|---|
| `ask_cline` | `prompt`, `provider`, `model` | `cwd`, `thinking:"none"`, `timeoutSeconds:180` (1-300), `systemPrompt` |
| `ask_cline_workspace` | `prompt`, `provider`, `model`, `cwd` | `thinking:"none"`, `timeoutSeconds:180` (1-300), `codeMap:true`, `guard` |
| `apply_cline_edits` | `prompt`, `provider`, `model`, `cwd`, `verify` | `thinking:"none"`, `timeoutSeconds:180` (1-300), `codeMap:true`, `guard`, `maxFixRuns:2` (0-3), `keepOnFailure:false` |
| `cline_start` | `mode`, `prompt`, `provider`, `model`; `cwd` for workspace/edits; `verify` for edits | `thinking:"none"`, `timeoutSeconds:600` (1-1800), `waitSeconds:3` (0-30), `codeMap:true`, `guard`, edits-only `maxFixRuns:2` (0-3) |
| `cline_status` | `taskId` (UUID) | `waitSeconds:20` (0-60) |
| `cline_send` | `taskId`; non-empty `message` for ask/workspace | `message` up to 20,000 characters, `action:"retry"`, `waitSeconds:3` (0-30) |
| `cline_cancel` | `taskId` | None |
| `cline_result` | `taskId` | `keepTrace:false` |
| `cline_list_models` | None (`{}`) | None |
| `cline_ping` | `provider`, `model` | `force:false`, `timeoutSeconds:25` (5-60) |

`cline_start.mode` accepts `ask | workspace | edits`; `thinking` accepts `none | low | medium | high | xhigh`. Numeric limits are integers. Prompts are 1-20,000 characters; a caller-supplied `systemPrompt` is ask-only and 1-8,000 characters. Prompt plus system text is limited to 24,000 characters, with additional preamble/map fitting where applicable. On Windows the escaped command line must fit within 32,000 UTF-16 units. Async input is strict and limited to 64 KiB of serialized UTF-8 JSON; edit lifecycle input has the same byte limit. Async ask/workspace reject `verify`/`maxFixRuns`; `keepOnFailure` is sync only. Ask mode ignores `codeMap`.

### Modes and task results

- **Ask:** prompt-only analysis with `--auto-approve false` and a no-tools instruction. Supply the text/code to analyze; this mode cannot inspect a repository.
- **Workspace:** tool-enabled analysis in a detached worktree at committed `HEAD`, excluding existing dirty changes. Cleanup is attempted after success, failure or cancellation; failed cleanup reports the leftover worktree. Its base is the OS temp directory's `cline-mcp-worktrees`.
- **Edits:** tool-enabled work in the checkout, with instructions forbidding commits and branch/history changes. Verification/recovery follow the rules below. Workspace/edits require a Git repository with at least one commit.

Sync answers include `text`, `durationMs` and available `model`, `usage`, `cost`, `guard`, `warnings` and `trace`. Successful sync edits also include `gitDiff` (up to 48,000 characters), `status`, `headBefore`, `headAfter`, `commitWasReverted:false` and `verification`. Async edit results aggregate numeric usage/cost across launches; they do not include the sync Git diff fields.

Async states are `running | resuming | input_required | done | failed | cancelled`. Status includes `taskId`, mode/state, elapsed time, `run`, `runs`, trace and `resultReady`, plus available progress, question, run history, guard and error. Edits also expose `phase`, `verification`, `waitReason` and recovery `evidence`; phases are `snapshot | run | verify | restore | waiting | done`. `done` alone does not mean verified: restoration and keeping edits also finish as `done`.

At most 2 tasks can be running/resuming. Settled uncollected tasks are pruned on new work, with a 1-hour age limit and 20-task cap. Waiting tasks are retained; waiting edits also hold their lock and snapshot. `cline_status` long-polls until settlement, a new trace question or its wait limit; `waitSeconds:0` returns immediately.

Cline is instructed to end an async question with `QUESTION: <question>` and optionally `OPTIONS: a | b | c`. These must be the final non-empty lines, with 0-3 leading spaces and no tabs; at most 5 options are returned. `cline_send` requires `input_required`. Ask/workspace support only `retry`, rebuilding context from the original task, prior answer/Q&A and workspace diff stat while shortening older context first. Oversized mandatory question/answer content is rejected before replacing the waiting state.

`cline_result` returns `{state, result?, error?, runHistory?, guard?, verification?, waitReason?, evidence?, log_run_hint, log_run_note?, trace?}`. Running/resuming tasks throw `task_running`. Collecting a waiting task preserves it for continuation; collecting a terminal task removes it and deletes traces unless `keepTrace:true`.

For edits, `log_run_hint.ok` is true only on successful completion with a passing check or explicit `none`; restored/kept outcomes are not successes. Hints are null while waiting, cancelled, or for recognized local failures. Otherwise the hint has `ok`, `duration_s` and optional `error_kind:timeout | quota | crash`, `retry_after_s` and `error_text`. Inspect verification and recovery evidence as well as the hint.

## Final check (Stage 12)

Every edit request requires exactly one strict alternative:

```ts
type Verify = {
  command: string;          // non-empty, no NUL
  args?: string[];          // literal arguments, no NUL
  timeoutSeconds?: number;  // default 60; integer 1-300
} | {
  none: true;
  reason: string;           // trimmed, 10-500 characters
};
```

The lifecycle acquires the checkout lock, records identity and one snapshot, runs Cline, checks identity, then verifies. A failed check can trigger up to `maxFixRuns` automatic repair launches (default 2, range 0-3), checking after each. Repair prompts preserve the objective, latest caller guidance/question and exact check specification; they include redacted status/tails and instruct Cline not to weaken or bypass the check. Optional diagnostics/maps are shortened first; oversized mandatory content fails rather than silently losing instructions.

Verification uses checkout-root cwd, closed stdin and `shell:false`: pass a command and literal arguments, not a shell command string. On Windows `npm`, `npx`, `npm.cmd` and `npx.cmd` resolve through Node and installed npm CLI scripts; other `.cmd`/`.bat` commands are refused. A pass requires exit zero without signal, cancellation, timeout or output kill. More than 1 MiB combined output triggers process-tree termination; each returned stdout/stderr tail is redacted and at most 8 KiB. Missing/refused executables produce failed check evidence without spending automatic repair runs.

`{none:true, reason}` reports `required:false`, `passed:null`, the reason and an empty attempts array. It performs no verification or automatic check-driven repair; Cline errors/questions still prevent ordinary successful completion.

### Recovery and caller actions

Sync final-check/Cline failures, unresolved questions and guard trips return failure evidence and restore by default. `keepOnFailure:true` explicitly retains failed edits as unverified. Async edits normally pause with these `waitReason` values:

| Reason | Meaning |
|---|---|
| `verify_failed` | Check failed after allowed repairs, or verification could not launch |
| `cline_question` | Cline requested input; partial edits are retained |
| `guard` | Repeated failure or cumulative tool/token budget stopped the run |
| `cline_error` | Cline/lifecycle error, including some snapshot/cleanup failures |
| `head_changed` | HEAD/index changed or identity could not be inspected |
| `budget` | Overall active-time budget exhausted |

Setup failures before a lock is acquired can instead finish as `failed`. While waiting, `cline_send` accepts:

- `retry`: one additional launch with optional guidance, retaining partial edits and the original snapshot. It also answers a question. Automatic-fix capacity and consumed budgets are not reset.
- `restore`: restore the original baseline and finish. Refusal/incomplete restoration stays visible with recovery evidence.
- `keep`: finish with current edits explicitly unverified. Identity refusal retains the recovery snapshot.

Cancellation aborts active work, attempts restoration, then releases the lock and publishes `cancelled`; identity refusal or incomplete restoration retains recovery evidence. Once completion has committed, cancellation waits for settlement. Ask/workspace cancellation has no edit snapshot and waits up to 5 seconds for an active run to settle.

### Snapshot and checkout lock

The single snapshot survives initial work, fixes, manual retries and question resumes. It copies tracked and untracked non-ignored working-tree bytes outside the checkout, normally under the OS temp directory's `cline-mcp-snapshots`. It preserves dirty/binary files and tracked deletions. Existing staging is preserved through unchanged index identity; the index is not backed up or restored.

Limits are 20,000 files, 64 MiB per file and 512 MiB total. Unsupported paths, submodules, nested repositories, symlinks/reparse points and oversized snapshots are refused. Ignored files are excluded; restore leaves ignored content untouched and reports baseline paths that have become ignored. Restore replaces modified/deleted baseline files and removes newly created non-ignored files, returning to pre-run bytes rather than HEAD.

Identity is checked before/after launches, after verification and before restore. Changed/unreadable HEAD or index refuses restoration, retaining snapshot/evidence; no Git reset or staging is performed. Partial restore failures retain recovery bytes. The canonical-checkout lock is shared across sync/async bridge writers and held during async waits; dead-holder locks can be reclaimed. It does not block unrelated editors or Git clients, so use the checkout exclusively during an edit lifecycle.

### Budgets and verification result

Each edit launch has one runner attempt, without hidden transient/timeout retries. Tool-call and input-token caps accumulate across initial work, fixes, questions and manual retries; each launch receives remaining capacity. Loop/window detection remains per invocation. `timeoutSeconds` is the cumulative active lifecycle budget (sync default 180/max 300; async default 600/max 1800), excluding caller waits; the check's timeout is an additional bound. Recovery, cleanup and final Git inspection can extend call wall time.

`verification` appears in sync lifecycle responses/errors, async status and async results (also inside `result`):

```ts
type Verification = {
  required: boolean;
  passed: boolean | null; // null for none or before any check
  command: Exclude<Verify, { none: true }> | null;
  reason?: string;
  attempts: Array<{
    run: number; passed: boolean; exitCode: number | null; signal: string | null;
    timedOut: boolean; killedForOutput: boolean; durationMs: number;
    stdoutTail: string; stderrTail: string; error?: string;
  }>;
  fixRuns: number;
  restored: boolean;
  kept: boolean;
};
```

`fixRuns` counts repair/continuation launches after the initial launch, including manual/question continuations; the automatic limit is tracked separately. Inspect `restored`/`kept` and terminal state alongside `passed`, which records the last check rather than rechecking restored bytes. Sync final Git diff/status inspection occurs after successful lifecycle completion and snapshot disposal; a later inspection error does not roll that completed work back.

### Breaking changes

Edits now require `verify` (command or reasoned `none`). `steps`, `stepBudget`, and the `skip`/`stop` actions are removed and rejected, along with the ledger, plan view and plan outcomes. Use one complete check suite and retry/restore/keep. Sync failures restore by default; retaining failed edits requires `keepOnFailure`.

## Loop and budget guard (Stage 9)

`guard` is accepted by sync workspace/edits and all async modes. Synchronous ask calls have no guard input.

| Parameter | Default | Integer range |
|---|---:|---:|
| `maxRepeatedFailures` | 3 | 2-20 |
| `window` | 10 | 3-50; must be at least `maxRepeatedFailures` |
| `maxToolCalls` | 150 | 10-1,000 |
| `maxInputTokens` | 1,500,000 | 10,000-20,000,000 |

`loop_detected` means repeated failures with the same tool/target signature within the sliding window. File tools use normalized paths, command tools use their command, and other tools use an input signature. Successes and unrelated calls consume window positions. `budget_exceeded` means tool calls or input tokens exceeded their limit; input usage combines incremental/cumulative reports without counting both twice.

When available, a final guard report includes counters, window, touched files, recent redacted errors and optional tripped kind/tool/target/count and assistant-text excerpt. Async guard trips pause; sync calls fail. Edit recovery follows the final-check rules above; guard trips do not automatically launch repairs.

## Environment, working rules and code map (Stage 10)

Workspace/edits system prompts identify the actual directory, whether it is a disposable worktree or checkout, and the OS. Shared rules request batched independent operations, combined searches, whole-file reads below about 600 lines, ranges of at least 200 lines for larger files, no repeated reads, and a new approach or failure report after two failures. These are instructions to Cline, not filesystem isolation.

`codeMap` defaults to true for workspace/edits and is rebuilt for each launch. By default it lists tracked paths, line counts and regex-detected declarations with 1-based positions; prompt-mentioned paths come first. Workspace maps use the detached HEAD worktree; edits maps read current tracked files, including dirty contents. The regex map does not include untracked files.

Scanning is bounded by 3,000 files, 512 KiB per file and 1,500 ms. Generated/vendor paths, minified files, lockfiles and binary/non-UTF-8 files are excluded. Maps are at most 6,000 characters, reduced for combined text limits and a 1,000-unit Windows command-line margin; they may be partial or omitted. Symbols are shortened before dropping lower-priority paths; set `codeMap:false` to omit the map.

Stage 13.3 optionally replaces this regex map with the local structural indexer. Set `CODEINDEX_CLI` to an absolute path such as `C:\Develop\codeindex\dist\cli.js` in the bridge's environment and restart the bridge. There is no codeindex package dependency or network access. The adapter launches `process.execPath` with that script, `shell:false`, `map --root <same map root> --json --budget <chars> --deadline-ms <ms>`, and sends the prompt on stdin. It accepts map schema version 2, caps stdout at 64 KiB, and ignores stderr. Structural maps can include eligible untracked files and report candidate call relationships; codeindex's own exclusions and cache contract apply.

Missing/unset/relative CLI paths, launch failures, nonzero exits, deadlines, invalid JSON/schema and oversized replies silently use the regex map. Cancellation kills the child process tree and propagates without fallback. Codeindex gets up to 10 seconds; process termination and regex fallback each reserve up to 1,500 ms within a shared preparation bound of 13 seconds, reduced to the remaining run budget when smaller. Preparation is charged against the run deadline, including edit lifecycle deadlines. Both map sources retain the 6,000-character map cap, 24,000-character combined-text cap, escaped Windows command-line limit minus 1,000, and omission below 800 units of headroom. The structural CLI's requested budget is conservatively reduced for Windows escaping.

Sync workspace/edit results, async status/results and per-run history expose `codeMapSource: "codeindex" | "regex" | "none"` alongside guard/warning information. It identifies the map included in the latest launch; `none` means disabled, omitted, or preparation has not yet produced a map. Failures carry the source when available. Maps are rebuilt for resumed and repair launches, so their source can change between runs.

Known source mismatch: the generated header and working rules describe positions as exact "at HEAD", but dirty edits maps describe current contents. Treat that label as inaccurate for dirty checkouts; the README does not change the generated instructions.

## Catalog, CLI state, updates and dashboard ping

`cline_list_models` reads the installed CLI's advertised free list from `@cline/llms`, enriches metadata and attaches recorded `last_status`; it does not infer free models from zero prices or guess IDs. Its JSON reply includes `provider`, `models`, `source`, `note` and, when state is readable, `cli`. Catalog snapshots are refreshed best-effort after listing and at startup.

`cline_ping` makes a one-attempt, no-tools PONG request and returns `state:available | rate_limited | quota_exhausted | unreachable`, provider/model, timestamps, reason, source and cache status, with available latency/reset/retry details. `force:true` bypasses fresh cached ping results. Default TTLs are 60 seconds for available/unreachable, 180 seconds for rate limits (reported retry delays are clamped to 5-3600 seconds), and the reported quota reset or next UTC midnight. A catalog entry is not proof that a model can answer.

| Local data | Default path | Override |
|---|---|---|
| CLI state | `~/.cline-mcp/state.json` | `CLINE_MCP_STATE_PATH` |
| Model status | `~/.cline-mcp/status.json` | `CLINE_MCP_STATUS_PATH` |
| Free-model snapshot | `~/.cline-mcp/catalog.json` | `CLINE_MCP_CATALOG_PATH` |
| Traces | OS temp directory's `cline-tasks/<runId>` | `CLINE_MCP_TRACE_DIR` |

CLI state records installed/catalog versions, update status, check time, previous version and failed versions. On tool calls, a due version check (at most daily) can start background `npm view cline version`; an eligible update runs when the settings journal has no live runs. The settings mutex covers install, on-disk version verification, catalog reload, self-check pings of up to three candidates and any rollback. Failed updates attempt rollback when the previous version is known; rollback failure is reported as `broken`. State is `ok | update_available | updating | rolled_back | broken`, and recorded failed versions constrain later offers. Version checks have a 30-second timeout; install/rollback commands have a 300-second timeout. This is automatic bridge behavior, not Cline's own updater.

Replies attach `cli` while update state is non-OK; `cline_list_models` requests it even when OK. State read failures can omit it. Provider-settings coordination restores only the bridge-managed provider/model/reasoning selection, preserving other settings and refreshed credentials.

After building, the dashboard-oriented refresh command is:

```powershell
node dist/pingall.js
```

It lists free models, refreshes status via sequential forced pings and emits a one-line JSON summary, with a 120-second overall cap. Models not reached within the cap are reported as skipped. This updates local status data; it does not serve a dashboard page or guarantee every model is available.

## Errors, traces and cleanup

MCP replies carry text content; JSON tools encode their payload in that content. Sync edits return structured JSON errors with available verification/recovery evidence, guard, trace and metrics; other handlers can return formatted error text. Validation or early setup errors need not contain `verification`. Preserve recovery paths before discarding a result.

Common error identifiers include `launch_failed`, `catalog_unavailable`, `workspace_not_git`, `workspace_setup_failed`, `workspace_cleanup_failed`, `edits_inspection_failed`, `checkout_busy`, `settings_lock_timeout`, `settings_restore_failed`, `cline_updating`, `quota_exhausted`, `non_zero_exit`, `transient_provider_error`, `timeout`, `cancelled`, `malformed_json`, `missing_final_result`, `loop_detected` and `budget_exceeded`. Task-control errors are `task_limit`, `task_not_found`, `task_running` and `task_not_waiting`. Verification internally distinguishes `verification_refused` and `verification_launch_failed`; these become failed attempt evidence, with async `verify_failed` waiting or a sync failure. They are not guaranteed top-level MCP error kinds.

Only synchronous analysis (`ask_cline`, `ask_cline_workspace`) permits a runner retry for eligible transient/timeouts when budget remains. Async and edit launches use one attempt. Terminal Cline output can still be accepted with a warning after a nonzero exit or signal; edit success additionally depends on the bridge check or explicit opt-out.

Traces contain redacted `events.ndjson` and coalesced `status.json`; streaming deltas are excluded from persisted events. Event files are capped at 5 MiB and live traces heartbeat every 30 seconds. Startup cleanup removes eligible old finished/orphaned traces after 24 hours, with a separate seven-day stale-live bound. Secret redaction is applied before output tails are cut. Client disconnect/shutdown aborts active work and waits for cleanup within a 120-second shutdown budget; failures retain available recovery evidence rather than claiming cleanup succeeded.
