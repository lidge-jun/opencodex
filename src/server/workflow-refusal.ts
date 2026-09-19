/**
 * The one place that knows how this proxy refuses a turn on its own workflow budget.
 *
 * It is a module rather than two inline blocks because the two call sites -- the HTTP admission
 * check in `src/server/index.ts` and the pre-dispatch ceiling check in
 * `src/server/responses/core.ts` -- had drifted into saying different things about the same
 * refusal, and because the non-obvious part below has to be stated once and not twice.
 *
 * The HTTP admission DECISION lives here too, for the same reason: the lane derivation and the
 * refusal it produces are two halves of one answer, and keeping them in one file is what stops
 * a denial from losing the detail that makes it legible on the way out.
 */
import { formatErrorResponse } from "../bridge";
import {
  addFinalRequestLog,
  markLocalRequestLogRefusal,
  type RequestLogContext,
} from "./request-log";
import {
  WORKFLOW_LOCAL_REFUSAL_HEADER,
  admitWorkflowTurn,
  workflowDenialSummary,
  recordWorkflowRefusalEvent,
  type WorkflowDenial,
  type WorkflowDecision,
  type WorkflowLane,
  type WorkflowSpendDenialDetail,
} from "../lib/workflow-budget";

/**
 * What a caller needs to hand over for the refusal to become a row on `/api/logs`.
 *
 * The HTTP admission check refuses before the body is parsed, so its `logCtx` still carries the
 * `unknown` model and provider the caller seeded it with. That is the honest record -- this
 * request genuinely never resolved either -- and it is the same placeholder the native
 * passthrough path already writes. Skipping the row entirely was the worse option: an operator
 * reading the logs saw no trace at all of a request the proxy had refused.
 */
export interface WorkflowRefusalLog {
  readonly requestId: string;
  readonly start: number;
  readonly logCtx: RequestLogContext;
}

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
 * The row is where an operator actually looks, so it gets the same treatment #4639 established:
 * `terminalSource: "synthetic"`, a local reason, and an error code naming the ceiling. Pass
 * `logCtx` when the caller is inside a turn that will write its own row, or `refusalLog` when
 * the refusal happens before any row exists and this is the only chance to write one.
 */
export function workflowRefusalResponse(
  reason: WorkflowDenial,
  logCtx?: RequestLogContext,
  refusalLog?: WorkflowRefusalLog,
  rootId?: string,
  spend?: WorkflowSpendDenialDetail,
): Response {
  // The denial detail, when the caller has it, is what turns "a token ceiling refused this"
  // into "the account ceiling of 100,000 is spent". It reaches the message, the event ring and
  // the log row through this one function, so the three cannot drift into saying different
  // things about the same refusal -- which is what put this module here in the first place.
  const summary = workflowDenialSummary(reason, spend);
  // Only a caller that decided the refusal ITSELF passes a root id. admitWorkflowTurn already
  // records its own denials, so passing one there would double-count them.
  if (rootId) recordWorkflowRefusalEvent(rootId, reason, Date.now(), spend);
  const recordOn = logCtx ?? refusalLog?.logCtx;
  if (recordOn) {
    markLocalRequestLogRefusal(recordOn, summary.code);
    // A locally assigned code wins in addFinalRequestLog, so this is what names the ceiling in
    // the logs column rather than the generic rate-limit classification a 429 would get.
    recordOn.errorCode = summary.code;
  }
  if (refusalLog) {
    addFinalRequestLog(refusalLog.requestId, refusalLog.start, refusalLog.logCtx, 429, {
      closeReason: "terminal",
    });
  }
  const refusal = formatErrorResponse(
    429,
    reason === "workflow-sends-exhausted" ? "workflow_budget_exhausted" : "queue_capacity_exceeded",
    summary.message,
  );
  refusal.headers.set(WORKFLOW_LOCAL_REFUSAL_HEADER, summary.code);
  // Without this a browser dashboard cannot read the header at all: the data plane never sets
  // Access-Control-Expose-Headers, so a cross-origin reader sees only the CORS-safelisted ones.
  refusal.headers.set("Access-Control-Expose-Headers", WORKFLOW_LOCAL_REFUSAL_HEADER);
  return refusal;
}

/**
 * Admit one HTTP turn against its root workflow budget.
 *
 * A fan-out shares the conversation it serves. Without a reserve, a worker burst takes every
 * slot under its own root and the interactive turn that started it waits behind its own
 * children. A request that names a parent is treated as that fan-out; a top-level request is
 * the conversation and may use the reserved slots.
 */
export function admitHttpWorkflowTurn(headers: Headers): WorkflowDecision | undefined {
  const rootId = headers.get("x-codex-parent-thread-id")?.trim() || undefined;
  const threadId = headers.get("thread-id")?.trim() || undefined;
  const lane: WorkflowLane = rootId !== undefined && threadId !== undefined && threadId !== rootId
    ? "worker"
    : "interactive";
  return admitWorkflowTurn(rootId, lane, undefined, threadId);
}

/**
 * The refusal for a decision {@link admitHttpWorkflowTurn} declined.
 *
 * It exists so the denial's own detail survives the trip to the wire. A token-ceiling denial
 * arrives carrying the scope that refused and the number it refused against, and a caller that
 * forwarded only `reason` would answer with a 429 that names no ceiling -- which is the
 * illegible refusal this whole path is built to avoid. No root id is passed on: the admission
 * check already recorded its own event, and passing one would count the refusal twice.
 */
export function workflowDecisionRefusalResponse(
  decision: Extract<WorkflowDecision, { admitted: false }>,
  logCtx?: RequestLogContext,
  refusalLog?: WorkflowRefusalLog,
): Response {
  const spend = decision.spendScope !== undefined && decision.spendLimit !== undefined
    ? {
      scope: decision.spendScope,
      limit: decision.spendLimit,
      ...(decision.spendProjected !== undefined ? { projected: decision.spendProjected } : {}),
    }
    : undefined;
  return workflowRefusalResponse(decision.reason, logCtx, refusalLog, undefined, spend);
}
