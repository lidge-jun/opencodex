/**
 * Derive how far a failed request got and why, from the closed facts the recorder already holds.
 *
 * #2366 asked for durable failure attribution and shipped its own `FailureSide` and seven-member
 * `FailureStage` to carry it. Those are a second attribution vocabulary beside the one that
 * landed in {@link ../lib/request-failure-model}, and two vocabularies for one question is the
 * class of defect that blocked 2.60.0. This module is the same answer expressed in the landed
 * vocabulary: no new stage names, no new cause names, and no new record store.
 *
 * Everything it reads is a CLOSED value the row already carries -- an HTTP status, a terminal
 * status, a close reason, a transport phase, a recovery kind. It never reads `errorCode` or
 * `upstreamError`, which are open strings assembled partly from upstream text: a classification
 * keyed on those is a different answer per provider and per locale, and a grouping key built from
 * them cannot promise it carries no content.
 *
 * MUST stay a leaf. Its only imports are types and the two tables it decides with, so nothing
 * here can pull the usage or budget subsystems into a request path that lacked them.
 */
import type { AttemptRecoveryKind, RequestFailureCause, RequestFailureStage } from "../usage/telemetry-contract";
import { causeForRecoveryKind } from "./request-failure-model";
import { classifyRequestOutcome, type RequestOutcomeFacts } from "../usage/request-outcome";

/**
 * What the recorder knows about one finished exchange at the single seam every request passes.
 *
 * Deliberately the same narrow set {@link RequestOutcomeFacts} reads, plus the four observation
 * facts a stage needs. A field that could carry a provider name, a model, an account or upstream
 * text is absent by construction rather than by review.
 */
export interface RequestFailureFacts extends RequestOutcomeFacts {
  readonly transportPhase?: "pre_headers" | "mid_stream" | "terminal_sse" | undefined;
  /** True once any output-bearing event reached the caller; `firstOutputMs` is the usual source. */
  readonly outputObserved?: boolean | undefined;
  /** True once a tool call or other externally visible effect was relayed to the caller. */
  readonly sideEffectObserved?: boolean | undefined;
  /** True when this proxy answered the turn itself and issued no upstream request. */
  readonly locallyAnswered?: boolean | undefined;
  /** Recovery kinds recorded on the attempt that ended the request. */
  readonly recoveryKinds?: readonly AttemptRecoveryKind[] | undefined;
}

/**
 * How far the caller's view of the exchange got.
 *
 * Total by construction and ordered downward from the most committed observation, so a fact that
 * proves a later stage wins over one that only proves an earlier one. The boundary between
 * `headers-only` and `protocol-prelude` is the one genuinely debatable step -- a non-streaming
 * 4xx error body is a body, but not a protocol body event -- and it is safe to argue about
 * because both stages carry the same `nothing-observed` commitment, so no resend decision turns
 * on which side of it a row lands.
 */
export function deriveRequestFailureStage(facts: RequestFailureFacts): RequestFailureStage {
  if (facts.terminalStatus === "completed" && facts.outputObserved === true) return "terminal";
  if (facts.sideEffectObserved === true) return "side-effect";
  if (facts.outputObserved === true) return "semantic-output";
  if (facts.terminalStatus !== undefined
    || facts.closeReason === "terminal"
    || facts.transportPhase === "mid_stream"
    || facts.transportPhase === "terminal_sse") return "protocol-prelude";
  if (facts.status >= 100) return "headers-only";
  return "pre-header";
}

/**
 * Recovery kinds whose cause survives as the FINAL cause when the request ends on the status that
 * recovery was made for.
 *
 * `causeForRecoveryKind` answers why a recovery was ATTEMPTED, which is usually a different
 * question from why the request finally failed -- a request that recovered from a 401 and then
 * died on a 500 failed for the 500. The two kinds below are the exception: each names a rejection
 * the status alone cannot distinguish from an ordinary bad request, so when the request also ends
 * on that status the recovery kind is the only evidence of which 4xx it was.
 */
const STATUS_CONFIRMED_RECOVERY_KINDS: Readonly<Partial<Record<AttemptRecoveryKind, number>>> = Object.freeze({
  "opaque-blob-rejection": 400,
  "reasoning-effort-downgrade": 400,
});

function refinedFourHundredCause(
  facts: RequestFailureFacts,
): RequestFailureCause | undefined {
  for (const kind of facts.recoveryKinds ?? []) {
    const confirmedStatus = STATUS_CONFIRMED_RECOVERY_KINDS[kind];
    if (confirmedStatus !== undefined && confirmedStatus === facts.status) return causeForRecoveryKind(kind);
  }
  return undefined;
}

/**
 * Why the request failed.
 *
 * Returns `undefined` for an outcome that is not a failure. An incomplete turn is a real
 * shortfall and gets a stage, but this dictionary answers "why did it fail", and a turn cut short
 * by `max_output_tokens` did not fail for any of these reasons; inventing one would put a
 * fabricated cause into a metric label and a grouping key.
 *
 * The status is the primary evidence because it is the one fact every transport produces. Two
 * refinements sit above it, both from closed values: a client cancel is known from the close
 * reason before any status is consulted, and a 400 that a recovery kind identified as a rejected
 * ciphertext or a rejected reasoning parameter is not the same answer as a rejected payload.
 */
export function deriveRequestFailureCause(facts: RequestFailureFacts): RequestFailureCause | undefined {
  const outcome = classifyRequestOutcome(facts);
  if (outcome === "completed" || outcome === "incomplete") return undefined;
  if (outcome === "aborted") return "client-cancelled";
  if (facts.locallyAnswered === true) return "local-refusal";

  const status = facts.status;
  // A 2xx head that carried a failed terminal: the origin ran the turn and said it failed. With
  // no output relayed the useful distinction is that nothing usable came back at all.
  if (status >= 100 && status < 400) {
    return facts.outputObserved === true ? "upstream-fault" : "empty-output";
  }
  if (status === 401) return "credential-rejected";
  if (status === 403) return "credential-rejected";
  if (status === 413) return "payload-too-large";
  if (status === 429) return "rate-limit";
  if (status === 451) return "policy-refusal";
  if (status === 503) return "upstream-declined";
  if (status >= 500) return "upstream-fault";
  if (status >= 400) return refinedFourHundredCause(facts) ?? "payload-rejected";
  // No response head at all. A stream that began and died is ambiguous about whether the origin
  // ran the turn; a request that never reached a mid-stream phase provably did not send.
  return facts.transportPhase === "mid_stream" || facts.transportPhase === "terminal_sse"
    ? "transport-ambiguous"
    : "transport-unsent";
}

export interface RequestFailureAttribution {
  stage: RequestFailureStage;
  cause?: RequestFailureCause;
}

/**
 * The attribution to persist, or `undefined` when the request completed.
 *
 * A completed request has no failure to attribute, and recording a stage for one would put a
 * `terminal` row into every grouping that exists to find failures.
 */
export function deriveRequestFailureAttribution(
  facts: RequestFailureFacts,
): RequestFailureAttribution | undefined {
  if (classifyRequestOutcome(facts) === "completed") return undefined;
  const cause = deriveRequestFailureCause(facts);
  return { stage: deriveRequestFailureStage(facts), ...(cause ? { cause } : {}) };
}
