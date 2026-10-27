/** Account-scoped Antigravity refusals. Unknown data never convicts an account. */
import { BOUNDED_BODY_MAX_BYTES } from "../lib/bounded-body";
import { registerProviderResponseProvenance } from "../providers/request-pacing";
import { parseUpstreamJsonPayload } from "./upstream-http-error";

/** Trusted only at the original Google body boundary; never serialized or inferred from display text. */
const modelNotFoundResponses = new WeakMap<Response, true>();
registerProviderResponseProvenance(modelNotFoundResponses);
export const hasAntigravityModelNotFoundProvenance = (response: Response): boolean => modelNotFoundResponses.has(response);

/** The caller supplies a complete original body, bounded to 4 KiB before normalization. */
export function markAntigravityModelNotFound(response: Response, requestBody: string, payloadText: string): void {
  if (response.status !== 404 || Buffer.byteLength(payloadText, "utf8") > 4096) return;
  const request = parseUpstreamJsonPayload(requestBody) as { model?: unknown } | undefined;
  const payload = parseUpstreamJsonPayload(payloadText) as { error?: {
    code?: unknown; status?: unknown; message?: unknown; details?: unknown;
  } } | undefined;
  const model = request?.model;
  const error = payload?.error;
  if (typeof model !== "string" || !model || !error || error.status !== "NOT_FOUND"
    || (error.code !== undefined && error.code !== 404)) return;
  const escaped = model.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const modelResource = new RegExp(`(?:^|/)models/${escaped}$`);
  const namedMessage = new RegExp(`\\bmodel\\s+["']?${escaped}["']?\\s+(?:was\\s+)?not found\\b`, "i");
  const resourceMessage = new RegExp(`\\bmodels/${escaped}(?=$|[\\s"':,;])`);
  const message = typeof error.message === "string" ? error.message : "";
  const details = Array.isArray(error.details) ? error.details : [];
  const resourceInfo = details.filter((detail): detail is Record<string, unknown> =>
    detail !== null && typeof detail === "object" && !Array.isArray(detail)
    && detail["@type"] === "type.googleapis.com/google.rpc.ResourceInfo");
  // A concrete project/resource refusal must not be recast as a model denial by incidental prose.
  if (resourceInfo.some(detail => typeof detail.resourceName !== "string" || !modelResource.test(detail.resourceName)
    || (detail.resourceType !== undefined && (typeof detail.resourceType !== "string"
      || !/(?:^|[./])models?$/i.test(detail.resourceType))))) return;
  if (!/\bnot found\b/i.test(message)) return;
  if (namedMessage.test(message) || resourceMessage.test(message) || resourceInfo.length > 0)
    modelNotFoundResponses.set(response, true);
}

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
