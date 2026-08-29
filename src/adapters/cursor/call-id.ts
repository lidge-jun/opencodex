/**
 * Reversible single-line codec for Cursor composite tool-call ids.
 *
 * Cursor's wire delivers tool-call ids that can be two identifiers glued with a
 * literal newline ("call-<uuid>-<n>\nfc_<uuid>_<n>"). OpenCodex forwards ids
 * verbatim, so that newline leaked into Responses-visible `call_id` values,
 * where line-oriented clients (logging, splitting, validation) break. The codec
 * encodes ids containing CR/LF into a versioned single-line form. It also
 * escapes ids already in that form's reserved namespace so encoding remains
 * injective. Both forms decode back to the exact upstream bytes before
 * anything is serialized toward Cursor.
 */

const CALL_ID_PREFIX = "ocxc1_";

/** True when the id needs encoding to survive line-oriented consumers. */
function needsEncoding(id: string): boolean {
  return id.includes("\n") || id.includes("\r");
}

/** Encode a Cursor wire call id into a single-line Responses-safe id. */
export function encodeCursorCallId(id: string): string {
  if (!needsEncoding(id) && !id.startsWith(CALL_ID_PREFIX)) return id;
  return CALL_ID_PREFIX + Buffer.from(id, "utf8").toString("base64url");
}

/**
 * Decode a Responses-visible call id back to the exact Cursor wire id.
 * Non-encoded ids (including legacy raw multi-line ids replayed by older
 * clients) pass through unchanged; a malformed encoded payload also passes
 * through rather than corrupting pairing.
 */
export function decodeCursorCallId(id: string): string {
  if (!id.startsWith(CALL_ID_PREFIX)) return id;
  const payload = id.slice(CALL_ID_PREFIX.length);
  if (payload.length === 0) return id;
  try {
    const decoded = Buffer.from(payload, "base64url").toString("utf8");
    // Round-trip guard: only trust payloads our encoder could have produced.
    if (Buffer.from(decoded, "utf8").toString("base64url") !== payload) return id;
    if (!needsEncoding(decoded) && !decoded.startsWith(CALL_ID_PREFIX)) return id;
    return decoded;
  } catch {
    return id;
  }
}
