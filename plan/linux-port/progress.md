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
| S1.3 | SUP | low | done | — | 1 | y | — | — | 10 | `9e65540`, applied exactly. VM: check 9/9 + 30/30 loop green. CI 45503968481: windows 593/0 fail; ubuntu + arm 552 pass / 2 fail (Gate 6, snapshot symlink) only |
| S2.1 | TEST | low | done | — | — | — | — | — | 2 | `8d28953`; RED as expected (tsc TS2554: resolveClineEntry takes 0-1 args) |
| S2.2 | CODE | med | done | Cline / cline-free/nemotron-3.5-super-vl | 1 | y | none | 0 | 4 | `52abbf9`. Diff: runner.ts only (import, ResolveEntryOptions, function), per spec. Linux check 78/78. Full VM suite 551 pass / 2 fail (G1 settings test now green). CI 45496762631: windows 593/0 fail; ubuntu+arm only Gate 6 + snapshot symlink. Review note: the old doc comment now sits above the interface (cosmetic) |
| S2.3 | TEST | med | done | — | — | — | — | — | 2 | `bda9c55`; RED for the right reason on Linux (spawned `cline`, expected node execPath) |
| S2.4 | CODE | low | done | OpenCode / nvidia/nvidia/nemotron-3.5-super-vl-120b-a12b | 2 | y | none | 1 | 3 | 1st try: yes; attempt-1 revert = false negative (flake). Attempt 1 `5c6ff86` reverted `af2ff67` for a guard-runner ENOTEMPTY flake (also seen without S2.4); attempt 2 `6ae87d2` = identical diff. Linux check 62/62; VM 552 pass / 2 fail (Gate 6, snapshot symlink). CI 45501791658 windows 593/0 fail. Claude review: matches plan |
| S3.1 | TEST | low | done | — | — | — | planner error | — | 5 | First try blocked by a PLANNER error (plan text had `\0123` = octal escape, TS1487), not an executor failure; Claude fixed plan.md `eb932e0`. Re-applied from the plan text: `2930f51`; RED as expected (TS2305: no exported formatCommandLine/parseProcStatusUid). Local branch `local/s3.1-as-written` deleted, never pushed |
| S3.2 | CODE | low | done | Cline / cline-free/nemotron-3.5-super-vl | 1 | y | none | 0 | 3 | `ae849f8`: two helpers appended, per spec. Linux check 2/2 |
| S3.3 | TEST | med | done | — | — | — | — | — | 2 | `96e29ea`; RED as expected (TS2554: expected 0-2 arguments, got 3) |
| S3.4 | CODE | med | done | OpenCode / nvidia/nvidia/nemotron-3.5-super-vl-120b-a12b | 2 | n | none | 0 | 10 | Attempt 1 rejected in review, not committed: re-indented the Windows close handler, and the timeout/abort did not really win the race. Attempt 2 `bbfd42e` per spec (real Promise race, Windows lines untouched). Linux check 7 pass / 0 fail / 1 skip (class (a)); real /proc test passes. CI 45557834790: windows 598/0 fail; ubuntu + arm 558 pass / 2 fail = the known Gate 6 (Stage 4) + snapshot link (Stage 7) only |
| S4.1 | TEST | low | done | — | — | — | — | — | 4 | `d5ba0e6`: new linux-hubstop.test.ts + the 3 one-line test edits, per plan. RED exactly the 5 expected (new test, 3 edited, plan-s20 Gate 6) |
| S4.2 | CODE | low | done | Cline / cline-free/nemotron-3.5-super-vl | 1 | y | none | 0 | 2 | `b03311f`: one line (runner.ts ~777, plan said ~749). Linux check 49 pass / 0 fail / 1 skip. CI 45559270437: ubuntu+arm only the known snapshot item (Stage 7); windows failed only on flaky F2 (2nd sighting, green on all later runs) |
| S5.1 | TEST | low | done | — | — | — | — | — | 2 | `a7f2c8d` (new plan text, 2 tests); RED as expected (mytool test only; npm/npx test passes today, as the plan says) |
| S5.2 | CODE | low | done | OpenCode / nvidia/nvidia/nemotron-3.5-super-vl-120b-a12b | 1 | y | none | 0 | 1 | `ef7c846`: exactly the 7 inserted lines (with the npm/npx exception). Linux check 7 pass / 0 fail / 1 skip. CI 45559484857: windows green; arm also hit `plan-s3-confirmed-kill.test.js:127` "S3: a timed-out run ... confirms the tree is dead" (timing, not on the list); rule 7 rerun → it passed (only the known Stage 7 item left). Proposed F3, see baseline.md |
| S6.1 | TEST | low | done | — | — | — | — | — | 2 | `79fa872`: rules.test.ts linux/darwin strings per plan, Windows assertion kept. RED as expected |
| S6.2 | CODE | low | done | Cline / cline-free/nemotron-3.5-super-vl | 1 | y | none | 0 | 11 | `f7f5a01`: one line, per spec. Linux check 3/3. CI 45560871194: windows green; ubuntu+arm only the known Stage 7 snapshot item |
| S7.x | TEST/CODE | — | done | — | — | — | — | — | — | baseline class (b): #4 → Stage 4, #5 → Stage 2, #6 (snapshot check-ignore beyond a symlink, G8) → S7.1-S7.4 below. Not process killing/timing → no Claude escalation |
| S7.1 | TEST | low | done | — | — | — | — | — | 5 | `e132161` (supervisor-written): new linux-snapshot-ignore.test.ts for helper `pathsNotBeyondLinks`. RED (TS2305) |
| S7.2 | CODE | low | done | OpenCode / nvidia/nvidia/nemotron-3.5-super-vl-120b-a12b | 1 | y | none | 0 | 10 | `8511618`: helper appended at the end of snapshot.ts. (The supervisor session was interrupted mid-run; the one OpenCode run finished on its own and its result was checked.) Linux check: new test green. CI 45562830684: windows green; ubuntu+arm only the baseline #6 test (fixed by S7.4) |
| S7.3 | TEST | low | done | — | — | — | — | — | 0 | the existing baseline #6 test `snapshot.test.ts` "restore reports integrity/link/ignored failures..." is the red test (Git check-ignore failed.) |
| S7.4 | CODE | low | done | Cline / cline-free/nemotron-3.5-super-vl | 1 | y | none | 0 | 6 | `7111cb5`: restoreSnapshot passes only pathsNotBeyondLinks(...) to check-ignore. Linux check 9 pass / 0 fail. VM full suite x2: 605 tests, 566 pass, 0 fail, 39 skip. CI 45563718403: ALL GREEN (windows 600/0 fail; ubuntu + arm 566/0 fail) |
| S8.1 | SUP | med | pending | — | — | — | — | — | — | full green x2 + CI |
| S8.2 | SUP | low | pending | — | — | — | — | — | — | self-review → Claude |
| S9.1 | SUP | high | pending | — | — | — | — | — | — | linux-smoke.mjs |
| S9.2 | SUP | high | pending | — | — | — | — | — | — | smoke green x2 |
| S10 | OWNER | med | pending | — | — | — | — | — | — | real arm64 server smoke |
| S11 | OWNER | — | pending | — | — | — | — | — | — | merge decision |

