# Stage 11.0 — Research: micro-steps (2026-11-12)

Source: Codex static inspection of Cline CLI 3.0.74 and this repository. No Cline run.

## Cline's own decomposition (`spawn_agent`, `team_task`)
- Available in the bridge's headless runs (`--auto-approve true`, no `--yolo`).
- Each sub-agent is a separate conversation with its own usage; team histories grow.
- Guard visibility is partial: plain `spawn_agent` tool events reach the JSON stream; local teammate events are
  filtered except usage. The Stage 9 guard would not see everything.
- Verification and rollback would still be the bridge's job. Little benefit for strictly sequential steps.

## What the bridge already has
Fresh run with bounded context (`buildResumedPrompt`), `input_required` + `cline_send`, guard reports, code map,
diff capture after edits (`inspectAfterRun`), cancellation, run history.

## Missing
Step schema and current-step state; a ledger of verified steps; automatic advancement; per-step and whole-plan
budgets; bridge-run verification (command, timeout, exit code, output); rollback of a failed step (edits run in the
real checkout; the diff is cumulative against HEAD, excludes untracked files, and failed runs skip inspection).

## Options
| Option | For | Against |
|---|---|---|
| (a) Cline plans itself (one workspace run → JSON steps) | Fully automatic | Extra call, schema validation, weak free model plans poorly |
| (b) Caller supplies the steps | Smallest; the caller (Claude/Codex/a planner model) plans, Cline executes, the bridge verifies — the "model per role" idea | The caller must write steps |
| (c) Cline's `spawn_agent`/`team_task` | Native | Partial guard visibility, growing histories, no verification/rollback |

Recommendation: (b) first, (a) later as an optional `cline_plan`.
