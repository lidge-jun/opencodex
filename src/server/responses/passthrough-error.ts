import { formatErrorResponse } from "../../bridge";
import { isCyberPolicyCode, isCyberPolicyMessage } from "../../lib/errors";
import {
  resolveClientRetryAfter,
  validateClientRetryAfterHeader,
} from "../../lib/retry-after";

function isCyberPolicyBody(body: string): boolean {
  if (isCyberPolicyMessage(body)) return true;
  try {
    const parsed = JSON.parse(body) as Record<string, unknown>;
    const response = parsed.response && typeof parsed.response === "object" && !Array.isArray(parsed.response)
      ? parsed.response as Record<string, unknown>
      : undefined;
    for (const candidate of [parsed.error, response?.error, response?.last_error, parsed.last_error, parsed]) {
      if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) continue;
      const record = candidate as Record<string, unknown>;
      if (isCyberPolicyCode(typeof record.code === "string" ? record.code : undefined)) return true;
      if (typeof record.message === "string" && isCyberPolicyMessage(record.message)) return true;
    }
  } catch {
    /* non-JSON body — message detection above is the only safe fallback */
  }
  return false;
}

/**
 * Passthrough adapters historically relayed upstream non-2xx bodies verbatim.
 * Codex maps an *empty* body to the literal client string "Unknown error"
 * (UnexpectedResponseError) — issue #452. Only empty bodies need wrapping.
 *
 * Non-empty bodies (including ChatGPT `{detail: ...}` account-model 400s and
 * HTML/text errors) must keep their original bytes and headers so pool-retry
 * activation and client diagnostics stay honest.
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
  },
): Response {
  const trimmed = bodyText.trim();
  const now = options?.now ?? Date.now();
  const upstreamRetryAfter = options?.headers?.get("retry-after")?.trim() || undefined;
  const originalValid = validateClientRetryAfterHeader(upstreamRetryAfter, now);
  const cyberPolicyFailure = isCyberPolicyBody(trimmed);
  const resolved = cyberPolicyFailure
    ? undefined
    : resolveClientRetryAfter({
      status,
      message: trimmed || `Provider error ${status}: (empty body)`,
      upstreamRetryAfter,
      now,
    });

  if (trimmed) {
    const needsSet = resolved !== undefined && upstreamRetryAfter !== resolved;
    const needsDelete = (cyberPolicyFailure && upstreamRetryAfter !== undefined)
      || (resolved === undefined
        && upstreamRetryAfter !== undefined
        && originalValid === undefined);

    if (!needsSet && !needsDelete) {
      return new Response(bodyText, {
        status,
        ...(options?.statusText ? { statusText: options.statusText } : {}),
        ...(options?.headers ? { headers: options.headers } : { headers: { "Content-Type": "application/json" } }),
      });
    }

    const headers = options?.headers
      ? new Headers(options.headers)
      : new Headers({ "Content-Type": "application/json" });
    if (needsSet) headers.set("Retry-After", resolved!);
    else headers.delete("Retry-After");
    return new Response(bodyText, {
      status,
      ...(options?.statusText ? { statusText: options.statusText } : {}),
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
