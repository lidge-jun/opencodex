/**
 * Classify an upstream provider destination as local or public.
 *
 * A *local* upstream is operator-trusted infrastructure on the same machine or LAN — LM Studio,
 * Ollama, a self-hosted vLLM, a local gateway. Those models are frequently CPU-bound and their
 * time-to-first-token or thinking phases can go silent for minutes, so a stall budget applied
 * there would kill healthy turns. The stall resolver (`src/stall-timeout.ts`) therefore treats an
 * unset budget on a local upstream as *disabled* while public upstreams keep the 300 s default.
 *
 * The destination is the provider's `baseUrl` (or the built request URL) — where the proxy
 * actually dials upstream. This is a different question from
 * `src/lib/local-destinations.ts`, which answers where local clients dial *this hub*; do not
 * conflate them.
 *
 * Conservative on purpose: only clear local evidence (loopback, private, link-local, or a
 * `.local`/`.lan` name) earns the disabled budget. Anything else — a public DNS name, an
 * unreachable host, a bare domain — stays public and keeps its stall budget, because being local
 * is what switches OFF a safety clock.
 */
import { isIP } from "node:net";

/** True when the provider destination is local infrastructure and its stall budget should default to disabled. */
export function isLocalUpstream(destination: string | null | undefined): boolean {
  if (!destination) return false;
  // A bare IP literal must be classified before URL parsing: `new URL("fe80::1")` reads the first
  // hextet as a scheme and yields an empty host, and `new URL("::1")` throws — either way the host
  // would be lost. Zone ids (`fe80::1%eth0`) are stripped for the family check.
  const trimmed = destination.trim();
  const literalFamily = isIP(trimmed.split("%")[0]);
  if (literalFamily === 4) return isLocalIpv4(trimmed);
  if (literalFamily === 6) return isLocalIpv6(trimmed.split("%")[0]);

  const host = hostnameOf(destination);
  if (!host) return false;
  const bare = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  const normalized = bare.toLowerCase().split("%")[0].replace(/\.$/, "");
  if (normalized === "") return false;
  if (normalized === "localhost") return true;
  if (normalized.endsWith(".local") || normalized.endsWith(".lan")) return true;
  const family = isIP(normalized);
  if (family === 4) return isLocalIpv4(normalized);
  if (family === 6) return isLocalIpv6(normalized);
  return false;
}

/**
 * Extract a hostname from a full URL or a schemeless `host:port` / bare host.
 *
 * `new URL` handles the scheme-bearing forms (it keeps IPv6 brackets in `hostname`); the fallback
 * recovers the host from a schemeless string by dropping a port or bracketed IPv6 suffix.
 */
function hostnameOf(destination: string): string | null {
  const trimmed = destination.trim();
  if (!trimmed) return null;
  // Only trust `new URL` when it produces a non-empty host. `new URL("localhost:1234")` succeeds
  // but reads `localhost` as a scheme and leaves the host empty, so fall through to the schemeless
  // parse in that case rather than returning null.
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) {
    try {
      const parsed = new URL(trimmed).hostname;
      if (parsed) return parsed;
    } catch {
      // Not an absolute URL after all: fall through to the schemeless forms.
    }
  }
  let host = trimmed;
  if (host.startsWith("[")) {
    const end = host.indexOf("]");
    host = end > 0 ? host.slice(1, end) : host.slice(1);
  } else {
    const colon = host.indexOf(":");
    if (colon >= 0) host = host.slice(0, colon);
  }
  return host || null;
}

/** 0.0.0.0/8, 10/8, 127/8 (loopback), 169.254/16 (link-local), 172.16/12, 192.168/16. */
function isLocalIpv4(host: string): boolean {
  const parts = host.split(".");
  if (parts.length !== 4) return false;
  const octets: number[] = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return false;
    const value = Number(part);
    if (value > 255) return false;
    octets.push(value);
  }
  const [a, b] = octets;
  if (a === 0) return true;
  if (a === 10) return true;
  if (a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  return false;
}

/** ::1 (loopback), `::ffff:a.b.c.d` (mapped), fe80::/10 (link-local), fc00::/7 (unique-local). */
function isLocalIpv6(host: string): boolean {
  const lower = host.toLowerCase();
  const groups = ipv6Groups(lower);
  if (!groups) return false;
  // Loopback in any spelling: every group zero except a trailing one.
  if (groups.every((group, index) => (index < 7 ? group === 0 : group === 1))) return true;
  const mapped = lower.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (mapped) return isLocalIpv4(mapped[1]);
  const first = groups[0];
  if ((first & 0xffc0) === 0xfe80) return true;
  if ((first & 0xfe00) === 0xfc00) return true;
  return false;
}

/** Expand a (possibly `::`-compressed) IPv6 literal into eight 16-bit groups, or null if malformed. */
function ipv6Groups(host: string): number[] | null {
  const marker = host.indexOf("::");
  const compressed = marker >= 0;
  const head = compressed ? host.slice(0, marker) : host;
  const tail = compressed ? host.slice(marker + 2) : "";
  const headGroups = head === "" ? [] : head.split(":");
  let tailGroups = tail === "" ? [] : tail.split(":");
  // A trailing embedded IPv4 (e.g. `64:ff9b::1.2.3.4`) counts as two groups.
  const last = tailGroups[tailGroups.length - 1];
  if (last !== undefined && last.includes(".")) {
    const v4 = last.split(".");
    if (v4.length === 4 && v4.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)) {
      const [o0, o1, o2, o3] = v4.map(Number);
      tailGroups = [...tailGroups.slice(0, -1), ((o0 << 8) | o1).toString(16), ((o2 << 8) | o3).toString(16)];
    } else return null;
  }
  let groups: string[];
  if (compressed) {
    // `::` fills the gap *between* head and tail with zero groups, not at either end.
    const fill = 8 - headGroups.length - tailGroups.length;
    if (fill < 1) return null;
    groups = [...headGroups, ...Array<string>(fill).fill("0"), ...tailGroups];
  } else {
    groups = [...headGroups, ...tailGroups];
    if (groups.length !== 8) return null;
  }
  const numbers = groups.map((group) => (isHextet(group) ? parseInt(group, 16) : Number.NaN));
  return numbers.some((group) => Number.isNaN(group)) ? null : numbers;
}

function isHextet(token: string): boolean {
  return /^[0-9a-f]{1,4}$/i.test(token);
}
