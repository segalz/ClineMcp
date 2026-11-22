# F10: a machine-wide queue for heavy bridge runs, and a "busy" status that `pick` reads

Finish-all item F10 (open item 12). Writer: Codex `gpt-6.2-astra` xhigh. Reviewer: Opus. Claude supervises, reviews the diffs, and runs the full suites.

## Problem

Heavy runs are checked edits and the seed runs that call them. Today the only limit is one writer per checkout. Several heavy runs on different checkouts can start at once, from Claude, Codex or a seed script. Under that load, model providers return 429 (Nvidia), the machine slows, and waits run out. Nothing tells `pick` that the bridges are saturated, so it keeps sending writes there.

## Design

### 1. Shared heavy-run slots (both bridges, same on-disk protocol)

- **Directory:** `~/.cline-mcp/heavy/`, next to the existing shared `~/.cline-mcp/locks/`. It can be overridden by env `BRIDGE_HEAVY_DIR`, which tests use.
- **Slots:** `BRIDGE_HEAVY_SLOTS` sets the number of slots; default 2, range 1 to 8.
  - A slot is the file `slot-<i>.json`, for i in 1..N, created exclusively (`wx`).
  - Its body is `{pid, bridge: "cline"|"opencode", kind: "edit", checkout: <sha256 of canonical checkout path>, started_at}`. There is no raw path, so no local path leaks.
  - A slot whose pid is gone is stale. Reclaim it the same way `checkoutlock` reclaims a stale lock, with the same pid check and the same race safety.
- **Queue:** a caller that finds no free slot writes a ticket `queue/<started_at_ms>-<pid>-<random>.json`.
  - Only the oldest live ticket may take a slot (FIFO).
  - Stale tickets (pid gone) are removed by whoever sees them.
  - The ticket is removed when the slot is taken, or when the caller gives up or is cancelled.
- **Wait:** poll at most once per second, inside the call's budget.
  - While queued, the progress heartbeat (already sent every 15 s) says `queued for a heavy-run slot: position P of Q`.
  - When the time left can no longer cover the minimum first run (`MIN_FIRST_RUN_SECONDS` / `MIN_FIRST_RUN_MS`) plus the check's reserve, return a new error kind `machine_busy`. That happens before any model use, with no snapshot taken and the checkout lock released. Use a clear message: how many heavy runs are active and queued, and that it should be retried later or sent elsewhere.
  - Async Cline tasks (`cline_start` mode `edits`) wait in the queue too. Their status shows `queued` with the position.
- **Order inside a call:** take the slot after the cheap up-front checks (verify command resolvable, budget) and before the checkout lock and snapshot. Release it in the same `finally` that releases the checkout lock. Do not release it while a stopped process may still be running: the existing unconfirmed-kill path keeps the checkout lock, so it keeps the slot as well.
- **Read-only calls never take a slot:** `ask_cline_workspace`, `analyze_code`, pings and lists.

### 2. Busy status file

- After every acquire, release, enqueue or dequeue, rewrite `~/.cline-mcp/heavy/state.json` atomically (temp file plus rename): `{version: 1, slots: N, active: [{bridge, kind, started_at}], queued: Q, updated_at}`.
- Readers must not trust it alone. A reader recounts the live slots and tickets from the directory, so a crashed writer cannot leave a "busy" state behind.

### 3. `pick` reads it (mcp-model-picker)

- Add a reader that counts the live slots and tickets in `~/.cline-mcp/heavy/` (`BRIDGE_HEAVY_DIR` honoured), with the same pid-liveness rule. `state.json` is only a hint.
- When every slot is taken, the `cline`, `cline-task` and `opencode-free` write units are marked busy for this pick.
  - They get a `warnings` entry: `bridges busy: A active, Q queued`.
  - They get a score penalty that grows with Q, so that with Q ≥ 1 another eligible unit (another bridge family member, AGY or Codex) wins when one exists.
  - When no other unit is eligible, the bridge unit is still returned, with the warning; its call will wait in the queue.
- `backend_status` shows the heavy-run state: slots, active, queued.
- Read picks are unaffected.

## Acceptance criteria (each is a test)

1. **Slots (both bridges).** With N=2, a third heavy run waits, then starts as soon as a slot frees. FIFO holds across 3 waiters. A stale slot and a stale ticket are reclaimed.
2. **Give-up.** A queued call whose time runs out returns `machine_busy`. No model run happened, no snapshot remains, and the checkout lock is free.
3. **Cancel.** Cancelling a queued call removes its ticket. Cancelling a running call frees its slot.
4. **Unconfirmed kill.** The slot stays held, the same as the checkout lock.
5. **Cross-bridge.** A slot taken by the Cline implementation blocks the OpenCode implementation, and the reverse. This is a test in each repo that writes a slot file in the other bridge's format.
6. **`pick`.**
   - Busy (all slots active, Q ≥ 1): a non-bridge write unit wins when eligible, and the bridge units carry the warning.
   - Not busy: unchanged.
   - Stale slot files (dead pids): not busy.
