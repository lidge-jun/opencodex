/**
 * OpenCode Zen short-window rate-limit guidance (#1145 / OCX-56).
 *
 * OpenCode's keyed Zen chat endpoint uses `https://opencode.ai/zen/v1`.
 * Free-model traffic can hit a short-window burst ceiling around 15–20 RPM
 * (community-measured). Zen often answers with opaque `429 Rate limit exceeded`
 * bodies and may omit `Retry-After` / `X-RateLimit-*`; when those headers are
 * present they still take precedence.
 */
import { validateClientRetryAfterHeader } from "../lib/retry-after";
import { registryEntryForProviderDestination } from "./registry";

const OPENCODE_ZEN_PROVIDER_IDS = new Set(["opencode-zen"]);

/** Observed free-model burst ceiling on Zen (not an official OpenCode figure). */
export const OPENCODE_ZEN_OBSERVED_RPM_HINT = "roughly 15-20 requests per minute";

/**
 * Synthetic client backoff when Zen omits Retry-After after a rate-limit 429.
 * Longer than the generic 2s default so Codex-shaped clients do not immediately
 * re-hammer a ~15-20 RPM window.
 */
export const OPENCODE_ZEN_SYNTHETIC_RETRY_AFTER_SEC = 15;

const ENRICHMENT_MARKER = "15-20 requests per minute";

export function isOpenCodeZenRateLimitProvider(opts: {
  providerName?: string;
  baseUrl?: string;
  adapter?: string;
}): boolean {
  const name = opts.providerName?.trim();
  if (name && OPENCODE_ZEN_PROVIDER_IDS.has(name)) return true;
  const baseUrl = opts.baseUrl?.trim();
  if (!baseUrl) return false;
  const entry = registryEntryForProviderDestination({
    baseUrl,
    adapter: opts.adapter?.trim() || "openai-chat",
    authMode: "key",
  });
  return entry !== undefined && OPENCODE_ZEN_PROVIDER_IDS.has(entry.id);
}

/**
 * Same-key `retryOn429` only applies on key-authenticated HTTP paths — not
 * keyless traffic and not custom `runTurn` transports.
 */
export function supportsOpenCodeZenRetryOn429Guidance(opts: {
  authMode?: string;
  hasApiKey?: boolean;
  supportsHttpSameKeyRetry?: boolean;
}): boolean {
  if (opts.supportsHttpSameKeyRetry === false) return false;
  if (opts.authMode !== undefined && opts.authMode !== "key") return false;
  return opts.hasApiKey === true;
}

/**
 * Append actionable Zen rate-limit context to a generic upstream 429 message and
 * embed a parseable `try again in Ns` hint so {@link resolveClientRetryAfter}
 * surfaces a useful Retry-After when the gateway sent none.
 */
export function enrichOpenCodeZenRateLimitMessage(
  message: string,
  opts: {
    status: number;
    /** Parsed upstream error type, when available. */
    upstreamErrorType?: string | null;
    upstreamErrorCode?: string | null;
    providerName?: string;
    baseUrl?: string;
    adapter?: string;
    authMode?: string;
    hasApiKey?: boolean;
    /** Upstream Retry-After header; when valid, skip the synthetic 15s text hint. */
    upstreamRetryAfter?: string | null;
    /** False for custom `runTurn` transports outside the HTTP retry loop. */
    supportsHttpSameKeyRetry?: boolean;
    now?: number;
  },
): string {
  if (opts.status !== 429) return message;
  if (!isOpenCodeZenRateLimitProvider(opts)) return message;
  const errorText = `${opts.upstreamErrorType ?? ""} ${opts.upstreamErrorCode ?? ""} ${message}`.replace(/[_-]/g, " ");
  if (/\b(?:quota|billing)\b|\busage\s+limit\b|\binsufficient\s+(?:credits?|balance|funds)\b|\b(?:credits?|balance)\s+(?:exhausted|depleted)\b/i.test(errorText)) return message;
  if (opts.upstreamErrorType !== "rate_limit_error" && !/rate\s*limit/i.test(message)) return message;
  if (message.includes(ENRICHMENT_MARKER)) return message;

  const upstreamRetry = validateClientRetryAfterHeader(
    opts.upstreamRetryAfter,
    opts.now ?? Date.now(),
  );
  const retryHint = upstreamRetry || /try again in \d/i.test(message)
    ? ""
    : ` Try again in ${OPENCODE_ZEN_SYNTHETIC_RETRY_AFTER_SEC}s.`;
  const paceHint = supportsOpenCodeZenRetryOn429Guidance(opts)
    ? " Slow the request pace, or set providers.opencode-zen.retryOn429 for same-key backoff."
    : " Slow the request pace.";
  return (
    `${message}`
    + ` OpenCode Zen free-model traffic is often limited to ${OPENCODE_ZEN_OBSERVED_RPM_HINT}`
    + ` (observed; OpenCode does not publish this RPM, and may omit rate-limit headers).`
    + `${retryHint}`
    + paceHint
  );
}

