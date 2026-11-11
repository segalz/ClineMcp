# Stage 10.0 — Research (2026-11-11)

Sources: static inspection of the installed Cline CLI 3.0.74 (`%APPDATA%\npm\node_modules\cline`,
`@cline/core` 0.2.0). AGY covered the read and search tools; Codex covered the rules and the bridge prompt,
after AGY timed out twice on the rules question. No Cline run, no network.

## Tools Cline already has

- **`read_files`** (alias `read_file`): `path`, optional `start_line` / `end_line` (1-based).
  Caps: 2,000 lines and 48,000 chars per read. When it truncates it says:
  `[Showing lines s-T of b. Use start_line/end_line to read other sections.]`
  (`output-limits.d.ts`: `MAX_READ_LINES`, `MAX_READ_OUTPUT_CHARS`).
- **`search_codebase`** (aliases `search_files`, `list_code_definition_names`): `queries` (regex, string or list).
  Caps: 100 results and 48,000 chars.
- So line-range reads exist already. The 2026-11-11 runs read whole 1,000+ line files first and only then
  re-read; the rules below just make Cline search first and read ranges.

## Rules mechanisms (all loaded in headless runs)

- Workspace: `.clinerules` (file or folder), `.cline\rules`, `AGENTS.md` in the cwd.
- Global: `~\.cline\rules`, `~\Cline\Rules`, `~\Documents\Cline\Rules` (and OneDrive), `~\.agents\AGENTS.md`.
  None of these exist on this machine today.
- `-s, --system <prompt>` **replaces** the default system prompt for that run. There is no flag that
  appends to it.

## What the bridge sends today

- `ask`: prepends `NO_TOOLS_PREAMBLE` to the prompt.
- `workspace` / `edits`: pass their own instructions through `--system` (`src/runner.ts:768,770,1249-1260`,
  `src/workspace.ts:26,150`, `src/edits.ts:49,164`). That means they replace Cline's default system
  prompt. Whether this removes useful built-in guidance has not been checked; 10.1 must find out first.

## Options for delivering the working rules

| Option | For | Against |
|---|---|---|
| A. Add to the bridge's existing instructions (`--system` / preamble) | One place, every mode, nothing written to the user's repos | Depends on what `--system` replaces |
| B. `.clinerules` written into the disposable worktree | Uses Cline's own mechanism, keeps the default system prompt | Workspace mode only; edits mode would write into the real checkout |
| C. Global rules folder | Zero bridge code | Affects every Cline use on the machine; not per task |

Recommendation: A. In addition, 10.1 opens with a live comparison: the same task with the bridge's
`--system` and with the rules moved into the user prompt instead, so Cline keeps its default system prompt.
Whichever is cheaper and still correct wins.
