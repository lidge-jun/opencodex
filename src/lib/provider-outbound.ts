import type { OcxProviderConfig } from "../types";
import {
  assessUrlDestination,
  DestinationDnsResolutionError,
  providerAllowsPrivateNetwork,
  providerDestinationConfigError,
  resolvePublicAddresses,
} from "./destination-policy";
import { pinnedHttpGet, pinnedHttpPost } from "./pinned-http";
import { outboundProxyConfigured } from "./proxy-env";
import { publicProviderBaseUrl } from "./provider-url";

type ProviderGetInit = Omit<RequestInit, "body" | "method" | "redirect">;
type ProviderPostInit = ProviderGetInit & { body: string };
type ProviderOutboundConfig = Pick<OcxProviderConfig, "baseUrl" | "allowPrivateNetwork"> & {
  fetch?: typeof globalThis.fetch;
};
export interface ProviderOutboundDependencies {
  resolveAddresses?: typeof resolvePublicAddresses;
  pinnedGet?: typeof pinnedHttpGet;
  pinnedPost?: typeof pinnedHttpPost;
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

async function providerOutboundRequest(
  name: string,
  provider: ProviderOutboundConfig,
  url: string,
  method: "GET" | "POST",
  init: ProviderGetInit | ProviderPostInit,
  dependencies: ProviderOutboundDependencies = {},
): Promise<Response> {
  const postUrl = method === "POST" ? new URL(url) : undefined;
  if (postUrl?.protocol !== undefined && postUrl.protocol !== "https:") {
    throw new ProviderOutboundPolicyError("provider POST URL must use HTTPS");
  }
  if (provider.fetch) {
    // A caller-owned executor cannot be peer-pinned here. This branch keeps literal/config
    // checks and redirect blocking, but does not provide the resolved-address guarantees of
    // the built-in transport. Main-request migration must define that executor contract first.
    const assessment = assessUrlDestination(url);
    if (assessment?.kind === "metadata" || assessment?.kind === "link-local" || assessment?.kind === "unspecified") {
      throw new ProviderOutboundPolicyError(`provider URL targets ${assessment.detail}`);
    }
    // Registry defaults count here too, not just the operator flag: a stock Ollama entry is
    // local by definition and previously passed config validation only to be refused at the
    // fetch (#758). Metadata/link-local/unspecified were already rejected above.
    const allowPrivate = providerAllowsPrivateNetwork(name, provider);
    if (!allowPrivate) {
      const destinationError = providerDestinationConfigError(name, {
        baseUrl: url,
        allowPrivateNetwork: false,
      });
      if (destinationError) throw new ProviderOutboundPolicyError(destinationError);
    }
    return provider.fetch(url, { ...init, method, redirect: "manual" });
  }
  const parsed = postUrl ?? new URL(url);
  const proxyConfigured = configuredProxyFor();
  const resolveAddresses = dependencies.resolveAddresses ?? resolvePublicAddresses;
  const pinnedGet = dependencies.pinnedGet ?? pinnedHttpGet;
  const pinnedPost = dependencies.pinnedPost ?? pinnedHttpPost;
  const allowPrivate = providerAllowsPrivateNetwork(name, provider);
  let resolved: Awaited<ReturnType<typeof resolvePublicAddresses>>;
  try {
    resolved = await resolveAddresses(url, {
      context: "provider URL",
      allowPrivateNetwork: allowPrivate,
      // Clash/Surge/Mihomo fake-IP DNS (198.18.0.0/15) answers are admitted only
      // when this exact host will use the configured outbound proxy: the hostname
      // then rides the proxy as an ordinary CONNECT instead of failing as a private
      // destination or being pin-connected to the fake-IP (credit #1748). A NO_PROXY
      // match is a direct route, so it keeps the benchmark answer rejected. Image/Lab
      // fetch never passes this flag.
      allowBenchmarkAddresses: proxyConfigured && !noProxyMatches(parsed),
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
    return globalThis.fetch(url, { ...init, method, redirect: "manual" });
  }
  if (proxyConfigured && !resolved.privateNetwork) {
    warnProxyBoundaryOnce();
    return globalThis.fetch(url, { ...init, method, redirect: "manual" });
  }
  if (proxyConfigured && resolved.privateNetwork && !noProxyMatches(parsed)) {
    const hostname = normalizeProxyHostname(parsed.hostname);
    throw new Error(
      `provider URL resolves to a private-network destination; add ${hostname} to NO_PROXY before using allowPrivateNetwork with an outbound proxy`,
    );
  }
  const requestOptions = {
    headers: init.headers,
    rejectUnauthorized: true,
    context: "provider response",
  };
  const pinned = pickPinnedAddress(resolved.addresses);
  if (method === "POST") {
    return pinnedPost(url, pinned, (init as ProviderPostInit).body, init.signal ?? undefined, requestOptions);
  }
  return pinnedGet(url, pinned, init.signal ?? undefined, requestOptions);
}

export async function providerOutboundGet(
  name: string,
  provider: ProviderOutboundConfig,
  url: string,
  init: ProviderGetInit = {},
  dependencies: ProviderOutboundDependencies = {},
): Promise<Response> {
  return providerOutboundRequest(name, provider, url, "GET", init, dependencies);
}

export async function providerOutboundPost(
  name: string,
  provider: ProviderOutboundConfig,
  url: string,
  init: ProviderPostInit,
  dependencies: ProviderOutboundDependencies = {},
): Promise<Response> {
  return providerOutboundRequest(name, provider, url, "POST", init, dependencies);
}
