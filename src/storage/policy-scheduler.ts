/**
 * Long-running schedule tick for daily/weekly storage cleanup policies.
 * Unref'd interval — never keeps the process alive alone (safe for tests).
 * Startup kickoff is tracked here so shutdown can cancel it.
 */
import { maybeRequestStorageCleanupPolicyRun } from "./policy-job";

const DEFAULT_INTERVAL_MS = 60 * 60 * 1000; // 1h

let timer: ReturnType<typeof setInterval> | null = null;
let startupTimer: ReturnType<typeof setTimeout> | null = null;

export function startStorageCleanupScheduler(intervalMs = DEFAULT_INTERVAL_MS): void {
  if (timer) return;
  timer = setInterval(() => {
    maybeRequestStorageCleanupPolicyRun("schedule");
  }, intervalMs);
  timer.unref?.();
}

/** Fire-and-forget startup evaluation; cancellable via stopStorageCleanupScheduler. */
export function scheduleStorageCleanupStartupRun(): void {
  if (startupTimer) return;
  startupTimer = setTimeout(() => {
    startupTimer = null;
    maybeRequestStorageCleanupPolicyRun("startup");
  }, 0);
  startupTimer.unref?.();
}

export function stopStorageCleanupScheduler(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  if (startupTimer) {
    clearTimeout(startupTimer);
    startupTimer = null;
  }
}
