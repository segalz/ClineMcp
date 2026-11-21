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
- **F9 running.** The OpenCode half of the hard set (`runhard4.sh`, Nvidia `nemotron-3-ultra`, 2 lanes) started about 00:45.
- **F3 decided (owner, 2026-11-22):** `ui` and `general` writes stay with AGY. The free bonus stays on coding, debugging and testing. No code change; the decision is written into CLAUDE.md wording (F2).

## Order

1. F1, F2, F3 together: they need the owner. Claude prepares F2 and asks F3 now.
2. F4, then F5 (quota permitting), then F9.
3. F7 (Neon, then Codex).
4. F6 (Codex, then Opus); the owner restarts afterwards.
5. F8: measure; build only if needed (Codex, then Opus).
6. F10 (Codex xhigh, then Opus): the largest item, done last so it builds on everything else.
7. F11, merge (owner), one restart, a final live check.
