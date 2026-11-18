# AI Agent Ecosystem Evaluation & Integration Plan for `ClineMcp` (`cline-local`)

**Target Repository:** `ClineMcp` (`cline-local-mcp-bridge`, TypeScript / Node.js `>=20`, `@modelcontextprotocol/sdk`)  
**Audience:** Coding and architecture agents working on `ClineMcp` and its companion indexer (`codeindex`)  
**Scope:** Architectural evaluation of 20 candidate open-source agent frameworks, memory layers, RAG/indexing engines, and MCP reference servers, with concrete recommendations on **what to integrate, what patterns to borrow, and what to skip**.

---

## 1. Executive Summary & Architectural Context

### 1.1 Current 3-Tier Architecture of `ClineMcp`
`ClineMcp` is already an execution bridge sitting inside a 3-tier architecture rather than a blank-slate chatbot:

1. **Tier 1 — External Orchestrator (Antigravity / Codex / Claude):**
   Decomposes large tasks into focused, incremental steps and calls the MCP tools exposed in `src/index.ts` (`ask_cline`, `ask_cline_workspace`, `apply_cline_edits`, `cline_ping`, `cline_list_models`, and the async lifecycle tools `cline_start`, `cline_status`, `cline_send`, `cline_cancel`, `cline_result`).
2. **Tier 2 — `ClineMcp` Bridge & Deterministic Lifecycle Guard (`src/`):**
   A TypeScript MCP server (`src/edits.ts`, `src/finalcheck.ts`, `src/guard.ts`, `src/codemap.ts`, `src/snapshot.ts`, `src/rules.ts`, `src/runner.ts`, `src/workspace.ts`, `src/trace.ts`, `src/settings.ts`, `src/clistate.ts`) that enforces:
   - Single-writer checkout locks (`src/checkoutlock.ts`) and baseline Git snapshots (`src/snapshot.ts`) with automatic rollback on failure (`FinalCheckLifecycle.restore()`).
   - Bounded preamble code maps (`src/codemap.ts`: `CODEINDEX_CLI` adapter with `buildRegexCodeMap` fallback), strictly constrained by `maxChars` (`6_000`), `MAX_TOTAL_TEXT_CHARACTERS` (`24_000`), and `WINDOWS_COMMAND_LINE_LIMIT` (`32_000`) via `codeMapCommandLineLength`.
   - Real-time loop and budget protection (`src/guard.ts`: `GuardOptions` enforcing `maxRepeatedFailures`, sliding `window`, `maxToolCalls`, and `maxInputTokens`).
   - An automated Edit -> Verify -> Repair state machine (`FinalCheckLifecycle` in `src/finalcheck.ts`) supporting deterministic shell-free verification commands (`verificationSchema`) and up to `maxFixRuns` (`0..3`) repair loops.
3. **Tier 3 — Execution Worker (Cline CLI):**
   The locally installed Cline CLI invoked in headless `--json --auto-approve` mode (`src/runner.ts`), running its own internal tool-use loop with free or configured LLM models.

### 1.2 Why Adding Full Agent Frameworks to `ClineMcp` Is an Anti-Pattern
Adding general-purpose agent orchestration frameworks (e.g., LangGraph, CrewAI, OpenAI Agents SDK, Microsoft Agent Framework, Google ADK, Agno, smolagents, OpenHands, Flowise, Dify, n8n) directly as runtime dependencies inside `ClineMcp` would degrade performance and reliability:
- **Agent-inside-an-agent-inside-an-agent overhead:** Tier 1 (Orchestrator) already plans and delegates; Tier 3 (Cline CLI) already executes a multi-step tool loop. Inserting another autonomous agent planner in Tier 2 duplicates tool calls, inflates token consumption, and adds latency.
- **Runtime & deployment mismatch:** `ClineMcp` is a lightweight local stdio Node.js/TypeScript server with strict Windows command-line and process-tree constraints (`defaultKillTree`, `TIME_BUDGET_MS = 1_500`). Most listed frameworks are Python-first or require Docker/Postgres/Neo4j sidecars.
- **Duplication of existing hardened primitives:** `FinalCheckLifecycle` (`src/finalcheck.ts`) and `Guard` (`src/guard.ts`) already provide tighter Git-level safety and loop detection than generic Python agent loops.

