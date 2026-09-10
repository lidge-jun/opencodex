import { describe, expect, test } from "bun:test";
import { createOpenAIChatAdapter, stripBracketedModelSuffix } from "../../../src/adapters/openai-chat";
import { createResponsesPassthroughAdapter } from "../../../src/adapters/openai-responses";
import { parseRequest } from "../../../src/responses/parser";
import { withTestTranslatorBudget } from "../../helpers/translator-budget";
import { createAnthropicAdapter } from "../../../src/adapters/anthropic";
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

function openaiChatProvider(): OcxProviderConfig {
  return {
    adapter: "openai-chat",
    baseUrl: "https://api.z.ai/api/paas/v4",
    modelSuffixBracketStrip: true,
  };
}

function routedZaiProvider(): OcxProviderConfig {
  const config: OcxConfig = {
    port: 10100,
    defaultProvider: "zai",
    providers: {
      zai: {
        adapter: "openai-chat",
        baseUrl: "https://api.z.ai/api/coding/paas/v4",
      },
    },
  };
  return routeModel(config, "zai/glm-5.2[1m]").provider;
}

function anthropicProvider(): OcxProviderConfig {
  return {
    adapter: "anthropic",
    baseUrl: "https://api.z.ai/api/coding/paas/v4",
    apiKey: "test-key",
  };
}

function wireModel(req: ReturnType<ReturnType<typeof createOpenAIChatAdapter>["buildRequest"]>): unknown {
  return (JSON.parse(req.body as string) as Record<string, unknown>).model;
}

describe("stripBracketedModelSuffix", () => {
  test("strips a trailing [..] suffix", () => {
    expect(stripBracketedModelSuffix("glm-5.2[1m]")).toBe("glm-5.2");
  });

  test("leaves a bare id untouched", () => {
    expect(stripBracketedModelSuffix("glm-5.2")).toBe("glm-5.2");
  });

  test("strips trailing suffix with trailing whitespace", () => {
    expect(stripBracketedModelSuffix("glm-5.2[1m] \t\r\n")).toBe("glm-5.2");
  });

  test("preserves trailing whitespace when there is no suffix", () => {
    const modelId = "glm-5.2 \t\r\n";
    expect(stripBracketedModelSuffix(modelId)).toBe(modelId);
  });

  test("does not strip an interior bracket group", async () => {
    expect(stripBracketedModelSuffix("a[b]c")).toBe("a[b]c");
  });

  test("empty bracket group is still stripped", async () => {
    expect(stripBracketedModelSuffix("model[]")).toBe("model");
  });

  test("strips only the final bracket group", () => {
    expect(stripBracketedModelSuffix("model[first][second]")).toBe("model[first]");
  });

  test("handles a long malformed suffix without regex backtracking", () => {
    const modelId = `model${"[".repeat(100_000)}x`;
    expect(stripBracketedModelSuffix(modelId)).toBe(modelId);
  });

  test("strips a long valid suffix", () => {
    const modelId = `model[${"x".repeat(100_000)}]`;
    expect(stripBracketedModelSuffix(modelId)).toBe("model");
  });

  test("preserves a long unmatched closing bracket", () => {
    const modelId = `model${"x".repeat(100_000)}]`;
    expect(stripBracketedModelSuffix(modelId)).toBe(modelId);
  });
});

describe("openai-chat adapter wire model normalization", () => {
  test("glm-5.2[1m] is sent as bare glm-5.2", async () => {
    const req = createOpenAIChatAdapter(openaiChatProvider()).buildRequest(parsed("glm-5.2[1m]"));
    expect(wireModel(req)).toBe("glm-5.2");
  });

  test("bare glm-5.2 passes through unchanged", async () => {
    const req = createOpenAIChatAdapter(openaiChatProvider()).buildRequest(parsed("glm-5.2"));
    expect(wireModel(req)).toBe("glm-5.2");
  });

  test("an unflagged provider sends glm-5.2[1m] verbatim", async () => {
    const provider: OcxProviderConfig = {
      adapter: "openai-chat",
      baseUrl: "https://example.test/v1",
    };
    const req = createOpenAIChatAdapter(provider).buildRequest(parsed("glm-5.2[1m]"));
    expect(wireModel(req)).toBe("glm-5.2[1m]");
  });

  test("a routed zai config opted back into Chat strips glm-5.2[1m]", async () => {
    // zai defaults to Responses now, so this is the modelAdapters opt-in path: the override
    // swaps the adapter and the row's chatCompletionsPath carries the request to the Chat
    // prefix. The bracket strip has to survive that swap.
    const req = createOpenAIChatAdapter({ ...routedZaiProvider(), adapter: "openai-chat" })
      .buildRequest(parsed("glm-5.2[1m]"));
    expect(wireModel(req)).toBe("glm-5.2");
  });

  test("the Responses wire strips the alias too, on the passthrough body", async () => {
    // The Responses adapter forwards the raw body instead of rebuilding it from the parsed
    // selector, and the router writes the routed id into that raw body. Stripping only the
    // parsed selector would send `glm-5.2[1m]` upstream, which Z.AI answers with a 400.
    const provider = routedZaiProvider();
    expect(provider.adapter).toBe("openai-responses");
    const adapter = withTestTranslatorBudget(createResponsesPassthroughAdapter(provider));
    const req = await adapter.buildRequest(parseRequest({ model: "glm-5.2[1m]", input: "hi" }));
    expect((JSON.parse(req.body as string) as { model?: unknown }).model).toBe("glm-5.2");
    expect(req.url).toBe("https://api.z.ai/api/v1/responses");
  });
});

describe("anthropic adapter leaves the bracketed suffix intact", () => {
  test("glm-5.2[1m] is sent verbatim", async () => {
    const req = await createAnthropicAdapter(anthropicProvider()).buildRequest(parsed("glm-5.2[1m]"));
    const model = (JSON.parse(req.body as string) as Record<string, unknown>).model;
    expect(model).toBe("glm-5.2[1m]");
  });
});
