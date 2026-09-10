/**
 * `chatCompletionsPath` is the mirror of `responsesPath`: a relative send path for the
 * openai-chat wire.
 *
 * It exists because a per-model wire override swaps `provider.adapter` and leaves
 * `provider.baseUrl` alone (src/server/adapter-resolve.ts). An upstream that serves Chat
 * Completions and Responses under different prefixes therefore cannot be reached by the
 * adapter swap by itself. Z.AI is exactly that shape: `/api/v1/responses` and
 * `/api/coding/paas/v4/chat/completions` on one host and one key, with
 * `/api/v1/chat/completions` answering 403.
 */
import { describe, expect, test } from "bun:test";
import { createOpenAIChatAdapter } from "../../../src/adapters/openai-chat";
import { routeModel } from "../../../src/router";
import type { OcxConfig, OcxParsedRequest, OcxProviderConfig } from "../../../src/types";

function parsed(modelId: string): OcxParsedRequest {
  return {
    modelId,
    context: { messages: [{ role: "user", content: "hello", timestamp: 0 }] },
    stream: false,
    options: {},
  };
}

describe("openai-chat send path override", () => {
  test("without the field the adapter keeps appending /chat/completions to baseUrl", () => {
    const provider: OcxProviderConfig = { adapter: "openai-chat", baseUrl: "https://example.test/v1" };
    const req = createOpenAIChatAdapter(provider).buildRequest(parsed("some-model"));
    expect(req.url).toBe("https://example.test/v1/chat/completions");
  });

  test("a configured path replaces the whole suffix, trailing slash and all", () => {
    const provider: OcxProviderConfig = {
      adapter: "openai-chat",
      baseUrl: "https://example.test/",
      chatCompletionsPath: "/api/other/v4/chat/completions",
    };
    const req = createOpenAIChatAdapter(provider).buildRequest(parsed("some-model"));
    expect(req.url).toBe("https://example.test/api/other/v4/chat/completions");
  });

  test("the zai row carries both wires, so a Chat opt-in reaches the Chat prefix", () => {
    const config: OcxConfig = {
      port: 10100,
      defaultProvider: "zai",
      providers: { zai: { adapter: "openai-responses", baseUrl: "https://api.z.ai" } },
    };
    const routed = routeModel(config, "zai/glm-5.3").provider;
    // Both paths are seeded from the registry onto the resolved provider.
    expect(routed.responsesPath).toBe("/api/v1/responses");
    expect(routed.chatCompletionsPath).toBe("/api/coding/paas/v4/chat/completions");
    // Opting a model back into Chat only swaps the adapter; the path field is what keeps
    // the request off `https://api.z.ai/chat/completions`, which is not an endpoint.
    const req = createOpenAIChatAdapter({ ...routed, adapter: "openai-chat" }).buildRequest(parsed("glm-5.3"));
    expect(req.url).toBe("https://api.z.ai/api/coding/paas/v4/chat/completions");
  });
});
