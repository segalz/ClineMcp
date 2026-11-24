# ClineMcp — Linux port plan (branch `linux-support`)

Version 2, 2026-11-24. Written by Claude Opus 5.5 after reading the source. Reviewed by Grok 4.6 against the source (10 findings, all folded in). This file is public: it names no people or private infrastructure.

## 0. Roles

| Role | Who | Does |
|------|-----|------|
| Owner | repository owner | Approves pushes, keys, merges. Is the only one who merges to `main`. |
| Supervisor | **Grok Bot** (cloud agent on its own Linux VM) | Installs tools on its VM, applies the TEST steps, dispatches executors, runs the Linux check, commits and pushes on `linux-support`, watches CI, applies the retry and escalation rules, updates `progress.md`, reports each stage. |
| Executors | **Cline CLI** and **OpenCode CLI** with free models, on the supervisor's VM | Do the CODE steps only. Weak models: every step is small and self-contained. |
| CI | GitHub Actions, free for this public repo | Runs on every push to `linux-support`: `windows-latest`, `ubuntu-24.04`, `ubuntu-24.04-arm`. This is the Windows-regression and arm64 gate. |
| Planner / last resort | Claude (through the owner) | Wrote this plan. Fixes steps the free executors could not finish. Does the final review together with the supervisor. |

## 1. Context

- Stack: TypeScript (`src/*.ts`, tests `src/test/*.test.ts`), `tsc` builds to `dist/`.
  - All tests: `npm test`.
  - One file: `npm run build && node --test dist/test/<name>.test.js`.
- Targets: Windows (unchanged, all tests green), Linux x86_64 and Linux aarch64.
- **Key finding:** the code is already largely POSIX-aware. These exist already:
  - process groups (`detached: true` plus `kill(-pid)`);
  - the POSIX branch of `confirmTreeDead` (`src/proctree.ts`);
  - a unix-socket settings mutex (`src/settings.ts`);
  - `/proc` start times (`src/checkoutlock.ts`);
  - a POSIX branch in `resolveVerificationCommand` (`src/verify.ts`).

  Windows Job Objects (`src/jobobject.ts`) are Windows-only by design; process groups replace them. The real gaps are small (section 3).

## 2. Rules for every step

1. **One step = one function (or one new file).** The executor changes only "Files allowed".
2. **Locked files.** Executors never edit any of these:
   - `src/test/**`, `scripts/**`, `.github/**`;
   - `package.json`, `package-lock.json`, `tsconfig.json`, `.gitattributes`;
   - `plan/linux-port/plan.md`.

   `scripts/check-locked.sh` (run inside the Linux check) fails if any of them is modified or added. The supervisor may update `plan/linux-port/progress.md`, `baseline.md` and `discovery.md` at any time.
3. **Test first.** For each CODE step, the supervisor first applies the TEST step exactly as written, commits it (`linux-port: <id> test (red)`), and confirms it is RED with the step's Linux check. If it is unexpectedly green, stop and report: the step is wrong.
4. **Linux check** (supervisor VM): `bash scripts/linux-check.sh <dist test files>`. It runs `check-locked.sh`, deletes `dist`, rebuilds, and runs the listed tests. **Windows and arm64 check:** CI after the push.
5. **Windows must not regress.** All Linux behaviour sits behind a platform branch. The Windows branch of a function stays byte-for-byte unchanged unless a step says otherwise.
6. **Restore after a failed attempt:** `git reset --hard HEAD && git clean -fd` (the test and progress are already committed).
7. **Accept:** the Linux check is green → the supervisor reads the diff:
   - only "Files allowed" changed;
   - the Windows branch is untouched;
   - no new shell use.

   If all hold, it commits (`linux-port: <id> <summary>`) and pushes. If CI then fails on Windows or arm64, run `git revert --no-edit HEAD && git push`. That counts as a failed attempt; feed the CI log tail into the next attempt. Never force-push.
8. **Stop rule:** at most 3 attempts per CODE step, then escalate (section 6). Never weaken, skip, or edit a test to get green.
9. **Executors:** no git, no installs, no network. They never touch `main`.
10. **Secrets:** API keys live only in the supervisor VM's environment. Never in the repo, CI, logs, or reports.

### Executor command lines (supervisor VM, repo root as cwd)

- Cline: `cline --json --auto-approve true --thinking high --timeout 1500 -P <provider> -m <model> --cwd "$PWD" "$(cat /tmp/step.md)"`
- OpenCode: `opencode run -m <provider>/<model> "$(cat /tmp/step.md)"`
- Assignment: alternate executors by CODE step order (the first CODE step to Cline, the next to OpenCode, and so on). Attempts 2 and 3 use the same executor. Free models to try, in order:
  - Cline: its current free `cline-free/*` model (run `cline` model listing first);
  - OpenCode: `nvidia/nvidia/nemotron-3.5-super-vl-120b-a12b`, `nvidia/poolside/laguna-xs-2.1`, `opencode/deepseek-v4.1-flash-free`.

  Record the model used.

### `/tmp/step.md` template (supervisor fills `<...>`)

