# Future work: share Cline bridge state across machines via Supabase

Status: proposal for the project backlog. Nothing is built yet.
Source: Cline MCP bridge v2 (`C:\Develop\ClineMcp`, plan `plan/cline-bridge-v2/`), Stage 8 and later.

## Context

The Cline MCP bridge (`cline-local`) runs Cline CLI for local agents (Claude Code, Codex,
others). Several bridge processes run at once: different agents on one machine, and
different machines at the same time. Each machine has its own Cline CLI install.

Stage 8 (local only) adds:
- A per-machine state file in `~/.cline-mcp/`: CLI version, update state
  (`ok`, `update_available`, `updating`, `rolled_back`, `broken`), failed versions with
  the reason, and the last real result per free model.
- A once-a-day CLI update check, started only by a real call (no timers).
- An update that runs only when no Cline run is active, a self-check after it, and an
  automatic rollback on failure.
- A rule after a rollback: never retry the failed version, only a newer one.
- A local lock, so only one bridge per machine updates.
- A model-picker dashboard showing each model's last real result with its time, and the
  CLI version in colour (green = current or newer available, yellow = rolled back).

The state file is shaped like the future table below, one row per machine, so syncing
can be added without a redesign. The bridge has one sync hook that is a no-op until this
work is done.

## Why Supabase

Local state cannot answer cross-machine questions:
1. **Repeated failures.** A CLI version that failed and rolled back on machine A is tried
   again on machine B. That wastes one self-check per machine and risks a broken window.
2. **No single view.** Each machine has its own dashboard. Nobody sees all machines'
   CLI versions, update states and model availability in one place.
3. **Model availability is per machine.** A free model that hit its quota on one machine
   is still picked on another.

Supabase (hosted Postgres plus API) is already part of the owner's project, so it is the
natural shared store.

## Proposed data (draft)

`cline_machines` — one row per machine:
- `machine_id` (stable id, not the hostname if that is private), `updated_at`
- `cli_version`, `catalog_version`, `update_state`, `latest_known_version`
- `last_error` (short, redacted)

`cline_failed_versions` — one row per (version, machine):
- `cli_version`, `machine_id`, `failed_at`, `reason` (short, redacted)
- Any machine skips a version listed here and waits for a newer one.

`cline_model_status` — last real result per (machine, model):
- `machine_id`, `provider`, `model_id`, `state` (`available`, `rate_limited`,
  `quota_exhausted`, `unreachable`), `checked_at`, `reset_at`, `source` (`run` or `ping`)

## Requirements

- **Optional and non-blocking.** The bridge must work fully offline. A Supabase error or
  timeout never fails, delays or blocks a Cline call. Sync failures are logged and retried
  on the next real call.
- **Local first.** The local file is the source of truth for that machine. Supabase adds
  knowledge from other machines (failed versions, model status) and never overrides a
  local self-check.
- **No secrets in rows.** Only versions, states, short redacted reasons and timestamps.
  No prompts, answers, paths with user names, or tokens.
- **Credentials stay with the owner.** The Supabase URL and key come from environment
  variables set by the owner on each machine. Use a key limited to these tables (row-level
  security), not the service key.
- **No timers.** Sync happens only as part of a real call or a dashboard refresh, like
  the local update check.
- **Shared dashboard.** model-picker (or the owner's project UI) can show all machines
  from these tables.

## Open questions for the project owner

- Which Supabase project and schema should host these tables?
- How should machines be identified (generated id stored in `~/.cline-mcp/`)?
- How long should rows be kept (for example, failed versions 30 days, model status 7 days)?
- Should the owner's project UI own the shared dashboard, or model-picker?

## Dependencies

- Cline bridge v2 Stage 8 (local state file and sync hook) must be done first.
