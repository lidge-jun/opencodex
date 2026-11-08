import { upstreamValidationIssues } from "../lib/upstream-validation-detail";
import { clientFacingModelText, errorDestinationText, providerErrorDestinationLabel } from "../lib/error-destination";
import { knownModelIdentity } from "../lib/model-identity";
/**
 * Proxy-authored failure detail for request logs.
 *
 * Some transports describe a failure themselves (header timeout, body stall, byte cap, client close,
 * a restated upstream status and closed error type). The row keeps a closed FailureDetail code with
 * bounded parameters (src/lib/failure-detail.ts); the English text goes only into the context's
 * upstreamError, which internal classifiers and status heuristics read and which never reaches a row.
 * Only proxy-composed text may be passed here.
 */
import { boundedFailureDetail, type FailureDetail, type FailureDetailCode } from "../lib/failure-detail";

export type { FailureDetail };

export const FAILURE_DETAIL_MAX_LENGTH = 500;

/** Contexts whose upstreamError currently holds proxy text rather than upstream evidence. */
const localOnly = new WeakSet<object>();

/**
 * Pass `upstreamEvidence: true` only when the text restates an upstream response (its status and a
 * closed type); a local timeout, cap or cancel is not evidence of an upstream condition.
 */
export function recordLocalFailureDetail(
  logCtx: { upstreamError?: string; failureDetail?: FailureDetail },
  text: string,
  detail: FailureDetail,
  options: { upstreamEvidence?: boolean } = {},
): void {
  // The classifier and status heuristics keep reading upstreamError; the row keeps the closed detail.
  logCtx.upstreamError = text.slice(0, FAILURE_DETAIL_MAX_LENGTH);
  logCtx.failureDetail = detail;
  if (options.upstreamEvidence) localOnly.delete(logCtx);
  else localOnly.add(logCtx);
}

/** True when the context's upstreamError is proxy text; the final row then carries no upstream evidence. */
export function upstreamErrorIsLocal(logCtx: object): boolean {
  return localOnly.has(logCtx);
}

const INCOMPLETE_REASONS: Readonly<Record<string, readonly [string, FailureDetailCode]>> = {
  max_output_tokens: ["Output reached the requested token limit (max_output_tokens)", "output_limit"],
  upstream_stall_timeout: ["Upstream stalled: no data for the stall-timeout window (upstream_stall_timeout)", "stall_timeout"],
  adapter_eof: ["Upstream stream ended unexpectedly without a terminal event (adapter_eof)", "adapter_eof"],
};

/**
 * A structured `incomplete_details.reason` (emitted by the bridge on a stall timeout or adapter EOF):
 * the context text that explains it, and a closed detail for a known reason.
 */
export function incompleteReasonDetail(reason: string): { text: string; detail?: FailureDetail } {
  const known = Object.prototype.hasOwnProperty.call(INCOMPLETE_REASONS, reason) ? INCOMPLETE_REASONS[reason] : undefined;
  return known ? { text: known[0], detail: { code: known[1] } } : { text: `Upstream incomplete: ${reason}` };
}

/** Local model refusals keep only client or catalog identities in the request row. */
export function projectLocalModelRefusalLog(
  logCtx: import("./request-log").RequestLogContext,
  clientModel: import("../lib/error-destination").ClientFacingModelLabel,
): void {
  const client = clientFacingModelText(clientModel);
  const known = (value: unknown) => knownModelIdentity(value, [client]);
  const providerKnown = (value: string) => errorDestinationText(providerErrorDestinationLabel(value)) === value;
  if (logCtx.provider && !providerKnown(logCtx.provider)) logCtx.provider = "unknown";
  logCtx.model = known(logCtx.model) ?? "unknown";
  logCtx.requestedModel = known(logCtx.requestedModel);
  logCtx.requestedAlias = known(logCtx.requestedAlias);
  logCtx.wireModel = known(logCtx.wireModel); logCtx.resolvedModel = known(logCtx.resolvedModel);
  logCtx.servedModel = known(logCtx.servedModel); logCtx.responseModelEcho = known(logCtx.responseModelEcho);
  for (const attempt of logCtx.attempts ?? []) {
    attempt.model = known(attempt.model) ?? "unknown";
    if (!providerKnown(attempt.provider)) attempt.provider = "unknown";
  }
  const decision = logCtx.routeDecision;
  if (decision && (!known(decision.requestedModel)
    || decision.candidates.some(candidate => !known(candidate.model) || !providerKnown(candidate.provider))
    || decision.selected && (!known(decision.selected.model) || !providerKnown(decision.selected.provider)))) logCtx.routeDecision = undefined;
}

/** Capture bounded schema facts before a 4xx is replaced by the client-facing error policy. */
export function recordUpstreamValidationDetail(logCtx: { failureDetail?: FailureDetail }, status: number, payload: unknown): void {
  if (status < 400 || status >= 500) return;
  let parsed = payload;
  if (typeof payload === "string") {
    if (payload.length > 256 * 1024) return;
    try { parsed = JSON.parse(payload); } catch { return; }
  }
  const validation = upstreamValidationIssues(parsed);
  if (!validation) return;
  const record = parsed as Record<string, unknown>;
  const nested = record.error !== null && typeof record.error === "object" && !Array.isArray(record.error)
    ? record.error as Record<string, unknown> : undefined;
  logCtx.failureDetail = boundedFailureDetail({ code: "provider_error", type: nested?.type ?? record.type, validation });
}
