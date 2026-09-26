import type { AdapterFetchContext } from "./base";
import type { SendClass } from "../lib/request-execution-budget";
import type { AttemptRecoveryKind } from "../usage/log";
import { abortError, SendBudgetExhaustedError } from "../lib/upstream-retry";
import {
  releaseProviderRequestSlot,
  sendTrackingRequestSlot,
  type ProviderRequestSlot,
} from "../providers/request-pacing";

type PacedFetch = typeof globalThis.fetch & {
  waitForPacing?: (signal?: AbortSignal) => Promise<ProviderRequestSlot | void>;
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
    /** Runs only after admission, e.g. backoff and cancellation of a superseded response. */
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
    let slot: ProviderRequestSlot | undefined;
    try {
      slot = (await executor.waitForPacing?.(ctx.abortSignal)) || undefined;
      if (ctx.abortSignal?.aborted) throw abortError(ctx.abortSignal);
      await options.beforeDispatch?.();
      if (ctx.abortSignal?.aborted) throw abortError(ctx.abortSignal);
      return await sendTrackingRequestSlot(slot, () => options.dispatch(physicalExecutor));
    } finally {
      releaseProviderRequestSlot(slot);
      permit?.release();
    }
  };
}
