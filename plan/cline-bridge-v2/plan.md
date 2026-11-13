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

## Stage 10 — Working rules for Cline (agreed with the owner on 2026-11-11)

Live runs on 2026-11-11 showed Cline reading whole files, getting truncated output and reading them again,
which burned the token budget and time. The bridge adds standing working rules to every task so Cline works
economically and finishes. These rules are also the base for micro-steps later (option C, each step is one task).
Roles: Codex codes, AGY reviews. All prompts and replies with other models in English.

| Step | Work | Done when |
|---|---|---|
| 10.0 | Research: what Cline 3.0.74 already offers (rules files, line-range reads, search tools, how the bridge builds the prompt today). Short proposal to the owner. | Owner agrees. |
| 10.1 | Working rules: search before reading, read line ranges, continue a truncated read instead of re-reading, stop and ask after 2 failures on the same thing, a closing summary (files read/changed, not verified, open). Delivered through the mechanism 10.0 picks. | Tests; the rules reach Cline in every mode. |
| 10.2 | Definition of done in the task prompt: required output shape per mode. | Tests. |
| 10.3 | Code map: before a workspace/edits run the bridge builds a compact map (files, top-level symbols with line numbers, regex per language, no new dependency) within a token cap (~2k) and puts it at the top of the task. Idea taken in part from LLMTooling/code-search-mcp (symbol search) without adding its server or tools to Cline. | Tests; capped; skipped cleanly on huge or unknown repos. |
| 10.R | AGY review. | No open findings. |
| 10.L | Live: the same task in three variants (today, rules, rules + map); compare tokens, time and success. | Fewer tokens or re-reads, same or better result. |

## Stage 11 — Micro-steps (research option b; agreed with the owner on 2026-11-12)

Research: [stage11-research.md](stage11-research.md). Plan reviewed by Codex (27 points, 2026-11-12); the agreed
minimal v1 is below (D-32). The caller plans (any model), Cline executes one small step per run, the bridge verifies,
and restores a failed step. Sequential only. Roles: Codex codes, AGY reviews.

**Contracts (v1)**
- Steps: `cline_start` mode `edits` with `steps` (1-16): `{id: [A-Za-z0-9_-]{1,64} unique, instruction: 1-4,000 chars,
  paths?: <=32 relative paths (context hints, validated: no traversal, no .git, no device/ADS names), verify: {command,
  args?, timeoutSeconds? (default 60, max 300)}}`. `verify` is mandatory. Unknown fields rejected; input <= 64 KiB.
- Per step: a fresh Cline run with the objective (the task prompt), the current step, a ledger of verified steps
  (id, one-line summary, changed files; rendered <= 4,000 chars) and the code map, within the existing prompt and
  Windows command-line limits (optional context shrinks first).
- Verification: no shell; cwd = checkout root; stdin closed; timeout; output tails 8 KiB per stream, killed above
  1 MiB; pass = exit 0 without timeout/kill. Windows: `npm`/`npx` run as `node.exe` + resolved `npm-cli.js`/`npx-cli.js`;
  other `.cmd`/`.bat` rejected.
- Snapshot before each step: raw bytes of tracked + untracked (not ignored) files into a folder outside the checkout,
  with a manifest (path, size, hash). Limits: 20,000 files, 64 MiB/file, 512 MiB total; above → refuse before
  launching. Restore after a failed step: rewrite modified/deleted files, remove files added by the step. Never stages,
  never touches HEAD, the index or ignored files. Submodules, nested repos and reparse points → refused in v1.
- HEAD or index changed during a step → fail closed (no reset), task waits with evidence.
- One writer per checkout: a lock (in-process and a lock file under `~/.cline-mcp/locks`) shared by all edits paths,
  held until the plan ends, also while waiting.
- Waiting and answers: verification failure, guard trip or Cline error → restore the step, then `input_required`
  with a typed reason. `cline_send` gains `action: retry | skip | stop` (default: retry with the message as guidance).
  retry = rerun the step from its baseline; skip = record unverified and move on; stop = end, keeping verified steps.
  Max 3 Cline launches per step. A Cline QUESTION inside a step keeps the partial edits and resumes the same step.
- Status/result: current step id/index/total, phase (snapshot/run/verify/restore/waiting), attempt, per-step records
  (state, summary, changed files, verification tail, restore outcome); final result `completed`,
  `completed_with_skips` or stopped, with usage summed over all runs.
- Cancel at any phase: stop the process, restore the unverified step, release the lock.
- Budgets: per-step and per-plan tool calls and input tokens (summed guard counters), plus the per-step launch cap.

