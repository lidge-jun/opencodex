import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { getProviderRegistryEntry } from "../providers/registry";
import type { OcxProviderConfig } from "../types";

const BLOCKED_METADATA_HOSTS = new Set([
  "instance-data.ec2.internal",
  "metadata.azure.internal",
  "metadata.google.internal",
]);

const BLOCKED_METADATA_IPV4 = new Set([
  "100.100.100.200",
  "169.254.169.254",
  "169.254.170.2",
]);

const BLOCKED_METADATA_IPV6 = new Set([
  "fd00:ec2::254",
]);

type DestinationKind =
  | "public"
  | "hostname"
  | "localhost"
  | "loopback"
  | "private"
  | "link-local"
  | "unspecified"
  | "metadata";

interface DestinationAssessment {
  kind: DestinationKind;
  detail: string;
}

function normalizeHostname(hostname: string): string {
  const trimmed = hostname.trim().toLowerCase().replace(/\.+$/, "");
  return trimmed.startsWith("[") && trimmed.endsWith("]") ? trimmed.slice(1, -1) : trimmed;
}

function parseIpv4(hostname: string): number[] | null {
  const parts = hostname.split(".");
  if (parts.length !== 4) return null;
  const octets = parts.map(part => Number(part));
  return octets.every(octet => Number.isInteger(octet) && octet >= 0 && octet <= 255) ? octets : null;
}

function classifyIpv4(hostname: string): DestinationAssessment {
  if (BLOCKED_METADATA_IPV4.has(hostname)) return { kind: "metadata", detail: "blocked metadata endpoint" };
  const octets = parseIpv4(hostname);
  if (!octets) return { kind: "public", detail: "public IP" };
  const [a, b, c] = octets;
  if (a === 127) return { kind: "loopback", detail: "loopback address" };
  if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127)) {
    return { kind: "private", detail: "private-network address" };
  }
  if (a === 169 && b === 254) return { kind: "link-local", detail: "link-local address" };
  if (a === 0) return { kind: "unspecified", detail: "unspecified address" };
  // Reserved / non-public ranges (review finding, PR #96): protocol-assignment,
  // documentation, benchmark, multicast, and reserved-future space never name a
  // legitimate provider endpoint.
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return { kind: "private", detail: "reserved address" };
  if (a === 198 && (b === 18 || b === 19)) return { kind: "private", detail: "benchmark address" };
  if (a === 198 && b === 51 && c === 100) return { kind: "private", detail: "documentation address" };
  if (a === 203 && b === 0 && c === 113) return { kind: "private", detail: "documentation address" };
  if (a >= 224) return { kind: "private", detail: "multicast/reserved address" };
  return { kind: "public", detail: "public IP" };
}

function firstIpv6Hextet(hostname: string): number | null {
  const head = hostname.split(":")[0];
  if (!head) return 0;
  const parsed = Number.parseInt(head, 16);
  return Number.isNaN(parsed) ? null : parsed;
}

function classifyIpv6(hostname: string): DestinationAssessment {
  if (BLOCKED_METADATA_IPV6.has(hostname)) return { kind: "metadata", detail: "blocked metadata endpoint" };
  const mappedIpv4 = hostname.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i)?.[1];
  if (mappedIpv4) return classifyIpv4(mappedIpv4);
  if (hostname === "::1") return { kind: "loopback", detail: "loopback address" };
  if (hostname === "::") return { kind: "unspecified", detail: "unspecified address" };
  const hextet = firstIpv6Hextet(hostname);
  if (hextet === null) return { kind: "public", detail: "public IP" };
  if (hextet >= 0xfc00 && hextet <= 0xfdff) return { kind: "private", detail: "private-network address" };
  if (hextet >= 0xfe80 && hextet <= 0xfebf) return { kind: "link-local", detail: "link-local address" };
  return { kind: "public", detail: "public IP" };
}

