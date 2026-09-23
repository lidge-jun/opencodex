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
    const domainForm = /^\*?\./.test(entry);

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
    if (!entryHost) continue;
    if (hostname === entryHost) return true;
    // A bare loopback name or an IP literal names one host: "localhost" must not send
    // "anything.localhost" direct, which need not resolve to loopback. ".localhost" still does.
    if (!domainForm && isExactOnlyNoProxyHost(entryHost)) continue;
    if (hostname.endsWith(`.${entryHost}`)) return true;
  }
  return false;
}

function isExactOnlyNoProxyHost(host: string): boolean {
  return host === "localhost" || host.includes(":") || /^\d{1,3}(?:\.\d{1,3}){3}$/.test(host);
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
    // A SOCKS URL in a scheme-matched variable is a usable proxy: admission
    // binds it explicitly and the transport follows, so it applies here too.
    if (isSocks5ProxyUrl(schemeValue)) return schemeValue;
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

/**
 * A request-scoped proxy decision as the outbound transports express it.
 *
 * `false` is Bun's documented "connect directly": it overrides HTTP_PROXY, HTTPS_PROXY and
 * ALL_PROXY, and it overrides NO_PROXY too. Bun treats `undefined`, `null` and `""` alike as
 * "no option given" and falls back to the environment, so none of those can express direct
 * egress. Declared locally because the value travels through `RequestInit`, which does not
 * carry it in the ambient DOM types.
 */
export type ProxyCapableRequestInit = RequestInit & { proxy?: string | false };

export function configuredOutboundFetch(
  input: RequestInfo | URL,
  init?: RequestInit,
  fallback?: typeof globalThis.fetch,
): Promise<Response> {
  const base = fallback ?? (globalThis.fetch === installedFetch ? nativeFetch : globalThis.fetch);
  const explicitProxy = (init as ProxyCapableRequestInit | undefined)?.proxy;
  // An explicit `false` is a decision, so it also has to win over the installed SOCKS wrapper.
  // Reading it as "no string was supplied" would fall through to ALL_PROXY and send a request
  // the caller pinned to direct egress through the global SOCKS proxy instead — the silent
  // substitution the caller asked this option to prevent. Bun applies the same `false` to its
  // own HTTP(S) proxy environment once the request reaches the base fetch below.
  const proxy = explicitProxy === false
    ? undefined
    : typeof explicitProxy === "string"
      ? (isSocks5ProxyUrl(explicitProxy) ? explicitProxy : undefined)
      : socks5ProxyFromEnv();
  let url: URL;
  try {
    url = new URL(input instanceof Request ? input.url : String(input));
  } catch {
    return base!(input, init);
  }
  // A mixed inherited SOCKS/HTTP ALL_PROXY environment cannot put bare "localhost" in
  // NO_PROXY: Bun would also bypass its HTTP proxy for app.localhost. Keep the name exact
  // here and force native fetch direct so the opposite-case HTTP proxy cannot take over.
  if (proxy && explicitProxy === undefined && (url.protocol === "http:" || url.protocol === "https:")
    && normalizeProxyHostname(url.hostname) === "localhost") {
    return base!(input, { ...init, proxy: false } as ProxyCapableRequestInit);
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
