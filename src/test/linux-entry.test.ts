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
