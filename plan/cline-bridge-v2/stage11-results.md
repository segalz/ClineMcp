# Stage 11 — Live results (2026-11-12)

Cline CLI 3.0.74, free model `cline-free/nemotron-3.5-super-vl`, thinking low, async edits tasks through the
bridge's `TaskManager` (built `dist/`), throwaway Git repo per run. Objective: extend a small Python module with a
dataclass, a loader, two functions and a unittest file (4 independent final checks).

| Run | Kind | Time | Input tokens | Final checks | Notes |
|---|---|---|---|---|---|
| O1 | single run | 161 s | 110k | 4/4 | — |
| O2 | single run | 225 s | 130k | 4/4 | — |
| S1 | micro-steps (4) | 372 s | 211k | 4/4 | every step verified on attempt 1 |
| S2 | micro-steps (4) | 394 s | 287k | 4/4 | Cline asked a question in step 1; answered via `cline_send`, step verified |

## Reading
- Both succeed on a small task. Micro-steps cost about twice the time and tokens: each step is a fresh run that
  repays the system prompt, rules and code map.
- What micro-steps add is control, not speed: each step is checked by a command the bridge runs, a failed step is
  restored from its snapshot, and the caller decides retry / skip / stop. The question path works live.
- Use micro-steps for broad or risky changes, where a single run tends to wander or fail (Stage 10's hard task);
  keep single runs for small ones.

## Experiment 2 — a harder 7-step, 6-file change (2026-11-12/13)

Objective: move a small shop library from float prices to an exact `Money` type, then add discounts, coupons, tax
and tests (6 files). Seven independent check scripts, validated first: a reference solution passes 7/7, the
starting code 0/7. Three pairs, each pair run in parallel on separate throwaway repos.

| Run | Kind | Time | Input tokens | Checks passed |
|---|---|---|---|---|
| O1 | single run | 76 s | 173k | 7/7 |
| O2 | single run | 111 s | 142k | 7/7 |
| O3 | single run | 122 s | 428k | **6/7** (missed the mixed-currency rule; reported done anyway) |
| S1 | micro-steps (7) | 471 s | 1,419k | 7/7 |
| S2 | micro-steps (7) | 455 s | 931k | 7/7 |
| S3 | micro-steps (7) | 347 s | 810k | 7/7 |

- Single run: 20/21 checks, about 100 s and 250k tokens on average, but one run silently missed a requirement.
- Micro-steps: 21/21 checks, every step verified on attempt 1, but about 4x the time and 4x the tokens.
- The free model handled even this 6-file change in one run. Micro-steps did not rescue a failing run; their
  value is that every requirement is checked, which a single run with a final check gets more cheaply.

## Conclusion (D-33)
- Default: one run, then the bridge runs all the checks: that is `steps` with a single step whose `verify` runs
  the whole check suite. On a failure the same retry / skip / stop applies. No new code needed.
- Full micro-steps: only for changes too big for one context, or after a single run has failed twice.
- Not ported to OpenCode for now; revisit if evidence shows single runs failing on real work.

## Incident during the first attempt of experiment 2
Stopping a monitor left the first driver running, so two drivers raced on the same repos. A repo script then ran
`git commit` in the ClineMcp checkout (local only, never pushed); it was removed with `git reset --hard` to the
previous commit. The checkout lock correctly refused a second writer on the same repo. The experiment script now
refuses any path outside its folder, and the data from that attempt was discarded and rerun.
