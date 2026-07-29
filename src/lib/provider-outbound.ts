import type { OcxProviderConfig } from "../types";
import {
  assessUrlDestination,
  DestinationDnsResolutionError,
  providerDestinationConfigError,
  resolvePublicAddresses,
} from "./destination-policy";
import { pinnedHttpGet } from "./pinned-http";
import { outboundProxyConfigured } from "./proxy-env";
import { publicProviderBaseUrl } from "./provider-url";

type ProviderGetInit = Omit<RequestInit, "body" | "method" | "redirect">;
type ProviderOutboundConfig = Pick<OcxProviderConfig, "baseUrl" | "allowPrivateNetwork"> & {
  fetch?: typeof globalThis.fetch;
};
export interface ProviderOutboundDependencies {
  resolveAddresses?: typeof resolvePublicAddresses;
  pinnedGet?: typeof pinnedHttpGet;
}

export class ProviderOutboundPolicyError extends Error {
  override readonly name = "ProviderOutboundPolicyError";
}

function pickPinnedAddress(addresses: Array<{ address: string; family: number }>): { address: string; family: number } {
  return addresses.find(address => address.family === 4) ?? addresses[0]!;
}

function configuredProxyFor(): boolean {
  return outboundProxyConfigured();
}

function normalizeProxyHostname(hostname: string): string {
  const normalized = hostname.trim().toLowerCase().replace(/\.+$/, "");
  return normalized.startsWith("[") && normalized.endsWith("]")
    ? normalized.slice(1, -1)
    : normalized;
}

function noProxyMatches(url: URL): boolean {
  const raw = process.env.NO_PROXY ?? process.env.no_proxy ?? "";
  const hostname = normalizeProxyHostname(url.hostname);
  const port = url.port || (url.protocol === "https:" ? "443" : "80");
  for (const rawEntry of raw.split(",")) {
    let entry = rawEntry.trim().toLowerCase();
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
    entryHost = normalizeProxyHostname(entryHost.replace(/^\*?\./, ""));
    if (!entryHost) continue;
    if (hostname === entryHost || hostname.endsWith(`.${entryHost}`)) return true;
  }
  return false;
}

let proxyBoundaryWarned = false;
let proxyDnsDegradationWarned = false;

function warnProxyBoundaryOnce(): void {
  if (proxyBoundaryWarned) return;
  proxyBoundaryWarned = true;
  console.warn(
    "[opencodex] Provider outbound proxy mode preserves Bun proxy/NO_PROXY routing and validates "
    + "the URL plus available local DNS results; the final route and peer cannot be pinned locally.",
  );
}

function warnProxyDnsDegradationOnce(): void {
  if (proxyDnsDegradationWarned) return;
  proxyDnsDegradationWarned = true;
  console.warn(
    "[opencodex] Local DNS could not resolve a proxied provider hostname; continuing after URL/literal checks. "
    + "The proxy-selected peer cannot be verified or pinned locally.",
  );
}

export async function providerRedirectError(response: Response, requestUrl: string): Promise<string | null> {
  if (response.status < 300 || response.status >= 400) return null;
  try { await response.body?.cancel(); } catch { /* ignore cancellation failures */ }
  const location = response.headers.get("location");
  let target = "the final upstream URL";
  if (location) {
    try { target = publicProviderBaseUrl(new URL(location, requestUrl).toString()); } catch { /* keep fallback */ }
  }
  return `provider returned ${response.status} redirect to ${target}; configure the final provider URL directly`;
}

export async function providerOutboundGet(
  name: string,
  provider: ProviderOutboundConfig,
  url: string,
  init: ProviderGetInit = {},
  dependencies: ProviderOutboundDependencies = {},
): Promise<Response> {
  if (provider.fetch) {
    // A caller-owned executor cannot be peer-pinned here. This branch keeps literal/config
    // checks and redirect blocking, but does not provide the resolved-address guarantees of
    // the built-in transport. Main-request migration must define that executor contract first.
    const assessment = assessUrlDestination(url);
    if (assessment?.kind === "metadata" || assessment?.kind === "link-local" || assessment?.kind === "unspecified") {
      throw new ProviderOutboundPolicyError(`provider URL targets ${assessment.detail}`);
    }
    if (!provider.allowPrivateNetwork) {
      const destinationError = providerDestinationConfigError(name, {
        baseUrl: url,
        allowPrivateNetwork: false,
      });
      if (destinationError) throw new ProviderOutboundPolicyError(destinationError);
    }
    return provider.fetch(url, { ...init, method: "GET", redirect: "manual" });
  }
  const parsed = new URL(url);
  const proxyConfigured = configuredProxyFor();
  const resolveAddresses = dependencies.resolveAddresses ?? resolvePublicAddresses;
  const pinnedGet = dependencies.pinnedGet ?? pinnedHttpGet;
  let resolved: Awaited<ReturnType<typeof resolvePublicAddresses>>;
  try {
    resolved = await resolveAddresses(url, {
      context: "provider URL",
      allowPrivateNetwork: provider.allowPrivateNetwork,
    });
  } catch (error) {
    const dnsResolutionFailed = error instanceof DestinationDnsResolutionError
      || (error instanceof Error && error.name === "DestinationDnsResolutionError");
    if (!dnsResolutionFailed) {
      throw new ProviderOutboundPolicyError(error instanceof Error ? error.message : "provider destination was blocked");
    }
    if (!proxyConfigured) throw error;
    warnProxyBoundaryOnce();
    warnProxyDnsDegradationOnce();
    return globalThis.fetch(url, { ...init, method: "GET", redirect: "manual" });
  }
  if (proxyConfigured && !resolved.privateNetwork) {
    warnProxyBoundaryOnce();
    return globalThis.fetch(url, { ...init, method: "GET", redirect: "manual" });
  }
  if (proxyConfigured && resolved.privateNetwork && !noProxyMatches(parsed)) {
    const hostname = normalizeProxyHostname(parsed.hostname);
    throw new Error(
      `provider URL resolves to a private-network destination; add ${hostname} to NO_PROXY before using allowPrivateNetwork with an outbound proxy`,
    );
  }
  return pinnedGet(url, pickPinnedAddress(resolved.addresses), init.signal ?? undefined, {
    headers: init.headers,
    rejectUnauthorized: true,
    context: "provider response",
  });
}
