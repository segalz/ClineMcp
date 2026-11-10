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
| 7.1 | model-picker: explicit models, `cline-task`, error_kind map | todo | | |
| 7.2 | model-picker: free list from bridge | todo | | |
| 7.3 | Update CLAUDE.md contract and README | todo | | |
| 7.R | Verify: code review | todo | | |
| 7.L | Verify: live check against Cline | todo | | |

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
