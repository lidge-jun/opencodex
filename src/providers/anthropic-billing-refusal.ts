/** Pure credit-balance evidence, independent of OAuth account routing. */
import { readBoundedResponseBody } from "../lib/bounded-body";
const MAX_BILLING_REFUSAL_BYTES = 8 * 1024;
const BILLING_REFUSAL_DEADLINE_MS = 250;
// Keep the whole-message credit-balance pattern used by anthropic-account-refusal.
const CREDIT_BALANCE_REFUSAL = /^Your credit balance is too low to access the Anthropic API\.(?: Please go to Plans & Billing to upgrade or purchase credits\.)?$/i;
const BILLING_ERROR_TYPES = new Set(["invalid_request_error", "billing_error", "permission_error"]);
const ACCOUNT_REFUSAL_CODES = new Set(["subscription_required", "insufficient_quota", "permission_denied"]);

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Only an Anthropic error envelope with exact billing wording is evidence. */
export function isAnthropicBillingRefusal(status: number, payload: unknown): boolean {
  if (status !== 400 && status !== 402) return false;
  if (!record(payload) || payload.type !== "error" || !record(payload.error)) return false;
  const error = payload.error;
  if (typeof error.type !== "string" || !BILLING_ERROR_TYPES.has(error.type)
    || typeof error.message !== "string" || Buffer.byteLength(error.message, "utf8") > MAX_BILLING_REFUSAL_BYTES) return false;
  if (error.code != null && (typeof error.code !== "string" || !ACCOUNT_REFUSAL_CODES.has(error.code))) return false;
  return CREDIT_BALANCE_REFUSAL.test(error.message.trim());
}

/** Bounded combo evidence after existing HTTP error formatting, before any output. */
export function isAnthropicBillingFailure(status: number, message: string, code?: string | null): boolean {
  if (status !== 400 && status !== 402 || Buffer.byteLength(message, "utf8") > MAX_BILLING_REFUSAL_BYTES) return false;
  if (code != null && !BILLING_ERROR_TYPES.has(code) && !ACCOUNT_REFUSAL_CODES.has(code)) return false;
  let text = message.trim();
  const prefix = `Provider error ${status}: `;
  if (text.startsWith(prefix)) text = text.slice(prefix.length);
  try { return isAnthropicBillingRefusal(status, JSON.parse(text)); } catch { /* Exact prose needs a structured type. */ }
  return typeof code === "string" && BILLING_ERROR_TYPES.has(code)
    && isAnthropicBillingRefusal(status, { type: "error", error: { type: code, message: text } });
}

/** Inspect a clone, never the terminal body; the shared reader owns interruption/cleanup. */
export async function readAnthropicBillingRefusal(response: Response, signal?: AbortSignal): Promise<boolean> {
  if (signal?.aborted || (response.status !== 400 && response.status !== 402)) return false;
  const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (!contentType || !/^application\/(?:json|[a-z0-9.+-]+\+json)$/.test(contentType)) return false;
  try {
    const deadline = AbortSignal.timeout(BILLING_REFUSAL_DEADLINE_MS);
    const body = await readBoundedResponseBody(response.clone(), {
      signal: signal ? AbortSignal.any([signal, deadline]) : deadline,
      maxBytes: MAX_BILLING_REFUSAL_BYTES, fatalUtf8: true,
      totalTimeoutMs: BILLING_REFUSAL_DEADLINE_MS,
    });
    if (signal?.aborted || !body.displaySafe || body.truncated || body.timedOut || body.oversized) return false;
    return isAnthropicBillingRefusal(response.status, JSON.parse(body.text));
  } catch {
    // Untrusted malformed, unreadable and invalid UTF-8 bodies confer no authority.
    return false;
  }
}
