import { describe, expect, test } from "bun:test";
import { createGoogleAdapter } from "../src/adapters/google";
import { compileGoogleWireBody } from "../src/adapters/google-wire-compiler";
import { parseRequest } from "../src/responses/parser";
import { googleProviderOptionsRouteError } from "../src/responses/google-provider-options";
import { handleResponses } from "../src/server/responses";
import type { OcxParsedRequest } from "../src/types";
import type { OcxConfig } from "../src/types";

const base = {
  model: "gemini-3.5-flash",
  input: "hello",
  provider_options: {
    google: {
      thinking_budget: -1,
      include_thoughts: false,
      safety_settings: [{
        category: "HARM_CATEGORY_HATE_SPEECH",
        threshold: "BLOCK_LOW_AND_ABOVE",
      }],
      cached_content: "cachedContents/cache-1",
    },
  },
};

describe("Google provider options", () => {
  const requestBody = JSON.stringify(base);
  const providerConfig = (providerName: string, provider: Record<string, unknown>): OcxConfig => ({
    defaultProvider: providerName,
    providers: { [providerName]: provider },
  } as OcxConfig);

  test("rejects CCA and non-Google routes before any upstream fetch", async () => {
    const originalFetch = globalThis.fetch;
    let fetches = 0;
    globalThis.fetch = (async () => {
      fetches += 1;
      return Response.json({ candidates: [{ content: { parts: [{ text: "unexpected" }] } }] });
    }) as typeof fetch;
    try {
      for (const [providerName, provider] of [
        ["cca", { adapter: "google", googleMode: "cloud-code-assist", baseUrl: "https://daily-cloudcode-pa.googleapis.com", apiKey: "key" }],
        ["other", { adapter: "openai-chat", baseUrl: "https://other.example", apiKey: "key" }],
      ] as const) {
        const response = await handleResponses(new Request("http://localhost/v1/responses", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: requestBody,
        }), providerConfig(providerName, provider), { model: "", provider: "" });
        expect(response.status).toBe(400);
      }
      for (const [providerName, provider, body] of [
        [
          "google-ai-studio",
          { adapter: "google", googleMode: "ai-studio", baseUrl: "https://generativelanguage.googleapis.com", apiKey: "key" },
          { ...base, provider_options: { google: { cached_content: "projects/project/locations/global/cachedContents/cache-1" } } },
        ],
        [
          "google-vertex",
          { adapter: "google", googleMode: "vertex", baseUrl: "https://aiplatform.googleapis.com", apiKey: "key" },
          { ...base, provider_options: { google: { cached_content: "cachedContents/cache-1" } } },
        ],
      ] as const) {
        const response = await handleResponses(new Request("http://localhost/v1/responses", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }), providerConfig(providerName, provider), { model: "", provider: "" });
        expect(response.status).toBe(400);
      }
      expect(fetches).toBe(0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("rechecks the gate when 429 key rotation changes the final adapter", async () => {
    const originalFetch = globalThis.fetch;
    let fetches = 0;
    const provider = {
      adapter: "google",
      googleMode: "ai-studio",
      baseUrl: "https://generativelanguage.googleapis.com",
      apiKey: "key-a",
      apiKeyPool: [{ id: "a", key: "key-a" }, { id: "b", key: "key-b" }],
      modelAdapters: { "gemini-3.5-flash": "google" },
    } as Record<string, unknown>;
    globalThis.fetch = (async () => {
      fetches += 1;
      if (fetches === 1) {
        (provider.modelAdapters as Record<string, string>)["gemini-3.5-flash"] = "openai-chat";
        return new Response(JSON.stringify({ error: { message: "rate limited" } }), { status: 429 });
      }
      return Response.json({ candidates: [{ content: { parts: [{ text: "bypass" }] } }] });
    }) as typeof fetch;
    try {
      const response = await handleResponses(new Request("http://localhost/v1/responses", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: requestBody,
      }), providerConfig("google", provider), { model: "", provider: "" });
      expect(response.status).toBe(400);
      expect(fetches).toBe(1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("maps strict snake-case options to typed camel-case fields", () => {
    const parsed = parseRequest(base);
    expect(parsed.options.providerOptions?.google).toEqual({
      thinkingBudget: -1,
      includeThoughts: false,
      safetySettings: [{
        category: "HARM_CATEGORY_HATE_SPEECH",
        threshold: "BLOCK_LOW_AND_ABOVE",
      }],
      cachedContent: "cachedContents/cache-1",
    });
  });

  test("rejects unknown nested provider keys", () => {
    expect(() => parseRequest({
      ...base,
      provider_options: { google: { future: true } },
    })).toThrow();
    expect(() => parseRequest({
      ...base,
      provider_options: { future: true },
    })).toThrow();
    expect(() => parseRequest({
      ...base,
      provider_options: {
        google: {
          safety_settings: [{
            category: "HARM_CATEGORY_HATE_SPEECH",
            threshold: "BLOCK_LOW_AND_ABOVE",
            future: true,
          }],
        },
      },
    })).toThrow();
  });

  test("rejects invalid budgets, safety settings, and cache names", () => {
    for (const thinking_budget of [Number.MAX_SAFE_INTEGER + 1, 1.5, -2]) {
      expect(() => parseRequest({ ...base, provider_options: { google: { thinking_budget } } })).toThrow();
    }
    expect(() => parseRequest({
      ...base,
      provider_options: { google: {
        safety_settings: [
          { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_LOW_AND_ABOVE" },
          { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_NONE" },
        ],
      } },
    })).toThrow();
    expect(() => parseRequest({
      ...base,
      provider_options: { google: { cached_content: "projects/p/locations/l/cachedContents/c?x=1" } },
    })).toThrow();
  });

  test("compiler keeps only validated Google safety/cache fields", () => {
    expect(compileGoogleWireBody({
      safetySettings: [{ category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_NONE", future: true }],
      cachedContent: "cachedContents/cache-1",
      futureTopLevel: true,
    }).body).toEqual({
      safetySettings: [{ category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_NONE" }],
      cachedContent: "cachedContents/cache-1",
    });
  });

  test("explicit budget replaces level and includeThoughts augments it", async () => {
    const adapter = createGoogleAdapter({
      adapter: "google",
      baseUrl: "https://generativelanguage.googleapis.com",
      apiKey: "test-key",
      reasoningEfforts: ["low", "high"],
      reasoningEffortMap: { low: "low", high: "high" },
    });
    const request = await adapter.buildRequest({
      modelId: "gemini-3.5-flash",
      stream: false,
      options: {
        reasoning: "high",
        providerOptions: { google: { thinkingBudget: 1234, includeThoughts: false } },
      },
      context: { messages: [{ role: "user", content: "hello" }] },
    } as OcxParsedRequest);
    expect(JSON.parse(request.body).generationConfig.thinkingConfig).toEqual({
      thinkingBudget: 1234,
      includeThoughts: false,
    });
  });

  test("validated safety and cache options reach AI Studio and Vertex wires", async () => {
    for (const googleMode of ["ai-studio", "vertex"] as const) {
      const cachedContent = googleMode === "vertex"
        ? "projects/project/locations/global/cachedContents/cache-1"
        : "cachedContents/cache-1";
      const adapter = createGoogleAdapter({
        adapter: "google",
        googleMode,
        baseUrl: googleMode === "vertex" ? "https://aiplatform.googleapis.com" : "https://generativelanguage.googleapis.com",
        apiKey: "test-key",
        ...(googleMode === "vertex" ? { project: "project", location: "global" } : {}),
      });
      const request = await adapter.buildRequest({
        modelId: "gemini-3.5-flash",
        stream: false,
        options: { providerOptions: { google: {
          safetySettings: [{ category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_NONE" }],
          cachedContent,
        } } },
        context: { messages: [{ role: "user", content: "hello" }] },
      } as OcxParsedRequest);
      const body = JSON.parse(request.body);
      expect(body.safetySettings).toEqual([{ category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_NONE" }]);
      expect(body.cachedContent).toBe(cachedContent);
    }
  });

  test("accepts each syntactically valid cache resource on its matching Google route", () => {
    expect(googleProviderOptionsRouteError(parseRequest({
      ...base,
      provider_options: { google: { cached_content: "cachedContents/cache-1" } },
    }), {
      providerName: "google",
      provider: { adapter: "google", googleMode: "ai-studio" },
      adapterName: "google",
    })).toBeUndefined();

    expect(googleProviderOptionsRouteError(parseRequest({
      ...base,
      provider_options: { google: { cached_content: "projects/project/locations/global/cachedContents/cache-1" } },
    }), {
      providerName: "google-vertex",
      provider: { adapter: "google", googleMode: "vertex" },
      adapterName: "google",
    })).toBeUndefined();
  });

  test("rejects a cache resource belonging to the other Google route", () => {
    const aiRouteError = googleProviderOptionsRouteError(parseRequest({
      ...base,
      provider_options: { google: { cached_content: "projects/project/locations/global/cachedContents/cache-1" } },
    }), {
      providerName: "google",
      provider: { adapter: "google", googleMode: "ai-studio" },
      adapterName: "google",
    });
    expect(aiRouteError).toContain("AI Studio");
    expect(aiRouteError).toContain("cachedContents/{id}");

    const vertexRouteError = googleProviderOptionsRouteError(parseRequest({
      ...base,
      provider_options: { google: { cached_content: "cachedContents/cache-1" } },
    }), {
      providerName: "google-vertex",
      provider: { adapter: "google", googleMode: "vertex" },
      adapterName: "google",
    });
    expect(vertexRouteError).toContain("Vertex");
    expect(vertexRouteError).toContain("projects/{project}/locations/{location}/cachedContents/{id}");
  });

  test("accepts only AI Studio and Vertex Google routes", () => {
    const parsed = parseRequest(base);
    expect(googleProviderOptionsRouteError(parsed, {
      providerName: "google",
      provider: { adapter: "google" },
      adapterName: "google",
    })).toBeUndefined();
    expect(googleProviderOptionsRouteError(parsed, {
      providerName: "google-antigravity",
      provider: { adapter: "google", googleMode: "cloud-code-assist" },
      adapterName: "google",
    })).toContain("Cloud Code Assist");
    expect(googleProviderOptionsRouteError(parsed, {
      providerName: "other",
      provider: { adapter: "openai-chat" },
      adapterName: "openai-chat",
    })).toContain("Google");
  });

  test("CCA adapter validation rejects the extension before request construction", () => {
    const adapter = createGoogleAdapter({
      adapter: "google",
      googleMode: "cloud-code-assist",
      baseUrl: "https://daily-cloudcode-pa.googleapis.com",
    });
    expect(() => adapter.validateRequest?.(parseRequest(base))).toThrow("Cloud Code Assist");
  });
});
