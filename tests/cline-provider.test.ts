import { describe, expect, test } from "bun:test";
import { PROVIDER_REGISTRY } from "../src/providers/registry";
import { providerConfigSeed, deriveKeyLoginMap, deriveProviderPresets } from "../src/providers/derive";
import { createOpenAIChatAdapter } from "../src/adapters/openai-chat";
import type { OcxParsedRequest, OcxProviderConfig } from "../src/types";

function minimalRequest(model: string): OcxParsedRequest {
  return {
    modelId: model,
    stream: false,
    context: { messages: [{ role: "user", content: "hi" }], tools: [] },
    options: {},
  };
}

describe("cline provider", () => {
  const entry = PROVIDER_REGISTRY.find(e => e.id === "cline");

  test("registry entry exists with correct shape", () => {
    expect(entry).toBeDefined();
    expect(entry?.adapter).toBe("openai-chat");
    expect(entry?.baseUrl).toBe("https://api.cline.bot/api/v1");
    expect(entry?.authKind).toBe("key");
    expect(entry?.dashboardUrl).toBe("https://app.cline.bot");
    expect(entry?.liveModels).toBe(true);
    expect(entry?.preserveCustomDestination).toBe(true);
    expect(entry?.defaultModel).toBe("anthropic/claude-sonnet-4-6");
    expect(entry?.models).toContain("anthropic/claude-sonnet-4-6");
    expect(entry?.models).toContain("minimax/minimax-m2.5");
    expect(entry?.note).toMatch(/usage-billing/i);
  });

  test("is included in the key-login map", () => {
    const keyMap = deriveKeyLoginMap();
    expect(keyMap.cline).toMatchObject({
      adapter: "openai-chat",
      baseUrl: "https://api.cline.bot/api/v1",
      dashboardUrl: "https://app.cline.bot",
    });
  });

  test("appears in the GUI preset picker", () => {
    const presets = deriveProviderPresets();
    const preset = presets.find((p: { id: string }) => p.id === "cline");
    expect(preset).toBeDefined();
    expect(preset?.baseUrl).toBe("https://api.cline.bot/api/v1");
    expect(preset?.defaultModel).toBe("anthropic/claude-sonnet-4-6");
    expect(preset?.note).toBeDefined();
  });

  test("adapter targets the Cline chat completions endpoint with bearer auth", () => {
    const provider: OcxProviderConfig = {
      ...providerConfigSeed(entry!),
      apiKey: "ck-test",
    };
    const req = createOpenAIChatAdapter(provider).buildRequest(minimalRequest("anthropic/claude-sonnet-4-6"));
    const headers = req.headers as Record<string, string>;
    expect(req.url).toBe("https://api.cline.bot/api/v1/chat/completions");
    expect(headers["Authorization"]).toBe("Bearer ck-test");
  });
});

describe("cline-pass provider integration", () => {
  test("sits alongside cline on the same endpoint with distinct curated models", () => {
    const pass = PROVIDER_REGISTRY.find(e => e.id === "cline-pass");
    const cline = PROVIDER_REGISTRY.find(e => e.id === "cline");
    expect(pass?.baseUrl).toBe(cline?.baseUrl);
    expect(pass?.models).not.toEqual(cline?.models);
    expect(pass?.models?.every(id => id.startsWith("cline-pass/"))).toBe(true);
  });
});
