/**
 * OpenCode Zen short-window rate-limit guidance (#1145 / OCX-56).
 *
 * OpenCode's keyed and keyless Zen chat endpoints share `https://opencode.ai/zen/v1`.
 * Free-model traffic can hit a short-window burst ceiling around 15–20 RPM
 * (community-measured). Zen often answers with opaque `429 Rate limit exceeded`
 * bodies and may omit `Retry-After` / `X-RateLimit-*`; when those headers are
 * present they still take precedence. Distinct from the keyless desktop
 * ~200 requests / 5h quota documented on `opencode-free`.
 *
 * The same module also owns the keyless free-tier admission explanation (#4121):
 * Zen rejects a request that carries no `x-opencode-session` header with
 * `MissingSessionID` / "OpenCode's free tier can only be used in OpenCode".
 * opencodex does not synthesize that header — see {@link enrichOpenCodeZenFreeTierMessage}.
 */
import { validateClientRetryAfterHeader } from "../lib/retry-after";
import { registryEntryForProviderDestination } from "./registry";

const OPENCODE_ZEN_PROVIDER_IDS = new Set(["opencode-zen", "opencode-free"]);

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
 * keyless `opencode-free` traffic and not custom `runTurn` transports.
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
  if (!/rate\s*limit/i.test(message)) return message;
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
 * Zen's keyless free tier admits only OpenCode's own client. A request without an
 * `x-opencode-session` header is refused with error type `MissingSessionID` and the
 * message "OpenCode's free tier can only be used in OpenCode" (#4121).
 *
 * Presence of the header is the whole gate — any value clears it — so opencodex could
 * pass by minting one. It does not. Fabricating a session identifier and a versioned
 * `opencode/<version>` User-Agent is a claim to *be* the OpenCode client, and no upstream
 * contract authorizes a third-party agent to make it; an HTTP 200 obtained that way is a
 * bypassed admission check, not permission. Until OpenCode publishes a third-party
 * integration path for this exact keyless tier, the supported route is the keyed
 * `opencode-zen` provider.
 *
 * Two markers are matched because the two request surfaces expose different parts of the
 * upstream envelope: the Responses path forwards the bounded raw body (which carries the
 * `MissingSessionID` type), while the native Chat path forwards only the parsed message.
 */
const OPENCODE_ZEN_FREE_TIER_LOCK_IN = /MissingSessionID|free tier can only be used in OpenCode/i;

/** Idempotence marker — the appended guidance must not stack across enrichment layers. */
const FREE_TIER_ENRICHMENT_MARKER = "does not send a fabricated OpenCode session header";

/** True when an upstream error body is Zen's keyless free-tier admission refusal. */
export function isOpenCodeZenFreeTierLockIn(message: string, upstreamErrorType?: string | null): boolean {
  if (upstreamErrorType && OPENCODE_ZEN_FREE_TIER_LOCK_IN.test(upstreamErrorType)) return true;
  return OPENCODE_ZEN_FREE_TIER_LOCK_IN.test(message);
}

/**
 * Replace a raw `MissingSessionID` passthrough with an explanation of the upstream
 * restriction and the supported alternative. No-op for every other provider and every
 * other error, and idempotent so layered enrichment cannot append it twice.
 */
export function enrichOpenCodeZenFreeTierMessage(
  message: string,
  opts: {
    providerName?: string;
    baseUrl?: string;
    adapter?: string;
    /** Upstream `error.type`, when the caller parsed one out of the envelope. */
    upstreamErrorType?: string | null;
  },
): string {
  if (message.includes(FREE_TIER_ENRICHMENT_MARKER)) return message;
  if (!isOpenCodeZenFreeTierLockIn(message, opts.upstreamErrorType)) return message;
  if (!isOpenCodeZenRateLimitProvider(opts)) return message;
  return (
    `${message}`
    + " OpenCode Zen's keyless free tier admits only OpenCode's own client: it refuses any"
    + " request that arrives without an x-opencode-session header."
    + ` opencodex ${FREE_TIER_ENRICHMENT_MARKER}, because presenting itself as the OpenCode`
    + " client is a claim no upstream contract supports."
    + " Use the keyed opencode-zen provider with an OpenCode Zen API key"
    + " (https://opencode.ai/auth), or route this model through another provider."
    + " Upstream terms: https://opencode.ai/docs/zen/."
  );
}

/**
 * Single entry point for Zen upstream-error guidance on the Responses wire: short-window
 * rate limits first, then the keyless free-tier admission refusal. Each layer is a no-op
 * outside its own case, so the composition is safe for every other upstream failure.
 */
export function enrichOpenCodeZenUpstreamMessage(
  message: string,
  opts: Parameters<typeof enrichOpenCodeZenRateLimitMessage>[1] & { upstreamErrorType?: string | null },
): string {
  return enrichOpenCodeZenFreeTierMessage(enrichOpenCodeZenRateLimitMessage(message, opts), opts);
}
