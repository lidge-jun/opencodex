/**
 * Proxy-authored failure detail for request logs.
 *
 * Some transports describe a failure with text this proxy writes itself: fixed sentences, numeric
 * guard limits and closed upstream type names (header timeout, body stall, byte cap, client close,
 * "Provider error 400: invalid_request_error"). That text is kept on the row as failureDetail, apart
 * from upstreamError, which may hold upstream-authored text and never leaves the request context.
 * Only proxy-composed strings may be passed here.
 */
export const FAILURE_DETAIL_MAX_LENGTH = 500;

/** Contexts whose upstreamError currently holds proxy text rather than upstream evidence. */
const localOnly = new WeakSet<object>();

/**
 * Pass \`upstreamEvidence: true\` only when the text restates an upstream response (its status and a
 * closed type); a local timeout, cap or cancel is not evidence of an upstream condition.
 */
export function recordLocalFailureDetail(
  logCtx: { upstreamError?: string; failureDetail?: string },
  detail: string,
  options: { upstreamEvidence?: boolean } = {},
): void {
  const bounded = detail.slice(0, FAILURE_DETAIL_MAX_LENGTH);
  // The classifier and status heuristics keep reading upstreamError, so set both.
  logCtx.upstreamError = bounded;
  logCtx.failureDetail = bounded;
  if (options.upstreamEvidence) localOnly.delete(logCtx);
  else localOnly.add(logCtx);
}

/** True when the context's upstreamError is proxy text; the final row then carries no upstream evidence. */
export function upstreamErrorIsLocal(logCtx: object): boolean {
  return localOnly.has(logCtx);
}
