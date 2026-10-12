import type { OcxProviderConfig } from "../types";

export const RUNTIME_PROVIDER_FETCH = Symbol("opencodex.provider.runtime-fetch");

export interface RuntimeProviderFetch {
  providerName: string;
  origins: readonly string[];
  fetch: typeof globalThis.fetch;
}

/** Return only an explicitly injected executor matching the provider and exact destination origin. */
export function runtimeProviderFetch(
  provider: OcxProviderConfig,
  providerName: string | undefined,
): typeof globalThis.fetch | undefined {
  const runtime = (provider as OcxProviderConfig & { [RUNTIME_PROVIDER_FETCH]?: RuntimeProviderFetch })[RUNTIME_PROVIDER_FETCH];
  if (!runtime || runtime.providerName !== providerName) return undefined;
  try {
    return runtime.origins.includes(new URL(provider.baseUrl).origin) ? runtime.fetch : undefined;
  } catch {
    return undefined;
  }
}
