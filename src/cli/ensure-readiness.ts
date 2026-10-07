/**
 * Readiness wait for a proxy this process just asked to start.
 *
 * ocx ensure spawns a detached ocx start and returns once this home's proxy answers.
 * It used to give up after a flat 8 s. A cold start can take longer than that on a
 * busy Windows host (Windows CI measured 10-45 s for the first proxy child of a
 * batch), so ensure reported "did not become healthy" for a proxy that came up
 * moments later, and the Codex shim or autostart that called it saw a failure.
 *
 * The wait is now as long as the service start's follow-up (40 s) while the
 * spawned child is alive. A child that has exited keeps the old 8 s bound, so a
 * start that failed outright is reported no later than before.
 */

export const ENSURE_READY_TIMEOUT_MS = 40_000;
export const ENSURE_EXITED_CHILD_TIMEOUT_MS = 8_000;
const POLL_MS = 150;

export interface LiveProxyWaitOptions<T> {
  find: () => Promise<T | null>;
  timeoutMs: number;
  /** Return false to stop polling early; one observation is always made first. */
  keepWaiting?: () => boolean;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export async function waitForLiveProxy<T>(options: LiveProxyWaitOptions<T>): Promise<T | null> {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)));
  const deadline = now() + options.timeoutMs;
  while (now() < deadline) {
    const live = await options.find();
    if (live) return live;
    if (options.keepWaiting && !options.keepWaiting()) return null;
    await sleep(POLL_MS);
  }
  return null;
}

/** Keep waiting while the spawned child lives; once it exits, only inside the old 8 s bound. */
export function ensureKeepWaiting(
  spawnedAt: number,
  childExited: () => boolean,
  now: () => number = Date.now,
): () => boolean {
  return () => !childExited() || now() - spawnedAt < ENSURE_EXITED_CHILD_TIMEOUT_MS;
}
