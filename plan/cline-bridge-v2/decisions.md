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

### D-14 — 2026-11-09 — Journal v2 with run IDs; restore after the last live run
**Decision:** The restore journal holds the user's original values (`base`) and a map of active runs
(`runId → pid, provider, startedAtMs`). A run is dead when its PID is gone, it is older than 6 h, or this
process marked it finished. The baseline is restored only when no live run remains. The end-of-run lock has
its own 30 s timeout, independent of the run deadline.
**Why:** A counter cannot tell which run crashed (Codex analysis). The restore keeps all three fields it
touched before (`lastUsedProvider`, `model`, `reasoning`).

### D-15 — 2026-11-09 — A cleanup failure never hides the run's result
**Decision:** If unregistering fails after a successful run, the result is returned with a warning and the
run is marked finished so the next call restores. If the run itself failed, its own error is rethrown.
**Why:** Codex review round 1 (P1). Previously a restore failure replaced a good result with an error.

### D-16 — 2026-11-09 — Both fields required at every layer; no inference
**Decision:** `provider` and `model` are required by the MCP schema, at `runCline` entry, in `cline_ping`
before its cache, and in `withProviderOverride` before any settings access. The code that filled a missing
field from saved settings (`resolveSavedSelection`, model-only provider inference) was removed.
**Why:** D-02. Codex review round 1 found the helper still accepted one field, which is not reachable via MCP
but contradicts the rule.

### D-17 — 2026-11-09 — "Free" means what Cline itself advertises as free
**Decision:** `cline_list_models` returns `GENERATED_CLINE_RECOMMENDED_MODELS.free` from the installed CLI's
`@cline/llms`, not every zero-priced catalog entry, and not only `cline-free/*` ids (the list also holds
e.g. `reflection/beam-free`). All are used with provider `cline`.
**Why:** Codex analysis: zero pricing also covers routers such as `openrouter/auto`; the explicit free list is
Cline's own classification.

### D-18 — 2026-11-09 — Trace redaction is defense in depth, not a security boundary
**Decision:** Traces live in the same user's TEMP with owner-only permissions. Structured values are redacted
reliably (a sensitive key redacts its whole subtree, any type). Free-text reasoning is covered only by the
text patterns; JSON embedded as text with escaped quotes may slip through, and that is accepted. Streaming
deltas are never persisted; the status shows only complete blocks.
**Why:** Cline itself already stores every session's full, unredacted messages in `~/.cline/data/sessions`
for the same user (2,899 sessions on 2026-11-09), so the trace exposes nothing new. Codex review kept finding
new free-text formats; perfect free-text redaction is not achievable.

### D-19 — 2026-11-09 — Sync calls keep their trace for 24 h
**Decision:** `ask_cline`, `ask_cline_workspace` and `apply_cline_edits` always record a trace and return its
location (also on errors). Traces are removed on bridge start after 24 h, or when their process died.
Removal "after the result is collected" applies to async tasks (Stage 5).

### D-20 — 2026-11-09 — Observation: `ask_cline` cannot read files — Superseded by D-21
`ask_cline` runs Cline with `--auto-approve false`, so even read tools are refused and Cline asks for approval
in its answer.

### D-21 — 2026-11-09 — `ask_cline` tells Cline up front that it has no tools
**Decision:** `ask_cline` prepends a short notice to the prompt (`NO_TOOLS_PREAMBLE`): no tools, answer from the
message, say so in one sentence if files are needed. Its MCP description says the same and points to
`ask_cline_workspace` (read a repo) and `apply_cline_edits` (change files). On Windows any request whose escaped
command line exceeds 32,000 UTF-16 units is refused clearly before launch.
**Why:** The user flagged the wasted tries as a bug. Codex analysis of CLI 3.0.74: headless `--auto-approve false`
refuses every tool; there is no read-only approval flag (per-tool `toolPolicies` exist internally but the CLI does
not expose them); `--plan` still allows `run_commands`; `--yolo` approves `editor` and `run_commands`. So
"no tools, said honestly" is the only safe option.
**Evidence:** Live: same file-listing request went from 2 refused tool calls / 2 iterations to 0 / 1 with an
honest one-sentence answer; a code question in the prompt was answered correctly.

