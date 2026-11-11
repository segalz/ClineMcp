# Stage 10 — Live results (2026-11-11/12)

Cline CLI 3.0.74, free model `cline-free/nemotron-3.5-super-vl`, thinking low, 300 s timeout, one attempt,
workspace mode on this repository at HEAD. Large run-to-run variance on the free model: read counts, not single runs.

- Task 1: list every export with its line number in `src/runner.ts`, `src/guard.ts`, `src/tasks.ts` (55 exports).
- Task 2: trace a guard trip in an async task through to the resume after `cline_send` (8 key facts).

## Delivery: `--system` vs instructions in the prompt (task 1, old instructions)

| Variant | Runs | Result |
|---|---|---|
| `--system` (today) | 2 | 55/55 and 54/55; 212-235 s; 95-98k input tokens |
| Prompt preamble, no `--system` | 2 | 52/55 (203 s, 84k); timeout |

Kept `--system`.

## Rules and map

| Variant | Task 1 | Task 2 |
|---|---|---|
| Today (no rules, no map) | 2/2 ok, ~223 s, ~96k | **0/2** (timeouts; 25 shell commands in one run) |
| Rules v1 ("read ranges") | timeout, 27 small reads, budget exceeded | — |
| Rules v1 + map | 55/55, 170 s, 258k | — |
| Map only | — | 0/2 (timeouts) |
| Rules v2 only | 1/2 (53/55, 126 s, 104k) | 1/2 (7/8, 189 s, 547k) |
| **Rules v2 + map** | 2/2 (55/55: 66 s / 30k; 300 s / 231k) | **3/3** (7/8 each; 148-259 s; 160-416k) |
| **Final code, real `askClineWorkspace` path** | — | **2/2** (8/8 in 133 s; 6/8 in 240 s) |
| Final code, edits mode (throwaway repo) | correct change, test passes, 121 s, 44k | — |

## What the traces showed

- Without an environment line Cline guessed `/home/user/workspace/...` and Unix `find`: the bridge's `--system`
  replaces Cline's default prompt, which carries the cwd and OS.
- Rules v1 ("locate, then read ranges") made Cline page through files in many small slices; each step resends
  the conversation, so tokens rose. Rules v2 say fewer, larger steps.
- The trace redacted numeric token counts (`inputTokens` matched `/token/`); fixed.
