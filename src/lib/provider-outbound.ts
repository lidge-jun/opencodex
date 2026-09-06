import type { OcxProviderConfig } from "../types";
import {
  assessUrlDestination,
  DestinationDnsResolutionError,
  providerAllowsPrivateNetwork,
  providerDestinationConfigError,
  resolvePublicAddresses,
} from "./destination-policy";
import { pinnedHttpGet, pinnedHttpPost } from "./pinned-http";
import { effectiveProxyFor, noProxyMatches, normalizeProxyHostname, outboundProxyConfigured } from "./proxy-env";
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
  /**
   * Canonical-URL proof for the transparent fake-IP exception (Clash TUN mode
   * without proxy env). Injected so this transport core stays decoupled from
   * the registry module; production compares the final request URL against the
   * registry's own fixed discovery URL. Defaults to "not canonical" so a caller
   * that forgets the seam fails closed, never open.
   */
  isCanonicalUrl?: (name: string, url: string) => boolean;
}

export class ProviderOutboundPolicyError extends Error {
  override readonly name = "ProviderOutboundPolicyError";
}

function pickPinnedAddress(addresses: Array<{ address: string; family: number }>): { address: string; family: number } {
  return addresses.find(address => address.family === 4) ?? addresses[0]!;
}

/**
 * Registry-owned fake-IP transparency exception (Clash/Surge/Mihomo TUN mode).
 *
 * Under TUN mode the packet path intercepts the fake-IP destination itself, so a
 * canonical registry destination whose local DNS answers include Clash fake-IP
 * space (198.18.0.0/15) is reachable by pin-connecting through the TUN — no
 * outbound HTTP(S) proxy env is required. The exception is deliberately narrow:
 *
 * - hostname-only: a literal 198.18.x.x URL never reaches it (the literal gate
 *   in `resolvePublicAddresses` rejects before DNS answers are examined);
 * - canonical-URL-only: `isCanonicalUrl` must prove the FINAL request URL is
 *   the registry's own fixed discovery URL for this provider (not merely that
 *   the provider NAME matches — OAuth/forward names match any baseUrl by
 *   design, and the bearer is pinned to the registry destination independently
 *   in `buildModelsRequest`). A retargeted row or a renamed custom row sends
 *   its credential to the registry URL anyway, so the proof must be on the URL
 *   actually fetched. The check is injected so the transport core stays
 *   decoupled from the registry module;
 * - per-answer validation: benchmark and public answers may coexist. The exception
 *   does not admit loopback/RFC1918/link-local/metadata companions; those still
 *   follow the resolver's private-network policy. Benchmark admission leaves
 *   `privateNetwork` false; proxy/NO_PROXY semantics are unchanged.
 *
 * Image/Lab fetch never passes the underlying flag and is unaffected.
 */
function transparentFakeIpException(
  url: string,
  parsed: URL,
  isCanonicalUrl: (name: string, url: string) => boolean,
  name: string,
): boolean {
  if (noProxyMatches(parsed)) return false;
  return isCanonicalUrl(name, url);
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
  const proxyConfigured = outboundProxyConfigured();
  // Snapshot the scheme-matched proxy once, before the DNS await, so admission and transport
  // below reason about the same value. `null` here means "no proxy fetch would actually use",
  // even if some other proxy variable is set.
  const effectiveProxy = effectiveProxyFor(parsed);
  const allowMihomoIpv6FakeIp = effectiveProxy !== null && !noProxyMatches(parsed);
  const resolveAddresses = dependencies.resolveAddresses ?? resolvePublicAddresses;
  const pinnedGet = dependencies.pinnedGet ?? pinnedHttpGet;
  const pinnedPost = dependencies.pinnedPost ?? pinnedHttpPost;
  const isCanonicalUrl = dependencies.isCanonicalUrl ?? (() => false);
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
      //
      // TUN-mode transparency: with no proxy env, Clash/Surge/Mihomo TUN still
      // intercepts the fake-IP destination itself, so the REGISTRY's own fixed
      // discovery URL stays reachable by pin-connecting through the TUN. The
      // proof is on the final request URL — not the provider name — because an
      // OAuth/forward name matches any baseUrl by design while the bearer is
      // pinned to the registry destination independently.
      allowBenchmarkAddresses: (proxyConfigured && !noProxyMatches(parsed))
        || transparentFakeIpException(url, parsed, isCanonicalUrl, name),
      // Mihomo IPv6 fake-IP (fdfe:dcba:9876::/48) answers are admitted on a stricter gate
      // than the benchmark range: the proxy must be the one fetch will use for this URL's
      // scheme, and the request below is then bound to it explicitly (#3462). A ULA answer
      // is otherwise indistinguishable from a real private host, so proxy presence alone
      // is not enough.
      allowMihomoIpv6FakeIp,
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
    // When the Mihomo exception could have admitted an answer, pin the transport to the
    // proxy the admission assumed instead of letting fetch re-infer it from the environment.
    const proxy = allowMihomoIpv6FakeIp ? effectiveProxy : undefined;
    return globalThis.fetch(url, { ...init, method, redirect: "manual", ...(proxy ? { proxy } : {}) });
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
