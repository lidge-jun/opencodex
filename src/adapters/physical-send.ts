import type { AdapterFetchContext } from "./base";
import type { SendClass } from "../lib/request-execution-budget";
import type { AttemptRecoveryKind } from "../usage/log";
import { abortError, SendBudgetExhaustedError } from "../lib/upstream-retry";
import { trackProviderRequestSlotBody, type ProviderRequestSlot } from "../providers/request-pacing";

type PacedFetch = typeof globalThis.fetch & {
  waitForPacing?: (signal?: AbortSignal) => Promise<ProviderRequestSlot | undefined>;
  unpacedFetch?: typeof globalThis.fetch;
};

/** One ordinal sequence per adapter fetchResponse call, across all of its inference retries.
 * Consumption starts at underlying executor invocation; its own later preflight may still fail. */
export function createAdapterPhysicalSend(ctx: AdapterFetchContext = {}, fallback = globalThis.fetch) {
  const executor = (ctx.executor ?? fallback) as PacedFetch;
  let ordinal = 0;
  return async (options: {
    url: string;
    sendClass?: SendClass;
    recovery?: AttemptRecoveryKind;
    /** Runs before admission, ahead of the pacing wait: drop resources that hold the
     * very lease this send would otherwise queue behind, e.g. cancel a superseded
     * response body. A budget refusal precedes it, so a refused replay can still
     * return the parked response intact. */
    beforeAdmission?: () => void | Promise<void>;
    /** Runs only after admission, e.g. backoff and credential refresh. Cancelling a
     * superseded response belongs in beforeAdmission: behind waitForPacing it queues
     * behind the very lease it would release (a concurrency cap of one self-deadlocks). */
    beforeDispatch?: () => void | Promise<void>;
    dispatch: (executor: typeof globalThis.fetch) => Promise<Response>;
  }): Promise<Response> => {
    if (ctx.abortSignal?.aborted) throw abortError(ctx.abortSignal);
    const decision = ctx.sendBudget?.reserveDispatch({
      sendClass: options.sendClass ?? "transient", targetKey: options.url,
    });
    if (decision && !decision.allowed) throw new SendBudgetExhaustedError(options.url);
    const permit = decision?.allowed ? decision.permit : undefined;
    let dispatched = false;
    const physicalExecutor = (async (input, init) => {
      if (ctx.abortSignal?.aborted) throw abortError(ctx.abortSignal);
      if (init?.signal?.aborted) throw abortError(init.signal);
      if (dispatched || (permit && !permit.use())) throw new SendBudgetExhaustedError(options.url);
      dispatched = true;
      ordinal += 1;
      ctx.onPhysicalSend?.({ ordinal, ...(options.recovery ? { recovery: options.recovery } : {}) });
      return (executor.unpacedFetch ?? executor)(input, init);
    }) as typeof globalThis.fetch;
    let pacingSlot: ProviderRequestSlot | undefined;
    try {
      // Admission must not queue behind a lease this caller is about to drop: the retry
      // ladders park a retryable response and cancel it here, before the wait, while
      // beforeDispatch keeps its post-admission semantics (backoff, credential refresh,
      // refused-replay contracts). With the cancel sitting behind waitForPacing, a cap of
      // one self-deadlocks: the parked body holds the only lease the next attempt needs.
      await options.beforeAdmission?.();
      if (ctx.abortSignal?.aborted) throw abortError(ctx.abortSignal);
      pacingSlot = await executor.waitForPacing?.(ctx.abortSignal);
      if (ctx.abortSignal?.aborted) throw abortError(ctx.abortSignal);
      await options.beforeDispatch?.();
      if (ctx.abortSignal?.aborted) throw abortError(ctx.abortSignal);
      return trackProviderRequestSlotBody(pacingSlot, await options.dispatch(physicalExecutor));
    } catch (error) {
      pacingSlot?.release();
      throw error;
    } finally {
      permit?.release();
    }
  };
}
