# ClineMcp Linux port — discovery (S0.3 / S0.5)

Supervisor VM: Linux x86_64 (Debian 13), 2026-11-24. Names and ids only; no keys.

## S0.3 — VM and free-model access

- Node: `v22.23.5` (nvm), npm `10.9.9`; `git`, `build-essential` installed.
- npm global prefix on this VM: `/home/box/.local` (set by `NPM_CONFIG_PREFIX`), so `npm root -g` = `/home/box/.local/lib/node_modules`.
- `cline` 3.0.75, `opencode-ai` 1.19.6 (`npm install -g cline opencode-ai`).

### Working free models (no secret)

| Executor | Model id | Proof |
|----------|----------|-------|
| OpenCode | `opencode/deepseek-v4.1-flash-free` | `opencode run -m opencode/deepseek-v4.1-flash-free "Reply with exactly the word PONG…"` → `PONG` (scratch folder, not the repo) |
| Cline | — none yet — | see below |

### Cline: no free model works without a login or key (BLOCKED, owner decision needed)

- `cline -P cline -m cline-free/nemotron-3.5-super-vl …` → `Unauthorized: … re-authenticate your Cline account` (`errorClass: auth`). The `cline-free/*` models need a Cline account device login.
- `cline -P opencode -m deepseek-v4.1-flash-free` reaches the model without a key, but this provider is the OpenCode SDK runtime: "Custom tool definitions are ignored. OpenCode executes tools server-side." The run then failed (`SonicBoom destroyed`). Not a usable Cline executor.
- OpenCode's free models refuse other clients: through Cline's OpenAI-compatible provider the endpoint answers "Free usage limit reached. Free models work in OpenCode". Not used further; that config was removed.
- OpenCode's `nvidia/*` models from the plan's list are not available without `NVIDIA_API_KEY` (`opencode models` lists no `nvidia/` provider).

Options for the owner (either one unblocks Cline):
1. Approve a Cline account device login on the supervisor VM → `cline-free/*` models.
2. Put `NVIDIA_API_KEY` (build.nvidia.com, free tier) into the supervisor's secret store → Cline `-P nvidia` and OpenCode `nvidia/*` models.

## S0.5 — Discovery of the Linux Cline install

- `npm root -g` → `/home/box/.local/lib/node_modules`
- `readlink -f "$(command -v cline)"` → `/home/box/.local/lib/node_modules/cline/bin/cline`
- First 200 bytes: `#!/usr/bin/env node` + `// Binary resolver for Cline CLI. … finds the correct platform-specific compiled binary to execute.` → **JS launcher**.
  - It `spawnSync`s a native ELF binary (`@cline/cli-linux-x64`, hard-linked by postinstall to `cline/bin/.cline`, ~165 MB). During a task the tree is `node bin/cline` → `bin/.cline`.
- `$(npm root -g)/cline/node_modules/@cline/llms/dist/index.js` → **exists**.
- Hub: `CLINE_HUB_PORT=<free port> CLINE_HUB_DISCOVERY_PATH=/tmp/h.json node <entry> hub start` → printed `ws://127.0.0.1:<port>/hub`, exit 0; discovery file written (`hubId`, `protocolVersion v1`, capabilities).
- `ps -eo pid,ppid,pgid,sid,args` while the hub ran:
  ```
  PID     PPID  PGID    SID     ARGS
  555889  53    555889  555889  /home/box/.local/lib/node_modules/cline/bin/.cline --cline-hub-daemon --cwd /workspace/linux-port/scratch --host 127.0.0.1 --port <port> --pathname /hub
  ```
  - The daemon is the native `bin/.cline` (not `node`), re-parented to the VM's init/subreaper (PPID 53), and **SID = its own PID** (it calls `setsid()`; it differs from the starting shell's SID). So it leaves our process group (known limitation, covered by G2/G3).
- `node <entry> hub stop` → `{"stopped":true}`, exit 0; no daemon left afterwards.

### Gates

- Stage 2 gate (JS launcher at `<prefix>/lib/node_modules/cline/bin/cline`): **PASS**.
- Stages 3-4 gate (daemon argv contains `--cline-hub-daemon`, `--cwd <dir>`, `--port <n>`): **PASS**. Note for Stage 3: the daemon's argv[0] is `…/cline/bin/.cline`, not `node …/bin/cline`.
