# ClineMcp Linux port — progress

Status: pending / red (test committed, failing as expected) / in-progress / done / escalated / skipped (reason).
Updated by the supervisor (Grok Bot) after every step.

| Step | Type | Risk | Status | Executor / model | Attempts | 1st try | Escalation | CI reverts | Minutes | Notes |
|------|------|------|--------|------------------|----------|---------|------------|------------|---------|-------|
| S0.1 | OWNER | low | done | — | — | — | — | — | — | push approved and pushed 2026-11-24 |
| S0.2 | Claude | low | done | — | — | — | — | — | — | workflow `69a9262` + CI revision 2 `c79ba86` (Cline CLI on the runner, long TEMP on Windows). Run 45488824177: windows success |
| S0.3 | SUP | low | done | — | — | — | — | — | 25 | Node v22.23.5 (nvm), git, build-essential, cline 3.0.75, opencode-ai 1.19.6, `npm ci` OK. Cline primary `cline-free/nemotron-3.5-super-vl` (Cline account login, owner-approved), fallback `nvidia` / `nvidia/nemotron-3.5-super-vl-120b-a12b`. OpenCode primary `nvidia/nvidia/nemotron-3.5-super-vl-120b-a12b`, fallback `opencode/deepseek-v4.1-flash-free`. See discovery.md |
| S0.4 | SUP | med | done | — | — | — | — | — | 45 | VM + CI ubuntu/arm: 6 fail + 11 cancelled. First-run windows failures were runner env (c), fixed by CI rev 2. **GATE PASS** (windows 586/0 fail). See baseline.md |
| S0.5 | SUP | med | done | — | — | — | — | — | 10 | JS launcher at `<prefix>/lib/node_modules/cline/bin/cline` (spawns native `bin/.cline`); `@cline/llms` present; daemon argv has `--cline-hub-daemon --cwd --port`, own SID (setsid). Both gates PASS |
| S1.1 | SUP | low | done | — | — | — | — | — | 25 | 5 class (a) tests skipped off Windows (plan-s18 job-closes; wait-budgets ×4 Job Object), `eabf7ca`. guard-runner ×2 resolved by S1.2. Linux failures are now class (b) only |
| S1.2 | SUP | low | done | — | 1 | y | — | — | 5 | `589fe70`: guard-runner expects [SIGTERM, SIGKILL] on POSIX. VM check green (9/9). CI 45494383407: windows 586/0 fail; ubuntu + arm 542 pass / 3 fail = Gate 6 (G3), settings (G1), snapshot symlink (Stage 7) only |
| S2.1 | TEST | low | pending | — | — | — | — | — | — | linux-entry.test.ts |
| S2.2 | CODE | med | pending | | | | | | | resolveClineEntry on Linux |
| S2.3 | TEST | med | pending | — | — | — | — | — | — | linux-launch.test.ts |
| S2.4 | CODE | low | pending | | | | | | | launch node <entry> |
| S3.1 | TEST | low | pending | — | — | — | — | — | — | linux-procs-parse.test.ts |
| S3.2 | CODE | low | pending | | | | | | | formatCommandLine, parseProcStatusUid |
| S3.3 | TEST | med | pending | — | — | — | — | — | — | linux-procs.test.ts |
| S3.4 | CODE | med | pending | | | | | | | listClineProcesses Linux branch |
| S4.1 | TEST | low | pending | — | — | — | — | — | — | linux-hubstop.test.ts + 3 test edits |
| S4.2 | CODE | low | pending | | | | | | | hub-stop fallback on Linux |
| S5.1 | TEST | low | pending | — | — | — | — | — | — | linux-verify-bin.test.ts |
| S5.2 | CODE | low | pending | | | | | | | node_modules/.bin on POSIX |
| S6.1 | TEST | low | pending | — | — | — | — | — | — | rules.test.ts expectations |
| S6.2 | CODE | low | pending | | | | | | | Linux env line |
| S7.x | TEST/CODE | ? | pending | | | | | | | from baseline class (b) |
| S8.1 | SUP | med | pending | — | — | — | — | — | — | full green x2 + CI |
| S8.2 | SUP | low | pending | — | — | — | — | — | — | self-review → Claude |
| S9.1 | SUP | high | pending | — | — | — | — | — | — | linux-smoke.mjs |
| S9.2 | SUP | high | pending | — | — | — | — | — | — | smoke green x2 |
| S10 | OWNER | med | pending | — | — | — | — | — | — | real arm64 server smoke |
| S11 | OWNER | — | pending | — | — | — | — | — | — | merge decision |

## Experiment summary (fill at the end)
- CODE steps: — · alone 1st try: — · alone within 3: — · after supervisor rewrite: — · needed Claude: —
- Failure patterns:
