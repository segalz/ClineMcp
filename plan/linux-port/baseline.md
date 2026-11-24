# ClineMcp Linux port — baseline (S0.4)

Commit `d2c4f86` (branch `linux-support`), 2026-11-24.

## Linux VM (supervisor)

`bash scripts/linux-check.sh` (whole suite), Node v22.23.5, Linux x86_64:
`tests 587 · pass 533 · fail 6 · cancelled 11 · skipped 37` (exit 1, ~87 s).

| # | File | Test | First error line | Class |
|---|------|------|------------------|-------|
| 1 | `src/test/guard-runner.test.ts` | runner: repeated edit failures trip loop guard, kill process once, attach report, no retry | `killTree called exactly once` (expected 1, actual 2) | unclear (was (a); see "Reclassification during S1.1") — POSIX sends SIGTERM then SIGKILL after the grace period by design (`runner.ts` ~1262-1266); "exactly once" is the Windows taskkill behaviour |
| 2 | `src/test/guard-runner.test.ts` | runner: budget_exceeded trips when maxToolCalls exceeded | `Expected values to be strictly equal` (expected 1, actual 2) | (a) — same SIGTERM→SIGKILL escalation |
| 3 | `src/test/plan-s18.test.ts` | S18 review: a job that closes when the check exits does not trigger a needless tree check | `Expected values to be strictly equal` (expected 0, actual 1) | (a) — Windows Job Object semantics; with no Job Object on POSIX the tree check is the only confirmation |
| 4 | `src/test/plan-s20.test.ts` | Gate 6: a failed hub stop with an unreadable process list is not confirmed | `Expected values to be strictly equal` (+ undefined, - false) | (b) — known, G3, fixed by Stage 4. Do not skip. |
| 5 | `src/test/settings.test.ts` | built stdio bridge startup restores a temporary journal and logs failed recovery | stderr `Failed to write catalog snapshot on startup: … the Cline CLI install was not found` (expected `''`) | (b) — G1 (`resolveClineEntry` Windows-only); expected to turn green after Stage 2 |
| 6 | `src/test/snapshot.test.ts` | restore reports integrity/link/ignored failures without following links or touching ignored files | `Git check-ignore failed.` | (b) — new (G8). On Linux, `git check-ignore -z --stdin` exits 128 with `fatal: pathspec 'dir/file' is beyond a symbolic link` when a manifest path sits under a symlinked dir (reproduced by hand). `snapshot.ts` ~511 treats that as a hard failure. → Stage 7 pair |
| 7 | `src/test/wait-budgets.test.ts` | Windows Job Object still runs process-table confirmation and confirms an unreadable table when no pipes are held open | cancelled: `Promise resolution is still pending but the event loop has already resolved` (hangs) | (a) — mocks `createWindowsJob` for `runVerification`; POSIX never uses the job, so the test waits forever |
| 8 | `src/test/wait-budgets.test.ts` | verify exitGrace gets its full 500 ms inside the settle margin when the check exits at its deadline | hangs (same message) once #7 is skipped | (a), provisional — Windows-job mock with fake timers; re-check in S1.1 |
| 9 | `src/test/wait-budgets.test.ts` | a child alive outside a drained Job Object is NOT confirmed in verify or runner, and triggers no auto-restore | hangs (same message) once #7-8 are skipped | (a) — drained Job Object scenario |
| 10 | `src/test/wait-budgets.test.ts` | drained Job Object + unreadable process table: confirmed without pipesHeldOpen, unconfirmed with pipesHeldOpen | hangs (same message) once #7-9 are skipped | (a) — Job Object scenario |

The other 7 "cancelled" tests in `wait-budgets.test.ts` (lines ~466, 535, 652, 712, 760, 1199, 1321) are collateral: they were cancelled because #7 hung the file. With #7-#10 excluded (`--test-skip-pattern`, investigation only, nothing edited) the rest of that file passes: `pass 21 · fail 0 · cancelled 0 · skipped 2` (the two existing Windows-only skips).

