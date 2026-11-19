import { formatErrorResponse } from "../../bridge";
import { isCyberPolicyCode, isCyberPolicyMessage } from "../../lib/errors";
import {
  applyReplayRefusalClientHeaders,
  replayRefusalBodyCode,
  projectReplayRefusal,
  hasNoRetryDirective,
  retainReplayRefusal,
  UPSTREAM_RESET_REPLAY_REFUSED_CODE,
} from "../../lib/upstream-retry";
import {
  formatClientRetryAfter,
  resolveClientRetryAfter,
} from "../../lib/retry-after";
import { isMetaMusePlanFailure, META_MUSE_PLAN_REFUSAL_MESSAGE } from "../../providers/meta-muse-plan-refusal";

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
 * - a replay refusal this proxy wrote gets none and keeps none: the whole point of the
 *   refusal is that the turn may already be running, and the synthetic default for a
 *   retryable 429 is a direct instruction to the client to send it a second time
 *
 * A refusal also leaves with the shared no-retry header and the in-process marker, so the
 * verdict survives this re-wrap as a property of the response rather than as a status a later
 * reader would have to guess from.
 */
export function formatPassthroughUpstreamError(
  status: number,
  bodyText: string,
  options?: {
    statusText?: string;
    headers?: Headers;
    now?: number;
    /** Caller holds an authoritative fatal verdict; neither inherited nor inferred waits apply. */
    suppressRetryAfter?: boolean;
    /**
     * Provenance from the caller that still holds the response synthesized by this proxy.
     */
    replayRefusal?: boolean;
  },
): Response {
  const trimmed = bodyText.trim();
  const refusalCode = replayRefusalBodyCode(trimmed);
  if (refusalCode || options?.replayRefusal) {
    const refusal = projectReplayRefusal(refusalCode ?? UPSTREAM_RESET_REPLAY_REFUSED_CODE);
    return options?.replayRefusal ? retainReplayRefusal(refusal) : refusal;
  }
  const now = options?.now ?? Date.now();
  // Meta's Muse Code subscription refusal is relayed as this proxy's own explanation (#8352):
  // the upstream body names the restriction but not the supported path, and a verbatim relay
  // reads as a rejected credential. The shared classifier keeps the subscription class.
  if (isMetaMusePlanFailure(status, trimmed)) {
    const refusal = formatErrorResponse(status, "permission_error", META_MUSE_PLAN_REFUSAL_MESSAGE);
    if (!options?.headers) {
      return options?.statusText
        ? new Response(refusal.body, { status: refusal.status, statusText: options.statusText, headers: refusal.headers })
        : refusal;
    }
    // The body is this proxy's own, but the relayed headers the caller already sanitized (the
    // upstream request id among them) stay; a plan restriction names no wait.
    const headers = new Headers(options.headers);
    for (const name of ["content-length", "content-encoding", "retry-after"]) headers.delete(name);
    refusal.headers.forEach((value, name) => headers.set(name, value));
    return new Response(refusal.body, {
      status: refusal.status,
      ...(options.statusText ? { statusText: options.statusText } : {}),
      headers,
    });
  }
  const upstreamRetryAfter = options?.headers?.get("retry-after")?.trim() || undefined;
  const cyberPolicyFailure = isCyberPolicyBody(trimmed);
  const noRetry = options?.headers !== undefined && hasNoRetryDirective({ headers: options.headers });
  // Two different reasons to answer with no wait at all, handled the same way: a hard policy
  // block will not become servable, and a refusal we made was never a rate limit.
  const suppressRetryAfter = options?.suppressRetryAfter === true || cyberPolicyFailure || noRetry;
  const resolved = suppressRetryAfter
    ? undefined
    : resolveClientRetryAfter({
      status,
      message: trimmed || `Provider error ${status}: (empty body)`,
      upstreamRetryAfter,
      now,
    });

  // The header leaves in this proxy's own format: an integer of seconds, never the upstream bytes.
  const formatted = resolved === undefined ? undefined : formatClientRetryAfter(resolved, now);

  if (trimmed) {
    const needsSet = formatted !== undefined && upstreamRetryAfter !== formatted;
    const needsDelete = formatted === undefined && upstreamRetryAfter !== undefined;

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
    if (needsSet) headers.set("Retry-After", formatted!);
    else headers.delete("Retry-After");
    if (noRetry) applyReplayRefusalClientHeaders(headers);
    const rewritten = new Response(bodyText, {
      status,
      ...(options?.statusText ? { statusText: options.statusText } : {}),
      headers,
    });
    return rewritten;
  }

  const response = formatErrorResponse(
    status,
    "upstream_error",
    `Provider error ${status}: (empty body)`,
    resolved !== undefined ? { retryAfter: resolved } : undefined,
  );
  const headers = new Headers(response.headers);
  headers.set("Content-Type", "application/json");
  if (formatted !== undefined) headers.set("Retry-After", formatted);
  else headers.delete("Retry-After");
  if (noRetry) applyReplayRefusalClientHeaders(headers);
  return new Response(response.body, { status: response.status, headers });
}
