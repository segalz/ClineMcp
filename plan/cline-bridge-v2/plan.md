# Cline Bridge v2 — Plan

Created: 2026-11-09. Repository: `C:\Develop\ClineMcp` (MCP server `cline-local`).
Companion files: [progress.md](progress.md) (status per step), [decisions.md](decisions.md) (decision log).

## Goal

Turn the bridge from "fire and hope" into a dependable, observable tool:

1. It never depends on Cline's saved default model.
2. It can tell the caller which free models exist right now.
3. Parallel calls do not block each other on the settings file.
4. The caller can follow Cline's reasoning and actions live.
5. Long tasks run asynchronously, with status, cancel and result.
6. When Cline needs input, the task stops and waits for the caller instead of guessing.

## Verified facts this plan rests on (experiments of 2026-11-09)

- **F1** Cline CLI 3.0.74 is the latest stable release on npm. Updating is not a fix.
- **F2** The "Insufficient balance $0.00" error came from a stale model ID saved in
  `~/.cline/data/settings/providers.json` (`nvidia/nemotron-3.5-super-vl:free`). The current
  catalog ID `cline-free/nemotron-3.5-super-vl` works for free through the CLI.
- **F3** The CLI writes the provider and model it was given back into `providers.json`
  (`lastUsedProvider`, `providers.<id>.settings.model`). The desktop app shares that file.
- **F4** `withProviderOverride` (`src/settings.ts`) holds the settings mutex for the whole run,
  and a waiting caller gives up after 30 s (`settings_lock_timeout`).
- **F5** `cline --json` streams NDJSON live: `agent_event` with `content_start` deltas for
  `reasoning` / `text` / `tool`, `content_end` with the full block, `iteration_start/end`,
  `usage`, `done`, and a final `run_result`. The first `hook_event` carries a `taskId`.
- **F6** A live tail of the events file works (verified with Monitor).
- **F7** In headless mode the `ask_question` tool does not stop and does not exit: the first
  option was auto-selected in ~27 ms and the run continued.
- **F8** The CLI has no "list models" command. The free catalog lives in the installed package
  `@cline/llms` (IDs `cline-free/...`, pricing 0).
- **F9** `src/parser.ts` deliberately drops all streamed events. `src/runner.ts` retries a
  failed run once (`maxAttempts` 2).

## Out of scope for v2 (deferred)

Micro-step splitting with a forced plan step; resume via `--id`; Cline `--zen` / `hub`;
an own agent loop on NVIDIA with a real `ask_caller` tool; A2A. See decisions D-08 and D-09.

---

## Stage structure: Code, then Verify

Every stage from 1 on has two phases, and the next stage starts only after Verify passes:

1. **Code** — the implementation steps (n.1, n.2, …) including their unit tests.
2. **Verify** — two gates, both recorded in progress.md:
   - **n.R Code review**: review of the stage's diff (correctness, error paths, settings safety,
     no secrets in output). Done by a reviewer other than the author.
   - **n.L Live check through the MCP**: call the bridge's own MCP tools (the built server,
     `cline-local`) and let the bridge drive the real Cline CLI on the free model
     (`cline-free/...`), in a scratch folder or a disposable worktree, with the exact scenario
     listed for the stage. Cline is never called directly. Record the tool call, the result and
     any `providers.json` diff.

A failed gate sends the stage back to Code; the reason is logged in decisions.md.

## Roles ("friends")

Cline is not part of the development process at all: no analysis, no code, no review (D-12).
It is only the system under test, reached through the bridge's MCP tools in `n.L`.

| Phase | Who | How |
|---|---|---|
| Pre-code analysis (one focused question per stage) | Codex via `agent-intern` `codex_ask` (default read-only sandbox) | Fallback: AGY `antigravity_ask`, then OpenCode `analyze_code`. |
| Code | Claude | AGY writes only if the user explicitly asks for it. |
| `n.R` code review | Codex `codex_ask` (read-only), author (Claude) excluded | Fallback: AGY, then OpenCode. Grok is not used (D-13). |
| `n.L` live check | Claude runs it | Through the bridge's MCP tools only; the bridge drives Cline on the free model. |
| After every delegated call | model-picker `log_run` | ok/failure, `error_kind`, `duration_s`. |

