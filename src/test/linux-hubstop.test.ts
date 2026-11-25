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
