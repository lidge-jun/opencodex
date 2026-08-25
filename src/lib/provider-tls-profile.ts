import type { OcxProviderConfig, ProviderTlsProfile } from "../types";
import { resolvePublicAddresses } from "./destination-policy";
import { registerOptionalShutdownHook } from "./optional-shutdown-hooks";
import { proxyForUrl } from "./proxy-env";
import { redactErrorMessage } from "./redact";

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
  resolveDestination?: typeof resolvePublicAddresses;
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

const SAFE_NATIVE_ERROR_NAMES = new Set(["AbortError", "TimeoutError"]);
const SAFE_NATIVE_ERROR_CODES = new Set([
  "ABORT_ERR", "ECONNREFUSED", "ECONNRESET", "EAI_AGAIN", "ENETUNREACH", "ENOTFOUND",
  "ETIMEDOUT", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_SOCKET",
]);

function safeProviderTlsError(error: unknown): Error {
  const raw = error instanceof Error ? error.message : String(error);
  const safe = new Error(redactErrorMessage(raw));
  if (!error || typeof error !== "object") return safe;
  const native = error as { name?: unknown; code?: unknown };
  if (typeof native.name === "string" && SAFE_NATIVE_ERROR_NAMES.has(native.name)) {
    safe.name = native.name;
  }
  if (typeof native.code === "string" && SAFE_NATIVE_ERROR_CODES.has(native.code)) {
    Object.defineProperty(safe, "code", {
      configurable: true,
      enumerable: false,
      value: native.code,
      writable: false,
    });
  }
  return safe;
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
    const proxy = proxyForUrl(url);
    // A direct profiled request must pass the same public-destination gate as the
    // ordinary provider executor before wreq can send its bearer-bearing request.
    // Proxied requests deliberately leave peer selection to the configured proxy,
    // matching providerOutbound's proxy boundary (and its inability to pin a peer).
    if (!proxy) {
      await (runtime.resolveDestination ?? resolvePublicAddresses)(String(url), {
        context: "Antigravity profile URL",
        allowPrivateNetwork: false,
      });
    }
    const initialized = await getTransport(proxy);
    if (!initialized) {
      setStatus(providerName, "fallback");
      warnFallbackOnce();
      return bunFetch(input, { ...init, redirect: "manual" });
    }
    setStatus(providerName, "active");
    const wreqInit = {
      ...init,
      transport: initialized.transport,
      disableDefaultHeaders: true,
      cookieMode: "ephemeral" as const,
      redirect: "manual" as const,
    };
    try {
      return await initialized.module.fetch(input, wreqInit) as Response;
    } catch (error) {
      // Native errors are post-dispatch failures. Redact at this boundary and
      // never replay through Bun, since generation may already have started.
      throw safeProviderTlsError(error);
    }
  }) as typeof globalThis.fetch;
}

export function setProviderTlsRuntimeForTest(next: ProviderTlsRuntimeForTest | undefined): void {
  if (next === undefined) {
    runtime = defaultRuntime;
    return;
  }
  // Test callers normally replace only the native module. Keep those tests
  // deterministic in offline sandboxes while allowing explicit DNS policy
  // regressions to inject a rejecting resolver.
  runtime = {
    ...defaultRuntime,
    resolveDestination: async (url: string) => ({
      hostname: new URL(url).hostname,
      addresses: [{ address: "142.250.1.1", family: 4 }],
      privateNetwork: false,
    }),
    ...next,
  };
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
