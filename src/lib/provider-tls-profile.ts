import type { OcxProviderConfig } from "../types";
import { redactSecretString } from "./redact";
import { runtimeProviderFetch } from "./provider-runtime-fetch";
import { resolveProxyRoute } from "./proxy-env";

export type ProviderTlsProfile = "antigravity-browser";
export type ProviderTlsProfileStatus = "disabled" | "active" | "failed";
export const ANTIGRAVITY_TLS_HOSTS = new Set(["daily-cloudcode-pa.googleapis.com", "cloudcode-pa.googleapis.com"]);
type TlsRuntime = { fetch(input: string | URL | Request, init?: RequestInit): Promise<Response> };
let status = new Map<string, ProviderTlsProfileStatus>();
let runtime: TlsRuntime | undefined;

export function isCanonicalAntigravityUrl(input: string | URL): boolean {
  try {
    const url = new URL(input);
    return url.protocol === "https:" && (url.port === "" || url.port === "443")
      && !url.username && !url.password && ANTIGRAVITY_TLS_HOSTS.has(url.hostname.toLowerCase());
  } catch {
    return false;
  }
}

export function providerTlsProfileConfigError(
  providerName: string,
  provider: Pick<OcxProviderConfig, "adapter" | "authMode" | "googleMode" | "baseUrl" | "tlsProfile">,
): string | null {
  if (provider.tlsProfile === undefined) return null;
  if (provider.tlsProfile !== "antigravity-browser") return "tlsProfile must be antigravity-browser";
  if (providerName !== "google-antigravity" || provider.adapter !== "google" || provider.authMode !== "oauth"
    || provider.googleMode !== "cloud-code-assist" || !isCanonicalAntigravityUrl(provider.baseUrl)) {
    return "tlsProfile antigravity-browser requires the canonical Google Antigravity OAuth destination";
  }
  return null;
}

export function getProviderTlsProfileStatus(name: string): ProviderTlsProfileStatus {
  return status.get(name) ?? "disabled";
}

export function resetProviderTlsProfileForTests(): void {
  status = new Map();
  runtime = undefined;
}

export function setProviderTlsRuntimeForTest(next: TlsRuntime | undefined): void {
  runtime = next;
}

function preserveTransportError(error: unknown): Error {
  const message = redactSecretString(error instanceof Error ? error.message : "provider TLS transport failed");
  const name = error instanceof Error ? error.name : "Error";
  if (name === "AbortError" || name === "TimeoutError") return new DOMException(message, name);
  const wrapped = new Error(message);
  wrapped.name = name;
  return wrapped;
}

export function providerTlsFetch(
  name: string,
  provider: Pick<OcxProviderConfig, "adapter" | "authMode" | "googleMode" | "baseUrl" | "tlsProfile">,
  fallback: typeof globalThis.fetch,
): typeof globalThis.fetch {
  if (provider.tlsProfile === undefined) {
    status.set(name, "disabled");
    return fallback;
  }
  if (providerTlsProfileConfigError(name, provider)) {
    status.set(name, "failed");
    return (async () => { throw new Error("invalid provider TLS profile"); }) as unknown as typeof globalThis.fetch;
  }
  return (async (input, init) => {
    const destination = typeof input === "string" || input instanceof URL ? input : input.url;
    if (!isCanonicalAntigravityUrl(destination)) throw new Error("provider TLS profile refused noncanonical destination");
    try {
      const configured = runtimeProviderFetch(provider as OcxProviderConfig, name);
      const mod = runtime ?? (await import("wreq-js") as unknown as TlsRuntime);
      const proxyRoute = resolveProxyRoute(new URL(destination));
      if (proxyRoute.kind === "fallback") throw new Error("provider TLS profile cannot preserve configured proxy semantics");
      const response = await (configured ?? mod.fetch)(input, {
        ...init,
        redirect: "manual",
        browser: "chrome_142",
        os: "windows",
        ...(proxyRoute.kind === "proxy" ? { proxy: proxyRoute.proxy } : {}),
      } as RequestInit & { browser: string; os: string });
      status.set(name, "active");
      return response;
    } catch (error) {
      status.set(name, "failed");
      throw preserveTransportError(error);
    }
  }) as typeof globalThis.fetch;
}
