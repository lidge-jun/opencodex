import { afterEach, describe, expect, test } from "bun:test";
import { DEVIN_MODEL_CONTEXT_WINDOWS, DEVIN_STATIC_MODELS } from "../../src/adapters/devin/live-models";
import { kiroNativeEffortField, kiroReasoningMode } from "../../src/adapters/kiro/reasoning";
import { providerConfigSeed } from "../../src/providers/derive";
import { getProviderRegistryEntry, PROVIDER_REGISTRY } from "../../src/providers/registry";
import { resolveWireProtocolOverride } from "../../src/server/adapter-resolve";
import { handleResponses } from "../../src/server/responses/core";
import type { OcxConfig } from "../../src/types";
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";

const TERRA = "gpt-6.1-terra";
const SOL = "gpt-6.1-sol";
const INBOUNDS = ["responses", "chat", "anthropic"] as const;

describe("GPT-6.1 Terra provider rows", () => {
  test("every non-Cursor Terra/Sol seed retains its predecessor and adds Terra", () => {
    for (const entry of PROVIDER_REGISTRY) {
      if (entry.id === "cursor") continue;
      for (const id of entry.models ?? []) {
        if (!/gpt-(5[.-]6-terra|6[.-]1-sol)$/.test(id)) continue;
        const terra = id.replace(/gpt-(5[.-]6-terra|6[.-]1-sol)$/, matched =>
          matched.includes(".") ? TERRA : "gpt-6-1-terra");
        expect(entry.models, `${entry.id}: ${id}`).toContain(terra);
      }
    }
  });

  test("OpenAI API declares the API window, modalities and none..max ladder", () => {
    const entry = getProviderRegistryEntry("openai-apikey")!;
    expect(entry.models).toContain(TERRA);
    expect(entry.models).toContain("gpt-5.6-terra");
    expect(entry.modelContextWindows?.[TERRA]).toBe(1_050_000);
    expect(entry.modelMaxInputTokens?.[TERRA]).toBe(922_000);
    expect(entry.modelMaxOutputTokens?.[TERRA]).toBe(128_000);
    expect(entry.modelInputModalities?.[TERRA]).toEqual(["text", "image"]);
    expect(entry.modelReasoningEfforts?.[TERRA]).toEqual(["none", "low", "medium", "high", "xhigh", "max"]);
    expect(entry.modelReasoningEfforts?.[SOL]).toEqual(["low", "medium", "high", "xhigh", "max"]);
    expect(entry.virtualModels?.[`${TERRA}-pro`]).toBeUndefined();
  });

  test("OpenRouter advertises the 1.05M OpenAI route and Fast eligibility", () => {
    const entry = getProviderRegistryEntry("openrouter")!;
    expect(entry.models).toContain(`openai/${TERRA}`);
    expect(entry.modelContextWindows?.[`openai/${TERRA}`]).toBe(1_050_000);
    expect(entry.modelSupportsServiceTier?.[`openai/${TERRA}`]).toBe(true);
  });

  test.each(["codebuddy", "kiro"])("%s mirrors its own Sol metadata", provider => {
    const entry = getProviderRegistryEntry(provider)!;
    expect(entry.models).toContain(TERRA);
    for (const field of ["modelContextWindows", "modelMaxOutputTokens", "modelReasoningEfforts",
      "modelDefaultReasoningEfforts", "modelInputModalities"] as const) {
      expect(entry[field]?.[TERRA], field).toEqual(entry[field]?.[SOL]);
    }
    expect(entry.modelContextWindows?.[TERRA]).toBe(provider === "kiro" ? 272_000 : 1_000_000);
  });

  test("Kiro uses the Sol native effort field, including xhigh", () => {
    for (const effort of ["low", "medium", "high", "xhigh", "max"]) {
      expect(kiroNativeEffortField(`kiro/gpt-6-1-terra-${effort}`, effort)).toBe("reasoning");
      expect(kiroReasoningMode(TERRA, effort)).toBe(kiroReasoningMode(SOL, effort));
    }
    expect(kiroNativeEffortField("gpt-5.6-terra", "xhigh")).toBeUndefined();
  });

  test("Devin uses its dashed degraded seed and provider-specific 1M window", () => {
    expect(DEVIN_STATIC_MODELS).toContain("gpt-6-1-terra");
    expect(DEVIN_STATIC_MODELS).toContain("gpt-5-6-terra");
    const entry = getProviderRegistryEntry("devin")!;
    expect(entry.models).toContain("gpt-6-1-terra");
    expect(DEVIN_MODEL_CONTEXT_WINDOWS["gpt-6-1-terra"]).toBe(1_000_000);
    expect(entry.modelReasoningEfforts?.["gpt-6-1-terra"])
      .toEqual(entry.modelReasoningEfforts?.["gpt-6-1-sol"]);
  });

  test.each(["github-copilot", "tokenlab"])("%s mirrors Sol wire selection and explicit overrides", provider => {
    const entry = getProviderRegistryEntry(provider)!;
    const seed = providerConfigSeed(entry);
    expect(entry.models).toContain(TERRA);
    for (const inbound of INBOUNDS) {
      const expected = provider === "github-copilot" || inbound === "responses" ? "openai-responses" : "openai-chat";
      expect(resolveWireProtocolOverride(provider, TERRA, seed, inbound).adapter).toBe(expected);
      expect(resolveWireProtocolOverride(provider, TERRA, {
        ...seed, modelAdapters: { [TERRA]: "openai-chat" },
      }, inbound).adapter).toBe("openai-chat");
    }
    expect(resolveWireProtocolOverride("unrelated", TERRA, {
      adapter: "openai-chat", baseUrl: "https://example.test/v1",
    }, "responses").adapter).toBe("openai-chat");
  });

  test("TokenLab retains the 5.6 default and seeds Terra limits", () => {
    const entry = getProviderRegistryEntry("tokenlab")!;
    expect(entry.defaultModel).toBe("gpt-5.6-terra");
    expect(entry.models).toContain("gpt-5.6-terra");
    expect(entry.modelContextWindows?.[TERRA]).toBe(1_050_000);
    expect(entry.modelMaxOutputTokens?.[TERRA]).toBe(128_000);
    expect(entry.modelInputModalities?.[TERRA]).toEqual(["text", "image"]);
  });

  test("Terra is never a provider default and Cursor has no Terra 6.1 seed", () => {
    for (const entry of PROVIDER_REGISTRY) {
      expect(entry.defaultModel ?? "").not.toMatch(/gpt-6[.-]1-terra/);
    }
    expect(getProviderRegistryEntry("cursor")!.models).not.toContain(TERRA);
    expect(getProviderRegistryEntry("openai-apikey")!.defaultModel).toBe("gpt-5.5");
    expect(getProviderRegistryEntry("github-copilot")!.defaultModel).toBe("gpt-4o");
  });
});

