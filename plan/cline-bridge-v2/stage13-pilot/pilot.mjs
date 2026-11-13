// usage: node pilot.mjs <cline|opencode> <A0|A1> <qid>
import { Client } from "file:///C:/Develop/openCodeHelperMcp/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js";
import { StdioClientTransport } from "file:///C:/Develop/openCodeHelperMcp/node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js";
import { readFileSync, writeFileSync } from "node:fs";
const [bridge, arm, qid] = process.argv.slice(2);
const here = new URL(".", import.meta.url).pathname.replace(/^\/([A-Z]:)/, "$1");
const Q = JSON.parse(readFileSync(here + (process.env.QFILE ?? "questions.json"), "utf8")).find(x => x.id === qid);
const env = { ...process.env };
delete env.CODEINDEX_CLI;
if (arm === "A1") env.CODEINDEX_CLI = "C:/Develop/codeindex/dist/cli.js";
const prompt = `## Question\n${Q.q}\n\n## Scope\nRepository: this workspace (TypeScript sources under src/). Read-only analysis: no edits, no commands that change anything.\n\n## Output\nName the exact file path(s) and function name(s) with line numbers. At most 150 words.`;
let server, tool, args;
if (bridge === "cline") {
  server = { command: "node", args: ["C:/Develop/ClineMcp/dist/index.js"], env };
  tool = "ask_cline_workspace";
  args = { prompt, provider: "cline", model: "cline-free/nemotron-3.5-super-vl", cwd: "C:/Develop/ClineMcp", thinking: "low", timeoutSeconds: 240 };
} else {
  env.OPENCODE_HELPER_ALLOWED_ROOTS = "C:/Develop";
  env.OPENCODE_BIN = process.env.APPDATA + "/npm/node_modules/opencode-ai/bin/opencode.exe";
  server = { command: "node", args: ["C:/Develop/openCodeHelperMcp/src/index.js"], env };
  tool = "analyze_code";
  args = { directory: "C:/Develop/ClineMcp", prompt, model: process.env.OCMODEL ?? "opencode/glm-5.3-flash-free", budgetMs: 240000, maxWords: 180 };
}
const client = new Client({ name: "pilot", version: "0" });
await client.connect(new StdioClientTransport(server));
const t0 = Date.now(); let r, err;
try { r = await client.callTool({ name: tool, arguments: args }, undefined, { timeout: 600000 }); } catch (e) { err = String(e?.message ?? e); }
const ms = Date.now() - t0;
const text = (r?.content ?? []).map(c => c.text ?? "").join("\n");
writeFileSync(`${here}out${process.env.OUTSUF ?? ""}/${bridge}-${arm}-${qid}-r${process.env.REP ?? "1"}.json`, JSON.stringify({ bridge, arm, qid, ms, isError: r ? !!r.isError : true, err, text }, null, 1));
console.log(bridge, arm, qid, ms, r?.isError ? "ERR" : "ok");
await client.close();
