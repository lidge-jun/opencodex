import { describe, expect, test } from "bun:test";
import { createOpenAIChatAdapter } from "../src/adapters/openai-chat";
import { PROVIDER_REGISTRY } from "../src/providers/registry";
import { routeModel } from "../src/router";
import type { OcxConfig, OcxParsedRequest } from "../src/types";

const CLINE_PASS_MODELS = [
  "cline-pass/glm-5.2",
  "cline-pass/kimi-k3",
  "cline-pass/kimi-k2.7-code",
  "cline-pass/kimi-k2.6",
  "cline-pass/deepseek-v4-pro",
  "cline-pass/deepseek-v4-flash",
  "cline-pass/mimo-v2.5",
  "cline-pass/mimo-v2.5-pro",
  "cline-pass/minimax-m3",
  "cline-pass/qwen3.7-max",
  "cline-pass/qwen3.7-plus",
] as const;

const CLINE_PASS_REASONING_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;

// Live probe 2026-08-13 against https://api.cline.bot/api/v1/chat/completions:
// every static ClinePass model accepted every effort above, while an invalid sentinel was
// rejected with the gateway's accepted enum (none|minimal|low|medium|high|xhigh|max).
// This pins ClinePass's INPUT contract only. It deliberately does not claim that every backend
// implements five distinct native compute modes; backend-specific normalization remains ClinePass's job.
function registryEntry() {
  const entry = PROVIDER_REGISTRY.find(provider => provider.id === "cline-pass");
  if (!entry) throw new Error("missing ClinePass registry entry");
  return entry;
}

function parsed(modelId: string, reasoning: string): OcxParsedRequest {
  return {
    modelId,
    context: { messages: [{ role: "user", content: "hello", timestamp: 0 }] },
    stream: false,
    options: { reasoning },
  };
}

const config: OcxConfig = {
  port: 10100,
  defaultProvider: "cline-pass",
  providers: {
    "cline-pass": {
      adapter: "openai-chat",
      baseUrl: "https://api.cline.bot/api/v1",
      apiKey: "cline-test-key",
      authMode: "key",
    },
  },
};

describe("ClinePass reasoning effort capabilities", () => {
  test("registry exposes the full live-probed gateway input ladder provider-wide", () => {
    const entry = registryEntry();

    expect(entry.reasoningEfforts).toEqual([...CLINE_PASS_REASONING_EFFORTS]);
    expect(entry.modelReasoningEfforts).toBeUndefined();
  });

  test("preserves every live-probed effort for every static ClinePass model", () => {
    for (const model of CLINE_PASS_MODELS) {
      for (const effort of CLINE_PASS_REASONING_EFFORTS) {
        const route = routeModel(config, `cline-pass/${model}`);
        const request = createOpenAIChatAdapter(route.provider).buildRequest(parsed(route.modelId, effort));
        const body = JSON.parse(request.body) as Record<string, unknown>;

        expect(route.modelId).toBe(model);
        expect(body.reasoning).toEqual({ enabled: true, effort });
        expect(body).not.toHaveProperty("reasoning_effort");
        expect(request.reasoningLog).toEqual({
          effectiveEffort: effort,
          wireField: "reasoning.effort",
          wireValue: effort,
        });
      }
    }
  });

  test("DeepSeek V4 Flash preserves max instead of clamping it", () => {
    const route = routeModel(config, "cline-pass/cline-pass/deepseek-v4-flash");
    const request = createOpenAIChatAdapter(route.provider).buildRequest(parsed(route.modelId, "max"));
    const body = JSON.parse(request.body) as Record<string, unknown>;

    expect(body.reasoning).toEqual({ enabled: true, effort: "max" });
    expect(request.reasoningLog).toEqual({
      effectiveEffort: "max",
      wireField: "reasoning.effort",
      wireValue: "max",
    });
  });

  test("Codex ultra still crosses the provider boundary as max", () => {
    const route = routeModel(config, "cline-pass/cline-pass/glm-5.2");
    const request = createOpenAIChatAdapter(route.provider).buildRequest(parsed(route.modelId, "ultra"));
    const body = JSON.parse(request.body) as Record<string, unknown>;

    expect(body.reasoning).toEqual({ enabled: true, effort: "max" });
    expect(request.reasoningLog).toEqual({
      effectiveEffort: "max",
      wireField: "reasoning.effort",
      wireValue: "max",
    });
  });

  test("canonical ClinePass repairs the historical generated low-only preset", () => {
    const staleConfig: OcxConfig = {
      ...config,
      providers: {
        "cline-pass": {
          ...config.providers!["cline-pass"],
          reasoningEfforts: ["low"],
          reasoningWireFormat: "gateway-object",
        },
      },
    };
    const route = routeModel(staleConfig, "cline-pass/cline-pass/deepseek-v4-flash");
    const request = createOpenAIChatAdapter(route.provider).buildRequest(parsed(route.modelId, "max"));
    const body = JSON.parse(request.body) as Record<string, unknown>;

    expect(route.provider.reasoningEfforts).toEqual([...CLINE_PASS_REASONING_EFFORTS]);
    expect(body.reasoning).toEqual({ enabled: true, effort: "max" });
    expect(request.reasoningLog).toEqual({
      effectiveEffort: "max",
      wireField: "reasoning.effort",
      wireValue: "max",
    });
  });

  test("does not repair a low-only same-name provider on a custom destination", () => {
    const customConfig: OcxConfig = {
      ...config,
      providers: {
        "cline-pass": {
          ...config.providers!["cline-pass"],
          baseUrl: "https://example.com/v1",
          reasoningEfforts: ["low"],
          reasoningWireFormat: "gateway-object",
        },
      },
    };
    const route = routeModel(customConfig, "cline-pass/cline-pass/deepseek-v4-flash");
    const request = createOpenAIChatAdapter(route.provider).buildRequest(parsed(route.modelId, "max"));
    const body = JSON.parse(request.body) as Record<string, unknown>;

    expect(route.provider.reasoningEfforts).toEqual(["low"]);
    expect(body.reasoning).toEqual({ enabled: true, effort: "low" });
  });
});
