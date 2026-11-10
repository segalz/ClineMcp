# Stage 9.0 — Research (2026-11-10)

Source: Codex static inspection of the installed Cline CLI 3.0.74
(`%APPDATA%\npm\node_modules\cline`). No Cline run, no network.

## What Cline already has

- **Decomposition:** `spawn_agent` and `team_task` (dependencies, claiming, blocking) in
  `@cline/core`; enabled in ordinary one-shot runs, off with `--yolo`. `--plan` gives an outline only.
  No Focus Chain / `new_task` / automatic micro-step execution found.
- **Checkpoints:** Git-based, on by default; rollback, not loop prevention.
- **Loop guards:** `LoopDetectionTracker` (soft 3 / hard 5) counts **consecutive identical** calls only;
  `MistakeTracker` counts failed-tool-only iterations and resets on any success. Today's loop
  (61 failing edits with small variations, interleaved with reads) slips through both.
- **Config:** SDK keys `execution.maxConsecutiveMistakes`, `execution.loopDetection.*`, `maxIterations`
  exist, but no headless flag/env/setting exposes them. `--retries` (default 3) works with `--json`.
- **Context:** auto-compaction at ~90% of the input budget (`--compaction agentic|basic|off`).
- **Events we can use:** tool `content_start` (`toolName`, `toolCallId`, `input`) and `content_end`
  (`output`, `error`, `durationMs`), iterations, usage, compaction notices, `run_result`.

## Options

| Option | Cost | Solves |
|---|---|---|
| A. Use built-ins only | Low | Exact consecutive repeats, compaction; not today's loop; no hard budget |
| B. Bridge-side guard | Moderate | Repeated failed edits with variations, budgets (tool calls / tokens / time), stop + report |
| C. Bridge-side micro-steps | High | Focus and small contexts on broad tasks; still needs B |

Codex recommends B first; C only if B is not enough.
