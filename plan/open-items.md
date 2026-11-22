# Open items: MCP optimization wrap-up

Recorded 2026-11-14. None is urgent. We close them one step at a time, only when the owner chooses
to, or not at all.

| # | Item | Where | Effort | Needs owner? | Status |
|---|---|---|---|---|---|
| 1 | Re-measure Cloudflare models; then have AGY's Claude review the results and failures | It was still rate-limited about a day later. Its ~10k neurons/day free tier covers only ~15-20 OpenCode requests. Owner decision 2026-11-15: exclude it from routing (`mcp-model-picker` bd02308), like Groq. | — | — | closed |
| 2 | Picker tie-break by speed: equal-skill OpenCode units are ordered without regard to latency, so the slowest (`muse-glimmer`, ~120 s) won | `mcp-model-picker` `picker.py`: on an exact score tie, the faster measured median of the last 20 successful runs wins (no rounding, so other backends keep their order) | small | No | done (2026-11-15) |
| 3 | Flaky test: `test/codeindex.test.js` "remaining attempt time bounds the adapter..." fails with `EBUSY` on Windows temp-folder cleanup. It also fails without the recent changes. | `openCodeHelperMcp` 5df617f: cleanup retries EBUSY (`fs.rm` maxRetries); 8/8 clean runs | small | No | done |
| 4 | Back up `codeindex` to a private GitHub repository | https://github.com/segalz/codeindex (private; default branch `stage13-feasibility`, `main` holds only the skeleton) | small | Approved 2026-11-14 | done |
| 5 | Upgrade agent-intern 0.36.0 → 0.37.1 | Done as 0.38.0. It runs from the local fork `C:\Develop\agent-intern`, so `uvx` was the wrong path; upstream was merged into the fork instead (1888 tests pass, pushed). Gains `effort` on `codex_ask`/`codex_continue`; CLAUDE.md now passes `pick`'s effort. | — | — | done (2026-11-16) |
| 8 | Cline as a writer. On 2026-11-14 it failed 3 of 3 edit tasks (token budget twice, time limit once), while the bridge itself worked: the guards stopped each run and restored cleanly. Two parts: (a) find why it stalls on large files: its read tool drops the middle of long files (`[truncated N chars]`), and the model then loops re-reading them (`map.ts`, `core.js`); (b) measure Cline models with the same seed tasks as OpenCode, so `pick` compares them on data instead of priors. | `ClineMcp` 9951f88; `mcp-model-picker` adeb03e (`--backend cline`) | medium | No | done (2026-11-15) |

### Item 8 results (2026-11-15)

- **Cause, from the failed trace:**
  - 6 of 28 steps used cmd/Unix syntax (`&&`, `cd /D`, `head`) in Windows PowerShell 5.1, so Cline never saw the test output;
  - the edit prompt also told Cline to run verification itself.
- **Fix:** the environment line now names PowerShell 5.1 and its rules, and the edit prompt says the bridge runs the check.
- **Seed with the same tasks as OpenCode, after the fix:**

  | Cline model | Localization | Edits |
  |---|---|---|
  | `cline-free/nemotron-3.5-super-vl` | 6/6 | 2/2 (22 s) |
  | `cline-free/solar-mini4` | 6/6 | 2/2 |
  | `nvidia/nemotron-3.5-lightning-free` | 5/6 | 2/2 |
  | `poolside/laguna-s-2.1-free` | "model not supported" | — |
  | `reflection/beam-free` | "Insufficient balance": not actually free | — |

