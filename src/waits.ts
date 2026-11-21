/**
 * Internal waits that must survive a busy machine (plan after-bridges, 2026-11-21).
 *
 * Each one used to be a few seconds. Under load (a parallel test run, a build, several bridge calls) Git,
 * PowerShell and killed children can take longer, and the bridge then gave up on work that was only slow:
 * a snapshot failed ("Snapshot Git call exceeded its time bound"), a process table could not be read so a kill
 * stayed unconfirmed, or a stale lock could not be checked. Every wait here is still bounded, and the caller's
 * own budget or cancel signal still stops it earlier.
 */

/** One read-only Git call while taking or checking a snapshot (was 10 s). */
export const SNAPSHOT_GIT_TIMEOUT_MS = 60_000;

/** One PowerShell read of the Windows process table (was 4 s). Two reads fit in TREE_KILL_CONFIRM_MS. */
export const PROCESS_TABLE_TIMEOUT_MS = 15_000;

/** Default cap to confirm a killed process tree is dead (was 10 s). */
export const TREE_KILL_CONFIRM_MS = 30_000;

/** After a kill, how long to wait for the child to close before settling anyway (was 5 s). */
export const KILL_SETTLE_MS = 15_000;

/** One PowerShell query of a process start time, used to check a lock holder (was 10 s). */
export const PROCESS_QUERY_TIMEOUT_MS = 20_000;

/** `git diff --stat` for a task summary (was 5 s). */
export const DIFF_STAT_TIMEOUT_MS = 15_000;
