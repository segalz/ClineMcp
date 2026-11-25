import assert from "node:assert/strict";
import test from "node:test";
import { formatCommandLine, parseProcStatusUid } from "../procs.js";

test("formatCommandLine joins NUL-separated argv and quotes args with whitespace", () => {
  assert.equal(formatCommandLine("node\0/x/cline/bin/cline\0--cline-hub-daemon\0--cwd\0/tmp/my dir\0--port\x00123\0"),
    'node /x/cline/bin/cline --cline-hub-daemon --cwd "/tmp/my dir" --port 123');
  assert.equal(formatCommandLine(""), "");
  assert.equal(formatCommandLine("a\0\0b\0"), "a b");
});
test("parseProcStatusUid reads the real uid", () => {
  assert.equal(parseProcStatusUid("Name:\tnode\nUid:\t1000\t1000\t1000\t1000\nGid:\t1000\n"), 1000);
  assert.equal(parseProcStatusUid("Name:\tx\n"), undefined);
});
