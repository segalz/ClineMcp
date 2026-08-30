# Local Cline MCP Bridge

This is a local stdio MCP server that exposes one tool, `ask_cline`. It launches the authenticated Cline CLI and returns only the terminal text response plus model, duration, and usage/cost when Cline supplies them.

## Requirements

- Node.js 20 or newer
- The Cline CLI already installed and authenticated (`cline.exe` on Windows)

## Install, build, and launch

```powershell
npm install
npm run build
npm test
npm start
```

`npm start` runs a stdio server, so it will appear idle until an MCP client connects. Do not type prompts into that terminal.

## MCP client configuration

Build first, then add this server to an MCP client that supports stdio servers:

```json
{
  "mcpServers": {
    "cline-local": {
      "command": "node",
      "args": ["C:\\Develop\\ClineMcp\\dist\\index.js"]
    }
  }
}
```

## Tool

```ts
ask_cline({
  prompt: string,
  cwd?: string,
  thinking?: "none" | "low" | "medium" | "high" | "xhigh",
  timeoutSeconds?: number,
  systemPrompt?: string
})
```

- `timeoutSeconds` defaults to `180` and is limited to `300`.
- `thinking` defaults to `none`.
- On Windows, `prompt` is limited to 20,000 characters and `systemPrompt` to 8,000. Together they may not exceed 24,000 characters, leaving a safe margin below the Windows command-line limit.
- The bridge always invokes `cline --json --auto-approve false` and uses an argument array, never a shell command.
- It passes `--system` only when `systemPrompt` is supplied and `--cwd` only when `cwd` is supplied.
- Cline streamed content and reasoning are ignored. Only a terminal `run_result`-style event is returned.
- With `--auto-approve false`, Cline cannot obtain automatic approval for file-changing operations. Use this bridge only for analysis/chat prompts.

## Manual test

After configuring the MCP client, call:

```json
{
  "prompt": "Reply with exactly: Cline bridge test successful.",
  "thinking": "none",
  "timeoutSeconds": 180
}
```

The returned `text` should be `Cline bridge test successful.`

## Isolated workspace analysis

`ask_cline_workspace` is a separate tool for repository-wide analysis. It requires a `cwd` inside a Git repository with at least one commit. The bridge creates a detached Git worktree in the system temporary directory, runs Cline there with a mandatory analysis-only instruction, and removes the worktree in a `finally` block after success, failure, timeout, or cancellation.

```json
{
  "prompt": "Review this repository for reliability and security issues. Do not modify files.",
  "cwd": "C:\\Develop\\your-repository",
  "thinking": "high",
  "timeoutSeconds": 300
}
```

This tool uses Cline with automatic tool approval only inside the disposable worktree so it can inspect the repository. The prompt prohibits writes and external side effects, but this is not an operating-system sandbox; use it only for repositories you trust. The original `ask_cline` tool remains the stricter no-workspace-access option.

Run a live isolated-workspace check with:

```powershell
npm run verify:workspace
```

## Security notes

The bridge does not read or return Cline configuration, credentials, API keys, tokens, stderr, or streamed reasoning. Process launch, non-zero exit, timeout, cancellation, malformed JSONL, and a missing final result are returned as generic MCP tool errors.
