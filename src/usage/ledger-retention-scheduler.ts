import { getUsageLedgerRetentionStatus } from "./ledger-retention-config";
import { requestUsageLedgerRetentionRun } from "./ledger-retention-job";

const DEFAULT_INTERVAL_MS = 60_000;
let timer: ReturnType<typeof setInterval> | null = null;
let startupTimer: ReturnType<typeof setTimeout> | null = null;

/** Request one background run only when the current persisted policy is enabled and over limit. */
function requestIfOverLimit(): void {
  try {
    const status = getUsageLedgerRetentionStatus();
    if (!status.enabled || !status.overLimit) return;
    requestUsageLedgerRetentionRun();
  } catch {
    // A later tick retries; scheduler failures never block the proxy.
  }
}

/** Poll only metadata on the main thread; file scanning/copying stays in the Worker job. */
export function startUsageLedgerRetentionScheduler(intervalMs = DEFAULT_INTERVAL_MS): void {
  if (timer) return;
  timer = setInterval(requestIfOverLimit, intervalMs);
  timer.unref?.();
}

/** Evaluate once after listeners bind so oversized ledgers are handled after startup. */
export function scheduleUsageLedgerRetentionStartupRun(): void {
  if (startupTimer) return;
  startupTimer = setTimeout(() => {
    startupTimer = null;
    requestIfOverLimit();
  }, 0);
  startupTimer.unref?.();
}

/** Stop both periodic and pending startup evaluations without touching an active Worker. */
export function stopUsageLedgerRetentionScheduler(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  if (startupTimer) {
    clearTimeout(startupTimer);
    startupTimer = null;
  }
}
