import { describe, expect, test } from "bun:test";
import { createResponsesPassthroughAdapter as createResponsesPassthroughAdapterProduction, stripOpenAiOnlyWebSearchFields } from "../src/adapters/openai-responses";
import { enrichProviderFromRegistry, providerConfigSeed } from "../src/providers/derive";
import { getProviderRegistryEntry } from "../src/providers/registry";
import type { OcxProviderConfig } from "../src/types";
import { withTestTranslatorBudget } from "./helpers/translator-budget";

const createResponsesPassthroughAdapter = (...args: Parameters<typeof createResponsesPassthroughAdapterProduction>) =>
  withTestTranslatorBudget(createResponsesPassthroughAdapterProduction(...args));

function buildWebSearchBody(provider: OcxProviderConfig): Record<string, unknown> {
  const request = createResponsesPassthroughAdapter(provider).buildRequest({
    modelId: "test-model",
    context: { messages: [] },
    stream: true,
    options: {},
    _rawBody: {
      model: "test-model",
      input: "ping",
      tools: [{
        type: "web_search",
        external_web_access: true,
        search_context_size: "medium",
        user_location: { type: "approximate" },
      }],
    },
  }, { headers: new Headers() });
  return JSON.parse(request.body) as Record<string, unknown>;
}

function buildScopedToolFieldsBody(provider: OcxProviderConfig): Record<string, unknown> {
  const request = createResponsesPassthroughAdapter(provider).buildRequest({
    modelId: "test-model",
    context: { messages: [] },
    stream: true,
    options: {},
    _rawBody: {
      model: "test-model",
      input: "ping",
      tools: [{
        type: "web_search",
        external_web_access: true,
        defer_loading: true,
      }],
    },
  }, { headers: new Headers() });
  return JSON.parse(request.body) as Record<string, unknown>;
}

// #2188 follow-up: routed Responses upstreams (xAI api.x.ai) 400 the WHOLE request on
// OpenAI-only web_search config fields (probe 2026-08-21: external_web_access and
// search_context_size each 400 individually; user_location and filters are accepted).
describe("stripOpenAiOnlyWebSearchFields", () => {
  test("removes the two fatal fields, keeps user_location/filters and other tools", () => {
    const body = { model: "grok-4.6", tools: [
      { type: "web_search", external_web_access: true, search_context_size: "medium", user_location: { type: "approximate" }, filters: { allowed_domains: ["x.ai"] } },
      { type: "function", name: "f" },
    ] };
    const out = stripOpenAiOnlyWebSearchFields(body) as { tools: Array<Record<string, unknown>> };
    expect(out.tools[0]).toEqual({ type: "web_search", user_location: { type: "approximate" }, filters: { allowed_domains: ["x.ai"] } });
    expect(out.tools[1]).toEqual({ type: "function", name: "f" });
  });

  test("web_search_preview covered; clean body returns the same reference", () => {
    const preview = { model: "m", tools: [{ type: "web_search_preview", external_web_access: false }] };
    const out = stripOpenAiOnlyWebSearchFields(preview) as { tools: Array<Record<string, unknown>> };
    expect(out.tools[0]).toEqual({ type: "web_search_preview" });
    const clean = { model: "m", tools: [{ type: "web_search" }] };
    expect(stripOpenAiOnlyWebSearchFields(clean)).toBe(clean);
  });
});

describe("Responses buildRequest web_search capability", () => {
  test("official OpenAI API-key traffic retains OpenAI web_search fields", () => {
    const body = buildWebSearchBody({
      adapter: "openai-responses",
      baseUrl: "https://api.openai.com/v1",
      authMode: "key",
      apiKey: "test-openai-key",
    });

    expect(body.tools).toEqual([{
      type: "web_search",
      external_web_access: true,
      search_context_size: "medium",
      user_location: { type: "approximate" },
    }]);
  });

  test("registry xAI traffic strips fields its Responses API rejects", () => {
    const entry = getProviderRegistryEntry("xai");
    if (!entry) throw new Error("xAI registry entry missing");
    const provider = { ...providerConfigSeed(entry), adapter: "openai-responses" };
    enrichProviderFromRegistry("xai", provider);

    const body = buildWebSearchBody(provider);
    expect(body.tools).toEqual([{
      type: "web_search",
      user_location: { type: "approximate" },
    }]);
  });
});

describe("Responses buildRequest destination-scoped tool fields", () => {
  test("official OpenAI API-key provider keeps external_web_access and drops defer_loading", () => {
    const body = buildScopedToolFieldsBody({
      adapter: "openai-responses",
      baseUrl: "https://api.openai.com/v1",
      authMode: "key",
      apiKey: "test-openai-key",
    });

    expect(body.tools).toEqual([{
      type: "web_search",
      external_web_access: true,
    }]);
  });

  test("canonical ChatGPT forward provider keeps both fields", () => {
    const body = buildScopedToolFieldsBody({
      adapter: "openai-responses",
      baseUrl: "https://chatgpt.com/backend-api/codex",
      authMode: "forward",
    });

    expect(body.tools).toEqual([{
      type: "web_search",
      external_web_access: true,
      defer_loading: true,
    }]);
  });
});
