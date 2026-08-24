import { describe, expect, test } from "bun:test";
import { createGoogleAdapter } from "../src/adapters/google";
import { compileGoogleWireBody } from "../src/adapters/google-wire-compiler";
import { parseRequest } from "../src/responses/parser";
import { googleProviderOptionsRouteError } from "../src/responses/google-provider-options";
import type { OcxParsedRequest } from "../src/types";

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
