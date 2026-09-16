import { formatErrorResponse } from "../../bridge";
import { isCyberPolicyCode, isCyberPolicyMessage } from "../../lib/errors";
import { isReplayRefusalCode, UPSTREAM_RESET_REPLAY_REFUSED_CODE } from "../../lib/upstream-retry";
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
 * True for a body this proxy wrote to refuse replaying an ambiguous pre-header reset.
 *
 * It is read off the body rather than a marker because this formatter is handed bytes, not
 * the response they came from, and the refusal reaches it after the original body was read.
 * The code is this proxy's own, so an upstream echoing it is not a case worth widening for.
 */
function isReplayRefusalBody(body: string): boolean {
  if (!body.includes(UPSTREAM_RESET_REPLAY_REFUSED_CODE)) return false;
  try {
    const parsed = JSON.parse(body) as Record<string, unknown>;
    const error = parsed.error && typeof parsed.error === "object" && !Array.isArray(parsed.error)
      ? parsed.error as Record<string, unknown>
      : undefined;
    return isReplayRefusalCode(error?.code) || isReplayRefusalCode(parsed.code);
  } catch {
    return false;
  }
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
 * - a replay refusal this proxy wrote gets none and keeps none: the whole point of the
 *   refusal is that the turn may already be running, and the synthetic default for a
 *   retryable 429 is a direct instruction to the client to send it a second time
 */
export function formatPassthroughUpstreamError(
  status: number,
  bodyText: string,
  options?: {
    statusText?: string;
    headers?: Headers;
    now?: number;
    /**
     * Provenance from the caller that still holds the response: this body is a refusal this
     * proxy synthesized. The body check below is the fallback for a re-wrapped body, and it
     * cannot answer at all when the bounded read returned nothing display-safe -- which is
     * precisely when the empty-body branch would invent the retryable-429 default.
     */
    replayRefusal?: boolean;
  },
): Response {
  const trimmed = bodyText.trim();
  const now = options?.now ?? Date.now();
  const upstreamRetryAfter = options?.headers?.get("retry-after")?.trim() || undefined;
  const originalValid = validateClientRetryAfterHeader(upstreamRetryAfter, now);
  const cyberPolicyFailure = isCyberPolicyBody(trimmed);
  // Two different reasons to answer with no wait at all, handled the same way: a hard policy
  // block will not become servable, and a refusal we made was never a rate limit.
  const suppressRetryAfter = cyberPolicyFailure
    || options?.replayRefusal === true
    || isReplayRefusalBody(trimmed);
  const resolved = suppressRetryAfter
    ? undefined
    : resolveClientRetryAfter({
      status,
      message: trimmed || `Provider error ${status}: (empty body)`,
      upstreamRetryAfter,
      now,
    });

  if (trimmed) {
    const needsSet = resolved !== undefined && upstreamRetryAfter !== resolved;
    const needsDelete = (suppressRetryAfter && upstreamRetryAfter !== undefined)
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
