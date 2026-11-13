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
