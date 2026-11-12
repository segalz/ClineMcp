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
const deadline = Date.now() + 600_000;
let release: CheckoutRelease;
while (true) {
  try { release = acquire(root, { lockDirectory: path.join(root, "locks") }); break; }
  catch (error) {
    if (!(error instanceof CheckoutBusyError) || Date.now() >= deadline) throw error;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}
after(() => release());
