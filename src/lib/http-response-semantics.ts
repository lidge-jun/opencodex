/**
 * Response rules both raw outbound transports have to apply themselves.
 *
 * `fetch` applies them below the Response constructor. `src/lib/pinned-http.ts` and
 * `src/lib/socks5-fetch.ts` assemble a Response from a socket instead, so each one answers the
 * same questions on its own — and a rule written twice is a rule that drifts. It already had:
 * the SOCKS helper excluded 204 and the pinned helper excluded nothing, so the same no-content
 * upstream answer behaved differently depending on which transport carried the request.
 */

/**
 * Statuses the Fetch specification defines as null-body.
 *
 * `new Response(body, { status })` throws a TypeError for a non-null body on any of these, so a
 * transport that attaches its stream unconditionally converts a valid no-content answer into a
 * construction failure. There are no body bytes to wait for either, so a transport that streams
 * one of these holds the caller until the peer closes a connection it is entitled to keep alive.
 *
 * 101 and 103 are null-body statuses too, but neither is a final Response status these helpers
 * support. 103 and every other informational head is consumed while looking for the final one,
 * and 101 hands the connection to a protocol neither helper speaks, which is outside what they
 * construct a Response for at all. The three below are the statuses these transports actually
 * have to answer for.
 *
 * https://fetch.spec.whatwg.org/#null-body-status
 */
export function isNullBodyStatus(status: number): boolean {
  return status === 204 || status === 205 || status === 304;
}

/** What a transport must do with the coding a response declares. */
export type ContentCoding =
  | { kind: "identity" }
  | { kind: "decodable"; format: "gzip" | "deflate" }
  | { kind: "unsupported"; coding: string };

/**
 * Classify the `content-encoding` a raw transport received.
 *
 * `fetch` undoes a content-coding below the Response constructor. A transport that assembles a
 * body from a socket hands the coded bytes to whatever reads them instead: `response.json()`
 * throws a SyntaxError on the gzip magic number and an SSE reader sees noise rather than frames.
 * Only `gzip` and `deflate` can be undone with `DecompressionStream`, so anything else is
 * reported as unsupported and each transport refuses it under its own error type rather than
 * surfacing bytes no caller can parse.
 *
 * This reads the coding the response actually carries and nothing else. A caller whose
 * `accept-encoding` names a coding this code cannot undo is not the problem; what the peer
 * chose to send is.
 */
export function classifyContentCoding(headers: Headers): ContentCoding {
  const coding = (headers.get("content-encoding") ?? "").trim().toLowerCase();
  if (coding === "" || coding === "identity") return { kind: "identity" };
  if (coding === "gzip" || coding === "x-gzip") return { kind: "decodable", format: "gzip" };
  if (coding === "deflate") return { kind: "decodable", format: "deflate" };
  return { kind: "unsupported", coding };
}
