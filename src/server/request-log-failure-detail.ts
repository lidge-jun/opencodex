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

export function recordLocalFailureDetail(
  logCtx: { upstreamError?: string; failureDetail?: string },
  detail: string,
): void {
  const bounded = detail.slice(0, FAILURE_DETAIL_MAX_LENGTH);
  // The classifier and status heuristics keep reading upstreamError, so set both.
  logCtx.upstreamError = bounded;
  logCtx.failureDetail = bounded;
}
