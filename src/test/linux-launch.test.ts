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
