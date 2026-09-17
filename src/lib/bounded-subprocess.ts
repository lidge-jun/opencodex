export interface KillableSubprocess {
  exited: Promise<number>;
  kill(): unknown;
  unref?(): unknown;
}

export interface BoundedSubprocessExit {
  exitCode: number | null;
  timedOut: boolean;
}

export type SubprocessDeadlineScheduler = (
  callback: () => void,
  milliseconds: number,
) => () => void;

const scheduleDeadline: SubprocessDeadlineScheduler = (callback, milliseconds) => {
  const timer = setTimeout(callback, milliseconds);
  return () => clearTimeout(timer);
};

/**
 * Compatibility allowance used by the ACL runner's outer watchdog.
 *
 * `kill()` only REQUESTS termination. It returns before the kernel has torn the process down, and
 * every handle that process holds stays held until it does. On Windows that is not a detail: file
 * locking is mandatory, so a directory an abandoned `icacls.exe` still has open cannot be removed
 * by anyone, and the removal fails with EPERM rather than waiting.
 */
export const SUBPROCESS_KILL_GRACE_MS = 2_000;

/**
 * Wait for a child until the deadline. At the deadline, kill it AND wait for it to actually die.
 *
 * This used to kill, `unref`, and resolve in the same tick, which made every caller's "I waited
 * for my child" guarantee false precisely when it mattered. The ACL runner now waits here until
 * actual exit; if its separate caller-facing belt fires first, that layer registers the target so
 * removal can wait for the reap without making ordinary startup or shutdown unbounded.
 *
 * That cost three failed fixes. #4789 blamed the removal retry budget and asked for more than
 * 2.5s; #4796 gave it a 15s exponential schedule; a later change awaited the hardening flight from
 * the test hook. Windows shard 1/6 failed identically through all three, because none of them
 * addressed a live process holding the handle -- run 35108652486 burned the full 15s budget and
 * still threw `EPERM ... rm ocx-management-auth-fDchUb`, with two
 * `ACL hardening timed out (ETIMEDOUT) - transient icacls stall` lines logged beside it.
 *
 * The old grace still abandoned a live child after two seconds. That recreated the same false
 * ownership contract on a slower clock: the ACL flight settled, cleanup removed the directory,
 * and Windows returned EPERM because the child still held it. A handle-bearing caller therefore
 * has no second deadline after kill. The child's actual exit is the only release signal.
 *
 * Pass `0` to opt out for a child that holds no path anyone will remove. The numeric form is kept
 * for compatibility with the existing callers; any positive value means that reaping is required.
 * The injected scheduler is a test seam so deadline and exit ordering can be proved without sleep.
 */
export function waitForSubprocessExit(
  proc: KillableSubprocess,
  timeoutMs: number,
  reapAfterKill: number = SUBPROCESS_KILL_GRACE_MS,
  schedule: SubprocessDeadlineScheduler = scheduleDeadline,
): Promise<BoundedSubprocessExit> {
  return new Promise(resolve => {
    let settled = false;
    let deadlineFired = false;
    let cancelDeadline: (() => void) | undefined;
    const finish = (result: BoundedSubprocessExit): void => {
      if (settled) return;
      settled = true;
      cancelDeadline?.();
      resolve(result);
    };
    const reaped = proc.exited.then(
      exitCode => finish(deadlineFired
        ? { exitCode: null, timedOut: true }
        : { exitCode, timedOut: false }),
      () => finish({ exitCode: null, timedOut: deadlineFired }),
    );
    cancelDeadline = schedule(() => {
      deadlineFired = true;
      try { proc.kill(); } catch { /* already exited */ }
      if (reapAfterKill <= 0) {
        try { proc.unref?.(); } catch { /* abandonment is still authoritative */ }
        finish({ exitCode: null, timedOut: true });
        return;
      }
    }, Math.max(1, timeoutMs));
  });
}
