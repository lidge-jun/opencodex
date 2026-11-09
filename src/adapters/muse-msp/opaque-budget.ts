import type { IncomingMeta } from "../base";
import type { SingleUseDispatchPermit } from "../../lib/request-execution-budget";
import { SendBudgetExhaustedError } from "../../lib/upstream-retry";
import { MuseMspError } from "./connection";

/**
 * Experimental opaque-segment accounting, NOT physical model-send enforcement.
 * Used for native CLI segment accounting; this does not enforce a physical-send cap.
 */
export function createMuseOpaqueBudgetFence(incoming: IncomingMeta, targetKey: string, ordinal = 1): { admit: () => void; close: () => void } {
  if (!targetKey || Buffer.byteLength(targetKey) > 4096 || !Number.isSafeInteger(ordinal) || ordinal < 1) throw new MuseMspError("invalid_budget_target");
  let called = false, closed = false;
  let producer: { close(): void } | undefined;
  let permit: SingleUseDispatchPermit | undefined;
  return {
    admit() {
      if (called || closed || incoming.abortSignal?.aborted) throw new MuseMspError("cancelled");
      called = true;
      producer = incoming.sendBudget?.beginSpendProducer?.();
      const decision = incoming.sendBudget?.reserveDispatch({ sendClass: "initial", targetKey });
      if (decision && !decision.allowed) throw new SendBudgetExhaustedError();
      permit = decision?.allowed ? decision.permit : undefined;
      incoming.beforePhysicalSend?.();
      if (permit && !permit.use()) throw new SendBudgetExhaustedError();
      incoming.onPhysicalSend?.({ ordinal });
    },
    close() {
      if (closed) return;
      closed = true;
      try { permit?.release(); } finally { producer?.close(); }
    },
  };
}