```
## Objective
<Goal>
## Files you may change
<exact list>. Do not create, rename or delete any other file.
## Current code
<quoted code with approximate line numbers>
## Required change
<Change spec, copied verbatim from the plan>
## Rules
- Never edit tests, scripts, .github, plan.md, package.json, package-lock.json, tsconfig.json.
- Keep the Windows branch byte-for-byte unchanged unless told otherwise.
- No git commands, no installs, no network.
- When done, stop. Do not run the whole test suite.
## Previous attempt failed (attempts 2-3 only)
<last 60 lines of the failing check or CI log>
## Output
## Result / ## Changes (exact paths) / ## Limitations
```

## 3. Gaps found in the source

| # | Gap | Where | Effect on Linux today |
|---|-----|-------|-----------------------|
| G1 | The Cline CLI entry is resolved only on Windows | `src/runner.ts` `resolveClineEntry` ~636-641 | `cline_list_models` fails (`catalog_unavailable`). There is no dedicated hub per run, so Cline resolves relative tool paths against the wrong folder. There is no "Cline updating" detection and no hub stop before updates. |
| G2 | The process list returns `[]` off Windows | `src/procs.ts` `listClineProcesses` ~10-11 | Stuck or leftover hub daemons cannot be found. |
| G3 | The hub-stop fallback scan runs only on Windows | `src/runner.ts` `stopDedicatedHub` ~749 | A hub whose `cline hub stop` failed is never killed. Existing test `plan-s20.test.ts` "Gate 6: a failed hub stop with an unreadable process list is not confirmed" fails on Linux today. |
| G4 | The Linux launch uses `cline` from PATH, not the resolved entry | `src/runner.ts` ~1047, ~1117-1119 | After G1, the CLI that runs and the catalog that is read can differ. |
| G5 | POSIX verify ignores the project-local `node_modules/.bin` | `src/verify.ts` ~40-46 | `verify: {command:"vitest"}` fails unless it is on PATH. Windows finds it. |
| G7 | The Linux OS line gives no shell guidance | `src/rules.ts` `buildEnvironmentLine` ~14-16 | Minor: the model may guess the shell. |
| G8 | Unknown until the baseline run | tests | Real Linux bugs the reading missed. |

**Known limitations (recorded, not fixed here):**
- A daemon that calls `setsid()` leaves our process group. G2 and G3 cover Cline hub daemons only.
- PID reuse between `/proc` listing and kill is a tiny window. The kill is a process-group kill.
- `normalizePathForMatch` (`src/workspace.ts` ~107) lower-cases on every OS. Worktree names are random and lower-case, so the risk is low. Changing it breaks `workspace-cleanup.test.ts` expectations, so it is left as is.
- The unix-socket path for the settings mutex is about 80 bytes, under the 108-byte limit.

Out of scope by design: `jobobject.ts`, the Windows command-line length checks, `.cmd` shim parsing, `codemap-kill.ts` Windows paths, and `ensureNeutralHub` (a Windows folder-lock workaround).

## 4. Stages and steps

Type: OWNER, SUP (supervisor), TEST (supervisor applies a failing test), CODE (executor). Risk: low/med/high.

---

### Stage 0 — Setup and baseline

**S0.1 · OWNER · Approve.** Push the `linux-support` branch to GitHub (a public repo; this file was written for that) and let Grok Bot work on it. Done 2026-11-24.

**S0.2 · Claude (one time, before handing over) · Check scripts and CI.** Risk low. After this step the files below are locked.
- `.gitattributes`:
  ```
  *.sh text eol=lf
  ```
- `scripts/check-locked.sh`:
  ```bash
  #!/usr/bin/env bash
  set -euo pipefail
  cd "$(dirname "$0")/.."
  [ "$(git rev-parse --abbrev-ref HEAD)" = "linux-support" ] || { echo "check-locked: not on linux-support" >&2; exit 2; }
  bad=$(git status --porcelain --untracked-files=all | cut -c4- \
    | grep -E '^(src/test/|scripts/|\.github/|package\.json$|package-lock\.json$|tsconfig\.json$|\.gitattributes$|plan/linux-port/plan\.md$)' || true)
  if [ -n "$bad" ]; then echo "check-locked: locked files changed:" >&2; echo "$bad" >&2; exit 3; fi
  ```
- `scripts/linux-check.sh`:
  ```bash
  #!/usr/bin/env bash
  # Usage: bash scripts/linux-check.sh [dist/test/<name>.test.js ...]   (no args = whole suite)
  set -euo pipefail
  cd "$(dirname "$0")/.."
  bash scripts/check-locked.sh
  rm -rf dist
  npm run build
  if [ "$#" -gt 0 ]; then node --test "$@"; else node --test "dist/test/**/*.test.js"; fi
  ```
