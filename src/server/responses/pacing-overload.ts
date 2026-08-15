import { formatErrorResponse } from "../../bridge";
import { RequestPacingQueueOverloadError } from "../../providers/request-pacing";

/** Convert local request-pacing admission failures into a retryable HTTP response. */
export function requestPacingOverloadResponse(error: unknown): Response | undefined {
  if (!(error instanceof RequestPacingQueueOverloadError)) return undefined;
  return formatErrorResponse(
    429,
    "rate_limit_error",
    error.message,
    { retryAfter: String(error.retryAfterSeconds) },
  );
}
