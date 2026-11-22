# Finish everything: no open item left (owner, 2026-11-22)

Every item still open after the after-bridges plan (`plan/after-bridges-2026-11-21.md`) and `plan/open-items.md`. Each item has a writer, a reviewer from another model family, a check, and a "done" definition. Claude supervises, writes failing tests first, reviews every diff and runs the full suites. Merges to `main` go through the owner.

Rule from earlier work: the reviewer is always from a different family than the writer. When Codex's quota runs out, stop and tell the owner.

## Items

| # | Item | Difficulty | Writer | Reviewer | Done when |
|---|---|---|---|---|---|
| F1 | Sandbox folders in `mcp-model-picker` (`.pytest-tmp-*`, `Users…probes-*`, `Develop…tmpp4-head-*`), owned by another Windows user | 1 | **Owner** runs the admin command once | Claude checks | The folders are gone; add them to `.gitignore` so git stops warning |
| F2 | Small CLAUDE.md/AGENTS.md text that the 2026-11-21/22 work made stale: "freellmapi: no model is write-eligible yet (2026-11-14)" (now `gpt-oss-120b` has `write_ok`); "2026-11-14: Nvidia models" (refresh the date and names) | 1 | Claude drafts | **Owner** approves | Both files match the 2026-11-22 seed |
| F3 | Owner question B4: should `ui`/`general` writes also prefer the free bridges? Today the free bonus covers only coding, debugging and testing. | 1 | **Owner** decides; Claude implements if yes (one line in `picker.py` plus a test) | Neon | Decision recorded; code and test match it |
| F4 | C4: does Claude Code send an MCP `progressToken`? Test it live with one call that logs only whether the token was present (no content), then remove the log. | 1 | Claude | none | The answer is in the plan; if "no", the tool descriptions say the heartbeat serves other clients |
| F5 | Re-seed the `opencode/*` edit track (quota ran out on 2026-11-21) and `freellmapi/*` (gateway timed out) | 1 | Claude runs `seed_opencode_models.py` once the quotas are back (checked with `list_free_models probe=true`) | none | Every free model has a fresh measurement or a recorded reason |
| F6 | agent-intern 0.38 → 0.40 (open item 13): merge upstream into the local fork `C:\Develop\agent-intern` on a branch, resolve conflicts, run its suite, check fastmcp 3.4 | 3 | Codex `gpt-6.2-astra` high (conflicts, if any) | Opus | Its suite passes; `antigravity_status` shows 0.40 after a restart; fork `main` merged and pushed |
| F7 | P8/B6: external-score matching for free models (`nvidia/nvidia/*` loses both `nvidia`, the missing `cline-free` prefix and vendor aliases `deepseek-ai`/`minimaxai`/`stepfun-ai`, paid and `:free` twins collide as "ambiguous") | 3 | AGY `gemini-4-neon-xhigh` | Codex `gpt-6.2-astra` high | Matched models get an external score in `backend_status`; the model-picker suite passes |
| F8 | C3 / Stage 14 (open item 9): measure 6 medium Cline edits on large files. If 5 or more pass, record it and close. Otherwise build: (a) code-map line spans in rule 4, (b) a guard against repeated identical reads. | 2 to measure, 4 if building | Claude measures; Codex writes (a)/(b) if needed | Opus | Measured and recorded; built and re-measured if needed |
| F9 | D5: the codeindex hard set, OpenCode half (lost on 2026-11-13 to the free quota) | 2 | Claude runs it with a seeded Nvidia model | none | Accuracy, tokens and time recorded in `plan/cline-bridge-v2/stage13-results.md` |
| F10 | Open item 12: a machine-wide queue for heavy bridge runs (Cline and OpenCode edits, seed runs) and a "busy" status that `pick` reads | 4 | Codex `gpt-6.2-astra` xhigh | Opus | Over a set number of heavy runs, a call waits in a queue with progress instead of failing. The bridge writes "busy" to its status file and `pick` routes elsewhere. Full suites pass in all three repos, plus one live check with 4 parallel edits. |
| F11 | Close the bookkeeping: `open-items.md` rows 9-14 closed with results; `after-bridges` plan marked closed; memory updated | 1 | Claude | none | No row is left open |

## Progress

- **F1 done.** The owner ran the admin command, and all 4 folders are gone. Scratch-folder patterns were added to model-picker's `.gitignore`.
- **F4 done.** The Claude Code docs say progress notifications count only as activity against the 30 min idle timeout and never extend the hard per-call timeout; `progressToken` is not documented. Our calls are capped at 10 min, so the heartbeat changes nothing for Claude Code and serves other clients. No code change.
- **F5 waiting.** At 00:44 the `opencode/*` quota was still exhausted ("Free usage limit reached", provider lock about 1 h) and FreeLLMAPI timed out. Run it again near the end.
- **F7 written, Codex re-check pending.**
  - model-picker `feat/external-score-matching` a1dce17 and 8dec743, written by Neon. Codex rejected the first version (wrong-vendor matches, merged snapshots, incomplete baseline); Neon fixed all three, and the suite passed 3793.
  - The Codex re-check was cut off by Codex's 5-hour limit (frees about 03:19). Owner rule: stop and tell the owner.
