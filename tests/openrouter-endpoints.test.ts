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

  test("bounds every external string before returning or caching the DTO", () => {
    const oversized = "x".repeat(257);
    const longParameter = "p".repeat(129);
    expect(parseOpenRouterModelEndpoints({
      data: {
        id: "author/model",
        endpoints: [{
          tag: "provider/live",
          provider_name: "Provider",
          name: oversized,
          context_length: Number.MAX_VALUE,
          max_completion_tokens: -1,
          supported_parameters: ["tools", longParameter],
          pricing: { prompt: "1".repeat(129), completion: " 0.000002 " },
        }],
      },
    }, "author/model")).toEqual([{
      tag: "provider/live",
      providerName: "Provider",
      supportedParameters: ["tools"],
      pricing: { completion: "0.000002" },
    }]);

    expect(parseOpenRouterModelEndpoints({
      data: { id: "author/model", endpoints: [{ tag: oversized, provider_name: "Provider" }] },
    }, "author/model")).toEqual([]);
  });

  test("rejects dot segments and oversized model path components before outbound fetch", async () => {
    let fetches = 0;
    const provider = {
      adapter: "openai-chat",
      baseUrl: "https://openrouter.ai/api/v1",
      fetch: async () => {
        fetches += 1;
        return Response.json(responseBody);
      },
    } as OcxProviderConfig;

    for (const modelId of ["../model", "author/..", `${"a".repeat(257)}/model`, `author/${"m".repeat(257)}`]) {
      await expect(listOpenRouterModelEndpoints("openrouter", provider, modelId, "test-token"))
        .rejects.toMatchObject({ code: "invalid_model", status: 400 });
    }
    expect(fetches).toBe(0);
  });

  test("same-key callers share one flight and do not call it a completed cache hit", async () => {
    let release!: () => void;
    let started!: () => void;
    let fetches = 0;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const fetchStarted = new Promise<void>(resolve => { started = resolve; });
    const provider = {
      adapter: "openai-chat",
      baseUrl: "https://openrouter.ai/api/v1",
      fetch: async () => {
        fetches += 1;
        started();
        await gate;
        return Response.json({ data: { id: "author/model", endpoints: [] } });
      },
    } as OcxProviderConfig;

    const first = listOpenRouterModelEndpoints("openrouter", provider, "author/model", "test-token");
    await fetchStarted;
    const joined = listOpenRouterModelEndpoints("openrouter", provider, "author/model", "test-token");
    release();

    expect(await Promise.all([first, joined])).toEqual([
      expect.objectContaining({ cached: false }),
      expect.objectContaining({ cached: false }),
    ]);
    expect(fetches).toBe(1);
    await expect(listOpenRouterModelEndpoints("openrouter", provider, "author/model", "test-token"))
      .resolves.toMatchObject({ cached: true });
  });

  test("maps authorization failures without returning the upstream body", async () => {
    const provider = {
      adapter: "openai-chat",
      baseUrl: "https://openrouter.ai/api/v1",
      fetch: async () => Response.json({ error: { message: "secret upstream detail" } }, { status: 403 }),
    } as OcxProviderConfig;
    await expect(listOpenRouterModelEndpoints("openrouter", provider, "deepseek/deepseek-r1", "test-token"))
      .rejects.toMatchObject({ code: "authorization_failed", status: 403 });
  });

  test("bounds unique discovery flights while still allowing existing flights to settle", async () => {
    let release!: () => void;
    let fetches = 0;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const provider = {
      adapter: "openai-chat",
      baseUrl: "https://openrouter.ai/api/v1",
      fetch: async (input: string | URL | Request) => {
        fetches += 1;
        await gate;
        const parts = new URL(String(input)).pathname.split("/");
        return Response.json({
          data: {
            id: `${decodeURIComponent(parts.at(-3)!)}/${decodeURIComponent(parts.at(-2)!)}`,
            endpoints: [],
          },
        });
      },
    } as OcxProviderConfig;
    const active = Array.from({ length: 8 }, (_, index) => (
      listOpenRouterModelEndpoints("openrouter", provider, `author/model-${index}`, "test-token")
    ));
    await Promise.resolve();
    const joined = listOpenRouterModelEndpoints("openrouter", provider, "author/model-0", "test-token");

    await expect(listOpenRouterModelEndpoints("openrouter", provider, "author/overflow", "test-token"))
      .rejects.toMatchObject({ code: "busy", status: 429 });

    release();
    await expect(Promise.all([...active, joined])).resolves.toHaveLength(9);
    expect(fetches).toBe(8);
    await expect(listOpenRouterModelEndpoints("openrouter", provider, "author/after", "test-token"))
      .resolves.toMatchObject({ cached: false, endpoints: [] });
  });
});
