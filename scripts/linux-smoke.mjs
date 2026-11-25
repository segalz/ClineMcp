#!/usr/bin/env node
// Linux end-to-end smoke (plan S9.1). Runs on the supervisor VM only, never in CI (no secrets there).
// Starts `node dist/index.js` over stdio and calls cline_ping, cline_list_models, ask_cline,
// ask_cline_workspace and apply_cline_edits. After each call the number of processes whose argv
// contains --cline-hub-daemon must return to its value before the call (no leaked hubs).
// Model: SMOKE_PROVIDER / SMOKE_MODEL (default cline / cline-free/nemotron-3.5-super-vl). Keys come
// from the environment only; this script never prints them.
import { execFileSync } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const provider = process.env.SMOKE_PROVIDER || "cline";
const model = process.env.SMOKE_MODEL || "cline-free/nemotron-3.5-super-vl";
const worktreeBase = path.join(os.tmpdir(), "cline-mcp-worktrees");

async function hubCount() {
  let n = 0;
  for (const name of await readdir("/proc")) {
    if (!/^\d+$/.test(name)) continue;
    try { if ((await readFile(`/proc/${name}/cmdline`, "utf8")).split("\0").includes("--cline-hub-daemon")) n++; } catch { /* gone */ }
  }
  return n;
}
async function settle(before, label) {
  for (let i = 0; i < 120; i++) {
    if (await hubCount() <= before) return;
    await new Promise(r => setTimeout(r, 500));
  }
  throw new Error(`${label}: hub daemon count did not return to ${before} (now ${await hubCount()})`);
}
const listWorktrees = async () => new Set(await readdir(worktreeBase).catch(() => []));
const text = result => (result.content ?? []).map(c => c.text ?? "").join("\n");
function check(cond, msg, result) {
  if (!cond) throw new Error(`${msg}${result ? `\n${text(result).slice(0, 2000)}` : ""}`);
  console.log("ok -", msg);
}
async function tempRepo(prefix, files) {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  const git = (...args) => execFileSync("git", ["-c", "user.name=smoke", "-c", "user.email=smoke@example.invalid", ...args], { cwd: dir, stdio: "ignore" });
  git("init", "-q");
  for (const [name, content] of Object.entries(files)) await writeFile(path.join(dir, name), content);
  git("add", "."); git("commit", "-qm", "init");
  return dir;
}

const wsRepo = await tempRepo("cline-smoke-ws-", { "add.js": "export function add(a, b) { return a + b; }\n" });
const editRepo = await tempRepo("cline-smoke-edit-", { "README.md": "# smoke\n" });
const transport = new StdioClientTransport({
  command: process.execPath, args: [path.join(repoRoot, "dist", "index.js")], cwd: repoRoot,
  env: { ...process.env }, stderr: "inherit",
});
const client = new Client({ name: "linux-smoke", version: "1.0.0" });
let failed = false;
try {
  await client.connect(transport);
  const call = (name, args) => client.callTool({ name, arguments: args }, undefined, { timeout: 900_000 });

  let before = await hubCount();
  const ping = await call("cline_ping", { provider, model });
  await settle(before, "cline_ping");
  check(!ping.isError, "cline_ping answered", ping);

  before = await hubCount();
  const models = await call("cline_list_models", {});
  await settle(before, "cline_list_models");
  check(!models.isError && /free/i.test(text(models)), "cline_list_models lists free models (G1)", models);

  before = await hubCount();
  const asked = await call("ask_cline", { prompt: "Reply with the single word: pong", provider, model, timeoutSeconds: 240 });
  await settle(before, "ask_cline");
  check(!asked.isError && text(asked).length > 0, "ask_cline answered (no repo)", asked);

  before = await hubCount();
  const worktreesBefore = await listWorktrees();
  const ws = await call("ask_cline_workspace", { prompt: "What does add.js export? One sentence.", cwd: wsRepo, provider, model, timeoutSeconds: 240 });
  await settle(before, "ask_cline_workspace");
  check(!ws.isError && text(ws).length > 0, "ask_cline_workspace answered", ws);
  const leftover = [...await listWorktrees()].filter(n => !worktreesBefore.has(n));
  check(leftover.length === 0, `ask_cline_workspace removed its worktree (leftover: ${leftover.join(", ") || "none"})`);

  before = await hubCount();
  const edited = await call("apply_cline_edits", { prompt: "add the word hello to README.md", cwd: editRepo, provider, model, timeoutSeconds: 300,
    verify: { command: "node", args: ["-e", "process.exit(require('fs').readFileSync('README.md','utf8').includes('hello')?0:1)"] } });
  await settle(before, "apply_cline_edits");
  const readme = await readFile(path.join(editRepo, "README.md"), "utf8");
  check(!edited.isError && readme.includes("hello"), "apply_cline_edits added hello and the check passed", edited);
  console.log("SMOKE PASS");
} catch (error) {
  failed = true;
  console.error("SMOKE FAIL:", error?.message ?? error);
} finally {
  await client.close().catch(() => {});
  for (const dir of [wsRepo, editRepo]) await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
process.exit(failed ? 1 : 0);
