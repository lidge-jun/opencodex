import type { OcxProviderConfig } from "../types";
import { redactSecretString } from "./redact";
import { runtimeProviderFetch } from "./provider-runtime-fetch";
import { markEgressTransparentExecutor } from "./provider-egress";
import {
  outboundProxyConfigured,
  proxyEnvPresent,
  resolveProxyRoute,
  socks5ProxyFromEnv,
  type ProxyEnvMap,
} from "./proxy-env";

export type ProviderTlsProfile = "antigravity-browser";
/**
 * `pending` means the profile is configured and valid but no request has used it yet; the
 * dashboard must not report a configured profile as `disabled` before its first send.
 */
export type ProviderTlsProfileStatus = "disabled" | "pending" | "active" | "failed";
export const ANTIGRAVITY_TLS_HOSTS = new Set([
  "daily-cloudcode-pa.googleapis.com",
  "cloudcode-pa.googleapis.com",
]);
type TlsRuntime = {
  fetch(input: string | URL | Request, init?: RequestInit): Promise<Response>;
  resolveProxyRoute?: typeof resolveProxyRoute;
  env?: ProxyEnvMap;
};
let status = new Map<string, ProviderTlsProfileStatus>();
let runtime: TlsRuntime | undefined;

export function isCanonicalAntigravityUrl(input: string | URL): boolean {
  try {
    const url = new URL(input);
    return (
      url.protocol === "https:" &&
      (url.port === "" || url.port === "443") &&
      !url.username &&
      !url.password &&
      ANTIGRAVITY_TLS_HOSTS.has(url.hostname.toLowerCase())
    );
  } catch {
    return false;
  }
}

export function providerTlsProfileConfigError(
  providerName: string,
  provider: Pick<
    OcxProviderConfig,
    "adapter" | "authMode" | "googleMode" | "baseUrl" | "tlsProfile"
  >,
): string | null {
  if (provider.tlsProfile === undefined) return null;
  if (provider.tlsProfile !== "antigravity-browser")
    return "tlsProfile must be antigravity-browser";
  if (
    providerName !== "google-antigravity" ||
    provider.adapter !== "google" ||
    provider.authMode !== "oauth" ||
    provider.googleMode !== "cloud-code-assist" ||
    !isCanonicalAntigravityUrl(provider.baseUrl)
  ) {
    return "tlsProfile antigravity-browser requires the canonical Google Antigravity OAuth destination";
  }
  return null;
}

export function getProviderTlsProfileStatus(
  name: string,
  configured?: boolean,
): ProviderTlsProfileStatus {
  const recorded = status.get(name);
  if (configured === undefined) return recorded ?? "disabled";
  if (!configured) return "disabled";
  return recorded === undefined || recorded === "disabled" ? "pending" : recorded;
}

/** The `/api/providers` fragment for a configured profile; empty when the provider has none. */
export function providerTlsProfileDiagnostic(
  name: string,
  provider: Pick<OcxProviderConfig, "tlsProfile">,
): { tlsProfile?: { profile: ProviderTlsProfile; status: ProviderTlsProfileStatus } } {
  if (provider.tlsProfile === undefined) return {};
  return { tlsProfile: { profile: provider.tlsProfile, status: getProviderTlsProfileStatus(name, true) } };
}

export function resetProviderTlsProfileForTests(): void {
  status = new Map();
  runtime = undefined;
}

export function setProviderTlsRuntimeForTest(
  next: TlsRuntime | undefined,
): void {
  runtime = next;
}

function preserveTransportError(error: unknown): Error {
  // A configured proxy URL can carry user:pass@, and the native transport may echo it. The
  // shared redactor does not mask URL userinfo, so strip it here before the message travels.
  const message = redactSecretString(
    error instanceof Error ? error.message : "provider TLS transport failed",
  ).replace(/\/\/[^/@\s]+@/g, "//<redacted>@");
  const name = error instanceof Error ? error.name : "Error";
  if (name === "AbortError" || name === "TimeoutError")
    return new DOMException(message, name);
  const wrapped = new Error(message);
  wrapped.name = name;
  return wrapped;
}

/** Proxy schemes the native TLS transport can carry for a route decided elsewhere. */
const TLS_PROXY_PROTOCOLS = new Set(["http:", "https:", "socks5:", "socks5h:"]);