| Step | Work | Done when |
|---|---|---|
| 11.0 | Research, proposal, Codex plan review. | Done 2026-11-12. |
| 11.1 | Building blocks: snapshot/restore module, checkout lock, verification runner (pure modules). | Unit tests incl. dirty/staged/untracked/binary files, deletions, renames, limits, Windows npm. |
| 11.2 | Step orchestration in tasks: schema, per-step runs with ledger, verify, restore, advance, `cline_send` actions, status/result, cancel. | Tests with fake runs. |
| 11.3 | Budgets per step and plan; README and tool descriptions. | Docs match code. |
| 11.R | AGY review. | No open findings. |
| 11.L | Live on a throwaway repo: a 3-4 step change as micro-steps vs one run; compare success, time and tokens. | Micro-steps succeed at least as often. Done: [stage11-results.md](stage11-results.md). |
| Later | `cline_plan` (automatic planning), parallel steps. | — |

## Stage 12 — Mandatory final check with automatic fixes; micro-step orchestration removed (owner, 2026-11-13)

Why: experiment 2 (stage11-results.md, D-33) showed micro-steps cost ~4x for one extra passed check out of 21; the
only single-run miss was silent, which a final check catches cheaply. The owner chose to remove the micro-step
orchestration and make the final check strong and mandatory. Roles: Codex reviews the plan and codes, AGY reviews.

**Contracts (draft, for Codex review)**
- Removed: `steps`, `stepBudget`, `cline_send` actions `skip`, the step ledger and plan view (`src/steps.ts` and its
  task wiring). Kept: `src/snapshot.ts`, `src/checkoutlock.ts`, `src/verify.ts`.
- `verify` is required on every edit run (`apply_cline_edits`, `cline_start` mode `edits`): either
  `{command, args?, timeoutSeconds?}` (same rules as Stage 11: no shell, npm/npx via node, 60 s default, 300 s max,
  8 KiB tails) or `{none: true, reason: string(10-500)}` as an explicit, reported opt-out.
- Flow: lock → snapshot → Cline run → verify → pass: done. Fail: up to 2 automatic fix runs (`maxFixRuns` 0-3,
  default 2), each a fresh Cline run with the objective, the failing command and its output tail, and "fix only what
  the check reports" → verify again. Still failing: sync tool returns failure with evidence and leaves the changes
  (no automatic restore); async task goes to `input_required` (`waitReason: verify_failed`), `cline_send` actions:
  `retry` (another fix run with the caller's guidance), `restore` (restore the snapshot and stop), `keep` (stop and
  keep the changes, reported unverified).
- Guard trip or Cline error on the first run: as today (async → input_required), plus `restore` available.
- Result: `verification: {required: true|false (none), passed, command, attempts: [{run, passed, exitCode, timedOut,
  stdoutTail, stderrTail}], fixRuns, restored}`; `log_run_hint.ok` only when the final check passed (or `none`).
- Budgets: the fix runs count toward the task's guard budgets.

**Agreed after the Codex plan review (2026-11-13, 16 points, D-34)**
- One edit lifecycle shared by sync and async; only async may pause. One snapshot taken before the first run is kept
  through all fix runs and question resumes; `restore` undoes the first run and every fix, back to the owner's
  pre-run bytes (not to HEAD).
- Sync failure (check still failing after fix runs, unresolved QUESTION, guard, Cline error): return the evidence and
  restore by default; `keepOnFailure: true` keeps the changes, reported unverified.
- HEAD/index identity checked before/after each run, after verification and before restore; a change → refuse, keep
  the recovery snapshot, report (replaces the old soft-reset recovery in edits).
- Fix prompt: objective, latest caller guidance, exact command/args, exit/timeout/output-limit status, redacted tails;
  "fix the code, never weaken or bypass the check". Fits 20,000 prompt / 8,000 system / 24,000 combined / Windows
  32,000; optional context (map, older history, long tails) trimmed first.
- `{none: true, reason}`: strict, reason 10-500 chars, reported as `required: false, passed: null`.
- Async QUESTION during a fix: `input_required` (`cline_question`), edits, snapshot and lock kept. Cancel at any phase:
  stop processes, restore, then publish the terminal state, release the lock; keep recovery evidence if restore fails.
- Budgets: guard budgets cumulative over first run, fixes, resumes and manual retries (never refunded); no hidden
  runner retries in this lifecycle; an overall active-time budget besides the per-check timeout. A refused or missing
  verify executable fails at once without spending fix runs.
- `cline_send` actions for edits: `retry` (one more fix run with guidance; does not reset the automatic count),
  `restore`, `keep`. `skip` and `stop` are removed.
