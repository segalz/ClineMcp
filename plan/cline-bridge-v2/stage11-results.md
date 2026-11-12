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
