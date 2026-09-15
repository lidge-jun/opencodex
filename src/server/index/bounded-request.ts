import {
  assertServerAuthConfig,
  corsHeaders,
  managementCorsHeaders,
  isAllowedRequestOrigin,
  isAllowedManagementOrigin,
  isApiAuthRequired,
  isLoopbackHostname,
  jsonResponse,
  admissionFields,
  resolveApiAuth,
  resolveResponsesApiAuth,
  requestPolicyView,
  type DataPlaneAdmission,
  type RequestPolicyView,
  safeConfigDTO,
  setCorsOrigin,
  withCors,
  withManagementCors,
} from "../auth-cors";

// Header-safe by construction: a key id reaches a response header, so anything outside this
// class could inject a header break or a control character into a response we control.
const REMOTE_CATALOG_KEY_ID_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;
export const GUI_PAIRING_EXCHANGE_BODY_LIMIT = 4 * 1024;
export const REMOTE_WORKSPACE_PAIRING_BODY_LIMIT = 32 * 1024;

/**
 * Read at most `limit` bytes of a request body, or refuse.
 *
 * Returns null the moment the body is known to exceed `limit`, without retaining the excess.
 * `req.text()` cannot express that: it buffers to completion first, so a caller who omits
 * Content-Length or uses chunked framing decides how much memory the process spends. That
 * matters here because the one caller is an unauthenticated endpoint.
 *
 * limit+1 is the stopping point rather than limit, so a body exactly at the limit is still
 * accepted and only a genuinely over-limit body is rejected.
 */
export async function readBoundedRequestText(req: Request, limit: number): Promise<string | null> {
  const body = req.body;
  if (!body) return "";
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value || value.byteLength === 0) continue;
      total += value.byteLength;
      if (total > limit) return null;
      chunks.push(value);
    }
  } finally {
    // Cancel rather than only releasing the lock: on the reject path the peer may still be
    // sending, and an uncancelled body keeps that transfer alive.
    await reader.cancel().catch(() => {});
  }
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(joined);
}

/**
 * Name WHICH configured credential was admitted, so a multi-key operator can attribute a
 * catalog read.
 *
 * Scoped to configured keys on purpose: an environment token or a loopback bind has no key
 * to name, and emitting one anyway would invent an attribution that does not exist. 200 only
 * — this route emits no validator and therefore never answers 304.
 *
 * An id that fails the header-safe pattern is omitted rather than sanitized, with one warning
 * that does NOT repeat the id: logging the offending value is how a malformed id becomes a
 * log-injection vector instead of a dropped header.
 */
export function withRemoteCatalogKeyId(response: Response, admission: DataPlaneAdmission): Response {
  if (response.status !== 200 || admission.kind !== "configured") return response;
  if (!REMOTE_CATALOG_KEY_ID_PATTERN.test(admission.keyId)) {
    console.warn("[remote-catalog] configured API key id is not header-safe; omitting x-opencodex-key-id");
    return response;
  }
  response.headers.set("x-opencodex-key-id", admission.keyId);
  return response;
}
