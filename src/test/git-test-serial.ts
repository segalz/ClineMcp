import "./heavy-test-dir.js";
import { after } from "node:test";
import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { acquire, CheckoutBusyError, type CheckoutRelease } from "../checkoutlock.js";

// Real Git fixture setup and scans otherwise compete across test-file processes on Windows.
// Serialize those files, rather than changing production scan budgets or weakening content assertions.
const root = path.join(os.tmpdir(), "cline-mcp-git-tests", createHash("sha256").update(process.cwd()).digest("hex"));
await mkdir(root, { recursive: true });
// Files wait their turn; with node's default concurrency (one file per CPU) the queue alone exceeded the old
// 10-minute cap and whole files failed with CheckoutBusyError. A file still fails after an hour in the queue.
const deadline = Date.now() + 3_600_000;
let release: CheckoutRelease;
while (true) {
  try { release = await acquire(root, { lockDirectory: path.join(root, "locks") }); break; }
  catch (error) {
    if (!(error instanceof CheckoutBusyError) || Date.now() >= deadline) throw error;
    // Each try against a live holder starts PowerShell to read the holder's start time (checkoutlock.ts).
    // At 25 ms, four waiting files started ~160 PowerShell processes a second and slowed the whole suite.
    await new Promise(resolve => setTimeout(resolve, 1_000));
  }
}
after(() => release());