---

## Stage 0 — Baseline

| Step | Work | Done when |
|---|---|---|
| 0.1 | Commit or set aside the current uncommitted work (`src/ping.ts`, `src/status.ts`, edits in `index.ts`, `runner.ts`, tests) so v2 starts from a clean, known state. | `git status` is clean on a work branch (not `main`). |
| 0.2 | Run the existing test suite once and record the result. | Pass/fail recorded in progress.md. |

## Stage 1 — Short settings lock (prerequisite for everything else)

| Step | Work | Done when |
|---|---|---|
| 1.1 | Replace "lock for the whole run" with: short lock at start (snapshot the original `lastUsedProvider` and the target provider's `settings.model`, increment an active-run counter in the journal), release, run, short lock at end (decrement; when the counter reaches 0, restore only those two fields). | Lock is held only around snapshot and restore. |
| 1.2 | Keep crash safety: the journal still lets the next start recover the original values if the bridge died mid-run. A stale counter is reset by checking whether the recorded PIDs are still alive. | Test: a simulated crash mid-run restores the original values on the next call. |
| 1.3 | Tests: two overlapping runs both succeed with no `settings_lock_timeout`; the original values are restored only after the last one ends; tokens and other fields are never touched. | New tests pass. |
| 1.R | Code review of Stage 1 diff. | No open blocking findings. |
| 1.L | Live: start two `ask_cline` calls at the same time on the free model. | Both answer; `providers.json` equals the pre-run snapshot afterwards (secrets compared by hash only). |

## Stage 2 — Explicit model is mandatory

| Step | Work | Done when |
|---|---|---|
| 2.1 | Make `provider` and `model` required in `ask_cline`, `ask_cline_workspace`, `apply_cline_edits`, `cline_ping`. Remove the `resolveSavedSelection` fallback from the run path. | A call without a model fails before Cline is launched. |
| 2.2 | The error for a missing or unknown model lists the free models currently available (from Stage 3; until then, a plain message). | Error text names valid IDs. |
| 2.3 | Tests for the schema change and the error. | Tests pass. |
| 2.R | Code review of Stage 2 diff. | No open blocking findings. |
| 2.L | Live: call without a model (expect a clear refusal, Cline not launched); call with `cline-free/...` (expect an answer). | Both behave as expected. |

## Stage 3 — Free-model discovery

| Step | Work | Done when |
|---|---|---|
| 3.1 | New module that loads the model catalog from the installed `@cline/llms` package (resolved from the same Cline install path the runner uses) and returns entries with zero pricing, with id, name, context window and capabilities. | Returns `cline-free/...` IDs on this machine. |
| 3.2 | If the internal catalog cannot be loaded (Cline update changed it), fail with a clear `catalog_unavailable` error. Never guess IDs. | Test with a missing/changed package. |
| 3.3 | New tool `cline_list_models` (`free_only` default true). Optionally joins the last `cline_ping` result per model from `status.json`. | Tool returns the list plus last-known availability. |
| 3.4 | Tests. | Tests pass. |
| 3.R | Code review of Stage 3 diff. | No open blocking findings. |
| 3.L | Live: `cline_list_models`, then `cline_ping` and one `ask_cline` on a model from the list. | The listed model answers. |

## Stage 4 — Event capture and live status

| Step | Work | Done when |
|---|---|---|
| 4.1 | Write every NDJSON line from Cline to `%TEMP%\cline-tasks\<taskId>\events.ndjson` as it arrives (in addition to the existing final-result parsing). | File grows live during a run. |
| 4.2 | Redact secrets before writing (reuse `redactSecrets`). Cap file size (e.g. 5 MB, then keep only `content_end` summaries). | Tests for redaction and the cap. |
| 4.3 | A separate status reducer (not `parser.ts`) folds events into `status.json`: state, iteration, current tool + target, last reasoning (≤300 chars), files touched, elapsed, last question seen. | Reducer unit tests from recorded event fixtures. |
| 4.4 | Cleanup: delete a task folder when its result is collected or after a TTL; delete orphans on bridge start. | Test for TTL and startup cleanup. |
| 4.R | Code review of Stage 4 diff (focus: redaction, file size, cleanup). | No open blocking findings. |
| 4.L | Live: a multi-step read-only task; follow `events.ndjson` while it runs. | Reasoning, tool calls and the final result appear live; folder removed after collection. |

## Stage 5 — Async task model

| Step | Work | Done when |
|---|---|---|
| 5.1 | `cline_start(prompt, cwd, provider, model, mode)` returns `taskId` immediately (after the process spawned and the first event arrived, or a short timeout). Workspace tasks keep the disposable worktree. | Returns within seconds. |
| 5.2 | `cline_status(taskId, wait_seconds≤60)` long-polls: returns at once on a state change (question, done, failed), otherwise after the wait. | Test with fake process. |
| 5.3 | `cline_cancel(taskId)` kills the process tree; `cline_result(taskId)` returns the final text, usage and a `log_run_hint` (`ok`, `error_kind`, `duration_s` excluding time waiting for input). | Tests. |
| 5.4 | Guards: no automatic retry for async tasks; at most 2 concurrent tasks (clear refusal beyond that); total wall-time cap per task; orphan processes killed on bridge start. | Tests. |
| 5.R | Code review of Stage 5 diff (focus: process lifecycle, kill tree, concurrency). | No open blocking findings. |
| 5.L | Live: start a task, poll status, cancel a second task mid-run, start a third while two run (expect refusal), collect the result. | All behave as specified; no orphan `cline` processes remain. |

## Stage 6 — Questions from Cline to the caller

| Step | Work | Done when |
|---|---|---|
| 6.1 | System-prompt rule for bridge runs: never use `ask_question`; when input is needed, end the turn with a line `QUESTION: <question>` (optional `OPTIONS: a | b | c`). | Rule in place for all bridge runs. |
| 6.2 | Detection: the reducer marks `input_required` when the final text contains `QUESTION:`. Safety net: if an `ask_question` tool call still appears, mark the task `auto_answered` with the question and the auto-picked option, so the caller is never blind to it. | Fixture tests for both paths. |
| 6.3 | `cline_send(taskId, message)`: for `input_required`, start a fresh Cline run with a context file (original task, what was done, `git diff --stat` for workspace tasks, the question and the answer). Same `taskId`, new run number. | End-to-end test on the free model. |
| 6.R | Code review of Stage 6 diff. | No open blocking findings. |
| 6.L | Live: the "hello world, which language?" scenario from the experiment. | Task stops in `input_required` with the question; after `cline_send("Go")` the result uses Go; no `auto_answered` unless forced. |

## Stage 7 — Integrations and documentation

| Step | Work | Done when |
|---|---|---|
| 7.1 | `mcp-model-picker`: replace the `cline-default` model entry with explicit model IDs; add a separate backend `cline-task` for async tasks; map bridge errors to `error_kind` (`timeout`, `quota` with `retry_after_s`, `crash`; cancelled is not a failure). | Picker returns an explicit Cline model. |
| 7.2 | `mcp-model-picker`: read free Cline models from the bridge catalog (Stage 3) instead of `globalState.json`, which holds stale IDs. | Picker shows `cline-free/...` IDs. |
| 7.3 | Update the invocation contract in `C:\Users\segal\.claude\CLAUDE.md` (model now required, new tools) and the bridge `README.md`. | Docs match the tools. |
| 7.R | Code review of the model-picker diff. | No open blocking findings. |
| 7.L | Live: `pick` for an analysis task returns an explicit `cline-free/...` model; calling the bridge with it succeeds; `log_run` records the outcome. | End-to-end flow works. |

## Stage 8 — Reliable dashboard and safe CLI updates (local only)

Everything runs on demand: no timers, no background polling. Each machine manages its own CLI.
Cross-machine sharing is future work: [future-supabase.md](future-supabase.md).

| Step | Work | Done when |
|---|---|---|
| 8.1 | Local state file `~/.cline-mcp/state.json` (machine id, CLI and catalog version, update state `ok` / `update_available` / `updating` / `rolled_back` / `broken`, failed versions with reason, last real result per model). Shaped like the future Supabase rows; one sync hook that is a no-op. Written atomically under a local lock shared by all bridges on the machine. | Tests: concurrent bridges, atomic writes, schema. |
| 8.2 | Catalog follows the installed CLI without a restart: on each call the bridge compares the CLI / `@cline/llms` version and reloads the catalog and rewrites `catalog.json` when it changed. | Test: version change → new catalog, no restart. |
| 8.3 | model-picker picks free models from the catalog: a catalog model missing from `backends.toml` is added at runtime with default Cline priors; a model gone from the catalog is not picked. | Picker tests. |
| 8.4 | Dashboard shows facts: each Cline model's last real result with its time (no 60 s expiry for display); "not checked" when none; never "unavailable" without evidence. A dashboard refresh pings every catalog model once. | Dashboard tests; refresh is the only extra ping. |
| 8.5 | Daily CLI update check, started by the first real call of the day, in the background (never delays that call). Never retries a failed version; only a newer one. | Tests with a fake registry. |
| 8.6 | Safe update: install only when no Cline run is active on the machine (lock); calls arriving meanwhile wait up to 60 s; after install, load the catalog and ping one free model; on failure roll back to the previous version and record the failed version and reason. | Tests: busy → deferred; failure → rollback; lock → one updater. |
| 8.7 | Status everywhere: every bridge reply carries a short `cli` field when the state is not `ok`; the dashboard shows the CLI version (green: current or newer available; yellow: rolled back, with the failed version and reason). | Tests; docs updated. |
| 8.R | Code review of the Stage 8 diffs (bridge and model-picker). | No open blocking findings. |
| 8.L | Live: restart → dashboard shows last results, not "unavailable"; refresh pings; a simulated failed update rolls back and shows yellow; a second bridge sees `updating`. | All behave as specified. |

## Order and dependencies

Stage 0 → 1 → 2 → 3 (2.2 uses 3) → 4 → 5 → 6 → 7 → 8. Stages 1–3 alone already restore a working,
parallel-safe synchronous bridge and can be released before 4–6.

## Stage 9 — Loop guard (option B, agreed with the owner on 2026-11-11)

Research: [stage9-research.md](stage9-research.md). Cline's own guards count only consecutive identical calls
and are not configurable headless; the 2026-11-10 loop (61 failing edits with small variations, interleaved
with reads) slipped through. Micro-steps (option C) are deferred until the guard proves insufficient.
Built against real Cline runs: each step ends with a live run before review. Roles: AGY codes, Codex reviews.

| Step | Work | Done when |
|---|---|---|
| 9.0 | Research and agreement with the owner. | Done 2026-11-11: option B. |
| 9.1 | Detector over the `--json` events (pure function, no I/O): a failed tool call's signature = tool name + normalised target (path); trip when the same signature fails 3 times within the last 10 tool calls (not only consecutive). Budgets: max tool calls and max input tokens per run (defaults generous, overridable). | Tests with synthetic event streams, incl. the 2026-11-10 pattern. |
| 9.2 | On a trip, the runner stops Cline (existing tree kill) and returns kind `loop_detected` or `budget_exceeded` with a report: the repeated tool and target, the last errors (short, redacted), counts, files touched, last text. `log_run_hint` = `crash` with that reason. | Tests; sync tools return the report. |
| 9.3 | Async tasks: a trip does not end the task; it becomes `input_required` with a bridge question ("Stopped: N failed edits on X. How should it continue?"). `cline_send` resumes with the report in context (Stage 6 path). | Tests; a trip then `cline_send` continues. |
| 9.4 | Optional `guard` params on `cline_start` and the sync tools (`maxToolCalls`, `maxInputTokens`, `maxRepeatedFailures`); README and tool descriptions. | Docs match code. |
| 9.R | Codex review per step. | No open findings. |
| 9.L | Live: a real Cline run that repeats a failing edit is stopped by the guard and reported; a normal run is untouched. | Both behave as specified. |

## Later — the same micro-steps for OpenCode (owner's idea, 2026-11-10)

Once Stage 9 works with Cline, apply it to the OpenCode helper (`C:\Develop\openCodeHelperMcp`), where
each step can use a different free model by role: one to plan, one to execute, one to review.
