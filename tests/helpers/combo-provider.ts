import type { ProviderAdapter } from "../../src/adapters/base";
import type { OcxProviderConfig } from "../../src/types";

/** Keep the fixture upstream behind the same executor used by real provider sends. */
export function comboProviderFactory(
  getFetchResponse: () => ProviderAdapter["fetchResponse"],
) {
  return function provider(
    adapter: string,
    url: string,
    apiKey: string,
    extra: Partial<OcxProviderConfig> = {},
  ): OcxProviderConfig {
    return {
      adapter,
      baseUrl: url,
      allowPrivateNetwork: url.includes("127.0.0.1"),
      authMode: "key",
      apiKey,
      ...(adapter === "test-response" ? { fetch: (async (input, init) => {
        const customFetchResponse = getFetchResponse();
        if (!customFetchResponse) throw new Error("custom fetchResponse not installed");
        return customFetchResponse({ url: String(input), method: init?.method ?? "POST",
          headers: Object.fromEntries(new Headers(init?.headers)), body: String(init?.body ?? "") },
        { abortSignal: init?.signal ?? undefined });
      }) as typeof globalThis.fetch } : {}),
      ...extra,
    };
  };
}
