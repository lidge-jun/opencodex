import { unlockRateLimitGate } from "./gate-rewrite";

/**
 * Line-level rewrite for the app-server's JSON-RPC output.
 *
 * Only the two messages that carry the composer's gate are rewritten: the
 * `account/rateLimits/updated` notification and a result whose top level holds the rate-limit
 * snapshot (the `account/rateLimits/read` response). Every other message is left alone, including
 * thread items and tool results that happen to nest a `rate_limit` object. Lines that do not
 * mention the snapshot fields are not even parsed, so the hot path costs two substring checks and
 * the bytes stay identical.
 */
const RATE_LIMITS_UPDATED = "account/rateLimits/updated";
const RATE_LIMIT_RESULT_FIELDS = ["rateLimits", "rateLimitsByLimitId", "ordinaryUsageAllowed"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The part of a message the gate rewrite may touch, or null when the message carries no gate. */
function gatePayload(message: unknown): Record<string, unknown> | null {
  if (!isRecord(message)) return null;
  if (message.method === RATE_LIMITS_UPDATED) return isRecord(message.params) ? message.params : null;
  if ("method" in message) return null;
  const result = message.result;
  return isRecord(result) && RATE_LIMIT_RESULT_FIELDS.some(field => field in result) ? result : null;
}

/**
 * Returns the rewritten line, or null when the line is not a gate-bearing JSON-RPC message or the
 * rewrite has nothing to change. Parse failures also return null: the rewrite owns removal of
 * known-shaped locks, not validation.
 */
export function rewriteAppServerLine(line: string): string | null {
  if (!line.includes("rateLimit") && !line.includes("ordinaryUsageAllowed")) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  const payload = gatePayload(parsed);
  if (payload === null) return null;
  return unlockRateLimitGate(payload) ? JSON.stringify(parsed) : null;
}
