# Stage 14 plan: large-file edits (measure first, then at most two small changes)

Written 2026-11-16 after reviewing `plan/agent-ecosystem-recommendations.md` against the code.
Status: proposal. Nothing is implemented.

## Why this stage is small

The recommendations document surveys 20 agent frameworks and proposes four phases. Checked
against the code and history, most of it is already done or has no evidence behind it:

| Recommendation | Verdict | Reason |
|---|---|---|
| Exact `start-end` symbol spans in the map | Already done | codeindex prints `kind name file:start-end \| signature` (`codeindex/src/map.ts`), and `CODEINDEX_CLI` is the configured default (D-35). Only the regex fallback prints start lines. |
| `imported-by` / caller edges | Already done | The codeindex map prints `called by:` and `calls:` for anchored symbols. |
| Git co-change edges | Rejected | Stage 13 found the bottleneck was file ranking, fixed in ranking v2. No measured miss is explained by a missing co-change edge. |
| Cross-run memory (Mem0 style) | Rejected | The one repeated mistake on record (PowerShell 5.1 syntax) was fixed for every run by one static line in `src/rules.ts` (9951f88). Memory would spend 600-800 prompt characters per run, can inject stale facts, and has no failure case to justify it. The calling agent already carries project memory. |
| Read-only MCP servers for Cline | Rejected | No task needs them, and they add writes to Cline's settings, which is an open risk in `decisions.md`. |
| Lifecycle checkpoints | Rejected | `src/trace.ts` already records every run as NDJSON; item 8 was diagnosed from it. |
| Typed output contracts with a repair turn | Rejected | Callers ask for a Markdown shape and rule 6 enforces it. No parsing failure is recorded. |
| Full agent frameworks | Rejected | The document itself rejects them. |

What is left is the one open question in `plan/open-items.md` item 8: medium, multi-file edits
in large files are unproven after 9951f88, and Cline's `read_files` drops the middle of a long
file. The document's only useful pointer there is "tell Cline to read the map's spans". Two
facts from the code make that worth testing:

- Rule 4 in `src/rules.ts` says "ranges ... each at least 200 lines" and never mentions the
  spans the map now provides. Cline's `read_files` accepts `start_line` / `end_line`.
- `src/guard.ts` counts only failed calls. A successful read repeated forever is stopped only by
  the budget (`maxInputTokens` default 1,500,000; `maxToolCalls` default 150).

## Steps

Each step is one change with its own check. Steps 14.1 and 14.2 run only if 14.0 shows the
problem they address.

### 14.0 Measure (no code change)

- **What:** three medium edit tasks, each touching 2-3 files with at least one file over 800
  lines, each with a `verify` command that fails before and passes on a reference solution.
  Reuse the two tasks that failed on 2026-11-14 (`map.ts` in codeindex, `core.js` in
  openCodeHelperMcp) and add one in this repository (`src/runner.ts` or `src/clistate.ts`).
  Run each through `apply_cline_edits` on a work branch with
  `cline-free/nemotron-3.5-super-vl` and `cline-free/solar-mini4`, `maxFixRuns` 2: 6 runs.
- **Record** in `plan/cline-bridge-v2/stage14-results.md`, per run: passed, time, input tokens,
  fix runs, guard verdict, `codeMapSource`, and from the trace: the number of `read_files` calls
  on files over 600 lines without a range, and the largest number of identical read calls.
- **Check:** the results table exists with 6 rows and each task's reference solution passes its
  `verify`.
- **Gate:** if at least 5 of 6 pass and no run shows 3 or more identical reads, stop. Close
  item 8 as proven and skip 14.1 and 14.2.
- **Benefit:** replaces "unproven" with a number. Cost: about 6 runs of roughly 100-300 k free
  tokens each.

### 14.1 Rule 4 uses the map's spans (only if 14.0 shows unranged reads of long files)

- **Files:** `src/rules.ts` (rule 4 text only), `src/test/rules.test.ts` (the exact-text test).
- **Change:** replace "read only the ranges you need, each at least 200 lines" with wording that
  says: for a file over about 600 lines, read the `start-end` spans the Code map gives for the
  symbols you need, widened to at least 200 lines, all in one call; without a map span, search
  first and then read a range. Keep "never page in small slices" and "never re-read"; the first
  rule text made Cline page in small slices (Stage 10.1).
- **Check:** `npm test`, then rerun the 14.0 runs that failed or read whole long files, 2 runs
  per task.
- **Keep it only if** the pass count does not drop and average input tokens on those tasks fall
  by at least 15%. Otherwise revert the text.
- **Expected benefit:** fewer truncated reads on long files. Target: 15-30% fewer input tokens on
  large-file tasks and at least one more passing run out of 6.

### 14.2 Guard stops a repeated-read loop (only if 14.0 shows 3 or more identical reads in a run)

- **Files:** `src/guard.ts` (success branch of `content_end`), `src/test/guard.test.ts`. No new
  option: reuse `maxRepeatedFailures` and `window`.
- **Change:** record the signature (tool plus `hashInput` of the input) of each successful
  read-only call. When the same signature succeeds `maxRepeatedFailures + 1` times inside the
  window, trip `loop_detected` with the action "repeated identical reads". A successful write to
  a path clears the counts for that path, so reading a file again after editing it is allowed.
- **Check:** new unit tests: 4 identical reads trip; 3 do not; read, edit, read, edit, read on
  one file does not trip; different ranges of one file do not trip. `npm test` passes.
- **Expected benefit:** success rate is unchanged. A looping run stops after 4 reads instead of
  at the budget. Measure the saving on the 14.0 traces as tokens spent after the fourth identical
  read; the upper bound per failed run is the 1.5 M token budget.

### 14.R Review and close

- A second model reviews the diff of 14.1 and 14.2. Update `progress.md`, `decisions.md` (one
  entry: what was kept and the measured numbers) and item 8 in `plan/open-items.md`.

## Not planned

- End lines in the regex fallback map (`buildRegexCodeMap`): it helps only when `codeMapSource`
  is `regex`. Reconsider if 14.0 or real traces show regex-sourced maps on large-file tasks.
- Everything marked rejected in the table above.
