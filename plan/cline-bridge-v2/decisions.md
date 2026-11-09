# Cline Bridge v2 — Decision Log

Each entry: date, decision, why, evidence. Newest at the bottom. Append only; mark a reversed
decision as "Superseded by D-xx" instead of deleting it.

### D-01 — 2026-11-09 — Keep Cline as the agent
**Decision:** The bridge stays a Cline bridge. No own agent loop for now.
**Why:** Cline already provides tools, the loop, worktree support and the event stream. An own
loop means rebuilding all of that.
**Evidence:** Experiments F5–F6 show the event stream gives enough visibility.

### D-02 — 2026-11-09 — Explicit provider and model on every call
**Decision:** `provider` and `model` become mandatory. The bridge never relies on Cline's saved default.
**Why:** The saved default went stale silently and broke the bridge ("Insufficient balance").
The CLI also overwrites the saved default on every run.
**Evidence:** F2, F3. Requested by the user.

### D-03 — 2026-11-09 — Short settings lock instead of a lock for the whole run
**Decision:** Lock only around snapshot and restore, with an active-run counter; restore when the last run ends.
**Why:** With D-02 every run would hold the lock for its whole duration, so parallel calls would
fail after 30 s. With an explicit model on every call the saved default no longer affects the
bridge; it is restored only to protect the user's app settings.
**Evidence:** F3, F4 (`withProviderOverride` in `src/settings.ts`).

### D-04 — 2026-11-09 — Free models come from the installed catalog
**Decision:** Read `@cline/llms` from the installed CLI; fail clearly if it cannot be read.
**Why:** There is no CLI command to list models, and `globalState.json` holds stale IDs.
**Risk accepted:** Internal API; a Cline update can break it. Mitigated by `catalog_unavailable`.
**Evidence:** F8.

### D-05 — 2026-11-09 — Fresh process per follow-up, not `--id` resume
**Decision:** Answers to Cline's questions start a fresh run with a context file.
**Why:** Deterministic and independent of reported resume bugs. `--id` may be tried later as an optimisation.

### D-06 — 2026-11-09 — `QUESTION:` protocol instead of `ask_question`
**Decision:** Bridge runs are told not to use `ask_question` and to end with `QUESTION: ...`.
Any `ask_question` call that still happens is surfaced as `auto_answered`.
**Why:** Headless `ask_question` silently auto-selects the first option (F7); that is a hidden decision.
**Note:** Not confirmed in Cline docs whether F7 is intentional. Observed behaviour only.

### D-07 — 2026-11-09 — No automatic retry for async tasks; max 2 concurrent
**Why:** A task that edits files must not be re-run blindly (F9). The concurrency cap protects quota and the machine.

### D-08 — 2026-11-09 — Deferred: micro-step splitting
**Decision:** Not in v2. When added, the bridge forces a short plan step that returns structured JSON; Cline decides the content.

### D-09 — 2026-11-09 — Deferred: true mid-run two-way dialogue
**Decision:** Not in v2. Options for later: Cline `hub` / `--zen` if it exposes a session API, or an
own loop on a hosted model with a real `ask_caller` tool. Revisit only if "stop, answer, rerun" proves insufficient.

### D-10 — 2026-11-09 — Plan files live in `plan/cline-bridge-v2/` inside the bridge repo
**Why:** Requested by the user. Keeps plan, progress and decisions next to the code they describe.

### D-11 — 2026-11-09 — Every stage = Code, then Verify (code review + live check against Cline)
**Decision:** Each stage ends with two gates: `n.R` code review of the stage diff and `n.L` a live
run of the real bridge against the real Cline CLI on the free model. The next stage starts only
after both pass.
**Why:** Requested by the user. Unit tests alone did not catch today's real failures (stale model
ID, settings write-back, headless auto-answer); only live runs did.

### D-12 — 2026-11-09 — Cline is not a helper in this project
**Decision:** No analysis, coding or review by Cline. Analysis: Grok (`xai`), fallback AGY/OpenCode.
Code: Claude. Review: picked by model-picker with the author excluded (default Grok `grok_code_review`).
Cline is only the system under test, and only through the bridge's MCP tools in the `n.L` live
checks; it is never called directly during development.
**Why:** Requested by the user. Also avoids Cline analysing or reviewing the bridge that runs it
while that bridge is broken.
**Note:** Overrides the global "Cline first" analysis route for this project only.

### D-13 — 2026-11-09 — Codex replaces Grok; Grok is out
**Decision:** Pre-code analysis and `n.R` code review go to Codex (`codex_ask`, read-only sandbox).
Fallback: AGY, then OpenCode. Grok is not used in this project. Supersedes the Grok parts of D-12.
**Why:** Requested by the user. Codex has the only real enforced OS sandbox among the backends,
so read-only is guaranteed.
**How:** Each Codex prompt opens with an explicit user-authorization block naming it the
analyst/reviewer (otherwise its global AGENTS.md makes it refuse). Effort comes from the
project's `.codex/config.toml`.
