import type { TFn } from "../i18n/shared";
import type { RequestFailureCause, RequestFailureStage, ResendPermission, RequestSpendTotals } from "../../../src/usage/telemetry-contract";

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
