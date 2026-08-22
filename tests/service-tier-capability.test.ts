/**
 * `service_tier` is an OpenAI-only Responses parameter. Fast mode used to inject it
 * for EVERY Responses provider; now a provider-level `supportsServiceTier` capability
 * gates it after the final route is settled (tri-state): canonical OpenAI providers
 * keep the fast-mode behavior (`true`), DeepSeek/Volcengine strip it (`false`), and
 * unclassified custom Responses providers preserve caller-supplied values untouched without
 * ever receiving an injection (PR #860 family).
 */
import { afterEach, describe, expect, test } from "bun:test";
import { applyProviderConfigHints } from "../src/codex/catalog";
import { applyCatalogModelMetadata } from "../src/codex/catalog/effort";
import type { RawEntry } from "../src/codex/catalog/parsing";
import { providerConfigSeed, enrichProviderFromRegistry } from "../src/providers/derive";
import { getProviderRegistryEntry } from "../src/providers/registry";
import type { RequestLogContext } from "../src/server/request-log";
import { applyServiceTierGate, handleResponses } from "../src/server/responses/core";
import { canForwardServiceTierForModel, serviceTierSupportForModel, supportsServiceTierForModel } from "../src/providers/service-tier";
import { serviceTierAdapterForModel } from "../src/providers/service-tier";
import { candidateCapabilityEvidence } from "../src/routing/capability";
import { resolveProductionBehaviorValues } from "../src/routing/compatibility/behavior";
import type { OcxConfig, OcxProviderConfig } from "../src/types";

describe("registry capability reaches saved configs without overriding them", () => {
  test("the registry holds the defaults; the seed stays free of them so explicit config stays distinguishable", () => {
    const entry = getProviderRegistryEntry("deepseek")!;
    expect(entry.supportsServiceTier).toBe(false);
    expect(entry.preserveResponsesReasoningContent).toBe(true);
    expect(getProviderRegistryEntry("openai-apikey")!.supportsServiceTier).toBe(true);
    expect(getProviderRegistryEntry("volcengine-agent-plan")!.supportsServiceTier).toBe(false);
    // Registry-only metadata (same philosophy as modelWireDefaults): NOT seeded.
    const seed = providerConfigSeed(entry);
    expect(seed.supportsServiceTier).toBeUndefined();
    expect(seed.preserveResponsesReasoningContent).toBeUndefined();
  });

  test("enrichProviderFromRegistry backfills a missing field (not a hardcoded config)", () => {
    const prov: OcxProviderConfig = { adapter: "openai-chat", baseUrl: "https://api.deepseek.com", apiKey: "sk-test" };
    enrichProviderFromRegistry("deepseek", prov);
    expect(prov.supportsServiceTier).toBe(false);
    expect(prov.preserveResponsesReasoningContent).toBe(true);
  });

  test("an explicit config value beats the registry default in both directions", () => {
    const stripped: OcxProviderConfig = { adapter: "openai-responses", baseUrl: "https://api.openai.com/v1", apiKey: "sk-test", supportsServiceTier: false };
    enrichProviderFromRegistry("openai-apikey", stripped);
    expect(stripped.supportsServiceTier).toBe(false);
    const optedIn: OcxProviderConfig = { adapter: "openai-chat", baseUrl: "https://api.deepseek.com", apiKey: "sk-test", supportsServiceTier: true };
    enrichProviderFromRegistry("deepseek", optedIn);
    expect(optedIn.supportsServiceTier).toBe(true);
  });

  test("OpenRouter stays provider-unclassified and declares only its three OpenAI-backed slugs", () => {
    const entry = getProviderRegistryEntry("openrouter")!;
    expect(entry.supportsServiceTier).toBeUndefined();
    expect(entry.chatServiceTier).toBeUndefined();
    expect(entry.modelSupportsServiceTier).toEqual({
      "openai/gpt-5.6-sol": true,
      "openai/gpt-5.6-terra": true,
      "openai/gpt-5.6-luna": true,
    });
    expect(entry.modelSupportsServiceTier).not.toHaveProperty("anthropic/claude-sonnet-5");
    expect(providerConfigSeed(entry).modelSupportsServiceTier).toBeUndefined();
  });

  test("OpenRouter registry capability is not inherited by a same-named noncanonical destination", () => {
    const provider: OcxProviderConfig = {
      ...providerConfigSeed(getProviderRegistryEntry("openrouter")!),
      baseUrl: "https://openrouter-proxy.example.test/v1",
      apiKey: "sk-test",
    };
    enrichProviderFromRegistry("openrouter", provider);
    expect(provider.modelSupportsServiceTier).toBeUndefined();
    expect(supportsServiceTierForModel(provider, "openai/gpt-5.6-sol")).toBeUndefined();
  });
});