function assessDestination(baseUrl: string): DestinationAssessment | null {
  try {
    const parsed = new URL(baseUrl.trim());
    const hostname = normalizeHostname(parsed.hostname);
    if (!hostname) return null;
    if (BLOCKED_METADATA_HOSTS.has(hostname)) return { kind: "metadata", detail: "blocked metadata endpoint" };
    if (hostname === "localhost" || hostname.endsWith(".localhost")) {
      return { kind: "localhost", detail: "localhost destination" };
    }
    const ipKind = isIP(hostname);
    if (ipKind === 4) return classifyIpv4(hostname);
    if (ipKind === 6) return classifyIpv6(hostname);
    return { kind: "hostname", detail: "hostname destination" };
  } catch {
    return null;
  }
}

function registryAllowsPrivateNetwork(name: string): boolean {
  return getProviderRegistryEntry(name)?.allowPrivateNetworkByDefault === true;
}

export function providerDestinationConfigError(name: string, provider: Pick<OcxProviderConfig, "baseUrl" | "allowPrivateNetwork">): string | null {
  const assessment = assessDestination(provider.baseUrl);
  if (!assessment) return null;
  if (assessment.kind === "public" || assessment.kind === "hostname") return null;
  if (assessment.kind === "metadata") return "baseUrl targets a blocked metadata endpoint";
  if (registryAllowsPrivateNetwork(name)) return null;
  if (provider.allowPrivateNetwork === true) return null;
  return `baseUrl points to a ${assessment.detail}; set allowPrivateNetwork:true only for intentionally local/self-hosted providers`;
}

export function assertProviderDestinationAllowed(name: string, provider: Pick<OcxProviderConfig, "baseUrl" | "allowPrivateNetwork">): void {
  const error = providerDestinationConfigError(name, provider);
  if (error) throw new Error(`provider ${name} ${error}`);
}

/**
 * Async companion to {@link providerDestinationConfigError} for hostname destinations:
 * resolves A/AAAA records and classifies every address, so a hostname that points at
 * loopback/private/metadata space is caught at provider write time (review finding,
 * PR #96 — the sync path must stay literal-only because the router hot path and
 * config load are synchronous). DNS failures return null: config-time validation is
 * advisory and must not hard-fail offline startups. DNS rebinding after validation is
 * a recorded residual for this loopback proxy (devlog 260712_pr_batch_landing 000).
 */
export async function providerDestinationResolvedError(
  name: string,
  provider: Pick<OcxProviderConfig, "baseUrl" | "allowPrivateNetwork">,
): Promise<string | null> {
  const syncError = providerDestinationConfigError(name, provider);
  if (syncError) return syncError;
  let hostname: string;
  try {
    hostname = normalizeHostname(new URL(provider.baseUrl.trim()).hostname);
  } catch {
    return null;
  }
  if (!hostname || isIP(hostname) !== 0 || hostname === "localhost" || hostname.endsWith(".localhost")) {
    return null; // literals and localhost are fully handled by the sync path
  }
  if (registryAllowsPrivateNetwork(name) || provider.allowPrivateNetwork === true) return null;
  let addresses: { address: string }[];
  try {
    addresses = await lookup(hostname, { all: true, verbatim: true });
  } catch {
    return null; // unresolvable now ≠ malicious; the provider simply won't connect
  }
  for (const { address } of addresses) {
    const ipKind = isIP(address);
    const assessment = ipKind === 4 ? classifyIpv4(address) : ipKind === 6 ? classifyIpv6(normalizeHostname(address)) : null;
    if (!assessment || assessment.kind === "public") continue;
    if (assessment.kind === "metadata") return `baseUrl hostname ${hostname} resolves to a blocked metadata endpoint (${address})`;
    return `baseUrl hostname ${hostname} resolves to a ${assessment.detail} (${address}); set allowPrivateNetwork:true only for intentionally local/self-hosted providers`;
  }
  return null;
}
