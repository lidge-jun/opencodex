import type { AdapterFetchContext } from "./base";
import type { SendClass } from "../lib/request-execution-budget";
import type { AttemptRecoveryKind } from "../usage/log";
import { abortError, SendBudgetExhaustedError } from "../lib/upstream-retry";

type PacedFetch = typeof globalThis.fetch & {
  waitForPacing?: (signal?: AbortSignal) => Promise<void>;
  unpacedFetch?: typeof globalThis.fetch;
};

/** One ordinal sequence per adapter fetchResponse call, across all of its inference retries.
 * Consumption starts at underlying executor invocation; its own later preflight may still fail. */
export function createAdapterPhysicalSend(ctx: AdapterFetchContext = {}, fallback = globalThis.fetch) {
  const executor = (ctx.executor ?? fallback) as PacedFetch;
  let ordinal = 0;
  return async (options: {
    url: string;
    /** Logical model-target identity for the shared request budget. Sidecars on the same relay
     * should reuse the parent target rather than looking like an account/route transition. */
    budgetTargetKey?: string;
    sendClass?: SendClass;
    recovery?: AttemptRecoveryKind;
    /**
     * Optional physical executor for an adapter-owned credential/control sidecar. Pacing and
     * admission still come from the request executor above; only the final HTTP function changes.
     */
    physicalFetch?: typeof globalThis.fetch;
    /** Runs only after admission, e.g. backoff and cancellation of a superseded response. */
    beforeDispatch?: () => void | Promise<void>;
    dispatch: (executor: typeof globalThis.fetch) => Promise<Response>;
  }): Promise<Response> => {
    if (ctx.abortSignal?.aborted) throw abortError(ctx.abortSignal);
    const sendClass = options.sendClass ?? ctx.sendClass ?? "transient";
    const recovery = options.recovery ?? ctx.recovery;
    const decision = ctx.sendBudget?.reserveDispatch({
      sendClass, targetKey: options.budgetTargetKey ?? options.url,
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
      ctx.onPhysicalSend?.({ ordinal, ...(recovery ? { recovery } : {}) });
      return (options.physicalFetch ?? executor.unpacedFetch ?? executor)(input, init);
    }) as typeof globalThis.fetch;
    try {
      await executor.waitForPacing?.(ctx.abortSignal);
      if (ctx.abortSignal?.aborted) throw abortError(ctx.abortSignal);
      await options.beforeDispatch?.();
      if (ctx.abortSignal?.aborted) throw abortError(ctx.abortSignal);
      return await options.dispatch(physicalExecutor);
    } finally {
      permit?.release();
    }
  };
}
