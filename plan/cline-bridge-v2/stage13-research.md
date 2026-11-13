# Stage 13 research: what context to send delegated code models (2026-11-13)

Question from the owner: what should the orchestrator send with each delegated analysis
or edit task (code map, project file, per-file index), even at extra token cost? What
does recent research say about code maps and context in model orchestration?

Sources are mostly 2026 arXiv preprints, read from abstracts and result summaries, not
full methodology. Treat effect sizes as indicative.

## Findings

1. **Project overview files barely help.** Gloaguen et al. ("Evaluating AGENTS.md",
   ETH Zurich, 2026) found no significant gain in task success from context files and
   over 20% higher inference cost. LLM-generated files were slightly negative and
   developer-written ones slightly positive, neither significant. Overviews did not
   speed up finding the relevant code. They are useful only for non-standard practices
   (custom test commands, conventions). A two-agent ablation (2607.27250) agrees:
   context strategy did not move correctness.
2. **Natural-language summaries are a weak representation of code.** Sam-Bodden
   (2607.09691): on behavioural questions, file summaries answered 4/45 against 27/45
   for the source, whoever wrote the summary. UML skeletons of the rest of a file added
   nothing at edit time. Compressed raw code matched whole files at about a third of
   the tokens (19k vs 94k per resolved issue). Noise floor: 9% of outcomes flip between
   identical temperature-0 runs.
3. **Localization is the bottleneck, and structure helps small models most.**
   Pre-registered scale study (2610.33958): code-graph tools (definitions, references,
   calls) added 6-10 points of function Acc@10 and 13-18 points of file Acc@5 for
   models up to about 14B, with fewer steps and seconds than grep alone. The gain
   shrank to about 3 points at 32B. Static call/inheritance topology: +2.2 points
   Func@5 and 1.6 fewer rounds (2606.26979). LARGER (2605.16352): AST graph anchored
   on the agent's own lexical queries, up to +10 points file Acc@5. LocAgent (ACL 2025)
   is the graph-tool reference design.
4. **More context can hurt.** Long inputs degrade all tested models, and a single
   topically related distractor drops accuracy (Chroma 2025, 18 models). Code search is
   the worst case because it returns many similar-looking hits. Structural visual maps
   cut input tokens by up to 26% at equal accuracy (2606.14061).
5. **Orchestration practice (blogs and vendors, weak evidence):** compact structured
   handoffs, results as summaries rather than transcripts, a single writer, and
   per-worker budgets. This already matches our bridges (guard, lock, structured
   results).

## What this means for us

- Our Stage 10 result fits finding 3. Rules plus a code map took the weak free model
  from 0/2 to 5/5 on the hard task. Free models behave like the "small model" group,
  where structure pays most.
- The map costs the orchestrator nothing. The bridge builds it and inserts it into the
  delegated prompt, so the cost lands on the free model's tokens and not on Claude's.
  The real limits are the free model's context quality and the Windows 32,000-character
  command line.
- A whole-repo "what each file does" index in natural language is not supported by the
  evidence (findings 1 and 2), so it should not become the default.

## Recommendation for Stage 13 (to be planned and measured)

1. **Query-focused structural map (default candidate).** Replace the regex symbol list
   with definitions plus references and callers for the symbols and paths named in the
   prompt, ranked over the reference graph in the style of Aider's repo map, inside the
   existing 6,000-character budget. Both bridges share it.
2. **Structural lookup as a tool (A/B arm).** The 2610.33958 gains came from tools the
   model calls, not from a static map. Test a small read-only "definition / references"
   tool exposed to the models. First check whether Cline CLI and OpenCode can load an
   extra MCP server per run.
3. **Short project brief, non-standard facts only.** Test command, conventions, and
   places not to touch, at most about 1,000 characters. Never repeat the README.
   Optional, as one A/B arm.
4. **No natural-language per-file index by default.** Test it only as a measured arm,
   if at all.
5. **Orchestrator side:** answer pure lookups ("where is X defined", "who calls Y")
   deterministically, with no model call.
6. **Measurement:** the same task set as Stages 10-12 plus localization questions with
   known answers. At least 5 runs per arm because of the noise floor. Report success,
   time and tokens for the free model, and Claude-side tokens separately.

## Sources

- https://arxiv.org/abs/2602.11988 (Evaluating AGENTS.md)
- https://arxiv.org/html/2607.27250v1 (two-agent ablation of context files)
- https://arxiv.org/abs/2607.09691 (What context does a coding agent need to act)
- https://arxiv.org/html/2610.33958 (structural tools for small coding agents)
- https://arxiv.org/pdf/2606.26979 (static structure, deterministic anchoring)
- https://arxiv.org/pdf/2605.16352 (LARGER)
- https://arxiv.org/abs/2503.09089 (LocAgent)
- https://arxiv.org/html/2606.14061v3 (LLM agents can see code repositories)
- https://www.morphllm.com/context-rot (context rot summary, vendor)
- https://www.agentpatterns.ai/context-engineering/repository-map-pattern/ (repo map pattern)
- https://futureagi.com/blog/organizing-context-in-a-multi-agent-harness/ (handoff practice, blog)
