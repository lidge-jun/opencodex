import { execFileSync } from "node:child_process";
import { isIP } from "node:net";

export type MacOSProxyReader = () => string | null;
export type UnrepresentableCounts = { cidr: number; hostname: number; wildcard: number; other: number };
export type MacOSSystemProxyResult =
  | { kind: "proxy"; httpUrl?: string; httpsUrl?: string; exceptions: string[]; droppedLinkLocal: boolean }
  | { kind: "unsafe-exceptions"; unrepresentable?: UnrepresentableCounts; setting?: string }
  | { kind: "socks-only" }
  | { kind: "disabled" | "unreadable" };

/** Reads the global proxy dictionary from /usr/sbin/scutil with tight time and size limits. */
function readScutilProxy(): string {
  return execFileSync("/usr/sbin/scutil", ["--proxy"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    timeout: 2_000,
    maxBuffer: 64 * 1024,
  });
}

/** Normalizes an enabled host/port pair into an origin URL, or undefined when unusable. */
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

/**
 * Bun matches a leading-dot entry at DNS-label boundaries and also bypasses the
 * bare apex. Translating "*.local" to ".local" therefore widens only to "local";
 * other glob shapes are refused. Bun cannot represent the default link-local
 * CIDRs, so they are dropped with a diagnostic instead of blocking discovery.
 * Returns the translated entry, null when one of those exact ranges was dropped,
 * or undefined when the shape cannot be represented and refuses discovery.
 * Non-canonical IPv4 literals (e.g. leading-zero octets) return undefined; the
 * refusal counter then reports them in the "other" shape bucket (see
 * unrepresentableCategory) so shape counts stay interpretable.
 */
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

/**
 * Classifies an unrepresentable entry for refusal diagnostics. Refusals must not echo
 * the offending entries (a system bypass list can name internal hosts), so discovery
 * reports only how many entries fall into each shape: CIDR ranges, syntactically
 * valid bare hostnames Bun would widen to subdomains (validated per DNS label, so
 * malformed structures like "foo..bar" do not count), malformed wildcard shapes,
 * and anything else. Non-canonical IPv4 literals (digit-dotted strings that fail
 * canonicalization) are IP-shaped rather than hostnames and count as "other".
 */
function unrepresentableCategory(value: string): "cidr" | "hostname" | "wildcard" | "other" {
  if (value.includes("/")) return "cidr";
  if (value.includes("*")) return "wildcard";
  if (isIP(value) || (value.startsWith("[") && value.endsWith("]"))) return "other";
  if (/^\d+(\.\d+)+$/.test(value)) return "other";
  const validLabels = value.split(".").every(label => label.length > 0 && label.length <= 63
    && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(label));
  return validLabels ? "hostname" : "other";
}

/** Counts unrepresentable entries by shape for the refusal diagnostic. */
function countUnrepresentable(values: string[]): UnrepresentableCounts {
  const counts: UnrepresentableCounts = { cidr: 0, hostname: 0, wildcard: 0, other: 0 };
  for (const value of values) counts[unrepresentableCategory(value)]++;
  return counts;
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
    for (const key of ["HTTPEnable", "HTTPSEnable", "ExcludeSimpleHostnames", "ProxyAutoConfigEnable", "ProxyAutoDiscoveryEnable"]) {
      const value = values.get(key);
      if (value !== undefined && value !== "0" && value !== "1") return { kind: "unreadable" };
    }
    const httpEnabled = values.get("HTTPEnable") === "1";
    const httpsEnabled = values.get("HTTPSEnable") === "1";
    const httpUrl = httpEnabled ? proxyUrl(values.get("HTTPProxy"), values.get("HTTPPort")) : undefined;
    const httpsUrl = httpsEnabled ? proxyUrl(values.get("HTTPSProxy"), values.get("HTTPSPort")) : undefined;
    if ((httpEnabled && !httpUrl) || (httpsEnabled && !httpsUrl)) return { kind: "unreadable" };
    // Transport precedence: with no HTTP(S) proxy configured, no bypass list or toggle
    // can change the outcome — SOCKS-only is the primary blocker and is reported ahead
    // of exception shapes, which would otherwise mask it (review round 1, P2).
    if (!(httpUrl || httpsUrl)) {
      // PAC and WPAD can route traffic without a static HTTP(S) proxy. Saying "disabled",
      // or "SOCKS-only, using direct egress", would misdescribe that setup, so the
      // automatic-configuration toggle is reported first.
      const autoSetting = values.get("ProxyAutoConfigEnable") === "1" ? "ProxyAutoConfigEnable"
        : values.get("ProxyAutoDiscoveryEnable") === "1" ? "ProxyAutoDiscoveryEnable"
        : undefined;
      if (autoSetting) return { kind: "unsafe-exceptions", setting: autoSetting };
      return values.get("SOCKSEnable") === "1" ? { kind: "socks-only" } : { kind: "disabled" };
    }
    // With a usable HTTP(S) transport, toggles and untranslatable entries refuse
    // discovery together: the user should fix both in one pass, not one per retry.
    const flaggedSetting = values.get("ExcludeSimpleHostnames") === "1" ? "ExcludeSimpleHostnames"
      : values.get("ProxyAutoConfigEnable") === "1" ? "ProxyAutoConfigEnable"
      : values.get("ProxyAutoDiscoveryEnable") === "1" ? "ProxyAutoDiscoveryEnable"
      : undefined;
    const translated = exceptions.map(translateException);
    const unrepresentable = translated.some(value => value === undefined)
      ? countUnrepresentable(exceptions.filter((_, index) => translated[index] === undefined))
      : undefined;
    if (flaggedSetting || unrepresentable) {
      return { kind: "unsafe-exceptions", setting: flaggedSetting, unrepresentable };
    }
    return { kind: "proxy", httpUrl, httpsUrl,
      exceptions: translated.filter((value): value is string => typeof value === "string"),
      droppedLinkLocal: translated.includes(null) };
  } catch {
    return { kind: "unreadable" };
  }
}
