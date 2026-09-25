import { createRequestExecutionBudget, type RequestExecutionBudget } from "../../lib/request-execution-budget";
import type { RequestLogContext } from "../request-log";
import { attachRequestSpendTracker } from "../responses/request-spend";

/**
 * The one construction of an ingress-owned send budget: the default guarded policy, no logical
 * request id, and this request's spend tracker as the send observer. Attaching the tracker
 * parks it on `logCtx`, so callers that inherit a holder must not call this at all.
 */
export function createInferenceSendBudget(
  req: Pick<Request, "headers">,
  logCtx: RequestLogContext,
): RequestExecutionBudget {
  return createRequestExecutionBudget(undefined, undefined, attachRequestSpendTracker(req, logCtx));
}
