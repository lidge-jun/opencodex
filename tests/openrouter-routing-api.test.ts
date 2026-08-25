import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleManagementAPI } from "../src/server/management-api";
import { resetOpenRouterEndpointCacheForTests } from "../src/providers/openrouter-endpoints";
import type { OcxConfig, OcxProviderConfig } from "../src/types";

const savedHome = process.env.OPENCODEX_HOME;
let tempHome: string | null = null;

afterEach(() => {
  resetOpenRouterEndpointCacheForTests();
  if (savedHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = savedHome;
  if (tempHome) rmSync(tempHome, { recursive: true, force: true });
  tempHome = null;
});

function config(provider: OcxProviderConfig): OcxConfig {
  tempHome = mkdtempSync(join(tmpdir(), "ocx-openrouter-api-"));
  process.env.OPENCODEX_HOME = tempHome;
  return { port: 10100, defaultProvider: "openrouter", providers: { openrouter: provider } } as OcxConfig;
}

async function management(current: OcxConfig, path: string, init?: RequestInit): Promise<Response> {
  const headers = new Headers(init?.headers);
  headers.set("Host", "localhost");
  const request = new Request(`http://localhost${path}`, { ...init, headers });
  const response = await handleManagementAPI(request, new URL(request.url), current);
  expect(response).not.toBeNull();
  return response!;
}

describe("OpenRouter model routing management API", () => {
  test("discovers exact provider tags for one model", async () => {
    const current = config({
      adapter: "openai-chat",
      baseUrl: "https://openrouter.ai/api/v1",
      apiKey: "test-api-key",
      fetch: async () => Response.json({
        data: { id: "deepseek/deepseek-r1", endpoints: [{ tag: "deepinfra/turbo", provider_name: "DeepInfra" }] },
      }),
    } as OcxProviderConfig);
    const response = await management(current, "/api/openrouter/model-providers?provider=openrouter&model=deepseek%2Fdeepseek-r1");
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      provider: "openrouter",
      model: "deepseek/deepseek-r1",
      routing: { source: "none" },
      endpoints: [{ tag: "deepinfra/turbo", providerName: "DeepInfra" }],
    });
  });

  test("patches one model override and null restores inheritance", async () => {
    const current = config({
      adapter: "openai-chat",
      baseUrl: "https://openrouter.ai/api/v1",
      apiKey: "test-key",
      openRouterRouting: { order: ["openai"] },
    });
    const patch = async (value: unknown) => management(current, "/api/providers?name=openrouter", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ modelOpenRouterRouting: value }),
    });
    expect((await patch({ "deepseek/deepseek-r1": { only: ["deepinfra/turbo"], allowFallbacks: false } })).status).toBe(200);
    expect(current.providers.openrouter?.modelOpenRouterRouting).toEqual({
      "deepseek/deepseek-r1": { only: ["deepinfra/turbo"], allowFallbacks: false },
    });
    expect((await patch({ "deepseek/deepseek-r1": null })).status).toBe(200);
    expect(current.providers.openrouter?.modelOpenRouterRouting).toBeUndefined();
  });

  test("rejects invalid model routing through the canonical schema before persistence", async () => {
    const current = config({
      adapter: "openai-chat",
      baseUrl: "https://openrouter.ai/api/v1",
      apiKey: "test-key",
      modelOpenRouterRouting: { "author/existing": { order: ["provider/live"] } },
    });
    const original = structuredClone(current.providers.openrouter?.modelOpenRouterRouting);
    const invalid = [
      { "author/model": { order: "provider/live" } },
      { "author/model": { only: [] } },
      { "author/model": { allowFallbacks: "yes" } },
      { "author/model": { allow_fallbacks: false } },
      { "author/model": { order: ["provider/live", "provider/live"] } },
    ];

    for (const modelOpenRouterRouting of invalid) {
      const response = await management(current, "/api/providers?name=openrouter", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ modelOpenRouterRouting }),
      });
      expect(response.status).toBe(400);
      expect(current.providers.openrouter?.modelOpenRouterRouting).toEqual(original);
    }
  });

  test("rejects discovery for a noncanonical OpenRouter-shaped provider", async () => {
    const current = config({ adapter: "openai-chat", baseUrl: "https://example.test/v1", apiKey: "test-key" });
    const response = await management(current, "/api/openrouter/model-providers?provider=openrouter&model=deepseek%2Fdeepseek-r1");
    expect(response.status).toBe(400);
  });

  test("reports ordinary OpenRouter API-key rejection without reflecting upstream details", async () => {
    const current = config({
      adapter: "openai-chat",
      baseUrl: "https://openrouter.ai/api/v1",
      apiKey: "test-api-key",
      fetch: async () => Response.json({ error: "private upstream detail" }, { status: 401 }),
    } as OcxProviderConfig);
    const response = await management(
      current,
      "/api/openrouter/model-providers?provider=openrouter&model=deepseek%2Fdeepseek-r1",
    );

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({
      error: "OpenRouter rejected the configured API key for endpoint discovery",
      code: "openrouter_authorization_failed",
    });
  });

  test("returns a bounded busy response when unique discovery capacity is exhausted", async () => {
    let release!: () => void;
    let allFetchesStarted!: () => void;
    let fetches = 0;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const fetchesStarted = new Promise<void>(resolve => { allFetchesStarted = resolve; });
    const current = config({
      adapter: "openai-chat",
      baseUrl: "https://openrouter.ai/api/v1",
      apiKey: "test-key",
      fetch: async (input: string | URL | Request) => {
        fetches += 1;
        if (fetches === 8) allFetchesStarted();
        await gate;
        const parts = new URL(String(input)).pathname.split("/");
        return Response.json({
          data: {
            id: `${decodeURIComponent(parts.at(-3)!)}/${decodeURIComponent(parts.at(-2)!)}`,
            endpoints: [],
          },
        });
      },
    } as OcxProviderConfig);
    const active = Array.from({ length: 8 }, (_, index) => management(
      current,
      `/api/openrouter/model-providers?provider=openrouter&model=author%2Fmodel-${index}`,
    ));
    await fetchesStarted;
    expect(fetches).toBe(8);

    const overflow = await management(
      current,
      "/api/openrouter/model-providers?provider=openrouter&model=author%2Foverflow",
    );
    expect(overflow.status).toBe(429);
    expect(await overflow.json()).toEqual({
      error: "OpenRouter endpoint discovery is busy",
      code: "openrouter_busy",
    });

    release();
    await expect(Promise.all(active)).resolves.toHaveLength(8);
  });
});
