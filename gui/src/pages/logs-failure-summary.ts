import type { TFn } from "../i18n/shared";
import type { RequestFailureCause, RequestFailureStage, ResendPermission, RequestSpendTotals } from "../../../src/usage/telemetry-contract";
import type { UpstreamCondition } from "../../../src/lib/upstream-condition";
import { boundedFailureDetail, type FailureDetailCode } from "../../../src/lib/failure-detail";

interface LogFailureAttribution {
  failureCause?: RequestFailureCause;
  failureStage?: RequestFailureStage;
  resendPermission?: ResendPermission;
}

/**
 * i18n key for each shared failure cause, total by construction.
 *
 * The `satisfies` clause is the point. The recovery-kind catalog on this page drifted to nine of
 * the durable thirteen and four real causes reached the operator as "Unknown recovery reason" --
 * an absence of a label rendered as an absence of a cause. A missing member here is a typecheck
 * failure instead.
 */
const FAILURE_CAUSE_KEYS = {
  "transport-unsent": "logs.detail.cause.transportUnsent",
  "transport-ambiguous": "logs.detail.cause.transportAmbiguous",
  "upstream-declined": "logs.detail.cause.upstreamDeclined",
  "rate-limit": "logs.detail.cause.rateLimit",
  "quota-exhausted": "logs.detail.cause.quotaExhausted",
  "credential-rejected": "logs.detail.cause.credentialRejected",
  "policy-refusal": "logs.detail.cause.policyRefusal",
  "parameter-rejected": "logs.detail.cause.parameterRejected",
  "ciphertext-refusal": "logs.detail.cause.ciphertextRefusal",
  "payload-too-large": "logs.detail.cause.payloadTooLarge",
  "payload-rejected": "logs.detail.cause.payloadRejected",
  "upstream-fault": "logs.detail.cause.upstreamFault",
  "empty-output": "logs.detail.cause.emptyOutput",
  "client-cancelled": "logs.detail.cause.clientCancelled",
  "local-refusal": "logs.detail.cause.localRefusal",
} as const satisfies Record<RequestFailureCause, string>;

/** i18n key for each stage the caller's view of the exchange reached. */
const FAILURE_STAGE_KEYS = {
  "pre-header": "logs.detail.stage.preHeader",
  "headers-only": "logs.detail.stage.headersOnly",
  "protocol-prelude": "logs.detail.stage.protocolPrelude",
  "semantic-output": "logs.detail.stage.semanticOutput",
  "side-effect": "logs.detail.stage.sideEffect",
  "terminal": "logs.detail.stage.terminal",
} as const satisfies Record<RequestFailureStage, string>;

/** i18n key for each resend verdict; every refusal names which refusal it is. */
const RESEND_PERMISSION_KEYS = {
  "permitted": "logs.detail.resend.permitted",
  "permitted-after-repair": "logs.detail.resend.permittedAfterRepair",
  "refused-ambiguous": "logs.detail.resend.refusedAmbiguous",
  "refused-committed": "logs.detail.resend.refusedCommitted",
  "refused-futile": "logs.detail.resend.refusedFutile",
} as const satisfies Record<ResendPermission, string>;

/**
 * Localized cause, stage and resend verdict for a row that carries them.
 *
 * A stale or hand-edited row can carry a value outside the roster, so each lookup falls back to
 * the wire value rather than handing `t()` an undefined key. Showing the raw member is more
 * useful than showing nothing, which is the mistake the recovery catalog made.
 */
export function failureAttributionLabels(
  row: LogFailureAttribution,
  t: TFn,
): { cause?: string; stage?: string; resend?: string } {
  const causeKey = row.failureCause === undefined ? undefined : (Object.hasOwn(FAILURE_CAUSE_KEYS, row.failureCause) ? FAILURE_CAUSE_KEYS[row.failureCause] : undefined);
  const stageKey = row.failureStage === undefined ? undefined : (Object.hasOwn(FAILURE_STAGE_KEYS, row.failureStage) ? FAILURE_STAGE_KEYS[row.failureStage] : undefined);
  const resendKey = row.resendPermission === undefined ? undefined : (Object.hasOwn(RESEND_PERMISSION_KEYS, row.resendPermission) ? RESEND_PERMISSION_KEYS[row.resendPermission] : undefined);
  return {
    ...(row.failureCause ? { cause: causeKey ? t(causeKey) : row.failureCause } : {}),
    ...(row.failureStage ? { stage: stageKey ? t(stageKey) : row.failureStage } : {}),
    ...(row.resendPermission ? { resend: resendKey ? t(resendKey) : row.resendPermission } : {}),
  };
}


const nonnegativeInteger = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= 0;

