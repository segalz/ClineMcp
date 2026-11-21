# After the bridges fix: what is left so the bridges get used more and better

Written 2026-11-21, after `plan/fix-plan-2026-11-18.md` (S1-S20, Gates 1-6, final Codex check) was merged to `main`
in ClineMcp (cbc29ca) and openCodeHelperMcp (aeeb4e4). The point of that work was to make the two free bridges
reliable enough to carry most analysis and checked edits. This plan lists what still stands between "the bridges
work" and "the bridges are used, routed and measured correctly". First draft by Claude; reviewed the same day by
Gemini 4 Neon xhigh (read-only, 65 files: rules, memory, both bridges, model-picker code and data, agent-intern);
Claude checked its key claims in the code before folding them in. The work is split up only after this.

Parts of the system and how they connect:
- **Cline bridge** (`C:\Develop\ClineMcp`, MCP `cline-local`): reads committed HEAD in a disposable worktree
  (`ask_cline_workspace`), checked edits in the checkout (`apply_cline_edits`, async `cline_start`).
- **OpenCode bridge** (`C:\Develop\openCodeHelperMcp`, MCP `opencodeHelper`): reads the live folder, uncommitted
  work included (`analyze_code`), checked edits (`apply_opencode_edits`); warm `opencode serve` for repeated reads.
- **model-picker** (`C:\Develop\mcp-model-picker`, MCP `model-picker`): `pick` chooses backend/model/effort,
  `log_run` records outcomes, `backend_status` reports health and quota; discovery is dynamic; free OpenCode models
  are trusted for writes only with a fresh seed measurement (`write_ok`, `SEED_FRESHNESS` = 7 days).