- `.github/workflows/linux-port.yml`:
  ```yaml
  name: linux-port
  on:
    push:
      branches: [linux-support]
    workflow_dispatch:
  permissions:
    contents: read
  jobs:
    test:
      strategy:
        fail-fast: false
        matrix:
          os: [windows-latest, ubuntu-24.04, ubuntu-24.04-arm]
      runs-on: ${{ matrix.os }}
      timeout-minutes: 30
      steps:
        - uses: actions/checkout@v4
        - uses: actions/setup-node@v4
          with:
            node-version: 22
            cache: npm
        - run: git config --global user.email ci@example.invalid && git config --global user.name ci
        - run: npm ci
        - run: npm test
  ```
Done when: committed on `linux-support` and pushed (after S0.1), and the first CI run has finished. Red jobs are expected and recorded in S0.4. Grok Bot takes over from S0.3.

**S0.3 · SUP · Prepare the VM and free-model access (the supervisor does this itself).**
- Install Node 22 (nvm), `git` and `build-essential`.
- Clone the repo and run `git checkout linux-support`, then `npm ci`.
- Install the CLIs: `npm install -g cline opencode-ai`.
- Set up free-model access yourself:
  1. Start with what needs no secret: OpenCode's free models (`opencode models`, ids ending in `-free`) and Cline's free models (its own model listing).
  2. If a provider needs a login or a key (for example a Cline account device login, or `NVIDIA_API_KEY` from build.nvidia.com), ask the owner either to approve the login or to put the key into your environment's secret store. Never ask for a key in chat. Never write keys to the repo, CI, logs or reports.
  3. Prove that each executor works with one tiny prompt in a scratch folder (not the repo).
  4. Record the working model ids (names only, never keys) in `plan/linux-port/discovery.md`.

Done when `node -v` shows v22 and at least one free model answers through `cline` and one through `opencode`.

**S0.4 · SUP · Baseline.** Risk med.
- Run `bash scripts/linux-check.sh` (whole suite) on the VM, and read the first CI run.
- Write `plan/linux-port/baseline.md`. For every failing test (Linux VM, CI ubuntu, CI arm, CI windows) give the file, the test name, the first error line, and a class:
  - (a) Windows-only behaviour without a skip;
  - (b) a real Linux bug;
  - (c) environment (a missing tool, CI-only).
- Known class (b) already: `plan-s20.test.ts` "Gate 6: a failed hub stop with an unreadable process list is not confirmed". It is G3 and is fixed by Stage 4; do not skip it.
- GATE: CI `windows-latest` must be green, apart from class (c) items explained in the baseline. Otherwise stop and report to the owner.

**S0.5 · SUP · Discovery of the Linux Cline install.** Risk med. Write `plan/linux-port/discovery.md`:
- `npm root -g`, `readlink -f "$(command -v cline)"`, and the first 200 bytes of that file: a JS launcher (`#!/usr/bin/env node` or JS) or a native binary?
- Whether `$(npm root -g)/cline/node_modules/@cline/llms/dist/index.js` exists.
- Start a hub the way the bridge does:
  - `CLINE_HUB_PORT=<free port> CLINE_HUB_DISCOVERY_PATH=/tmp/h.json node <entry> hub start`, or one trivial `cline` task;
  - record `ps -eo pid,ppid,pgid,sid,args | grep -i cline`: the daemon argv, and whether its SID differs from its parent's;
  - then run `node <entry> hub stop`.

GATES:
- Stage 2 runs as written only if the entry is a **JS launcher** at `<prefix>/lib/node_modules/cline/bin/cline`. Otherwise stop and ask Claude for a redesign (escalation level 3) before Stage 2.
- Stages 3 and 4 run as written only if the daemon argv contains `--cline-hub-daemon`, `--cwd <dir>` and `--port <n>`.

---

### Stage 1 — Test hygiene (supervisor only)

**S1.1 · SUP.** For each class (a) test, add `{ skip: process.platform !== "win32" && "Windows-only: <reason>" }`. Never skip a class (b) test. Commit and push. Done when Linux failures are class (b) only.

---

### Stage 2 — Find the Cline CLI on Linux (G1, G4)

