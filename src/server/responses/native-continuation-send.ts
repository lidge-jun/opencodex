import { formatErrorResponse } from "../../bridge";
import { markProxyError } from "../../lib/client-error-body";
import type { PhysicalSendReporter } from "../../lib/request-execution-budget";
import { SendBudgetExhaustedError } from "../../lib/upstream-retry";
import type { RequestLogContext } from "../request-log";
import { unboundPoolSpendRefusalResponse, workflowSendCeilingRefusalResponse } from "../workflow-refusal";
import { NativeContinuationRefusalError } from "./native-continuation-refusal";

/** Claim one successor's physical start; never borrow an initial or recovery receipt. */
export function claimNativeContinuationSend(reporter: PhysicalSendReporter, logCtx: RequestLogContext, rootId?: string): void {
  try {
    if (reporter.beforeSend?.() === false) {
      const refusal = workflowSendCeilingRefusalResponse(logCtx, rootId)
        ?? unboundPoolSpendRefusalResponse(logCtx)
        ?? markProxyError(formatErrorResponse(429, "request_send_budget_exhausted", new SendBudgetExhaustedError().message));
      throw new NativeContinuationRefusalError(refusal);
    }
    reporter(1);
  } finally { reporter.close?.(); }
}
