import { afterEach, describe, expect, test } from "bun:test";
import { gatherRoutedModels } from "../src/codex/catalog";
import {
  clearModelCache,
  getModelsDiscoveryStatus,
  isModelsFetchCoolingDown,
} from "../src/codex/model-cache";

afterEach(() => {
  clearModelCache();
});

describe("provider discovery status (#329)", () => {
  test("HTTP 401 keeps configured fallback models and records discovery status", async () => {
    const provider = "ark-401";
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response(JSON.stringify({
      error: { message: "AuthenticationError", type: "authentication_error" },
    }), { status: 401, headers: { "content-type": "application/json" } })) as typeof fetch;
    try {
      const models = await gatherRoutedModels({
        providers: {
          [provider]: {
            baseUrl: "https://example.invalid/api/plan",
            adapter: "anthropic",
            authMode: "key",
            apiKey: "plan-key",
            defaultModel: "glm-5-2",
          },
        },
      });
      expect(models.map(model => `${model.provider}/${model.id}`)).toEqual([`${provider}/glm-5-2`]);
      expect(getModelsDiscoveryStatus(provider)).toMatchObject({
        ok: false,
        kind: "http",
        httpStatus: 401,
        fallback: "configured",
      });
      expect(isModelsFetchCoolingDown(provider)).toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("HTTP 403 records sibling auth failure without erasing the provider catalog fallback", async () => {
    const provider = "ark-403";
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response("forbidden", { status: 403 })) as typeof fetch;
    try {
      const models = await gatherRoutedModels({
        providers: {
          [provider]: {
            baseUrl: "https://example.invalid/v1",
            adapter: "openai-chat",
            authMode: "key",
            apiKey: "k",
            models: ["known-model"],
          },
        },
      });
      expect(models.map(model => model.id)).toEqual(["known-model"]);
      expect(getModelsDiscoveryStatus(provider)).toMatchObject({
        ok: false,
        kind: "http",
        httpStatus: 403,
        fallback: "configured",
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("network failure records kind=network and falls back to configured models", async () => {
    const provider = "ark-net";
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      throw new TypeError("fetch failed");
    }) as typeof fetch;
    try {
      const models = await gatherRoutedModels({
        providers: {
          [provider]: {
            baseUrl: "https://example.invalid/v1",
            adapter: "openai-chat",
            authMode: "key",
            apiKey: "k",
            models: ["offline-model"],
          },
        },
      });
      expect(models.map(model => model.id)).toEqual(["offline-model"]);
      expect(getModelsDiscoveryStatus(provider)).toMatchObject({
        ok: false,
        kind: "network",
        fallback: "configured",
        detail: "TypeError",
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("authoritative empty live catalog records kind=empty without a failure badge", async () => {
    const provider = "ark-empty";
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response(JSON.stringify({ data: [] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as typeof fetch;
    try {
      const models = await gatherRoutedModels({
        providers: {
          [provider]: {
            baseUrl: "https://example.invalid/v1",
            adapter: "openai-chat",
            authMode: "key",
            apiKey: "k",
          },
        },
      });
      expect(models.filter(model => model.provider === provider)).toEqual([]);
      expect(getModelsDiscoveryStatus(provider)).toMatchObject({
        ok: true,
        kind: "empty",
        fallback: "none",
      });
      expect(isModelsFetchCoolingDown(provider)).toBe(false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("successful discovery after auth fix clears the failure status and cooldown", async () => {
    const provider = "ark-retry";
    const originalFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      if (calls === 1) {
        return new Response("unauthorized", { status: 401 });
      }
      return new Response(JSON.stringify({ data: [{ id: "live-ok" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
    try {
      await gatherRoutedModels({
        providers: {
          [provider]: {
            baseUrl: "https://example.invalid/v1",
            adapter: "openai-chat",
            authMode: "key",
            apiKey: "bad",
            models: ["seed"],
          },
        },
      });
      expect(getModelsDiscoveryStatus(provider)?.httpStatus).toBe(401);

      // Credential / config change clears cache + status (same path as PATCH /api/providers).
      clearModelCache(provider);
      expect(getModelsDiscoveryStatus(provider)).toBeUndefined();

      const models = await gatherRoutedModels({
        providers: {
          [provider]: {
            baseUrl: "https://example.invalid/v1",
            adapter: "openai-chat",
            authMode: "key",
            apiKey: "good",
            models: ["seed"],
          },
        },
      });
      expect(models.map(model => model.id)).toEqual(["live-ok"]);
      expect(getModelsDiscoveryStatus(provider)).toMatchObject({
        ok: true,
        kind: "ok",
        fallback: "none",
      });
      expect(isModelsFetchCoolingDown(provider)).toBe(false);
      expect(calls).toBe(2);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("zero-model provider with only defaultModel stays selectable after 401 (#329 / #308)", async () => {
    const provider = "agent-plan";
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response("AuthenticationError", { status: 401 })) as typeof fetch;
    try {
      const models = await gatherRoutedModels({
        providers: {
          [provider]: {
            baseUrl: "https://ark.example/api/plan",
            adapter: "anthropic",
            authMode: "key",
            apiKey: "plan",
            defaultModel: "glm-5-2",
            // No static models[] — this is the Agent Plan shape from the issue.
          },
        },
      });
      expect(models).toEqual([
        expect.objectContaining({ provider, id: "glm-5-2" }),
      ]);
      expect(getModelsDiscoveryStatus(provider)).toMatchObject({
        ok: false,
        kind: "http",
        httpStatus: 401,
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
