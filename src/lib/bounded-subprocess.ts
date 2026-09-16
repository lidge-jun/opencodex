export interface KillableSubprocess {
  exited: Promise<number>;
  kill(): unknown;
  unref?(): unknown;
}

export interface BoundedSubprocessExit {
  exitCode: number | null;
  timedOut: boolean;
}

/**
 * How long to wait for a killed child to actually be reaped before abandoning it.
 *
 * `kill()` only REQUESTS termination. It returns before the kernel has torn the process down, and
 * every handle that process holds stays held until it does. On Windows that is not a detail: file
 * locking is mandatory, so a directory an abandoned `icacls.exe` still has open cannot be removed
 * by anyone, and the removal fails with EPERM rather than waiting.
 */
export const SUBPROCESS_KILL_GRACE_MS = 2_000;

/**
 * Wait for a child, bounded. At the deadline, kill it AND wait for it to actually die.
 *
 * This used to kill, `unref`, and resolve in the same tick, which made every caller's "I waited
 * for my child" guarantee false precisely when it mattered. `flushConfigDirHardening` exists so
 * shutdown owns every `icacls.exe` it started; it awaited a promise that had already settled while
 * the child was still alive, so the contract read as satisfied and the directory stayed locked.
 *
 * That cost three failed fixes. #4789 blamed the removal retry budget and asked for more than
 * 2.5s; #4796 gave it a 15s exponential schedule; a later change awaited the hardening flight from
 * the test hook. Windows shard 1/6 failed identically through all three, because none of them
 * addressed a live process holding the handle -- run 35108652486 burned the full 15s budget and
 * still threw `EPERM ... rm ocx-management-auth-fDchUb`, with two
 * `ACL hardening timed out (ETIMEDOUT) - transient icacls stall` lines logged beside it.
 *
 * The grace is bounded and abandonment is still the fallback, so a genuinely unkillable child
 * cannot hang shutdown. The classification does not move: a child that missed its deadline is
 * reported as timed out whether or not it dies during the grace, because it did time out. Only the
 * moment of resolution changes.
 */
export function waitForSubprocessExit(
  proc: KillableSubprocess,
  timeoutMs: number,
  killGraceMs: number = SUBPROCESS_KILL_GRACE_MS,
): Promise<BoundedSubprocessExit> {
  return new Promise(resolve => {
    let settled = false;
    let deadlineFired = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let graceTimer: ReturnType<typeof setTimeout> | undefined;
    const finish = (result: BoundedSubprocessExit): void => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      if (graceTimer !== undefined) clearTimeout(graceTimer);
      resolve(result);
    };
    timer = setTimeout(() => {
      deadlineFired = true;
      try { proc.kill(); } catch { /* already exited */ }
      graceTimer = setTimeout(() => {
        // The child outlived its own kill. Abandon it -- but only now, and only after having
        // given the OS a real chance to release what it holds.
        try { proc.unref?.(); } catch { /* abandonment is still authoritative */ }
        finish({ exitCode: null, timedOut: true });
      }, Math.max(1, killGraceMs));
    }, Math.max(1, timeoutMs));
    void proc.exited.then(
      exitCode => finish(deadlineFired
        ? { exitCode: null, timedOut: true }
        : { exitCode, timedOut: false }),
      () => finish({ exitCode: null, timedOut: deadlineFired }),
    );
  });
}