- **`pick`:** the Cline fallback now has skill 0.80 from history (was 0.72 prior); OpenCode/Nvidia stays first at 0.86.
- **Not yet shown:** the small seed tasks do not prove the fix on medium, multi-file tasks in large files, where the original failures happened. Watch the next real Cline edit.
| 9 | Stage 14 (gated): large-file Cline edits. First measure 6 medium edit runs on large files; stop if at least 5 pass. Only if the measurement shows it: (a) rule 4 uses the code map's line spans; (b) the guard stops repeated identical reads. Reviewed by Fable from `plan/agent-ecosystem-recommendations.md` (most of it rejected). | `plan/cline-bridge-v2/stage14-plan.md` | small (measure first) | No | done (2026-11-22, F8): 5 of 6 passed, no unranged or repeated reads; 14.1/14.2 not needed (`stage14-results.md`) |
| 7 | To discuss (owner, 2026-11-14), not to build yet: a token dashboard as dry JSON data only (no UI): usage and remaining quota per provider and model. Then use that data in model selection, so `pick` makes smart quota-aware choices. | model-picker `e158796` (merged 2026-11-16): exact reset locks parsed from provider messages, pool- and model-scoped health, next-best fallback, and paid-window pacing. Planned by AGY (Gemini 4 Argon), rewritten by Codex and then Fable, implemented by AGY and reviewed by Codex. | — | — | done |
| 6 | Optional, later: one generic direct OpenAI-compatible MCP server (Nvidia, Cloudflare, Groq) for text-only tasks, which makes Groq usable and saves Cloudflare quota. Only if many small text-only tasks appear. | Not needed (owner, 2026-11-15). FreeLLMAPI is already an OpenCode provider (`freellmapi/*`) and aggregates many free providers behind one API, so text-only tasks go through `analyze_code` with a `freellmapi` model. OpenCode's ~18k-token overhead costs nothing there. | — | — | closed |
| 10 | Accepted limits from the fix plan (S18-S20 re-audits), recorded 2026-11-21 (after-bridges D2). Redaction misses rare secret forms: an unterminated quote, a YAML block scalar, escaped JSON. On Windows without a Job Object, the hub kill rests on the process table. A flat `tool_call` event is not counted toward `maxToolCalls`. Snapshot placeholders over 64 MiB compare by size only. There is an S11 elevated-holder lock edge and the S12 six-hour settings cutoff. A drive-relative `C:npm` can resolve to an existing alternate npm in Cline. | `plan/fix-plan-2026-11-18.md` S18-S20 records | — | No | accepted (2026-11-22, F11): known limits, recorded; no change planned |
| 11 | Accepted limits from the budget-following waits, recorded 2026-11-21. A clean check whose pipes closed while a Job Object was active skips the process-table scan, so a child that escaped the job before assignment is not scanned. A hub stop accepts a drained job when the process list cannot be read. Cancelling an edit can take up to `RESTORE_BUDGET_MS` (90 s) while the restore runs. After an unknown Codex id, `log_run` may start `codex login status` once. Two processes writing `agy-discovery.json` race, and the last one wins. | `plan/after-bridges-2026-11-21.md` Progress | — | No | accepted (2026-11-22, F11): known limits, recorded; no change planned |
| 12 | Machine-wide queue for heavy bridge runs, and a "busy" status that `pick` reads (owner's question 2026-11-21, layers 1 and 3). Build it only if real use shows bridges failing under concurrent load after the budget-following waits. | after-bridges plan, Progress | medium | Yes | done (2026-11-22, F10): merged in all three repos (`plan/f10-heavy-queue.md`); live check after restart |
| 13 | agent-intern 0.38 → 0.40: merge upstream into the local fork on a branch, run its suite, restart. The fastmcp-3.4 requirement is unverified. | `C:\Develop\agent-intern` | small | Yes | done (2026-11-22, F6): fork `main` 0.40.0; loads on the next restart |
| 15 | Retired Nvidia models (2026-11-22). Six `nvidia/*` models answer "Gone" (HTTP 410) or "Not Found": `deepseek-ai/deepseek-v4.1-flash`, `google/diffusiongemma-26b-a4b-it`, `meta/llama-3.2-11b-vision-instruct`, `meta/llama-3.2-90b-vision-instruct`, `openai/gpt-oss-20b`, `nvidia/nemotron-voicechat`. The public catalog (models.dev) still lists them, so the OpenCode helper keeps offering them. They get no cooldown, and the probe error is a cut log line instead of "removed by the provider". Fix: a 24 h model lock on Gone/Not Found, plus a clean message. | `openCodeHelperMcp` limit classification and probe error text | small | No | open: fix only if wasted attempts show up in real work |
| 16 | `pick` does not see the OpenCode helper's live locks (2026-11-22). The helper locked `freellmapi/gpt-oss-120b` for about 3 h (rate limit), yet `pick(needs_write)` still ranked it first as "available". The call fails in seconds and the fallback (Nvidia laguna) runs. Fix: `pick` reads the helper's live limit state, as it reads the heavy-run state. | model-picker `probes.py` / `picker.py`; helper limit state | small-medium | No | open: fix if failed first picks become frequent |
| 17 | Nvidia depends on one tool (2026-11-22). Today only OpenCode carries Nvidia in `pick`. OpenCode can drop Nvidia while Nvidia itself works: an OpenCode crash, a catalog failure (seen 2026-11-22), a catalog price change (Nvidia counts as free only by cost 0), or a misclassified quota lock. Cline already reaches Nvidia with the owner's key (live ping passed). | model-picker `feat/cline-nvidia-backup` | medium | Yes | light version built (2026-11-22): model-picker `feat/cline-nvidia-backup` cea2095, written by Codex and reviewed by Claude; full suite 3821 passed; a live edit through Cline with `provider=nvidia` passed. A `cline-nvidia` unit is offered only when OpenCode cannot offer the same Nvidia model. Merged to model-picker `main` (cea2095, owner OK); loads on the next restart. The full version (one limit state shared across tools, provider first) is not planned. |
| 18 | Nvidia as free by provider, not by price. The helper counts `nvidia/*` free only because the catalog shows cost 0. If the catalog starts showing a price, every Nvidia model drops out. Adding `nvidia` to the free providers (`OPENCODE_HELPER_FREE_PROVIDERS` and `free_providers` in `backends.toml`) removes that risk. | helper env, model-picker `config/backends.toml` | small | Yes (owner confirms Nvidia is free for this account) | open |
| 14 | Directories created by Codex's Windows sandbox in `mcp-model-picker` (`.pytest-tmp-*`, `Users…model-picker-probes-*`, `Develop…tmpp4-head-*`) belong to another user and cannot be deleted without admin rights. The owner runs `takeown` and then deletes them. | `mcp-model-picker` root | small | Yes | done (2026-11-22, F1): owner removed the folders; patterns in `.gitignore` |

## Context

- What was done is in `plan/cline-bridge-v2/stage13-results.md`, in `mcp-model-picker/plan/free-model-discovery/plan.md`, and in the git history of the four repositories.
- Codex was synced on 2026-11-14:
  - `~/.codex/AGENTS.md` and `config.toml`;
  - backups `*.bak-sync-2026-11-14`.
