import { describe, expect, test } from "bun:test";
import type { OcxProviderConfig } from "../../src/types";
import { captureWireAdapterHardPins } from "../../src/types";
import type { ProviderRegistryEntry } from "../../src/providers/registry/types";
import { PROVIDER_REGISTRY } from "../../src/providers/registry";
import { effectiveProviderAliasDecision, resolveModelAlias } from "../../src/providers/default-aliases";
import { resolveOpenAiVirtualModel } from "../../src/providers/openai-virtual-models";
import { routedProviderConfig } from "../../src/router";
import { resolveWireProtocolOverride } from "../../src/server/adapter-resolve";
import { applyProviderConfigHints } from "../../src/codex/catalog/model-hints";
import { captureFastPolicyAuthority } from "../../src/providers/service-tier";
import {
  clampObservedModelLimits,
  resolveModelPolicy,
} from "../../src/providers/resolved-model-policy";
import { modelRecordValue } from "../../src/reasoning-effort";

const MODEL = "vendor/model-a";

function registry(overrides: Partial<ProviderRegistryEntry> = {}): ProviderRegistryEntry {
  return {
    id: "fixture-provider",
    label: "Fixture provider",
    adapter: "openai-chat",
    baseUrl: "https://registry.invalid/v1",
    authKind: "key",
    contextWindow: 120_000,
    modelContextWindows: { [MODEL]: 100_000, "registry-only": 90_000 },
    modelInputModalities: { [MODEL]: ["text", "image"] },
    modelMaxInputTokens: { [MODEL]: 80_000 },
    modelMaxOutputTokens: { [MODEL]: 16_000 },
    modelReasoningEfforts: { [MODEL]: ["low", "high"] },
    modelDefaultReasoningEfforts: { [MODEL]: "high" },
    modelSupportsReasoningSummaries: { [MODEL]: true },
    modelSupportsVerbosity: { [MODEL]: true },
    modelSupportsServiceTier: { [MODEL]: true },
    staticHeaders: { "X-Registry": "registry", "User-Agent": "registry-agent" },
    parallelToolCalls: true,
    showThinkingSummary: true,
    alias: "registry-alias",
    ...overrides,
  };
}

function provider(overrides: Partial<OcxProviderConfig> = {}): OcxProviderConfig {
  return {
    adapter: "openai-chat",
    baseUrl: "https://registry.invalid/v1",
    authMode: "key",
    ...overrides,
  };
}

function resolve(
  configured: OcxProviderConfig,
  entry: ProviderRegistryEntry | undefined = registry(),
  transportMatchedRegistry = true,
) {
  return resolveModelPolicy({
    providerName: "fixture-provider",
    modelId: MODEL,
    provider: configured,
    registryEntry: entry,
    transportMatchedRegistry,
  });
}