- `log_run_hint.ok` only for success with a passing check or `none`; null while waiting, cancelled, or local failure.
- Order: shared lifecycle module + sync/async adapters with converted tests → delete step orchestration → docs →
  review → live. D-33's micro-step fallback and the OpenCode port are superseded.

| Step | Work | Done when |
|---|---|---|
| 12.0 | Plan, Codex review, agreement. | Done 2026-11-13 (D-34). |
| 12.1 | Remove micro-step orchestration; keep building blocks; tests updated. | Suite green, no `steps` in schemas or README. |
| 12.2 | Mandatory `verify` + automatic fix runs, sync and async; `cline_send` retry/restore/keep; result shape. | Tests: pass first time; fail→fix→pass; fail after fixes (sync report, async wait); restore; keep; `none` opt-out; guard trip. |
| 12.3 | README and tool descriptions. | Docs match code. |
| 12.R | AGY review. | No open findings. |
| 12.L | Live: the 7-check experiment, 3 runs with the final check as the full check suite. | Every run ends 7/7 or reports the failure; cost close to a single run. Done: [stage12-results.md](stage12-results.md). |

## Later — the same micro-steps for OpenCode (owner's idea, 2026-11-10)

Once Stage 9 works with Cline, apply it to the OpenCode helper (`C:\Develop\openCodeHelperMcp`), where
each step can use a different free model by role: one to plan, one to execute, one to review.

## Stage 13 — Structural code context for delegated models (owner, 2026-11-13)

Why: the owner asked what context each delegated task should carry. Research
([stage13-research.md](stage13-research.md)) shows that general overview files and natural-language
per-file summaries barely help (no gain in success, more than 20% higher cost), while structural
information helps small models most: definitions, references and callers gave +6-18 points of
localization accuracy for models up to about 14B, in fewer steps. Our free models are in that group,
and the Stage 10 map already lifted the hard task from 0/2 to 5/5. The map costs the orchestrator
nothing, because the bridge inserts it into the free model's prompt. Roles: Codex reviews the plan and
codes, AGY reviews.

**Design (draft, for Codex review)**
- One shared component, `codeindex` (a new local package, `C:\Develop\codeindex`, Node/TypeScript):
  - a library and CLI that parse tracked files with tree-sitter (WASM, no native build) for TS/JS and
    Python first, and other languages by fallback to the existing regex symbols;
  - it records definitions (kind, name, file, line range) and identifier references with the
    enclosing definition, so "who calls X" is a lookup;
  - the cache lives outside the checkout (`~/.cline-mcp/codeindex/<sha256 of root>`), keyed by Git
    blob hash, so only changed files are re-parsed and dirty files are read from disk;
  - CLI: `codeindex map --root <dir> --query <text> --budget <chars> --json`,
    `codeindex def <name>`, `codeindex refs <name>`, `codeindex outline <file>`.
  - Bounds: as today (3,000 files, 512 KiB per file, time budget 1.5 s for a map on a warm cache; the
    first index build may take longer and runs once).
- **Query-focused map** (replaces the regex list as the default in both bridges, when `codeindex` is
  present):
  - anchors are the paths and identifiers named in the prompt (LARGER-style lexical anchoring);
  - expand to definitions, callers and callees one hop out, rank with personalized PageRank over the
    reference graph seeded by the anchors, then render signatures and `file:line` within the existing
    6,000-character budget and the Windows command-line clamp;
  - with no anchors, fall back to the current repository-level map.
  - Both bridges call the CLI as a bounded subprocess (`CODEINDEX_BIN` or a known path). If it is
    missing, slow or failing, they use the current map, with no error. The public OpenCode repo gets no
    hard dependency.
- **Structural tools for the model (arm B):** `codeindex` also serves a read-only stdio MCP server with
  `find_definition`, `find_references` and `outline`. First check (13.0) whether Cline CLI 3.0.74 and
  OpenCode 1.19.5 can attach an extra MCP server per run without changing global config. If not, arm B
  is dropped.
- **Project brief (arm C):** an optional `.codeindex/brief.md` or the repository's `AGENTS.md`, cut to at
  most 1,000 characters, holding only non-standard facts (the test command, conventions, places not to
  touch). Off by default.
- **No natural-language per-file index.**
- **Orchestrator side:** register the `codeindex` MCP server in Claude Code, and add to CLAUDE.md that
  pure lookups ("where is X defined", "who calls Y", "what is in file Z") use it directly with no model
  call.

