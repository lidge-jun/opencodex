import { PinnedHttpError, pinnedHttpGet, pinnedHttpPost } from "./pinned-http";
import { TransportError } from "../lab/live/transport";
import type { LabCredentialLeaseV1, LabPinnedSender } from "../lab/live/types";

/** Only response metadata required by current live assertions crosses into Lab. */
const LAB_RESPONSE_HEADER_ALLOWLIST = ["content-type"] as const;

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
        switch (error.code) {
          case "connect_timeout":
            throw new TransportError("connect_timeout", "pinned provider connection timed out");
          case "first_byte_timeout":
            throw new TransportError("first_byte_timeout", "pinned provider first byte timed out");
          case "inactivity_timeout":
            throw new TransportError("inactivity_timeout", "pinned provider response stalled");
          case "output_byte_limit":
            throw new TransportError("output_byte_limit", "pinned provider response exceeded byte budget");
        }
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
