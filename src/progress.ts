import type { QueuePosition } from "./heavyslots.js";

export interface ProgressNotification {
  method: "notifications/progress";
  params: {
    progressToken: string | number;
    progress: number;
    message?: string;
  };
}

export interface ProgressExtra {
  _meta?: { progressToken?: string | number };
  sendNotification?: (notification: ProgressNotification) => Promise<void>;
}

/**
 * Emits MCP `notifications/progress` heartbeats on a fixed interval while `work` is running
 * when the caller supplied a progress token. Errors from `sendNotification` are ignored, and
 * no notification is emitted after `work` settles.
 */
export async function withProgressHeartbeat<T>(
  extra: ProgressExtra | undefined,
  work: (onQueue: (queue?: QueuePosition) => void) => Promise<T>,
  options: { intervalMs?: number } = {}
): Promise<T> {
  const progressToken = extra?._meta?.progressToken;
  // Any string (the empty string too) or number is a valid MCP progress token.
  if ((typeof progressToken !== "string" && typeof progressToken !== "number") || typeof extra?.sendNotification !== "function") {
    return work(() => {});
  }
  const intervalMs = options.intervalMs ?? 15_000;
  const sendNotification = extra.sendNotification;
  let queue: QueuePosition | undefined;
  let progress = 0;
  let settled = false;
  const startedAt = Date.now();
  const timer = setInterval(() => {
    if (settled) return;
    progress++;
    const elapsedSec = Math.round((Date.now() - startedAt) / 1000);
    try {
      Promise.resolve(sendNotification({
        method: "notifications/progress",
        params: {
          progressToken,
          progress,
          message: queue ? `queued for a heavy-run slot: position ${queue.position} of ${queue.total}` : `still running, ${elapsedSec} s elapsed`
        }
      })).catch(() => {});
    } catch {
      // Ignore transport errors so heartbeats never fail the tool call.
    }
  }, intervalMs);
  timer.unref?.();
  try {
    return await work(position => { queue = position; });
  } finally {
    settled = true;
    clearInterval(timer);
  }
}
