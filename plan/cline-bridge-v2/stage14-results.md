# Stage 14.0 results: Cline medium edits on large files (2026-11-22, finish-all F8)

Measured on the fixed bridges (ClineMcp `main` 5ad37ee), with codeindex as the code map. Each task ran through `apply_cline_edits` with `maxFixRuns` 2, `timeoutSeconds` 300 and `thinking` high. Runs were made in throwaway worktrees on a `stage14-measure` branch. Every task's test fails before the edit and passes on a reference solution written by Claude.

## Tasks

| Task | Repo, file (lines) | Change | Check |
|---|---|---|---|
| T1 | ClineMcp `src/runner.ts` (1801) | `validateInputLimits`: refuse NUL in prompt/systemPrompt, a new `MAX_PROMPT_LINES` limit | `stage14-t1.test.ts` (3 tests) |
| T2 | openCodeHelperMcp `src/core.js` (1211) | `parseRetryAfterMs`: read "retry in" and "reset(s) in" | `stage14-t2.test.js` + `core.test.js` (25 tests) |
| T3 | ClineMcp `src/clistate.ts` (1412) | `CliReplyStatus.failed_count`, new `summarizeFailedVersions` | `stage14-t3.test.ts` + `clistate.test.ts` (23 tests) |

## Runs

| # | Task | Model | Passed | Time | Input tokens | Fix runs | Guard | Map | Unranged reads of files over 600 lines | Most identical reads |
|---|---|---|---|---|---|---|---|---|---|---|
| 1 | T1 | `cline-free/nemotron-3.5-super-vl` | yes | 14 s | 69k | 0 | ok | codeindex | 0 | 1 |
| 2 | T1 | `nvidia/nemotron-3.5-lightning-free` | yes | 30 s | 215k | 0 | ok | codeindex | 0 | 1 |
| 3 | T3 | super-vl | yes | 18 s | 48k | 0 | ok | codeindex | 0 | 1 |
| 4 | T3 | lightning | yes | 24 s | 116k | 0 | ok | codeindex | 0 | 1 |
| 5 | T2 | super-vl | yes | 43 s | 123k | 0 | ok | codeindex | 0 | 1 |
| 6 | T2 | lightning | **no** | ~60 s | 391k | 0 | `loop_detected` (3 failed edits) | codeindex | 0 | 1 |

**5 of 6 passed.** No run read a long file without a range, and no run repeated an identical read.

## Run 6: why it failed

It was not a large-file problem. The target line is a regex literal full of backslashes. Lightning doubled every backslash in the editor's `old_text`, so all 3 edits missed with "text not found", and the guard stopped the run after the third miss. The guard worked as designed, and the checkout was restored clean. Lightning also ran 18 read-only shell commands (`grep`, `Get-Content`) although the prompt said not to run commands; super-vl followed the instruction in all three of its runs.

## Fault found and fixed along the way

Run 6's error result reported `durationMs: 0`. Cause: in `src/finalcheck.ts`, a failed run (guard stop, timeout) adds the error's `durationMs`, which a `ClineRunError` does not have. Fix: count the run's wall time when the result carries none. New test in `src/test/finalcheck.test.ts`: "a run stopped by the guard still reports its measured duration". Branch `fix/failed-run-duration`.

## Gate

The plan's gate is: at least 5 of 6 pass, and no run with 3 or more identical reads. **Met**: 5 of 6, with at most 1 identical read. Item 8 is proven for medium edits; steps 14.1 (map spans in rule 4) and 14.2 (repeated-read guard) are not needed and are skipped.

Model note for `pick`: on these tasks super-vl was 3 of 3 with about half of lightning's tokens. All six runs are logged in model-picker with `write=true`.
