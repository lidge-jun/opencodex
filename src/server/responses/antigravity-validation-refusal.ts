import { ANTIGRAVITY_ACCESS_DENIED_PREFIX, ANTIGRAVITY_VALIDATION_REQUIRED_PREFIX, safeAntigravityHttpErrorMessage } from "../../adapters/google-errors";
import { readBoundedResponseBody } from "../../lib/bounded-body";
import { classifyAntigravityRefusal, hasAntigravityModelNotFoundProvenance } from "../../adapters/antigravity-refusal";

/** Match only the normalized Antigravity validation-refusal marker. */
export function hasAntigravityValidationRefusalMarker(text: string): boolean {
  return text.startsWith(`${ANTIGRAVITY_VALIDATION_REQUIRED_PREFIX}: `);
}

/**
 * A normalized 403 that names this account's access, not a validation demand and not a "verify your
 * account" conviction (the dedicated quarantine path owns that one). The caller cools the account and
 * tries a sibling; nothing here marks the account durably, so a body that is wrong for every account
 * costs at most the bounded sibling hops, never a stored verdict.
 */
export function hasAntigravityAccessDeniedMarker(text: string): boolean {
  return text.startsWith(ANTIGRAVITY_ACCESS_DENIED_PREFIX) && classifyAntigravityRefusal(403, text).kind === "other";
}

/** Inspect only the Google adapter's normalized, already bounded 403 response. */
export async function isAntigravityValidationRefusal(response: Response, signal?: AbortSignal): Promise<boolean> {
  return inspectValidationRefusal(response, signal, false, hasAntigravityValidationRefusalMarker);
}

/** Normalized 403 whose account is simply refused: cool it and rotate (credential-rejected). */
export async function isAntigravityAccessDeniedRefusal(response: Response, signal?: AbortSignal): Promise<boolean> {
  return inspectValidationRefusal(response, signal, false, hasAntigravityAccessDeniedMarker);
}

/** Sidecar dispatch retains the raw Google envelope; normalize only a complete bounded body. */
export async function isAntigravityRawValidationRefusal(response: Response, signal?: AbortSignal): Promise<boolean> {
  return inspectValidationRefusal(response, signal, true,
    text => hasAntigravityValidationRefusalMarker(text) || text.startsWith(ANTIGRAVITY_ACCESS_DENIED_PREFIX));
}

async function inspectValidationRefusal(
  response: Response,
  signal: AbortSignal | undefined,
  raw: boolean,
  accepts: (text: string) => boolean,
): Promise<boolean> {
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
      && accepts(raw ? safeAntigravityHttpErrorMessage(403, body.text) : body.text);
  } catch {
    return false;
  }
}

/** Only original-body, model-specific Google adapter evidence qualifies for account rotation. */
export async function isAntigravityModelNotFoundRefusal(response: Response, signal?: AbortSignal): Promise<boolean> {
  return response.status === 404 && !signal?.aborted && hasAntigravityModelNotFoundProvenance(response);
}