describe("service-tier capability is exact-model and provider-scoped", () => {
  test("an exact model entry overrides the provider fallback in both directions", () => {
    const provider: OcxProviderConfig = {
      adapter: "openai-responses",
      baseUrl: "https://relay.example.test/v1",
      supportsServiceTier: true,
      modelSupportsServiceTier: { "gpt-5.6-sol": false, "gpt-5.6-terra": true },
    };
    expect(supportsServiceTierForModel(provider, "gpt-5.6-sol")).toBe(false);
    expect(supportsServiceTierForModel(provider, "gpt-5.6-terra")).toBe(true);
    expect(supportsServiceTierForModel(provider, "gpt-5.6-luna")).toBe(true);
    expect(supportsServiceTierForModel({
      supportsServiceTier: false,
      modelSupportsServiceTier: { "gpt-5.6-sol": true },
    }, "gpt-5.6-sol")).toBe(false);
  });

  test("the same bare model id remains independent across providers", () => {
    expect(supportsServiceTierForModel({ supportsServiceTier: true }, "same-model")).toBe(true);
    expect(supportsServiceTierForModel({ supportsServiceTier: false }, "same-model")).toBe(false);
    expect(supportsServiceTierForModel({ modelSupportsServiceTier: { "same-model": true } }, "same-model")).toBe(true);
  });

  test("catalog-time wire resolution follows exact model adapters", () => {
    const provider = {
      adapter: "openai-chat",
      baseUrl: "https://relay.example.test/v1",
      modelAdapters: { "responses-model": "openai-responses" },
    } as const;
    expect(serviceTierAdapterForModel("custom-relay", provider, "responses-model")).toBe("openai-responses");
    expect(serviceTierAdapterForModel("custom-relay", provider, "chat-model")).toBe("openai-chat");
    expect(canForwardServiceTierForModel({
      ...provider,
      adapter: "anthropic",
      supportsServiceTier: true,
    }, "anthropic-model", "custom-relay")).toBe(false);
    expect(canForwardServiceTierForModel({
      ...provider,
      supportsServiceTier: true,
    }, "chat-model", "custom-relay")).toBe(true);
    expect(canForwardServiceTierForModel({
      ...provider,
      supportsServiceTier: true,
      chatServiceTier: true,
    }, "chat-model", "custom-relay")).toBe(true);
  });
});

