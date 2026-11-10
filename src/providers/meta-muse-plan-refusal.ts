import type { RequestFailureCause } from "../usage/telemetry-contract";

/**
 * Meta's Muse Code subscription refusal (#8352).
 *
 * A Muse Code subscription key is valid, and Meta scopes it to the Muse Code client. Every request
 * from another client is refused with HTTP 403 and one fixed sentence, so the credential is not
 * rejected and no login can lift the restriction. Classifying it as `permission_denied` /
 * `credential-rejected` sent operators to re-authenticate a key that works exactly as Meta sold it;
 * the refusal is a plan restriction whose only remedy is a pay-as-you-go key.
 *
 * The match is deliberately narrow, in the shape of `anthropic-billing-refusal.ts`: a 403, an
 * OpenAI-compatible `error` envelope, and that whole sentence. A missed match leaves the turn
 * failing with Meta's own text, which is already legible; a loose match would relabel an unrelated
 * permission denial that the operator fixes another way.
 */

/** The envelope and message are upstream-controlled input; this bounds what is read. */
const MAX_REFUSAL_CHARS = 8 * 1024;

/** Meta's two sentences, whole. A suffix, prefix, or reworded copy is a different refusal. */
const PLAN_REFUSAL = /^This API key is billed to a Muse Code subscription\. Muse Code subscriptions cover requests from the Muse Code client only\. Use it in Muse Code, or use a pay-as-you-go API key for other clients\.?$/i;

/** Classes Meta has been observed to put on this refusal; anything else is a different verdict. */
const PERMISSION_TYPES = new Set(["permission_error", "permission_denied", "invalid_request_error"]);
const PERMISSION_CODES = new Set(["permission_denied", "permission_error", "subscription_required", "forbidden"]);

/**
 * The one sentence a client sees instead of Meta's refusal.
 *
 * It names the restriction, the fact that no retry or re-login changes it, and the supported path.
 * It is also a proxy literal that later classification passes recognize verbatim, so the Chat and
 * Anthropic formatters cannot fold it back into `permission_denied`.
 */
export const META_MUSE_PLAN_REFUSAL_MESSAGE = "Meta rejected this request because the configured key is billed to a Muse Code subscription, and Meta restricts Muse Code subscription keys to the Muse Code client. This is a plan restriction on a valid credential, not an expired one, so a new login cannot lift it. Use a pay-as-you-go Meta API key with the meta-model provider instead (export it as META_MODEL_API_KEY); OpenCodex cannot serve this request with a Muse Code subscription key.";

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Only a 403 error envelope carrying Meta's whole sentence is evidence. */
export function isMetaMusePlanRefusal(status: number, payload: unknown): boolean {
  if (status !== 403 || !record(payload) || !record(payload.error)) return false;
  const error = payload.error;
  if (typeof error.message !== "string" || error.message.length > MAX_REFUSAL_CHARS) return false;
  if (error.type != null && (typeof error.type !== "string" || !PERMISSION_TYPES.has(error.type))) return false;
  if (error.code != null && (typeof error.code !== "string" || !PERMISSION_CODES.has(error.code))) return false;
  return PLAN_REFUSAL.test(error.message.trim());
}

/**
 * The same evidence after HTTP error formatting, which frames the body as `Provider error 403: …`.
 * A bare sentence body is accepted too: the refusal is the whole payload either way, and the
 * sentence is the only thing that grants the verdict.
 */
export function isMetaMusePlanFailure(status: number, message: string): boolean {
  if (status !== 403 || typeof message !== "string" || message.length > MAX_REFUSAL_CHARS) return false;
  let text = message.trim();
  // This proxy's own copy re-enters later formatters; keep it in the same class without re-reading
  // upstream bytes.
  if (text === META_MUSE_PLAN_REFUSAL_MESSAGE) return true;
  const prefix = `Provider error ${status}: `;
  if (text.startsWith(prefix)) text = text.slice(prefix.length).trim();
  if (text === META_MUSE_PLAN_REFUSAL_MESSAGE) return true;
  try {
    const payload: unknown = JSON.parse(text);
    if (isMetaMusePlanRefusal(status, payload)) return true;
    // The proxy's own error envelope carrying its own sentence: a later pass that re-parses the
    // rewritten body keeps the class.
    if (record(payload) && record(payload.error) && payload.error.message === META_MUSE_PLAN_REFUSAL_MESSAGE) return true;
  } catch {
    // A non-JSON body falls through to the whole-sentence test below.
  }
  return PLAN_REFUSAL.test(text);
}

/**
 * Stamp the plan-restriction cause on a request row and return the client sentence, or undefined
 * for any other failure.
 *
 * The cause is stamped at the site that proved it: the status alone cannot tell this 403 from a
 * rejected credential, and `quota-exhausted` is the closed roster's plan/entitlement class, whose
 * resend verdict is `refused-futile`. `causeHint` outranks the status table in
 * `deriveRequestFailureCause`, so both the row and the attempt report the plan class.
 */
export function stampMetaMusePlanRefusal(
  logCtx: { causeHint?: RequestFailureCause },
  status: number,
  bodyText: string,
): string | undefined {
  if (!isMetaMusePlanFailure(status, bodyText)) return undefined;
  logCtx.causeHint = "quota-exhausted";
  return META_MUSE_PLAN_REFUSAL_MESSAGE;
}
