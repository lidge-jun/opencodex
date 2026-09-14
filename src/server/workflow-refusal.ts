/**
 * The one place that knows how this proxy refuses a turn on its own workflow budget.
 *
 * It is a module rather than two inline blocks because the two call sites -- the HTTP admission
 * check in `src/server/index.ts` and the pre-dispatch ceiling check in
 * `src/server/responses/core.ts` -- had drifted into saying different things about the same
 * refusal, and because the non-obvious part below has to be stated once and not twice.
 */
import { formatErrorResponse } from "../bridge";
import { markLocalRequestLogRefusal, type RequestLogContext } from "./request-log";
import {
  WORKFLOW_LOCAL_REFUSAL_HEADER,
  workflowDenialSummary,
  type WorkflowDenial,
} from "../lib/workflow-budget";

/**
 * Build the 429 for a refusal this proxy made itself.
 *
 * The status and type arguments below do not reach the client: `classifyError` rewrites every
 * 429 to `rate_limit_error` / `rate_limit_exceeded`, so the body is shaped exactly like a
 * provider rate limit. That is a deliberate wire contract -- changing it would change how every
 * client retries -- which leaves two places to carry the truth. The message names the ceiling
 * that fired and says no provider was contacted, and the header carries the machine-readable
 * name. Nothing upstream sets that header, so its presence is conclusive.
 *
 * When a request-log context exists, the row is additionally marked synthetic through the helper
 * #4639 introduced for the same problem. The HTTP admission check has no context to pass -- it
 * runs before the body is parsed, so there is no model and no provider yet -- which is why that
 * argument is optional rather than required.
 */
export function workflowRefusalResponse(
  reason: WorkflowDenial,
  logCtx?: RequestLogContext,
): Response {
  const summary = workflowDenialSummary(reason);
  if (logCtx) markLocalRequestLogRefusal(logCtx, summary.code);
  const refusal = formatErrorResponse(
    429,
    reason === "workflow-sends-exhausted" ? "workflow_budget_exhausted" : "queue_capacity_exceeded",
    summary.message,
  );
  refusal.headers.set(WORKFLOW_LOCAL_REFUSAL_HEADER, summary.code);
  return refusal;
}
