import { isIP } from "node:net";
import { z } from "zod";

/**
 * `dashboardTrustedProxy` (#8338): the one reverse proxy a standalone dashboard may sit behind
 * and still remember devices. Pure parsing shared by the load schema, the live-write check and
 * the request path, so every reader applies the same rules. Nothing here trusts a header.
 */
export const DASHBOARD_TRUSTED_PROXY_HEADERS = ["x-forwarded-host", "x-forwarded-proto"] as const;
export type DashboardTrustedProxyHeader = typeof DASHBOARD_TRUSTED_PROXY_HEADERS[number];
export const MAX_DASHBOARD_PROXY_ADDRESSES = 16;

export interface DashboardTrustedProxySettings {
  /** Canonical `https://host[:port]` origin the browser uses. */
  origin: string;
  /** The origin's host as `URL.host` spells it (lowercase, default port removed). */
  host: string;
  /** Normalized peer addresses of the proxy hop. */
  addresses: ReadonlySet<string>;
  trust: ReadonlySet<DashboardTrustedProxyHeader>;
}

/** One IP literal in the form `requestIP()` reports, or null. IPv4-mapped IPv6 reads as IPv4. */
export function normalizeProxyAddress(value: string): string | null {
  const raw = value.trim();
  const version = isIP(raw);
  if (version === 4) return raw;
  if (version !== 6) return null;
  let host: string;
  try { host = new URL(`http://[${raw}]/`).hostname.slice(1, -1); } catch { return null; }
  const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(host);
  if (mapped) {
    const high = Number.parseInt(mapped[1]!, 16);
    const low = Number.parseInt(mapped[2]!, 16);
    return [high >> 8, high & 255, low >> 8, low & 255].join(".");
  }
  return host;
}

/** A parsed setting, or the reason it is unusable. Unknown fields are refused. */
export function parseDashboardTrustedProxy(value: unknown): DashboardTrustedProxySettings | string {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "must be an object";
  const record = value as Record<string, unknown>;
  const unknown = Object.keys(record).find(key => key !== "origin" && key !== "proxyAddresses" && key !== "trustHeaders");
  if (unknown !== undefined) return `contains an unsupported field: ${unknown}`;
  const { origin, proxyAddresses, trustHeaders } = record;
  if (typeof origin !== "string" || origin.includes("*")) return "origin must be one exact https origin (no wildcards)";
  let parsed: URL;
  try { parsed = new URL(origin); } catch { return "origin must be one exact https origin (no wildcards)"; }
  // The URL parser decodes %2A, so the raw-string check alone would let an encoded wildcard through.
  if (parsed.hostname.includes("*")) return "origin must be one exact https origin (no wildcards)";
  if (parsed.protocol !== "https:") return "origin must use https";
  if (parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash || !parsed.hostname) {
    return "origin must be an origin without credentials, path, query, or fragment";
  }
  if (!Array.isArray(proxyAddresses) || proxyAddresses.length === 0 || proxyAddresses.length > MAX_DASHBOARD_PROXY_ADDRESSES) {
    return `proxyAddresses must list 1 to ${MAX_DASHBOARD_PROXY_ADDRESSES} proxy IP addresses`;
  }
  const addresses = new Set<string>();
  for (const entry of proxyAddresses) {
    const address = typeof entry === "string" ? normalizeProxyAddress(entry) : null;
    if (!address) return "proxyAddresses must be exact IP addresses (no ranges, wildcards, or host names)";
    addresses.add(address);
  }
  const trust = new Set<DashboardTrustedProxyHeader>();
  if (trustHeaders !== undefined) {
    if (!Array.isArray(trustHeaders)) return "trustHeaders must be a list";
    for (const header of trustHeaders) {
      const name = typeof header === "string" ? header.toLowerCase() : "";
      if (!(DASHBOARD_TRUSTED_PROXY_HEADERS as readonly string[]).includes(name)) {
        return "trustHeaders may contain only x-forwarded-host and x-forwarded-proto";
      }
      trust.add(name as DashboardTrustedProxyHeader);
    }
  }
  return { origin: parsed.origin, host: parsed.host, addresses, trust };
}

/** Load schema: keeps the operator's spelling and refuses anything the parser refuses. */
export const dashboardTrustedProxySchema = z.unknown().superRefine((value, ctx) => {
  const parsed = parseDashboardTrustedProxy(value);
  if (typeof parsed === "string") ctx.addIssue({ code: "custom", message: parsed });
}) as unknown as z.ZodType<{ origin: string; proxyAddresses: string[]; trustHeaders?: DashboardTrustedProxyHeader[] }>;
