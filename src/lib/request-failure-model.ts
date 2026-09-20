/**
 * One vocabulary for how far a failed request got, why it failed, and whether this proxy may
 * send it again (roadmap items 7 and 14).
 *
 * These two items are one module on purpose. Item 7 wants a resend decision per failure stage;
 * item 14 wants one cause dictionary spanning logical request, attempt, physical send and
 * terminal. Defined apart they typecheck on each branch and contradict each other in the merge,
 * which is the class that blocked 2.60.0.
 *
 * What lives here is the vocabulary and the decision derived from it. What does NOT live here is
 * a second record store: the durable shapes stay `PersistedUsageAttempt` and
 * `PersistedUsageEntry` in src/usage/log.ts, and every projection below reads those structurally
 * rather than growing a parallel history.
 *
 * MUST stay a leaf. Its one runtime import is `src/usage/telemetry-contract.ts`, which has no
 * imports at all; everything else it names is a type, erased at runtime. So nothing here can
 * pull the usage or budget subsystems into a request path that did not already have them.
 */
import type { SendClass } from "./request-execution-budget";
import {
  REQUEST_FAILURE_STAGES,
  type AttemptRecoveryKind,
  type RequestFailureCause,
  type RequestFailureStage,
  type ResendPermission,
} from "../usage/telemetry-contract";

/**
 * The vocabulary this module decides over is DECLARED in `src/usage/telemetry-contract.ts` and
 * re-exported here, so every importer of this module keeps its path while the dashboard can
 * reach the same rosters without pulling this file's import graph into the browser project.
 *
 * What stays here is the decision: the per-stage commitment, the per-cause evidence and
 * disposition, and the resend permission derived from them.
 *
 * A stage is how far the OBSERVABLE progression got, not which events happened to arrive. A turn
 * that settled carrying no output -- an empty completion, a 4xx error body -- did not reach
 * `terminal`; it stalled below `semantic-output`, because the caller saw no answer. `terminal`
 * means the answer was delivered, which is why it is both last and refused.
 */
export {
  REQUEST_FAILURE_CAUSES,
  REQUEST_FAILURE_STAGES,
  RESEND_PERMISSIONS,
} from "../usage/telemetry-contract";
export type {
  RequestFailureCause,
  RequestFailureStage,
  ResendPermission,
} from "../usage/telemetry-contract";

/** Position in {@link REQUEST_FAILURE_STAGES}. Derived, so the order is stated exactly once. */
export function stageRank(stage: RequestFailureStage): number {
  return REQUEST_FAILURE_STAGES.indexOf(stage);
}

/**
 * What the caller has irreversibly observed at a stage.
 *
 * Named separately from the rank so a reader can see WHY a stage refuses rather than inferring it
 * from a position, and so the three committed stages stay distinguishable in a record.
 */
export type StageCommitment = "nothing-observed" | "output-observed" | "effect-observed" | "answer-delivered";

const STAGE_COMMITMENT = {
  "pre-header": "nothing-observed",
  "headers-only": "nothing-observed",
  "protocol-prelude": "nothing-observed",
  "semantic-output": "output-observed",
  "side-effect": "effect-observed",
  "terminal": "answer-delivered",
} as const satisfies Record<RequestFailureStage, StageCommitment>;

export function stageCommitment(stage: RequestFailureStage): StageCommitment {
  return STAGE_COMMITMENT[stage];
}

/**
 * What the cause proves about whether the origin ran the turn.
 *
 * This is the safety axis. `unknown` is the RFC 9110 9.2.2 case and is never upgraded by having
 * budget left: a request whose upstream execution state is unknown is not replayable merely
 * because a counter allows another send.
 */
export type UpstreamProcessingEvidence = "not-processed" | "declined" | "processed" | "unknown";

const CAUSE_EVIDENCE = {
  "transport-unsent": "not-processed",
  "transport-ambiguous": "unknown",
  "upstream-declined": "declined",
  "rate-limit": "declined",
  "quota-exhausted": "declined",
  "credential-rejected": "declined",
  "policy-refusal": "processed",
  "parameter-rejected": "declined",
  "ciphertext-refusal": "declined",
  "payload-too-large": "declined",
  "payload-rejected": "declined",
  "upstream-fault": "unknown",
  "empty-output": "processed",
  "client-cancelled": "unknown",
  "local-refusal": "not-processed",
} as const satisfies Record<RequestFailureCause, UpstreamProcessingEvidence>;

export function causeEvidence(cause: RequestFailureCause): UpstreamProcessingEvidence {
  return CAUSE_EVIDENCE[cause];
}

/**
 * What a resend would have to change to have any chance.
 *
 * The usefulness axis, orthogonal to safety. A policy refusal is perfectly safe to repeat and
 * completely pointless; an ambiguous reset is the reverse.
 */
export type ResendDisposition = "resend-may-help" | "resend-after-repair" | "resend-is-futile";

