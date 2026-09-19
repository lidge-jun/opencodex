import { describe, expect, test } from "bun:test";
import { routeModel } from "../../src/router";
import { resolveWireProtocolOverride } from "../../src/server/adapter-resolve";
import { applyOpenAiVirtualModel } from "../../src/providers/openai-virtual-models";
import { PROVIDER_REGISTRY } from "../../src/providers/registry";
import { captureProviderGather } from "../../src/codex/catalog/gather-capture";
import { fetchProviderModelsWithAuth, refreshingModelsAuthResolver } from "../../src/codex/catalog/provider-models";
import { applyProviderConfigHints } from "../../src/codex/catalog/model-hints";
import type { OcxConfig, OcxParsedRequest } from "../../src/types";
import type { RequestLogContext } from "../../src/server/request-log";

describe("resolved static policy consumers", () => {
  test("route capture is frozen and late credential replacement cannot change static policy", () => {
    const config: OcxConfig = {
      port: 10100,
      defaultProvider: "fixture",
      providers: {
        fixture: {
          adapter: "openai-chat",
          baseUrl: "https://fixture.invalid/v1",
          authMode: "key",
          apiKey: "first-private-key",
          modelSupportsVerbosity: { "model-a": false },
          modelAdapters: { "model-a": "openai-responses" },
        },
      },
    };
    const route = routeModel(config, "fixture/model-a");
    const captured = route.staticPolicy;
    route.provider = { ...route.provider, apiKey: "second-private-key" };
    expect(route.staticPolicy).toBe(captured);
    expect(route.staticPolicy.model.supportsVerbosity).toBe(false);
    expect(Object.isFrozen(route.staticPolicy)).toBe(true);
    expect(JSON.stringify(route.staticPolicy)).not.toContain("private-key");
    expect(resolveWireProtocolOverride(
      route.providerName,
      route.modelId,
      route.provider,
      "responses",
      route.staticPolicy,
    ).adapter).toBe(route.staticPolicy.model.adapter);
  });

  test("virtual rewrite atomically replaces selected-model policy with wire-model policy", () => {
    const entry = PROVIDER_REGISTRY.find(candidate => candidate.virtualModels !== undefined)!;
    const selectedModelId = Object.keys(entry.virtualModels!)[0]!;
    const config: OcxConfig = {
      port: 10100,
      defaultProvider: entry.id,
      providers: {
        [entry.id]: {
          adapter: entry.adapter,
          baseUrl: entry.baseUrl,
          authMode: entry.authKind,
          apiKey: "private-key",
          models: [selectedModelId],
        },
      },
    };
    const route = routeModel(config, `${entry.id}/${selectedModelId}`);
    const selectedPolicy = route.staticPolicy;
    const parsed = {
      modelId: selectedModelId,
      _rawBody: { model: selectedModelId },
      options: {},
    } as unknown as OcxParsedRequest;
    const logCtx = { model: selectedModelId, provider: entry.id } as unknown as RequestLogContext;
    const resolution = applyOpenAiVirtualModel(parsed, route, logCtx)!;
    expect(route.modelId).toBe(resolution.wireModelId);
    expect(route.staticPolicy.modelId).toBe(resolution.wireModelId);
    expect(route.staticPolicy).not.toBe(selectedPolicy);
    expect(logCtx.model).toBe(resolution.selectedModelId);
    expect(logCtx.resolvedModel).toBe(resolution.wireModelId);
    expect(parsed._openAiVirtualSelectedModelId).toBe(resolution.selectedModelId);
  });

  test("OpenAI API gather capture and catalog rows apply positive context and input caps", async () => {
    const modelId = "gpt-6-astra";
    const cases = [
      { name: "below", configuredContext: 200_000, configuredInput: 150_000, expectedContext: 200_000, expectedInput: 150_000 },
      { name: "above", configuredContext: 1_100_000, configuredInput: 950_000, expectedContext: 1_050_000, expectedInput: 922_000 },
    ] as const;

    for (const limits of cases) {
      const captured = captureProviderGather("openai-apikey", {
        adapter: "openai-responses",
        baseUrl: "https://api.openai.com/v1",
        authMode: "key",
        apiKey: "test-key",
        liveModels: false,
        models: [modelId],
        modelContextWindows: { [modelId]: limits.configuredContext },
        modelMaxInputTokens: { [modelId]: limits.configuredInput },
      }, refreshingModelsAuthResolver);
      const { models } = await fetchProviderModelsWithAuth(captured, 0, undefined, refreshingModelsAuthResolver);
      const row = models.find(model => model.id === modelId);

      expect({
        name: limits.name,
        capturedContext: captured.provider.modelContextWindows?.[modelId],
        capturedInput: captured.provider.modelMaxInputTokens?.[modelId],
        emittedContext: row?.contextWindow,
        emittedInput: row?.maxInputTokens,
      }).toEqual({
        name: limits.name,
        capturedContext: limits.expectedContext,
        capturedInput: limits.expectedInput,
        emittedContext: limits.expectedContext,
        emittedInput: limits.expectedInput,
      });
    }
  });

  test("Anthropic family context outranks provider-wide and observed date-model limits", () => {
    const modelId = "claude-sonnet-4-20250514";
    const captured = captureProviderGather("anthropic", {
      adapter: "anthropic",
      baseUrl: "https://api.anthropic.com",
      authMode: "oauth",
      liveModels: false,
      models: [modelId],
      contextWindow: 111_000,
      modelContextWindows: { "claude-sonnet-4": 222_000 },
    }, refreshingModelsAuthResolver);

    const projected = applyProviderConfigHints("anthropic", captured.provider, {
      provider: "anthropic",
      id: modelId,
      contextWindow: 333_000,
    });
    expect(projected.contextWindow).toBe(222_000);
  });
});
