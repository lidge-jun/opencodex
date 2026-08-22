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

export type DestinationKind =
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
  // Decode hex IPv4-mapped IPv6: ::ffff:7f00:1 → 127.0.0.1
  // The dotted-decimal regex above only matches ::ffff:127.0.0.1; without this,
  // hex form bypasses all private/loopback checks (hextet is 0 → classified "public").
  const hexMapped = hostname.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i);
  if (hexMapped) {
    const hi = Number.parseInt(hexMapped[1], 16);
    const lo = Number.parseInt(hexMapped[2], 16);
    const ipv4 = `${(hi >> 8) & 255}.${hi & 255}.${(lo >> 8) & 255}.${lo & 255}`;
    return classifyIpv4(ipv4);
  }
  if (hostname === "::1") return { kind: "loopback", detail: "loopback address" };
  if (hostname === "::") return { kind: "unspecified", detail: "unspecified address" };
  const hextet = firstIpv6Hextet(hostname);
  if (hextet === null) return { kind: "private", detail: "non-global address" };
  // Multicast ff00::/8, deprecated site-local fec0::/10, ULA fc00::/7, link-local fe80::/10.
  if (hextet >= 0xff00) return { kind: "private", detail: "multicast address" };
  if (hextet >= 0xfe80 && hextet <= 0xfebf) return { kind: "link-local", detail: "link-local address" };
  if (hextet >= 0xfec0 && hextet <= 0xfeff) return { kind: "private", detail: "site-local address" };
  if (hextet >= 0xfc00 && hextet <= 0xfdff) return { kind: "private", detail: "private-network address" };
  // Documentation 2001:db8::/32 (inside global-unicast 2000::/3).
  if (hextet === 0x2001) {
    const second = Number.parseInt(hostname.split(":")[1] || "0", 16);
    if (second === 0xdb8) return { kind: "private", detail: "documentation address" };
  }
  // Only global unicast 2000::/3 is treated as a public image/CDN peer.
  if (hextet >= 0x2000 && hextet <= 0x3fff) return { kind: "public", detail: "public IP" };
  return { kind: "private", detail: "non-global address" };
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

/**
 * OAuth registry entries that opt into `allowBaseUrlOverride` send bearer credentials to a
 * user-configured endpoint (review findings, PR #2109 / PR #2110): a cleartext `http:`
 * override would expose the OAuth token on the wire. `https:` is therefore required for
 * every non-local destination. Loopback/localhost/private relays keep working over
 * `http:` because they already sit behind the explicit `allowPrivateNetwork` opt-in
 * enforced by {@link providerDestinationConfigError}. Keyed/local providers (Ollama,
 * vLLM, LM Studio, LiteLLM, Moonshot, Qwen, Alibaba) are untouched: they are not
 * `authKind: "oauth"`, so this check never fires for them.
 */
function registrySendsOAuthToOverriddenBaseUrl(name: string): boolean {
  const entry = getProviderRegistryEntry(name);
  return entry?.authKind === "oauth" && entry.allowBaseUrlOverride === true;
}

export function providerSecureTransportConfigError(
  name: string,
  provider: Pick<OcxProviderConfig, "baseUrl" | "allowPrivateNetwork">,
): string | null {
  if (!registrySendsOAuthToOverriddenBaseUrl(name)) return null;
  let parsed: URL;
  try {
    parsed = new URL(provider.baseUrl.trim());
  } catch {
    return null; // invalid URLs are providerBaseUrlConfigError's concern
  }
  if (parsed.protocol !== "http:") return null;
  const assessment = assessDestination(provider.baseUrl);
  // Classify FIRST, then consult the opt-in. `allowPrivateNetwork` says "this destination is
  // intentionally local", which is a statement about the address, not a waiver of transport
  // security — reading it before classification let `http://attacker.example` with the opt-in
  // set carry an OAuth bearer in cleartext to a public host.
  if (!assessment) return null;
  const local = assessment.kind === "localhost"
    || assessment.kind === "loopback"
    || assessment.kind === "private";
  if (local && providerAllowsPrivateNetwork(name, provider)) {
    // A genuinely local relay over http stays reachable through the explicit opt-in; the
    // private-network gate still governs whether it may be reached at all.
    return null;
  }
  return "baseUrl must use https: this provider sends OAuth credentials to its endpoint, and http is allowed only for loopback/private relays";
}

