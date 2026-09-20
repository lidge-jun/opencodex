import { socks5Fetch } from "./socks5-fetch";

export const OUTBOUND_PROXY_ENV_KEYS = ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY"] as const;
export const PROXY_ENV_KEYS = [...OUTBOUND_PROXY_ENV_KEYS, "NO_PROXY"] as const;

export type ProxyEnvKey = typeof PROXY_ENV_KEYS[number];
export type ProxyEnvMap = Record<string, string | undefined>;
export type ProxyRoute =
  | { kind: "direct" }
  | { kind: "proxy"; proxy: string }
  | { kind: "fallback" };

export function normalizeProxyHostname(hostname: string): string {
  const normalized = hostname.trim().toLowerCase().replace(/\.+$/, "");
  return normalized.startsWith("[") && normalized.endsWith("]")
    ? normalized.slice(1, -1)
    : normalized;
}

export function noProxyMatches(
  url: URL,
  env: ProxyEnvMap = process.env,
): boolean {
  const raw = env.NO_PROXY ?? env.no_proxy ?? "";
  const hostname = normalizeProxyHostname(url.hostname);
  const port = url.port || (url.protocol === "https:" || url.protocol === "wss:" ? "443" : "80");
  for (const rawEntry of raw.split(",")) {
    let entry = rawEntry.trim().toLowerCase();
    if (!entry) continue;
    if (entry === "*") return true;
    entry = entry.replace(/^(?:https?|wss?):\/\//, "").split("/", 1)[0]!;

    let entryHost = entry;
    let entryPort = "";
    const bracketed = /^\[([^\]]+)](?::(\d+))?$/.exec(entry);
    if (bracketed) {
      entryHost = bracketed[1]!;
      entryPort = bracketed[2] ?? "";
    } else if ((entry.match(/:/g)?.length ?? 0) === 1) {
      const separator = entry.lastIndexOf(":");
      const possiblePort = entry.slice(separator + 1);
      if (/^\d+$/.test(possiblePort)) {
        entryHost = entry.slice(0, separator);
        entryPort = possiblePort;
      }
    }
    if (entryPort && entryPort !== port) continue;
    entryHost = normalizeProxyHostname(entryHost.replace(/^\*?\./, ""));
    if (entryHost && (hostname === entryHost || hostname.endsWith(`.${entryHost}`))) return true;
  }
  return false;
}

export function resolveProxyRoute(
  url: URL,
  env: ProxyEnvMap = process.env,
): ProxyRoute {
  if (noProxyMatches(url, env)) return { kind: "direct" };
  const key = url.protocol === "https:" || url.protocol === "wss:"
    ? "HTTPS_PROXY"
    : "HTTP_PROXY";
  const proxy = [key, key.toLowerCase(), "ALL_PROXY", "all_proxy"]
    .map(candidate => env[candidate]?.trim())
    .find(Boolean);
  if (!proxy) return { kind: "direct" };
  try {
    const protocol = new URL(proxy).protocol;
    return protocol === "http:" || protocol === "https:"
      ? { kind: "proxy", proxy }
      : { kind: "fallback" };
  } catch {
    return { kind: "fallback" };
  }
}

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
 * The value when `raw` is a proxy URL Bun fetch can actually use, else null.
 * Bun rejects unparseable values and non-http(s) schemes (UnsupportedProxyProtocol),
 * so admitting them as "the proxy that applies" would only downgrade DNS pinning.
 */
function usableHttpProxyUrl(raw: string | undefined): string | null {
  if (!raw) return null;
  try {
    const scheme = new URL(raw).protocol;
    return scheme === "http:" || scheme === "https:" ? raw : null;
  } catch {
    return null;
  }
}