- **agent-intern** (`C:\Develop\agent-intern`, local fork of upstream): Codex, AGY (Gemini), Grok.
- **Rules**: global `C:\Users\segal\.claude\CLAUDE.md`, `mcp-model-picker/docs/SUPERVISOR.md`, and the auto-memory
  in `C:\Users\segal\.claude\projects\C--Develop-ClineMcp\memory\`.

**The loop that should work:** Claude asks `pick` → free bridge for analysis and S/M edits → outcome and tokens to
`log_run` → `pick` learns → better routing. The review found it broken at several points (P below); fixing those
comes first, or every later measurement and rule change is wasted.

## P. Break points in the pick → bridge → log_run loop (first; model-picker code, small fixes, tests first)

| # | Break | Evidence (checked by Claude where marked ✓) | Effect today |
|---|---|---|---|
| P1 | Seed freshness expires | ✓ `registry.py:329` `SEED_FRESHNESS = 7 days`; ✓ all 6 `write_ok` OpenCode models were stamped 2026-11-13/14 (`~/.model-picker/opencode-catalog.json`); 2 already expired, 4 expire 2026-11-21 15:52 UTC. `opencode_measured()` ignores `log_run` history. | After that time no free OpenCode model counts as write-measured: `pick` stops preferring the bridge for writes (about -0.42 score). Decide: re-seed (B1), let recent successful `log_run`s refresh freshness, or both. |
| P2 | Cold-start discovery gap | `probes.py:1742-1755` (`_agy_for_pick` empty before `backend_status`); `picker.py:946`, `registry.py:934-943` (`log_run` validates without syncing discovered models). | After a restart, until `backend_status` runs, `pick` hides `gemini-4-*` and `log_run` still says "unknown model" for new ids. |
| P3 | Cline rate-limit ladder not read by the picker | ClineMcp `status.ts:227-252, 315-335` write `expires_at`/`strikes`; picker `probes.py:1452-1495, 1570-1578` ignores `expires_at`; `dashboard.py:627` shows expired limits. | A rate-limited Cline model shows as `down` instead of "limited until"; stale limits on the dashboard. |
| P4 | OpenCode limit patterns not shared with the picker | openCodeHelperMcp `core.js:322-336, 720-727` (503, overloaded, insufficient_quota, "All models exhausted", HTTP-date Retry-After, per-model 429); picker `probes.py:914-986`, `limits.py:10-18` lock all `nvidia/*` on one model's 429; `learning.py:14, 149` count `rate_limit`/`request_too_large` as skill failures. | One model's 429 locks the whole provider; rate limits lower a model's skill instead of pausing it. |
| P5 | Bridge tokens never reach `log_run` | CLAUDE.md and `SUPERVISOR.md` say "AGY/Cline → omit" tokens, OpenCode not mentioned, although both bridges return `usage`; `estimate.py:40-43` drops zero-token runs; `seed_opencode_models.py:200-207` drops cache/reasoning tokens. | Token estimates for the free bridges stay on priors. |
| P6 | Seeding revokes `write_ok` on infrastructure errors | `seed_opencode_models.py:424-425` sets `write_ok=False` on any failure (429, timeout, quota); `learning.py:61-68` keeps pre-fix seed failures (2026-11-13/14) forever at full weight. | A re-seed on a busy day can strip good models; old failures from the broken bridges keep dragging scores. Fix before B1. |
| P7 | Retired model still hard-coded | ✓ openCodeHelperMcp `core.js:54` `PREFERRED_MODELS` includes `opencode/glm-5.3-flash-free`; also `ANALYZE_DESCRIPTION` (core.js:1049), O README:80, picker `backends.toml:202-207` and README. | Auto-order and docs point at a model that is no longer free. |
| P8 | External-score matching bugs | `external_scores.py:240-246` strips both `nvidia` from `nvidia/nvidia/*`; `backends.toml:256-259` lacks the `cline-free` prefix and vendor aliases (`deepseek-ai`, `minimaxai`, `stepfun-ai`); paid and `:free` twins collide as "ambiguous" (`external_scores.py:280, 510-515`). | Most free models get no external score; skill comes only from seeds and history. Fix only if external benchmarks should count for free models; otherwise document it as intended. |

## A. Rules, docs and memory (text; the owner approves CLAUDE.md edits)

| # | Item | Detail |
|---|---|---|
| A1 | Lift the fix-plan-only "no free writers" rule | Memory `bridges-fix-roles.md`: "Don't route these stages to `apply_opencode_edits` or `apply_cline_edits`, even when `pick` says to." Mark the fix plan closed. |
| A2 | "TEMPORARY: Codex is off" | CLAUDE.md "Delegation routing". Codex was used all through the fix plan with the owner's OK. Owner decides (its weekly quota is at 4%). |
| A3 | Stale model names | CLAUDE.md example `opencode/glm-5.3-flash-free`; CLAUDE.md lines ~116-121 and ~281-291 name `gemini-3.8-flash`, Argon and `grok-4.6` as defaults; `stage14-plan.md:44` uses the retired `cline-free/solar-mini4`. |
| A4 | Stale `verify` rule | CLAUDE.md: "npm/npx work. On OpenCode, other .cmd/.bat commands are refused". Both bridges now resolve pnpm/yarn/npx and `node_modules/.bin` tools (bare or explicit path), refuse a missing command before any model use, and run the check in the requested folder. |
| A5 | New behaviours callers must know (CLAUDE.md and `SUPERVISOR.md`) | Commit point (passing check plus identity re-read; a cancel before it restores); after an unconfirmed kill `retry` is refused (restore/keep), snapshot kept; first run reserves the check's time (verify timeout + 10 s); async edits return `gitDiff`/`status`/`headAfter` (may be absent); `createdFiles` warnings; clean tracked symlinks/submodules allowed; `analyze_code` moves to the next model on a loop trip; warm OpenCode server for repeated reads; progress heartbeat every 15 s. Also `antigravity_ask(plan=True)` for read-only AGY. |
| A6 | Contradictions in rules and memory | `bridge-failures-are-bugs.md` ("stop and diagnose before fallback") vs CLAUDE.md's fallback route; `free-bridges-limits.md` (`keepOnFailure=true`, glm as the reliable writer) vs CLAUDE.md (default false); `project-next-steps.md` "Codex writes, AGY reviews"; `free-model-providers.md` cites closed open item 6; CLAUDE.md says `claude-self` cannot be probed (it is probed now, `probes.py:1830-1844`) and says to use the old `fallback` after a quota failure (conflicts with `server.py:126`); `SUPERVISOR.md:53` says `codex_ask` has no `effort`. Resolve each. |
| A7 | Memory index | `project-next-steps.md` and `MEMORY.md` point to this plan. |
| A8 | Finish the documentation branches, then merge, rebuild, restart | Before merging: ClineMcp `168beed` misses `cline_start`; openCodeHelperMcp `9856907` keeps the retired GLM in `ANALYZE_DESCRIPTION`; model-picker `68c411a` put `analyze_code` guidance into `write_note`, which `pick` shows only for writes (move it); say "commit point = passing check plus identity re-read". Then merge to `main` in all three repos, switch back to `main`, `npm run build` (ClineMcp runs `dist/`), restart. |

## B. Measurement and learning (after P)

| # | Item | Detail |
|---|---|---|
| B1 | Re-seed the free models on the fixed bridges | `seed_opencode_models.py --providers nvidia,freellmapi,opencode` and `--backend cline`, after P6. The last seed was 2026-11-13/14 on the old bridges. On demand only, never scheduled. |
| B2 | `log_run` after every delegated call, with tokens | After P2 and P5; test on a cold server (no prior `backend_status`). Back-fill of the fix plan's runs: dropped (Codex/AGY/Claude skill comes from external scores, and undated failures could trip `recent_health`). |
| B3 | Static model lists in `backends.toml` | `cline`/`cline-task` list the retired `solar-mini4`; `opencode-free` lists the retired GLM, and static `deepseek`/`mimo` entries bypass `write_ok` (`registry.py:690-696`). `Backend.models` needs at least one entry and uses `configured[0]` as a template (`registry.py:251, 309`): keep one live model per backend or change the schema. |
| B4 | Quota-aware routing check | On a cold server: S/M coding/debugging/testing writes should go to the free bridges. Note the write bonus applies only to those three categories (`picker.py:853`), and a full AGY window gets no hold-back, so `ui`/`general` writes still go to AGY. Decide whether that is wanted. Quota on 2026-11-21: Codex 4% weekly (to 2026-11-25), Claude-self 3% (to 2026-11-23), AGY Claude/GPT 0% (to 2026-11-25), Gemini and Argon 100%. |
| B5 | (dropped) warm-server latency in `pick` | The speed tie-break only breaks exact ties, and edit calls get a per-call server; only repeated reads are faster. |
| B6 | External scores for free models | See P8: fix the matching, or record that seeds and history are the intended source. |

## C. Real-size validation (after P, A8, B1)

| # | Item | Detail |
|---|---|---|
| C1 | One real medium task end to end on each bridge | `pick` → bridge → verify → review on a real multi-file task, measuring time, tokens, fix runs and quality against the 2026-11-17 numbers; then rewrite `free-bridges-limits.md`. |
| C2 | Open item 9: large-file Cline edits | Measure 6 medium edit runs on large files (update `stage14-plan.md` to live models first); build the code-map-span / repeated-read guard only if the measurement shows the need. |
| C3 | Re-check the old limits | Cline's ~6000-char `new_text` cap; Nvidia 429 under parallel load. (OpenCode and gitignored `plan/**`: verified in code: `apply_opencode_edits` denies ignored paths by design, `analyze_code` can read them; no live test needed.) |
| C4 | Is the progress heartbeat used? | Check whether Claude Code sends an MCP `progressToken`; if not, record that the heartbeat helps other clients only. (Unverified.) |

## D. Hygiene and backlog

| # | Item | Detail |
|---|---|---|
| D1 | Kept recovery snapshots accumulate | Both bridges keep the snapshot after an unconfirmed kill and never delete it; `%TEMP%\cline-mcp-snapshots` holds 8 folders from 2026-11-17..20. Add an age-based sweep (both bridges); OpenCode `snapshot.js:315` should also honour `CLINE_MCP_SNAPSHOT_DIR` like ClineMcp. |
| D2 | Recorded limits into `plan/open-items.md` | Rare secret forms (unterminated quote, YAML block, escaped JSON), hub kill on Windows without a job, flat `tool_call` not counted toward `maxToolCalls`, placeholders over 64 MiB by size, the S11 elevated-holder lock, the S12 six-hour cutoff, drive-relative `C:npm` to an existing alternate npm in Cline. |
| D3 | Remaining load-flaky tests | ClineMcp: S3b unit "a failed build can be retried once after cooldown", verify "timeout and abort", the S15 code-map regression test. |
| D4 | agent-intern 0.38 → 0.40 (optional) | Merge upstream into the local fork on a branch, run its suite, then restart. `plan=True` already exists in 0.38; the fastmcp-3.4 requirement is unverified (the local `pyproject.toml` allows `fastmcp<5`). |
| D5 | codeindex hard-set, OpenCode half | Lost on 2026-11-13 to the free quota; re-run with the fixed bridge. |
| D6 | Repository tidiness | Stray `UserssegalAppDataLocalTempmodel-picker-probes-*` and `.pytest-tmp-*` folders in mcp-model-picker; all three repos are on `docs/*` branches until A8 is merged. |

## E. Process lessons from the fix plan

- Never write regex or backslash-heavy code through shell heredocs or `node -e`: it halved backslashes in a test (S19) and put a backspace control character into `runner.ts` (Gate 6). Use the Write/Edit tools; after any scripted edit, grep sources for control characters.
- Reviewer always from another family than the writer.
- Re-audits found smaller edge cases each round. Stop rule: when a round finds only rare forms, record them as limits.
- Rebuild ClineMcp `dist/` after every merge before restarting.
- `log_run` after every delegated call, with tokens (B2).

## Order

1. **P1-P7 in model-picker and the bridges** (P1 is urgent: write freshness expires today). Without them, re-seeding, rules and measurement are wasted.
2. **A8**: finish, merge, rebuild, restart, so the live tools and notes match.
3. **A1-A7**: rules and memory (owner approves CLAUDE.md), so callers route to the bridges and log tokens.
4. **B1, B2, B3, B4**: re-seed, then check on a cold server that `pick` sends S/M writes to the free bridges and `log_run` accepts every id with tokens.
5. **C1, C3, C4**: one real task per bridge; refresh `free-bridges-limits.md`.
6. **Later**: P8/B6, C2, D1-D6.

## Who fixes what (owner 2026-11-21: no free bridges and no `pick` routing for this plan yet)

The free bridges and `pick` are what this plan fixes, so they do not route or write it. As in the fix plan, Claude supervises: it writes the failing test first, reviews each diff and runs the suites. The writer and the reviewer always come from different families.

Quota on 2026-11-21:
- AGY Gemini Models: 96% weekly. Argon: 100%. AGY Claude/GPT: 0% until 2026-11-25.
- Codex: 4% weekly until 2026-11-25.
- Claude-self: reset on 2026-11-21. 1% of the weekly limit used, 8% of the 5-hour window.

So the Gemini writers have quota, Claude reviews, and Codex is kept for one last pass after 2026-11-25.

| Difficulty | Items | Writer | Reviewer |
|---|---|---|---|
| 4 | P4 (shared limit patterns, per-model lock, `AVAILABILITY_ERRORS`), C2 (large-file Cline edits) | AGY `gemini-4-argon-high`; one repo per call, tight design | Claude Opus (subagent, high) |
| 3 | P1 (write freshness), P2 (cold-start discovery), P6 (seeding vs infrastructure errors, old failures), P8 (external-score matching), D1 (snapshot sweep, both bridges), D3 (flaky tests), D4 (agent-intern upgrade) | AGY `gemini-4-neon-xhigh`, backup `gemini-4-hydrogen-xhigh` | Claude Opus (subagent, high); at the end one pass over all of P (Opus, or Codex after 2026-11-25) |
| 1-2 | P3 (read the Cline ladder), P5 (tokens into `log_run`), P7 (remove GLM), B3 (static lists), D6 (stray folders) | AGY `gemini-4-hydrogen-xhigh`, or Claude by hand when it is a few lines | Claude reads the diff (with AGY Neon when Claude wrote it) |
| 1 (text) | A1-A8 (rules, memory, docs branches) | Claude | The owner approves CLAUDE.md and the merges |
| Runs | B1, B2, B4, C1, C3, C4 (re-seed, measure, check routing) | Claude runs them | - (after P and A8; these are where the free bridges and `pick` come back) |

Order inside P: P7, P3 and P5 first (easy), then P6, P1 and P2, then P4. P1 is not urgent while `pick` does not route this work. Every step goes on a work branch per repo, never `main`, and must pass the full suite of the repo it touches.

## Open questions for the owner

1. A2: drop the "Codex off" note, or keep Codex for hard work only?
2. P1: should a recent successful real run (`log_run`) keep a model's write trust fresh, or only seed runs?
3. B4: should `ui`/`general` writes also prefer the free bridges?
4. D4: upgrade agent-intern now or leave it?