7. **Full suites pass** in all three repos (Cline at default concurrency, OpenCode `npm test`, model-picker pytest).
8. **Live check (Claude, after a restart).** 4 parallel edits across the two bridges, with N=2. Two run, two queue and then run, none fails. During the queue, `pick(needs_write)` shows the busy warning.

## Spec changes from Codex's plan review (2026-11-22, "sound with changes")

These override the design above where they differ.

1. **Slot ownership.** Do not write the slot with `wx` and then fill it, because a crash in between leaves an empty slot with no owner. Instead, write a complete, uniquely named owner file, then publish it as `slot-<i>.json` with a same-volume hard link that refuses to replace (as `checkoutlock` does). Include a per-acquisition token and a `time` field for PID-reuse detection, and reuse the serialized stale reaper and the token-checked release. The Python reader needs a non-destructive process query on Windows.
2. **FIFO and status.** Serialize ticket publication and admission under a short admission lock, so a newcomer cannot jump a waiting ticket when a slot frees. Every arrival honours existing tickets. Capacity and directory are shared by all processes. `state.json` is a best-effort hint: write it via unique temp files, ignore Windows sharing violations, and have readers always recount. Tests run real concurrent processes, a newcomer at release, and a crash during publication.
3. **Unconfirmed kill (existing bug, fix in both bridges).** Today both synchronous paths release the checkout lock even after an unconfirmed kill (`ClineMcp/src/edits.ts:266`, `src/finalcheck.ts:419`, `openCodeHelperMcp/src/edits.js:318`). Keep both the checkout lock and the slot whenever a process may still be running, including after a passing check with an unconfirmed server stop. Record the surviving process ids in the lease, and treat the lease as stale only when the bridge pid **and** every recorded survivor are gone.
4. **Budget.** Polling time counts against the call's existing active-time deadline. Keep three outcomes apart: a budget too small from the start (the existing refusal), the queue running the budget out (`machine_busy`), and caller cancellation. `verify:{none}` also needs the 60 s minimum first run before it may take a slot.
5. **Async Cline edits.** Release the slot on a confirmed `input_required` (keep the checkout lock) and take it again on `retry`, so unanswered tasks cannot hold every slot. Queue position is a phase under `running`, so cancel, status and concurrency accounting are unchanged.
6. **Insertion points.**
   - Cline: move verifier resolution ahead of the checkout acquire in `FinalCheckLifecycle.execute`, take the slot between preflight and the checkout lock, and unwind it if the checkout acquire fails. Add `machine_busy` to the error union in `runner.ts`, and feed the queue position to `progress.ts`.
   - OpenCode: acquire in `runEdits` just before the checkout `acquire` (`edits.js:202`), release in its `finally`, subject to rule 3.
   - model-picker: an uncached reader next to the Cline status reader in `probes.py`, read once per write pick and once per `backend_status`. When every slot is full and a waiter exists, rank eligible non-bridge units first in both ranking passes, rather than relying on a penalty alone. Keep the fallback selection, and emit one warning even when every eligible choice is a bridge.

## Opus review of step A (Cline, uncommitted, 2026-11-22): REJECT, fix before step B

The design passed: FIFO, admission, budget separation, the `machine_busy` path and cancel are correct. To fix:

1. **Medium: orphan ticket or slot.** `publishHolder` throws when deleting the `.tmp` fails after a successful link (`checkoutlock.ts:218`). `heavyslots.ts:120` then never records `ticket`, and a live-pid orphan at the head of the queue blocks every waiter until a restart. The same happens if the release at line 136 throws. Ignore `rmTemp` errors after a successful link, record `ticket` before cleanup, and make ticket release best-effort with a retry.
2. **Medium: a retained lease never heals.** After an unconfirmed kill (including `killUnverified` with no survivors), `release()` (`finalcheck.ts:442-447`) and `CheckoutRelease` (`checkoutlock.ts:320`) return early forever, and the reaper never frees the bridge's own pid. Two such events leave the machine at `machine_busy` until a restart. Re-check the survivors on release, keep and restore, and free both leases when all survivors are gone; or let the reaper free an own-pid retained lease whose survivors are all dead.
3. **Medium: retries need 60 s.** The new pre-slot check (`finalcheck.ts:244`) applies `MIN_FIRST_RUN_SECONDS` to every `execute`. Apply the 60 s floor only when `launches === 0`, and otherwise 1 s, as before.
4. **Medium: cleanup can throw.** `recordUnconfirmedKill` → `retain` (`finalcheck.ts:142`) and `fileLease` (`checkoutlock.ts:231`) rethrow. One effect is that a passed check turns into `cline_error`. Make retain and release best-effort, and record failures in evidence.
5. **Low:** `staleCandidates` starts one PowerShell per foreign lease on every 1 s poll. Cache start times by (pid, time) for the length of the wait.
6. **Low:** `tasks.ts:916` overwrites the `resuming` state with `running` while queued.

## Out of scope

- Queueing read-only analysis.
- Changing the per-checkout lock.
- Any change to model choice inside a bridge.
