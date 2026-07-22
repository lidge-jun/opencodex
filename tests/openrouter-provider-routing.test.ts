import { describe, expect, test } from "bun:test";
import { createOpenAIChatAdapter } from "../src/adapters/openai-chat";
import {
  openRouterRoutingConfigError,
  openRouterProviderPayload,
} from "../src/providers/openrouter-routing";
import { routeModel } from "../src/router";
import { providerManagementConfigError, safeConfigDTO } from "../src/server/auth-cors";
import type { OcxConfig, OcxParsedRequest, OcxProviderConfig } from "../src/types";

function provider(baseUrl: string, overrides: Partial<OcxProviderConfig> = {}): OcxProviderConfig {
  return { adapter: "openai-chat", baseUrl, apiKey: "test-key", ...overrides };
}

function parsed(modelId: string, stream = false): OcxParsedRequest {
  return {
    modelId,
    stream,
    context: { messages: [{ role: "user", content: "hello" }], tools: [] },
    options: {},
  };
}

function body(baseUrl: string, modelId: string, overrides: Partial<OcxProviderConfig> = {}, stream = false): Record<string, unknown> {
  const request = createOpenAIChatAdapter(provider(baseUrl, overrides)).buildRequest(parsed(modelId, stream));
  return JSON.parse(request.body as string) as Record<string, unknown>;
}

describe("OpenRouter configurable provider routing", () => {
  const deepSeekLock = { openRouterRouting: { only: ["deepseek"], allowFallbacks: false } };

  test("maps the default preference to OpenRouter's wire format", () => {
    expect(body("https://openrouter.ai/api/v1", "deepseek/deepseek-v4-pro", deepSeekLock).provider).toEqual({
      only: ["deepseek"], allow_fallbacks: false,
    });
  });

  test("an exact model preference replaces the provider-wide default", () => {
    const requestBody = body("https://openrouter.ai/api/v1", "anthropic/claude-sonnet-5", {
      openRouterRouting: { order: ["deepseek"], allowFallbacks: false },
      modelOpenRouterRouting: {
        "anthropic/claude-sonnet-5": { only: ["anthropic"], allowFallbacks: true },
      },
    });
    expect(requestBody.provider).toEqual({ only: ["anthropic"], allow_fallbacks: true });
  });

  test("model lookup ignores inherited object keys", () => {
    const requestBody = body("https://openrouter.ai/api/v1", "toString", {
      openRouterRouting: { only: ["anthropic"] },
      modelOpenRouterRouting: {},
    });
    expect(requestBody.provider).toEqual({ only: ["anthropic"] });
  });

  test("Codex-visible routed slugs resolve before exact model preferences are applied", () => {
    const nativeModelId = "anthropic/claude-sonnet-5";
    const config: OcxConfig = {
      port: 10100,
      defaultProvider: "openrouter",
      providers: {
        openrouter: provider("https://openrouter.ai/api/v1", {
          models: [nativeModelId],
          modelOpenRouterRouting: {
            [nativeModelId]: { only: ["anthropic"], allowFallbacks: false },
          },
        }),
      },
    };
    const route = routeModel(config, "openrouter/anthropic-claude-sonnet-5");
    expect(route.modelId).toBe(nativeModelId);
    const request = createOpenAIChatAdapter(route.provider).buildRequest(parsed(route.modelId));
    expect(JSON.parse(request.body as string).provider).toEqual({
      only: ["anthropic"], allow_fallbacks: false,
    });
  });

  test("preserves order, only, and the snake-case wire fallback flag", () => {
    expect(openRouterProviderPayload({
      order: ["anthropic", "amazon-bedrock"],
      only: ["anthropic", "amazon-bedrock", "google-vertex"],
      allowFallbacks: false,
    })).toEqual({
      order: ["anthropic", "amazon-bedrock"],
      only: ["anthropic", "amazon-bedrock", "google-vertex"],
      allow_fallbacks: false,
    });
  });

  test("accepts the canonical OpenRouter URL with a trailing slash", () => {
    expect(body("https://openrouter.ai/api/v1/", "deepseek/deepseek-chat", deepSeekLock).provider).toEqual({
      only: ["deepseek"],
      allow_fallbacks: false,
    });
  });

  test("preserves routing on streaming requests", () => {
    const requestBody = body("https://openrouter.ai/api/v1", "deepseek/deepseek-chat", deepSeekLock, true);
    expect(requestBody.provider).toEqual({ only: ["deepseek"], allow_fallbacks: false });
    expect(requestBody.stream_options).toEqual({ include_usage: true });
  });

  test.each([
    ["https://openrouter.ai/api/v1", "anthropic/claude-sonnet-5", {}],
    ["https://api.deepseek.com/v1", "deepseek-chat", deepSeekLock],
    ["https://other-aggregator.test/v1", "deepseek/deepseek-chat", deepSeekLock],
    ["https://openrouter.ai.example/api/v1", "deepseek/deepseek-chat", deepSeekLock],
    ["https://openrouter.ai/api/v1/proxy", "deepseek/deepseek-chat", deepSeekLock],
    ["http://openrouter.ai/api/v1", "deepseek/deepseek-chat", deepSeekLock],
    ["https://openrouter.ai:8443/api/v1", "deepseek/deepseek-chat", deepSeekLock],
    ["https://openrouter.ai/api/v1?route=custom", "deepseek/deepseek-chat", deepSeekLock],
  ] as const)("does not inject provider routing for %s / %s", (baseUrl, modelId, overrides) => {
    expect(body(baseUrl, modelId, overrides).provider).toBeUndefined();
  });
});

