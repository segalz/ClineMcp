# Open items: MCP optimization wrap-up

Recorded 2026-11-14. None is urgent. We close them one step at a time, only when the owner chooses
to, or not at all.

| # | Item | Where | Effort | Needs owner? | Status |
|---|---|---|---|---|---|
| 1 | Re-measure Cloudflare models once their free daily quota is back; then have AGY's Claude review the results and failures | `mcp-model-picker`: `scripts/seed_opencode_models.py --providers cloudflare-workers-ai` | ~30 min run, no Claude tokens | Yes: on request only, never scheduled | open |
| 2 | Picker tie-break by speed: equal-skill OpenCode units are ordered without regard to latency, so the slowest (`muse-glimmer`, ~120 s) won | `mcp-model-picker` `picker.py` (tie-break), seed `avg_seconds` in the snapshot | small | No | open |
| 3 | Flaky test: `test/codeindex.test.js` "remaining attempt time bounds the adapter..." fails with `EBUSY` on Windows temp-folder cleanup. It also fails without the recent changes. | `openCodeHelperMcp` 5df617f: cleanup retries EBUSY (`fs.rm` maxRetries); 8/8 clean runs | small | No | done |
| 4 | Back up `codeindex` to a private GitHub repository | https://github.com/segalz/codeindex (private; default branch `stage13-feasibility`, `main` holds only the skeleton) | small | Approved 2026-11-14 | done |
| 5 | Upgrade agent-intern 0.36.0 → 0.37.1 | owner's terminal: `uvx agent-intern@latest` | one command | Yes: the owner runs it | open |
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
| 7 | To discuss (owner, 2026-11-14), not to build yet: a token dashboard as dry JSON data only (no UI): usage and remaining quota per provider and model. Then use that data in model selection, so `pick` makes smart quota-aware choices. | model-picker (ledger, `backend_status`, `pick`) | to be discussed | Yes: discussion first | to discuss |
| 6 | Optional, later: one generic direct OpenAI-compatible MCP server (Nvidia, Cloudflare, Groq) for text-only tasks, which makes Groq usable and saves Cloudflare quota. Only if many small text-only tasks appear. | new | medium | Yes: decision | parked |

## Context

- What was done is in `plan/cline-bridge-v2/stage13-results.md`, in `mcp-model-picker/plan/free-model-discovery/plan.md`, and in the git history of the four repositories.
- Codex was synced on 2026-11-14:
  - `~/.codex/AGENTS.md` and `config.toml`;
  - backups `*.bak-sync-2026-11-14`.
