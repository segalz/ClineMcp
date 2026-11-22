import assert from "node:assert/strict";
import test from "node:test";
import childProcess, { spawn } from "node:child_process";
import { EventEmitter, once } from "node:events";
import fs, { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import "./git-test-serial.js";
import { TEST_WAIT_MS } from "./test-waits.js";
import { acquire, CheckoutBusyError } from "../checkoutlock.js";
import { acquireHeavySlot, setFailedTicketRetryIntervalMs } from "../heavyslots.js";
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

test("finding 1: .tmp unlink failure after link leaves no orphan; ticket and slot release retry once and stay best-effort", async t => {
  process.env.BRIDGE_HEAVY_SLOTS = "1";
  mkdirSync(dir(), { recursive: true });
  const holder = await acquireHeavySlot(dir(), () => TEST_WAIT_MS, signal);
  t.after(() => holder());

  const realUnlink = fs.unlinkSync;
  let ticketAttempts = 0;
  let slotAttempts = 0;
  let failSlotAlways = false;
  const stub = t.mock.method(fs, "unlinkSync", (target: fs.PathLike) => {
    const file = String(target);
    if (file.endsWith(".tmp")) {
      throw Object.assign(new Error("injected tmp unlink EBUSY"), { code: "EBUSY" });
    }
    if (file.includes(`${path.sep}queue${path.sep}`) && ++ticketAttempts === 1) {
      throw Object.assign(new Error("injected transient ticket unlink EBUSY"), { code: "EBUSY" });
    }
    if (file.endsWith("slot-1.json")) {
      slotAttempts++;
      if (failSlotAlways || slotAttempts === 1) {
        throw Object.assign(new Error("injected slot unlink EBUSY"), { code: "EBUSY" });
      }
    }
    return realUnlink(target);
  });
  syncBuiltinESMExports();
  t.after(() => { stub.mock.restore(); syncBuiltinESMExports(); });

  // Ticket publication ignores .tmp unlink failure; throwing from onQueue triggers best-effort ticket release with retry.
  const injectedQueueError = new Error("injected onQueue failure");
  await assert.rejects(
    acquireHeavySlot(dir(), () => TEST_WAIT_MS, signal, q => {
      if (q) throw injectedQueueError;
    }),
    err => err === injectedQueueError
  );
  assert.equal(ticketAttempts, 2, "ticket release must retry once after transient EBUSY");
  assert.deepEqual(readdirSync(path.join(dir(), "queue")).filter(n => n.endsWith(".json")), [], "no orphan ticket left behind");

  // Slot release retries once on transient EBUSY and succeeds.
  assert.equal(holder(), true);
  assert.equal(slotAttempts, 2, "slot release must retry once after transient EBUSY");
  assert.equal(existsSync(path.join(dir(), "slot-1.json")), false);

  // Persistent slot unlink failure never throws and records lastError.
  const next = await acquireHeavySlot(dir(), () => TEST_WAIT_MS, signal);
  failSlotAlways = true;
  slotAttempts = 0;
  assert.equal(next(), false);
  assert.equal(slotAttempts, 2, "persistent slot release failure must try at most twice (initial + one retry)");
  assert.match(next.lastError ?? "", /injected slot unlink EBUSY/);

  // Clean up slot-1.json after restoring fs.unlinkSync.
  stub.mock.restore(); syncBuiltinESMExports();
  assert.equal(next(), true);
  assert.equal(existsSync(path.join(dir(), "slot-1.json")), false);
});

test("finding 1b: failed ticket unlink is retried under admission lock and never blocks later waiters", async t => {
  process.env.BRIDGE_HEAVY_SLOTS = "1";
  mkdirSync(dir(), { recursive: true });
  const holder = await acquireHeavySlot(dir(), () => TEST_WAIT_MS, signal);
  t.after(() => holder());

  const realUnlink = fs.unlinkSync;
  let blockFailedTicket = true;
  let stuckTicketName = "";
  const stub = t.mock.method(fs, "unlinkSync", (target: fs.PathLike) => {
    const file = String(target);
    if (blockFailedTicket && file.includes(`${path.sep}queue${path.sep}`) && file.endsWith(".json") && (!stuckTicketName || file.endsWith(stuckTicketName))) {
      stuckTicketName = path.basename(file);
      throw Object.assign(new Error("injected persistent ticket EBUSY"), { code: "EBUSY" });
    }
    return realUnlink(target);
  });
  syncBuiltinESMExports();
  t.after(() => { stub.mock.restore(); syncBuiltinESMExports(); });

  // Waiter 1 queues, aborts, and its ticket unlink fails on every attempt -> ticket stays on disk in failedTickets.
  const abort1 = new AbortController();
  await assert.rejects(
    acquireHeavySlot(dir(), () => TEST_WAIT_MS, abort1.signal, q => { if (q) abort1.abort(); }),
    { name: "AbortError" }
  );
  assert.ok(stuckTicketName, "failed ticket name must be captured");
  assert.ok(existsSync(path.join(dir(), "queue", stuckTicketName)), "failed ticket is still on disk");

  // Free slot-1 while the failed ticket is STILL un-unlinkable at the head of queue/: waiter 2 must NOT be blocked!
  holder();
  const second = await acquireHeavySlot(dir(), () => TEST_WAIT_MS, signal);
  t.after(() => second());
  assert.equal(data("slot-1.json").pid, process.pid);
  second();

  // Once unlink recovers, the next acquire retries and removes the failed ticket under admission.lock.
  blockFailedTicket = false;
  const third = await acquireHeavySlot(dir(), () => TEST_WAIT_MS, signal);
  third();
  assert.deepEqual(readdirSync(path.join(dir(), "queue")).filter(n => n.endsWith(".json")), [], "failed ticket must be removed on later acquire");

  // Also cover failure during slot-acquisition ticket removal (~line 119): ticket stays tracked and is cleaned up next time.
  const blocker = await acquireHeavySlot(dir(), () => TEST_WAIT_MS, signal);
  t.after(() => blocker());
  stuckTicketName = "";
  blockFailedTicket = true;
  const queued = acquireHeavySlot(dir(), () => TEST_WAIT_MS, signal, q => { if (q) blocker(); });
  const acquiredAfterQueue = await queued;
  assert.ok(stuckTicketName && existsSync(path.join(dir(), "queue", stuckTicketName)), "ticket unlink failed during slot acquisition");
  acquiredAfterQueue();
  // Next acquire is not blocked while still un-unlinkable, then removes it once unlink recovers.
  const fourth = await acquireHeavySlot(dir(), () => TEST_WAIT_MS, signal);
  fourth();
  blockFailedTicket = false;
  const fifth = await acquireHeavySlot(dir(), () => TEST_WAIT_MS, signal);
  fifth();
  assert.deepEqual(readdirSync(path.join(dir(), "queue")).filter(n => n.endsWith(".json")), []);
});

test("finding 1c: background interval retries failed ticket unlink without further polling, unblocks another process, and stops when empty", async t => {
  process.env.BRIDGE_HEAVY_SLOTS = "1";
  mkdirSync(dir(), { recursive: true });
  setFailedTicketRetryIntervalMs(20);
  t.after(() => setFailedTicketRetryIntervalMs());

  const holder = await acquireHeavySlot(dir(), () => TEST_WAIT_MS, signal);
  t.after(() => holder());

  const realUnlink = fs.unlinkSync;
  let failTicket = true;
  let stuckTicketName = "";
  let ticketUnlinkCalls = 0;
  const stub = t.mock.method(fs, "unlinkSync", (target: fs.PathLike) => {
    const file = String(target);
    if (file.includes(`${path.sep}queue${path.sep}`) && file.endsWith(".json") && (!stuckTicketName || file.endsWith(stuckTicketName))) {
      stuckTicketName = path.basename(file);
      ticketUnlinkCalls++;
      if (failTicket) throw Object.assign(new Error("injected ticket EBUSY"), { code: "EBUSY" });
    }
    return realUnlink(target);
  });
  syncBuiltinESMExports();
  t.after(() => { stub.mock.restore(); syncBuiltinESMExports(); });

  // Waiter queues, aborts, and its ticket unlink fails -> ticket stays on disk, background retry interval starts.
  const abort1 = new AbortController();
  await assert.rejects(
    acquireHeavySlot(dir(), () => TEST_WAIT_MS, abort1.signal, q => { if (q) abort1.abort(); }),
    { name: "AbortError" }
  );
  const ticketPath = path.join(dir(), "queue", stuckTicketName);
  assert.ok(stuckTicketName && existsSync(ticketPath));

  // Another process queues behind our failed ticket; our process never calls acquireHeavySlot again.
  const other = await worker(t);
  other.child.send("go");
  await other.wait("queued");
  holder();

  // Wait for background interval to retry while still failing.
  const callsBefore = ticketUnlinkCalls;
  await until(() => ticketUnlinkCalls >= callsBefore + 2);
  assert.ok(existsSync(ticketPath), "ticket stays on disk while unlink still fails");

  // Once unlink recovers, the background interval removes the ticket on its own (no polling in our process),
  // unblocking the other process, and then stops retrying once the failed-ticket set is empty.
  failTicket = false;
  await until(() => !existsSync(ticketPath));
  await other.wait("acquired");
  other.child.send("release");
  await other.exited;

  const callsAfterCleared = ticketUnlinkCalls;
  await delay(80);
  assert.equal(ticketUnlinkCalls, callsAfterCleared, "background retry interval must stop once failed-ticket set is empty");
});

test("finding 2: stale reaper frees an own-pid retained checkout lock and heavy slot once all survivors exit", async t => {
  process.env.BRIDGE_HEAVY_SLOTS = "1";
  const repo = path.join(dir(), "repo");
  const locks = path.join(dir(), "locks");
  mkdirSync(repo, { recursive: true });
  mkdirSync(locks, { recursive: true });

  const survivor = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore", windowsHide: true });
  const exited = once(survivor, "exit");
  t.after(async () => {
    if (survivor.exitCode === null && survivor.signalCode === null) survivor.kill();
    await exited;
  });
  await once(survivor, "spawn");

  const slot = await acquireHeavySlot(repo, () => TEST_WAIT_MS, signal);
  const lock = await acquire(repo, { lockDirectory: locks });
  assert.equal(slot.retain([survivor.pid!]), true);
  assert.equal(lock.retain([survivor.pid!]), true);
  // Lifecycle releases while survivor is still alive: both stay retained on disk.
  slot();
  lock();

  await assert.rejects(acquire(repo, { lockDirectory: locks }), CheckoutBusyError);
  await assert.rejects(acquireHeavySlot(repo, () => 0, signal), { kind: "machine_busy" });

  // Survivor exits; another process still refuses to reap a lease whose owner PID is alive,
  // while the owning bridge process can reap both own-pid retained leases.
  survivor.kill();
  await exited;

  const foreign = await worker(t);
  foreign.child.send("go");
  await foreign.wait("queued");
  foreign.child.kill();
  await foreign.exited;

  const reclaimedLock = await acquire(repo, { lockDirectory: locks });
  reclaimedLock();
  const reclaimedSlot = await acquireHeavySlot(repo, () => TEST_WAIT_MS, signal);
  assert.equal(data("slot-1.json").pid, process.pid);
  reclaimedSlot();
});

test("finding 5: staleCandidates caches foreign process start-time lookups by (pid, time) for one wait",
  { skip: process.platform !== "win32" }, async t => {
  process.env.BRIDGE_HEAVY_SLOTS = "1";
  mkdirSync(dir(), { recursive: true });
  const time = new Date().toISOString();
  writeFileSync(path.join(dir(), "slot-1.json"), JSON.stringify({
    bridge: "opencode", kind: "edit", checkout: "b".repeat(64),
    started_at: time, pid: process.ppid, time, token: "cache-test-token"
  }));

  let execCalls = 0;
  const stub = t.mock.method(childProcess, "execFile", ((...args: unknown[]) => {
    execCalls++;
    const cb = args.find(arg => typeof arg === "function") as ((err: Error | null, stdout: string) => void) | undefined;
    const earlier = new Date(Date.now() - 3_600_000).toISOString();
    queueMicrotask(() => cb?.(null, earlier + "\n"));
    return Object.assign(new EventEmitter(), { kill: () => true });
  }) as unknown as typeof childProcess.execFile);
  syncBuiltinESMExports();
  t.after(() => { stub.mock.restore(); syncBuiltinESMExports(); });

  const start = Date.now();
  await assert.rejects(
    acquireHeavySlot(dir(), () => 2_300 - (Date.now() - start), signal),
    { kind: "machine_busy" }
  );
  assert.equal(execCalls, 1, "start-time query should run once per (pid, time) across multiple 1 s polls");
});
