import { formatErrorResponse } from "../../bridge";
import { markProxyError } from "../../lib/client-error-body";
import type { PhysicalSendReporter } from "../../lib/request-execution-budget";
import { SendBudgetExhaustedError } from "../../lib/upstream-retry";
import type { RequestLogContext } from "../request-log";
import { workflowSendCeilingRefusalResponse, workflowRefusalResponse } from "../workflow-refusal";
import { NativeContinuationRefusalError } from "./native-continuation-refusal";
import type { RequestSpendTracker } from "./request-spend";

/** Claim one successor's physical start; never borrow an initial or recovery receipt. */
export function claimNativeContinuationSend(reporter: PhysicalSendReporter, logCtx: RequestLogContext, rootId?: string): void {
  const tracker = logCtx.spendTracker as RequestSpendTracker | undefined;
  const before = tracker?.refusals ?? 0;
  try {
    if (reporter.beforeSend?.() === false) {
      const denied = tracker && tracker.refusals > before ? tracker.lastRefusal : undefined;
      const refusal = (denied ? workflowRefusalResponse(denied.reason, logCtx, undefined, undefined, denied.spend) : undefined)
        ?? workflowSendCeilingRefusalResponse(logCtx, rootId)
        ?? markProxyError(formatErrorResponse(429, "request_send_budget_exhausted", new SendBudgetExhaustedError().message));
      throw new NativeContinuationRefusalError(refusal);
    }
    reporter(1);
  } finally { reporter.close?.(); }
}
