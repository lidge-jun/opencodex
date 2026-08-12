import { isIP } from "node:net";
import { assessUrlDestination, resolvePublicAddresses } from "../../lib/destination-policy";
import { localFingerprint } from "../digest";
import { readInstallationSalt } from "../subject/installation-salt";
import { TransportError } from "./transport";
import type { DnsResolver, LabDestinationV1 } from "./types";

export class LabDestinationError extends Error {
  override readonly name = "LabDestinationError";
  constructor(message: string, readonly code: string) { super(message); }
}

function normalizeBasePath(pathname: string): string {
  if (!pathname || pathname === "/") return "";
  const trimmed = pathname.endsWith("/") ? pathname.slice(0, -1) : pathname;
  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

function addressUrl(scheme: "http" | "https", address: string): string {
  return `${scheme}://${isIP(address) === 6 ? `[${address}]` : address}/`;
}

function validateResolvedAddress(
  scheme: "http" | "https",
  address: { address: string; family: 4 | 6 },
  allowPrivateNetwork: boolean,
  labRunApproval: boolean,
): boolean {
  const actualFamily = isIP(address.address);
  if ((actualFamily !== 4 && actualFamily !== 6) || actualFamily !== address.family) {
    throw new LabDestinationError("resolver returned an invalid address/family", "harness_failure");
  }
  const assessment = assessUrlDestination(addressUrl(scheme, address.address));
  if (!assessment) throw new LabDestinationError("resolver address could not be classified", "harness_failure");
  if (["metadata", "link-local", "unspecified"].includes(assessment.kind)) {
    throw new LabDestinationError("blocked resolved destination", "harness_failure");
  }
  const privateAnswer = ["private", "loopback", "localhost"].includes(assessment.kind);
  if (privateAnswer && (!allowPrivateNetwork || !labRunApproval)) {
    throw new LabDestinationError("resolved private network requires allowPrivateNetwork and labRunApproval", "harness_failure");
  }
  return privateAnswer;
}

function canonicalAddresses(addresses: ReadonlyArray<{ address: string; family: 4 | 6 }>): Array<{ address: string; family: 4 | 6 }> {
  const unique = new Map<string, { address: string; family: 4 | 6 }>();
  for (const row of addresses) unique.set(`${row.family}:${row.address}`, { ...row });
  return [...unique.values()].sort((a, b) => a.family - b.family || (a.address < b.address ? -1 : a.address > b.address ? 1 : 0));
}

function addressSetKey(addresses: ReadonlyArray<{ address: string; family: 4 | 6 }>): string {
  return canonicalAddresses(addresses).map((row) => `${row.family}:${row.address}`).join(",");
}

async function withResolutionTimeout<T>(timeoutMs: number, operation: () => Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation(),
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new TransportError("connect_timeout", "destination resolution timed out")), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export interface CreateDestinationOptions {
  baseUrl: string;
  allowPrivateNetwork?: boolean;
  labRunApproval?: boolean;
  resolve?: DnsResolver;
  connectTimeoutMs?: number;
  configDir?: string;
}

/** Resolve once, policy-check every answer, then freeze the exact snapshot used by all later stages. */
export async function createLabDestination(opts: CreateDestinationOptions): Promise<LabDestinationV1> {
  let parsed: URL;
  try { parsed = new URL(opts.baseUrl); } catch { throw new LabDestinationError("invalid provider baseUrl", "harness_failure"); }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new LabDestinationError("unsupported URL scheme", "harness_failure");
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new LabDestinationError("provider destination may not contain userinfo, query, or fragment", "harness_failure");
  }
  const scheme = parsed.protocol === "https:" ? "https" as const : "http" as const;
  const literal = assessUrlDestination(parsed.toString());
  if (literal && ["metadata", "link-local", "unspecified"].includes(literal.kind)) {
    throw new LabDestinationError("blocked destination", "harness_failure");
  }
  const allowPrivate = opts.allowPrivateNetwork === true;
  const approved = opts.labRunApproval === true;
  const literalPrivate = Boolean(literal && ["private", "loopback", "localhost"].includes(literal.kind));
  if (literalPrivate && (!allowPrivate || !approved)) {
    throw new LabDestinationError("private network requires allowPrivateNetwork and labRunApproval", "harness_failure");
  }

  const connectTimeoutMs = opts.connectTimeoutMs ?? 10_000;
  if (!Number.isInteger(connectTimeoutMs) || connectTimeoutMs <= 0) {
    throw new LabDestinationError("invalid connect timeout", "harness_failure");
  }

  let addresses: Array<{ address: string; family: 4 | 6 }>;
  let privateNetwork = literalPrivate;
  if (opts.resolve) {
    try { addresses = await withResolutionTimeout(connectTimeoutMs, () => opts.resolve!(parsed.hostname)); }
    catch (error) {
      if (error instanceof TransportError || error instanceof LabDestinationError) throw error;
      throw new LabDestinationError("DNS resolution failed", "network_blocked");
    }
    if (addresses.length === 0) throw new LabDestinationError("DNS resolution returned no addresses", "network_blocked");
    for (const row of addresses) privateNetwork = validateResolvedAddress(scheme, row, allowPrivate, approved) || privateNetwork;
  } else {
    try {
      const resolved = await withResolutionTimeout(connectTimeoutMs, () => resolvePublicAddresses(parsed.toString(), {
        context: "Lab provider destination",
        allowPrivateNetwork: allowPrivate && approved,
      }));
      addresses = resolved.addresses.map((row) => ({ address: row.address, family: row.family === 6 ? 6 as const : 4 as const }));
      privateNetwork = resolved.privateNetwork || privateNetwork;
    } catch (error) {
      if (error instanceof TransportError || error instanceof LabDestinationError) throw error;
      throw new LabDestinationError("DNS destination policy failed", "network_blocked");
    }
  }
  const frozenAddresses = Object.freeze(canonicalAddresses(addresses).map((row) => Object.freeze(row)));
  const port = parsed.port ? Number(parsed.port) : scheme === "https" ? 443 : 80;
  if (!Number.isInteger(port) || port <= 0 || port > 65535) throw new LabDestinationError("invalid destination port", "harness_failure");
  const snapshot = {
    scheme,
    host: parsed.hostname.toLowerCase(),
    port,
    basePath: normalizeBasePath(parsed.pathname),
    sniHost: parsed.hostname.toLowerCase(),
    addresses: frozenAddresses,
    privateNetwork,
  };
  const salt = readInstallationSalt(opts.configDir);
  const fingerprint = localFingerprint("endpoint", {
    scheme: snapshot.scheme, host: snapshot.host, port: snapshot.port, basePath: snapshot.basePath,
  }, salt);
  return Object.freeze({ ...snapshot, fingerprint });
}

/** Detect any attempted replacement/re-resolution of the approved immutable address set. */
export function assertDestinationAddressSet(destination: LabDestinationV1, addresses: Array<{ address: string; family: 4 | 6 }>): void {
  if (addressSetKey(destination.addresses) !== addressSetKey(addresses)) {
    throw new LabDestinationError("destination address set mismatch", "destination_mismatch");
  }
}

export function assertHostSniMatch(destination: LabDestinationV1, host: string, sni?: string): void {
  if (host.toLowerCase() !== destination.host) throw new LabDestinationError("host mismatch", "host_sni_mismatch");
  if (sni !== undefined && sni.toLowerCase() !== destination.sniHost) throw new LabDestinationError("SNI mismatch", "host_sni_mismatch");
}
