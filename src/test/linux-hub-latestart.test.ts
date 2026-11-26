import assert from "node:assert/strict";
import test from "node:test";
import { stopDedicatedHub } from "../runner.js";

test("linux: a hub that starts late (slow machine) is still found and stopped",
  { skip: process.platform !== "linux" && "Linux only" }, async () => {
  const startedAt = Date.now() + 1_500;
  let stops = 0;
  const result = await stopDedicatedHub(4556, {
    hubStarted: async () => Date.now() >= startedAt,
    isListening: async () => Date.now() >= startedAt && stops === 0,
    runHubStop: async () => { stops++; return true; },
    removeFiles: async () => {}
  });
  assert.equal(stops, 1);
  assert.equal(result, undefined);
});

test("linux: when no hub ever starts, the stop still returns within the late-start window",
  { skip: process.platform !== "linux" && "Linux only" }, async () => {
  const t0 = Date.now();
  let stops = 0;
  const result = await stopDedicatedHub(4557, {
    hubStarted: async () => false,
    isListening: async () => false,
    runHubStop: async () => { stops++; return true; },
    removeFiles: async () => {}
  });
  assert.equal(stops, 0);
  assert.equal(result, undefined);
  assert.ok(Date.now() - t0 < 12_000, `took ${Date.now() - t0} ms`);
});