export function failureSummary(
  row: LogFailureAttribution & { spend?: RequestSpendTotals; attempts?: Array<{ sendCount: number }>; attemptNormalizationDropped?: boolean },
  fallback: { label: string; description: string } | null,
  t: TFn,
): { label?: string; description?: string; sends?: number; unresolved?: number; retries?: number } {
  const cause = row.failureCause;
  const causeKey = cause && Object.hasOwn(FAILURE_CAUSE_KEYS, cause) ? FAILURE_CAUSE_KEYS[cause] : undefined;
  const result: { label?: string; description?: string; sends?: number; unresolved?: number; retries?: number } = causeKey
    ? { label: t(causeKey) }
    : { label: fallback?.label, description: fallback?.description };
  const spend = row.spend;
  if (!spend || !nonnegativeInteger(spend.sends) || !nonnegativeInteger(spend.settled)
    || !nonnegativeInteger(spend.unresolved) || spend.settled > spend.sends
    || (spend.reserved !== undefined && !nonnegativeInteger(spend.reserved))) return result;
  result.sends = spend.sends;
  result.unresolved = spend.unresolved;
  if (spend.unresolved === 0 && spend.settled === spend.sends
    && (spend.reserved === undefined || spend.reserved <= spend.settled)
    && row.attemptNormalizationDropped !== true && Array.isArray(row.attempts) && row.attempts.length === 1
    && nonnegativeInteger(row.attempts[0]?.sendCount) && row.attempts[0].sendCount === spend.sends) {
    result.retries = Math.max(0, spend.sends - 1);
  }
  return result;
}

/** i18n key for each upstream condition the server classified; total over the closed enum. */
const UPSTREAM_CONDITION_KEYS = {
  auth_failed: "logs.detail.condition.authFailed",
  access_denied: "logs.detail.condition.accessDenied",
  context_overflow: "logs.detail.condition.contextOverflow",
  location_unsupported: "logs.detail.condition.locationUnsupported",
  account_verification_required: "logs.detail.condition.accountVerificationRequired",
  billing_exhausted: "logs.detail.condition.billingExhausted",
  model_unavailable: "logs.detail.condition.modelUnavailable",
  rate_limited: "logs.detail.condition.rateLimited",
  upstream_unavailable: "logs.detail.condition.upstreamUnavailable",
  upstream_failed: "logs.detail.condition.upstreamFailed",
  request_rejected: "logs.detail.condition.requestRejected",
} as const satisfies Record<UpstreamCondition, string>;

/** Localized label for a row's classified upstream condition; unknown values (newer servers) get none. */
export function upstreamConditionLabel(condition: unknown, t: TFn): string | undefined {
  return typeof condition === "string" && Object.hasOwn(UPSTREAM_CONDITION_KEYS, condition)
    ? t(UPSTREAM_CONDITION_KEYS[condition as UpstreamCondition])
    : undefined;
}

/** i18n key for each closed failure-detail code; total over the code set. */
const FAILURE_DETAIL_KEYS = {
  provider_error: "logs.failureDetail.providerError",
  header_timeout: "logs.failureDetail.headerTimeout",
  connect_timeout: "logs.failureDetail.connectTimeout",
  connect_failed: "logs.failureDetail.connectFailed",
  client_closed: "logs.failureDetail.clientClosed",
  body_stall: "logs.failureDetail.bodyStall",
  body_overflow: "logs.failureDetail.bodyOverflow",
  stream_error_stop: "logs.failureDetail.streamErrorStop",
  stream_ended_early: "logs.failureDetail.streamEndedEarly",
  stream_failed: "logs.failureDetail.streamFailed",
  output_limit: "logs.failureDetail.outputLimit",
  stall_timeout: "logs.failureDetail.stallTimeout",
  adapter_eof: "logs.failureDetail.adapterEof",
  generation_timeout: "logs.failureDetail.generationTimeout",
  turn_inactivity: "logs.failureDetail.turnInactivity",
} as const satisfies Record<FailureDetailCode, string>;

const VALUE_REQUIRED: ReadonlySet<FailureDetailCode> = new Set([
  "connect_timeout", "body_stall", "body_overflow", "generation_timeout", "turn_inactivity",
]);

/**
 * Localized text for a row's failure detail. Only a closed code with valid parameters renders; free
 * text (a legacy or edited row) and malformed details render nothing.
 */
export function failureDetailLabel(value: unknown, t: TFn): string | undefined {
  const detail = boundedFailureDetail(value);
  if (!detail) return undefined;
  if (detail.code === "provider_error") {
    const typed = detail.type ? t("logs.failureDetail.providerErrorTyped", { type: detail.type }) : t(FAILURE_DETAIL_KEYS.provider_error);
    // The provider's closed finishReason is a machine token, appended like the validation pairs.
    const label = detail.finishReason ? `${typed} [finishReason: ${detail.finishReason}]` : typed;
    return detail.validation ? `${label}: ${detail.validation.map(issue => `${issue.field} [${issue.type}]`).join("; ")}` : label;
  }
  if (detail.code === "header_timeout" && detail.value !== undefined) {
    return t("logs.failureDetail.headerTimeoutAfter", { value: detail.value });
  }
  if (VALUE_REQUIRED.has(detail.code)) {
    return detail.value === undefined ? undefined : t(FAILURE_DETAIL_KEYS[detail.code], { value: detail.value });
  }
  return t(FAILURE_DETAIL_KEYS[detail.code]);
}

