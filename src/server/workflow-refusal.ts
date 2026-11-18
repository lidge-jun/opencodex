import { carryProxyError, isProxyError, markProxyError } from "../lib/client-error-body";
import { sharedPoolContinuityDenial } from "../lib/spend-reservation-ledger";
import { markResponseNonReplayable } from "../lib/upstream-retry";
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
  workflowSendCeilingReached,
  workflowDenialSummary,
  recordWorkflowRefusalEvent,
  type WorkflowDenial,
  type WorkflowDecision,
  type WorkflowLane,
  type WorkflowSpendDenialDetail,
} from "../lib/workflow-budget";
import { currentWorkflowBudgetPolicy } from "../lib/workflow-budget-config";
import { SEND_BUDGET_EXHAUSTED_CODE } from "../lib/errors";

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
  /** Receiving HTTP route's notification after this refusal's final-log call. */
  readonly onLogged?: () => void;
}

/**
 * Build the 429 for a refusal this proxy made itself.
 *
 * The status and type arguments below do not reach the client: `classifyError` rewrites every
 * 429 to `rate_limit_error` / `rate_limit_exceeded`, so the body is shaped exactly like a
 * provider rate limit. That is a deliberate wire contract -- changing it would change how every
 * client retries -- which leaves two places to carry the truth. The message names the ceiling
 * that fired and distinguishes admission from refusing a later send, and the header carries
 * the machine-readable name. The in-process proxy marker establishes its local provenance.
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
  const sentPreviously = (recordOn?.activeAttempt?.sendCount ?? 0) > 0
    || recordOn?.attempts?.some(attempt => attempt.sendCount > 0) === true;
  const message = sentPreviously ? summary.message
    .replace("refused the request locally", "refused an additional send locally")
    .replace("no provider was contacted", "no additional provider request was sent")
    .replace("No provider was contacted", "No additional provider request was sent") : summary.message;
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
    refusalLog.onLogged?.();
  }
  const refusal = formatErrorResponse(
    429,
    reason === "workflow-sends-exhausted" ? "workflow_budget_exhausted" : "queue_capacity_exceeded",
    message,
  );
  refusal.headers.set(WORKFLOW_LOCAL_REFUSAL_HEADER, summary.code);
  // Without this a browser dashboard cannot read the header at all: the data plane never sets
  // Access-Control-Expose-Headers, so a cross-origin reader sees only the CORS-safelisted ones.
  refusal.headers.set("Access-Control-Expose-Headers", WORKFLOW_LOCAL_REFUSAL_HEADER);
  // No Combo target has an allowance after a root send denial; do not classify it as quota.
  if (reason === "workflow-sends-exhausted") markResponseNonReplayable(refusal);
  return markProxyError(refusal, reason === "workflow-spend-exhausted" && spend && Object.hasOwn({ root: 1, identity: 1, pool: 1 }, spend.scope) ? (spend.includesUnboundPoolHistory ? "workflow_unbound" : "workflow") : undefined);
}

/** Preserve only a locally constructed workflow refusal across response projections. */
export function carryWorkflowRefusal(source: Response, target: Response): Response {
  const code = isProxyError(source) ? source.headers.get(WORKFLOW_LOCAL_REFUSAL_HEADER) : null;
  if (!code) return target;
  target.headers.set(WORKFLOW_LOCAL_REFUSAL_HEADER, code);
  const exposed = target.headers.get("Access-Control-Expose-Headers");
  if (!exposed?.split(",").some(name => name.trim().toLowerCase() === WORKFLOW_LOCAL_REFUSAL_HEADER)) {
    target.headers.set("Access-Control-Expose-Headers", exposed ? `${exposed}, ${WORKFLOW_LOCAL_REFUSAL_HEADER}` : WORKFLOW_LOCAL_REFUSAL_HEADER);
  }
  return carryProxyError(source, target);
}

/** Distinguish an exhausted live root from the request's independent send allowance. */
export function workflowSendCeilingRefusalResponse(
  logCtx: RequestLogContext,
  rootId?: string,
  recordedOn: Pick<RequestLogContext, "localTerminalReason"> = logCtx,
): Response | undefined {
  if (!workflowSendCeilingReached(rootId, currentWorkflowBudgetPolicy())) return undefined;
  // Observer-backed admission already records its denial; legacy budgets need the event here.
  return workflowRefusalResponse("workflow-sends-exhausted", logCtx, undefined,
    recordedOn.localTerminalReason === "workflow_sends_exhausted" ? undefined : rootId);
}

/** Render the approved conservative-overlay explanation after a dispatch reservation refuses. */
export function unboundPoolSpendRefusalMessage(
  logCtx: Pick<RequestLogContext, "spendRefusalDetail">,
): string | undefined {
  const detail = logCtx.spendRefusalDetail;
  if (!detail?.includesUnboundPoolHistory) return undefined;
  return workflowDenialSummary("workflow-spend-exhausted", detail).message;
}

/** HTTP form for pre-commit send-budget catches; the tracker already recorded the event. */
export function unboundPoolSpendRefusalResponse(logCtx: RequestLogContext): Response | undefined {
  const detail = logCtx.spendRefusalDetail;
  if (!detail?.includesUnboundPoolHistory) return undefined;
  return workflowRefusalResponse("workflow-spend-exhausted", logCtx, undefined, undefined, detail);
}

/** Preserve affinity when the proxy, rather than the serving credential, refuses a send. */
export function adapterSendBudgetRefusal(logCtx: RequestLogContext, rootId: string | undefined, message: string): Response {
  logCtx.terminalSource = "synthetic";
  return unboundPoolSpendRefusalResponse(logCtx) ?? workflowSendCeilingRefusalResponse(logCtx, rootId)
    ?? markProxyError(formatErrorResponse(429, SEND_BUDGET_EXHAUSTED_CODE, message));
}

/**
 * Admit one HTTP turn against its root workflow budget.
 *
 * A fan-out shares the conversation it serves. Without a reserve, a worker burst takes every
 * slot under its own root and the interactive turn that started it waits behind its own
 * children. A request that names a parent is treated as that fan-out; a top-level request is
 * the conversation and may use the reserved slots.
 */
/** Read-only alias validation: keep replay corruption distinct from conflicting pool owners. */
export function poolContinuityRefusalReason(): WorkflowDenial | undefined {
  const denial = sharedPoolContinuityDenial();
  if (!denial) return undefined;
  return denial.reason === "pool-history-unresolved" ? "workflow-pool-history-unresolved" : "workflow-spend-undurable";
}

export function admitHttpWorkflowTurn(headers: Headers): WorkflowDecision | undefined {
  const rootId = headers.get("x-codex-parent-thread-id")?.trim() || undefined;
  const continuityRefusal = poolContinuityRefusalReason();
  if (continuityRefusal) {
    recordWorkflowRefusalEvent(rootId, continuityRefusal);
    return { admitted: false, reason: continuityRefusal, rootId: rootId ?? "" };
  }
  const threadId = headers.get("thread-id")?.trim() || undefined;
  const lane: WorkflowLane = rootId !== undefined && threadId !== undefined && threadId !== rootId
    ? "worker"
    : "interactive";
  return admitWorkflowTurn(rootId, lane, currentWorkflowBudgetPolicy(), threadId);
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
      ...(decision.spendIncludesUnboundPoolHistory ? { includesUnboundPoolHistory: true } : {}),
    }
    : undefined;
  return workflowRefusalResponse(decision.reason, logCtx, refusalLog, undefined, spend);
}
