/**
 * Where a request's failure attribution is derived and stamped.
 *
 * A sibling of `request-log.ts` rather than a section inside it. That file carries the whole
 * request-logging surface and sits against the 2,000-line repository ceiling, which only ever
 * moves down; this is the extraction that rule asks for, not a cap that was negotiated.
 *
 * It holds the two places a stage and cause are decided and written. Both read the recorder's
 * own closed facts and neither reads `errorCode` or `upstreamError`, which are assembled partly
 * from upstream text.
 */
import { deriveRequestFailureAttribution } from "../lib/request-failure-attribution";
import { causeForRecoveryKind } from "../lib/request-failure-model";
import type { AttemptRecoveryKind, PersistedUsageAttempt, RequestFailureCause, RequestFailureStage } from "../usage/log";
import type { ResponsesTerminalStatus } from "../bridge";

/** The subset of the log context this derivation may see. Narrow on purpose. */
export interface FinalRequestAttributionFacts {
  readonly status: number;
  readonly terminalStatus?: ResponsesTerminalStatus | undefined;
  readonly closeReason?: "terminal" | "client_cancel" | "non_stream" | "body_stall" | "body_overflow" | undefined;
  readonly transportPhase?: "pre_headers" | "mid_stream" | "terminal_sse" | undefined;
  readonly terminalSource?: "upstream" | "synthetic" | undefined;
  /** The REQUEST's first-output observation, not the final attempt's. See below. */
  readonly outputObserved: boolean;
  readonly locallyAnswered: boolean;
  readonly attempt?: PersistedUsageAttempt | undefined;
}

export interface StampedAttribution {
  failureStage?: RequestFailureStage;
  failureCause?: RequestFailureCause;
}

/**
 * Derive the attribution for a finished logical request and stamp the attempt that ended it.
 *
 * Called from the one seam every request passes exactly once, and BEFORE the attempt snapshot,
 * so the row that reaches disk and the live attempt object carry the same pair. Deriving it at
 * each transport's own exit would give the same request a different attribution per transport,
 * which is the disagreement the shared terminal classifier already removed once.
 *
 * `outputObserved` is the request's observation rather than the final attempt's. A request that
 * relayed output on its first attempt and then failed over has committed that output to the
 * caller whatever the last attempt saw, so the logical row and the attempt that ended it carry
 * the same answer. Reading the attempt-local value would produce a MORE permissive resend verdict
 * for exactly that case, and a permission decision has to fail in the safe direction.
 */
export function attributeFinalRequest(facts: FinalRequestAttributionFacts): StampedAttribution {
  const attribution = deriveRequestFailureAttribution({
    status: facts.status,
    ...(facts.terminalStatus ? { terminalStatus: facts.terminalStatus } : {}),
    ...(facts.closeReason ? { closeReason: facts.closeReason } : {}),
    ...(facts.transportPhase ? { transportPhase: facts.transportPhase } : {}),
    ...(facts.terminalSource ? { terminalSource: facts.terminalSource } : {}),
    ...(facts.attempt?.streamAborted === true ? { streamAborted: true } : {}),
    outputObserved: facts.outputObserved,
    // The one fact that can raise a stage above `semantic-output`, and the reason it is counted
    // at the transport rather than at the adapter: an emitted tool call the client never
    // received has committed nothing, and a resend for it is still safe (#3983).
    sideEffectObserved: (facts.attempt?.deliverySummary?.sideEffectEvents ?? 0) > 0,
    locallyAnswered: facts.locallyAnswered,
    recoveryKinds: facts.attempt?.recoveryKinds ?? [],
  });
  // The final row and the attempt that ended it describe the same exchange, so they carry the
  // same pair rather than each deriving one from a different slice of the facts.
  if (facts.attempt) {
    if (attribution?.stage) facts.attempt.failureStage = attribution.stage;
    else delete facts.attempt.failureStage;
    if (attribution?.cause) facts.attempt.failureCause = attribution.cause;
    else delete facts.attempt.failureCause;
  }
  return {
    ...(attribution?.stage ? { failureStage: attribution.stage } : {}),
    ...(attribution?.cause ? { failureCause: attribution.cause } : {}),
  };
}

/**
 * Attribute an attempt being sealed because a named recovery rejected it.
 *
 * The recovery kind is direct evidence here rather than an inference from history: this attempt
 * is ending precisely because that recovery was needed. Without it the sealed attempt would reach
 * the ledger with no attribution at all, because the finalization seam only ever sees the last
 * attempt of a request.
 */
export function attributeSealedAttempt(
  attempt: PersistedUsageAttempt,
  recovery: AttemptRecoveryKind | undefined,
): void {
  const attribution = deriveRequestFailureAttribution({
    status: attempt.status,
    outputObserved: attempt.firstOutputMs !== undefined,
    sideEffectObserved: (attempt.deliverySummary?.sideEffectEvents ?? 0) > 0,
    ...(recovery ? { causeHint: causeForRecoveryKind(recovery) } : {}),
  });
  if (attribution?.stage) attempt.failureStage = attribution.stage;
  if (attribution?.cause) attempt.failureCause = attribution.cause;
}
