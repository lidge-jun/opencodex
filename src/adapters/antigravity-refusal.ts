/** Account-scoped Antigravity refusals. Unknown data never convicts an account. */
import { BOUNDED_BODY_MAX_BYTES } from "../lib/bounded-body";

export type AntigravityRefusalKind = "verify_account" | "other";
export interface AntigravityRefusal { kind: AntigravityRefusalKind }

const VERIFY_ACCOUNT_WORDS = [
  "verify your account",
] as const;

/**
 * Classify an Antigravity (Cloud Code Assist) HTTP refusal.
 *
 * Only the observed 403 verification demand convicts: Google answers
 * `PERMISSION_DENIED` with "Please verify your account to continue using
 * Antigravity." when the account itself is blocked, while the stored OAuth
 * grant (and its refresh) stays valid. Anything else — rate limits, location
 * refusals, malformed or oversized bodies — is "other" and must never mark
 * the account.
 */
export function classifyAntigravityRefusal(status: number, bodyText: string): AntigravityRefusal {
  if (status !== 403) return { kind: "other" };
  if (Buffer.byteLength(bodyText, "utf8") > BOUNDED_BODY_MAX_BYTES)
    return { kind: "other" };
  const lower = bodyText.toLowerCase();
  if (VERIFY_ACCOUNT_WORDS.some(word => lower.includes(word))) return { kind: "verify_account" };
  return { kind: "other" };
}
