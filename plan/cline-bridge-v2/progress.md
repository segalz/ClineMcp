# Cline Bridge v2 — Progress

Plan: [plan.md](plan.md). Decisions: [decisions.md](decisions.md).
Status values: `todo`, `in progress`, `done`, `blocked`, `skipped`.

| Step | Title | Status | Date | Notes |
|---|---|---|---|---|
| 0.1 | Clean baseline on a work branch | done | 2026-11-09 | Prior work committed+pushed to main (b573b95, 2879ea3); branch `bridge-v2` |
| 0.2 | Record current test result | done | 2026-11-09 | `npm test`: 106 tests, 105 pass, 1 skipped, 0 fail |
| 1.1 | Short lock at start/end with active-run counter | done | 2026-11-09 | Journal v2: base + runs {runId: pid, provider, startedAtMs} (D-14) |
| 1.2 | Crash-safe journal and stale counter recovery | done | 2026-11-09 | Dead PID / >6 h runs pruned; v1 journals still recovered |
| 1.3 | Tests: overlapping runs, restore after last run | done | 2026-11-09 | 111 tests, 110 pass, 1 skipped; 6 new |
| 1.R | Verify: code review | done | 2026-11-09 | Codex round 1 FAIL (P1 cleanup masking, P2 model-only provider) → fixed; round 2 PASS |
| 1.L | Verify: live check against Cline | done | 2026-11-09 | Built server via MCP stdio: 2 concurrent `ask_cline` on `cline-free/nemotron-3.5-super-vl` → PONG1/PONG2, 2 runs in journal at once, selection restored, journal removed; only Cline's own token refresh changed |
| 2.1 | provider + model required in all tools | done | 2026-11-09 | zod schema, `requireSelection` in runCline, ping before cache, `withProviderOverride`; saved-default code removed (D-16) |
| 2.2 | Missing-model error lists free models | done | 2026-11-09 | Schema description and error point to `cline_list_models` (a zod validation error cannot carry a live list) |
| 2.3 | Tests for mandatory model | done | 2026-11-09 | 111 tests, 110 pass, 1 skipped |
| 2.R | Verify: code review | done | 2026-11-09 | Codex round 1 FAIL (helper accepted one field) → fixed; round 2 PASS |
| 2.L | Verify: live check against Cline | done | 2026-11-09 | Via MCP: `{}`, provider-only, model-only and ping without selection refused (-32602) in ≤4 ms, settings untouched; explicit `cline-free/nemotron-3.5-super-vl` → PONG, settings restored |
| 3.1 | Load catalog from installed @cline/llms | done | 2026-11-09 | Public export `GENERATED_CLINE_RECOMMENDED_MODELS.free` + `getGeneratedModelsForProvider("cline")` (D-17) |
| 3.2 | `catalog_unavailable` on load failure | done | 2026-11-09 | Also for prohibited ids and a missing entry; entry is realpath-resolved |
| 3.3 | Tool `cline_list_models` | done | 2026-11-09 | Joins last bridge status per model |
| 3.4 | Tests for discovery | done | 2026-11-09 | 118 tests, 116 pass, 2 skipped (symlink test needs Windows symlink privilege) |
| 3.R | Verify: code review | done | 2026-11-09 | Codex round 1 FAIL (prohibited ids, symlink root, `""` entry) → fixed; round 2 PASS |
| 3.L | Verify: live check against Cline | done | 2026-11-09 | After the user re-signed in (login had expired 22:49): list → 5 free models; ping: `cline-free/nemotron-3.5-super-vl`, `cline-free/solar-mini4`, `nvidia/nemotron-3.5-lightning-free` available; `poolside/laguna-s-2.1-free` "model not supported", `reflection/beam-free` "Insufficient balance" (listed ≠ usable; status join shows it). `ask_cline` on `nvidia/nemotron-3.5-lightning-free` → PONG; settings restored |
| 4.1 | Write events.ndjson live | done | 2026-11-09 | `src/trace.ts` TraceRecorder; per-attempt LineSplitter in runner; async ordered appends |
| 4.2 | Redaction and size cap | done | 2026-11-09 | Decoded-value redaction, sensitive keys redact subtrees, deltas never persisted, oversized/cut-off lines dropped with markers; 5 MB file / 1 MB queue caps (D-18) |
| 4.3 | Status reducer → status.json | done | 2026-11-09 | state, attempt, iteration, current tool+target, tool count, files, last complete reasoning/text, streamingChars, ask_question + auto-answer; 500 ms coalescing + 30 s heartbeat |
| 4.4 | Cleanup (TTL, orphans) | done | 2026-11-09 | On bridge start: finished > 24 h, dead-PID orphans, live PID silent > 7 days. Removal right after collection belongs to Stage 5 (D-19) |
| 4.R | Verify: code review | done | 2026-11-09 | Codex 6 rounds: partial-delta secret, recursion crash, unbounded finish, live-trace deletion, lost traces on wrapper/plain errors, oversized lines, structured-key gaps, retry task id → all fixed; round 6 PASS |
| 4.L | Verify: live check against Cline | done | 2026-11-09 | Via MCP `ask_cline` on `cline-free/nemotron-3.5-super-vl`: status.json changed every second during the run (iteration, tools, streaming chars, reasoning); response carried `trace`; 23 events, 0 deltas, 0 dropped. Side finding: `ask_cline` runs with auto-approve off, so Cline could not read files and asked for approval (pre-existing behaviour, see D-20) |
| 5.1 | `cline_start` | done | 2026-11-10 | `src/tasks.ts` TaskManager; modes ask/workspace/edits; taskId = trace runId |
| 5.2 | `cline_status` long-poll | done | 2026-11-10 | ≤60 s; returns on settle or a new question |
| 5.3 | `cline_cancel`, `cline_result`, log_run_hint | done | 2026-11-10 | Hint null for cancelled and local failures (D-23); trace folder removed after collection |
| 5.4 | Guards: no retry, max 2, wall cap, orphans | done | 2026-11-10 | maxAttempts 1, `task_limit`, 1800 s cap (sync stays 300), shutdown stops tasks AND sync calls, Git deadlines + tree kill (D-22) |
| 5.R | Verify: code review | done | 2026-11-10 | Codex 9 rounds (shutdown, hanging Git, trace recreation, hint mapping, retry checks, cleanup notes, Git tree kill) → round 9 PASS |
| 5.L | Verify: live check against Cline | done | 2026-11-10 | Via MCP: A+B in parallel, 3rd refused (`task_limit`); B cancelled at 4 s, its process gone, hint null; long poll returned when A finished (1,030 words, 19.8 s); trace folder removed on collection; closing the client mid-task killed its Cline (0 extra cline.exe) |
| 6.1 | `QUESTION:` protocol in system prompt | done | 2026-11-10 | AGY (D-24): `TASK_QUESTION_PREAMBLE` on every task run, combined with ask mode's no-tools notice |
| 6.2 | Detect input_required / auto_answered | done | 2026-11-10 | Trailing QUESTION/OPTIONS block only (D-25); `autoAnswered` surfaced; long poll returns on it |
| 6.3 | `cline_send` → fresh run with context | done | 2026-11-10 | Same taskId, run counter + history; prompt = original + previous answer + `git diff --stat` + full Q&A history (with options), budgeted for 20k chars and the Windows command line |
| 6.R | Verify: code review | done | 2026-11-10 | Codex 8 rounds (resume race, truncation, Windows budget, expiry, code-block questions, stale results, poll starvation, Q&A history, Git lifecycle, options) → PASS; AGY fixed every round; Claude verified each diff and test run |
| 6.L | Verify: live check against Cline | done | 2026-11-10 | Via MCP: "hello world, which language?" → `input_required` with 5 options; result call kept the task; `cline_send("Go")` → run 2 → Hello World in Go; hint ok, 37.5 s |
| 7.1 | model-picker: explicit models, `cline-task`, error_kind map | done | 2026-11-10 | AGY (D-27): 3 explicit Cline ids (model ids may contain `/`; unit split at first/last `/`), backend `cline-task` → `cline_start`; error_kind comes from the bridge's `log_run_hint` (picker instructions say pass it, skip when null) |
| 7.2 | model-picker: free list from bridge | done | 2026-11-10 | Bridge writes `~/.cline-mcp/catalog.json` at startup and on `cline_list_models` (D-26); picker reads it, no globalState fallback; Cline models absent from the catalog or with a fresh non-available status are not picked |
| 7.3 | Update CLAUDE.md contract and README | done | 2026-11-10 | CLAUDE.md: required provider/model incl. `cline_start`, pick unit format, task flow, log_run_hint; README Tools section rewritten for all 10 tools (AGY) |
| 7.R | Verify: code review | done | 2026-11-10 | Claude reviewed (Codex dropped by the user): round 1 found pick could choose a model missing from the catalog or quota-exhausted → AGY fixed; picker 3080 pass / 1 skip, bridge 186 tests 184 pass / 2 skip |
| 7.L | Verify: live check against Cline | done | 2026-11-10 | New code from the repos: bridge wrote catalog.json (5 free ids); `pick` → `cline/cline-free/nemotron-3.5-super-vl/fixed` and `cline-task/...` with `cline_start`; `cline_start` on it → done in 14 s, hint ok; `log_run` recorded it (temp ledger; the running picker loads the new config after a restart) |
| 8.1 | Local state file + lock + sync hook | done | 2026-11-10 | `src/clistate.ts`: `~/.cline-mcp/state.json` v1 (machine_id, cli version/state/failed versions), atomic + locked, no-op `syncHook` for Supabase (AGY) |
| 8.2 | Catalog reload on CLI change | done | 2026-11-10 | Installed CLI / `@cline/llms` versions checked per call (mtime cache); catalog reloaded with cache-busted import, no restart |
| 8.3 | Picker: catalog models pickable | done | 2026-11-10 | model-picker adds catalog models at runtime (mtime cache, lock); absent or evidenced-unavailable models not picked (AGY) |
| 8.4 | Dashboard: last real result, refresh pings | done | 2026-11-10 | Dashboard rebuilt by Claude with ui-ux-pro-max: every catalog model with last result + time, "לא נבדק" without one, card unavailable only with evidence; `backend_status(force)` runs `dist/pingall.js` once |
| 8.5 | Daily update check on first call | done | 2026-11-10 | First call after 24 h starts `npm view cline version` in the background; failed versions never retried, only newer ones |
| 8.6 | Safe update with rollback | done | 2026-11-10 | Install only with no live run (journal) under the settings mutex; self-check pings up to 3 candidates (last-available first); version verified on disk; rollback or `broken` |
| 8.7 | CLI status in replies and dashboard | done | 2026-11-10 | `cli` field in replies when not ok (always in `cline_list_models`); dashboard CLI line with text + tone + marker shape |
| 8.R | Verify: code review | done | 2026-11-10 | Claude reviewed: round 1 — self-check pinged an unusable model (would roll back every update), state could claim an uninstalled version, hard-coded default version; round 2 — a test overwrote the real `catalog.json`, 4 flaky tests → all fixed by AGY; bridge 207 tests 205 pass / 2 skip (×3, real files untouched), picker 3100 pass / 1 skip |
| 8.L | Verify: live check against Cline | done | 2026-11-10 | Live via MCP: state.json created, daily check ran (latest 3.0.74 = installed, ok), no `cli` field when ok; `pingall` pinged 5 models; forced `backend_status` (42 s) → 3 available, beam/laguna unavailable with evidence, `pick` → explicit model; real-data dashboard rendered. Rollback / `updating` verified by unit tests only (no newer CLI exists; a real failed install is not forced) |
| 9.0 | Research and agree the goal with the owner | done | 2026-11-11 | Codex static research of Cline 3.0.74; owner chose option B (bridge-side guard) |
| 9.1 | Detector over events | done | 2026-11-11 | AGY: src/guard.ts pure detector; signature = tool + target (paths, apply_patch headers, failing command text); 3 failures within 10 calls; tool-call and token budgets |
| 9.2 | Stop and report | done | 2026-11-11 | Runner stops Cline through the existing tree kill, kind loop_detected / budget_exceeded with a redacted report, never retried; trace marker guard_trip; hint crash |
| 9.3 | Async: input_required instead of failure | done | 2026-11-11 | Tasks go to input_required with a bridge question; cline_send resumes with a bounded report and 'do not repeat' |
| 9.4 | Guard params and docs | done | 2026-11-11 | Optional guard params on cline_start, ask_cline_workspace, apply_cline_edits (zod); README section; 241 tests pass / 2 skip |
| 9.R | Verify: code review | done | 2026-11-11 | Codex: 6 bugs reproduced on real 3.0.74 shapes (apply_patch targets, double-counted tokens, run_commands failures, path redaction, resume budget, report content) → fixed by AGY |
| 9.L | Verify: live check against Cline | done | 2026-11-11 | Live on real Cline: a normal run (Cline stopped after 2 failures by itself) untouched; a forced run tripped loop_detected on the 3rd failing `editor` edit, task → input_required with the report |
| 10.0 | Research and proposal | done | 2026-11-11 | stage10-research.md; owner approved option A and full autonomy for the optimisation (2026-11-11 night) |
| 10.1 | Working rules | done | 2026-11-12 | Codex: src/rules.ts; per-run environment line (cwd + OS) because the bridge's --system replaces Cline's default prompt; rule text v2 tuned live (v1 made Cline page in small slices) |
| 10.2 | Definition of done | done | 2026-11-12 | Rule 6: stop when the requested output is complete, follow the format exactly; edit mode keeps its closing summary |
| 10.3 | Code map | done | 2026-11-12 | Codex: src/codemap.ts, git ls-files + regex symbols, 6,000-char cap clamped to the Windows command line, 1.5 s / 3,000 files; codeMap param (default true). Also fixed: trace redacted numeric token counts |
| 10.R | Verify: code review | done | 2026-11-12 | AGY approved both rounds; two low notes left as is (snake_case token keys unused by Cline; extreme cwd already rejected by limits) |
| 10.L | Verify: live before/after | done | 2026-11-12 | 22 live runs, free model; see stage10-results.md. Hard task: today 0/2, rules+map 5/5 |
| 11.0 | Research and proposal | done | 2026-11-12 | stage11-research.md; Codex plan review (27 points) folded into a minimal v1 (D-32); owner approved |
| 11.1 | Building blocks | done | 2026-11-12 | Codex: src/snapshot.ts (raw-byte snapshot of tracked + untracked files, restore, HEAD/index identity), src/checkoutlock.ts (one writer per checkout, also wired into existing edits paths), src/verify.ts (no shell, npm/npx via node + cli.js) |
| 11.2 | Step orchestration | done | 2026-11-12 | Codex: src/steps.ts + tasks: steps on cline_start edits, ledger, verify, restore, cline_send action retry/skip/stop, 3 launches per step, status/result plan view. First Codex turn timed out at 30 min; continued |
| 11.3 | Budgets and docs | done | 2026-11-12 | stepBudget per step and per plan from summed guard counters; README Micro-steps section; 297 tests |
| 11.R | Verify: code review | done | 2026-11-12 | AGY approved both halves; 4 low findings (stale .reap, close before unlink, drive-letter case, verify resolution errors) fixed by Codex; 301 tests pass |
| 11.L | Verify: live comparison | done | 2026-11-12 | stage11-results.md: single 2/2, micro-steps 2/2 (all 4 checks); micro-steps ~2x time and tokens; question path verified live |
| 12.0 | Plan and Codex review | done | 2026-11-13 | Codex review (16 points) folded in; sync restores by default (D-34) |
| 12.1 | Remove micro-step orchestration | done | 2026-11-13 | Codex: src/steps.ts and its wiring removed; shared schemas moved to finalcheck.ts; snapshot/lock/verify kept; 294 tests |
| 12.2 | Mandatory verify with automatic fixes | done | 2026-11-13 | Codex: src/finalcheck.ts shared lifecycle; sync restores by default (keepOnFailure), async retry/restore/keep; identity refusal replaces soft-reset recovery |
| 12.3 | Docs | done | 2026-11-13 | README Final check + Breaking changes |
| 12.R | Verify: code review | done | 2026-11-13 | AGY approved both halves (sync lifecycle, async + removal) with no findings |
| 12.L | Verify: live rerun | done | 2026-11-13 | stage12-results.md: 3/3 full runs 7/7 at ~100 s / ~110k; 2/2 runs with a missing requirement fixed automatically in 1 fix run |

