import { createHash } from "node:crypto";
import type { OcxProviderConfig } from "../types";

/**
 * xAI account OAuth and xAI API keys share a bearer shape but not a billing
 * transport. OAuth represents the Grok CLI subscription entitlement, while a
 * key represents the API team. Keep the saved provider preset compatible with
 * the dashboard's "Use an API key instead" switch and resolve the transport at
 * request time.
 */
export const XAI_GROK_CLI_BASE_URL = "https://cli-chat-proxy.grok.com/v1";

/** Minimum-compatible official Grok CLI wire version verified with the proxy. */
export const XAI_GROK_CLIENT_VERSION = "0.2.93";

const XAI_GROK_CLI_HEADERS: Readonly<Record<string, string>> = {
  "x-grok-client-identifier": "opencodex",
  "x-grok-client-version": XAI_GROK_CLIENT_VERSION,
  "x-xai-token-auth": "xai-grok-cli",
};

/**
 * Sticky-routing hint for xAI's automatic prefix cache. xAI routes requests
 * carrying the same `x-grok-conv-id` to the same server, which is where the
 * prompt cache lives (docs.x.ai prompt-caching best-practices; verified
 * 2026-07-13, devlog/_plan/260713_grok_caching). Codex clients send a stable
 * per-conversation `prompt_cache_key`; hash it so the raw session id never
 * leaves the proxy.
 */
export const XAI_CONV_ID_HEADER = "x-grok-conv-id";

function hasHeaderCaseInsensitive(headers: Record<string, string> | undefined, name: string): boolean {
  if (!headers) return false;
  const target = name.toLowerCase();
  return Object.keys(headers).some(key => key.toLowerCase() === target);
}

export function deriveXaiConvId(promptCacheKey: string): string {
  return createHash("sha256").update(promptCacheKey).digest("hex").slice(0, 32);
}

/**
 * Resolve the effective xAI transport without mutating persisted config.
 * User-provided headers are preserved and may advance the compatibility
 * version without waiting for an opencodex release.
 *
 * `promptCacheKey` (the client's stable conversation key) additionally pins
 * cache-affinity routing via `x-grok-conv-id` in BOTH auth modes. Blank or
 * whitespace-only keys are ignored so unrelated requests can never collapse
 * onto one shared conv id, and any user-configured header (any case) wins.
 */
export function resolveProviderTransport(
  providerName: string,
  provider: OcxProviderConfig,
  promptCacheKey?: string,
): OcxProviderConfig {
  if (providerName !== "xai") return provider;
  const cacheKey = promptCacheKey?.trim();
  const convIdHeaders: Record<string, string> =
    cacheKey && !hasHeaderCaseInsensitive(provider.headers, XAI_CONV_ID_HEADER)
      ? { [XAI_CONV_ID_HEADER]: deriveXaiConvId(cacheKey) }
      : {};
  if (provider.authMode !== "oauth") {
    if (Object.keys(convIdHeaders).length === 0) return provider;
    return {
      ...provider,
      headers: { ...convIdHeaders, ...(provider.headers ?? {}) },
    };
  }
  return {
    ...provider,
    baseUrl: XAI_GROK_CLI_BASE_URL,
    headers: {
      ...XAI_GROK_CLI_HEADERS,
      ...convIdHeaders,
      ...(provider.headers ?? {}),
    },
  };
}
