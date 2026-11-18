import type { AdapterFetchContext } from "./base";
import type { SendClass } from "../lib/request-execution-budget";
import type { AttemptRecoveryKind } from "../usage/log";
import { abortError, SendBudgetExhaustedError, errorDestinationLabel } from "../lib/upstream-retry";
import {
  releaseProviderRequestSlot,
  sendTrackingRequestSlot,
  type ProviderRequestSlot,
} from "../providers/request-pacing";

type PacedFetch = typeof globalThis.fetch & {
  waitForPacing?: (signal?: AbortSignal) => Promise<ProviderRequestSlot | void>;
  unpacedFetch?: typeof globalThis.fetch;
};

export const EXECUTOR_PHYSICAL_SEND_RECEIPT = Symbol("executor physical send receipt");
const receiptExecutors = new WeakSet<typeof globalThis.fetch>();

export function markPhysicalSendReceiptExecutor<T extends typeof globalThis.fetch>(executor: T): T {
  receiptExecutors.add(executor);
  return executor;
}

/** Use the executor's final admission when it owns the transport's remaining guards. */
export function fetchWithPhysicalSendReceipt(
  executor: typeof globalThis.fetch,
  input: Parameters<typeof globalThis.fetch>[0],
  init: RequestInit | undefined,
  receipt: () => void,
): Promise<Response> {
  if (receiptExecutors.has(executor)) {
    return executor(input, { ...init, [EXECUTOR_PHYSICAL_SEND_RECEIPT]: receipt } as RequestInit);
  }
  receipt();
  return executor(input, init);
}

/** One ordinal sequence per adapter fetchResponse call, across all of its inference retries.
 * Consumption starts at the guarded executor receipt. */
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
    if (decision && !decision.allowed) throw new SendBudgetExhaustedError(errorDestinationLabel(options.url));
    const permit = decision?.allowed ? decision.permit : undefined;
    let dispatched = false;
    const physicalExecutor = (async (input, init) => {
      if (ctx.abortSignal?.aborted) throw abortError(ctx.abortSignal);
      if (init?.signal?.aborted) throw abortError(init.signal);
      const receipt = (): void => {
        if (ctx.abortSignal?.aborted) throw abortError(ctx.abortSignal);
        if (init?.signal?.aborted) throw abortError(init.signal);
        if (dispatched || (permit && !permit.use())) throw new SendBudgetExhaustedError(errorDestinationLabel(options.url));
        dispatched = true;
        ordinal += 1;
        ctx.onPhysicalSend?.({ ordinal, ...(options.recovery ? { recovery: options.recovery } : {}) });
      };
      const run = () => fetchWithPhysicalSendReceipt(executor.unpacedFetch ?? executor, input, init, receipt);
      return permit?.execute ? permit.execute(run) : run();
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
