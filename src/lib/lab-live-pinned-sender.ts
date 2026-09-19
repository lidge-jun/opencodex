import { PinnedHttpError, pinnedHttpGet, pinnedHttpPost, type PinnedHttpErrorCode } from "./pinned-http";
import { TransportError } from "../lab/live/transport";
import type { LabCredentialLeaseV1, LabPinnedSender, TransportErrorCode } from "../lab/live/types";

/** Only response metadata required by current live assertions crosses into Lab. */
const LAB_RESPONSE_HEADER_ALLOWLIST = ["content-type"] as const;

/**
 * Every pinned-transport failure code, mapped to the Lab transport taxonomy or to nothing.
 *
 * A switch over the codes that existed when it was written silently let later ones fall through
 * to a raw rethrow, so Lab classified them as nothing at all without anyone deciding that. This
 * map makes a new code a compile error, and `undefined` is a deliberate answer rather than an
 * oversight: the Lab taxonomy has no code for "the peer's response cannot be read", and
 * borrowing a timeout or a transient code would tell Lab to wait or retry for a failure that is
 * neither. A corrupt coded body is different — a retry can legitimately decode — so it takes the
 * provider-fault code Lab already has.
 */
const LAB_TRANSPORT_FAILURES = {
  connect_timeout: { code: "connect_timeout", message: "pinned provider connection timed out" },
  first_byte_timeout: { code: "first_byte_timeout", message: "pinned provider first byte timed out" },
  inactivity_timeout: { code: "inactivity_timeout", message: "pinned provider response stalled" },
  output_byte_limit: { code: "output_byte_limit", message: "pinned provider response exceeded byte budget" },
  content_decode_failed: { code: "provider_transient", message: "pinned provider response did not decode" },
  unsupported_content_encoding: undefined,
} satisfies Record<PinnedHttpErrorCode, { code: TransportErrorCode; message: string } | undefined>;

/**
 * Trusted credential/transport owner. Secret headers exist only in this non-Lab module and are
 * consumed directly by the pinned HTTP primitive; they are never returned to Lab code.
 */
export function createLabAuthorizedPinnedSender(
  authorize: (lease: LabCredentialLeaseV1) => Promise<HeadersInit> | HeadersInit,
): LabPinnedSender {
  return async (lease, destination, pinned, request, signal, limits) => {
    const headers = await authorize(lease);
    const url = `${destination.scheme}://${destination.host}:${destination.port}${destination.basePath}${request.path}`;
    const options = {
      headers,
      maxBytes: limits.maxOutputBytes,
      connectTimeoutMs: limits.connectTimeoutMs,
      firstByteTimeoutMs: limits.firstByteTimeoutMs,
      inactivityTimeoutMs: limits.inactivityTimeoutMs,
      rejectUnauthorized: true,
      context: "Lab provider response",
    };
    let response: Response;
    let body: string;
    try {
      response = request.method === "POST"
        ? await pinnedHttpPost(url, pinned, request.body ?? "", signal, options)
        : await pinnedHttpGet(url, pinned, signal, options);
      body = await response.text();
    } catch (error) {
      if (error instanceof PinnedHttpError) {
        const mapped = LAB_TRANSPORT_FAILURES[error.code];
        if (mapped) throw new TransportError(mapped.code, mapped.message);
      }
      throw error;
    }
    const responseHeaders: Record<string, string> = {};
    for (const headerName of LAB_RESPONSE_HEADER_ALLOWLIST) {
      const value = response.headers.get(headerName);
      if (value !== null) responseHeaders[headerName] = value;
    }
    return { status: response.status, headers: responseHeaders, body };
  };
}