describe("applyServiceTierGate fails closed", () => {
  test("a supported provider is untouched, including a caller-supplied tier", () => {
    const body = { model: "m", service_tier: "flex" };
    const options: { serviceTier?: string } = { serviceTier: "flex" };
    applyServiceTierGate({ adapter: "openai-responses", baseUrl: "https://api.openai.com/v1", supportsServiceTier: true }, body, options);
    expect(body.service_tier).toBe("flex");
    expect(options.serviceTier).toBe("flex");
  });

  test("an unsupported provider loses the field AND the logging value", () => {
    const body = { model: "m", service_tier: "priority" };
    const options: { serviceTier?: string } = { serviceTier: "priority" };
    applyServiceTierGate({ adapter: "openai-responses", baseUrl: "https://api.deepseek.com", supportsServiceTier: false }, body, options);
    expect("service_tier" in body).toBe(false);
    expect(options.serviceTier).toBeUndefined();
  });

  test("an unclassified provider (undefined capability) preserves the caller value", () => {
    const body = { model: "m", service_tier: "priority" };
    const options: { serviceTier?: string } = { serviceTier: "priority" };
    applyServiceTierGate({ adapter: "openai-responses", baseUrl: "https://example.com/v1" }, body, options);
    // Tri-state: only an explicit `false` strips; unknown gateways keep the
    // caller's field (we know nothing about them), and never get an injection.
    expect(body.service_tier).toBe("priority");
    expect(options.serviceTier).toBe("priority");
  });

  test("a non-Responses adapter is out of scope", () => {
    const body = { model: "m", service_tier: "priority" };
    const options: { serviceTier?: string } = {};
    applyServiceTierGate({ adapter: "openai-chat", baseUrl: "https://api.deepseek.com" }, body, options);
    expect(body.service_tier).toBe("priority");
  });

  test("an exact unsupported model strips a caller tier even when the provider default is true", () => {
    const body = { model: "gpt-5.6-sol", service_tier: "priority" };
    const options: { serviceTier?: string } = { serviceTier: "priority" };
    applyServiceTierGate({
      adapter: "openai-chat",
      baseUrl: "https://relay.example.test/v1",
      supportsServiceTier: true,
      modelSupportsServiceTier: { "gpt-5.6-sol": false },
    }, body, options, "gpt-5.6-sol");
    expect(body).not.toHaveProperty("service_tier");
    expect(options.serviceTier).toBeUndefined();
  });

  test("a final non-service-tier adapter strips the caller tier after route resolution", () => {
    const body = { model: "anthropic-model", service_tier: "priority" };
    const options: { serviceTier?: string } = { serviceTier: "priority" };
    applyServiceTierGate({
      adapter: "anthropic",
      baseUrl: "https://api.anthropic.com",
      supportsServiceTier: true,
    }, body, options, "anthropic-model", undefined);
    expect(body).not.toHaveProperty("service_tier");
    expect(options.serviceTier).toBeUndefined();
  });
});

describe("routing evidence uses the final model adapter", () => {
  const relay = (overrides: Partial<OcxProviderConfig> = {}): OcxProviderConfig => ({
    adapter: "openai-chat",
    baseUrl: "https://relay.example.test/v1",
    chatServiceTier: true,
    supportsServiceTier: true,
    modelSupportsServiceTier: { blocked: false },
    ...overrides,
  });

  test("model declarations and wire opt-ins reach routing and compatibility evidence", () => {
    const config = {
      port: 10100,
      defaultProvider: "relay",
      providers: { relay: relay() },
    } as OcxConfig;
    expect(candidateCapabilityEvidence(config, "relay", "verified").serviceTier).toBe("supported");
    expect(candidateCapabilityEvidence(config, "relay", "blocked").serviceTier).toBe("unsupported");
    expect(candidateCapabilityEvidence({
      ...config,
      providers: { relay: relay({ chatServiceTier: false }) },
    }, "relay", "verified").serviceTier).toBe("supported");

    const mixedProvider = relay({
      adapter: "openai-responses",
      chatServiceTier: false,
      modelAdapters: { chat: "openai-chat" },
    });
    const mixedConfig = { ...config, providers: { relay: mixedProvider } };
    expect(candidateCapabilityEvidence(mixedConfig, "relay", "verified").serviceTier).toBe("supported");
    expect(candidateCapabilityEvidence(mixedConfig, "relay", "chat").serviceTier).toBe("supported");

    const behavior = resolveProductionBehaviorValues(
      mixedConfig,
      "relay",
      "chat",
      mixedProvider,
      "service-tier-test-salt",
    );
    expect(behavior?.["responses.serviceTier"]?.value).toBe(true);
  });
});

