import { configuredOutboundFetch, effectiveProxyFor, noProxyMatches, type ProxyEnvMap, type ProxyCapableRequestInit } from "./proxy-env";

/** Bind both native desktop transports to one explicit route; never fall back after failure. */
export function desktopProxyFor(url: URL, env: ProxyEnvMap = process.env): string | false {
  if (noProxyMatches(url, env)) return false;
  const selected = effectiveProxyFor(url, env);
  if (selected) {
    const proxy = new URL(selected);
    if (!["http:", "https:", "socks5:", "socks5h:"].includes(proxy.protocol) || !proxy.hostname
      || proxy.search || proxy.hash || proxy.pathname !== "" && proxy.pathname !== "/") throw new Error("desktop_egress_proxy_invalid");
    return selected;
  }
  const key = url.protocol === "https:" ? "HTTPS_PROXY" : "HTTP_PROXY";
  // An explicit but unsupported route must not quietly become direct desktop traffic.
  if ([env[key], env[key.toLowerCase()], env.ALL_PROXY, env.all_proxy].some(value => value?.trim())) throw new Error("desktop_egress_proxy_invalid");
  return false;
}
export function desktopOutboundFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = new URL(input instanceof Request ? input.url : String(input));
  return configuredOutboundFetch(input, { ...init, proxy: desktopProxyFor(url) } as ProxyCapableRequestInit);
}
