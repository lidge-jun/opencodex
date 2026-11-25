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

// Captured before config/proxy-env applies runtime changes; Bun retains startup proxy env.
export const startupOutboundProxyConfigured = outboundProxyConfigured();

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

/** A request named an HTTP(S) proxy for a destination the process `NO_PROXY` exempts. */
export class ExplicitProxyExemptedError extends Error {
  override readonly name = "ExplicitProxyExemptedError";
  readonly code = "explicit_proxy_exempted";
}

/**
 * Bun's own `NO_PROXY` match, ported from `src/dotenv/no_proxy.rs` at the pinned `bun-v1.4.4`.
 *
 * Entries split on commas and whitespace. `*` matches everything. An entry containing `/` is a CIDR
 * block and matches only an IP-literal host inside it. Otherwise an optional `:port` must equal the
 * destination port numerically, a leading `*.` or `.` and one trailing `.` are dropped, an IP-literal
 * host matches only an equal address (compared canonically, so `::ffff:127.0.0.1` is `127.0.0.1`),
 * and a name matches itself and every subdomain, case-insensitively.
 */
function bunNoProxyMatches(list: string, url: URL): boolean {
  const hostname = stripOneTrailingDot(stripIpv6Brackets(url.hostname));
  if (!hostname) return false;
  const port = Number(url.port || (url.protocol === "https:" || url.protocol === "wss:" ? "443" : "80"));
  const hostIp = parseIpLiteral(hostname);
  for (const entry of list.split(/[,\s]+/)) {
    if (!entry) continue;
    if (entry === "*") return true;
    const slash = entry.indexOf("/");
    if (slash !== -1) {
      if (hostIp && cidrContains(entry, slash, hostIp)) return true;
      continue;
    }
    const [rawHost, entryPort] = splitEntryPort(entry);
    if (entryPort !== undefined && (!/^\d+$/.test(entryPort) || Number(entryPort) !== port)) continue;
    const entryHost = stripOneTrailingDot(rawHost.startsWith("*.") ? rawHost.slice(2) : rawHost.startsWith(".") ? rawHost.slice(1) : rawHost);
    if (!entryHost) continue;
    if (hostIp) {
      const entryIp = parseIpLiteral(entryHost);
      if (entryIp && sameIp(entryIp, hostIp)) return true;
      continue;
    }
    const host = hostname.toLowerCase();
    const name = entryHost.toLowerCase();
    if (host === name || (host.length > name.length && host.endsWith(`.${name}`))) return true;
  }
  return false;
}

interface IpLiteral { v6: boolean; bytes: number[] }

function stripOneTrailingDot(host: string): string { return host.endsWith(".") ? host.slice(0, -1) : host; }
function stripIpv6Brackets(host: string): string {
  return host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
}

/** `host[:port]` where host may be a bracketed or bare IPv6 literal (only one colon means a port). */
function splitEntryPort(entry: string): [string, string | undefined] {
  if (entry.startsWith("[")) {
    const close = entry.indexOf("]");
    if (close === -1) return [entry, undefined];
    const rest = entry.slice(close + 1);
    return [entry.slice(1, close), rest.startsWith(":") ? rest.slice(1) : undefined];
  }
  const colons = entry.split(":").length - 1;
  if (colons === 1) {
    const colon = entry.indexOf(":");
    return [entry.slice(0, colon), entry.slice(colon + 1)];
  }
  return [entry, undefined];
}

/** A dotted quad or an IPv6 literal as bytes, with `::ffff:a.b.c.d` folded to IPv4. */
function parseIpLiteral(text: string): IpLiteral | null {
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(text)) {
    const bytes = text.split(".").map(Number);
    return bytes.every(byte => byte <= 255) ? { v6: false, bytes } : null;
  }
  if (!text.includes(":")) return null;
  let canonical: string;
  try { canonical = new URL(`http://[${text}]/`).hostname.slice(1, -1); } catch { return null; }
  const halves = canonical.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const groups = halves.length === 2 ? [...head, ...Array(8 - head.length - tail.length).fill("0"), ...tail] : head;
  if (groups.length !== 8 || !groups.every(group => /^[0-9a-f]{1,4}$/.test(group))) return null;
  const bytes = groups.flatMap(group => { const value = parseInt(group, 16); return [value >> 8, value & 0xff]; });
  const mapped = bytes.slice(0, 10).every(byte => byte === 0) && bytes[10] === 0xff && bytes[11] === 0xff;
  return mapped ? { v6: false, bytes: bytes.slice(12) } : { v6: true, bytes };
}

function sameIp(a: IpLiteral, b: IpLiteral): boolean {
  return a.v6 === b.v6 && a.bytes.every((byte, index) => byte === b.bytes[index]);
}

function cidrContains(entry: string, slash: number, host: IpLiteral): boolean {
  const writtenText = stripIpv6Brackets(entry.slice(0, slash));
  const network = parseIpLiteral(writtenText);
  const prefix = entry.slice(slash + 1);
  if (!network || !/^\d+$/.test(prefix)) return false;
  let bits = Number(prefix);
  // `::ffff:10.0.0.0/104` is `10.0.0.0/8`.
  if (writtenText.includes(":") && !network.v6) {
    if (bits < 96) return false;
    bits -= 96;
  }
  if (network.v6 !== host.v6 || bits > network.bytes.length * 8) return false;
  const whole = Math.floor(bits / 8);
  const rem = bits % 8;
  for (let index = 0; index < whole; index += 1) if (network.bytes[index] !== host.bytes[index]) return false;
  return rem === 0 || ((network.bytes[whole]! ^ host.bytes[whole]!) >> (8 - rem)) === 0;
}

