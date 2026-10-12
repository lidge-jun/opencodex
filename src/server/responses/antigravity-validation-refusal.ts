import { ANTIGRAVITY_VALIDATION_REQUIRED_PREFIX, safeAntigravityHttpErrorMessage } from "../../adapters/google-errors";
import { readBoundedResponseBody } from "../../lib/bounded-body";

/** Match only the normalized Antigravity validation-refusal marker. */
export function hasAntigravityValidationRefusalMarker(text: string): boolean {
  return text.startsWith(`${ANTIGRAVITY_VALIDATION_REQUIRED_PREFIX}: `);
}

/** Inspect only the Google adapter's normalized, already bounded 403 response. */
export async function isAntigravityValidationRefusal(response: Response, signal?: AbortSignal): Promise<boolean> {
  return inspectValidationRefusal(response, signal, false);
}

/** Sidecar dispatch retains the raw Google envelope; normalize only a complete bounded body. */
export async function isAntigravityRawValidationRefusal(response: Response, signal?: AbortSignal): Promise<boolean> {
  return inspectValidationRefusal(response, signal, true);
}

async function inspectValidationRefusal(response: Response, signal: AbortSignal | undefined, raw: boolean): Promise<boolean> {
  if (response.status !== 403 || signal?.aborted) return false;
  try {
    const body = await readBoundedResponseBody(response.clone(), {
      maxBytes: raw ? 4096 : 1024,
      totalTimeoutMs: raw ? 2000 : 1000,
      firstByteTimeoutMs: raw ? 2000 : 1000,
      inactivityTimeoutMs: raw ? 2000 : 1000,
      signal,
    });
    return !signal?.aborted && body.displaySafe && !body.truncated && !body.timedOut && !body.oversized
      && hasAntigravityValidationRefusalMarker(raw ? safeAntigravityHttpErrorMessage(403, body.text) : body.text);
  } catch {
    return false;
  }
}