| X.1 | `ask_cline` no-tools notice + Windows length guard (D-21) | done | 2026-11-09 | Codex analysis + review (3 rounds: Windows command-line length, UTF-16 count) PASS; 139 tests; live 0 tool calls / 1 iteration |

## Session notes

- 2026-11-09 — Helper readiness check (D-12/D-13). Same read-only question to each helper, with
  explicit rules: analyze yourself, never use Cline (it is the system under test), no MCP or other
  agents, no writes. All three answered correctly with exact lines (`withProviderOverride`
  settings.ts:353, 30_000 ms at :359; `maxAttempts` 2 at runner.ts:558) and reported no delegation.
  - Codex (`codex_ask`, read-only sandbox, gpt-6.1-sol/medium): OK. Note: its config also exposes
    xai, agent-intern and claude-code MCP servers, so every prompt must forbid delegation.
  - AGY (`antigravity_ask`, gemini-3.8-flash-high): OK. Gemini quota 100%; its Claude/GPT quota is 0%.
  - OpenCode (`analyze_code`, glm-5.3-flash-free): OK in 22 s; 11 of 12 free models probed OK.
  - No helper has the Cline MCP configured. agent-intern bridge v0.26.0 (v0.36.0 available).

- 2026-11-09 — Plan created. No code changed yet. Cline settings were restored after the
  experiments (`lastUsedProvider = cline`, `cline` model left at the original saved value).
