# Stage 12 — Live results (2026-11-13)

Same 7-check task as stage11-results.md experiment 2 (6 files; checks validated: reference 7/7, start 0/7).
Async edits tasks through the bridge's `TaskManager`, Cline CLI 3.0.74, free model, thinking low. The final check is
one script running all 7 checks; `maxFixRuns` default 2.

| Run | Instructions | Time | Input tokens | First check | Fix runs | Final |
|---|---|---|---|---|---|---|
| F1 | full | 105 s | 110k | 7/7 | 0 | 7/7 |
| F2 | full | 96 s | 125k | 7/7 | 0 | 7/7 |
| F3 | full | 92 s | 100k | 7/7 | 0 | 7/7 |
| G1 | one requirement left out (the HALF coupon) | 165 s | 330k | 6/7 (`FAIL check 5: coupons.py`) | 1 | 7/7 |
| G2 | same | 111 s | 304k | 6/7 (same) | 1 | 7/7 |

## Reading
- With full instructions the cost equals a single run (~100 s, ~110k tokens): the check adds seconds.
- A missed requirement is caught by the check and fixed automatically from its output in one fix run.
- Compared with micro-steps (experiment 2: ~425 s, ~1.05M tokens), the final check reaches the same 7/7 at about a
  quarter of the time and a tenth of the tokens.