describe("GPT-6.1 Terra provider wires through handleResponses", () => {
  const originalFetch = globalThis.fetch;
  let releaseSpendHome: (() => void) | undefined;

  afterEach(() => {
    releaseSpendHome?.();
    releaseSpendHome = undefined;
    globalThis.fetch = originalFetch;
  });

  async function upstream(provider: string, inboundWire: typeof INBOUNDS[number], effort?: string) {
    const seen: Array<{ url: string; body: Record<string, unknown> }> = [];
    globalThis.fetch = (async (input, init) => {
      seen.push({ url: String(input), body: JSON.parse(String(init?.body)) });
      return new Response("data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
    }) as typeof fetch;
    releaseSpendHome = acquireOwnedSpendHome();
    const config = { providers: { [provider]: {
      ...providerConfigSeed(getProviderRegistryEntry(provider)!), authMode: "key", apiKey: "test-key",
    } } } as unknown as OcxConfig;
    await handleResponses(new Request("http://localhost/v1/responses", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: `${provider}/${TERRA}`, input: "ping", stream: true,
        ...(effort ? { reasoning: { effort } } : {}) }),
    }), config, { model: "", provider: "" }, { inboundWire });
    expect(seen).toHaveLength(1);
    return seen[0]!;
  }

  for (const provider of ["github-copilot", "tokenlab"]) {
    test.each(INBOUNDS)(`${provider} Terra reaches the correct endpoint on %s inbound`, async inbound => {
      const seen = await upstream(provider, inbound);
      const responses = provider === "github-copilot" || inbound === "responses";
      const base = provider === "github-copilot" ? "https://api.githubcopilot.com/v1" : "https://api.tokenlab.sh/v1";
      expect(seen.url).toBe(`${base}/${responses ? "responses" : "chat/completions"}`);
      expect(seen.body.model).toBe(TERRA);
    });
  }

  test.each(["none", "ultra"])("API Terra sends %s effort using the API wire ladder", async effort => {
    const seen = await upstream("openai-apikey", "responses", effort);
    expect(seen.url).toBe("https://api.openai.com/v1/responses");
    expect(seen.body.model).toBe(TERRA);
    expect(seen.body.reasoning).toMatchObject({ effort: effort === "ultra" ? "max" : "none" });
  });
});
