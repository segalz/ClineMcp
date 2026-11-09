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
| 2.2 | Missing-model error lists free models | in progress | 2026-11-09 | Plain message now; the live free-model list is added in Stage 3 |
| 2.3 | Tests for mandatory model | done | 2026-11-09 | 111 tests, 110 pass, 1 skipped |
| 2.R | Verify: code review | done | 2026-11-09 | Codex round 1 FAIL (helper accepted one field) → fixed; round 2 PASS |
| 2.L | Verify: live check against Cline | done | 2026-11-09 | Via MCP: `{}`, provider-only, model-only and ping without selection refused (-32602) in ≤4 ms, settings untouched; explicit `cline-free/nemotron-3.5-super-vl` → PONG, settings restored |
| 3.1 | Load catalog from installed @cline/llms | todo | | |
| 3.2 | `catalog_unavailable` on load failure | todo | | |
| 3.3 | Tool `cline_list_models` | todo | | |
| 3.4 | Tests for discovery | todo | | |
| 3.R | Verify: code review | todo | | |
| 3.L | Verify: live check against Cline | todo | | |
| 4.1 | Write events.ndjson live | todo | | |
| 4.2 | Redaction and size cap | todo | | |
| 4.3 | Status reducer → status.json | todo | | |
| 4.4 | Cleanup (TTL, orphans) | todo | | |
| 4.R | Verify: code review | todo | | |
| 4.L | Verify: live check against Cline | todo | | |
| 5.1 | `cline_start` | todo | | |
| 5.2 | `cline_status` long-poll | todo | | |
| 5.3 | `cline_cancel`, `cline_result`, log_run_hint | todo | | |
| 5.4 | Guards: no retry, max 2, wall cap, orphans | todo | | |
| 5.R | Verify: code review | todo | | |
| 5.L | Verify: live check against Cline | todo | | |
| 6.1 | `QUESTION:` protocol in system prompt | todo | | |
| 6.2 | Detect input_required / auto_answered | todo | | |
| 6.3 | `cline_send` → fresh run with context | todo | | |
| 6.R | Verify: code review | todo | | |
| 6.L | Verify: live check against Cline | todo | | |
| 7.1 | model-picker: explicit models, `cline-task`, error_kind map | todo | | |
| 7.2 | model-picker: free list from bridge | todo | | |
| 7.3 | Update CLAUDE.md contract and README | todo | | |
| 7.R | Verify: code review | todo | | |
| 7.L | Verify: live check against Cline | todo | | |

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
