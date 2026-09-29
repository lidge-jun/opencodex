import { execFileSync } from "node:child_process";
import { isIP } from "node:net";

export type MacOSProxyReader = () => string | null;
export type MacOSSystemProxyResult =
  | { kind: "proxy"; httpUrl?: string; httpsUrl?: string; exceptions: string[]; droppedLinkLocal: boolean }
  | { kind: "disabled" | "unreadable" | "unsafe-exceptions" };

function readScutilProxy(): string {
  return execFileSync("/usr/sbin/scutil", ["--proxy"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    timeout: 2_000,
    maxBuffer: 64 * 1024,
  });
}

function proxyUrl(host: string | undefined, port: string | undefined): string | undefined {
  if (!host || !port || !/^\d+$/.test(port) || +port < 1 || +port > 65535) return undefined;
  const bareHost = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  if (!isIP(bareHost) && !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.?$/i.test(host)) return undefined;
  try {
    return new URL(`http://${isIP(bareHost) === 6 ? `[${bareHost}]` : host}:${port}`).origin;
  } catch {
    return undefined;
  }
}

// Bun matches a leading-dot entry at DNS-label boundaries and also bypasses the
// bare apex. Translating "*.local" to ".local" therefore widens only to "local";
// other glob shapes are refused. Bun cannot represent the default link-local
// CIDRs, so they are dropped with a diagnostic instead of blocking discovery.
// null means one of those exact ranges was dropped; undefined refuses discovery.
function translateException(value: string): string | null | undefined {
  if (value === "*") return value;
  if (value === "169.254/16" || value === "169.254.0.0/16") return null;
  const ipv6Range = /^(?:\[([0-9a-f:]+)\]|([0-9a-f:]+))\/10$/i.exec(value);
  const ipv6Base = ipv6Range?.[1] ?? ipv6Range?.[2];
  if (ipv6Base && isIP(ipv6Base) === 6
    && new URL(`http://[${ipv6Base}]`).hostname === "[fe80::]") return null;
  if (value.startsWith("*.")) {
    const domain = value.slice(2);
    if (domain.length > 253 || !domain.split(".").every(label => label.length <= 63
      && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(label))) return undefined;
    return `.${domain.toLowerCase()}`;
  }
  if (isIP(value) === 4) {
    const canonical = new URL(`http://${value}`).hostname;
    return value === canonical ? value : undefined;
  }
  const bare = value.startsWith("[") && value.endsWith("]") ? value.slice(1, -1) : value;
  return isIP(bare) === 6 ? new URL(`http://[${bare}]`).hostname : undefined;
}

/** Read only the global dictionary; scoped service dictionaries do not apply globally. */
export function readMacOSSystemProxy(reader: MacOSProxyReader = readScutilProxy): MacOSSystemProxyResult {
  try {
    const output = reader();
    if (!output || output.length > 64 * 1024 || !/^\s*<dictionary>\s*\{/.test(output)) return { kind: "unreadable" };
    const values = new Map<string, string>();
    const exceptions: string[] = [];
    let depth = 0;
    let inExceptions = false;
    for (const row of output.split(/\r?\n/)) {
      const line = row.trim();
      if (line.endsWith("{")) {
        if (inExceptions) return { kind: "unreadable" };
        if (depth === 1) {
          inExceptions = /^ExceptionsList\s*:\s*<array>\s*\{$/.test(line);
          if (line.startsWith("ExceptionsList") && !inExceptions) return { kind: "unreadable" };
        }
        depth++;
      } else if (line === "}") {
        if (--depth < 0) return { kind: "unreadable" };
        if (depth === 1) inExceptions = false;
      } else {
        const entry = /^([^:]+)\s*:\s*(.*?)\s*$/.exec(line);
        if (!entry) {
          if (inExceptions) return { kind: "unreadable" };
          continue;
        }
        if (depth === 1) {
          if (entry[1]!.trim() === "ExceptionsList") return { kind: "unreadable" };
          values.set(entry[1]!.trim(), entry[2]!);
        }
        if (depth === 2 && inExceptions) {
          if (!/^\d+$/.test(entry[1]!.trim())) return { kind: "unreadable" };
          exceptions.push(entry[2]!);
        }
      }
    }
    if (depth !== 0) return { kind: "unreadable" };
    if (values.get("ExcludeSimpleHostnames") === "1" || values.get("ProxyAutoConfigEnable") === "1"
      || values.get("ProxyAutoDiscoveryEnable") === "1") return { kind: "unsafe-exceptions" };
    for (const key of ["HTTPEnable", "HTTPSEnable", "ExcludeSimpleHostnames", "ProxyAutoConfigEnable", "ProxyAutoDiscoveryEnable"]) {
      const value = values.get(key);
      if (value !== undefined && value !== "0" && value !== "1") return { kind: "unreadable" };
    }
    const translated = exceptions.map(translateException);
    if (translated.some(value => value === undefined)) return { kind: "unsafe-exceptions" };
    const httpEnabled = values.get("HTTPEnable") === "1";
    const httpsEnabled = values.get("HTTPSEnable") === "1";
    const httpUrl = httpEnabled ? proxyUrl(values.get("HTTPProxy"), values.get("HTTPPort")) : undefined;
    const httpsUrl = httpsEnabled ? proxyUrl(values.get("HTTPSProxy"), values.get("HTTPSPort")) : undefined;
    if ((httpEnabled && !httpUrl) || (httpsEnabled && !httpsUrl)) return { kind: "unreadable" };
    return httpUrl || httpsUrl
      ? { kind: "proxy", httpUrl, httpsUrl,
          exceptions: translated.filter((value): value is string => typeof value === "string"),
          droppedLinkLocal: translated.includes(null) }
      : { kind: "disabled" };
  } catch {
    return { kind: "unreadable" };
  }
}
