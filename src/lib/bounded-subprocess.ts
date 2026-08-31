export interface KillableSubprocess {
  exited: Promise<number>;
  kill(): unknown;
  unref?(): unknown;
}

export interface BoundedSubprocessExit {
  exitCode: number | null;
  timedOut: boolean;
}

/** Kill at the deadline and abandon immediately; late exit/rejection remains observed. */
export function waitForSubprocessExit(
  proc: KillableSubprocess,
  timeoutMs: number,
): Promise<BoundedSubprocessExit> {
  return new Promise(resolve => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (result: BoundedSubprocessExit): void => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      resolve(result);
    };
    timer = setTimeout(() => {
      try { proc.kill(); } catch { /* already exited */ }
      try { proc.unref?.(); } catch { /* abandonment is still authoritative */ }
      finish({ exitCode: null, timedOut: true });
    }, Math.max(1, timeoutMs));
    void proc.exited.then(
      exitCode => finish({ exitCode, timedOut: false }),
      () => finish({ exitCode: null, timedOut: false }),
    );
  });
}
