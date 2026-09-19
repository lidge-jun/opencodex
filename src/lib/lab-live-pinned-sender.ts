import { PinnedHttpError, pinnedHttpGet, pinnedHttpPost, type PinnedHttpErrorCode } from "./pinned-http";
import { TransportError } from "../lab/live/transport";
import type { LabCredentialLeaseV1, LabPinnedSender, TransportErrorCode } from "../lab/live/types";

/** Only response metadata required by current live assertions crosses into Lab. */
const LAB_RESPONSE_HEADER_ALLOWLIST = ["content-type"] as const;

/**
 * Every pinned-transport failure code, mapped to the Lab transport taxonomy or to nothing.
 *
 * A switch over the codes that existed when it was written silently let later ones fall through
 * to a raw rethrow. That is not the same as leaving them unclassified: Lab's executor turns an
 * unrecognized error into `harness_failure` / `execution_error`, so a response the peer coded
 * in a format this transport cannot undo was reported as a fault of the runner. Both unreadable
 * answers therefore carry `unreadable_response`, which Lab classifies as a protocol failure.
 * A total map keeps a future code from acquiring that misattribution by default.
 */
const LAB_TRANSPORT_FAILURES = {
  connect_timeout: { code: "connect_timeout", message: "pinned provider connection timed out" },
  first_byte_timeout: { code: "first_byte_timeout", message: "pinned provider first byte timed out" },
  inactivity_timeout: { code: "inactivity_timeout", message: "pinned provider response stalled" },
  output_byte_limit: { code: "output_byte_limit", message: "pinned provider response exceeded byte budget" },
  content_decode_failed: { code: "unreadable_response", message: "pinned provider response did not decode" },
  unsupported_content_encoding: {
    code: "unreadable_response",
    message: "pinned provider used a content-encoding this transport cannot decode",
  },
} satisfies Record<PinnedHttpErrorCode, { code: TransportErrorCode; message: string }>;

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
        throw new TransportError(mapped.code, mapped.message);
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
