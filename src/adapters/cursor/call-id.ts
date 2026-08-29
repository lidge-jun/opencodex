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
 *
 * The escape uses its OWN prefix rather than reusing the encoding one. Sharing a
 * prefix made the decoder guess: `ocxc1_b2N4YzFf` is a legal opaque upstream id
 * whose payload happens to decode to the literal text `ocxc1_`, so a decoder that
 * unwraps any payload beginning with the prefix turned that id into a bare
 * `ocxc1_` and sent the wrong id to Cursor, breaking call/result pairing for a
 * pre-change call or replayed history. Two prefixes remove the ambiguity: a
 * payload under `ocxc1_` is only ever CR/LF-bearing wire content, and a payload
 * under `ocxc1e_` is only ever an escaped reserved id.
 */

const CALL_ID_PREFIX = "ocxc1_";
/** Escape namespace for ids that already sit in a reserved namespace. */
const CALL_ID_ESCAPE_PREFIX = "ocxc1e_";

/** True when the id needs encoding to survive line-oriented consumers. */
function needsEncoding(id: string): boolean {
  return id.includes("\n") || id.includes("\r");
}

/** True when the id sits in a namespace this codec owns and must be escaped. */
function isReserved(id: string): boolean {
  return id.startsWith(CALL_ID_PREFIX) || id.startsWith(CALL_ID_ESCAPE_PREFIX);
}

/** Encode a Cursor wire call id into a single-line Responses-safe id. */
export function encodeCursorCallId(id: string): string {
  // CR/LF content is the codec's actual job, so it wins the primary namespace.
  if (needsEncoding(id)) return CALL_ID_PREFIX + Buffer.from(id, "utf8").toString("base64url");
  // A reserved id carries no newline; it only needs to stop looking like our output.
  if (isReserved(id)) return CALL_ID_ESCAPE_PREFIX + Buffer.from(id, "utf8").toString("base64url");
  return id;
}

/**
 * Decode a Responses-visible call id back to the exact Cursor wire id.
 * Non-encoded ids (including legacy raw multi-line ids replayed by older
 * clients) pass through unchanged; a malformed encoded payload also passes
 * through rather than corrupting pairing.
 */
export function decodeCursorCallId(id: string): string {
  const escaped = id.startsWith(CALL_ID_ESCAPE_PREFIX);
  if (!escaped && !id.startsWith(CALL_ID_PREFIX)) return id;
  const payload = id.slice((escaped ? CALL_ID_ESCAPE_PREFIX : CALL_ID_PREFIX).length);
  if (payload.length === 0) return id;
  try {
    const decoded = Buffer.from(payload, "base64url").toString("utf8");
    // Round-trip guard: only trust payloads our encoder could have produced.
    if (Buffer.from(decoded, "utf8").toString("base64url") !== payload) return id;
    // Each namespace admits exactly what its encoder puts there. An `ocxc1_` payload
    // that decodes to newline-free text is NOT our output — it is an opaque upstream
    // id that merely looks like ours, and unwrapping it would change the id.
    if (escaped ? !isReserved(decoded) : !needsEncoding(decoded)) return id;
    return decoded;
  } catch {
    return id;
  }
}
