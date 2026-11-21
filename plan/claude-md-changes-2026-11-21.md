# Proposed CLAUDE.md changes (after-bridges A2-A5), waiting for the owner's approval

Target: `C:\Users\segal\.claude\CLAUDE.md`. Back it up first (`CLAUDE.md.bak-2026-11-21`). Each item replaces one existing line or adds one; nothing else changes.

1. **Retired example id** (Invocation contract, OpenCode analysis example): `opencode/glm-5.3-flash-free` → `opencode/deepseek-v4.1-flash-free`. That model is no longer free.
2. **verify** (bullet "npm/npx work. On OpenCode, other .cmd/.bat commands are refused."), replaced by:
   "npm, npx, pnpm, yarn and `node_modules/.bin` tools resolve without a shell; other `.cmd`/`.bat` files are refused. A missing command is refused before any model use. The check runs in the requested folder (a monorepo package), not the repository root."
3. **New bullet under "After every edit call"**:
   "A passing check is final. If a stopped process may still be running, nothing is restored automatically, retry is refused (restore or keep), and the recovery snapshot is kept. Internal waits follow the call's budget, so a busy machine slows a call instead of failing it."
4. **log_run tokens**. Replace "Tokens: Codex → `codex_session="latest"`; Grok (`raw_output=true`) → pass its `usage` numbers; AGY/Cline → omit." with:
   "Tokens: Codex → `codex_session="latest"`; OpenCode/Cline → pass the bridge's `usage` (`cline_result`'s `log_run_hint` already carries them); AGY → omit. Pass `write=true` for a checked edit; a passing one keeps a free model's write trust fresh. For a bridge limit pass `error_kind` = the bridge's `limitKind` (`quota`, `rate_limit`, `request_too_large`) and `error_text` = its message verbatim. A rate limit locks only that model; a quota locks the provider."
5. **claude-self**. Replace "`claude-self` cannot be probed." with:
   "`claude-self` is probed from `claude -p /usage`; when that read fails and you know your own remaining quota, pass it on any `log_run`."
6. **After a quota failure**. Add to "On failure, log it, then use `fallback`.":
   "After a quota or rate-limit failure call `pick` again instead of trusting the old fallback."
7. **Read picks**. Add after "Call the returned `primary.mcp_tool`…": "Follow `call_note` on reads too; it carries the read tool's usage."
8. **AGY read-only**. In "AGY fallback branch: `antigravity_ask` …" add "pass `plan=true` for analysis (agent-enforced read-only)".
9. **"TEMPORARY: Codex is off"**. The owner lifted it for the after-bridges plan and said to use Codex fully (stop and report when its quota runs out). Proposal: delete the TEMPORARY block and add to "Delegation routing": "Use Codex fully; when its quota runs out, stop and tell the owner, who resets it."

Not changed without a separate decision: the default AGY models named in CLAUDE.md (`gemini-3.8-flash-high`, `gemini-4-argon-high`). Neon xhigh (AA 61) proved the strongest AGY writer on 2026-11-21; whether it becomes the default is the owner's call.
