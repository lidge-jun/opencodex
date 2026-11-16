import {
  ANTIGRAVITY_ACCESS_DENIED_PREFIX, ANTIGRAVITY_AUTH_FAILED_PREFIX, ANTIGRAVITY_VALIDATION_REQUIRED_PREFIX,
  safeAntigravityHttpErrorMessage,
} from "../../adapters/google-errors";
import { readBoundedResponseBody } from "../../lib/bounded-body";
import { classifyAntigravityRefusal, hasAntigravityModelNotFoundProvenance } from "../../adapters/antigravity-refusal";

/** Match only the normalized Antigravity validation-refusal marker. */
export function hasAntigravityValidationRefusalMarker(text: string): boolean {
  return text.startsWith(`${ANTIGRAVITY_VALIDATION_REQUIRED_PREFIX}: `);
}

/**
 * A normalized 403 that Google itself attributed to this account: a structured `PERMISSION_DENIED`
 * envelope (`classifyGoogle` keeps the "(PERMISSION_DENIED)" suffix only when it parsed that enum) or
 * the "authentication failed" wording Google sometimes puts under PERMISSION_DENIED. Not a validation
 * demand and not a "verify your account" conviction (the dedicated quarantine path owns that one). The
 * caller cools the account and tries a sibling; nothing here marks the account durably.
 *
 * `classifyGoogle` writes the bare "Antigravity access denied" prefix for every 403, including an empty
 * body, a proxy or WAF HTML page, or an envelope without the enum. That bare prefix says nothing about
 * this account, so it does not qualify: accepting it would walk the whole pool and cool every account
 * on a failure that is wrong for all of them.
 *
 * Text that carries the validation marker is never an access denial: that wording belongs to the
 * validation path, and an upstream message imitating it must not earn a different recovery.
 */
export function hasAntigravityAccessDeniedMarker(text: string): boolean {
  return (text.startsWith(`${ANTIGRAVITY_ACCESS_DENIED_PREFIX} (PERMISSION_DENIED)`)
    || text.startsWith(ANTIGRAVITY_AUTH_FAILED_PREFIX))
    && !text.includes(ANTIGRAVITY_VALIDATION_REQUIRED_PREFIX)
    && classifyAntigravityRefusal(403, text).kind === "other";
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
    text => hasAntigravityValidationRefusalMarker(text) || hasAntigravityAccessDeniedMarker(text));
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