describe("OpenRouter provider-routing validation", () => {
  test("accepts valid defaults and exact model overrides", () => {
    expect(openRouterRoutingConfigError(provider("https://openrouter.ai/api/v1", {
      openRouterRouting: { order: ["deepseek"], allowFallbacks: false },
      modelOpenRouterRouting: {
        "anthropic/claude-sonnet-5": { only: ["anthropic"] },
      },
    }))).toBeNull();
  });

  for (const [label, overrides, message] of [
    ["an empty preference", { openRouterRouting: {} }, "must define order, only, or allowFallbacks"],
    ["an empty allowlist", { openRouterRouting: { only: [] } }, "must contain 1-64 provider slugs"],
    ["duplicate slugs", { openRouterRouting: { only: ["deepseek", "deepseek"] } }, "must not contain duplicate"],
    ["untrimmed slugs", { openRouterRouting: { order: [" deepseek"] } }, "nonblank trimmed provider slugs"],
    ["a nonboolean fallback flag", { openRouterRouting: { allowFallbacks: "no" } }, "allowFallbacks must be a boolean"],
    ["unknown fields", { openRouterRouting: { only: ["deepseek"], typo: true } }, "unknown field"],
    ["blank model ids", { modelOpenRouterRouting: { " ": { only: ["deepseek"] } } }, "keys must be nonblank trimmed model ids"],
  ] as const) {
    test(`rejects ${label}`, () => {
      const error = openRouterRoutingConfigError(provider(
        "https://openrouter.ai/api/v1",
        overrides as Partial<OcxProviderConfig>,
      ));
      expect(error).toContain(message);
    });
  }

  test("rejects routing preferences on noncanonical destinations", () => {
    expect(openRouterRoutingConfigError(provider("https://proxy.example/v1", {
      openRouterRouting: { only: ["deepseek"] },
    }))).toContain("canonical https://openrouter.ai/api/v1");
  });

  test("rejects routing preferences on an adapter that cannot emit the provider object", () => {
    expect(openRouterRoutingConfigError(provider("https://openrouter.ai/api/v1", {
      adapter: "anthropic",
      openRouterRouting: { only: ["anthropic"] },
    }))).toContain("require the openai-chat adapter");
  });

  test("management validation and safe config DTO preserve validated preferences", () => {
    const openrouter = provider("https://openrouter.ai/api/v1", {
      openRouterRouting: { order: ["deepseek"], allowFallbacks: false },
    });
    openrouter.defaultMaxOutputTokens = 32_000;
    openrouter.modelMaxOutputTokens = { "anthropic/claude-sonnet-5": 64_000 };
    expect(providerManagementConfigError("openrouter", openrouter)).toBeNull();
    expect(providerManagementConfigError("openrouter", {
      ...openrouter,
      defaultMaxOutputTokens: 0,
    })).toContain("defaultMaxOutputTokens");
    expect(providerManagementConfigError("openrouter", {
      ...openrouter,
      modelMaxOutputTokens: { "anthropic/claude-sonnet-5": 0 },
    })).toContain("modelMaxOutputTokens");
    expect(providerManagementConfigError("custom", {
      ...openrouter,
      baseUrl: "https://example.test/v1",
    })).toContain("canonical https://openrouter.ai/api/v1");
    const dto = safeConfigDTO({
      port: 10100,
      defaultProvider: "openrouter",
      providers: { openrouter },
    }) as { providers: Record<string, { openRouterRouting?: unknown; defaultMaxOutputTokens?: unknown; modelMaxOutputTokens?: unknown }> };
    expect(dto.providers.openrouter.openRouterRouting).toEqual({
      order: ["deepseek"], allowFallbacks: false,
    });
    expect(dto.providers.openrouter.defaultMaxOutputTokens).toBe(32_000);
    expect(dto.providers.openrouter.modelMaxOutputTokens).toEqual({ "anthropic/claude-sonnet-5": 64_000 });
  });
});