### 1.3 Actual Bottlenecks Observed in `ClineMcp`
Based on `src/`, `plan/open-items.md`, and `plan/cline-bridge-v2/stage13-results.md`, `ClineMcp`'s real bottlenecks are **context quality, cross-run amnesia, and large-file navigation**, not lack of orchestration:

1. **Cold-start statelessness across runs:** Every `apply_cline_edits` and `ask_cline_workspace` call starts with zero memory of prior runs. Cline cannot recall repository-specific test quirks, PowerShell 5.1 pitfalls (documented in `plan/open-items.md` Item #8, where 6 of 28 steps used Unix syntax before `buildEnvironmentLine` was hardened), or fixes discovered during previous `maxFixRuns` repair cycles.
2. **Large-file truncation & re-read loops:** As recorded in `plan/open-items.md` (Item #8), Cline's internal read tool drops the middle of long files (`[truncated N chars]`), causing models to loop re-reading the same file until `guard.ts` trips `maxInputTokens` or `maxRepeatedFailures`. While `WORKING_RULES` (`src/rules.ts`) tells Cline to read ranges of >=200 lines, `buildRegexCodeMap` only supplies symbol start lines (`symbol:line`), not end lines.
3. **Missing structural impact / reverse-dependency edges:** `stage13-results.md` shows `codeindex` ranking v2 cut input tokens by 16% and runtime by 25% on hard localization questions (`0.91` score vs `0.89` regex baseline), yet hard multi-file accuracy plateaued because the map does not explicitly surface `imported-by` / caller edges when a function signature changes.
4. **Unchecked assumptions about external state:** During code changes involving SQLite/Postgres schemas, local services, or library APIs, headless Cline relies on guessing or fragile shell one-liners unless grounded via read-only MCP tools.

---

## 2. Tier 1: High-Impact Repositories to Integrate or Adapt

These four entries directly address the bottlenecks above without competing with Tier 1 or Tier 3.

### 2.1 #14 — Mem0 (`https://github.com/mem0ai/mem0`)
- **Source:** https://github.com/mem0ai/mem0
- **What it is:** A persistent, structured memory layer for AI agents that extracts, deduplicates, updates, and retrieves factual memories across sessions.
- **Why it helps `ClineMcp`:**
  - Eliminates cold-start amnesia across `apply_cline_edits` and `ask_cline_workspace` runs on the same repository.
  - Captures the highest-signal knowledge generated by `ClineMcp`: **repair deltas** (when Verification Run 1 fails in `FinalCheckLifecycle` and Repair Run 2 succeeds) and **guard failure patterns** (when `guard.ts` trips `loop_detected` on a specific tool + target).
  - Reduces repeated `maxFixRuns` waste and prevents free/fast models from making the same environment or convention mistake twice.
- **How to implement in `ClineMcp` (TypeScript/Node.js):**
  - **Storage choice:** Avoid adding a heavy Python server. Either use the `mem0ai` TypeScript/Node SDK if an external memory backend is desired, or implement Mem0's **extract -> reconcile -> retrieve** lifecycle natively in Node.js using a lightweight local store under `~/.cline-mcp/memory/` (e.g., per-repo JSONL/SQLite indexed by normalized `rootPath`, matching how `~/.cline-mcp/locks` and `.cline-mcp/status.json` are managed).
  - **Write path (`src/finalcheck.ts`):** Hook into `FinalCheckLifecycle.complete()` and `FinalCheckLifecycle.wait()`:
    - When `this.launches > 1` (a repair run succeeded after an initial `verify` failure), store a concise memory record: `{ repoRoot, filesTouched, failureSignal (redacted stderrTail summary), resolutionSummary, timestamp }`.
    - When `waitReason === "guard"` (`loop_detected` or repeated command failure), store an anti-pattern warning (e.g., `"Avoid running X in PowerShell 5.1; test runner requires Y"`).
  - **Read path (`src/edits.ts`, `src/workspace.ts`, `src/codemap.ts`):** Add a bounded `withProjectMemory(root, prompt, options)` step alongside `withCodeMap`:
    - Retrieve top-K memories matching `input.prompt` keywords or top-ranked files from the code map.
    - Cap injected memory tightly (e.g., `<= 600–800` characters) and include it in `codeMapCommandLineLength` calculations so `WINDOWS_COMMAND_LINE_LIMIT` (`32_000`) and `MAX_TOTAL_TEXT_CHARACTERS` (`24_000`) are never exceeded.
    - Prepend as a `## Project Memory (auto-learned from prior runs)` block in `promptPreamble`.

### 2.2 #13 — LlamaIndex (`https://github.com/run-llama/llama_index`)
- **Source:** https://github.com/run-llama/llama_index
- **What it is:** Data framework specializing in code/document ingestion, AST-aware splitting (`CodeSplitter`), and hybrid retrieval/reranking.
- **Why it helps `ClineMcp`:**
  - Directly mitigates **Open Item #8** (Cline stalling on large files when its read tool emits `[truncated N chars]`).
  - `WORKING_RULES` rule #4 (`src/rules.ts`) tells Cline: *"for a longer file read only the ranges you need, each at least 200 lines."* Currently, `buildRegexCodeMap` (`src/codemap.ts`) only emits start lines (`symbolName:42`). Cline still does not know where a function or class ends, causing over-broad reads that get truncated in the middle.
- **How to implement in `ClineMcp` / `codeindex`:**
  - Adopt LlamaIndex's **`CodeSplitter` (tree-sitter AST chunking)** pattern inside `codeindex` (already wired via `CODEINDEX_CLI` in `src/codemap.ts`) or as an optional enhancement to `src/codemap.ts`:
    - Emit **exact `[startLine-endLine]` AST spans** for relevant symbols instead of single start lines (e.g., `FinalCheckLifecycle.execute:127-223`, `buildRegexCodeMap:114-186`).
    - Apply LlamaIndex-style **chunk scoring & parent-context preservation**: rank AST blocks against `input.prompt` using BM25/identifier weighting, keeping class/module headers alongside matching methods.
    - Respect `CODEINDEX_TIME_BUDGET_MS` (`10_000`) and `formatMap` binary-search truncation so the emitted `## Code map` stays fast and fits under `maxChars` (`6_000`).

### 2.3 #15 — Graphiti (`https://github.com/getzep/graphiti`) & #16 — Cognee (`https://github.com/topoteretes/cognee`)
- **Sources:**
  - https://github.com/getzep/graphiti
  - https://github.com/topoteretes/cognee
- **What they are:**
  - **Graphiti:** Temporal knowledge-graph engine that tracks entities, relationships, and how facts/dependencies evolve over time.
  - **Cognee:** Semantic memory and entity-relationship graph builder over raw documents and source code.
- **Why they help `ClineMcp`:**
  - On multi-file edits, Cline often changes an exported type, function signature, or constant in File A without updating callers in File B, causing `verify` to fail and consuming a `maxFixRuns` slot.
  - `stage13-results.md` highlighted that hard localization tasks involve multi-file flows and caller traces (`"who calls withCodeMap"`), where structural edges cut token usage dramatically when surfaced in the map.
- **How to implement in `ClineMcp` / `codeindex`:**
  - **Do not embed Neo4j or a Python daemon.** Instead, implement a lightweight local dependency + temporal-coupling graph inside `codeindex` (or cached per-commit in `.git`/temp cache):
    - **Cognee-inspired static graph:** Build a compact adjacency index of `imports` / `exports` / symbol references across tracked files.
    - **Graphiti-inspired temporal co-change edges:** Mine recent `git log --name-only` commits incrementally (bounded by a small commit window, e.g., last 100 commits) to identify files that historically change together even without direct imports (e.g., `src/edits.ts` <-> `src/test/edits.test.ts` or `src/rules.ts` <-> `plan/open-items.md`).
    - **Injection format:** Annotate the top-ranked files in `## Code map` with compact edge hints, e.g.:
      `src/runner.ts (1305 lines) [imported-by: edits.ts, codemap.ts, workspace.ts, finalcheck.ts]`.

### 2.4 #12 — MCP Reference Servers (`https://github.com/modelcontextprotocol/servers`)
- **Source:** https://github.com/modelcontextprotocol/servers
- **What it is:** The official collection of reference MCP servers (`sqlite`, `postgres`, `git`, `fetch`, `memory`, `filesystem`, etc.).
- **Why it helps `ClineMcp`:**
  - Gives headless Cline deterministic, structured access to local schemas, database metadata, or external docs instead of guessing or running error-prone PowerShell scripts.
  - Offloads fragile read-only inspection from shell commands (which frequently hit Windows PowerShell 5.1 quoting/syntax issues).
- **How to implement in `ClineMcp`:**
  - Wire **read-only** reference servers (such as `@modelcontextprotocol/server-sqlite` or `fetch`) into Cline's isolated data/settings profile when needed for database-backed or API-heavy target repositories.
  - **Safety constraint:** Any server configuration managed by `ClineMcp` must integrate cleanly with `src/settings.ts` (`acquireSettingsMutex`, settings snapshot/restore) and must never expose write-capable MCP servers during `ask_cline_workspace`, preserving the strict read-only invariants of `WORKSPACE_SYSTEM_PROMPT` (`src/workspace.ts`).

---

## 3. Tier 2: Valuable Design Patterns to Borrow (No New Dependencies Needed)

Even where adding a Python/heavy library makes no sense, three frameworks offer concrete architectural patterns worth adapting directly into `ClineMcp`'s TypeScript codebase:

1. **#1 — LangGraph (`https://github.com/langchain-ai/langgraph`) -> Serializable Lifecycle Checkpoints in `src/trace.ts`**
   - *Why not the library:* `FinalCheckLifecycle` (`src/finalcheck.ts`) already implements a purpose-built cyclical state graph (`snapshot -> run -> verify -> repair loop -> done/restore/waiting`) tailored to Git invariants and Windows process trees.
   - *Pattern to borrow:* **Graph state checkpointing.** Persist structured lifecycle checkpoints (`phase`, `launches`, `automaticFixes`, `verification.attempts`, `guard` snapshot, `filesTouched`) into the per-run trace directory (`resolveTraceBase()` in `src/trace.ts`) after every transition. This enables full post-mortem diagnostics for failed multi-file runs and safer resume semantics across async `cline_send` (`retry`/`restore`/`keep`) cycles.

2. **#6 — Pydantic AI (`https://github.com/pydantic/pydantic-ai`) -> Schema-Validated Output Retries**
   - *Why not the library:* `ClineMcp` is TypeScript and already uses `zod` (`verificationSchema`, `startTaskSchema`, `guardOptionsSchema`).
   - *Pattern to borrow:* **Output validation with targeted retry.** When callers use `ask_cline_workspace` or `ask_cline` for structured localization or audit tasks (or when parsing `editQuestion` in `src/edits.ts`), optionally accept a JSON output contract/schema and run one ultra-short repair turn if Cline's final response violates the requested structure.

3. **#7 — Agno (`https://github.com/agno-agi/agno`) -> Strict Context-Budget & Sub-5ms Local Knowledge Separation**
   - *Why not the library:* Agno wraps direct LLM SDK calls in Python; Cline CLI owns the model conversation.
   - *Pattern to borrow:* Agno's separation between **ephemeral run instructions**, **session state**, and **indexed knowledge** with minimal runtime overhead. Keeping `ClineMcp`'s memory lookup and code-map assembly strictly local (`<5–10 ms` memory read inside `TIME_BUDGET_MS = 1_500`) prevents `preparationMs` (`src/codemap.ts`) from eating into Cline's execution timeout.

---

## 4. Full Reference Matrix: All 20 Evaluated Repositories

| # | Repository & Source URL | Primary Category | Verdict for `ClineMcp` | Technical Rationale |
|---|---|---|---|---|
| 1 | **LangGraph**<br>https://github.com/langchain-ai/langgraph | Stateful cyclical agent graphs | **Borrow Pattern Only** | `FinalCheckLifecycle` (`src/finalcheck.ts`) already implements the exact Edit-Verify-Repair state graph. Borrow its checkpoint serialization pattern in `src/trace.ts`. |
| 2 | **CrewAI**<br>https://github.com/crewAIInc/crewAI | Multi-agent role delegation | **Skip** | Tier 1 (Antigravity/Codex) already performs task decomposition; Cline is a single focused worker. Adding role-playing crews in Tier 2 adds latency and token waste. |
| 3 | **OpenAI Agents SDK**<br>https://github.com/openai/openai-agents-python | Lightweight Python handoffs & tracing | **Skip** | Python-centric orchestrator redundant with Tier 1 + `src/trace.ts` NDJSON tracing. |
| 4 | **Microsoft Agent Framework**<br>https://github.com/microsoft/agent-framework | Enterprise multi-agent workflows | **Skip** | Designed for business/enterprise multi-agent pipelines, not local Git-checkout CLI bridging. |
| 5 | **Google ADK**<br>https://github.com/google/adk-python | Modular Python agent SDK (Gemini) | **Skip** | Orchestration layer redundant with Antigravity; `ClineMcp` is intentionally model-agnostic across free/configured Cline providers (`models.ts`). |
| 6 | **Pydantic AI**<br>https://github.com/pydantic/pydantic-ai | Type-safe agents & structured outputs | **Borrow Pattern Only** | `ClineMcp` already uses `zod` for inputs. Borrow its typed-output validation + self-correction retry pattern for structured `ask_cline_workspace` responses. |
| 7 | **Agno**<br>https://github.com/agno-agi/agno | Fast multimodal agents w/ memory & knowledge | **Borrow Pattern Only** | Do not wrap Cline in Agno's agent runner; borrow its clean separation of lightweight local knowledge + memory retrieval within tight latency budgets. |
| 8 | **Hugging Face smolagents**<br>https://github.com/huggingface/smolagents | Python CodeAgents (write Python instead of JSON tools) | **Skip** | Cline CLI has native file-edit and search tools tuned to its system prompt (`WORKING_RULES`). Wrapping it in Python code-execution agents adds security/sandbox risk and Windows quoting friction. |
| 9 | **Flowise**<br>https://github.com/FlowiseAI/Flowise | Visual drag-and-drop LLM builder | **Skip** | No-code UI workflow builder; incompatible with programmatic headless stdio MCP bridging. |
| 10 | **Dify**<br>https://github.com/langgenius/dify | Visual LLM app & RAG platform | **Skip** | Full web platform for building end-user AI apps; heavy server stack unrelated to local code editing. |
| 11 | **n8n**<br>https://github.com/n8n-io/n8n | Workflow automation platform | **Skip** | SaaS/business workflow automation; adds heavy infrastructure without helping code localization or Git safety. |
| 12 | **MCP Reference Servers**<br>https://github.com/modelcontextprotocol/servers | Standard MCP servers (`sqlite`, `postgres`, `fetch`, `git`, `memory`) | **Integrate / Adapt** | Useful read-only grounding tools for Cline (DB schemas, official docs) when scoped safely alongside `src/settings.ts` and `WORKSPACE_SYSTEM_PROMPT`. |
| 13 | **LlamaIndex**<br>https://github.com/run-llama/llama_index | RAG & AST `CodeSplitter` indexing | **Integrate / Adapt** | Adopt its tree-sitter `CodeSplitter` + hybrid retrieval design in `codeindex` / `src/codemap.ts` to emit exact `start-end` line ranges and stop large-file truncation loops (Open Item #8). |
| 14 | **Mem0**<br>https://github.com/mem0ai/mem0 | Persistent cross-session agent memory | **Integrate / Adapt** | **Highest ROI.** Adapt Mem0's extract-reconcile-retrieve pattern locally to persist repair lessons (`FinalCheckLifecycle`) and `guard` loop warnings per repo across runs. |
| 15 | **Graphiti**<br>https://github.com/getzep/graphiti | Temporal knowledge graphs | **Integrate / Adapt (Lightweight)** | Borrow temporal co-change graph modeling (`git log` file coupling + evolving codebase facts) in `codeindex` without deploying Neo4j. |
| 16 | **Cognee**<br>https://github.com/topoteretes/cognee | Semantic memory & entity-relation graphs | **Integrate / Adapt (Lightweight)** | Borrow static entity/import-edge extraction (`imported-by` / caller edges) to enrich `## Code map` for multi-file edits. |
| 17 | **OpenHands**<br>https://github.com/All-Hands-AI/OpenHands | Autonomous containerized SWE agent | **Skip (Direct Competitor)** | Competes directly with Cline CLI (Tier 3) inside Docker. Would replace Cline rather than improve `ClineMcp`. |
| 18 | **Browser Use**<br>https://github.com/browser-use/browser-use | Browser automation agent | **Skip** | Tier 1 (Antigravity) already includes a dedicated browser subagent; headless Cline edits local repos, not live browsers. |
| 19 | **AI Agents for Beginners**<br>https://github.com/microsoft/ai-agents-for-beginners | Educational course repository | **Skip** | Learning resource only; no production capabilities to integrate. |
| 20 | **Awesome LLM Apps**<br>https://github.com/Shubhamsaboo/awesome-llm-apps | Curated list of example apps | **Skip** | Reference examples only; not an infrastructure library. |

---

## 5. Prioritized Implementation Roadmap for Coding Agents

If a coding agent is tasked with upgrading `ClineMcp` and `codeindex`, execute in this order to maximize reliability gains per engineering hour while preserving existing invariants (`npm test`, `WINDOWS_COMMAND_LINE_LIMIT`, checkout locks, and snapshot recovery):

### Phase 1 — AST Span Line Ranges & Reverse-Import Edges (`codeindex` + `src/codemap.ts`)
- **Inspired by:** LlamaIndex (`CodeSplitter`) + Cognee/Graphiti (dependency & temporal edges).
- **Problem solved:** Eliminates large-file `[truncated N chars]` re-read loops (Open Item #8) and multi-file caller misses (`stage13-results.md`).
- **Concrete tasks:**
  1. Update `codeindex` (schema v2/v3 or `src/codemap.ts` fallback) so top-ranked symbols include exact `startLine-endLine` spans (e.g., `applyClineEdits:136-177`) rather than start lines alone.
  2. Add a compact `[imported-by: ...]` / `[co-changed-with: ...]` suffix on the top 3–5 prompt-matched files inside `## Code map`.
  3. Update `WORKING_RULES` #3/#4 (`src/rules.ts`) to instruct Cline to read exact `[start-end]` symbol spans directly from the Code map.
  4. Verify all outputs fit strictly inside `codeMapCommandLineLength` and `maxChars` (`6_000`).

### Phase 2 — Local Auto-Learned Project & Repair Memory (`src/memory.ts` + `src/finalcheck.ts` + `src/edits.ts`)
- **Inspired by:** Mem0 (persistent factual memory) + Graphiti (temporal validity).
- **Problem solved:** Stops Cline from repeating environment, command-syntax, or verification mistakes across separate `apply_cline_edits` invocations.
- **Concrete tasks:**
  1. Create a zero-dependency (or `node:sqlite` / atomic JSON store) local module `src/memory.ts` storing scoped memories under `~/.cline-mcp/memory/<repo-hash>.json`, using the same atomic write/lock safety patterns seen in `src/status.ts` and `src/trace.ts` (and secret redaction via `redactSecrets`).
  2. On `FinalCheckLifecycle` fail -> pass transitions (`this.launches > 1` and `verified.passed`) or `guard` loop trips, extract a deterministic, redacted 1-line lesson (e.g., command failed -> fix applied, or repeated failing target).
  3. Inject the top-K relevant memories (`<= 600` chars) before `input.prompt` via `promptPreamble` in `runEdits` (`src/edits.ts`) and `askClineWorkspace` (`src/workspace.ts`), accounting for `WINDOWS_COMMAND_LINE_LIMIT`.
  4. Add an opt-out or cap mechanism (`maxMemoryChars`, stale-entry eviction when referenced files are deleted/renamed) so memory never bloats prompts or injects stale facts.

### Phase 3 — Lifecycle Checkpoints & Typed Output Contracts (`src/trace.ts` + `src/finalcheck.ts` + `src/workspace.ts`)
- **Inspired by:** LangGraph (checkpointing) + Pydantic AI (output schema validation).
- **Concrete tasks:**
  1. Persist structured phase checkpoints (`snapshot`, `run`, `verify`, `waiting`, `restore`, `done`) with attempt deltas into the per-run trace folder (`src/trace.ts`) for rapid debugging of failed multi-file edits.
  2. Add an optional `outputSchema` / JSON-contract verification helper for `ask_cline_workspace` so Tier 1 orchestrators can request deterministic machine-readable localization reports without brittle regex parsing.

### Phase 4 (Optional) — Scoped Read-Only MCP Reference Servers for Cline (`src/settings.ts`)
- **Inspired by:** `modelcontextprotocol/servers`.
- **Concrete tasks:**
  1. Only if target projects require live database schema or external doc inspection during edits, support an allowlisted read-only MCP server profile injected safely under `acquireSettingsMutex` (`src/settings.ts`) and explicitly disabled in `ask_cline_workspace` write-prohibited runs.
