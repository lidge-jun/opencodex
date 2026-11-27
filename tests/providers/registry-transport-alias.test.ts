import { expect, test } from "bun:test";
import { enrichProviderFromRegistry } from "../../src/providers/derive";
import { providerMatchesRegistryTransport, registryEntryForProviderDestination } from "../../src/providers/registry";
import { deepseekReasoningMapFor, THINKING_BUDGET_EFFORTS } from "../../src/providers/registry/model-seeds";
import { captureRouteStaticPolicy, routedProviderConfig } from "../../src/router";
import type { OcxConfig, OcxProviderConfig } from "../../src/types";
import { projectStaleModelRosters, STALE_MODEL_ROSTERS } from "../../src/providers/stale-model-roster-migration";
import { planNativeChatReasoningReplay } from "../../src/adapters/openai-chat/reasoning-replay";
import { extractProviderModelItems, resolveProviderModelDiscovery } from "../../src/providers/model-discovery";
import { findExpectedPriceOverlay } from "../../src/usage/expected-prices";
import { NEURALWATT_MODEL_HINTS } from "../../src/providers/registry/model-seeds";

test("a metadata alias on another adapter does not grant registry transport ownership", () => {
  // Volcengine's canonical row moved to Responses; saved Chat rows remain Chat.
  const provider: OcxProviderConfig = {
    adapter: "openai-chat", authMode: "key", apiKey: "test-key",
    baseUrl: "https://ark.cn-beijing.volces.com/api/coding/v3",
  };
  expect(registryEntryForProviderDestination(provider)?.id).toBe("volcengine-coding-plan");
  expect(providerMatchesRegistryTransport("volcengine-coding-plan", provider)).toBe(false);
  expect(routedProviderConfig("volcengine-coding-plan", provider).adapter).toBe("openai-chat");
  expect(captureRouteStaticPolicy("volcengine-coding-plan", "doubao-seed-2.0-code", provider).provider.adapter).toBe("openai-chat");
});

test("the Go inference alias identifies renamed destinations while the preset remains pinned", () => {
  const provider: OcxProviderConfig = {
    adapter: "openai-chat", authMode: "key", apiKey: "test-key",
    baseUrl: "https://opencode.ai/inference/go/v1",
  };
  expect(registryEntryForProviderDestination(provider)?.id).toBe("opencode-go");
  expect(providerMatchesRegistryTransport("opencode-go", provider)).toBe(true);
  expect(routedProviderConfig("opencode-go", provider).baseUrl).toBe("https://opencode.ai/zen/go/v1");
  expect(routedProviderConfig("renamed-go", provider).baseUrl).toBe(provider.baseUrl);
});

test("non-Alibaba destination aliases fill effort defaults and maps while operator values win", () => {
  // Z.AI's former Chat address carries the GLM-5.3 default; Ark's Chat alias carries a map.
  const zaiUrl = "https://api.z.ai/api/coding/paas/v4";
  const arkUrl = "https://ark.cn-beijing.volces.com/api/coding/v3";
  const registryMap = deepseekReasoningMapFor("deepseek-v4-flash");
  const zai: OcxProviderConfig = { adapter: "openai-chat", baseUrl: zaiUrl };
  const ark: OcxProviderConfig = { adapter: "openai-chat", baseUrl: arkUrl };
  enrichProviderFromRegistry("GLM", zai);
  enrichProviderFromRegistry("ark-chat", ark);
  expect(zai.modelDefaultReasoningEfforts?.["glm-5.3"]).toBe("max");
  expect(ark.modelReasoningEffortMap?.["deepseek-v4-flash"]).toEqual(registryMap);
  expect(routedProviderConfig("GLM", { adapter: "openai-chat", baseUrl: zaiUrl })
    .modelDefaultReasoningEfforts?.["glm-5.3"]).toBe("max");
  expect(routedProviderConfig("ark-chat", { adapter: "openai-chat", baseUrl: arkUrl })
    .modelReasoningEffortMap?.["deepseek-v4-flash"]).toEqual(registryMap);

  const zaiOperator: OcxProviderConfig = {
    adapter: "openai-chat", baseUrl: zaiUrl, modelDefaultReasoningEfforts: { "glm-5.3": "low" },
  };
  const arkOperator: OcxProviderConfig = {
    adapter: "openai-chat", baseUrl: arkUrl, modelReasoningEffortMap: { "deepseek-v4-flash": { medium: "low" } },
  };
  const zaiRouted = routedProviderConfig("GLM", zaiOperator);
  const arkRouted = routedProviderConfig("ark-chat", arkOperator);
  enrichProviderFromRegistry("GLM", zaiOperator);
  enrichProviderFromRegistry("ark-chat", arkOperator);
  for (const row of [zaiOperator, zaiRouted]) {
    expect(row.modelDefaultReasoningEfforts?.["glm-5.3"]).toBe("low");
    expect(row.modelDefaultReasoningEfforts?.["glm-5.3-flash"]).toBe("max");
  }
  for (const row of [arkOperator, arkRouted]) {
    expect(row.modelReasoningEffortMap?.["deepseek-v4-flash"]).toEqual({ ...registryMap, medium: "low" });
  }
});

