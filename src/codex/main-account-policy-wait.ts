import {
  isMainAccountPolicyBindingPending,
  waitForNativeMainStartupGate,
} from "./native-profile-startup";

/**
 * How long a request waits for an owned startup to finish binding the main-account policy
 * before it is refused as draining.
 *
 * `codexMainAccountHardLock` is on by default (#5694), so the admission fence beside this
 * constant is no longer an opt-in rarity: every request that arrives while a process-owned
 * startup is still recovering, sweeping stages, and binding the pinned home lands on it. That
 * window is milliseconds on a warm Linux host and seconds on Windows, which is why the fence
 * waits for the gate instead of failing the request the moment it arrives.
 *
 * 15 s is deliberately just above one startup claim wait: both exclusive claims
 * (`withNativeMainExclusiveClaim` in `convergeOwnedStartup`) allow 10 s before they give up, so a
 * request that arrived during the last claim is not refused in the instant before the gate would
 * have opened. Anything longer stops being a courtesy to the client and starts being a hung
 * request, and a gate still blocked after this leaves a real answer -- retained recovery or a
 * manual-recovery requirement -- where waiting cannot help, which is what the draining error says.
 */
export const MAIN_ACCOUNT_POLICY_BINDING_WAIT_MS = 15_000;

/**
 * Repoll interval for the one window where the settle promise is already resolved and the gate
 * still reads pending: a manual-recovery fence publishes a resolved promise while an in-flight
 * convergence is still marked pending, and re-awaiting that same resolved promise would spin the
 * microtask queue -- which never lets the deadline timer fire.
 */
const MAIN_ACCOUNT_POLICY_BINDING_REPOLL_MS = 25;

export interface MainAccountPolicyBindingWait {
  /** Ends the wait with the signal's reason, as an aborted request must. */
  signal?: AbortSignal;
  /** Overrides {@link MAIN_ACCOUNT_POLICY_BINDING_WAIT_MS} for a bounded focused test. */
  timeoutMs?: number;
}

/**
 * Wait, bounded, for an owned startup's main-account policy binding to settle.
 *
 * Returns `true` once the binding is no longer pending, `false` when the deadline passed with it
 * still in flight. Callers fail closed on `false`; the gate itself is re-read every iteration
 * because a rearm replaces the settle promise rather than resolving the one already held.
 */
export async function waitForMainAccountPolicyBinding(
  wait: MainAccountPolicyBindingWait = {},
): Promise<boolean> {
  const signal = wait.signal;
  const timeoutMs = Math.max(0, wait.timeoutMs ?? MAIN_ACCOUNT_POLICY_BINDING_WAIT_MS);
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (!isMainAccountPolicyBindingPending()) return true;
    const remaining = deadline - Date.now();
    if (remaining <= 0) return false;
    const settledNow = await raceSettle(waitForNativeMainStartupGate(), remaining, signal);
    // Settling does not always clear the flag: the gate may have been rearmed, or the resolved
    // promise above may belong to a fence that never released the entry. Yield to the event loop
    // before asking again so this stays a poll rather than a busy-wait.
    if (settledNow && isMainAccountPolicyBindingPending()) {
      await pause(Math.min(remaining, MAIN_ACCOUNT_POLICY_BINDING_REPOLL_MS), signal);
    }
  }
}

/** `true` when the settle promise resolved first, `false` on the deadline. */
async function raceSettle(
  settle: Promise<unknown>,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<boolean> {
  if (signal?.aborted) throw signal.reason;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const deadline = new Promise<boolean>(resolve => {
    timer = setTimeout(() => resolve(false), timeoutMs);
    // A request waiting on a startup gate must never be the reason the process stays alive.
    timer.unref?.();
  });
  const aborted = new Promise<never>((_resolve, reject) => {
    if (!signal) return;
    onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort);
  });
  try {
    // A rejected settle is not an error here: the loop re-reads the gate and decides.
    return await Promise.race([settle.then(() => true, () => true), deadline, aborted]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (signal && onAbort) signal.removeEventListener("abort", onAbort);
  }
}

/** One short, abortable, unref'd yield so the loop cannot monopolize the microtask queue. */
function pause(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(signal.reason);
  return new Promise<void>((resolve, reject) => {
    const finish = (settle: () => void) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      settle();
    };
    const timer = setTimeout(() => finish(resolve), ms);
    timer.unref?.();
    const onAbort = () => finish(() => reject(signal?.reason));
    signal?.addEventListener("abort", onAbort);
  });
}