Summary (initial): class (a) 8 (#1-3, #7-10); after S1.1 re-check: (a) 6, unclear 2 (#1-2), class (b) 3 (#4 G3, #5 G1, #6 new), class (c) 0.

## CI (GitHub Actions) — first run

Workflow added by Claude in `69a9262` (matches plan S0.2 byte for byte). Run: https://github.com/segalz/ClineMcp/actions/runs/45483808438 (Node 22, `npm ci`, `npm test`).

| Job | Result | tests / pass / fail / cancelled / skipped |
|-----|--------|--------------------------------------------|
| ubuntu-24.04 | failure | 587 / 533 / 6 / 11 / 37 |
| ubuntu-24.04-arm | failure | 587 / 533 / 6 / 11 / 37 |
| windows-latest | **failure** | 587 / 576 / 9 / 0 / 2 |

Both Linux jobs fail on exactly the same tests as the VM (#1-#10 above, plus the same 7 collateral cancellations). arm64 adds nothing new.

### windows-latest failures (first error line, suspected class)

Two causes seen on the hosted runner. Neither comes from `linux-support`, which has no source change yet:
- **E1, no Cline CLI on the runner:** `the Cline CLI entry C:\Users\runneradmin\AppData\Roaming\npm\node_modules\cline\bin\cline is not readable (ENOENT)` / `Cline CLI is missing or being updated`.
- **E2, 8.3 short TEMP path:** the runner's `%TEMP%` is `C:\Users\RUNNER~1\...`, while the code resolves the long name `C:\Users\runneradmin\...`, so path-equality checks differ.

| # | File | Test | First error line | Suspected cause / class |
|---|------|------|------------------|--------------------------|
| W1 | `checkoutlock.test.ts` | sync edits refuses a held checkout before launching Cline | `"busy" validation ... Received false ... ClineRunError: Cline CLI is missing or being updated` | E1 → (c) |
| W2 | `checkoutlock.test.ts` | async edits retains its lock across waiting and resume, blocks sync/async writers, and releases on completion | `assert.ok(ownsCheckoutLock(lease, root))` falsy | E2 → (c)? (lock identity under short vs long path) |
| W3 | `codemap.test.ts` | edits integration reads the current checkout | env line has `...\runneradmin\...`, expected `...\RUNNER~1\...` | E2 → (c) |
| W4 | `codemap.test.ts` | structural provenance and exact roots reach sync and async workspace/edits, including resumes | `includes("structural root=<smallRepo>")` falsy | E2 → (c) |
| W5 | `finalcheck.test.ts` | async exhausted verification waits with retained edits; restore, keep and one manual repair | `Missing expected rejection.` | E1/E2, unconfirmed |
| W6 | `finalcheck.test.ts` | async input_required releases only the slot; retry queues, and cancellation cleans up both queued and running edits | `Missing expected rejection.` | E1/E2, unconfirmed |
| W7 | `finalcheck.test.ts` | survivor timer frees only the slot while async task waits in input_required; checkout lock stays held until keep/restore | `Missing expected rejection (CheckoutBusyError).` | E2 (lock identity), unconfirmed |
| W8 | `plan-s15.test.ts` | S15 Gate 2: CLINE_MCP_SNAPSHOT_DIR sets the default snapshot base | `C:\Users\runneradmin\...\snapshots\<id>` `true !== false` | E2 → (c)? |
| W9 | `settings.test.ts` | built stdio bridge startup restores a temporary journal and logs failed recovery | stderr `... Cline CLI entry ... not readable (ENOENT)` | E1 → (c) |

**First-run GATE: failed (superseded by CI revision 2 below).** W1, W3 and W9 are clearly environment. W2 and W4-W8 point at 8.3 short-path aliasing, which may also be a latent Windows bug in lock/path identity (it would be on `main` too). Stage 0 stops here and the owner decides (see progress.md).

## CI revision 2 (S0.2, Claude) — gate re-check

Workflow `c79ba86` (runner fixes: Cline CLI 3.0.75 installed on the runner; Windows tests run with `TEMP`/`TMP` = the long runner temp folder). Run: https://github.com/segalz/ClineMcp/actions/runs/45488824177

| Job | Result | tests / pass / fail / cancelled / skipped |
|-----|--------|--------------------------------------------|
| windows-latest | **success** | 587 / 586 / 0 / 0 / 1 |
| ubuntu-24.04 | failure | 587 / 533 / 6 / 11 / 37 (the same as the VM baseline) |
| ubuntu-24.04-arm | failure | 587 / 533 / 6 / 11 / 37 (the same as the VM baseline) |

All W1-W9 above were runner environment (class (c)), fixed by CI revision 2. **GATE (windows-latest green): PASS.** Stage 0 closed 2026-11-24.

## Reclassification during S1.1 (supervisor re-check)

- #8 (`verify exitGrace …`): **confirmed (a).** A diagnostic copy in `dist/` (deleted afterwards, nothing tracked changed) shows that on POSIX no Job Object is created, so `runVerification` runs the real `confirmTreeDead` on the test's fake pid 12345 under mocked timers and never settles. With an injected tree check the same scenario passes (`passed: true`, `timedOut: false`). The test models the Windows job path.
- #1 and #2 (`guard-runner.test.ts`): **moved from (a) to "unclear", not skipped.** The test is platform-aware: its `mockKillTree` expects `SIGTERM` on POSIX. On Linux the runner calls it twice, `SIGTERM` and then the `SIGKILL` escalation 500 ms later, because the mock child never exits. The test expects exactly one call. So this is not Windows-only behaviour. Either the test expectation or the escalation-while-guard-tripped behaviour is wrong. Escalated to the owner/Claude (rule: never skip a non-(a) test).

## After S1.1 (`eabf7ca`)

- VM `bash scripts/linux-check.sh`: 587 / 540 pass / 5 fail / 0 cancelled / 42 skipped.
- CI run https://github.com/segalz/ClineMcp/actions/runs/45492036371: windows-latest **success** (586 pass, 0 fail, unchanged); ubuntu-24.04 and ubuntu-24.04-arm 540 pass / 5 fail / 0 cancelled.
- The remaining Linux failures: #4 (b, G3 → Stage 4), #5 (b, G1 → Stage 2), #6 (b, check-ignore beyond symlink → Stage 7), #1-#2 (guard-runner, unclear, waiting for the owner).

## Known-flaky list (plan rule 7, "Flaky first")

| # | Where | Test | Signature | Status |
|---|-------|------|-----------|--------|
| F1 | any OS | `src/test/guard-runner.test.ts` file-level after-hook (~33) | `ENOTEMPTY: directory not empty, rmdir '…/traces-7/<id>-run-2'` | fixed by S1.3; keep listed until S1.3 CI is green |
| F2 | windows-latest | S12: a restore whose rename is refused while a reader holds providers.json open is retried | seen once, run 45501587786 | watch; if it fails twice more, stop and report to the owner |

