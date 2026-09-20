/**
 * Whether one leg of a logical request may send it again, asked in the #5266 vocabulary.
 *
 * Two pull requests arrived at this question from opposite sides of the response head. #4942
 * asked it for a connection that died before any head; #4989 asked it for an SSE body that
 * died after the head while carrying only control events. Both are the same row of the stage
 * table: a stage the caller observed nothing at, with a cause that cannot prove the origin did
 * not run the turn. `resendPermission` answers `refused-ambiguous` for both, and
 * request-failure-model.ts already names the only thing that may override that answer -- a
 * narrowly scoped recovery a maintainer opted into and bounded.
 *
 * One override, not two. The reason this module exists rather than a boolean in each caller is
 * that a request which resets before the head and again after it would otherwise buy a
 * replacement send on each side, and the second one is exactly the duplicated inference the
 * refusal exists to prevent. The allowance is claimed HERE, at the moment of authorisation, so
 * a caller cannot ask without paying.
 *
 * MUST stay a leaf. It imports the vocabulary as values and everything else as types, so it
 * reaches no request path that did not already have it.
 */
import {
  causeForRecoveryKind,
  permitsResend,
  resendPermission,
  resendSendClass,
  type RequestFailureCause,
  type RequestFailureStage,
  type ResendPermission,
} from "./request-failure-model";
import type { SendClass } from "./request-execution-budget";
import type { AttemptRecoveryKind } from "../usage/telemetry-contract";

/**
 * Why an authorisation was refused.
 *
 * The three ambiguous members are separate because they need different operator responses: no
 * policy is a configuration choice, a request the proxy cannot judge is a property of the turn,
 * and a spent allowance means the replacement already went somewhere else in this request.
 */
export const RESEND_REFUSALS = Object.freeze([
  /** The caller already observed output, an effect, or the delivered answer. */
  "committed",
  /** Identical bytes would get the identical answer. */
  "futile",
  /** The origin's execution state is unknown and no operator policy overrides that. */
  "ambiguous-no-policy",
  /** An operator policy exists, but this request's second send could do more than re-infer. */
  "ambiguous-request-not-replayable",
  /** The operator policy exists and its replacement was already spent by this request. */
  "ambiguous-allowance-spent",
] as const);

export type ResendRefusal = typeof RESEND_REFUSALS[number];

/**
 * The operator-granted replacement for ONE logical request.
 *
 * `claim` is the single counter both stages draw on. It is a method rather than a number
 * because the holder is the request's send ledger, which a combo child shares with its parent;
 * a number passed down per leg is what let each leg hold its own.
 */
export interface AmbiguousResendAllowance {
  /** True when a second send of this request's body can only repeat the inference. */
  readonly selfContained: boolean;
  /** Spend one replacement. False once the request has none left. */
  claim(): boolean;
}

interface ResendDecisionBase {
  readonly stage: RequestFailureStage;
  readonly cause: RequestFailureCause;
  readonly permission: ResendPermission;
  /**
   * The recovery this send will be recorded as, when the caller asked in those terms. Carried
   * back rather than re-chosen at the call site: the cause was derived from it, so recording a
   * different kind would describe the send by a reason the gate never evaluated.
   */
  readonly recoveryKind?: AttemptRecoveryKind;
}

export type ResendDecision =
  | ResendDecisionBase & {
    readonly allowed: true;
    /** Which request-wide send class funds it, or null when the cause funds no resend. */
    readonly sendClass: SendClass | null;
    /** True when the table refused and an operator allowance was spent to proceed. */
    readonly spentOperatorAllowance: boolean;
  }
  | ResendDecisionBase & { readonly allowed: false; readonly refusal: ResendRefusal };

/**
 * Decide whether this proxy may send the request again after a failure at `stage` caused by
 * `cause`, spending `allowance` when the table refuses only because the upstream state is
 * unknown.
 *
 * The allowance is touched on exactly one path: a decision the table would otherwise refuse as
 * ambiguous, for a request whose body the caller has judged replayable. A committed or futile
 * failure never reaches it, so a turn that already produced output cannot quietly drain the
 * replacement a later ambiguous reset would have been entitled to.
 */
export function authorizeResend(
  stage: RequestFailureStage,
  cause: RequestFailureCause,
  allowance?: AmbiguousResendAllowance,
  recoveryKind?: AttemptRecoveryKind,
): ResendDecision {
  const permission = resendPermission(stage, cause);
  const base = { stage, cause, permission, ...(recoveryKind ? { recoveryKind } : {}) };
  if (permitsResend(permission)) {
    return { ...base, allowed: true, sendClass: resendSendClass(cause), spentOperatorAllowance: false };
  }
  if (permission === "refused-committed") return { ...base, allowed: false, refusal: "committed" };
  if (permission === "refused-futile") return { ...base, allowed: false, refusal: "futile" };
  if (!allowance) return { ...base, allowed: false, refusal: "ambiguous-no-policy" };
  if (!allowance.selfContained) {
    return { ...base, allowed: false, refusal: "ambiguous-request-not-replayable" };
  }
  // Claimed last, and only here. Asking earlier would spend the request's one replacement on a
  // question whose answer was already no.
  if (!allowance.claim()) return { ...base, allowed: false, refusal: "ambiguous-allowance-spent" };
  return { ...base, allowed: true, sendClass: resendSendClass(cause), spentOperatorAllowance: true };
}

/**
 * The same decision, asked in terms of the recovery this proxy will RECORD for the send.
 *
 * Deriving the cause from the recorded kind is what keeps the log honest: the reason an
 * operator reads beside a send count is the reason the gate weighed, because it is the same
 * value. A call site that recorded one kind and reasoned about another is how a send count
 * stops meaning anything.
 */
export function authorizeResendForRecovery(
  stage: RequestFailureStage,
  kind: AttemptRecoveryKind,
  allowance?: AmbiguousResendAllowance,
): ResendDecision {
  return authorizeResend(stage, causeForRecoveryKind(kind), allowance, kind);
}
