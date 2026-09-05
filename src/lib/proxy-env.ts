export const OUTBOUND_PROXY_ENV_KEYS = ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY"] as const;
export const PROXY_ENV_KEYS = [...OUTBOUND_PROXY_ENV_KEYS, "NO_PROXY"] as const;

export type ProxyEnvKey = typeof PROXY_ENV_KEYS[number];
export type ProxyEnvMap = Record<string, string | undefined>;

export function proxyEnvPresent(
  key: ProxyEnvKey,
  env: ProxyEnvMap = process.env,
): boolean {
  return Boolean(env[key]?.trim() || env[key.toLowerCase()]?.trim());
}

export function outboundProxyConfigured(
  env: ProxyEnvMap = process.env,
): boolean {
  return OUTBOUND_PROXY_ENV_KEYS.some(key => proxyEnvPresent(key, env));
}

/**
 * The proxy URL that Bun's fetch will actually use for `url`, or null when none applies.
 *
 * Bun selects by scheme: `HTTPS_PROXY` for `https:` targets, `HTTP_PROXY` for `http:`.
 * `ALL_PROXY` is deliberately not consulted here — fetch does not honour it, so a caller
 * that needs "this request will ride the proxy" as a precondition must not count it.
 * Presence of *some* proxy variable (`outboundProxyConfigured`) is not that guarantee.
 */
export function effectiveProxyFor(
  url: URL,
  env: ProxyEnvMap = process.env,
): string | null {
  const key: ProxyEnvKey | null = url.protocol === "https:"
    ? "HTTPS_PROXY"
    : url.protocol === "http:"
      ? "HTTP_PROXY"
      : null;
  if (!key) return null;
  const value = env[key]?.trim() || env[key.toLowerCase()]?.trim();
  return value ? value : null;
}
