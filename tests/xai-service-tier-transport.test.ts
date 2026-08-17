import { afterEach, describe, expect, test } from "bun:test";
import { buildOpenAIChatPassthroughRequest } from "../src/adapters/openai-chat";
import { canSerializeServiceTierForChatModel, serviceTierSupportForModel } from "../src/providers/service-tier";
import { providerForNativeChatSerialization } from "../src/server/chat-native";
import { handleResponses } from "../src/server/responses/core";
import type { OcxConfig, OcxProviderConfig } from "../src/types";

const MODEL_ID = "grok-4";

function xaiProvider(overrides: Partial<OcxProviderConfig> = {}): OcxProviderConfig {
  return {
    adapter: "openai-chat",
    baseUrl: "https://api.x.ai/v1",
    apiKey: "xai-test",
    authMode: "key",
    chatServiceTier: true,
    ...overrides,
  };
}

function directChatBody(provider: OcxProviderConfig): Record<string, unknown> {
  const serializationProvider = providerForNativeChatSerialization("xai", provider, MODEL_ID);
  const request = buildOpenAIChatPassthroughRequest(
    serializationProvider,
    {
      messages: [{ role: "user", content: "hello" }],
      service_tier: "priority",
    },
    MODEL_ID,
    false,
  );
  return JSON.parse(request.body) as Record<string, unknown>;
}

describe("xAI Priority Processing transport boundary", () => {
  test("canonical API-key transport is the only xAI Chat transport that advertises Fast", () => {
    const canonical = xaiProvider();
    expect(canSerializeServiceTierForChatModel(canonical, MODEL_ID, "xai")).toBe(true);
    expect(serviceTierSupportForModel(canonical, MODEL_ID, "xai")).toBe(true);

    const trailingSlash = xaiProvider({ baseUrl: "https://api.x.ai/v1/" });
    expect(canSerializeServiceTierForChatModel(trailingSlash, MODEL_ID, "xai")).toBe(true);

    for (const provider of [
      xaiProvider({ authMode: "oauth", baseUrl: "https://cli-chat-proxy.grok.com/v1" }),
      xaiProvider({ baseUrl: "https://relay.example.test/v1" }),
      xaiProvider({ baseUrl: "https://api.x.ai.evil.example/v1" }),
      xaiProvider({ baseUrl: "https://api.x.ai/v1?proxy=1" }),
      xaiProvider({ adapter: "openai-responses" }),
    ]) {
      expect(canSerializeServiceTierForChatModel(provider, MODEL_ID, "xai")).toBe(false);
      expect(serviceTierSupportForModel(provider, MODEL_ID, "xai")).toBe(false);
    }
  });

  test("explicit provider and model opt-outs remain fail-closed on canonical xAI", () => {
    const chatOptOut = xaiProvider({
      chatServiceTier: false,
      modelSupportsServiceTier: { [MODEL_ID]: true },
    });
    expect(canSerializeServiceTierForChatModel(chatOptOut, MODEL_ID, "xai")).toBe(false);
    expect(serviceTierSupportForModel(chatOptOut, MODEL_ID, "xai")).toBe(false);

    const providerOptOut = xaiProvider({ supportsServiceTier: false });
    expect(canSerializeServiceTierForChatModel(providerOptOut, MODEL_ID, "xai")).toBe(false);
    expect(serviceTierSupportForModel(providerOptOut, MODEL_ID, "xai")).toBe(false);

    const modelOptOut = xaiProvider({ modelSupportsServiceTier: { [MODEL_ID]: false } });
    expect(canSerializeServiceTierForChatModel(modelOptOut, MODEL_ID, "xai")).toBe(false);
    expect(serviceTierSupportForModel(modelOptOut, MODEL_ID, "xai")).toBe(false);
  });

  test("native Chat serialization consumes the same transport-aware decision", () => {
    expect(directChatBody(xaiProvider()).service_tier).toBe("priority");

    for (const provider of [
      xaiProvider({ authMode: "oauth", baseUrl: "https://cli-chat-proxy.grok.com/v1" }),
      xaiProvider({ baseUrl: "https://relay.example.test/v1" }),
      xaiProvider({ chatServiceTier: false }),
      xaiProvider({ supportsServiceTier: false }),
      xaiProvider({ modelSupportsServiceTier: { [MODEL_ID]: false } }),
    ]) {
      expect(directChatBody(provider)).not.toHaveProperty("service_tier");
    }
  });
});

describe("xAI transport gate on the live Responses path", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = originalFetch; });

  type CapturedRequest = {
    url: string;
    body: Record<string, unknown>;
  };

  async function responsesRequest(
    provider: OcxProviderConfig,
    rawBody: Record<string, unknown> = {},
    fastMode?: boolean,
  ): Promise<CapturedRequest> {
    const requests: CapturedRequest[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input instanceof Request
        ? input.url
        : input instanceof URL
          ? input.toString()
          : String(input);
      requests.push({
        url,
        body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
      });
      return new Response("data: [DONE]\n\n", {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    }) as typeof fetch;

    const config = {
      providers: { xai: provider },
      ...(fastMode === undefined ? {} : { fastMode }),
    } as unknown as OcxConfig;
    await handleResponses(
      new Request("http://localhost/v1/responses", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: `xai/${MODEL_ID}`,
          input: "ping",
          stream: true,
          ...rawBody,
        }),
      }),
      config,
      { model: "", provider: "" },
      {},
    );
    return requests[0] ?? { url: "", body: {} };
  }

  test("a same-named xAI baseUrl override is pinned canonical before Fast gating", async () => {
    const configured = xaiProvider({ baseUrl: "https://relay.example.test/v1" });

    const fast = await responsesRequest(configured, {}, true);
    expect(fast.url).toBe("https://api.x.ai/v1/chat/completions");
    expect(fast.body.service_tier).toBe("priority");

    const caller = await responsesRequest(configured, { service_tier: "priority" });
    expect(caller.url).toBe("https://api.x.ai/v1/chat/completions");
    expect(caller.body.service_tier).toBe("priority");
  });

  test("canonical xAI opt-outs strip Fast before the request is serialized", async () => {
    const chatOptOut = xaiProvider({ chatServiceTier: false });
    expect((await responsesRequest(chatOptOut, {}, true)).body).not.toHaveProperty("service_tier");

    const modelOptOut = xaiProvider({ modelSupportsServiceTier: { [MODEL_ID]: false } });
    expect((await responsesRequest(modelOptOut, { service_tier: "priority" }, true)).body).not.toHaveProperty("service_tier");
  });
});
