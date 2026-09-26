/** Pure eligibility policy. The caller owns admission, buffering, dispatch and the shared budget. */
export interface CompactionRecoveryConfig {
  enabled: true;
  model: string;
  allowDevinInvalidArgument?: boolean;
}

/** Evidence must describe the failed attempt, never request text or a guessed error message. */
export interface CompactionRecoveryEvidence {
  requestKind: "ordinary" | "compaction-v1" | "compaction-v2";
  recoveryAttempts: number;
  cancelled: boolean;
  nonReplayable: boolean;
  /** Any semantic output observed, including output retained privately before delivery. */
  partialOutput: boolean;
  toolEffects: boolean;
  remainingSends: number;
  /** Canonical serving identities resolved by the caller, including provider/account identity. */
  originalModel: string;
  fallbackModel: string;
  /** Actual serving adapter/provider, not a prefix inferred from the requested selector. */
  provider: string;
  httpStatus?: number;
  /** A completed result is never retried. Output validation belongs to the caller. */
  responseStatus: "completed" | "failed" | "incomplete" | "unknown";
  errorCode?: string;
  errorType?: string;
  authenticationDenied: boolean;
  policyDenied: boolean;
  budgetDenied: boolean;
  refusal: boolean;
  upstreamFailure: boolean;
}

export type CompactionRecoveryDecision =
  | { recover: true; model: string; reason: "context-overflow" | "compaction-output" | "upstream-unavailable" | "devin-invalid-argument" }
  | { recover: false; reason: "disabled" | "invalid-evidence" | "ordinary-request" | "already-attempted" | "cancelled" | "unsafe-replay" | "protected-failure" | "budget-exhausted" | "same-model" | "succeeded" | "unclassified-failure" };

const MODEL_LIMIT = 512;
const safeName = (value: unknown, limit: number): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= limit
  && value === value.trim() && !/[\u0000-\u0020\u007f-\u009f]/.test(value);

/** Invalid persisted values disable recovery rather than widening it. No configurable retry count. */
export function readCompactionRecoveryConfig(value: unknown): CompactionRecoveryConfig | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (Object.keys(raw).some(key => !["enabled", "model", "allowDevinInvalidArgument"].includes(key))
    || raw.enabled !== true || !safeName(raw.model, MODEL_LIMIT)
    || (raw.allowDevinInvalidArgument !== undefined && typeof raw.allowDevinInvalidArgument !== "boolean")) return null;
  return {
    enabled: true,
    model: raw.model,
    ...(raw.allowDevinInvalidArgument !== undefined ? { allowDevinInvalidArgument: raw.allowDevinInvalidArgument } : {}),
  };
}

// Structured tokens only. The normalizer must also supply the explicit denial flags above.
const PROTECTED_CODE = /(?:^|_)(?:auth|authentication|authorization|unauthenticated|unauthorized|permission|forbidden|policy|refusal|refused|budget|quota|billing|safety|content_filter|origin_rejected|admission|scope)(?:_|$)/;
const CONTEXT_CODES = new Set(["context_length_exceeded", "context_window_exceeded", "input_too_long"]);
const COMPACTION_CODES = new Set(["compaction_failed", "invalid_compaction_output", "empty_compaction_output"]);
const SERVER_CODES = new Set(["upstream_error", "upstream_server_error", "server_is_overloaded", "internal", "internal_error", "server_error", "unavailable", "service_unavailable", "gateway_timeout"]);

/** Decides eligibility only; returning true neither spends nor grants another send. */
export function decideCompactionRecovery(
  value: unknown,
  evidence: CompactionRecoveryEvidence,
): CompactionRecoveryDecision {
  const config = readCompactionRecoveryConfig(value);
  if (!config) return { recover: false, reason: "disabled" };
  const flags = [evidence.cancelled, evidence.nonReplayable, evidence.partialOutput, evidence.toolEffects,
    evidence.authenticationDenied, evidence.policyDenied, evidence.budgetDenied, evidence.refusal, evidence.upstreamFailure];
  if (flags.some(flag => typeof flag !== "boolean")
    || !Number.isSafeInteger(evidence.recoveryAttempts) || evidence.recoveryAttempts < 0
    || !Number.isSafeInteger(evidence.remainingSends) || evidence.remainingSends < 0
    || !safeName(evidence.originalModel, MODEL_LIMIT) || !safeName(evidence.fallbackModel, MODEL_LIMIT)
    || !safeName(evidence.provider, 128)
    || !["ordinary", "compaction-v1", "compaction-v2"].includes(evidence.requestKind)
    || !["completed", "failed", "incomplete", "unknown"].includes(evidence.responseStatus)
    || (evidence.httpStatus !== undefined && (!Number.isInteger(evidence.httpStatus) || evidence.httpStatus < 100 || evidence.httpStatus > 599))
    || [evidence.errorCode, evidence.errorType].some(code => code !== undefined && !safeName(code, 128))) {
    return { recover: false, reason: "invalid-evidence" };
  }
  if (evidence.requestKind === "ordinary") return { recover: false, reason: "ordinary-request" };
  if (evidence.recoveryAttempts !== 0) return { recover: false, reason: "already-attempted" };
  const status = evidence.httpStatus;
  const codes = [evidence.errorCode, evidence.errorType].filter((code): code is string => code !== undefined);
  if (evidence.cancelled || status === 499 || codes.some(code => code === "cancelled" || code === "canceled" || code === "client_cancelled")) {
    return { recover: false, reason: "cancelled" };
  }
  if (evidence.nonReplayable || evidence.partialOutput || evidence.toolEffects) return { recover: false, reason: "unsafe-replay" };
  if (evidence.authenticationDenied || evidence.policyDenied || evidence.budgetDenied || evidence.refusal
    || status === 401 || status === 403 || status === 402 || status === 429
    || codes.some(code => PROTECTED_CODE.test(code.toLowerCase()) || code === "failed_precondition")) {
    return { recover: false, reason: "protected-failure" };
  }
  if (evidence.remainingSends === 0) return { recover: false, reason: "budget-exhausted" };
  if (evidence.originalModel === evidence.fallbackModel) return { recover: false, reason: "same-model" };
  if (evidence.responseStatus === "completed") return { recover: false, reason: "succeeded" };
  const failedHttp = status !== undefined && status >= 400;
  if (!evidence.upstreamFailure || (!failedHttp && evidence.responseStatus !== "failed")) {
    return { recover: false, reason: "unclassified-failure" };
  }
  const code = evidence.errorCode;
  const requestFailure = status === undefined || status === 200 || status === 400 || status === 413 || status === 422 || status >= 500;
  if (requestFailure && code && CONTEXT_CODES.has(code)) return { recover: true, model: config.model, reason: "context-overflow" };
  if (requestFailure && code && COMPACTION_CODES.has(code)) return { recover: true, model: config.model, reason: "compaction-output" };
  if (config.allowDevinInvalidArgument === true && evidence.provider === "devin" && code === "invalid_argument"
    && (evidence.responseStatus === "failed" || (status !== undefined && status >= 400 && status < 500))) {
    return { recover: true, model: config.model, reason: "devin-invalid-argument" };
  }
  if (status !== undefined && status >= 500 && (code === undefined || SERVER_CODES.has(code))) {
    return { recover: true, model: config.model, reason: "upstream-unavailable" };
  }
  return { recover: false, reason: "unclassified-failure" };
}
