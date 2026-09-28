import { ANTIGRAVITY_VALIDATION_REQUIRED_PREFIX } from "../../adapters/google-errors";
import { readBoundedResponseBody } from "../../lib/bounded-body";

/** Inspect only the Google adapter's normalized, already bounded 403 response. */
export async function isAntigravityValidationRefusal(response: Response, signal?: AbortSignal): Promise<boolean> {
  if (response.status !== 403 || signal?.aborted) return false;
  try {
    const body = await readBoundedResponseBody(response.clone(), {
      maxBytes: 1024,
      totalTimeoutMs: 1000,
      firstByteTimeoutMs: 1000,
      inactivityTimeoutMs: 1000,
      signal,
    });
    return !signal?.aborted && body.displaySafe && !body.truncated && !body.timedOut && !body.oversized
      && body.text.startsWith(`${ANTIGRAVITY_VALIDATION_REQUIRED_PREFIX}: `);
  } catch {
    return false;
  }
}