- **F9 done.** OpenCode hard set: A0 25.4/30, A1 (codeindex) 24.2/30, 59/60 runs valid, 17% fewer tokens with codeindex. Keep codeindex. Recorded in `stage13-results.md`.
- **F7 approved.** Codex's re-check (06:20) confirmed all three findings fixed and found one more: an ID with two gateways (`freellmapi/opencode/...`) stripped only the first. Claude fixed it (e1c57c4, test `test_stacked_gateways_are_all_stripped`; suite 3794 passed), and Codex approved. Branch pushed; merge waits for the owner.
- **F6 ready.** Upstream 0.40 merged into the fork on branch `update-0.40` with no conflicts. The fork has no code of its own, so it equals upstream, and the Opus review has nothing to review. The suite has 1 live failure: agy 1.5.14 lists `gemini-4-neon` and `gemini-pro-orchestrator-neon`, which upstream's docs do not name. Documented in the fork (13d073a); 2124 passed. The new read-only default is opt-in (`AGENT_INTERN_AGY_DEFAULT=plan`), so AGY write mode is unchanged. Merge plus restart wait for the owner.
- **F8 done: 5 of 6 passed, gate met.** No unranged long reads and no repeated identical reads, so 14.1 and 14.2 are skipped. The one failure was Lightning over-escaping a regex line. A bridge fault found along the way (a guard-stopped run reported `durationMs` 0) was fixed on branch `fix/failed-run-duration`. Details: `plan/cline-bridge-v2/stage14-results.md`.
- **F10 spec written:** `plan/f10-heavy-queue.md`.
- **Owner approvals (2026-11-22, 07:45):**
  - F7 was fast-forward merged to model-picker `main` (e1c57c4) and pushed.
  - The F8 fix was merged to ClineMcp `main` (50b45c2) and pushed.
  - F2 was applied to `~/.claude/CLAUDE.md` and `~/.codex/AGENTS.md`; backups are `.bak-2026-11-22`. **F2 done.**
  - F6 was approved later and fast-forward merged: fork `main` 13d073a (0.40.0), pushed. After the owner restarts, `codex_status` should show v0.40.0.
- **F10 code done; the live check waits for merge plus restart.** Codex ran out at 07:00 (resets 11:21). On the owner's suggestion, AGY `gemini-4-neon-xhigh` took over as writer, with Opus as reviewer. All branches are `feat/heavy-queue`, pushed.
  - Step A, Cline: written by Codex, then 4 Opus rounds fixed by AGY. The final round was approved; the full suite passes 581/0.
  - Step C, model-picker: started by Codex and finished by AGY. Opus approved it, and Claude fixed its two notes. 3797 passed.
  - Step B, OpenCode: written by AGY. Opus approved it, and AGY fixed its two notes. 349 passed.
  - Owner-level decisions:
    - after `killUnverified`, the checkout lock is never auto-healed (only an explicit restore/keep or a restart), but the slot is freed at once;
    - survivors-only leases heal on a 30 s re-check, and the lock is freed only after disposal.
  - Two load-flaky code-map tests were fixed in both bridges.
- **F5 ran at 08:18.** Results by provider:
  - `freellmapi/*`: all 7 models timed out on the probe. The home gateway is not answering, and `gpt-oss-120b` keeps `write_ok`, since infrastructure errors do not revoke it.
  - `opencode/*`: all 11 answered the probe. The shared free quota then ran out partway through ("Free usage limit reached"), so the edit track never ran (quota, recorded as such).
  - A seed bug found along the way: limit messages inside a Markdown analysis error were logged as `crash`. Fixed in model-picker d3c07b2 (on `feat/heavy-queue`), with a test, and the error text is now logged too.
  - Still to do: re-run `--tracks edit --providers opencode` when the quota is back, about 22 calls, which fits one quota window.
- **F10 merged (owner OK, 2026-11-22):**
  - ClineMcp and openCodeHelperMcp were fast-forwarded to `main` (8c68773, d5fea09).
  - model-picker got a merge commit d70991b with F7; it had no conflicts and its suite passed 3807.
- **F11 bookkeeping done.** `open-items.md` rows 9-14 are closed (none left open), the after-bridges plan is marked closed, and memory is updated.
- **Live check after the owner's restart (2026-11-22, 15:20): passed.**
  - `codex_status` showed agent-intern v0.40.0.
  - Four MCP calls issued in one message ran one after another, because Claude Code serializes them, so a script started four bridge processes in parallel instead (2 Cline, 2 OpenCode, 2 slots).
  - The heavy-run state reached `2 active, 1 queued`, and `pick(needs_write)` then returned Codex with the warning `bridges busy: 2 active, 1 queued`. Each waiter started when a slot freed, and all 4 edits passed their checks.
  - **Bug found and fixed along the way (openCodeHelperMcp `fix/catalog-fallback` a192912, not merged):** under load, one helper's `opencode models --verbose` failed once. The catalog then fell back silently to the name rule, which drops every `nvidia/*` model, cached that for 10 minutes, and refused a valid edit.
    - The fix retries the verbose listing once, marks a fallback list `degraded` and caches it for only 30 s, and re-lists when a required model is missing.
    - The failing tests were written first. Cline wrote the fix (Lightning ran out of budget; super-vl passed first try), and Claude reviewed it. The suite passed 352/0, and the re-run live check passed 4/4.
- **Left:**
  1. ~~One restart by the owner~~ done.
  2. A live check: 4 parallel edits across both bridges with 2 slots, plus `pick(needs_write)` showing the busy warning, plus `codex_status` v0.40.0.
  3. The F5 `opencode/*` edit track when its quota is back.
- **F3 decided (owner, 2026-11-22):** `ui` and `general` writes stay with AGY. The free bonus stays on coding, debugging and testing. No code change; the decision is written into CLAUDE.md wording (F2).

## Order

1. F1, F2, F3 together: they need the owner. Claude prepares F2 and asks F3 now.
2. F4, then F5 (quota permitting), then F9.
3. F7 (Neon, then Codex).
4. F6 (Codex, then Opus); the owner restarts afterwards.
5. F8: measure; build only if needed (Codex, then Opus).
6. F10 (Codex xhigh, then Opus): the largest item, done last so it builds on everything else.
7. F11, merge (owner), one restart, a final live check.
