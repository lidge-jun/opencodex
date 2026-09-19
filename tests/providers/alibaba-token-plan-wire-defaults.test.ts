/**
 * Alibaba Token Plan (Beijing) serves the same models over both the OpenAI Responses
 * wire and Chat Completions, and Alibaba documents an official Responses API plus a
 * Codex integration guide on the same base (#5097). The registry pins the
 * live-verified models to native Responses for Responses inbound only; chat and
 * anthropic inbound keep the provider-wide chat wire, mirroring the DeepSeek
 * deepseek-v4-flash precedent. The end-to-end cases assert the captured upstream URL
 * because a resolver-only test would pass even if the handleResponses replay flipped
 * the wire back.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { providerConfigSeed } from "../../src/providers/derive";
import { getProviderRegistryEntry } from "../../src/providers/registry";
import { resolveWireProtocolOverride } from "../../src/server/adapter-resolve";
import { handleResponses } from "../../src/server/responses/core";
import type { OcxConfig, OcxProviderConfig } from "../../src/types";
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";

const RESPONSES_INBOUND_DEFAULT = ["qwen3.8-flash", "qwen3.7-plus", "glm-5.3"] as const;
const CHAT_SERVED = ["qwen3.8-max", "qwen3.7-max", "qwen3.6-flash", "deepseek-v4-pro", "glm-5.2"] as const;
const INBOUNDS = ["responses", "chat", "anthropic"] as const;

function tokenPlanProvider(): OcxProviderConfig {
  return { ...providerConfigSeed(getProviderRegistryEntry("alibaba-token-plan")!), apiKey: "sk-test" };
}

describe("pinned Token Plan models ride Responses only on Responses inbound", () => {
  for (const model of RESPONSES_INBOUND_DEFAULT) {
    test(`${model} resolves to openai-responses for responses inbound`, () => {
      expect(resolveWireProtocolOverride("alibaba-token-plan", model, tokenPlanProvider(), "responses").adapter)
        .toBe("openai-responses");
    });

    for (const inbound of ["chat", "anthropic"] as const) {
      test(`${model} stays on the provider chat wire for ${inbound} inbound`, () => {
        expect(resolveWireProtocolOverride("alibaba-token-plan", model, tokenPlanProvider(), inbound).adapter)
          .toBe("openai-chat");
      });
    }
  }
});

describe("unpinned Token Plan models keep the provider chat wire", () => {
  for (const model of CHAT_SERVED) {
    test(`${model} stays on openai-chat for every inbound`, () => {
      for (const inbound of INBOUNDS) {
        expect(resolveWireProtocolOverride("alibaba-token-plan", model, tokenPlanProvider(), inbound).adapter)
          .toBe("openai-chat");
      }
    });
  }
});

describe("explicit modelAdapters beat the Token Plan defaults in both directions", () => {
  test("opt-out: qwen3.8-flash pinned back to chat for responses inbound", () => {
    const provider = { ...tokenPlanProvider(), modelAdapters: { "qwen3.8-flash": "openai-chat" } };
    expect(resolveWireProtocolOverride("alibaba-token-plan", "qwen3.8-flash", provider, "responses").adapter)
      .toBe("openai-chat");
  });

  test("opt-in: an unpinned model mapped to Responses", () => {
    const provider = { ...tokenPlanProvider(), modelAdapters: { "deepseek-v4.1-flash": "openai-responses" } };
    expect(resolveWireProtocolOverride("alibaba-token-plan", "deepseek-v4.1-flash", provider, "responses").adapter)
      .toBe("openai-responses");
  });
});

describe("the Token Plan default is isolated to the registry provider", () => {
  test("qwen3.8-flash on a custom provider is untouched", () => {
    const other: OcxProviderConfig = { adapter: "openai-chat", baseUrl: "https://example.com/v1", apiKey: "sk-test" };
    for (const inbound of INBOUNDS) {
      expect(resolveWireProtocolOverride("some-custom", "qwen3.8-flash", other, inbound).adapter)
        .toBe("openai-chat");
    }
  });

  test("resolution preserves credentials and the base URL through the copy", () => {
    const resolved = resolveWireProtocolOverride("alibaba-token-plan", "qwen3.8-flash", tokenPlanProvider(), "responses");
    expect(resolved.adapter).toBe("openai-responses");
    expect(resolved.apiKey).toBe("sk-test");
    expect(resolved.baseUrl).toBe("https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1");
  });
});

describe("the Token Plan wire default survives the handleResponses replay", () => {
  const originalFetch = globalThis.fetch;
  let releaseSpendHome: (() => void) | undefined;

  afterEach(() => {
    releaseSpendHome?.();
    releaseSpendHome = undefined;
    globalThis.fetch = originalFetch;
  });

  function captureUpstreamUrl(): string[] {
    const urls: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      urls.push(String(input));
      return new Response("data: [DONE]\n\n", {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    }) as typeof fetch;
    return urls;
  }

  async function drive(model: string, inboundWire: "responses" | "chat" | "anthropic"): Promise<string> {
    const urls = captureUpstreamUrl();
    const config = { providers: { "alibaba-token-plan": tokenPlanProvider() } } as unknown as OcxConfig;
    releaseSpendHome ??= acquireOwnedSpendHome();
    await handleResponses(
      new Request("http://localhost/v1/responses", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: `alibaba-token-plan/${model}`, input: "ping", stream: true }),
      }),
      config,
      { model: "", provider: "" },
      { inboundWire },
    );
    return urls[0] ?? "";
  }

  test("qwen3.8-flash reaches the Responses upstream, never /chat/completions", async () => {
    const url = await drive("qwen3.8-flash", "responses");
    expect(url).toContain("token-plan.cn-beijing.maas.aliyuncs.com");
    expect(url).toContain("/responses");
    expect(url).not.toContain("chat/completions");
  });

  test("qwen3.8-flash keeps the chat upstream on a chat inbound replay", async () => {
    const url = await drive("qwen3.8-flash", "chat");
    expect(url).toContain("token-plan.cn-beijing.maas.aliyuncs.com");
    expect(url).toContain("chat/completions");
  });

  test("glm-5.3 keeps the chat upstream on an anthropic inbound replay", async () => {
    const url = await drive("glm-5.3", "anthropic");
    expect(url).toContain("chat/completions");
  });

  test("qwen3.8-max (unpinned) keeps the chat upstream on a responses inbound", async () => {
    const url = await drive("qwen3.8-max", "responses");
    expect(url).toContain("chat/completions");
  });
});
