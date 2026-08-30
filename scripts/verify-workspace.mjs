import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const execFileAsync = promisify(execFile);
const git = process.platform === "win32" ? "git.exe" : "git";
const testRepository = await mkdtemp(path.join(os.tmpdir(), "cline-bridge-workspace-test-"));

try {
  await execFileAsync(git, ["init", "-q"], { cwd: testRepository });
  await execFileAsync(git, ["-c", "user.name=Cline Bridge Test", "-c", "user.email=cline-bridge-test@local.invalid", "commit", "--allow-empty", "-m", "initial", "-q"], { cwd: testRepository });

  const client = new Client({ name: "workspace-verifier", version: "1.0.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["dist/index.js"],
    cwd: process.cwd(),
    stderr: "pipe"
  });
  await client.connect(transport);
  try {
    const result = await client.callTool({
      name: "ask_cline_workspace",
      arguments: {
        cwd: testRepository,
        thinking: "none",
        timeoutSeconds: 180,
        prompt: "Use a read-only inspection tool to confirm this is a Git workspace, then reply with exactly: isolated workspace analysis successful."
      }
    }, undefined, { timeout: 300_000 });
    const text = result.content.find((item) => item.type === "text")?.text ?? "";
    assert.match(text, /isolated workspace analysis successful\.?/);
  } finally {
    await client.close();
  }

  const { stdout } = await execFileAsync(git, ["worktree", "list", "--porcelain"], { cwd: testRepository });
  assert.equal(stdout.split(/\r?\n/).filter((line) => line.startsWith("worktree ")).length, 1, "temporary worktree was not removed");
  console.log("Isolated workspace analysis succeeded and the temporary worktree was removed.");
} finally {
  await rm(testRepository, { recursive: true, force: true, maxRetries: 5, retryDelay: 250 });
}
