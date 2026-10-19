/** Account-scoped Kiro refusals. Unknown data never convicts an account. */
import { BOUNDED_BODY_MAX_BYTES } from "../lib/bounded-body";
export type KiroRefusalKind = "rate" | "monthly_quota" | "suspended" | "profile" | "other";
export interface KiroRefusal { kind: KiroRefusalKind; resetAt?: number }

/** The vendor's own name for the body validator that rejects a request for this identity. */
const VALIDATION_EXCEPTION = "ValidationException";
/** Kiro's wording for that rejection; the code alone is also what a genuinely bad payload gets. */
const IMPROPER_REQUEST_WORD = /improperly formed request/i;

const SUSPENSION_WORDS = [
  "temporarily suspended", "temporarily is suspended",
  "locked your account", "locked it as a",
] as const;

export function classifyKiroRefusal(status: number, bodyText: string): KiroRefusal {
  if (Buffer.byteLength(bodyText, "utf8") > BOUNDED_BODY_MAX_BYTES)
    return { kind: status === 429 ? "rate" : "other" };
  let reason: unknown;
  let message: unknown;
  try {
    const row: unknown = JSON.parse(bodyText);
    if (row && typeof row === "object" && !Array.isArray(row)) {
      reason = (row as Record<string, unknown>).reason;
      message = (row as Record<string, unknown>).message;
    }
  } catch { /* Unrecognised bodies cannot establish an account verdict. */ }
  if ((status === 400 || status === 429) && reason === "MONTHLY_REQUEST_COUNT")
    return { kind: "monthly_quota" };
  // A 400 whose own validator calls the body improperly formed is not proof that the request is
  // impossible: Kiro answers this shape when the identity a request was routed under cannot serve
  // it. Treating it as `other` leaves the account selected and the same 400 reaches the client.
  // Both vendor tokens are required, so a bad payload or a caller echoing one token stays terminal.
  if (status === 400 && typeof message === "string" && IMPROPER_REQUEST_WORD.test(message)
    && (reason === VALIDATION_EXCEPTION || message.includes(VALIDATION_EXCEPTION)))
    return { kind: "profile" };
  if (status === 403 && (reason === "TEMPORARILY_SUSPENDED"
    || (typeof message === "string" && SUSPENSION_WORDS.some(word => message.toLowerCase().includes(word)))))
    return { kind: "suspended" };
  if (status === 429) return { kind: "rate" };
  return { kind: "other" };
}

/**
 * The same verdict at the combo layer, where the body arrives as wrapped text rather than as a
 * live response ("Provider error 400: {...}"), which JSON cannot parse. Both vendor tokens must
 * still appear for the shape to count.
 */
export function isKiroAccountProfileRefusal(status: number, bodyText: string): boolean {
  if (status !== 400 || Buffer.byteLength(bodyText, "utf8") > BOUNDED_BODY_MAX_BYTES) return false;
  return bodyText.includes(VALIDATION_EXCEPTION) && IMPROPER_REQUEST_WORD.test(bodyText);
}