**S2.1 · TEST · `resolveClineEntry` options.** Risk low. New file `src/test/linux-entry.test.ts`:
```ts
import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { resolveClineEntry } from "../runner.js";

test("explicit entryPath always wins", () => {
  assert.equal(resolveClineEntry("/x/cline", { platform: "linux", env: {}, exists: () => false }), "/x/cline");
});
test("CLINE_MCP_CLINE_ENTRY overrides discovery without probing", () => {
  assert.equal(resolveClineEntry(undefined, { platform: "linux", env: { CLINE_MCP_CLINE_ENTRY: "/opt/c/bin/cline" },
    exists: () => { throw new Error("must not probe"); } }), "/opt/c/bin/cline");
});
test("linux: global npm install next to the running node", () => {
  const execPath = "/home/u/.nvm/versions/node/v22.11.0/bin/node";
  const expected = "/home/u/.nvm/versions/node/v22.11.0/lib/node_modules/cline/bin/cline";
  assert.equal(resolveClineEntry(undefined, { platform: "linux", env: { PATH: "/usr/bin" }, execPath,
    exists: p => p === expected, realpath: p => p }), expected);
});
test("linux: a cline on PATH that resolves into an npm install", () => {
  const link = "/usr/local/bin/cline", real = "/usr/local/lib/node_modules/cline/bin/cline";
  assert.equal(resolveClineEntry(undefined, { platform: "linux", env: { PATH: "/usr/bin:/usr/local/bin" }, execPath: "/usr/bin/node",
    exists: p => p === link || p === real, realpath: p => (p === link ? real : p) }), real);
});
test("linux: a cline on PATH outside an npm install is ignored", () => {
  assert.equal(resolveClineEntry(undefined, { platform: "linux", env: { PATH: "/usr/bin" }, execPath: "/usr/bin/node",
    exists: p => p === "/usr/bin/cline", realpath: p => p }), undefined);
});
test("linux: nothing found", () => {
  assert.equal(resolveClineEntry(undefined, { platform: "linux", env: { PATH: "/usr/bin" }, execPath: "/usr/bin/node",
    exists: () => false, realpath: p => p }), undefined);
});
test("win32 is unchanged", () => {
  const appdata = "C:\\Users\\u\\AppData\\Roaming";
  assert.equal(resolveClineEntry(undefined, { platform: "win32", env: { APPDATA: appdata } }),
    path.win32.join(appdata, "npm", "node_modules", "cline", "bin", "cline"));
  assert.equal(resolveClineEntry(undefined, { platform: "win32", env: {} }), undefined);
});
```
RED on every platform: the second argument does not exist yet, so `tsc` fails. Linux check: `bash scripts/linux-check.sh dist/test/linux-entry.test.js`.

**S2.2 · CODE · Linux discovery in `resolveClineEntry`.** Risk med. Only after the S0.5 gate (JS launcher).
Files allowed: `src/runner.ts`, and only the function `resolveClineEntry` plus one new import line.
Current code (~636-641):
```ts
export function resolveClineEntry(entryPath?: string): string | undefined {
  if (entryPath !== undefined) return entryPath;
  return process.platform === "win32" && process.env.APPDATA
    ? path.join(process.env.APPDATA, "npm", "node_modules", "cline", "bin", "cline")
    : undefined;
}
```
Required change:
- Add `import { existsSync, realpathSync } from "node:fs";` next to the other imports.
- Just above the function, add:
  ```ts
  export interface ResolveEntryOptions { platform?: NodeJS.Platform; env?: NodeJS.ProcessEnv; execPath?: string;
    exists?: (p: string) => boolean; realpath?: (p: string) => string }
  ```
- New signature: `export function resolveClineEntry(entryPath?: string, opts: ResolveEntryOptions = {}): string | undefined`. Inside, take `platform`, `env`, `execPath`, `exists` and `realpath` from `opts`, with defaults `process.platform`, `process.env`, `process.execPath`, `existsSync` and `realpathSync`.
- Order:
  1. If `entryPath !== undefined`, return it.
  2. If `env.CLINE_MCP_CLINE_ENTRY` is a non-empty string, return it (no probing).
  3. If `platform === "win32"`, return `env.APPDATA ? path.win32.join(env.APPDATA, "npm", "node_modules", "cline", "bin", "cline") : undefined`.
  4. Using `path.posix`: `const a = path.posix.join(path.posix.dirname(path.posix.dirname(execPath)), "lib", "node_modules", "cline", "bin", "cline"); if (exists(a)) return a;`
  5. For each `dir` of `(env.PATH ?? "").split(":")` that is non-empty:
     - `const c = path.posix.join(dir, "cline");`
     - if `exists(c)`, get `const r = realpath(c)` inside try/catch (on a throw, `continue`);
     - if `r.endsWith("/node_modules/cline/bin/cline")`, return `r`.
  6. Return `undefined`.

Callers stay as they are: the second parameter is optional.

Side effect to expect (correct, not a bug): on Linux the dedicated per-run hub (`dedicatedHub`, ~775-806) and `stopClineHub` (`src/clistate.ts` ~658-667) now start working. Do not change them.

Linux check: `bash scripts/linux-check.sh dist/test/linux-entry.test.js dist/test/models.test.js dist/test/runner.test.js`.

