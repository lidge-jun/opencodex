import { formatErrorResponse } from "../../bridge";
import {
  resolveClientRetryAfter,
  validateClientRetryAfterHeader,
} from "../../lib/retry-after";
import { redactExactSecretOccurrences } from "../../lib/redact";

const BODY_REPRESENTATION_HEADERS = [
  "accept-ranges",
  "content-encoding",
  "content-length",
  "content-range",
  "content-md5",
  "digest",
  "content-digest",
  "repr-digest",
  "etag",
  "last-modified",
] as const;

export function stripPassthroughBodyRepresentationHeaders(headers: Headers): Headers {
  const clientHeaders = new Headers(headers);
  for (const header of BODY_REPRESENTATION_HEADERS) clientHeaders.delete(header);
  return clientHeaders;
}

export function redactPassthroughResponseBody(
  bodyText: string,
  headers: Headers | undefined,
  redactExactValues: readonly string[] = [],
): { bodyText: string; headers: Headers | undefined } {
  const clientBodyText = redactExactSecretOccurrences(bodyText, redactExactValues);
  const bodyChanged = clientBodyText !== bodyText;
  let clientHeaders = headers;

  if (headers && (bodyChanged || redactExactValues.length > 0)) {
    clientHeaders = new Headers(headers);
    if (redactExactValues.length > 0) {
      clientHeaders.delete("chatgpt-account-id");
      for (const [key, value] of [...clientHeaders.entries()]) {
        if (redactExactSecretOccurrences(value, redactExactValues) !== value) {
          clientHeaders.delete(key);
        }
      }
    }
    if (bodyChanged) {
      clientHeaders = stripPassthroughBodyRepresentationHeaders(clientHeaders);
    }
  }

  return {
    bodyText: clientBodyText,
    headers: clientHeaders,
  };
}

/**
 * Passthrough adapters historically relayed upstream non-2xx bodies verbatim.
 * Codex maps an *empty* body to the literal client string "Unknown error"
 * (UnexpectedResponseError) — issue #452. Only empty bodies need wrapping.
 *
 * Non-empty bodies (including ChatGPT `{detail: ...}` account-model 400s and
 * HTML/text errors) keep their original bytes and headers unless they contain an
 * exact credential value injected into the upstream request. Pool-retry activation
 * happens before this formatter, so redacting the client-facing copy cannot change
 * the routing decision.
 *
 * Retry-After is validated independently of the body path:
 * - valid upstream values are preserved
 * - missing/malformed values are replaced when resolveClientRetryAfter yields a value
 * - malformed/expired values are removed when the resolver returns undefined
 *   (e.g. quota-exhausted 429s must not keep junk headers or get the synthetic "2")
 */
export function formatPassthroughUpstreamError(
  status: number,
  bodyText: string,
  options?: {
    statusText?: string;
    headers?: Headers;
    now?: number;
    redactExactValues?: readonly string[];
  },
): Response {
  const trimmed = bodyText.trim();
  const now = options?.now ?? Date.now();
  const upstreamRetryAfter = options?.headers?.get("retry-after")?.trim() || undefined;
  const originalValid = validateClientRetryAfterHeader(upstreamRetryAfter, now);
  const resolved = resolveClientRetryAfter({
    status,
    message: trimmed || `Provider error ${status}: (empty body)`,
    upstreamRetryAfter,
    now,
  });
  const client = redactPassthroughResponseBody(
    bodyText,
    options?.headers,
    options?.redactExactValues,
  );
  const statusText = redactExactSecretOccurrences(
    options?.statusText ?? "",
    options?.redactExactValues,
  );

  if (trimmed) {
    const needsSet = resolved !== undefined && upstreamRetryAfter !== resolved;
    const needsDelete = resolved === undefined
      && upstreamRetryAfter !== undefined
      && originalValid === undefined;

    if (!needsSet && !needsDelete) {
      return new Response(client.bodyText, {
        status,
        ...(statusText ? { statusText } : {}),
        ...(client.headers ? { headers: client.headers } : { headers: { "Content-Type": "application/json" } }),
      });
    }

    const headers = client.headers
      ? new Headers(client.headers)
      : new Headers({ "Content-Type": "application/json" });
    if (needsSet) headers.set("Retry-After", resolved!);
    else headers.delete("Retry-After");
    return new Response(client.bodyText, {
      status,
      ...(statusText ? { statusText } : {}),
      headers,
    });
  }

  const response = formatErrorResponse(
    status,
    "upstream_error",
    `Provider error ${status}: (empty body)`,
    resolved !== undefined ? { retryAfter: resolved } : undefined,
  );
  const headers = new Headers(response.headers);
  headers.set("Content-Type", "application/json");
  if (resolved !== undefined) headers.set("Retry-After", resolved);
  return new Response(response.body, { status: response.status, headers });
}