/**
 * Whether the process `NO_PROXY` or `no_proxy` exempts `url`, as broadly as Bun reads it.
 *
 * Bun's fetch and WebSocket connect directly to such a destination even when the request names a
 * proxy, as a string or as `{ url }`; only `proxy: false` outranks the environment. This guard
 * therefore has to match at least everything Bun matches (`bunNoProxyMatches`: whitespace separators,
 * subdomains, CIDR blocks, numeric ports, canonical addresses), and either spelling is enough. It also
 * accepts anything
 * `noProxyMatches` accepts, so it never answers narrower than the routing decisions elsewhere.
 * Over-matching only refuses a request; under-matching would send it around the proxy.
 */
export function processNoProxyExempts(url: URL, env: ProxyEnvMap = process.env): boolean {
  // Bun reads `no_proxy`, else `NO_PROXY`; checking each on its own covers whichever it picks.
  return [env.NO_PROXY, env.no_proxy].some(value => typeof value === "string" && value.trim() !== ""
    && (bunNoProxyMatches(value, url) || noProxyMatches(url, { NO_PROXY: value })));
}

/** The refusal for an explicit HTTP(S) proxy that the process environment would make Bun skip. */
export function explicitProxyExemptedError(url: URL): ExplicitProxyExemptedError {
  return new ExplicitProxyExemptedError(
    `the configured proxy for ${url.origin} cannot be applied because NO_PROXY in the process environment `
    + "exempts this destination; remove it from NO_PROXY to keep the proxy, or list it in the provider's noProxy to connect directly",
  );
}

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
  // An HTTP(S) proxy string reaches Bun's fetch as `init.proxy`, and Bun ignores it for a
  // destination the process NO_PROXY exempts. The caller named this proxy, so the request must not
  // leave without it: refuse instead. SOCKS5 strings never reach Bun's proxy option (below).
  if (typeof explicitProxy === "string" && !isSocks5ProxyUrl(explicitProxy)
    && (url.protocol === "http:" || url.protocol === "https:")) {
    if (processNoProxyExempts(url)) return Promise.reject(explicitProxyExemptedError(url));
    // Bun would follow a redirect itself and apply NO_PROXY to the new destination, so with any
    // bypass list in the environment the redirects are followed here, checking every hop.
    const redirectMode = init?.redirect ?? (input instanceof Request ? input.redirect : "follow");
    if (redirectMode === "follow" && processNoProxyConfigured()) {
      return followExplicitProxyRedirects(base!, input, init, explicitProxy, url);
    }
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

function processNoProxyConfigured(env: ProxyEnvMap = process.env): boolean {
  return [env.NO_PROXY, env.no_proxy].some(value => typeof value === "string" && value.trim() !== "");
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const MAX_EXPLICIT_PROXY_REDIRECTS = 20;
/** Request fields the rebuilt `Request` carries; everything else in `init` (Bun's own options) is passed on. */
const REQUEST_FIELDS = ["method", "headers", "body", "signal", "redirect", "duplex", "referrer", "referrerPolicy", "mode", "credentials", "cache", "integrity", "window"];

/**
 * Follow redirects of an explicit HTTP(S)-proxy request here, rechecking every destination before it
 * is contacted. Each hop is sent through the same proxy with `redirect: "manual"`. The Fetch rules
 * apply: 303, and 301/302 after a POST, become a bodiless GET; 307 and 308 replay the method and
 * body; a cross-origin hop drops `Authorization`; more than 20 redirects fail.
 */
async function followExplicitProxyRedirects(
  base: typeof globalThis.fetch, input: RequestInfo | URL, init: RequestInit | undefined, proxyUrl: string, firstUrl: URL,
): Promise<Response> {
  const passthrough: Record<string, unknown> = { ...(init as Record<string, unknown> | undefined) };
  for (const field of REQUEST_FIELDS) delete passthrough[field];
  let request = new Request(input, { ...init, redirect: "manual" });
  let target = firstUrl;
  for (let hops = 0; ; hops += 1) {
    const response = await base(request.clone(), { ...passthrough, proxy: proxyUrl, redirect: "manual" } as ProxyCapableRequestInit);
    const location = REDIRECT_STATUSES.has(response.status) ? response.headers.get("location") : null;
    if (location === null) return response;
    let next: URL;
    try {
      next = new URL(location, target);
    } catch {
      return response;
    }
    await response.body?.cancel().catch(() => {});
    if (hops >= MAX_EXPLICIT_PROXY_REDIRECTS) throw new TypeError(`too many redirects from ${firstUrl.origin}`);
    if (next.protocol !== "http:" && next.protocol !== "https:") throw new TypeError(`redirect to an unsupported scheme from ${target.origin}`);
    if (processNoProxyExempts(next)) throw explicitProxyExemptedError(next);
    const toGet = response.status === 303 ? request.method !== "HEAD"
      : (response.status === 301 || response.status === 302) && request.method === "POST";
    const headers = new Headers(request.headers);
    if (toGet) for (const name of ["content-type", "content-length", "content-encoding", "content-language", "content-location"]) headers.delete(name);
    if (next.origin !== target.origin) headers.delete("authorization");
    request = new Request(next, {
      method: toGet ? "GET" : request.method, headers, body: toGet ? null : request.body,
      redirect: "manual", signal: request.signal, duplex: "half",
    } as RequestInit);
    target = next;
  }
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
