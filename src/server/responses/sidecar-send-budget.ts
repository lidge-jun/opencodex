import type { IncomingMeta, ProviderAdapter } from "../../adapters/base";
import type { HandleResponsesOptions } from "./core-options";
import type { ResponsesSendBudget } from "./request-send-budget";
import type { ProviderFetchOptions } from "./fetch-helpers";
import type { SingleUseDispatchPermit } from "../../lib/request-execution-budget";

/** Hosted inference consumes the same child-owned booking as ordinary dispatch. */
export function createSidecarSendBudget(
  options: HandleResponsesOptions,
  budget: Pick<ResponsesSendBudget, "adapterDispatchBudget" | "noteInitialDispatch" | "noteAdapterPhysicalSend" | "noteAdapterRecoveryWithheld" | "pendingHopPermit">,
  inputTokens: () => number | undefined,
) {
  const initial = options.comboInitialSend;
  let hopPermit: SingleUseDispatchPermit | undefined;
  let producerActive = false;
  /** Detach this owner’s hop before refunding its still-unused reservation. */
  const releaseHop = (): void => {
    const permit = hopPermit;
    hopPermit = undefined;
    if (budget.pendingHopPermit === permit) budget.pendingHopPermit = undefined;
    permit?.release();
  };
  return {
    /** Retain a Combo hop until dispatch; direct requests keep eager settlement. */
    ownCredentialHop(permit?: SingleUseDispatchPermit): void {
      if (!initial) { permit?.use(); return; } // Preserve direct callers' reporting contract.
      releaseHop();
      hopPermit = permit;
      budget.pendingHopPermit = permit;
    },
    // Adapter-owned transports settle through the live dispatch view, not an HTTP receipt too.
    incomingMeta: initial ? {
      comboAttempt: options.comboAttempt === true,
      sendBudget: budget.adapterDispatchBudget,
      onPhysicalSend: send => budget.noteAdapterPhysicalSend(inputTokens(), send),
      onRecoveryWithheld: budget.noteAdapterRecoveryWithheld,
    } satisfies Partial<IncomingMeta> : {},
    /** Attach HTTP receipts only when the adapter does not own physical dispatch. */
    fetchOptions(adapter: ProviderAdapter): Pick<ProviderFetchOptions, "onPhysicalDispatch"> {
      return initial && !adapter.fetchResponse && !adapter.runTurn
        ? { onPhysicalDispatch: () => {
          const prepaid = budget.pendingHopPermit;
          budget.pendingHopPermit = undefined;
          budget.noteInitialDispatch(prepaid);
        } } : {};
    },
    /** Transfer cleanup to the asynchronous producer before it can outlive the response. */
    takeProducerOwnership(): void {
      if (initial) { initial.producerOwned = true; producerActive = true; }
    },
    /** Release unused bookings only after the owning producer has settled. */
    release(): void {
      initial?.permit.release(); producerActive = false; releaseHop();
    },
    /** An iteration may finish before runTurn; defer its refund while that producer is active. */
    releaseUnsentHop(): void { if (!producerActive) releaseHop(); },
  };
}
