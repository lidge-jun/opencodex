/**
 * Proxy-authored failure detail for request logs.
 *
 * Some transports describe a failure themselves (header timeout, body stall, byte cap, client close,
 * a restated upstream status and closed error type). The row keeps a closed FailureDetail code with
 * bounded parameters (src/lib/failure-detail.ts); the English text goes only into the context's
 * upstreamError, which internal classifiers and status heuristics read and which never reaches a row.
 * Only proxy-composed text may be passed here.
 */
import type { FailureDetail, FailureDetailCode } from "../lib/failure-detail";

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