describe("the gate fires on the live handleResponses path", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = originalFetch; });

  function captureBody(): { bodies: Record<string, unknown>[] } {
    const bodies: Record<string, unknown>[] = [];
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
      return new Response("data: [DONE]\n\n", { status: 200, headers: { "content-type": "text/event-stream" } });
    }) as typeof fetch;
    return { bodies };
  }

  async function drive(
    providerName: string,
    provider: OcxProviderConfig,
    model: string,
    rawBody: Record<string, unknown>,
    fastMode?: boolean,
  ): Promise<Record<string, unknown>> {
    const { bodies } = captureBody();
    const config = { providers: { [providerName]: provider }, ...(fastMode === undefined ? {} : { fastMode }) } as unknown as OcxConfig;
    await handleResponses(
      new Request("http://localhost/v1/responses", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: `${providerName}/${model}`, input: "ping", stream: true, ...rawBody }),
      }),
      config,
      { model: "", provider: "" },
      {},
    );
    return bodies[0] ?? {};
  }

  const deepseekProvider = (): OcxProviderConfig =>
    ({ ...providerConfigSeed(getProviderRegistryEntry("deepseek")!), apiKey: "sk-test" });
  const openAiKeyProvider = (): OcxProviderConfig =>
    ({ ...providerConfigSeed(getProviderRegistryEntry("openai-apikey")!), apiKey: "sk-test" });
  const openRouterProvider = (overrides: Partial<OcxProviderConfig> = {}): OcxProviderConfig => {
    const provider: OcxProviderConfig = {
      ...providerConfigSeed(getProviderRegistryEntry("openrouter")!),
      apiKey: "sk-test",
      ...overrides,
    };
    return provider;
  };

  test("DeepSeek never receives service_tier, even with fastMode on", async () => {
    const body = await drive("deepseek", deepseekProvider(), "deepseek-v4-flash", {}, true);
    expect("service_tier" in body).toBe(false);
  });

  test("DeepSeek strips a caller-supplied service_tier", async () => {
    const body = await drive("deepseek", deepseekProvider(), "deepseek-v4-flash", { service_tier: "priority" });
    expect("service_tier" in body).toBe(false);
  });

  test("DeepSeek clears a stripped caller tier from request logging", async () => {
    const { bodies } = captureBody();
    const logCtx: RequestLogContext = { model: "", provider: "" };
    await handleResponses(
      new Request("http://localhost/v1/responses", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "deepseek/deepseek-v4-flash",
          input: "ping",
          stream: true,
          service_tier: "priority",
        }),
      }),
      { providers: { deepseek: deepseekProvider() } } as unknown as OcxConfig,
      logCtx,
      {},
    );

    const upstreamBody = bodies[0];
    expect(upstreamBody).toBeDefined();
    expect("service_tier" in upstreamBody!).toBe(false);
    expect(logCtx.requestedServiceTier).toBeUndefined();
    expect(logCtx.requestedSpeedLabel).toBeUndefined();
  });

  test("canonical OpenAI keeps fast-mode injection and removal", async () => {
    const on = await drive("openai-apikey", openAiKeyProvider(), "gpt-5.5", {}, true);
    expect(on.service_tier).toBe("priority");
    const off = await drive("openai-apikey", openAiKeyProvider(), "gpt-5.5", { service_tier: "flex" }, false);
    expect("service_tier" in off).toBe(false);
  });

  test("canonical OpenAI preserves a caller value when fastMode is unset", async () => {
    const body = await drive("openai-apikey", openAiKeyProvider(), "gpt-5.5", { service_tier: "flex" });
    expect(body.service_tier).toBe("flex");
  });

  test("an unclassified custom Responses provider keeps caller values; only explicit false strips", async () => {
    const custom = (): OcxProviderConfig => ({ adapter: "openai-responses", baseUrl: "https://gateway.example.com/v1", apiKey: "sk-test" });
    const preserved = await drive("custom-gw", custom(), "some-model", { service_tier: "priority" });
    expect(preserved.service_tier).toBe("priority");
    const stripped = await drive("custom-gw", { ...custom(), supportsServiceTier: false }, "some-model", { service_tier: "priority" });
    expect("service_tier" in stripped).toBe(false);
    const optedIn = await drive("custom-gw", { ...custom(), supportsServiceTier: true }, "some-model", { service_tier: "priority" });
    expect(optedIn.service_tier).toBe("priority");
  });

  test("an exact-model-only Chat capability forwards Fast while undeclared models stay blocked", async () => {
    const custom = (): OcxProviderConfig => ({
      adapter: "openai-chat",
      baseUrl: "https://gateway.example.com/v1",
      apiKey: "sk-test",
      modelSupportsServiceTier: { "verified-model": true, "blocked-model": false },
    });
    const supported = await drive("custom-chat", custom(), "verified-model", {}, true);
    expect(supported.service_tier).toBe("priority");
    const blocked = await drive("custom-chat", custom(), "blocked-model", { service_tier: "priority" }, true);
    expect(blocked).not.toHaveProperty("service_tier");
    const undeclared = await drive("custom-chat", custom(), "undeclared-model", { service_tier: "priority" });
    expect(undeclared).not.toHaveProperty("service_tier");
  });

  test.each([
    "openai/gpt-5.6-sol",
    "openai/gpt-5.6-terra",
    "openai/gpt-5.6-luna",
  ])("OpenRouter %s publishes and injects canonical Fast without route pins", async modelId => {
    const provider = openRouterProvider();
    const model = applyProviderConfigHints("openrouter", provider, { id: modelId, provider: "openrouter" });
    const catalogEntry: RawEntry = {};
    applyCatalogModelMetadata(catalogEntry, model);
    expect(catalogEntry.service_tiers).toEqual([expect.objectContaining({ id: "priority", name: "Fast" })]);

    const body = await drive("openrouter", provider, modelId, {}, true);
    expect(body.service_tier).toBe("priority");
    expect(body).not.toHaveProperty("provider");
  });

  test("OpenRouter Anthropic and undeclared slugs stay unclassified and receive no Fast injection", async () => {
    const provider = openRouterProvider();
    for (const modelId of ["anthropic/claude-sonnet-5", "google/gemini-unknown"]) {
      const model = applyProviderConfigHints("openrouter", provider, { id: modelId, provider: "openrouter" });
      const catalogEntry: RawEntry = {};
      applyCatalogModelMetadata(catalogEntry, model);
      expect(catalogEntry).not.toHaveProperty("service_tiers");
      expect(await drive("openrouter", provider, modelId, {}, true)).not.toHaveProperty("service_tier");
    }
  });

  test("an explicit OpenRouter provider-level false remains fail-closed", async () => {
    const provider = openRouterProvider({ supportsServiceTier: false });
    expect(supportsServiceTierForModel(provider, "openai/gpt-5.6-sol")).toBe(false);
    const body = await drive("openrouter", provider, "openai/gpt-5.6-sol", {}, true);
    expect(body).not.toHaveProperty("service_tier");
  });

  test("a same-named noncanonical OpenRouter destination neither publishes nor injects registry Fast", async () => {
    const provider = openRouterProvider({ baseUrl: "https://openrouter-proxy.example.test/v1" });
    const model = applyProviderConfigHints("openrouter", provider, {
      id: "openai/gpt-5.6-sol",
      provider: "openrouter",
    });
    const catalogEntry: RawEntry = {};
    applyCatalogModelMetadata(catalogEntry, model);
    expect(catalogEntry).not.toHaveProperty("service_tiers");
    const body = await drive("openrouter", provider, "openai/gpt-5.6-sol", {}, true);
    expect(body).not.toHaveProperty("service_tier");
  });
});

describe("unclassified chat-wire tier projection (release-audit fix)", () => {
  test("unclassified openai-chat without chatServiceTier projects false (require.serviceTier unsupported keeps matching)", () => {
    const provider = { adapter: "openai-chat" } as OcxProviderConfig;
    expect(serviceTierSupportForModel(provider, "some-model")).toBe(false);
  });

  test("unclassified openai-chat WITH chatServiceTier: true keeps the historical unknown", () => {
    const provider = { adapter: "openai-chat", chatServiceTier: true } as OcxProviderConfig;
    expect(serviceTierSupportForModel(provider, "some-model")).toBeUndefined();
  });

  test("unclassified Responses-wire provider stays unknown", () => {
    const provider = { adapter: "openai-responses" } as OcxProviderConfig;
    expect(serviceTierSupportForModel(provider, "some-model")).toBeUndefined();
  });
});
