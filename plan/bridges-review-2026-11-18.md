# Bridges review — 2026-11-18

Reviewer: AGY gemini-4-argon-high (read-only, one run per repo). Every item marked **verified** was checked by Claude against the code. The other items are the reviewer's claims, not yet checked.

Branches holding tonight's fixes (pushed, not merged): `fix/remaining-edge-cases` in both repos.

## A. Loses work or gives a wrong result

| # | Bridge | Problem | Trigger → outcome | Status |
|---|---|---|---|---|
| A1 | Cline | The Cline CLI auto-update starts in the background on a tool call | An update is available → the update takes the settings lock and stops the hub for minutes while the call is preparing → the call fails `settings_lock_timeout` or its hub dies (`clistate.ts` `onToolCall` / `executeSafeUpdate`) | verified |
| A2 | Both | On a timeout, the process is not confirmed dead before restore or cleanup | Cline: `clampGrace` → 0 ms at the deadline (`runner.ts:978`). OpenCode: `stop()` resolves after a 1 s grace while `taskkill` still runs (`core.js` `runBoundedProcess`) → restore races a live writer; the last answer can be lost | verified |
| A3 | Both | Verify shims (`pnpm`, `yarn`, `vitest`, `tsc`, `node_modules/.bin`) are refused | Only `.exe`, `.com` and npm/npx resolve, and the check runs only after the whole edit run → the run is wasted and the edits are restored (`verify.ts`, `verify.js`) | verified |
| A4 | OpenCode | A line starting `Question:` in the model's summary | The summary is treated as `input_required` → edits restored without running verify (`edits.js:129`) | verified |
| A5 | OpenCode | A new message ID clears the collected answer text | The last step starts a new message without text → "no valid analysis" / edits lost (`events.js:28`) | verified in code, not reproduced live |
| A6 | OpenCode (Cline too?) | `directory` is a monorepo subfolder | The agent and verify run at the repo root → wrong cwd, verify fails → restore (`edits.js` `runEdits`) | reviewer claim |

## B. Wastes time or quota

| # | Bridge | Problem | Status |
|---|---|---|---|
| B1 | Cline | Sync `ask_cline` / `ask_cline_workspace` split the time 60/40 into two attempts (attempt 1 dies at 60%), and retry even after tools already ran (`canRetry` is never passed) | verified |
| B2 | Cline | A bare `429` anywhere in the output marks the model rate-limited for 180 s; `launch_failed` / `cline_updating` mark the model unreachable (`status.ts`) | verified |
| B3 | OpenCode | Runtime quota failures are not remembered for the next call; the auto order can come back empty when the preferred models are missing (`core.js` `buildAutoOrder`) | verified (empty fallback) |
| B4 | OpenCode | A guard trip (loop) on model 1 stops every fallback model (`core.js` `runAnalysis`); cached tokens count toward `maxInputTokens` | verified (fallback stop) |
| B5 | OpenCode | Reasoning variant forced to `low` on every model that has variants (`PREFERRED_VARIANT`) — lower quality for heavy coding | verified |
| B6 | Cline | New tonight: a PowerShell process scan (~1 s) after every run, and a hub is started even when the call is refused by a quota lock (`runner.ts` `dedicatedHub`) | verified |
| B7 | OpenCode | One tracked file deleted in the working tree → the whole regex code map is dropped (`codemap.js`) | verified |
| B8 | Cline | The codeindex map is checked against the JSON envelope length → near-budget maps are thrown away (`codemap.ts:242`) | verified |
| B9 | Cline | Async edits (`cline_start` mode edits) return no `gitDiff` / `status` | verified |
| B10 | Both | The first edit run does not reserve verify time when the budget is small (OpenCode `run === 0`); Cline maps a timeout to `cline_error` instead of `budget` | reviewer claim |
| B11 | Cline | Cache reads count toward `maxInputTokens` (`guard.ts` takes `usage.inputTokens`, which includes the cached part for at least the free Cline provider): long cached prompts trip the budget early. Parity with O, fixed there in S7 | verified 2026-11-19 (live trace) |

## C. Lower priority

- C1 (Both, new tonight): the PID-reuse check gets "access denied" on a system process, so the lock stays busy. It also runs PowerShell synchronously and blocks the server for about 1 s on contention. Fix: treat access denied as "not ours"; make it async.
- C2 (Cline): `providers.json` is shared by concurrent runs; a parse failure during a concurrent write fails the run (`settings.ts`). Reviewer claim.
- C3 (OpenCode): an ignored path containing `[id]` or `{slug}` throws before the launch (Next.js / SvelteKit folders). Verified.
- C4 (Both): snapshot refuses any repository that contains a submodule or a tracked symlink, even an untouched one.
- C5 (Both): redaction hides identifiers (`key: string`, long SHAs) in verify output sent to the fix prompt.
- C6 (OpenCode): shutdown does not stop running `analyze_code` children; `GIT_OPTIONAL_LOCKS=0` is missing for analysis; verify output over 1 MiB kills a passing check.
- C7 (Cline): guard / parser details (last-text capture, `finishReason: error` after `done`), the code-map room in fix prompts, and resume budgets.
- C8 (Both): timing tests that are flaky under full-suite load (`codemap.test`, `fixes-2026-11-17` deadline test).

## D. Ideas from external projects (web research, 2026-11-18)

1. **OpenCode as one long-lived server**: `opencode serve` plus `run --attach` or the session HTTP API (prompt / interrupt / wait, one SSE event stream), instead of a cold process per call. Seen in Dheerax/opencode_mcp; documented by OpenCode ("avoid MCP server cold boot times on every run"). Watchdog: restart when a prompt yields zero tokens after N s.
2. **Windows Job Object (KILL_ON_JOB_CLOSE, no breakaway)** for every spawned CLI, so a killed run cannot leave orphans; `taskkill /T /F` stays as the fallback. Directly addresses A2.
3. **429 classification with per-provider cooldown ladders** (quota exhausted vs rate limited vs capacity; Retry-After; collapse 429s within 2 s). Addresses B2/B3.
4. **Cline structured signals**: `run_result.finishReason`, stderr `{"type":"error"}`, `--timeout`, `--retries`, `--id` resume, `cline hub ensure/status`; `@cline/sdk` in-process is a later experiment.
5. **Ergonomics**: progress heartbeat about every 15 s on long sync calls; prompt through stdin (no command-line limit, fixes the OpenCode repair-prompt overflow); a quality-gate verdict on every async result; conflict warning when parallel jobs touch the same files.

Sources: PAL MCP (BeehiveInnovations/pal-mcp-server), steipete/claude-code-mcp, grahama1970/claude-code-mcp-enhanced, Dheerax/opencode_mcp, mryesiller/opencode-delegate-mcp, triumsebas/unlimited-mcp, opencode.ai docs (cli, server, sdk), docs.cline.bot (cli-reference, sdk).

## Proposed order

1. Batch A (A1–A6): stop losing work. Each fix gets a failing test first, then a live run.
2. Batch B (B1–B10): stop wasting quota and time; this is what makes free use "smooth".
3. Batch C.
After each batch: full test suites in both repos, a live read and edit on each bridge, then merge with the owner's OK.
