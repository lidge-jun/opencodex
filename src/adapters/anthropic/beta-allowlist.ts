/**
 * The `anthropic-beta` values a managed native Messages request may carry from its caller (PF-10).
 *
 * A beta header changes what the provider accepts and bills, so the native lane never forwards
 * the caller's header as written. Each value is compared, case-insensitively, against a fixed
 * list for the destination's provider class; a match is re-emitted in this file's own spelling,
 * so no caller byte ever reaches the wire, and everything else is dropped. The caller learns
 * nothing about which value was dropped, and the trace records only that something was
 * (`anthropic-beta-dropped`), never the value.
 *
 * Proxy-owned betas (the OAuth pair, the fast-mode beta) are not listed here: the lane sets them
 * itself from the provider's own configuration, exactly as the adapter does.
 *
 * LEAF MODULE: no runtime import, so the builder, the lane and tests can read it freely.
 */

/** Where the native lane sends: Anthropic's own API, or an Anthropic-compatible third party. */
export type AnthropicProviderClass = "first-party" | "compatible";

/**
 * Betas a caller may forward to `api.anthropic.com`. Deliberately short: only a value whose
 * effect is limited to how the model uses the body it already sent, with no new body field,
 * no billing tier and no retained server state, belongs here.
 */
const FIRST_PARTY_BETAS: readonly string[] = [
  // Lets thinking blocks appear between tool calls in one assistant turn. No request field;
  // the thinking and tool blocks it affects are already on the lane's field allowlist, and the
  // proxy's own OAuth quota probe sends it (`src/providers/quota/vendor-probes-oauth.ts`).
  "interleaved-thinking-2025-05-14",
];

/**
 * Betas a caller may forward to an Anthropic-compatible third party. Empty: a third party's
 * beta semantics are its own, an unknown value can fail the request outright, and none is
 * needed for the fields the lane forwards.
 */
const COMPATIBLE_BETAS: readonly string[] = [];
const INLINE_TOOLS_BETA = "inline-tools-2026-09-15";

/** An observed Claude client already requested these native body schemas. Advisor may
 * perform its explicitly requested model sub-inference; no feature or body is injected. */
const NATIVE_CLIENT_BETAS: readonly string[] = [
  ...FIRST_PARTY_BETAS,
  "advisor-tool-2026-03-01",
  "per-turn-control-2026-07-01",
  "redact-thinking-2026-02-12",
  "inline-tools-2026-09-15",
  "thinking-display-updates-2026-08-18",
  "prompt-caching-scope-2026-01-05",
  "mid-conversation-system-2026-04-07",
];
const NATIVE_CLIENT_ALLOWLIST = new Map(NATIVE_CLIENT_BETAS.map(beta => [beta.toLowerCase(), beta]));

const ALLOWLISTS: Readonly<Record<AnthropicProviderClass, ReadonlyMap<string, string>>> = {
  "first-party": new Map(FIRST_PARTY_BETAS.map(beta => [beta.toLowerCase(), beta])),
  compatible: new Map(COMPATIBLE_BETAS.map(beta => [beta.toLowerCase(), beta])),
};

/** A caller header longer than this is not parsed at all and counts as dropped. */
const MAX_CALLER_BETA_HEADER_CHARS = 2048;

export interface AllowlistedAnthropicBetas {
  /** Allowlisted values in this file's spelling, first-seen order, no duplicates. */
  betas: string[];
  /** Whether any non-empty caller value was left out. Never says which. */
  dropped: boolean;
}

/**
 * Filter the caller's comma-separated `anthropic-beta` header for one provider class. An absent
 * or blank header yields nothing and drops nothing.
 */
export function allowlistAnthropicBetas(
  callerHeader: string | null | undefined,
  providerClass: AnthropicProviderClass,
  features: { inlineTools?: boolean; observedNativeClient?: boolean } = {},
): AllowlistedAnthropicBetas {
  if (typeof callerHeader !== "string" || callerHeader.trim() === "") return { betas: [], dropped: false };
  if (callerHeader.length > MAX_CALLER_BETA_HEADER_CHARS) return { betas: [], dropped: true };
  const allowed = providerClass === "first-party" && features.observedNativeClient ? NATIVE_CLIENT_ALLOWLIST : ALLOWLISTS[providerClass];
  const betas: string[] = [];
  let dropped = false;
  for (const part of callerHeader.split(",")) {
    const token = part.trim().toLowerCase();
    if (!token) continue;
    const canonical = allowed.get(token) ?? (providerClass === "first-party" && features.inlineTools
      && token === INLINE_TOOLS_BETA ? INLINE_TOOLS_BETA : undefined);
    if (canonical === undefined) dropped = true;
    else if (!betas.includes(canonical)) betas.push(canonical);
  }
  return { betas, dropped };
}

/** The allowlist for one class, for documentation and tests. */
export function anthropicBetaAllowlist(providerClass: AnthropicProviderClass): readonly string[] {
  return [...ALLOWLISTS[providerClass].values()];
}