/**
 * Whether a provider may reach loopback/private addresses.
 *
 * Two sources, and both have to be consulted at every boundary: the operator's explicit
 * `allowPrivateNetwork`, and the registry's `allowPrivateNetworkByDefault` for entries that are
 * local BY DEFINITION (Ollama, vLLM, LM Studio, LiteLLM). Config validation already read both;
 * outbound discovery read only the first, so a stock Ollama entry passed validation and was then
 * refused at the fetch (#758).
 *
 * This grants nothing new. Metadata, link-local and unspecified destinations are rejected before
 * this is consulted, and a provider without either source still cannot reach a private address.
 */
export function providerAllowsPrivateNetwork(
  name: string,
  provider: Pick<OcxProviderConfig, "allowPrivateNetwork">,
): boolean {
  return provider.allowPrivateNetwork === true || registryAllowsPrivateNetwork(name);
}

export function providerDestinationConfigError(name: string, provider: Pick<OcxProviderConfig, "baseUrl" | "allowPrivateNetwork">): string | null {
  const secureTransportError = providerSecureTransportConfigError(name, provider);
  if (secureTransportError) return secureTransportError;
  const assessment = assessDestination(provider.baseUrl);
  if (!assessment) return null;
  if (assessment.kind === "public" || assessment.kind === "hostname") return null;
  if (assessment.kind === "metadata") return "baseUrl targets a blocked metadata endpoint";
  if (providerAllowsPrivateNetwork(name, provider)) return null;
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
 *
 * `allowBenchmarkAddresses` is only for the exact canonical ChatGPT Codex seed under
 * Clash fake-IP DNS (198.18.0.0/15). Every other non-public answer — including mixed
 * benchmark + private/metadata sets — still fails.
 */
export async function providerDestinationResolvedError(
  name: string,
  provider: Pick<OcxProviderConfig, "baseUrl" | "allowPrivateNetwork">,
  options?: { allowBenchmarkAddresses?: boolean },
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
  if (providerAllowsPrivateNetwork(name, provider)) return null;
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
    // Clash fake-IP only: 198.18/19 benchmark detail. Mixed dangerous sets still reject.
    if (
      options?.allowBenchmarkAddresses
      && assessment.kind === "private"
      && assessment.detail === "benchmark address"
    ) {
      continue;
    }
    if (assessment.kind === "metadata") return `baseUrl hostname ${hostname} resolves to a blocked metadata endpoint (${address})`;
    return `baseUrl hostname ${hostname} resolves to a ${assessment.detail} (${address}); set allowPrivateNetwork:true only for intentionally local/self-hosted providers`;
  }
  return null;
}

export interface UrlDestinationAssessment {
  kind: DestinationKind;
  detail: string;
}

export class DestinationDnsResolutionError extends Error {
  override readonly name = "DestinationDnsResolutionError";
}

/**
 * Synchronous literal URL destination assessment — classifies the hostname
 * without DNS resolution. Returns null for unparseable URLs.
 */
export function assessUrlDestination(url: string): UrlDestinationAssessment | null {
  return assessDestination(url);
}

/**
 * Async DNS-resolved URL safety check. By default, rejects every non-public
 * address. Provider diagnostics may explicitly admit loopback/private answers;
 * metadata, link-local, and unspecified addresses remain unconditionally denied.
 * Returns the validated addresses so direct callers can pin the connect peer and
 * avoid a second, rebindable resolution. DNS failures remain fail-closed here;
 * the provider proxy wrapper alone may recognize that typed failure and degrade.
 *
 * `allowBenchmarkAddresses` is an explicit outbound-only opt-in for Clash/Surge/
 * Mihomo fake-IP DNS (IANA benchmark space 198.18.0.0/15, credit #1748): a hostname
 * answer in that range is accepted without marking the destination private, so the
 * caller can keep the hostname on its configured HTTP(S) proxy path. It applies to
 * resolved answers only — a literal 198.18.x URL still rejects — and mixed answers
 * that include any other non-public address still fail. Callers that do not pass it
 * (image and Lab fetch) keep rejecting benchmark space.
 */