/**
 * The proxy URL selected by configured outbound fetch for `url`, or null when none applies.
 *
 * Bun selects by scheme: `HTTPS_PROXY` for `https:` targets, `HTTP_PROXY` for `http:`.
 * A SOCKS5 `ALL_PROXY` is selected by the explicit wrapper first. A non-SOCKS
 * `ALL_PROXY` is still honoured by the native fetch for plain `http:` targets on
 * every platform the CI matrix covers — the provider-outbound e2e drives exactly that
 * request through the proxy on Linux, macOS and Windows. For `https:` targets the
 * SOCKS wrapper remains the only `ALL_PROXY` route this module counts.
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
  // The installed SOCKS wrapper takes this route before Bun sees scheme proxies.
  const socksProxy = socks5ProxyFromEnv(env);
  if (socksProxy) return socksProxy;
  const schemeValue = env[key]?.trim() || env[key.toLowerCase()]?.trim();
  if (schemeValue) {
    // A present but unusable scheme-matched variable fails closed: it is not a
    // proxy Bun fetch can use, and it must not fall through to ALL_PROXY either.
    // If Bun would have used ALL_PROXY here, keeping the DNS-pinned transport is
    // the safe direction; if it would not, this is exactly right.
    return usableHttpProxyUrl(schemeValue);
  }
  if (url.protocol !== "http:") return null;
  return usableHttpProxyUrl(env.ALL_PROXY?.trim() || env.all_proxy?.trim());
}

/**
 * The proxy a request can be explicitly bound to for fake-IP admission, or
 * null: a scheme-matched variable or a SOCKS5 `ALL_PROXY`. This is the
 * stricter documented gate for Mihomo IPv6 fake-IP answers — a non-SOCKS
 * `ALL_PROXY` does not count here even when `effectiveProxyFor` reports it,
 * because admission pins the transport to the returned value and the gate's
 * contract is stated in those terms. The scheme-matched value counts only as
 * a usable binding — a SOCKS or http(s) URL; anything else would admit a
 * fake-IP answer nothing can resolve.
 */
export function schemeMatchedProxyFor(
  url: URL,
  env: ProxyEnvMap = process.env,
): string | null {
  const key: ProxyEnvKey | null = url.protocol === "https:"
    ? "HTTPS_PROXY"
    : url.protocol === "http:"
      ? "HTTP_PROXY"
      : null;
  if (!key) return null;
  const socksProxy = socks5ProxyFromEnv(env);
  if (socksProxy) return socksProxy;
  const value = env[key]?.trim() || env[key.toLowerCase()]?.trim();
  if (!value) return null;
  if (isSocks5ProxyUrl(value)) return value;
  return usableHttpProxyUrl(value);
}

export function isSocks5ProxyUrl(proxy: string): boolean {
  return /^socks5h?:\/\//i.test(proxy.trim());
}

export function socks5ProxyFromEnv(env: ProxyEnvMap = process.env): string | undefined {
  const candidates = [env.ALL_PROXY, env.all_proxy];
  return candidates.find(value => typeof value === "string" && isSocks5ProxyUrl(value));
}

export function configuredOutboundFetch(
  input: RequestInfo | URL,
  init?: RequestInit,
  fallback?: typeof globalThis.fetch,
): Promise<Response> {
  const base = fallback ?? (globalThis.fetch === installedFetch ? nativeFetch : globalThis.fetch);
  const explicitProxy = (init as (RequestInit & { proxy?: string }) | undefined)?.proxy;
  const proxy = typeof explicitProxy === "string"
    ? (isSocks5ProxyUrl(explicitProxy) ? explicitProxy : undefined)
    : socks5ProxyFromEnv();
  let url: URL;
  try {
    url = new URL(input instanceof Request ? input.url : String(input));
  } catch {
    return base!(input, init);
  }
  if (proxy && (url.protocol === "http:" || url.protocol === "https:") && (explicitProxy !== undefined || !noProxyMatches(url))) {
    return socks5Fetch(input, init, proxy);
  }
  return base!(input, init);
}

type FetchWithPreconnect = typeof globalThis.fetch & {
  preconnect?: typeof globalThis.fetch.preconnect;
};

let nativeFetch: FetchWithPreconnect | undefined;
let installedFetch: FetchWithPreconnect | undefined;

export function configureSocks5Fetch(): void {
  if (globalThis.fetch !== installedFetch) {
    nativeFetch = globalThis.fetch as FetchWithPreconnect;
    installedFetch = undefined;
  }
  const proxy = socks5ProxyFromEnv();
  if (!proxy) {
    if (installedFetch && globalThis.fetch === installedFetch && nativeFetch) globalThis.fetch = nativeFetch;
    installedFetch = undefined;
    return;
  }
  if (installedFetch && globalThis.fetch === installedFetch) return;
  const base = nativeFetch ?? globalThis.fetch as FetchWithPreconnect;
  nativeFetch = base;
  const wrapped = Object.assign(
    (input: RequestInfo | URL, init?: RequestInit) => {
      return configuredOutboundFetch(input, init, base);
    },
    { preconnect: base.preconnect?.bind(base) },
  ) as FetchWithPreconnect;
  installedFetch = wrapped;
  globalThis.fetch = wrapped;
}