function requireDirect(env: ProxyEnvMap): Record<string, never> {
  // The native transport reads HTTP_PROXY/HTTPS_PROXY/ALL_PROXY itself whenever no proxy option
  // is given, and it has no per-request "direct" switch. A direct route is therefore only
  // honoured when no proxy variable exists at all; otherwise omitting the option would send the
  // credential through the environment proxy the operator routed this request away from.
  if (outboundProxyConfigured(env)) {
    throw new Error("provider TLS profile cannot force a direct connection while a proxy environment variable is set");
  }
  return {};
}

/**
 * The proxy option expressing this send's route on the native transport, or a refusal.
 *
 * `sendWithConnectionPolicy` resolves the per-provider egress (`providers.<name>.proxy` /
 * `noProxy`) and passes it as `init.proxy`: a URL, `false` for direct, or absent when the
 * provider inherits the global environment route.
 */
function tlsProxyOption(init: RequestInit | undefined, destination: string | URL): { proxy?: string } {
  const env = runtime?.env ?? process.env;
  const decided = init !== undefined && Object.hasOwn(init, "proxy")
    ? (init as RequestInit & { proxy?: unknown }).proxy
    : undefined;
  if (typeof decided === "string") {
    let protocol: string;
    try {
      protocol = new URL(decided).protocol;
    } catch {
      throw new Error("provider TLS profile cannot preserve configured proxy semantics");
    }
    if (!TLS_PROXY_PROTOCOLS.has(protocol)) {
      throw new Error("provider TLS profile cannot preserve configured proxy semantics");
    }
    return { proxy: decided };
  }
  if (decided === false) return requireDirect(env);
  const route = (runtime?.resolveProxyRoute ?? resolveProxyRoute)(new URL(destination), env);
  if (route.kind === "fallback") {
    // `resolveProxyRoute` only classifies HTTP(S) proxies; an inherited ALL_PROXY of socks5://
    // or socks5h:// is the route the ordinary outbound path takes through socks5ProxyFromEnv().
    // Carry that same route when no HTTPS-specific variable outranks it, instead of refusing
    // every Antigravity send for an operator whose only global proxy is SOCKS.
    const socks = proxyEnvPresent("HTTPS_PROXY", env) ? undefined : socks5ProxyFromEnv(env);
    if (socks) return { proxy: socks.trim() };
    throw new Error("provider TLS profile cannot preserve configured proxy semantics");
  }
  if (route.kind === "proxy") return { proxy: route.proxy };
  return requireDirect(env);
}

export function providerTlsFetch(
  name: string,
  provider: Pick<
    OcxProviderConfig,
    "adapter" | "authMode" | "googleMode" | "baseUrl" | "tlsProfile"
  >,
  fallback: typeof globalThis.fetch,
): typeof globalThis.fetch {
  if (provider.tlsProfile === undefined) {
    status.set(name, "disabled");
    return fallback;
  }
  if (providerTlsProfileConfigError(name, provider)) {
    status.set(name, "failed");
    return (async () => {
      throw new Error("invalid provider TLS profile");
    }) as unknown as typeof globalThis.fetch;
  }
  // Transparent to provider egress: the route decided at the physical send arrives as
  // `init.proxy` and is either carried by the native transport or refused below.
  return markEgressTransparentExecutor((async (input, init) => {
    const destination =
      typeof input === "string" || input instanceof URL ? input : input.url;
    if (!isCanonicalAntigravityUrl(destination)) {
      status.set(name, "failed");
      throw new Error("provider TLS profile refused noncanonical destination");
    }
    try {
      const configured = runtimeProviderFetch(
        provider as OcxProviderConfig,
        name,
      );
      const proxyOption = tlsProxyOption(init, destination);
      const mod =
        configured === undefined
          ? runtime ?? ((await import("wreq-js")) as unknown as TlsRuntime)
          : undefined;
      const { proxy: _decidedRoute, ...rest } = (init ?? {}) as RequestInit & { proxy?: unknown };
      const response = await (configured ?? mod!.fetch)(input, {
        ...rest,
        redirect: "manual",
        browser: "chrome_142",
        os: "windows",
        ...proxyOption,
      } as RequestInit & { browser: string; os: string });
      status.set(name, "active");
      return response;
    } catch (error) {
      if (init?.signal?.aborted && error === init.signal.reason) {
        // A caller cancellation says nothing about the profile's health.
        throw error;
      }
      status.set(name, "failed");
      throw preserveTransportError(error);
    }
  }) as typeof globalThis.fetch);
}