**Measurement (13.L)**
- Arms: A0 current regex map, A1 query-focused map, A2 = A1 + structural tools, A3 = A1 + brief.
- Tasks:
  - 10 localization questions with hand-checked answers on this repository (file and function);
  - the Stage 10 hard analysis task;
  - the Stage 12 7-check edit task.
- Runs: at least 5 per arm and task, because of the 9% run-to-run noise floor. Analysis runs on both
  bridges; the edit task runs on OpenCode.
- Report: success, time and free-model tokens per arm, plus Claude-side tokens for the lookup rule.
- Adopt an arm as the default only if success is not lower and time or tokens fall, or success rises by
  more than the noise.

**Agreed after the Codex plan review (2026-11-13, 9 points, D-35 draft)**
- Lifecycle facts: the Cline workspace map is built inside the disposable HEAD worktree; edits map the
  live checkout; `tasks.ts` forwards `codeMap` to later runs; OpenCode builds a map per launch, repairs
  included. There is no persistent index today.
- Budgets: keep every existing limit: 6,000 map characters, Cline's 24,000 combined text, the escaped
  command line at 32,000 minus 1,000 with no map below 800 characters of headroom, OpenCode preparation
  counted in the attempt budget, and the edit lifecycle deadlines. A cold build, the fallback and
  process-tree termination share one bound. Cancellation never launches the fallback.
- Packaging: one package with library and CLI. The bridges use an optional CLI adapter: `node` plus an
  absolute script path, `shell:false`, query on stdin, and a bounded, versioned JSON reply. No
  duplicated implementations, and no hard dependency in the public OpenCode repo.
- Cache:
  - keyed by canonical repository identity, not by the worktree path;
  - content-addressed parse records keyed by a hash of the actual bytes (dirty and CRLF included) plus
    the grammar, query and schema versions;
  - per-checkout manifests that handle deletions and renames;
  - atomic publication, bounded locking and an eviction rule.
  - A record is never served across roots without re-checking the content hash.
- References are candidates, not resolved facts. Imports, aliases, shadowing, dispatch and dynamic
  Python calls are not resolved. Results use scoped symbol IDs and separate calls from other
  references.
- v1 ranking: lexical and path anchors, deterministic weighted one-hop expansion, and a penalty for
  high-degree symbols. Personalized PageRank only later, if an ablation shows value.
- Parser: `web-tree-sitter` with pinned prebuilt WASM grammars (javascript, typescript, tsx,
  python). A feasibility gate covers ABI compatibility, offline assets, Windows paths, Node 20+,
  Unicode offsets, syntax errors, memory disposal and interruptible parsing.
- Arm B, conditional and deny-by-default:
  - Cline: only an isolated `--config` / `--data-dir` directory holding its own MCP settings, and only
    if provider state still works there. There is no per-run MCP flag.
  - OpenCode: `OPENCODE_CONFIG_CONTENT` with only the three named MCP tools allowed, writes, bash,
    tasks and external directories still denied, and the permission validator extended explicitly.
  - The server itself enforces root containment and the hidden, credential and generated-path
    exclusions.
- Measurement, reduced:
  - A pilot first: A0 against A1, paired and randomized, with fixed commits, models, budgets and
    scoring. Expand only if it is promising.
  - Five runs are exploratory, not proof of non-regression.
  - Report localization rank, correctness, failures, tool calls, tokens, and cold and warm latency.
  - Do not assume the 9% noise figure or the model sizes. Stage 10 measured rules and map together.
- A brief is untrusted data. "No model call" on the orchestrator side means no delegated analysis
  call.

| Step | Work | Done when |
|---|---|---|
| 13.0 | Contracts and security fixtures (output schema, root containment, excluded paths, budgets, cancellation). | Written in the plan; fixtures in the package. |
| 13.1 | Parser and cache feasibility: WASM stack offline on Windows, cache identity and concurrency. | Short note in stage13-research.md; go/no-go. |
| 13.2 | `codeindex` library and CLI (def/refs/outline/map, v1 ranking) with tests. | Deterministic output within budget on fixtures. |
| 13.3 | Static-map integration in both bridges through the CLI adapter, with silent fallback. | Existing suites green; tests for fallback, the budget clamp and cancellation. |
| 13.P | Pilot A0 against A1 (localization questions plus the hard analysis task, both bridges). | stage13-results.md; go or stop. |
| 13.4 | Optional: MCP tools for models (arm B), only after the pilot and feasibility checks. | Read-only proven; measured. |
| 13.5 | Optional: brief (arm C). | Measured. |
| 13.6 | Orchestrator lookup rule and Claude Code registration (after owner OK). | One live lookup with no delegated call. |
| 13.R | AGY review per code step. | No open findings. |
