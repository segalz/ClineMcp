# ClineMcp Linux port — baseline (S0.4)

Commit `d2c4f86` (branch `linux-support`), 2026-11-24.

## Linux VM (supervisor)

`bash scripts/linux-check.sh` (whole suite), Node v22.23.5, Linux x86_64:
`tests 587 · pass 533 · fail 6 · cancelled 11 · skipped 37` (exit 1, ~87 s).

| # | File | Test | First error line | Class |
|---|------|------|------------------|-------|
| 1 | `src/test/guard-runner.test.ts` | runner: repeated edit failures trip loop guard, kill process once, attach report, no retry | `killTree called exactly once` (expected 1, actual 2) | (a) — POSIX sends SIGTERM then SIGKILL after the grace period by design (`runner.ts` ~1262-1266); "exactly once" is the Windows taskkill behaviour |
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

Summary: class (a) 8 (#1-3, #7-10), class (b) 3 (#4 G3, #5 G1, #6 new), class (c) 0.

## CI (GitHub Actions)

**No CI run exists.** `.github/workflows/linux-port.yml` is still not on `linux-support`: the supervisor's GitHub token also lacks the `workflow` scope (scopes: `repo, gist, read:org, delete_repo`), so it cannot push workflow files.

- CI ubuntu-24.04 / ubuntu-24.04-arm / windows-latest: not run.
- **GATE (CI `windows-latest` green): NOT EVALUATED → open.** Stage 0 stops here until the workflow is pushed and its first run is read.