/**
 * Zen upstream-error guidance on Responses and native Messages.
 */
export function enrichOpenCodeZenUpstreamMessage(
  message: string,
  opts: Parameters<typeof enrichOpenCodeZenRateLimitMessage>[1] & { upstreamErrorType?: string | null },
): string {
  return enrichOpenCodeZenRateLimitMessage(message, opts);
}

/** The effective HTTP endpoint, never the configured row name, identifies Console. */
export function isConsoleGoDestination(outboundUrl: string | undefined): boolean {
  if (!outboundUrl) return false;
  try {
    const url = new URL(outboundUrl);
    return url.protocol === "https:" && url.hostname === "opencode.ai"
      && url.port === "" && url.username === "" && url.password === ""
      && url.search === "" && url.hash === ""
      && /^\/zen\/(?:go\/)?v1\/(?:responses|chat\/completions|messages)$/.test(url.pathname);
  } catch {
    return false;
  }
}

/**
 * The canonical refusal envelope, as served on both Console routes:
 *   {"error":{"param":null,"type":"invalid_request_error","message":"Error from provider
 *   (Console Go): Upstream request failed: [invalid_request_error] Invalid upload request."}}
 *
 * The gateway names itself Console on the Zen key route and Console Go on the Go route, so the
 * anchor is the shared product name plus the refusal sentence. The message is matched whole: a
 * bare string, a suffix, or any other envelope is a different refusal and must not be replayed.
 * Being stricter than necessary is the safe direction: a missed match leaves the turn failing
 * exactly as it does today, while a loose match spends an extra request on unrelated 400s.
 */
const CONSOLE_UPLOAD_REFUSALS = new Set([
  "Error from provider (Console Go): Upstream request failed: [invalid_request_error] Invalid upload request.",
  "Error from provider (Console): Upstream request failed: [invalid_request_error] Invalid upload request.",
]);

/**
 * True only for the canonical Console upload refusal on a canonical Console destination.
 * Route-gated on purpose: the message alone would let any other upstream that happens to answer
 * with this English sentence trigger a second send from an unrelated provider.
 */
export function isTransientConsoleGoUploadRejection(opts: {
  status: number;
  errorBody: string | undefined;
  outboundUrl?: string;
}): boolean {
  if (opts.status !== 400 || !opts.errorBody) return false;
  if (!isConsoleGoDestination(opts.outboundUrl)) return false;
  let payload: unknown;
  try {
    payload = JSON.parse(opts.errorBody);
  } catch {
    return false;
  }
  const error = (payload as { error?: unknown } | null)?.error;
  if (!error || typeof error !== "object" || Array.isArray(error)) return false;
  // The whole envelope, not just the sentence: Console always answers this refusal as
  // invalid_request_error with a null param, so a partial envelope is a different error.
  const envelope = error as { param?: unknown; type?: unknown; message?: unknown };
  if (envelope.type !== "invalid_request_error" || envelope.param !== null) return false;
  // Matched without trimming: padding means the gateway wrapped or appended something.
  return typeof envelope.message === "string" && CONSOLE_UPLOAD_REFUSALS.has(envelope.message);
}