describe("resolved static model policy parity", () => {
  test("inline tag opt-in inherits only matching transport defaults and preserves explicit empty lists", () => {
    const entry = registry({ inlineThinkTagModels: [MODEL] });
    expect(resolve(provider(), entry).provider.inlineThinkTagModels).toEqual([MODEL]);
    expect(resolve(provider({ inlineThinkTagModels: [] }), entry).provider.inlineThinkTagModels).toEqual([]);
    expect(resolve(provider({ inlineThinkTagModels: ["other"] }), entry).provider.inlineThinkTagModels).toEqual(["other"]);
    expect(resolve(provider(), entry, false).provider.inlineThinkTagModels).toBeUndefined();
    expect(routedProviderConfig("fixture-provider", provider({ inlineThinkTagModels: [MODEL] })).inlineThinkTagModels).toEqual([MODEL]);
  });
  test("representative registry maps stay byte-equivalent to the current route merge", () => {
    const entry = PROVIDER_REGISTRY.find(candidate => {
      if (candidate.allowBaseUrlOverride || /\{[^}]*\}/.test(candidate.baseUrl)) return false;
      const shared = Object.keys(candidate.modelContextWindows ?? {}).find(modelId => (
        candidate.modelMaxOutputTokens?.[modelId] !== undefined
        && candidate.modelReasoningEfforts?.[modelId] !== undefined
      ));
      return shared !== undefined;
    });
    expect(entry).toBeDefined();
    const modelId = Object.keys(entry!.modelContextWindows!).find(candidate => (
      entry!.modelMaxOutputTokens?.[candidate] !== undefined
      && entry!.modelReasoningEfforts?.[candidate] !== undefined
    ))!;
    const configured = provider({
      adapter: entry!.adapter,
      baseUrl: entry!.baseUrl,
      authMode: entry!.authKind,
    });
    const current = routedProviderConfig(entry!.id, configured);
    const policy = resolveModelPolicy({
      providerName: entry!.id,
      modelId,
      provider: configured,
      registryEntry: entry,
      transportMatchedRegistry: true,
    });
    expect(JSON.stringify({
      context: policy.provider.modelContextWindows,
      output: policy.provider.modelMaxOutputTokens,
      efforts: policy.provider.modelReasoningEfforts,
    })).toBe(JSON.stringify({
      context: current.modelContextWindows,
      output: current.modelMaxOutputTokens,
      efforts: current.modelReasoningEfforts,
    }));
  });

  test("registry defaults match the current registry-first route projection", () => {
    const policy = resolve(provider());
    expect({
      adapter: policy.provider.adapter,
      baseUrl: policy.provider.baseUrl,
      contextWindow: policy.model.contextWindow,
      inputModalities: policy.model.inputModalities,
      maxInputTokens: policy.model.maxInputTokens,
      maxOutputTokens: policy.model.maxOutputTokens,
      reasoningEfforts: policy.model.reasoningEfforts,
      defaultReasoningEffort: policy.model.defaultReasoningEffort,
      summaries: policy.model.supportsReasoningSummaries,
      verbosity: policy.model.supportsVerbosity,
      serviceTier: policy.model.supportsServiceTier,
      alias: policy.effectiveAlias,
    }).toEqual({
      adapter: "openai-chat",
      baseUrl: "https://registry.invalid/v1",
      contextWindow: 100_000,
      inputModalities: ["text", "image"],
      maxInputTokens: 80_000,
      maxOutputTokens: 16_000,
      reasoningEfforts: ["low", "high"],
      defaultReasoningEffort: "high",
      summaries: true,
      verbosity: true,
      serviceTier: true,
      alias: "registry-alias",
    });
    expect(policy.provenance.model.contextWindow).toBe("registry");
    expect(policy.provenance.alias).toBe("registry");
  });

  test("operator values win per model while registry-only siblings survive", () => {
    const configured = provider({
      modelContextWindows: { [MODEL]: 70_000, "operator-only": 60_000 },
      modelInputModalities: { [MODEL]: ["text"] },
      modelMaxInputTokens: { [MODEL]: 50_000 },
      modelMaxOutputTokens: { [MODEL]: 8_000 },
      modelReasoningEfforts: { [MODEL]: [] },
      modelDefaultReasoningEfforts: { [MODEL]: "low" },
      modelSupportsReasoningSummaries: { [MODEL]: false },
      modelSupportsVerbosity: { [MODEL]: false },
      modelSupportsServiceTier: { [MODEL]: false },
      headers: { "user-agent": "operator-agent", "X-Operator": "operator" },
      parallelToolCalls: false,
      showThinkingSummary: false,
      alias: "operator-alias",
    });
    const policy = resolve(configured);
    expect(policy.provider.modelContextWindows).toEqual({
      [MODEL]: 70_000,
      "registry-only": 90_000,
      "operator-only": 60_000,
    });
    expect(policy.provider.headers).toEqual({
      "user-agent": "operator-agent",
      "X-Operator": "operator",
      "X-Registry": "registry",
    });
    expect(policy.model).toMatchObject({
      contextWindow: 70_000,
      inputModalities: ["text"],
      maxInputTokens: 50_000,
      maxOutputTokens: 8_000,
      reasoningEfforts: [],
      defaultReasoningEffort: "low",
      supportsReasoningSummaries: false,
      supportsVerbosity: false,
      supportsServiceTier: false,
    });
    expect(policy.provider.parallelToolCalls).toBe(false);
    expect(policy.provider.showThinkingSummary).toBe(false);
    expect(policy.effectiveAlias).toBe("operator-alias");
    expect(policy.provenance.model.supportsReasoningSummaries).toBe("operator");
  });

  test("nonempty explicit capability modalities outrank the registry map", () => {
    const configured = provider({ modelCapabilities: { [MODEL]: { inputModalities: ["audio"] } } });
    const policy = resolveModelPolicy({
      providerName: "fixture-provider",
      modelId: MODEL,
      provider: configured,
      registryEntry: registry(),
      transportMatchedRegistry: true,
      modelCapabilities: configured.modelCapabilities![MODEL],
    });
    const current = applyProviderConfigHints("fixture-provider", configured, { provider: "fixture-provider", id: MODEL });
    expect(policy.model.inputModalities).toEqual(["audio"]);
    expect(policy.model.inputModalities).toEqual(current.inputModalities);
    expect(policy.provenance.model.inputModalities).toBe("operator-capability");
  });

  test("empty explicit capability modalities fall through to the registry map", () => {
    const policy = resolveModelPolicy({
      providerName: "fixture-provider",
      modelId: MODEL,
      provider: provider(),
      registryEntry: registry(),
      transportMatchedRegistry: true,
      modelCapabilities: { inputModalities: [] },
    });
    expect(policy.model.inputModalities).toEqual(["text", "image"]);
    expect(policy.provenance.model.inputModalities).toBe("registry");
  });

  test("absent explicit capabilities preserve the current registry-map winner", () => {
    const policy = resolve(provider());
    expect(policy.model.inputModalities).toEqual(["text", "image"]);
    expect(policy.provenance.model.inputModalities).toBe("registry");
  });

  test("cleared exact capability restores colon-family legacy modalities", () => {
    const modelId = "ModelA:variant";
    const configured = provider({
      modelInputModalities: { ModelA: ["audio"] },
      modelCapabilities: { [modelId]: { inputModalities: ["text", "image"] } },
    });
    const withExactCapability = resolveModelPolicy({
      providerName: "custom",
      modelId,
      provider: configured,
      transportMatchedRegistry: false,
      modelCapabilities: configured.modelCapabilities![modelId],
    });
    expect(withExactCapability.model.inputModalities).toEqual(["text", "image"]);
    delete configured.modelCapabilities![modelId];
    const cleared = resolveModelPolicy({
      providerName: "custom",
      modelId,
      provider: configured,
      transportMatchedRegistry: false,
    });
    expect(cleared.model.inputModalities).toEqual(["audio"]);
    expect(cleared.provenance.model.inputModalities).toBe("operator");
  });

  test("colon-family legacy modalities resolve without an exact capability declaration", () => {
    const policy = resolveModelPolicy({
      providerName: "custom",
      modelId: "ModelA:variant",
      provider: provider({ modelInputModalities: { ModelA: ["audio"] } }),
      transportMatchedRegistry: false,
    });
    expect(policy.model.inputModalities).toEqual(["audio"]);
    expect(policy.provenance.model.inputModalities).toBe("operator");
  });

  test("registry exact key beats operator family with matching provenance", () => {
    const modelId = "ModelA:variant";
    const entry = registry({ modelInputModalities: { [modelId]: ["text", "image"] } });
    const configured = provider({ modelInputModalities: { ModelA: ["audio"] } });
    const policy = resolveModelPolicy({
      providerName: entry.id,
      modelId,
      provider: configured,
      registryEntry: entry,
      transportMatchedRegistry: true,
    });
    expect(policy.model.inputModalities).toEqual(["text", "image"]);
    expect(policy.provenance.model.inputModalities).toBe("registry");
  });

  test("captured effective auth admits a usable key override without credential material", () => {
    const entry = PROVIDER_REGISTRY.find(candidate => (
      candidate.authKind === "oauth" && candidate.allowKeyAuthOverride === true
    ))!;
    const configured = provider({
      adapter: entry.adapter,
      baseUrl: entry.baseUrl,
      authMode: "key",
      apiKey: "usable-private-key",
    });
    const authority = routedProviderConfig(entry.id, configured);
    expect(authority.authMode).toBe("key");
    const policy = resolveModelPolicy({
      providerName: entry.id,
      modelId: entry.defaultModel ?? MODEL,
      provider: configured,
      registryEntry: entry,
      transportMatchedRegistry: true,
      effectiveAuth: { authMode: authority.authMode! },
    });
    expect(policy.provider.authMode).toBe(authority.authMode);
    expect(policy.provenance.provider.authMode).toBe("captured-auth");
    expect(JSON.stringify(policy)).not.toContain("usable-private-key");
  });

  test("captured unresolved key authority falls back to registry OAuth", () => {
    const entry = PROVIDER_REGISTRY.find(candidate => (
      candidate.authKind === "oauth" && candidate.allowKeyAuthOverride === true
    ))!;
    const envName = "OCX_TEST_RESOLVED_POLICY_MISSING_KEY";
    const previous = process.env[envName];
    delete process.env[envName];
    try {
      const reference = `\${${envName}}`;
      const configured = provider({
        adapter: entry.adapter,
        baseUrl: entry.baseUrl,
        authMode: "key",
        apiKey: reference,
      });
      const authority = routedProviderConfig(entry.id, configured);
      expect(authority.authMode).toBe("oauth");
      const policy = resolveModelPolicy({
        providerName: entry.id,
        modelId: entry.defaultModel ?? MODEL,
        provider: configured,
        registryEntry: entry,
        transportMatchedRegistry: true,
        effectiveAuth: { authMode: authority.authMode! },
      });
      expect(policy.provider.authMode).toBe(authority.authMode);
      expect(policy.provenance.provider.authMode).toBe("captured-auth");
      expect(JSON.stringify(policy)).not.toContain(reference);
    } finally {
      if (previous === undefined) delete process.env[envName];
      else process.env[envName] = previous;
    }
  });

  test("a custom transport receives no registry policy", () => {
    const configured = provider({
      baseUrl: "https://custom.invalid/v1",
      contextWindow: 42_000,
      apiKey: "private-fixture-value",
      modelSupportsVerbosity: { [MODEL]: false },
    });
    const policy = resolve(configured, registry(), false);
    expect(policy.transportMatchedRegistry).toBe(false);
    expect(policy.provider.baseUrl).toBe("https://custom.invalid/v1");
    expect(policy.provider.contextWindow).toBe(42_000);
    expect(policy.model.contextWindow).toBe(42_000);
    expect(policy.model.supportsVerbosity).toBe(false);
    expect(JSON.stringify(policy)).not.toContain("private-fixture-value");
    expect(policy.provenance.model.contextWindow).toBe("operator");
  });

  test("unknown capabilities stay absent rather than becoming false or empty", () => {
    const policy = resolveModelPolicy({
      providerName: "custom",
      modelId: "unknown-model",
      provider: provider({ baseUrl: "https://custom.invalid/v1" }),
      transportMatchedRegistry: false,
    });
    expect(policy.model).toEqual({ adapter: "openai-chat" });
    expect(policy.model.contextWindow).toBeUndefined();
    expect(policy.model.reasoningEfforts).toBeUndefined();
    expect(policy.model.supportsReasoningSummaries).toBeUndefined();
    expect(policy.provenance.model.contextWindow).toBe("unknown");
  });

  test("discovered limits remain call-local and are clamped by frozen static caps", () => {
    const configured = provider({
      modelContextWindows: { [MODEL]: 70_000 },
      modelMaxInputTokens: { [MODEL]: 50_000 },
      modelMaxOutputTokens: { [MODEL]: 8_000 },
    });
    const policy = resolve(configured);
    const widened = clampObservedModelLimits(policy.model, {
      contextWindow: 90_000,
      maxInputTokens: 60_000,
      maxOutputTokens: 12_000,
    });
    const narrowed = clampObservedModelLimits(policy.model, {
      contextWindow: 40_000,
      maxInputTokens: 30_000,
      maxOutputTokens: 4_000,
    });
    expect(widened).toEqual({ contextWindow: 70_000, maxInputTokens: 50_000, maxOutputTokens: 8_000 });
    expect(narrowed).toEqual({ contextWindow: 40_000, maxInputTokens: 30_000, maxOutputTokens: 4_000 });
    const current = applyProviderConfigHints("fixture-provider", configured, {
      provider: "fixture-provider",
      id: MODEL,
      contextWindow: 90_000,
      maxInputTokens: 60_000,
      maxOutputTokens: 12_000,
    });
    expect(widened).toEqual({
      contextWindow: current.contextWindow,
      maxInputTokens: current.maxInputTokens,
      maxOutputTokens: current.maxOutputTokens,
    });
    expect(policy.model).toMatchObject({ contextWindow: 70_000, maxInputTokens: 50_000, maxOutputTokens: 8_000 });
    // The frozen policy legitimately retains the registry map's "registry-only": 90_000 entry,
    // so a blanket substring ban cannot prove the observed clamp stayed out. Prove non-mutation
    // instead: deep-frozen snapshot equality across both clamp calls, exact model caps, the
    // registry-only entry retained, and no observed fields on the model projection.
    const beforeSnapshot = JSON.stringify(policy);
    clampObservedModelLimits(policy.model, { contextWindow: 90_000, maxInputTokens: 60_000, maxOutputTokens: 12_000 });
    clampObservedModelLimits(policy.model, { contextWindow: 40_000, maxInputTokens: 30_000, maxOutputTokens: 4_000 });
    expect(JSON.stringify(policy)).toBe(beforeSnapshot);
    expect(policy.provider.modelContextWindows?.["registry-only"]).toBe(90_000);
    expect(policy.model).not.toHaveProperty("observedContextWindow");
  });

  test("hard pins outrank explicit model adapters and registry wire defaults", () => {
    const modelId = Object.keys(captureWireAdapterHardPins("opencode-go"))[0]!;
    const entry = registry({
      id: "opencode-go",
      modelWireDefaults: { [modelId]: "openai-responses" },
    });
    const policy = resolveModelPolicy({
      providerName: "opencode-go",
      modelId,
      provider: provider({ modelAdapters: { [modelId]: "openai-chat" } }),
      registryEntry: entry,
      transportMatchedRegistry: true,
    });
    expect(policy.model.adapter).toBe("anthropic");
    expect(policy.provenance.model.adapter).toBe("hard-pin");
    expect(policy.model.adapter).toBe(resolveWireProtocolOverride(
      "opencode-go",
      modelId,
      provider({ modelAdapters: { [modelId]: "openai-chat" } }),
    ).adapter);
  });

  test("explicit wire override beats a registry default and an explicit provider adapter opts out", () => {
    const entry = registry({ modelWireDefaults: { [MODEL]: "openai-responses" } });
    const explicit = resolve(provider({ modelAdapters: { [MODEL]: "openai-responses" } }), entry);
    const optOut = resolve(provider({ modelAdapters: { [MODEL]: "openai-chat" } }), entry);
    expect(explicit.model.adapter).toBe("openai-responses");
    expect(explicit.provenance.model.adapter).toBe("operator");
    expect(optOut.model.adapter).toBe("openai-chat");
    expect(optOut.provenance.model.adapter).toBe("operator");
  });

  test("captured alias decisions preserve explicit null and registry provenance", () => {
    const disabled = resolveModelPolicy({
      providerName: "fixture-provider",
      modelId: MODEL,
      provider: provider(),
      registryEntry: registry(),
      transportMatchedRegistry: true,
      effectiveAlias: null,
      effectiveAliasSource: "operator",
    });
    const capturedRegistry = resolveModelPolicy({
      providerName: "fixture-provider",
      modelId: MODEL,
      provider: provider(),
      registryEntry: registry(),
      transportMatchedRegistry: true,
      effectiveAlias: "registry-alias",
      effectiveAliasSource: "registry",
    });
    expect(disabled.effectiveAlias).toBeNull();
    expect(disabled.provenance.alias).toBe("operator");
    expect(capturedRegistry.effectiveAlias).toBe("registry-alias");
    expect(capturedRegistry.provenance.alias).toBe("registry");
  });

  test("captured registry alias matches the current collision-aware decision", () => {
    const entry = PROVIDER_REGISTRY.find(candidate => candidate.alias !== undefined)!;
    const configured = provider({ adapter: entry.adapter, baseUrl: entry.baseUrl, authMode: entry.authKind });
    const config = { providers: { [entry.id]: configured } };
    const current = effectiveProviderAliasDecision(entry.id, configured, config);
    const policy = resolveModelPolicy({
      providerName: entry.id,
      modelId: entry.defaultModel ?? "fixture-model",
      provider: configured,
      registryEntry: entry,
      transportMatchedRegistry: true,
      effectiveAlias: current,
      effectiveAliasSource: "registry",
    });
    expect(policy.effectiveAlias).toBe(current);
    expect(policy.provenance.alias).toBe("registry");
  });

  test("model alias policy resolves against the post-alias native identity", () => {
    const configured = provider({ modelAliases: { [MODEL]: "short-selector" } });
    const resolved = resolveModelAlias({ defaultModelAliases: false }, configured, [MODEL], "short-selector");
    expect(resolved).toBe(MODEL);
    const policy = resolveModelPolicy({
      providerName: "fixture-provider",
      modelId: resolved!,
      provider: configured,
      registryEntry: registry(),
      transportMatchedRegistry: true,
    });
    expect(policy.modelId).toBe(MODEL);
    expect(policy.model.contextWindow).toBe(100_000);
  });

  test("virtual model policy resolves against the post-rewrite wire identity", () => {
    const entry = PROVIDER_REGISTRY.find(candidate => candidate.virtualModels !== undefined)!;
    const selectedModelId = Object.keys(entry.virtualModels!)[0]!;
    const resolution = resolveOpenAiVirtualModel(entry.id, selectedModelId)!;
    const configured = provider({ adapter: entry.adapter, baseUrl: entry.baseUrl, authMode: entry.authKind });
    const policy = resolveModelPolicy({
      providerName: entry.id,
      modelId: resolution.wireModelId,
      provider: configured,
      registryEntry: entry,
      transportMatchedRegistry: true,
    });
    expect(policy.modelId).toBe(resolution.wireModelId);
    expect(policy.modelId).not.toBe(resolution.selectedModelId);
  });

  test("repeat resolution is deeply equal, frozen, and detached", () => {
    const configured = provider({ modelInputModalities: { [MODEL]: ["text"] } });
    const entry = registry();
    const input = {
      providerName: "fixture-provider",
      modelId: MODEL,
      provider: configured,
      registryEntry: entry,
      transportMatchedRegistry: true,
    } as const;
    const first = resolveModelPolicy(input);
    const second = resolveModelPolicy(input);
    expect(first).toEqual(second);
    expect(first).not.toBe(second);
    expect(first.provider).not.toBe(second.provider);
    expect(first.model).not.toBe(second.model);
    expect(first.model.inputModalities).not.toBe(second.model.inputModalities);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(second)).toBe(true);
  });

  test("stale direct-effort budget classification matches current route repair", () => {
    const entry = PROVIDER_REGISTRY.find(candidate => candidate.id === "alibaba-token-plan")!;
    const directModel = entry.directReasoningEffortModels![0]!;
    const configured = provider({
      adapter: entry.adapter,
      baseUrl: entry.baseUrl,
      authMode: entry.authKind,
      thinkingBudgetModels: [directModel, ...(entry.thinkingBudgetModels ?? [])],
    });
    const current = routedProviderConfig(entry.id, configured);
    const policy = resolveModelPolicy({
      providerName: entry.id, modelId: directModel, provider: configured,
      registryEntry: entry, transportMatchedRegistry: true,
    });
    expect(policy.provider.thinkingBudgetModels).toEqual(current.thinkingBudgetModels);
    expect(policy.provider.modelReasoningEfforts?.[directModel]).toEqual(current.modelReasoningEfforts?.[directModel]);
    expect(policy.provider.modelDefaultReasoningEfforts?.[directModel]).toEqual(current.modelDefaultReasoningEfforts?.[directModel]);
    expect(policy.provider.modelReasoningEffortMap?.[directModel]).toEqual(current.modelReasoningEffortMap?.[directModel]);
  });

  test.each(["cline-pass", "mimo-free"])("%s stale live discovery matches static route authority", id => {
    const entry = PROVIDER_REGISTRY.find(candidate => candidate.id === id)!;
    const configured = provider({ adapter: entry.adapter, baseUrl: entry.baseUrl, authMode: entry.authKind, liveModels: true });
    const current = routedProviderConfig(id, configured);
    const policy = resolveModelPolicy({
      providerName: id, modelId: entry.defaultModel ?? MODEL, provider: configured,
      registryEntry: entry, transportMatchedRegistry: true,
      effectiveAuth: { authMode: current.authMode! },
    });
    expect(policy.provider.liveModels).toBe(current.liveModels);
    expect(policy.provider.liveModels).toBe(false);
  });

  test("historical ClinePass ladder matches current route repair", () => {
    const entry = PROVIDER_REGISTRY.find(candidate => candidate.id === "cline-pass")!;
    const configured = provider({
      adapter: entry.adapter, baseUrl: entry.baseUrl, authMode: entry.authKind,
      reasoningWireFormat: "gateway-object", reasoningEfforts: ["low"],
    });
    const current = routedProviderConfig(entry.id, configured);
    const policy = resolveModelPolicy({
      providerName: entry.id, modelId: entry.defaultModel!, provider: configured,
      registryEntry: entry, transportMatchedRegistry: true,
    });
    expect(policy.provider.reasoningEfforts).toEqual(current.reasoningEfforts);
  });

  test("custom ClinePass destination keeps an intentional low-only gateway ladder", () => {
    const entry = PROVIDER_REGISTRY.find(candidate => candidate.id === "cline-pass")!;
    const configured = provider({
      adapter: entry.adapter,
      baseUrl: "https://custom-cline-pass.invalid/v1",
      authMode: entry.authKind,
      reasoningWireFormat: "gateway-object",
      reasoningEfforts: ["low"],
    });
    const current = routedProviderConfig(entry.id, configured);
    const policy = resolveModelPolicy({
      providerName: entry.id,
      modelId: entry.defaultModel!,
      provider: configured,
      registryEntry: entry,
      transportMatchedRegistry: false,
    });
    expect(policy.provider.reasoningEfforts).toEqual(current.reasoningEfforts);
    expect(policy.provider.reasoningEfforts).toEqual(["low"]);
    expect(policy.provenance.provider.reasoningEfforts).toBe("operator");
  });

  test("Anthropic numeric-family context matches current catalog fallback", () => {
    const entry = PROVIDER_REGISTRY.find(candidate => (
      candidate.adapter === "anthropic" && Object.keys(candidate.modelContextWindows ?? {}).length > 0
    ))!;
    const family = Object.keys(entry.modelContextWindows!)[0]!;
    const pointRelease = `${family}-20260919`;
    const configured = provider({
      adapter: entry.adapter, baseUrl: entry.baseUrl, authMode: entry.authKind,
      modelContextWindows: { ...entry.modelContextWindows },
    });
    const current = applyProviderConfigHints(entry.id, configured, { provider: entry.id, id: pointRelease });
    const policy = resolveModelPolicy({
      providerName: entry.id, modelId: pointRelease, provider: configured,
      registryEntry: entry, transportMatchedRegistry: true,
    });
    expect(policy.model.contextWindow).toBe(current.contextWindow);
  });

  test("resolved max input never exceeds the resolved context", () => {
    const configured = provider({ modelContextWindows: { [MODEL]: 70_000 }, modelMaxInputTokens: { [MODEL]: 90_000 } });
    const policy = resolveModelPolicy({
      providerName: "custom", modelId: MODEL,
      provider: configured,
      transportMatchedRegistry: false,
    });
    const current = applyProviderConfigHints("custom", configured, { provider: "custom", id: MODEL });
    expect(policy.model.maxInputTokens).toBe(current.maxInputTokens);
    expect(policy.model).toMatchObject({ contextWindow: 70_000, maxInputTokens: 70_000 });
    expect(clampObservedModelLimits(policy.model, { maxInputTokens: 80_000 }))
      .toMatchObject({ contextWindow: 70_000, maxInputTokens: 70_000 });
  });

  test("override URL rejection and template fallback match current routing", () => {
    const entry = PROVIDER_REGISTRY.find(candidate => candidate.allowBaseUrlOverride === true)!;
    const configured = provider({ adapter: entry.adapter, baseUrl: "{unresolved}", authMode: entry.authKind });
    expect(() => routedProviderConfig(entry.id, configured)).toThrow(/Invalid baseUrl/);
    expect(() => resolveModelPolicy({
      providerName: entry.id, modelId: entry.defaultModel ?? MODEL, provider: configured,
      registryEntry: entry, transportMatchedRegistry: true,
    })).toThrow(/Invalid baseUrl/);
    const template = registry({ baseUrl: "https://{region}.invalid/v1", allowBaseUrlOverride: false });
    const fallback = resolveModelPolicy({
      providerName: template.id, modelId: MODEL,
      provider: provider({ baseUrl: "{unresolved}" }), registryEntry: template, transportMatchedRegistry: true,
    });
    expect(fallback.provider.baseUrl).toBe(template.baseUrl);
    expect(fallback.provenance.provider.baseUrl).toBe("registry");
  });

  test("absent override URL matches current Invalid baseUrl oracle while templates fall back", () => {
    const entry = PROVIDER_REGISTRY.find(candidate => candidate.allowBaseUrlOverride === true)!;
    const absent = { adapter: entry.adapter, authMode: entry.authKind } as OcxProviderConfig;
    expect(() => routedProviderConfig(entry.id, absent))
      .toThrow(`Invalid baseUrl for provider "${entry.id}": expected a nonblank URL without unresolved placeholders`);
    expect(() => resolveModelPolicy({
      providerName: entry.id,
      modelId: entry.defaultModel ?? MODEL,
      provider: absent,
      registryEntry: entry,
      transportMatchedRegistry: true,
    })).toThrow(`Invalid baseUrl for provider "${entry.id}": expected a nonblank URL without unresolved placeholders`);
    const template = registry({ baseUrl: "https://{region}.invalid/v1", allowBaseUrlOverride: false });
    const templateAbsent = { adapter: template.adapter, authMode: template.authKind } as OcxProviderConfig;
    const fallback = resolveModelPolicy({
      providerName: template.id,
      modelId: MODEL,
      provider: templateAbsent,
      registryEntry: template,
      transportMatchedRegistry: true,
    });
    expect(fallback.provider.baseUrl).toBe(template.baseUrl);
    expect(fallback.provenance.provider.baseUrl).toBe("registry");
  });

  test("captured key-auth service-tier overlay matches current authority and preserves false", () => {
    const entry = PROVIDER_REGISTRY.find(candidate => candidate.keyAuthServiceTier !== undefined)!;
    const modelId = Object.keys(entry.keyAuthServiceTier?.modelSupportsServiceTier ?? entry.modelSupportsServiceTier ?? {})[0] ?? MODEL;
    const keyConfigured = provider({ adapter: entry.adapter, baseUrl: entry.baseUrl, authMode: "key" });
    const keyAuthority = captureFastPolicyAuthority(entry.id, keyConfigured, true);
    const keyPolicy = resolveModelPolicy({
      providerName: entry.id, modelId, provider: keyConfigured,
      registryEntry: entry, transportMatchedRegistry: true, effectiveAuth: { authMode: "key" },
    });
    const oauthPolicy = resolveModelPolicy({
      providerName: entry.id, modelId,
      provider: provider({ adapter: entry.adapter, baseUrl: entry.baseUrl, authMode: "oauth" }),
      registryEntry: entry, transportMatchedRegistry: true, effectiveAuth: { authMode: "oauth" },
    });
    expect(keyPolicy.provider.supportsServiceTier).toBe(keyAuthority.capability.provider);
    expect(keyPolicy.provider.supportsServiceTier).not.toBe(oauthPolicy.provider.supportsServiceTier);
    const configured = provider({
      adapter: entry.adapter, baseUrl: entry.baseUrl, authMode: "key",
      supportsServiceTier: false, chatServiceTier: false,
      modelSupportsServiceTier: { [modelId]: false },
    });
    const authority = captureFastPolicyAuthority(entry.id, configured, true);
    const policy = resolveModelPolicy({
      providerName: entry.id, modelId, provider: configured,
      registryEntry: entry, transportMatchedRegistry: true, effectiveAuth: { authMode: "key" },
    });
    expect(policy.provider.supportsServiceTier).toBe(authority.capability.provider);
    expect(policy.provider.chatServiceTier).toBe(authority.capability.chatServiceTier);
    expect(policy.model.supportsServiceTier).toBe(authority.capability.models[modelId]);
    expect(policy.model.supportsServiceTier).toBe(false);
  });

  test("unlisted key-auth model inherits provider service tier with registry provenance", () => {
    const entry = PROVIDER_REGISTRY.find(candidate => candidate.id === "xai")!;
    const modelId = "grok-4.20-multi-agent-0309";
    expect(entry.modelSupportsServiceTier?.[modelId]).toBeUndefined();
    const configured = provider({ adapter: entry.adapter, baseUrl: entry.baseUrl, authMode: "key" });
    const authority = captureFastPolicyAuthority(entry.id, configured, true);
    const policy = resolveModelPolicy({
      providerName: entry.id,
      modelId,
      provider: configured,
      registryEntry: entry,
      transportMatchedRegistry: true,
      effectiveAuth: { authMode: "key" },
    });
    expect(policy.model.supportsServiceTier).toBe(authority.capability.provider);
    expect(policy.model.supportsServiceTier).toBe(true);
    expect(policy.provenance.model.supportsServiceTier).toBe("registry");
  });

  test("provider default output fallback and provenance match current route", () => {
    const entry = PROVIDER_REGISTRY.find(candidate => candidate.defaultMaxOutputTokens !== undefined)!;
    const configured = provider({ adapter: entry.adapter, baseUrl: entry.baseUrl, authMode: entry.authKind });
    const current = routedProviderConfig(entry.id, configured);
    const policy = resolveModelPolicy({
      providerName: entry.id, modelId: entry.defaultModel ?? MODEL, provider: configured,
      registryEntry: entry, transportMatchedRegistry: true,
    });
    expect(policy.model.maxOutputTokens).toBe(current.defaultMaxOutputTokens);
    expect(policy.provenance.model.maxOutputTokens).toBe("registry");
  });

  test("lower-cap merge is scoped to the canonical API-key provider", () => {
    const apiEntry = PROVIDER_REGISTRY.find(candidate => candidate.id === "openai-apikey")!;
    const apiModel = Object.keys(apiEntry.modelMaxInputTokens ?? {})[0]!;
    const apiConfigured = provider({
      adapter: apiEntry.adapter, baseUrl: apiEntry.baseUrl, authMode: apiEntry.authKind,
      modelContextWindows: { [apiModel]: apiEntry.modelContextWindows![apiModel]! + 1_000 },
      modelMaxInputTokens: { [apiModel]: apiEntry.modelMaxInputTokens![apiModel]! + 1_000 },
    });
    const apiCurrent = routedProviderConfig(apiEntry.id, apiConfigured);
    const api = resolveModelPolicy({
      providerName: apiEntry.id, modelId: apiModel, provider: apiConfigured,
      registryEntry: apiEntry, transportMatchedRegistry: true,
    });
    expect(api.model.contextWindow).toBe(apiCurrent.modelContextWindows?.[apiModel]);
    expect(api.model.maxInputTokens).toBe(apiCurrent.modelMaxInputTokens?.[apiModel]);
    const entry = PROVIDER_REGISTRY.find(candidate => (
      candidate.id !== "openai-apikey" && Object.keys(candidate.modelContextWindows ?? {}).length > 0
    ))!;
    const modelId = Object.keys(entry.modelContextWindows!)[0]!;
    const configured = provider({
      adapter: entry.adapter, baseUrl: entry.baseUrl, authMode: entry.authKind,
      modelContextWindows: { [modelId]: entry.modelContextWindows![modelId]! + 1_000 },
    });
    const ordinaryCurrent = routedProviderConfig(entry.id, configured);
    const ordinary = resolveModelPolicy({
      providerName: entry.id, modelId, provider: configured,
      registryEntry: entry, transportMatchedRegistry: true,
    });
    expect(ordinary.model.contextWindow).toBe(ordinaryCurrent.modelContextWindows?.[modelId]);
  });

  test("selected base URL carries operator provenance", () => {
    const entry = PROVIDER_REGISTRY.find(candidate => candidate.allowBaseUrlOverride === true)!;
    const configured = provider({
      adapter: entry.adapter, baseUrl: "https://operator.invalid/v1", authMode: entry.authKind,
    });
    const current = routedProviderConfig(entry.id, configured);
    const policy = resolveModelPolicy({
      providerName: entry.id, modelId: MODEL, provider: configured,
      registryEntry: entry, transportMatchedRegistry: true,
    });
    expect(policy.provider.baseUrl).toBe(current.baseUrl);
    expect(policy.provenance.provider.baseUrl).toBe("operator");
  });

  test("result is detached, recursively frozen, and excludes mutable request evidence", () => {
    const configured = provider({
      apiKey: "secret-value",
      _apiKeyAttempt: { entryId: "account-like-private-id" },
      modelInputModalities: { [MODEL]: ["text"] },
    });
    const entry = registry();
    const policy = resolve(configured, entry);
    configured.modelInputModalities![MODEL]!.push("audio");
    entry.modelContextWindows![MODEL] = 1;
    expect(policy.model.inputModalities).toEqual(["text"]);
    expect(policy.model.contextWindow).toBe(100_000);
    expect(Object.isFrozen(policy)).toBe(true);
    expect(Object.isFrozen(policy.provider)).toBe(true);
    expect(Object.isFrozen(policy.model.inputModalities)).toBe(true);
    expect(JSON.stringify(policy)).not.toContain("secret-value");
    expect(JSON.stringify(policy)).not.toContain("account-like-private-id");
  });

  test("case-varied modelReasoningEffortMap override claims the registry row", () => {
    const entry = registry({
      modelReasoningEffortMap: { [MODEL]: { low: "registry-low", xhigh: "registry-xhigh" } },
    });
    const configured = provider({
      modelReasoningEffortMap: { "VENDOR/Model-A": { xhigh: "custom" } },
    });
    const policy = resolve(configured, entry);
    const map = policy.provider.modelReasoningEffortMap;
    expect(map).not.toHaveProperty(MODEL);
    expect(map?.["VENDOR/Model-A"]).toEqual({ low: "registry-low", xhigh: "custom" });
    // The folded runtime lookup must resolve the operator row, not a registry-spelled shadow.
    expect(modelRecordValue(map, MODEL)).toEqual({ low: "registry-low", xhigh: "custom" });
  });

  test("case-varied operator key reports operator provenance for the folded model id", () => {
    const entry = registry({
      modelContextWindows: { "claude-opus-5": 200_000 },
    });
    const configured = provider({
      modelContextWindows: { "Claude-Opus-5": 150_000 },
    });
    const policy = resolveModelPolicy({
      providerName: "anthropic",
      modelId: "claude-opus-5",
      provider: configured,
      registryEntry: entry,
      transportMatchedRegistry: true,
    });
    expect(policy.model.contextWindow).toBe(150_000);
    expect(policy.provenance.model.contextWindow).toBe("operator");
  });

  test.each([50_000, 150_000])("case-varied API-key caps retain the lower limit for operator cap %i", (cap) => {
    const operatorKey = "VENDOR/Model-A";
    const entry = registry({ id: "openai-apikey" });
    const configured = provider({
      modelContextWindows: { [operatorKey]: cap },
      modelMaxInputTokens: { [operatorKey]: cap - 10_000 },
    });
    for (const modelId of [MODEL, operatorKey, "Vendor/model-a"]) {
      const policy = resolveModelPolicy({
        providerName: "openai-apikey", modelId, provider: configured,
        registryEntry: entry, transportMatchedRegistry: true,
      });
      expect(policy.model.contextWindow).toBe(Math.min(100_000, cap));
      expect(policy.model.maxInputTokens).toBe(Math.min(80_000, cap - 10_000));
      expect(policy.provider.modelContextWindows).not.toHaveProperty(MODEL);
      expect(policy.provider.modelMaxInputTokens).not.toHaveProperty(MODEL);
      expect(policy.provenance.model.contextWindow).toBe("operator");
      expect(policy.provenance.model.maxInputTokens).toBe("operator");
      expect(policy.provider.modelContextWindows?.["registry-only"]).toBe(90_000);
    }
    expect(configured.modelContextWindows).toEqual({ [operatorKey]: cap });
    expect(entry.modelContextWindows?.[MODEL]).toBe(100_000);
  });
});
