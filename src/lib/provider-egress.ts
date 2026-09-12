// Resolves provider-scoped HTTP(S) proxy overrides.
import type { OcxProviderConfig } from "../types";

export class InvalidProviderEgressError extends Error {
  override readonly name = "InvalidProviderEgressError";
}

export interface ProviderEgressContext {
  providerName: string;
  modelId?: string;
  provider: Pick<OcxProviderConfig, "proxy">;
  url: string | URL;
  purpose?: string;
}

export type ProviderEgress =
  | { kind: "inherit" }
  | { kind: "proxy"; proxyUrl: string; routeKey: string };

function egressFailure(providerName: string, reason: string, purpose?: string): never {
  const scope = purpose ? " (" + purpose + ")" : "";
  throw new InvalidProviderEgressError(
    "providers." + providerName + ".proxy is invalid" + scope + ": " + reason + ". " +
    "Phase 1 supports only an explicit http(s) proxy URL; omit the field to inherit global behavior."
  );
}

function fnv1aHex(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  const unsigned = hash >>> 0;
  return unsigned.toString(16).padStart(8, "0");
}

// Builds a credential-free connection reuse key.
export function providerEgressRouteKey(proxyUrl: string): string {
  const parsed = new URL(proxyUrl);
  const port = parsed.port || (parsed.protocol === "https:" ? "443" : "80");
  return "proxy|" + parsed.protocol + "//" + parsed.hostname.toLowerCase() + "|" + port + "|" + fnv1aHex(proxyUrl);
}

// Returns a credential-free proxy origin for logs.
export function sanitizeProxyUrlForLog(proxyUrl: string): string {
  try {
    return new URL(proxyUrl).origin;
  } catch {
    return "<unparseable-proxy-url>";
  }
}

export function describeProviderEgressForLog(egress: ProviderEgress): string {
  if (egress.kind === "inherit") return "inherit";
  return "proxy(" + sanitizeProxyUrlForLog(egress.proxyUrl) + " route=" + egress.routeKey + ")";
}

export function egressRequestUrl(input: string | URL | Request): URL | null {
  try {
    if (typeof input === "string") return new URL(input);
    if (input instanceof URL) return new URL(input.toString());
    return new URL(input.url);
  } catch {
    return null;
  }
}

function parseExplicitProxyUrl(providerName: string, trimmed: string, purpose?: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return egressFailure(providerName, "proxy is not a parseable absolute URL", purpose);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return egressFailure(
      providerName,
      "unsupported proxy scheme " + sanitizeProxyUrlForLog(trimmed) + "; Phase 1 supports only http(s)",
      purpose
    );
  }
  return parsed;
}

export function resolveProviderEgress(context: ProviderEgressContext): ProviderEgress {
  const providerName = context.providerName;
  const provider = context.provider;
  const purpose = context.purpose;
  const raw = provider.proxy;
  if (raw === undefined) return { kind: "inherit" };
  if (raw === null) {
    return egressFailure(providerName, "proxy null is not accepted; omit the field to inherit or use an explicit http(s) proxy URL", purpose);
  }
  if (typeof raw !== "string") {
    return egressFailure(providerName, "proxy must be a string URL or omitted", purpose);
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return egressFailure(providerName, "empty proxy value is not DIRECT; omit the field to inherit", purpose);
  }
  const lowered = trimmed.toLowerCase();
  if (lowered === "direct") {
    return egressFailure(providerName, "direct has no safe request-scoped transport on this runtime; use global noProxy", purpose);
  }
  if (lowered === "auto") {
    return egressFailure(providerName, "provider auto proxy is deferred in Phase 1A; omit the field to inherit the global proxy behavior", purpose);
  }
  const parsed = parseExplicitProxyUrl(providerName, trimmed, purpose);
  const target = egressRequestUrl(context.url);
  if (target === null) {
    return egressFailure(providerName, "target URL is not parseable", purpose);
  }
  const proxyUrl = parsed.toString();
  return { kind: "proxy", proxyUrl: proxyUrl, routeKey: providerEgressRouteKey(proxyUrl) };
}
