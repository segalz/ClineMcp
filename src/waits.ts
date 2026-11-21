/**
 * Internal wait caps and budget helpers.
 *
 * Invariant:
 * - A timed-out or cancelled run or check settles within its budget + `SETTLE_MARGIN_MS`,
 *   or + `KILL_CONFIRM_MARGIN_MS` when process-table kill confirmation runs.
 * - Every internal wait is bounded by `min(its cap, the owning operation's remaining budget)`.
 * - A cancellation stops waiting promptly and shortens even a settlement wait already in progress.
 *   Note: cancelling an edit task can take up to `RESTORE_BUDGET_MS` because `tasks.cancel`
 *   awaits `task.settled` while baseline restoration runs.
 */

/** Per-call cap for read-only snapshot Git work; bounded earlier by the owning operation's signal. */
export const SNAPSHOT_GIT_TIMEOUT_MS = 60_000;
/** Includes the identity guard, restoration, and final inventory. Below the 120 s shutdown cap.
 * Cancelling an edit task can take up to this long because `tasks.cancel` awaits `task.settled` (including restore). */
export const RESTORE_BUDGET_MS = 90_000;
/** One PowerShell process-start / hub-stop / job-owner wait cap; bounded by the caller's budget. */
export const PROCESS_QUERY_TIMEOUT_MS = 20_000;
/** One PowerShell read of the Windows process table. Two reads fit inside `TREE_KILL_CONFIRM_MS`. */
export const PROCESS_TABLE_TIMEOUT_MS = 15_000;
/** Two complete Windows process-table reads plus 2 s of slack to poll and reap. */
export const TREE_KILL_CONFIRM_MS = 2 * PROCESS_TABLE_TIMEOUT_MS + 2_000;
/** Margin used for process-table kill confirmation after timeout/cancel (one full 15 s read + 1 s polling). */
export const KILL_CONFIRM_MARGIN_MS = PROCESS_TABLE_TIMEOUT_MS + 1_000;
/** Short settle cap after a kill (also exceeds the Windows job owner's 2 s drain). */
export const KILL_SETTLE_MS = 5_000;
/** Runs/checks share one grace window after budget exhaustion or cancellation (tasks.cancel waits 5 s for ask/workspace). */
export const SETTLE_MARGIN_MS = 4_000;
/** Optional `git diff --stat` display awaited by `cline_send`; omitted on timeout. */
export const DIFF_STAT_TIMEOUT_MS = 5_000;

const MAX_TIMER_MS = 2_147_483_647;

export function boundedSignal(ms: number, parent?: AbortSignal): AbortSignal {
  if (parent?.aborted) return parent;
  if (ms === Infinity) return parent ?? new AbortController().signal;
  const timeout = new AbortController();
  const fire = () => timeout.abort(new DOMException("The operation was aborted due to timeout", "TimeoutError"));
  if (!(ms > 0)) fire();
  else {
    const timer = setTimeout(fire, Math.min(ms, MAX_TIMER_MS));
    timer.unref?.();
  }
  return parent ? AbortSignal.any([parent, timeout.signal]) : timeout.signal;
}

/**
 * One clock for confirmation, job drain and hub stop. Cancellation shortens even a wait already in progress.
 * Exposes `remaining()`/`signal` (`SETTLE_MARGIN_MS`) for normal settlement and `confirmRemaining()`/`confirmSignal`
 * (`KILL_CONFIRM_MARGIN_MS`) for process-table kill confirmation.
 */
export function settlementBudget(workMs: number, cancel?: AbortSignal, now = () => performance.now()) {
  const workDeadline = now() + Math.max(0, workMs);
  let deadline = workDeadline + SETTLE_MARGIN_MS;
  let confirmDeadline = workDeadline + KILL_CONFIRM_MARGIN_MS;
  const controller = new AbortController();
  const confirmController = new AbortController();
  const remaining = () => Math.max(0, deadline - now());
  const confirmRemaining = () => Math.max(0, confirmDeadline - now());
  const expire = () => controller.abort();
  const expireConfirm = () => confirmController.abort();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let confirmTimer: ReturnType<typeof setTimeout> | undefined;
  const arm = () => {
    clearTimeout(timer);
    const ms = remaining();
    if (ms <= 0) expire();
    else {
      timer = setTimeout(expire, Math.min(ms, MAX_TIMER_MS));
      timer.unref?.();
    }
    clearTimeout(confirmTimer);
    const confirmMs = confirmRemaining();
    if (confirmMs <= 0) expireConfirm();
    else {
      confirmTimer = setTimeout(expireConfirm, Math.min(confirmMs, MAX_TIMER_MS));
      confirmTimer.unref?.();
    }
  };
  const onCancel = () => {
    const current = now();
    deadline = Math.min(deadline, current + SETTLE_MARGIN_MS);
    confirmDeadline = Math.min(confirmDeadline, current + KILL_CONFIRM_MARGIN_MS);
    arm();
  };
  if (cancel?.aborted) onCancel();
  else {
    arm();
    cancel?.addEventListener("abort", onCancel, { once: true });
  }
  return {
    now,
    workDeadline,
    remaining,
    signal: controller.signal,
    confirmRemaining,
    confirmSignal: confirmController.signal,
    dispose() {
      clearTimeout(timer);
      clearTimeout(confirmTimer);
      cancel?.removeEventListener("abort", onCancel);
    }
  };
}
export type SettlementBudget = ReturnType<typeof settlementBudget>;

/** Stop waiting even if a dependency cannot acknowledge cancellation. Its owner still initiates cleanup. */
export function untilAborted<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}
