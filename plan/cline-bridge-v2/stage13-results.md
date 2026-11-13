# Stage 13 pilot results (13.P, 2026-11-13)

A0 = current regex map; A1 = codeindex structural map (`CODEINDEX_CLI`). Ten localization
questions with hand-checked answers (file + function) on this repository at 06f3ccc.

Setup:
- Cline: `ask_cline_workspace`, `cline-free/nemotron-3.5-super-vl`, thinking low.
- OpenCode: `analyze_code`, `opencode/glm-5.3-flash-free`.
- One paired run per question, arm and bridge (40 runs), with the arm order alternated.
- The codeindex cache was warm.
- `codeMapSource` confirmed the arm in every run.

| Bridge | Arm | Correct | Avg time | Avg input tokens | Avg tool calls |
|---|---|---|---|---|---|
| Cline | A0 regex | 10/10 | 24.0 s | 52,141 | 2.3 |
| Cline | A1 codeindex | 10/10 | 26.8 s | 35,294 | 2.0 |
| OpenCode | A0 regex | 10/10 | 25.8 s | 55,108 | 2.8 |
| OpenCode | A1 codeindex | 10/10 | 16.9 s | 35,328 | 1.8 |

## Reading

- **Accuracy:** at the ceiling for both arms. These questions are too easy to show an accuracy
  difference; a harder set is needed for that.
- **Cost:** input tokens fell by 32% on Cline and 36% on OpenCode.
  - The largest gains came on caller questions: q03 "who calls withCodeMap", q04, and q10 "who calls
    formatGuardContext". There the map already contains the answer; OpenCode q03 dropped from 133k
    tokens / 7 tools to 23k / 1.
- **Exceptions:** A1 cost more in three runs, Cline q09 and q02 and OpenCode q06, where the model
  explored anyway.
- **Time:** OpenCode was 35% faster. Cline's time did not change beyond noise.
- **Limits:** one run per cell, so this is exploratory. The noise floor was not measured.

## Decision (D-35 draft)

Go. A1 keeps accuracy and cuts free-model tokens by about a third. Next:
- make the codeindex map the default in both MCP configurations (`CODEINDEX_CLI`, after owner OK);
- a harder question set and the hard analysis task, 3 runs per cell, to test accuracy;
- arms B (tools) and C (brief) only if that shows a remaining localization gap.

# Hard set (13.P2, 2026-11-13)

Ten harder questions (`stage13-pilot/hardq.json`): multi-file flows, callers, lifecycle paths. Each
question has 2-4 expected items (identifier + file); the score is the fraction found. 3 runs per
question, arm and bridge, with the arm order alternated (`runhard.sh`, `scoreH.mjs`). Code at 96eeeb2.

| Bridge | Arm | Score | Avg time | Avg input tokens | Avg tool calls |
|---|---|---|---|---|---|
| Cline | A0 regex | 25.8/30 (1 run errored; 0.89 per valid run) | 52 s | 103,523 | 4.0 |
| Cline | A1 codeindex | 23.3/30 (0.78) | 52 s | 112,218 | 4.2 |
| OpenCode | both | invalid | - | - | - |

## Reading

- **OpenCode:** invalid. From h04 on, every run timed out at 240 s with 0 tokens. A probe of all 12 free
  OpenCode models at the same time also timed out, so this was a provider outage, not the map.
  The OpenCode half must be rerun when the service is back.
- **Cline accuracy:** no gain from A1. Per question A1 was higher on 2 (h02, h03), equal on 3 (h01, h04,
  h10) and lower on 5 (h05-h09). That split is not significant (sign test p ≈ 0.45), but there is no sign
  of an accuracy benefit either.
- **Cline cost:** the pilot's token saving disappears on hard questions (+8%, within noise: single runs
  range from 29k to 540k tokens). On hard questions the model explores anyway.
- **Why A1 lost on h05-h07:** the map's file ranking is weak for multi-step questions. For h05 (the
  model catalog) it does not surface `status.ts` (`resolveCatalogPath`), so the model followed the
  map's candidates to a neighbouring answer (`clistate.ts`). Some losses (h06 `editQuestion` in
  `edits.ts` versus the expected `parseQuestionFromText` in `tasks.ts`) are partly question ambiguity.

## Decision (D-35, updated)

- Keep codeindex as the default: it cuts about a third of the tokens on targeted questions (pilot) and
  costs nothing measurable on hard ones.
- It does not raise accuracy on hard questions. The bottleneck there is the map's ranking, not its
  format, so arms B (tools) and C (brief) would not address it.
- Next, if pursued: improve the query-to-file ranking in codeindex (for example, weight definitions over
  mentions) and rerun the hard set on both bridges once OpenCode is back.