**S2.3 · TEST · The Linux launch uses `node <entry>`.** Risk med. New file `src/test/linux-launch.test.ts`. It does NOT use `deps.entryPath`, because `entryPath` already forces `node <entry>` and would make the test green too early.
```ts
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runCline } from "../runner.js";

test("linux: a resolved entry is launched as `node <entry>`", { skip: process.platform === "win32" && "Linux behaviour" }, async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "linux-launch-"));
  const entry = path.join(dir, "cline");
  await writeFile(entry, "// fake entry\n");
  const saved = process.env.CLINE_MCP_CLINE_ENTRY;
  process.env.CLINE_MCP_CLINE_ENTRY = entry;
  const seen: Array<{ file: string; argv: string[] }> = [];
  const fakeSpawn = (file: string, argv: string[]) => {
    seen.push({ file, argv });
    const child = new EventEmitter() as any;
    child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
    child.stdout.destroy = () => {}; child.stderr.destroy = () => {};
    child.kill = () => true;
    queueMicrotask(() => {
      child.stdout.emit("data", Buffer.from(JSON.stringify({ type: "run_result", finishReason: "completed", text: "ok", model: "m" }) + "\n"));
      child.emit("exit", 0, null);
      child.emit("close", 0, null);
    });
    return child;
  };
  try {
    const result = await runCline({ provider: "p", model: "m", prompt: "hi" }, undefined,
      { deps: { spawn: fakeSpawn as any, access: async () => {}, backoffMs: 0, statusPath: null } });
    assert.equal(result.text, "ok");
    assert.equal(seen.length, 1);
    assert.equal(seen[0].file, process.execPath);
    assert.equal(seen[0].argv[0], entry);
  } finally {
    if (saved === undefined) delete process.env.CLINE_MCP_CLINE_ENTRY; else process.env.CLINE_MCP_CLINE_ENTRY = saved;
  }
});
```
RED on Linux: today it spawns `cline` with no entry. Skipped on Windows. If the test is RED for a different reason (for example an error about the fake child), the supervisor fixes only the fake, modelled on `createMockChild` in `src/test/runner.test.ts` ~33-60, and re-confirms RED for the right reason: `seen[0].file === "cline"`.

**S2.4 · CODE · Launch `node <entry>` whenever an entry is known.** Risk low. Files allowed: `src/runner.ts`, two statements only.
Current code (~1047 and ~1117-1119):
```ts
const executable = (process.platform === "win32" || deps.entryPath) ? process.execPath : "cline";
...
const spawnArgs = (process.platform === "win32" || deps.entryPath) && windowsEntry
  ? [windowsEntry, ...args]
  : args;
```
Required change:
- `const executable = windowsEntry ? process.execPath : "cline";`
- `const spawnArgs = windowsEntry ? [windowsEntry, ...args] : args;`

On Windows `windowsEntry` is always set (otherwise the run already threw at ~1043), so Windows behaviour is identical. Do not touch anything else.
Linux check: `bash scripts/linux-check.sh dist/test/linux-launch.test.js dist/test/runner.test.js`.

---

### Stage 3 — List Cline processes on Linux (G2), in two small steps

**S3.1 · TEST · Pure `/proc` helpers.** Risk low. New file `src/test/linux-procs-parse.test.ts`:
```ts
import assert from "node:assert/strict";
import test from "node:test";
import { formatCommandLine, parseProcStatusUid } from "../procs.js";

test("formatCommandLine joins NUL-separated argv and quotes args with whitespace", () => {
  assert.equal(formatCommandLine("node\0/x/cline/bin/cline\0--cline-hub-daemon\0--cwd\0/tmp/my dir\0--port\0123\0"),
    'node /x/cline/bin/cline --cline-hub-daemon --cwd "/tmp/my dir" --port 123');
  assert.equal(formatCommandLine(""), "");
  assert.equal(formatCommandLine("a\0\0b\0"), "a b");
});
test("parseProcStatusUid reads the real uid", () => {
  assert.equal(parseProcStatusUid("Name:\tnode\nUid:\t1000\t1000\t1000\t1000\nGid:\t1000\n"), 1000);
  assert.equal(parseProcStatusUid("Name:\tx\n"), undefined);
});
```
RED: the exports do not exist (tsc fails).

**S3.2 · CODE · Add the two pure helpers.** Risk low. Files allowed: `src/procs.ts` (add two exported functions at the end; change nothing else).
- `export function formatCommandLine(raw: string): string`: split `raw` on `"\0"`, drop empty parts, wrap a part in double quotes when it matches `/\s/`, join with `" "`.
- `export function parseProcStatusUid(status: string): number | undefined`: match `/^Uid:\s+(\d+)/m` and return `Number(group 1)`, or `undefined` when there is no match.

Linux check: `bash scripts/linux-check.sh dist/test/linux-procs-parse.test.js`.

