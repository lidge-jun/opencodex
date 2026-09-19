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
 * 101 and 103 are also null-body statuses, but neither reaches a final-response decision here:
 * an upgrade is refused before this point and informational heads are consumed while looking for
 * the final one. The three below are the ones these transports can actually have to answer for.
 *
 * https://fetch.spec.whatwg.org/#null-body-status
 */
export function isNullBodyStatus(status: number): boolean {
  return status === 204 || status === 205 || status === 304;
}
