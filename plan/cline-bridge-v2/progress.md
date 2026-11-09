# Cline Bridge v2 — Progress

Plan: [plan.md](plan.md). Decisions: [decisions.md](decisions.md).
Status values: `todo`, `in progress`, `done`, `blocked`, `skipped`.

| Step | Title | Status | Date | Notes |
|---|---|---|---|---|
| 0.1 | Clean baseline on a work branch | todo | | Uncommitted: ping.ts, status.ts, index.ts, runner.ts, tests |
| 0.2 | Record current test result | todo | | |
| 1.1 | Short lock at start/end with active-run counter | todo | | |
| 1.2 | Crash-safe journal and stale counter recovery | todo | | |
| 1.3 | Tests: overlapping runs, restore after last run | todo | | |
| 1.R | Verify: code review | todo | | |
| 1.L | Verify: live check against Cline | todo | | |
| 2.1 | provider + model required in all tools | todo | | |
| 2.2 | Missing-model error lists free models | todo | | Depends on 3 |
| 2.3 | Tests for mandatory model | todo | | |
| 2.R | Verify: code review | todo | | |
| 2.L | Verify: live check against Cline | todo | | |
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