**S3.3 · TEST · Linux listing with injectable deps.** Risk med. New file `src/test/linux-procs.test.ts`:
```ts
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import test from "node:test";
import { hubDaemonPidsOnPort, listClineProcesses } from "../procs.js";
import { hubDaemonPidsFor } from "../workspace.js";

const files: Record<string, string> = {
  "/proc/42/cmdline": "node\0/x/cline/bin/cline\0--cline-hub-daemon\0--cwd\0/tmp/my dir\0--port\0123\0",
  "/proc/42/status": "Name:\tnode\nUid:\t1000\t1000\t1000\t1000\n",
  "/proc/43/cmdline": "node\0/x/cline/bin/cline\0--cline-hub-daemon\0--port\0124\0",
  "/proc/43/status": "Name:\tnode\nUid:\t0\t0\t0\t0\n",
  "/proc/1/cmdline": "/sbin/init\0",
  "/proc/1/status": "Name:\tinit\nUid:\t0\t0\t0\t0\n"
};
const readFile = async (file: string) => {
  if (file in files) return files[file];
  throw Object.assign(new Error("gone"), { code: "ENOENT" });
};

test("linux listing: own-user cline processes only, quoted cwd", async () => {
  const list = await listClineProcesses(5000, undefined, { platform: "linux", selfPid: 7, uid: 1000,
    readdir: async () => ["1", "7", "42", "43", "self", "abc", "99"], readFile });
  assert.deepEqual(list, [{ pid: 42, commandLine: 'node /x/cline/bin/cline --cline-hub-daemon --cwd "/tmp/my dir" --port 123' }]);
  assert.deepEqual(hubDaemonPidsOnPort(123, list!), [42]);
  assert.deepEqual(hubDaemonPidsFor("/tmp/my dir", list!), [42]);
});
test("linux listing: unreadable /proc or no time left is unknown (undefined)", async () => {
  assert.equal(await listClineProcesses(5000, undefined, { platform: "linux", readdir: async () => { throw new Error("EACCES"); }, readFile }), undefined);
  assert.equal(await listClineProcesses(0, undefined, { platform: "linux", readdir: async () => [], readFile }), undefined);
});
test("darwin stays an empty list", async () => {
  assert.deepEqual(await listClineProcesses(5000, undefined, { platform: "darwin" }), []);
});
test("linux real /proc: a live process with a hub-like argv is listed", { skip: process.platform !== "linux" && "Linux only" }, async () => {
  const child = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)", "--", "--cline-hub-daemon", "--cwd", "/tmp/x", "--port", "54321"], { stdio: "ignore" });
  await new Promise<void>((resolve, reject) => { child.once("spawn", () => resolve()); child.once("error", reject); });
  try {
    let pids: number[] = [];
    for (let i = 0; i < 20 && pids.length === 0; i++) {
      pids = hubDaemonPidsOnPort(54321, (await listClineProcesses()) ?? []);
      if (pids.length === 0) await new Promise(r => setTimeout(r, 100));
    }
    assert.deepEqual(pids, [child.pid]);
  } finally { child.kill("SIGKILL"); }
});
```
RED: the third parameter does not exist (`tsc`: expected 0-2 arguments). On Linux, `[]` is returned today.

**S3.4 · CODE · The Linux branch of `listClineProcesses`.** Risk med. Files allowed: `src/procs.ts`.
Current code (~9-11):
```ts
/** Lists cline.exe processes with their command lines (Windows only; empty elsewhere). Undefined when the list could not be read. */
export async function listClineProcesses(timeoutMs = PROCESS_TABLE_TIMEOUT_MS, signal?: AbortSignal): Promise<ProcessInfo[] | undefined> {
  if (process.platform !== "win32") return [];
```
Required change:
1. Add the exported interface:
   ```ts
   export interface ProcListDeps {
     platform?: NodeJS.Platform;
     readdir?: (dir: string) => Promise<string[]>;
     readFile?: (file: string) => Promise<string>;
     uid?: number;
     selfPid?: number;
   }
   ```
2. New signature, with a **3rd** parameter: `listClineProcesses(timeoutMs = PROCESS_TABLE_TIMEOUT_MS, signal?: AbortSignal, deps: ProcListDeps = {})`.
3. Replace the line `if (process.platform !== "win32") return [];` with:
   ```ts
   const platform = deps.platform ?? process.platform;
   if (platform === "linux") return listLinuxClineProcesses(timeoutMs, signal, deps);
   if (platform !== "win32") return [];
   ```
   The Windows code below it stays unchanged.
4. Add a non-exported `async function listLinuxClineProcesses(timeoutMs, signal, deps): Promise<ProcessInfo[] | undefined>`:
   - If `timeoutMs <= 0` or `signal?.aborted`, return `undefined`.
   - Use `readdir = deps.readdir ?? (d => fs.promises.readdir(d))` and `readFile = deps.readFile ?? (f => fs.promises.readFile(f, "utf8"))`. Import `{ readdir, readFile }` from `"node:fs/promises"`.
   - Set `uid = deps.uid ?? process.getuid?.()` and `selfPid = deps.selfPid ?? process.pid`.
   - Race the work against a timer of `Math.min(PROCESS_TABLE_TIMEOUT_MS, timeoutMs)` ms and the abort signal. A timeout or abort returns `undefined`. Clear the timer and remove the listener at the end.
   - Work:
     - `let names: string[]; try { names = await readdir("/proc"); } catch { return undefined; }`
     - For each name matching `/^\d+$/` whose `Number(name) !== selfPid`:
       - read `/proc/<pid>/cmdline` (on error, `continue`);
       - `const line = formatCommandLine(raw)`; if it is empty or does not include `"cline"`, `continue`;
       - if `uid !== undefined`, read `/proc/<pid>/status` (on error, `continue`) and skip when `parseProcStatusUid(status) !== uid`;
       - push `{ pid: Number(name), commandLine: line }`.
     - Return the list sorted by pid.

Linux check: `bash scripts/linux-check.sh dist/test/linux-procs.test.js dist/test/linux-procs-parse.test.js dist/test/workspace-cleanup.test.js`.

---

### Stage 4 — Kill a stuck hub on Linux (G3)

