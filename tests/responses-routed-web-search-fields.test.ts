import { describe, expect, test } from "bun:test";
import { createResponsesPassthroughAdapter as createResponsesPassthroughAdapterProduction, stripOpenAiOnlyWebSearchFields } from "../src/adapters/openai-responses";
import { enrichProviderFromRegistry, providerConfigSeed } from "../src/providers/derive";
import { getProviderRegistryEntry } from "../src/providers/registry";
import { routedProviderConfig } from "../src/router";
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

// The request path resolves a saved provider row through routedProviderConfig(), NOT through
// enrichProviderFromRegistry(). Until this backfill existed, a saved xai row reached the
// Responses adapter with supportsOpenAiWebSearchToolFields === undefined, so the #2262
// capability gate read "unclassified" and forwarded the fields; live xAI answered
// `400 Argument not supported: external_web_access` and every routed Grok turn on the
// Responses lane died before inference (verified against cli-chat-proxy.grok.com 2026-08-21).
// Asserting on the adapter with a hand-built provider cannot catch this — the gap is upstream
// of the adapter, in what the router hands it.
describe("routedProviderConfig web_search capability backfill", () => {
  test("a saved xai row without the flag is classified by the registry", () => {
    const saved: OcxProviderConfig = {
      adapter: "openai-chat",
      baseUrl: "https://api.x.ai/v1",
      authMode: "oauth",
      // The GUI Responses opt-in writes only modelAdapters; it never writes the capability.
      modelAdapters: { "grok-4.6": "openai-responses" },
    };
    expect(saved.supportsOpenAiWebSearchToolFields).toBeUndefined();

    const routed = routedProviderConfig("xai", saved);
    expect(routed.supportsOpenAiWebSearchToolFields).toBe(false);
  });

  test("the routed row actually strips the fatal fields at the adapter", () => {
    const routed = routedProviderConfig("xai", {
      adapter: "openai-chat",
      baseUrl: "https://api.x.ai/v1",
      authMode: "oauth",
      modelAdapters: { "grok-4.6": "openai-responses" },
    });

    const body = buildWebSearchBody({ ...routed, adapter: "openai-responses" });
    expect(body.tools).toEqual([{
      type: "web_search",
      user_location: { type: "approximate" },
    }]);
  });

  test("an explicit saved value still overrides the registry default", () => {
    const routed = routedProviderConfig("xai", {
      adapter: "openai-responses",
      baseUrl: "https://api.x.ai/v1",
      authMode: "oauth",
      supportsOpenAiWebSearchToolFields: true,
    });
    expect(routed.supportsOpenAiWebSearchToolFields).toBe(true);
  });
});
