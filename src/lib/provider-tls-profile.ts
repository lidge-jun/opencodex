import type { OcxProviderConfig, ProviderTlsProfile } from "../types";
import { registerOptionalShutdownHook } from "./optional-shutdown-hooks";
import { proxyForUrl } from "./proxy-env";

export const ANTIGRAVITY_TLS_HOSTS = new Set([
  "daily-cloudcode-pa.googleapis.com",
  "cloudcode-pa.googleapis.com",
]);

export type ProviderTlsProfileStatus = "disabled" | "active" | "fallback";

interface WreqTransport {
  close(): Promise<void>;
}

interface WreqModule {
  createTransport(options: {
    browser: "chrome_142";
    os: "windows" | "macos" | "linux";
    proxy?: string;
  }): Promise<WreqTransport>;
  fetch(input: string | URL | Request, init?: Record<string, unknown>): Promise<unknown>;
}

interface InitializedTransport {
  module: WreqModule;
  transport: WreqTransport;
}

export interface ProviderTlsRuntimeForTest {
  importWreq: () => Promise<WreqModule>;
}

const defaultRuntime: ProviderTlsRuntimeForTest = {
  importWreq: async () => await import("wreq-js") as unknown as WreqModule,
};

let runtime = defaultRuntime;
const statusByProvider = new Map<string, ProviderTlsProfileStatus>();
const transports = new Map<string, Promise<InitializedTransport | undefined>>();
let shutdownDetach: (() => void) | undefined;
let fallbackWarned = false;

function setStatus(providerName: string, status: ProviderTlsProfileStatus): void {
  statusByProvider.set(providerName, status);
}

function warnFallbackOnce(): void {
  if (fallbackWarned) return;
  fallbackWarned = true;
  console.warn("[opencodex] Antigravity TLS profile requested → fallback to Bun fetch; native transport initialization failed");
}

function emulationOs(): "windows" | "macos" | "linux" {
  if (process.platform === "win32") return "windows";
  if (process.platform === "darwin") return "macos";
  if (process.platform === "linux") return "linux";
  throw new Error("unsupported host operating system for Antigravity TLS profile");
}

function profileIsSupported(providerName: string, provider: Pick<OcxProviderConfig, "adapter" | "authMode" | "googleMode" | "baseUrl" | "tlsProfile">): boolean {
  return providerName === "google-antigravity"
    && provider.adapter === "google"
    && provider.authMode === "oauth"
    && provider.googleMode === "cloud-code-assist"
    && isCanonicalAntigravityUrl(provider.baseUrl)
    && provider.tlsProfile === "antigravity-browser";
}

export function providerTlsProfileConfigError(
  providerName: string,
  provider: Pick<OcxProviderConfig, "adapter" | "authMode" | "googleMode" | "baseUrl" | "tlsProfile">,
): string | null {
  if (provider.tlsProfile === undefined) return null;
  if (provider.tlsProfile !== "antigravity-browser") {
    return "tlsProfile must be antigravity-browser";
  }
  if (providerName !== "google-antigravity") return "tlsProfile antigravity-browser is valid only for google-antigravity";
  if (provider.adapter !== "google" || provider.authMode !== "oauth") {
    return "tlsProfile antigravity-browser requires Google OAuth authentication";
  }
  if (provider.googleMode !== "cloud-code-assist") {
    return "tlsProfile antigravity-browser requires Google Cloud Code Assist mode";
  }
  if (!isCanonicalAntigravityUrl(provider.baseUrl)) {
    return "tlsProfile antigravity-browser requires a canonical Antigravity HTTPS destination";
  }
  return null;
}

export function isCanonicalAntigravityUrl(input: string | URL): boolean {
  try {
    const url = new URL(input);
    return url.protocol === "https:"
      && (url.port === "" || url.port === "443")
      && url.username === ""
      && url.password === ""
      && ANTIGRAVITY_TLS_HOSTS.has(url.hostname.toLowerCase());
  } catch {
    return false;
  }
}

export function getProviderTlsProfileStatus(providerName: string): ProviderTlsProfileStatus {
  return statusByProvider.get(providerName) ?? "disabled";
}

function registerShutdownHook(): void {
  if (shutdownDetach) return;
  shutdownDetach = registerOptionalShutdownHook("provider-tls-profile", () => {
    const pending = [...transports.values()];
    transports.clear();
    shutdownDetach = undefined;
    for (const transport of pending) {
      void transport.then(value => value?.transport.close()).catch(() => undefined);
    }
  });
}

function transportKey(proxy: string | undefined): string {
  return `${process.platform}:${proxy ?? "direct"}`;
}

async function getTransport(proxy: string | undefined): Promise<InitializedTransport | undefined> {
  const key = transportKey(proxy);
  const existing = transports.get(key);
  if (existing) return existing;
  const pending = (async () => {
    let transport: WreqTransport | undefined;
    try {
      const module = await runtime.importWreq();
      transport = await module.createTransport({
        browser: "chrome_142",
        os: emulationOs(),
        ...(proxy ? { proxy } : {}),
      });
      registerShutdownHook();
      return { module, transport };
    } catch {
      if (transport) await transport.close().catch(() => undefined);
      return undefined;
    }
  })();
  transports.set(key, pending);
  return pending;
}

export function providerTlsFetch(
  providerName: string,
  provider: Pick<OcxProviderConfig, "adapter" | "authMode" | "googleMode" | "baseUrl" | "tlsProfile">,
  bunFetch: typeof globalThis.fetch,
): typeof globalThis.fetch {
  if (provider.tlsProfile === undefined) {
    setStatus(providerName, "disabled");
    return bunFetch;
  }
  if (!profileIsSupported(providerName, provider)) {
    setStatus(providerName, "fallback");
    warnFallbackOnce();
    return bunFetch;
  }
  return (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" || input instanceof URL ? input : input.url;
    if (!isCanonicalAntigravityUrl(url)) return bunFetch(input, init);
    const initialized = await getTransport(proxyForUrl(url));
    if (!initialized) {
      setStatus(providerName, "fallback");
      warnFallbackOnce();
      return bunFetch(input, init);
    }
    setStatus(providerName, "active");
    const wreqInit = {
      ...init,
      transport: initialized.transport,
      disableDefaultHeaders: true,
      cookieMode: "ephemeral" as const,
      redirect: "manual" as const,
    };
    return await initialized.module.fetch(input, wreqInit) as Response;
  }) as typeof globalThis.fetch;
}

export function setProviderTlsRuntimeForTest(next: ProviderTlsRuntimeForTest | undefined): void {
  runtime = next ?? defaultRuntime;
}

export function resetProviderTlsProfileForTests(): void {
  for (const pending of transports.values()) void pending.then(value => value?.transport.close()).catch(() => undefined);
  transports.clear();
  shutdownDetach?.();
  shutdownDetach = undefined;
  statusByProvider.clear();
  fallbackWarned = false;
  runtime = defaultRuntime;
}

export type { ProviderTlsProfile };