### D-22 — 2026-11-10 — No Cline or Git process outlives its run or the bridge
**Decision:** On stdin end/close or SIGINT/SIGTERM the bridge refuses new work, aborts every async task and every
sync tool call in flight, waits up to 120 s for their cleanup (settings unregister ≤30 s, then worktree removal or
the edits post-run Git budget of 60 s), then exits. Git commands have deadlines (60 s; cleanup 20 s; post-run
steps share 60 s; retry checks share 20 s), follow the caller's cancel before the run, and on Windows are killed
as a process tree. A cancel just before launch never starts Cline.
**Why:** Codex review (Stage 5) found each way a process or a task slot could be left behind.

### D-23 — 2026-11-10 — Only model runs are logged to model-picker
**Decision:** `cline_result` returns `log_run_hint: null` with `log_run_note` when the task was cancelled or failed
locally (bad cwd, Git setup, settings lock, launch, catalog, cleanup). Otherwise the hint maps timeout → `timeout`,
quota/rate limit → `quota` (with `retry_after_s`), anything else → `crash`.
**Why:** model-picker counts crashes against the model's skill; local failures are not the model's fault.

### D-24 — 2026-11-10 — Stage 6 is written by AGY and reviewed by Codex
**Decision:** At the user's request, Stage 6 code is implemented by AGY (`antigravity_ask`, write mode, branch
`bridge-v2`) and reviewed by Codex (`codex_ask`, read-only). Claude writes no Stage 6 code: it writes the prompts,
verifies the diff and tests itself, runs the live check, and commits.
**Why:** Requested by the user ("only Codex and AGY do the next stage"). Cline stays out (D-12).

### D-25 — 2026-11-10 — A question is the trailing `QUESTION:` block, without Markdown parsing
**Decision:** A run's answer is a question only when its last non-empty lines are `QUESTION: ...` and optionally
`OPTIONS: ...`, each with at most 3 leading spaces and no tab. No fence tracking: a closed code block always ends
with its closing fence, so a `QUESTION:` inside it is never the last line, and 4+ spaces / a tab (indented code)
are rejected. Accepted residual: an answer that ends inside an UNCLOSED fence with a column-0 `QUESTION:` line
(malformed Markdown) is treated as a question.
**Why:** Codex review rounds 3–5 kept finding new nested-Markdown cases (4-backtick fences, fences in lists);
a full CommonMark parser is out of proportion, and the trailing-block rule covers well-formed Markdown.

### D-26 — 2026-11-10 — The bridge publishes its free list as a file; the picker trusts it for Cline
**Decision:** The bridge writes `~/.cline-mcp/catalog.json` (env `CLINE_MCP_CATALOG_PATH`) atomically at startup and
after each `cline_list_models`, without statuses. model-picker reads only that file (no `globalState.json`
fallback). Configured Cline models absent from a valid catalog, or with a fresh non-available bridge status, are not
picked; a missing or invalid catalog blocks nothing. The picker's model list stays static in TOML.
**Why:** Python cannot import `@cline/llms` without duplicating the bridge's install resolution; a file keeps one source.

### D-27 — 2026-11-10 — Stage 7: AGY implements, Claude reviews; AGY on its strong model
**Decision:** At the user's request Codex is out for Stage 7; Claude does the analysis and review. AGY implements,
from review round 1 on `gemini-4-argon-high` (added to model-picker's `agy` backend, quota family "Gemini 4 Argon").

### Open risk — settings restore vs. a concurrent token refresh
The restore reads the freshest settings file and rewrites it. If another Cline client (the desktop app)
rotates the login token in the milliseconds between that read and write, the rotation could be lost and
Cline would ask for re-authentication. Pre-existing in v1; not shown to be the cause of the 2026-11-09
expiry. Revisit if re-authentication repeats.

### D-13 — 2026-11-09 — Codex replaces Grok; Grok is out
**Decision:** Pre-code analysis and `n.R` code review go to Codex (`codex_ask`, read-only sandbox).
Fallback: AGY, then OpenCode. Grok is not used in this project. Supersedes the Grok parts of D-12.
**Why:** Requested by the user. Codex has the only real enforced OS sandbox among the backends,
so read-only is guaranteed.
**How:** Each Codex prompt opens with an explicit user-authorization block naming it the
analyst/reviewer (otherwise its global AGENTS.md makes it refuse). Effort comes from the
project's `.codex/config.toml`.
