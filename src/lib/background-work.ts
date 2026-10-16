/**
 * Fire-and-forget work the process started and nobody awaits.
 *
 * A lazy quota prime or a startup reconcile is deliberately left running behind a
 * request so the request never waits on it. The work still owns files: the pool
 * prime holds the native-main claim database open across ACL hardening and a WHAM
 * read. Whoever later removes the directory those files live in has to wait for the
 * owner. Without a handle on the work there was nothing to wait for: test teardown
 * spun a synchronous retry loop, which blocks the very event loop the owner needs to
 * reach its `finally` and close the file. On Windows every overlap became a 15 s EBUSY.
 *
 * Registering costs one Set entry per in-flight task and changes nothing about how
 * the work runs. Settling is opt-in: test teardown calls it; requests never do.
 */

interface BackgroundWork {
  readonly label: string;
  readonly settled: Promise<void>;
}

const inFlight = new Set<BackgroundWork>();

/** Record `work` until it settles and return it unchanged. Rejections stay the caller's. */
export function trackBackgroundWork<T>(label: string, work: Promise<T>): Promise<T> {
  const entry: BackgroundWork = {
    label,
    settled: work.then(() => { inFlight.delete(entry); }, () => { inFlight.delete(entry); }),
  };
  inFlight.add(entry);
  return work;
}

/** Labels of work still running, for diagnostics. */
export function pendingBackgroundWork(): string[] {
  return [...inFlight].map(entry => entry.label);
}

export interface BackgroundWorkSettlement {
  readonly settled: boolean;
  readonly pending: string[];
}

/**
 * Wait until no tracked work is in flight, including work started by work that was
 * already running. A bounded wait reports what is still running instead of throwing,
 * so the caller decides whether that is fatal.
 */
export async function settleBackgroundWork(options: { timeoutMs?: number } = {}): Promise<BackgroundWorkSettlement> {
  const deadline = options.timeoutMs === undefined ? Infinity : Date.now() + options.timeoutMs;
  while (inFlight.size > 0) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    const batch = Promise.all([...inFlight].map(entry => entry.settled)).then(() => false);
    if (remaining === Infinity) {
      await batch;
      continue;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(true), remaining); });
    const timedOut = await Promise.race([batch, expired]);
    clearTimeout(timer);
    if (timedOut) break;
  }
  return { settled: inFlight.size === 0, pending: pendingBackgroundWork() };
}
