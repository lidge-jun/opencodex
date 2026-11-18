import { readBoundedResponseBody } from "../lib/bounded-body";
import { markProxyError } from "../lib/client-error-body";
import type { OcxProviderConfig } from "../types";
import type { RequestFailureCause } from "../usage/telemetry-contract";

const LEGACY_PRIVACY_MARKER = "[WKE=privacy-mode:legacy]";
const MAX_ERROR_BYTES = 16_384;
export const XAI_LEGACY_PRIVACY_MESSAGE = "The xAI account uses Legacy (no storage), which blocks Grok Build. Switch the xAI account to Privacy Mode in the xAI/Grok privacy settings, then retry.";

export function isXaiGrokOAuth(providerName: string, provider: Pick<OcxProviderConfig, "authMode">): boolean {
  return providerName === "xai" && provider.authMode === "oauth";
}

/** Callers must have a bounded error body from the Grok OAuth endpoint. */
export function isXaiLegacyPrivacyError(status: number, text: string): boolean {
  if (status !== 403 || text.length > MAX_ERROR_BYTES) return false;
  try {
    const payload = JSON.parse(text) as { error?: string | { message?: unknown } } | null;
    const error = payload?.error;
    const message = typeof error === "string" ? error : error?.message;
    return typeof message === "string" && message.includes(LEGACY_PRIVACY_MARKER);
  } catch {
    return false;
  }
}

/** Consume a Grok OAuth 403 probe body. Missing, oversized and incomplete bodies keep the generic result. */
export async function readXaiLegacyPrivacyError(response: Response): Promise<boolean> {
  if (response.status !== 403) return false;
  try {
    const body = await readBoundedResponseBody(response, { maxBytes: MAX_ERROR_BYTES, fatalUtf8: true });
    return body.displaySafe && !body.truncated && isXaiLegacyPrivacyError(response.status, body.text);
  } catch {
    return false;
  }
}

const privacyRefusals = new WeakSet<Response>();

/** The 403 expresses the provider's account policy and carries no credential-recovery signal. */
export function xaiPrivacyModeRefusal(logCtx?: { causeHint?: RequestFailureCause }): Response {
  if (logCtx) logCtx.causeHint = "policy-refusal";
  const response = Response.json({
    error: { message: XAI_LEGACY_PRIVACY_MESSAGE, type: "permission_error", param: null, code: "permission_denied" },
  }, { status: 403 });
  privacyRefusals.add(response);
  return markProxyError(response);
}

export function isXaiPrivacyModeRefusal(response: Response): boolean {
  return privacyRefusals.has(response);
}