## Experiment summary (fill at the end)
- CODE steps: 9 (S2.2 Cline, S2.4 OpenCode, S3.2 Cline, S3.4 OpenCode, S4.2 Cline, S5.2 OpenCode, S6.2 Cline, S7.2 OpenCode, S7.4 Cline) · alone 1st try: 8 (all but S3.4) · alone within 3: 9 · after supervisor rewrite: 0 · needed Claude: 0
- Planner errors (not executor failures): S3.1/S3.3 octal escape in the plan text (fixed by Claude `eb932e0`); S1.2 test expectations (Claude).
- Failure patterns: S3.4 attempt 1 (OpenCode) re-indented Windows code and built a timeout that did not really win the race; fixed on attempt 2 with that feedback. CI flakes: F1 (fixed by S1.3), F2 (2 sightings), proposed F3 (1 sighting).

## Open items (supervisor)
- 2026-11-25: flaky after-hook in `src/test/guard-runner.test.ts` (~line 18, `rm` of the temp root): `ENOTEMPTY … traces-7/<id>-run-2` while a trace writer is still writing. Seen in CI on ubuntu, arm and windows, with and without S2.4; locally ~1/40 runs. Resolved by S1.3 (Claude).
- 2026-11-25: windows-latest flake once: `S12: a restore whose rename is refused while a reader holds providers.json open is retried` (run 45501587786, reverted state) and again in run 45559270437. Watch it (F2).