export async function resolvePublicAddresses(
  url: string,
  options?: string | { context?: string; allowPrivateNetwork?: boolean; allowBenchmarkAddresses?: boolean },
): Promise<{
  hostname: string;
  addresses: { address: string; family: number }[];
  privateNetwork: boolean;
}> {
  const context = typeof options === "string"
    ? `${options.trim() || "image"} URL`
    : options?.context?.trim() || "image URL";
  const privateNetworkAllowed = typeof options === "object" && options?.allowPrivateNetwork === true;
  const benchmarkAllowed = typeof options === "object" && options?.allowBenchmarkAddresses === true;
  let hostname: string;
  try {
    hostname = normalizeHostname(new URL(url.trim()).hostname);
  } catch {
    throw new Error(`${context} is not a valid URL`);
  }
  if (!hostname) throw new Error(`${context} has no hostname`);
  const literalAssessment = assessDestination(url);
  let privateNetwork = false;
  if (literalAssessment && literalAssessment.kind !== "public" && literalAssessment.kind !== "hostname") {
    const allowedPrivateLiteral = privateNetworkAllowed
      && (literalAssessment.kind === "localhost"
        || literalAssessment.kind === "loopback"
        || literalAssessment.kind === "private");
    if (!allowedPrivateLiteral) throw new Error(`${context} targets ${literalAssessment.detail}`);
    privateNetwork = true;
  }
  // Literal public IPs: no DNS round-trip; pin the literal itself.
  const literalKind = isIP(hostname);
  if (literalKind !== 0) {
    return { hostname, addresses: [{ address: hostname, family: literalKind }], privateNetwork };
  }
  let addresses: { address: string; family: number }[];
  try {
    addresses = await lookup(hostname, { all: true, verbatim: true });
  } catch {
    // If DNS fails, we can't verify — fail-closed (unlike provider config-time validation,
    // this is a runtime fetch to an untrusted URL, so be conservative).
    throw new DestinationDnsResolutionError(`${context} hostname ${hostname} could not be resolved`);
  }
  if (addresses.length === 0) {
    throw new DestinationDnsResolutionError(`${context} hostname ${hostname} could not be resolved`);
  }
  const validatedAddresses: { address: string; family: number }[] = [];
  for (const { address, family } of addresses) {
    // Prefer classifying from the address string itself — do not trust a mislabeled
    // resolver `family` that could skip IPv4/IPv6 private checks.
    const ipKind = isIP(address) || (family === 4 || family === 6 ? family : 0);
    const assessment = ipKind === 4 ? classifyIpv4(address) : ipKind === 6 ? classifyIpv6(normalizeHostname(address)) : null;
    if (!assessment || assessment.kind !== "public") {
      // Hostname → 198.18.0.0/15 under the explicit opt-in is Clash/Surge/Mihomo
      // fake-IP DNS, not a LAN provider. Accept it without allowPrivateNetwork and
      // do not mark the destination private, so the caller's HTTP(S)_PROXY path
      // still applies (credit #1748).
      if (benchmarkAllowed && assessment?.kind === "private" && assessment.detail === "benchmark address") {
        validatedAddresses.push({ address, family: ipKind === 4 || ipKind === 6 ? ipKind : (family || 4) });
        continue;
      }
      const allowedPrivateAddress = privateNetworkAllowed
        && assessment
        && (assessment.kind === "loopback" || assessment.kind === "private");
      if (!allowedPrivateAddress) {
        throw new Error(`${context} hostname ${hostname} resolves to ${assessment?.detail ?? "an unsafe address"} (${address})`);
      }
      privateNetwork = true;
    }
    validatedAddresses.push({ address, family: ipKind === 4 || ipKind === 6 ? ipKind : (family || 4) });
  }
  return { hostname, addresses: validatedAddresses, privateNetwork };
}

/**
 * Void assertion wrapper around {@link resolvePublicAddresses} for call sites
 * that only need the safety check.
 */
export async function assertUrlResolvesPublic(url: string): Promise<void> {
  await resolvePublicAddresses(url);
}