**S4.1 · TEST · Hub-stop fallback on Linux.** Risk low. The supervisor does all of this in one commit:
1. New file `src/test/linux-hubstop.test.ts`:
   ```ts
   import assert from "node:assert/strict";
   import test from "node:test";
   import { stopDedicatedHub } from "../runner.js";

   test("a failed hub stop falls back to the process scan and kills the daemon (Windows and Linux)",
     { skip: process.platform !== "win32" && process.platform !== "linux" && "win32/linux only" }, async () => {
     const killed: number[] = [];
     const result = await stopDedicatedHub(4555, {
       hubStarted: async () => true,
       isListening: async () => killed.length === 0,
       runHubStop: async () => false,
       listProcesses: async () => [{ pid: 9001, commandLine: "cline --cline-hub-daemon --cwd /w --port 4555" }],
       killTree: async (pid: number) => { killed.push(pid); return true; },
       removeFiles: async () => {}
     });
     assert.deepEqual(killed, [9001]);
     assert.equal(result, undefined);
   });
   ```
2. `src/test/plan-s6-retry-hub.test.ts` (~115): change `stillListening && process.platform === "win32"` to `stillListening && (process.platform === "win32" || process.platform === "linux")`.
3. `src/test/plan-s6b-review-fixes.test.ts` (~142) and `src/test/plan-s20-extra.test.ts` (~100): change `{ skip: process.platform !== "win32" }` to `{ skip: process.platform !== "win32" && process.platform !== "linux" }`.

RED on Linux: the new test, the three edited tests, and the existing `plan-s20.test.ts` Gate 6 test. Green on Windows.

**S4.2 · CODE · Enable the fallback on Linux.** Risk low. Files allowed: `src/runner.ts`, one line.
Current code (~749): `if (process.platform === "win32") {`. Change it to `if (process.platform === "win32" || process.platform === "linux") {`. Nothing else.
Linux check: `bash scripts/linux-check.sh dist/test/linux-hubstop.test.js dist/test/plan-s6-retry-hub.test.js dist/test/plan-s6b-review-fixes.test.js dist/test/plan-s20.test.js dist/test/plan-s20-extra.test.js`.

---

### Stage 5 — Verify finds project-local tools on Linux (G5)

**S5.1 · TEST.** Risk low. New file `src/test/linux-verify-bin.test.ts`:
```ts
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { resolveVerificationCommand } from "../verify.js";

test("posix: a bare tool resolves to the nearest node_modules/.bin, PATH still works", { skip: process.platform === "win32" && "POSIX behaviour" }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "verify-bin-"));
  const bin = path.join(root, "node_modules", ".bin");
  const pathDir = path.join(root, "pathdir");
  await mkdir(path.join(root, ".git"));
  await mkdir(bin, { recursive: true });
  await mkdir(path.join(root, "pkg", "sub"), { recursive: true });
  await mkdir(pathDir);
  await writeFile(path.join(bin, "mytool"), "#!/bin/sh\nexit 0\n"); await chmod(path.join(bin, "mytool"), 0o755);
  await writeFile(path.join(bin, "plain"), "#!/bin/sh\nexit 0\n"); await chmod(path.join(bin, "plain"), 0o644);
  await writeFile(path.join(pathDir, "pathtool"), "#!/bin/sh\nexit 0\n"); await chmod(path.join(pathDir, "pathtool"), 0o755);
  const savedPath = process.env.PATH;
  process.env.PATH = pathDir;
  try {
    assert.deepEqual(await resolveVerificationCommand("mytool", ["a"], path.join(root, "pkg", "sub")),
      { command: path.join(bin, "mytool"), args: ["a"] });
    assert.deepEqual(await resolveVerificationCommand("pathtool", [], root), { command: "pathtool", args: [] });
    await assert.rejects(resolveVerificationCommand("plain", [], root), (e: any) => e?.kind === "verification_launch_failed");
    await assert.rejects(resolveVerificationCommand("nosuchtool-xyz", [], root), (e: any) => e?.kind === "verification_launch_failed");
  } finally { process.env.PATH = savedPath; }
});
```
RED on Linux: `mytool` is not on PATH today. Skipped on Windows.

**S5.2 · CODE.** Risk low. Files allowed: `src/verify.ts`, only inside the POSIX branch of `resolveVerificationCommand`.
Current code (~40-46):
```ts
  if (process.platform !== "win32") {
    // POSIX spawns resolve through PATH; check that the target is a runnable file so directories or non-executables are refused up front.
    const found = hasDirectory ? await isRunnablePosix(path.resolve(cwd, command))
      : (await Promise.all(pathDirectories().map(dir => isRunnablePosix(path.join(dir, command))))).some(Boolean);
    if (!found) throw new VerificationError("verification_launch_failed", "Verification executable was not found on PATH.");
    return { command, args };
  }
```
Required change: insert these lines directly after the opening `if (process.platform !== "win32") {` and its comment, before `const found`:
```ts
    if (bare) {
      for (let dir = path.resolve(cwd); ; dir = path.dirname(dir)) {
        const local = path.join(dir, "node_modules", ".bin", command);
        if (await isRunnablePosix(local)) return { command: local, args };
        if (path.dirname(dir) === dir || await exists(path.join(dir, ".git"))) break;
      }
    }
```
Nothing else changes: no `.cmd`, and no edits to the Windows code below.
Linux check: `bash scripts/linux-check.sh dist/test/linux-verify-bin.test.js dist/test/verify.test.js`.

