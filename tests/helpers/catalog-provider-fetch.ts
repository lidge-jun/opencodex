/**
 * Provider-model discovery now runs on the pinned outbound transport
 * (`providerOutboundGet`), which resolves and pins the peer address instead of
 * calling `globalThis.fetch`. Catalog tests that stub `globalThis.fetch` would
 * otherwise hit real DNS and fail with DestinationDnsResolutionError.
 *
 * `providerOutboundGet` honors a caller-owned executor via `provider.fetch`, so
 * these helpers hand the current `globalThis.fetch` back to the transport. The
 * indirection matters: the stub is read at call time, so a test may install or
 * replace its stub after building the config.
 */

/** A caller-owned executor that defers to whatever `globalThis.fetch` is installed. */
export const stubbedProviderFetch = ((input: RequestInfo | URL, init?: RequestInit) =>
  globalThis.fetch(input, init)) as typeof fetch;

/** Attach {@link stubbedProviderFetch} to every provider in a test config. */
export function withStubbedProviderFetch<T extends { providers?: Record<string, unknown> }>(config: T): T {
  for (const provider of Object.values(config.providers ?? {})) {
    if (provider && typeof provider === "object" && !("fetch" in provider)) {
      (provider as { fetch?: typeof fetch }).fetch = stubbedProviderFetch;
    }
  }
  return config;
}