test("Neuralwatt refreshes only the old seed", () => {
  const seed = STALE_MODEL_ROSTERS.find(entry => entry.provider === "neuralwatt")!;
  const baseUrl = "https://api.neuralwatt.com/v1";
  const config: OcxConfig = { port: 10100, providers: { neuralwatt: {
    adapter: "openai-chat", baseUrl, models: [...seed.from],
  } } };
  expect(projectStaleModelRosters(config).changed).toBe(true);
  expect(config.providers.neuralwatt?.models).toContain("deepseek-v4.1-flash");
  config.providers.neuralwatt!.models = [...seed.from, "custom-model"];
  expect(projectStaleModelRosters(config).changed).toBe(false);
});

test("Neuralwatt keeps Kimi sampling locks and the Qwen 3.6 thinking budget", () => {
  const routed = routedProviderConfig("neuralwatt", { adapter: "openai-chat", baseUrl: "https://api.neuralwatt.com/v1" });
  for (const field of ["noTemperatureModels", "noTopPModels", "noPenaltyModels"] as const) {
    expect(routed[field]).toEqual(expect.arrayContaining(["kimi-k3.1-pro", "nw-large", "kimi-k2.7-code"]));
  }
  expect(routed.autoToolChoiceOnlyModels).toEqual(["kimi-k2.7-code"]);
  expect(routed.thinkingBudgetModels).toContain("qwen3.6-35b");
  expect(routed.modelReasoningEfforts?.["qwen3.6-35b"]).toEqual(THINKING_BUDGET_EFFORTS);
});

test("Neuralwatt discovers chat models but excludes decision models on either OpenAI wire", () => {
  const data = [{ id: "nw-flash" }, { id: "mammoth-1", metadata: { capabilities: { task: "decision" } } }];
  for (const adapter of ["openai-chat", "openai-responses"]) {
    const provider = { adapter, baseUrl: "https://api.neuralwatt.com/v1" };
    const discovery = resolveProviderModelDiscovery("neuralwatt", provider);
    expect(extractProviderModelItems({ data }, discovery)).toEqual({ ok: true, rawCount: 2, items: [data[0]] });
  }
});

test("Neuralwatt Chat replays reasoning for DeepSeek and its advertised aliases", () => {
  const provider = routedProviderConfig("neuralwatt", {
    adapter: "openai-chat", baseUrl: "https://api.neuralwatt.com/v1",
    preserveReasoningContentModels: ["glm-5.3"], // Already-saved, stale preset.
  });
  for (const model of ["deepseek-v4.1-flash", "deepseek-v4.1-flash-flex", "deepseek-v4.1-flash-speed", "nw-flash", "nw-flash-flex"]) {
    const messages = [{ role: "assistant", content: "Working", reasoning: "Trace marker" }];
    expect(planNativeChatReasoningReplay(messages, provider, model, undefined, true).apply()[0])
      .toMatchObject({ reasoning_content: "Trace marker" });
  }
});

test("every seeded Neuralwatt chat model has a list-price estimate", () => {
  for (const id of NEURALWATT_MODEL_HINTS.models) {
    expect(findExpectedPriceOverlay("neuralwatt", id)?.status, id).toBe("verified-derived");
  }
  expect(findExpectedPriceOverlay("neuralwatt", "nw-flash-flex")?.cost4)
    .toEqual({ input: 0.0975, output: 0.39, cacheRead: 0.00975, cacheWrite: 0 });
});
