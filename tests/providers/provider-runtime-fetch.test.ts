import { expect, test } from "bun:test";
import { RUNTIME_PROVIDER_FETCH, runtimeProviderFetch } from "../../src/lib/provider-runtime-fetch";

test("runtime provider fetch is scoped to provider and exact origin", () => {
  const fetcher = async () => new Response("ok");
  const provider = { adapter: "openai-chat", baseUrl: "https://example.com", [RUNTIME_PROVIDER_FETCH]: { providerName: "p", origins: ["https://example.com"], fetch: fetcher } } as any;
  expect(runtimeProviderFetch(provider, "p")).toBe(fetcher);
  expect(runtimeProviderFetch(provider, "other")).toBeUndefined();
  expect(runtimeProviderFetch({ ...provider, baseUrl: "https://example.net" }, "p")).toBeUndefined();
});