const CAUSE_DISPOSITION = {
  "transport-unsent": "resend-may-help",
  "transport-ambiguous": "resend-may-help",
  "upstream-declined": "resend-may-help",
  "rate-limit": "resend-may-help",
  "quota-exhausted": "resend-is-futile",
  "credential-rejected": "resend-after-repair",
  "policy-refusal": "resend-is-futile",
  "parameter-rejected": "resend-after-repair",
  "ciphertext-refusal": "resend-after-repair",
  "payload-too-large": "resend-after-repair",
  "payload-rejected": "resend-is-futile",
  "upstream-fault": "resend-may-help",
  "empty-output": "resend-may-help",
  "client-cancelled": "resend-is-futile",
  "local-refusal": "resend-is-futile",
} as const satisfies Record<RequestFailureCause, ResendDisposition>;

export function causeDisposition(cause: RequestFailureCause): ResendDisposition {
  return CAUSE_DISPOSITION[cause];
}

/**
 * Whether this proxy may send the request again, from the stage it failed at and the cause.
 *
 * Derived from the two per-cause facts above and the per-stage commitment, rather than written
 * out as a stage-by-cause matrix. A matrix of that size is a restatement: it would have to be
 * re-derived by hand every time a member is added, and the cell nobody revisited is exactly how
 * two correct branches merge into a wrong table.
 *
 * `refused-ambiguous` forbids an AUTOMATIC resend. It does not forbid a narrowly scoped,
 * explicitly opted-in recovery that a maintainer reasoned about and bounded -- the reset replay
 * behind a default-off provider flag, the single-shot empty-completion rebuild. Those are
 * separate recorded decisions with their own acceptance, which is precisely what distinguishes
 * them from a retry loop that fires because a counter had room.
 */
export function resendPermission(
  stage: RequestFailureStage,
  cause: RequestFailureCause,
): ResendPermission {
  // Any stage at which the caller observed something refuses, whatever the cause says. Testing
  // the commitment rather than listing the committed stages is what keeps a stage added later
  // from defaulting into permission.
  if (STAGE_COMMITMENT[stage] !== "nothing-observed") return "refused-committed";
  if (CAUSE_DISPOSITION[cause] === "resend-is-futile") return "refused-futile";
  const evidence = CAUSE_EVIDENCE[cause];
  if (evidence === "unknown" || evidence === "processed") return "refused-ambiguous";
  return CAUSE_DISPOSITION[cause] === "resend-after-repair" ? "permitted-after-repair" : "permitted";
}

/** True for the two permissions that allow a further send. */
export function permitsResend(permission: ResendPermission): boolean {
  return permission === "permitted" || permission === "permitted-after-repair";
}

/**
 * Which request-wide send budget class a resend for this cause draws on, or null when no resend
 * of any kind makes sense.
 *
 * Funding is keyed on the DISPOSITION, not on the permission. A cause the table refuses to resend
 * automatically may still be resent by a narrowly scoped recovery a maintainer opted into, and
 * that send has to be bought from the same budget every other send comes from -- the opt-in reset
 * replay and the bounded empty-completion rebuild both draw on the transient allowance. Keying on
 * permission instead would leave exactly those paths unfunded, which is how a per-layer counter
 * reappears.
 *
 * Only a futile cause is null. `quota-exhausted` is null rather than `account-failover` because
 * moving accounts is a route decision this table does not make.
 */
const CAUSE_SEND_CLASS = {
  "transport-unsent": "transient",
  "transport-ambiguous": "transient",
  "upstream-declined": "transient",
  "rate-limit": "transient",
  "quota-exhausted": null,
  "credential-rejected": "auth-recovery",
  "policy-refusal": null,
  "parameter-rejected": "repair",
  "ciphertext-refusal": "repair",
  "payload-too-large": "repair",
  "payload-rejected": null,
  "upstream-fault": "transient",
  "empty-output": "transient",
  "client-cancelled": null,
  "local-refusal": null,
} as const satisfies Record<RequestFailureCause, SendClass | null>;

export function resendSendClass(cause: RequestFailureCause): SendClass | null {
  return CAUSE_SEND_CLASS[cause];
}

/**
 * The cause behind each recovery this proxy already records.
 *
 * Total over `AttemptRecoveryKind` by construction, so a new recovery kind is a typecheck
 * failure here rather than a row that quietly classifies as "other" in three projections.
 */
const RECOVERY_KIND_CAUSE = {
  // The retried status set mixes 503, which declined, with 500, which may already have run the
  // turn. One kind cannot say both, so it says the weaker thing.
  "transient-5xx": "upstream-fault",
  "connection-reset": "transport-ambiguous",
  "oauth-401": "credential-rejected",
  "key-401": "credential-rejected",
  "key-429": "rate-limit",
  "rate-limit-429": "rate-limit",
  "anthropic-oauth-429": "rate-limit",
  "oauth-account-429": "rate-limit",
  "image-413": "payload-too-large",
  // The gateway rejects a body it accepts seconds later and the replay is byte-identical, so
  // nothing about the payload was wrong; the origin declined to take it at that moment.
  "console-go-upload-retry": "upstream-declined",
  "opaque-blob-rejection": "ciphertext-refusal",
  "empty-completion": "empty-output",
  "reasoning-effort-downgrade": "parameter-rejected",
} as const satisfies Record<AttemptRecoveryKind, RequestFailureCause>;

export function causeForRecoveryKind(kind: AttemptRecoveryKind): RequestFailureCause {
  return RECOVERY_KIND_CAUSE[kind];
}
