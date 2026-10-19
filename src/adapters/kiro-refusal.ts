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

/** The adapter's own prefix for a normalized 400 (`normalizedKiroErrorMessage` in kiro-errors.ts). */
const KIRO_INVALID_REQUEST_PREFIX = "Kiro invalid request: ";

/**
 * The same verdict at the combo layer. There the text is either the adapter's normalized message
 * ("Kiro invalid request: ValidationException: Improperly formed request", what a combo child's
 * failure carries) or a raw JSON body, each possibly behind the "Provider error 400: " frame.
 * JSON goes through the parsed `reason`/`message` rules of `classifyKiroRefusal` (tokens in
 * unrelated fields never count); prose counts only behind the adapter's own prefix. Callers must
 * also know the failed target is a Kiro adapter.
 */
export function isKiroAccountProfileRefusal(status: number, bodyText: string): boolean {
  if (status !== 400 || Buffer.byteLength(bodyText, "utf8") > BOUNDED_BODY_MAX_BYTES) return false;
  const text = bodyText.replace(/^Provider error \d{3}: /, "");
  if (text.startsWith(KIRO_INVALID_REQUEST_PREFIX)) {
    const detail = text.slice(KIRO_INVALID_REQUEST_PREFIX.length);
    return detail.includes(VALIDATION_EXCEPTION) && IMPROPER_REQUEST_WORD.test(detail);
  }
  try {
    const row: unknown = JSON.parse(text);
    if (!row || typeof row !== "object" || Array.isArray(row)) return false;
    const envelope = (row as Record<string, unknown>).error;
    const body = envelope && typeof envelope === "object" && !Array.isArray(envelope) ? envelope : row;
    const { reason, message } = body as Record<string, unknown>;
    return classifyKiroRefusal(400, JSON.stringify({ reason, message })).kind === "profile";
  } catch { return false; }
}
