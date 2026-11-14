# Open items: MCP optimization wrap-up

Recorded 2026-11-14. None is urgent. We close them one step at a time, only when the owner chooses
to, or not at all.

| # | Item | Where | Effort | Needs owner? | Status |
|---|---|---|---|---|---|
| 1 | Re-measure Cloudflare models once their free daily quota is back; then have AGY's Claude review the results and failures | `mcp-model-picker`: `scripts/seed_opencode_models.py --providers cloudflare-workers-ai` | ~30 min run, no Claude tokens | Yes: on request only, never scheduled | open |
| 2 | Picker tie-break by speed: equal-skill OpenCode units are ordered without regard to latency, so the slowest (`muse-glimmer`, ~120 s) won | `mcp-model-picker` `picker.py` (tie-break), seed `avg_seconds` in the snapshot | small | No | open |
| 3 | Flaky test: `test/codeindex.test.js` "remaining attempt time bounds the adapter..." fails with `EBUSY` on Windows temp-folder cleanup. It also fails without the recent changes. | `openCodeHelperMcp` | small | No | open |
| 4 | Back up `codeindex` to a private GitHub repository | https://github.com/segalz/codeindex (private; default branch `stage13-feasibility`, `main` holds only the skeleton) | small | Approved 2026-11-14 | done |
| 5 | Upgrade agent-intern 0.36.0 → 0.37.1 | owner's terminal: `uvx agent-intern@latest` | one command | Yes: the owner runs it | open |
| 6 | Optional, later: one generic direct OpenAI-compatible MCP server (Nvidia, Cloudflare, Groq) for text-only tasks, which makes Groq usable and saves Cloudflare quota. Only if many small text-only tasks appear. | new | medium | Yes: decision | parked |

## Context

- What was done is in `plan/cline-bridge-v2/stage13-results.md`, in `mcp-model-picker/plan/free-model-discovery/plan.md`, and in the git history of the four repositories.
- Codex was synced on 2026-11-14:
  - `~/.codex/AGENTS.md` and `config.toml`;
  - backups `*.bak-sync-2026-11-14`.
