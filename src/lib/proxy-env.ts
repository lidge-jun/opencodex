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

function proxyValue(key: ProxyEnvKey, env: ProxyEnvMap): string | undefined {
  const value = env[key]?.trim() || env[key.toLowerCase()]?.trim();
  return value || undefined;
}

export function noProxyMatches(url: URL, env: ProxyEnvMap = process.env): boolean {
  const raw = env.NO_PROXY?.trim() || env.no_proxy?.trim() || "";
  const hostname = url.hostname.trim().toLowerCase().replace(/^\[|\]$/g, "").replace(/\.+$/, "");
  const port = url.port || (url.protocol === "https:" ? "443" : "80");
  for (const value of raw.split(",")) {
    let entry = value.trim().toLowerCase();
    if (!entry) continue;
    if (entry === "*") return true;
    entry = entry.replace(/^https?:\/\//, "").split("/", 1)[0]!;
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
    entryHost = entryHost.replace(/^\*?\./, "").replace(/^\[|\]$/g, "").replace(/\.+$/, "");
    if (entryHost && (hostname === entryHost || hostname.endsWith(`.${entryHost}`))) return true;
  }
  return false;
}

/** Select the standard proxy for a URL without exposing its credentials. */
export function proxyForUrl(url: string | URL, env: ProxyEnvMap = process.env): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }
  if (noProxyMatches(parsed, env)) return undefined;
  if (parsed.protocol === "https:") return proxyValue("HTTPS_PROXY", env) ?? proxyValue("ALL_PROXY", env);
  if (parsed.protocol === "http:") return proxyValue("HTTP_PROXY", env) ?? proxyValue("ALL_PROXY", env);
  return undefined;
}
