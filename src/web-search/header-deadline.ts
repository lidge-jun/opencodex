import { clearableDeadline, registerResponseHeaderPause } from "../lib/abort";
import { inheritAdapterSupportExecutor } from "../lib/executor-physical-send-receipt";
import { sendTrackingRequestSlot } from "../providers/request-pacing";
import type { ProviderFetch } from "../server/responses/fetch-helpers";

/** One iteration's cumulative header budget; pacing and bounded post-header body inspection pause its clock. */
export function pacingHeaderDeadline(timeoutMs: number, parent: AbortSignal) {
  const disabled = timeoutMs <= 0;
  const controller = new AbortController();
  const signal = AbortSignal.any([parent, controller.signal]);
  let remainingMs = timeoutMs;
  let armedAt = performance.now();
  let current = clearableDeadline(remainingMs, parent);
  const timeoutReason = current.timeoutReason;
  let pacingWaits = 0;
  let cleared = false;
  const relayExpiry = () => {
    if (current.didExpire()) controller.abort(timeoutReason);
  };
  current.signal.addEventListener("abort", relayExpiry, { once: true });

  const pause = () => {
    if (disabled || cleared || pacingWaits++ > 0) return;
    remainingMs = Math.max(0, remainingMs - (performance.now() - armedAt));
    current.clear();
    current.signal.removeEventListener("abort", relayExpiry);
    // A delayed timer task must not let an already-spent budget escape into the queue.
    if (remainingMs === 0 && !signal.aborted) controller.abort(timeoutReason);
  };
  const resume = () => {
    if (disabled || cleared || --pacingWaits > 0 || signal.aborted) return;
    armedAt = performance.now();
    current = clearableDeadline(remainingMs, parent);
    current.signal.addEventListener("abort", relayExpiry, { once: true });
  };
  const unregister = registerResponseHeaderPause(signal, () => { pause(); return resume; });

  return {
    signal,
    didExpire: () => signal.aborted && signal.reason === timeoutReason,
    clear: () => {
      cleared = true;
      unregister();
      current.clear();
      current.signal.removeEventListener("abort", relayExpiry);
    },
    /** Preserve the pacing seams used by adapter physical-send helpers, without double admission. */
    pacedFetch(executor: typeof globalThis.fetch, onDispatch?: () => void): typeof globalThis.fetch {
      const pacing = executor as ProviderFetch;
      if (!pacing.waitForPacing) {
        if (!onDispatch) return executor;
        return ((input, init) => {
          signal.throwIfAborted();
          init?.signal?.throwIfAborted();
          onDispatch();
          return executor(input, init);
        }) as typeof globalThis.fetch;
      }
      const waitForPacing: NonNullable<ProviderFetch["waitForPacing"]> = async (sendSignal) => {
        pause();
        try {
          return await pacing.waitForPacing!(sendSignal ? AbortSignal.any([signal, sendSignal]) : signal);
        } finally {
          resume();
        }
      };
      const unpacedFetch = pacing.unpacedFetch ?? executor;
      const wrapped = async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        const slot = await waitForPacing(init?.signal ?? undefined);
        return sendTrackingRequestSlot(slot, () => {
          signal.throwIfAborted();
          init?.signal?.throwIfAborted();
          onDispatch?.();
          return unpacedFetch(input, init);
        });
      };
      const paced = Object.assign(wrapped, { preconnect: executor.preconnect, waitForPacing, unpacedFetch }) as ProviderFetch;
      return inheritAdapterSupportExecutor(paced, executor);
    },
  };
}
