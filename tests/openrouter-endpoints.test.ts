import { afterEach, describe, expect, test } from "bun:test";
import {
  listOpenRouterModelEndpoints,
  OpenRouterEndpointsError,
  parseOpenRouterModelEndpoints,
  resetOpenRouterEndpointCacheForTests,
} from "../src/providers/openrouter-endpoints";
import type { OcxProviderConfig } from "../src/types";

afterEach(() => resetOpenRouterEndpointCacheForTests());

const responseBody = {
  data: {
    id: "deepseek/deepseek-r1",
    endpoints: [
      {
        tag: "deepinfra/turbo",
        provider_name: "DeepInfra",
        name: "DeepInfra Turbo",
        context_length: 131072,
        max_completion_tokens: 32768,
        supports_implicit_caching: true,
        supported_parameters: ["tools", "reasoning"],
        pricing: { prompt: "0.000001", completion: "0.000002" },
      },
      { tag: "deepinfra/turbo", provider_name: "duplicate" },
      { tag: "", provider_name: "invalid" },
    ],
  },
};

describe("OpenRouter model endpoint discovery", () => {
  test("parses exact routing tags and rejects a mismatched model envelope", () => {
    expect(parseOpenRouterModelEndpoints(responseBody, "deepseek/deepseek-r1")).toEqual([{
      tag: "deepinfra/turbo",
      providerName: "DeepInfra",
      name: "DeepInfra Turbo",
      contextLength: 131072,
      maxCompletionTokens: 32768,
      supportsImplicitCaching: true,
      supportedParameters: ["tools", "reasoning"],
      pricing: { prompt: "0.000001", completion: "0.000002" },
    }]);
    expect(() => parseOpenRouterModelEndpoints(responseBody, "other/model")).toThrow(OpenRouterEndpointsError);
  });

  test("uses the canonical encoded model URL and caches successful results", async () => {
    const urls: string[] = [];
    const provider = {
      adapter: "openai-chat",
      baseUrl: "https://openrouter.ai/api/v1",
      fetch: async (url: string | URL | Request) => {
        urls.push(String(url));
        return Response.json(responseBody);
      },
    } as OcxProviderConfig;
    const first = await listOpenRouterModelEndpoints("openrouter", provider, "deepseek/deepseek-r1", "test-token");
    const second = await listOpenRouterModelEndpoints("openrouter", provider, "deepseek/deepseek-r1", "test-token");
    expect(first.cached).toBe(false);
    expect(second.cached).toBe(true);
    expect(urls).toEqual(["https://openrouter.ai/api/v1/models/deepseek/deepseek-r1/endpoints"]);
  });

  test("maps authorization failures without returning the upstream body", async () => {
    const provider = {
      adapter: "openai-chat",
      baseUrl: "https://openrouter.ai/api/v1",
      fetch: async () => Response.json({ error: { message: "secret upstream detail" } }, { status: 403 }),
    } as OcxProviderConfig;
    await expect(listOpenRouterModelEndpoints("openrouter", provider, "deepseek/deepseek-r1", "test-token"))
      .rejects.toMatchObject({ code: "management_key_required", status: 403 });
  });
});
