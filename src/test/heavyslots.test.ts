import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import "./git-test-serial.js";
import { TEST_WAIT_MS } from "./test-waits.js";
import { acquireHeavySlot } from "../heavyslots.js";
import { withProgressHeartbeat } from "../progress.js";

const moduleUrl = new URL("../heavyslots.js", import.meta.url).href;
const signal = new AbortController().signal;
function dir() { return process.env.BRIDGE_HEAVY_DIR!; }
function data(file: string) { return JSON.parse(readFileSync(path.join(dir(), file), "utf8")); }

async function until(check: () => boolean) {
  const end = Date.now() + TEST_WAIT_MS;
  while (!check()) { assert.ok(Date.now() < end, "condition timed out"); await delay(15); }
}

// Every worker uses its own bridge PID and the same machine directory. IPC gates
// admission attempts and releases, so ordering assertions need no timing guesses.
async function worker(t: test.TestContext, crash = "") {
  const child = spawn(process.execPath, ["--input-type=module", "-e", `
    import fs from "node:fs";
    import { syncBuiltinESMExports } from "node:module";
    const crash = process.argv[1];
    const link = fs.linkSync;
    fs.linkSync = (src, dst) => {
      if (crash && dst.endsWith("slot-1.json")) {
        if (!JSON.parse(fs.readFileSync(src)).token) process.exit(9);
        if (crash === "after") link(src, dst);
        process.exit(77);
      }
      link(src, dst);
    };
    syncBuiltinESMExports();
    const { acquireHeavySlot } = await import(${JSON.stringify(moduleUrl)});
    let lease;
    process.on("message", async cmd => {
      if (cmd === "go") {
        lease = await acquireHeavySlot(process.env.BRIDGE_HEAVY_DIR, () => ${TEST_WAIT_MS},
          new AbortController().signal, q => { if (q) process.send("queued"); });
        process.send("acquired");
      } else { lease(); process.disconnect(); }
    });
    process.send("ready");
  `, crash], { windowsHide: true, stdio: ["ignore", "ignore", "pipe", "ipc"] });
  const messages: unknown[] = [];
  let errors = "";
  child.stderr!.on("data", chunk => { errors += chunk; });
  child.on("message", msg => messages.push(msg));
  const exited = once(child, "exit");
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await exited;
  });
  const wait = (msg: string) => until(() => {
    assert.ok(child.exitCode === null && child.signalCode === null, errors || "worker exited");
    return messages.includes(msg);
  });
  await wait("ready");
  return { child, wait, exited, messages };
}

test("two slots admit three waiters in FIFO order, including a newcomer at release", async t => {
  mkdirSync(dir(), { recursive: true });
  const first = await acquireHeavySlot(dir(), () => TEST_WAIT_MS, signal);
  const second = await acquireHeavySlot(dir(), () => TEST_WAIT_MS, signal);
  t.after(first); t.after(second);
  const waiters: Awaited<ReturnType<typeof worker>>[] = [];
  for (let i = 0; i < 3; i++) {
    const w = await worker(t);
    w.child.send("go"); await w.wait("queued"); waiters.push(w);
  }
  assert.equal(data("state.json").queued, 3);
  const newcomer = await worker(t);
  first(); newcomer.child.send("go");
  waiters.push(newcomer);
  for (let i = 0; i < waiters.length; i++) {
    const w = waiters[i];
    await w.wait("acquired");
    assert.ok(waiters.slice(i + 1).every(other => !other.messages.includes("acquired")));
    assert.equal(data("slot-1.json").pid, w.child.pid);
    w.child.send("release"); await w.exited;
  }
  second();
  assert.deepEqual(data("state.json").active, []);
  assert.equal(data("state.json").queued, 0);
});

test("a crash either side of hard-link publication leaves a reclaimable admission lock and no partial slot", async t => {
  mkdirSync(dir(), { recursive: true });
  for (const stage of ["before", "after"]) {
    const w = await worker(t, stage); w.child.send("go");
    assert.equal((await w.exited)[0], 77);
    assert.ok(existsSync(path.join(dir(), "admission.lock")));
    assert.equal(existsSync(path.join(dir(), "slot-1.json")), stage === "after");
    if (stage === "after") assert.equal(data("slot-1.json").pid, w.child.pid);
    const release = await acquireHeavySlot(dir(), () => TEST_WAIT_MS, signal);
    assert.equal(data("slot-1.json").pid, process.pid);
    release();
  }
});

test("OpenCode lease and recorded survivor block Cline; crashed tickets and reused PIDs are reclaimed", async t => {
  process.env.BRIDGE_HEAVY_SLOTS = "1";
  mkdirSync(dir(), { recursive: true });
  const w = await worker(t);
  const time = new Date().toISOString();
  const fixture = { bridge: "opencode", kind: "edit", checkout: "a".repeat(64),
    started_at: time, pid: process.pid, time, token: "5d193092-66f9-4fa1-b62e-39cb782d25c6" };
  const file = path.join(dir(), "slot-1.json");
  writeFileSync(file, JSON.stringify(fixture));
  const controller = new AbortController();
  await assert.rejects(acquireHeavySlot(dir(), () => TEST_WAIT_MS, controller.signal, q => {
    if (q) { assert.deepEqual(q, { position: 1, total: 1 }); controller.abort(); }
  }), { name: "AbortError" });
  assert.deepEqual(readdirSync(path.join(dir(), "queue")), []);
  w.child.send("go"); await w.wait("queued");
  w.child.kill(); await w.exited;
  // Bridge PID died while a survivor still owns the lease.
  writeFileSync(file, JSON.stringify({ ...fixture, pid: w.child.pid, survivors: [process.pid], survivor_time: time }));
  const other = new AbortController();
  await assert.rejects(acquireHeavySlot(dir(), () => TEST_WAIT_MS, other.signal, q => {
    if (q) { assert.equal(q.total, 1, "dead worker ticket reaped"); other.abort(); }
  }), { name: "AbortError" });
  const live = await worker(t);
  writeFileSync(file, JSON.stringify({ ...fixture, pid: w.child.pid, survivors: [live.child.pid],
    survivor_time: "2000-01-01T00:00:00.000Z" }));
  const release = await acquireHeavySlot(dir(), () => TEST_WAIT_MS, signal);
  const actual = data("slot-1.json");
  assert.equal(actual.bridge, "cline");
  assert.match(actual.checkout, /^[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(actual).includes(dir()), false);
  writeFileSync(file, JSON.stringify(fixture)); release();
  assert.deepEqual(data("slot-1.json"), fixture, "old token cannot release a replacement");
});

test("the progress heartbeat reports the queue position and returns to elapsed time after admission", async () => {
  const messages: string[] = [];
  await withProgressHeartbeat({ _meta: { progressToken: 1 }, sendNotification: async n => {
    messages.push(n.params.message!);
  } }, async update => {
    update({ position: 2, total: 3 });
    await until(() => messages.includes("queued for a heavy-run slot: position 2 of 3"));
    update(); await until(() => messages.some(m => m.startsWith("still running")));
  }, { intervalMs: 5 });
});
