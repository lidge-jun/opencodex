/** Account-scoped Kiro refusals. Unknown data never convicts an account. */
import { BOUNDED_BODY_MAX_BYTES } from "../lib/bounded-body";
export type KiroRefusalKind = "rate" | "monthly_quota" | "suspended" | "other";
export interface KiroRefusal { kind: KiroRefusalKind; resetAt?: number }

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
  if (status === 403 && (reason === "TEMPORARILY_SUSPENDED"
    || (typeof message === "string" && SUSPENSION_WORDS.some(word => message.toLowerCase().includes(word)))))
    return { kind: "suspended" };
  if (status === 429) return { kind: "rate" };
  return { kind: "other" };
}