---

### Stage 6 — Linux environment line (G7)

**S6.1 · TEST.** Risk low. The supervisor does both of these in one commit:
1. `src/test/rules.test.ts` (~42-43): change the two expected strings to:
   ```ts
   assert.equal(build(cwd, "linux"), environment + "The OS is Linux. Shell commands run in bash with the working directory already set: do not cd.\n" + modeText);
   assert.equal(build(cwd, "darwin"), environment + "The OS is darwin. Shell commands run in bash with the working directory already set: do not cd.\n" + modeText);
   ```
2. Keep the Windows assertion as it is.

RED on every platform (the strings do not match today).

**S6.2 · CODE.** Risk low. Files allowed: `src/rules.ts`, the non-Windows text only.
Current code (~14-16):
```ts
  const os = platform === "win32"
    ? "The OS is Windows. ...(unchanged)..."
    : `The OS is ${platform}.`;
```
Required change: replace only the last line with:
```ts
    : `The OS is ${platform === "linux" ? "Linux" : platform}. Shell commands run in bash with the working directory already set: do not cd.`;
```
Linux check: `bash scripts/linux-check.sh dist/test/rules.test.js`.

---

### Stage 7 — Baseline leftovers

**S7.x · TEST/CODE pairs**, written by the supervisor from the class (b) items of S0.4:
- use the same format;
- one failing test per item;
- one CODE step limited to one function.

If an item needs more than one function, split it. Items about process killing or timing are high risk: send them to Claude (escalation level 3) unless they are one-liners.

---

### Stage 8 — Full green

**S8.1 · SUP.** `bash scripts/linux-check.sh` (whole suite) is green twice in a row on the VM, and CI is green on all three jobs. Flaky tests go back to Stage 7.
**S8.2 · SUP.** A self-review of `git diff main...linux-support` covering:
- Windows branches really unchanged;
- no new shell use;
- `/proc` parsing robust to races;
- never touching other users' processes.

Post the review to the owner, who forwards it to Claude for a second review.

---

### Stage 9 — End-to-end with a real Linux Cline on the VM (HIGH risk)

**S9.1 · SUP.** Write `scripts/linux-smoke.mjs`, an MCP SDK stdio client. It starts `node dist/index.js` and calls, in order:
1. `cline_ping`;
2. `cline_list_models`, which must list free models (proves G1);
3. `ask_cline` (no repo);
4. `ask_cline_workspace` on a fresh temp git repo with one file. It must answer, and its worktree folder under `path.join(os.tmpdir(), "cline-mcp-worktrees")` must be gone afterwards;
5. `apply_cline_edits` on a temp repo, "add the word hello to README.md", with `verify: { command: "node", args: ["-e", "process.exit(require('fs').readFileSync('README.md','utf8').includes('hello')?0:1)"] }`.

After each call, the count of processes whose argv contains `--cline-hub-daemon` must return to its value before the call (no leaked hubs). The smoke uses the free model access of the VM. It is never run in CI (no secrets in CI).

**S9.2 · SUP.** Every failure becomes a Stage 7 pair. Done when the smoke passes twice in a row.

---

### Stage 10 — Real arm64 server (deferred until the owner's ARM64 server exists)

CI already covers arm64 unit tests (`ubuntu-24.04-arm`). This stage runs the S9 smoke once on the real server, through the owner's own channel. The supervisor gets no direct access.

### Stage 11 — Merge decision (OWNER)

The owner gets:
- the diff summary;
- the experiment numbers (section 7);
- the supervisor's and Claude's reviews.

Merge to `main` only on the owner's explicit yes.

## 5. Order

S0.1 → S0.2 → S0.3 → S0.4 → S0.5 → S1 → S2 → S3 → S4 → S5 → S6 → S7 → S8 → S9 → S10 → S11. Stages 5 and 6 do not depend on S0.5.

## 6. Escalation ladder

1. **Attempts 1-3:** the same executor and step text, adding the failure tail.
2. **The supervisor rewrites or splits the step**: a clearer change spec, or smaller steps. It keeps the same tests and runs up to 3 more attempts.
3. **Report to the owner**, who sends the step to Claude. Claude implements it by hand. Record "escalated: claude".

Never: edit a test to pass, skip a class (b) test, or change the Windows branch to make Linux pass.

## 7. Experiment log

For every CODE step, `progress.md` records:
- executor and model;
- attempts;
- first-try pass (y/n);
- escalation level (none / supervisor / claude);
- minutes;
- CI reverts;
- whether review fixes were needed.

The final report answers: what share of steps the free executors finished alone, and which kinds of steps failed.
