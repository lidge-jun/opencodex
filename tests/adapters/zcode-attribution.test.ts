import { describe, expect, test } from "bun:test";
import { createOpenAIChatAdapter } from "../../src/adapters/openai-chat";
import { createResponsesPassthroughAdapter } from "../../src/adapters/openai-responses";
import type { OcxParsedRequest, OcxProviderConfig } from "../../src/types";
import { withTestTranslatorBudget } from "../helpers/translator-budget";

function parsed(modelId: string): OcxParsedRequest {
  return {
    modelId,
    context: { messages: [{ role: "user", content: "hello", timestamp: 0 }] },
    stream: false,
    options: {},
  };
}

function chatHeaders(provider: OcxProviderConfig): Record<string, string> {
  const adapter = withTestTranslatorBudget(createOpenAIChatAdapter(provider));
  return adapter.buildRequest(parsed("glm-5.3"), { headers: new Headers() }).headers as Record<string, string>;
}

function responsesHeaders(provider: OcxProviderConfig): Record<string, string> {
  const adapter = withTestTranslatorBudget(createResponsesPassthroughAdapter(provider));
  return adapter.buildRequest(parsed("glm-5.3"), { headers: new Headers() }).headers as Record<string, string>;
}

describe("ZCode attribution on plan-metered GLM transports", () => {
  test("chat: coding-plan send path receives identity + coding-plan trace headers", () => {
    // The real preset shape: bare-host baseUrl with the metered path in chatCompletionsPath.
    const headers = chatHeaders({
      adapter: "openai-chat",
      baseUrl: "https://api.z.ai",
      chatCompletionsPath: "/api/coding/paas/v4/chat/completions",
      apiKey: "k",
    });
    expect(headers["X-ZCode-Agent"]).toBe("glm");
    expect(headers["User-Agent"]).toMatch(/^ZCode\//);
    expect(headers["x-query-id"]).toBeDefined();
    expect(headers["x-session-id"]).toBeDefined();
    expect(headers["x-zcode-session-type"]).toBe("main");
  });

  test("chat: legacy full coding baseUrl also attributed", () => {
    const headers = chatHeaders({ adapter: "openai-chat", baseUrl: "https://open.bigmodel.cn/api/coding/paas/v4", apiKey: "k" });
    expect(headers["X-ZCode-Agent"]).toBe("glm");
  });

  test("chat: pay-as-you-go and unrelated destinations are NOT attributed", () => {
    const payg = chatHeaders({ adapter: "openai-chat", baseUrl: "https://open.bigmodel.cn/api/paas/v4", apiKey: "k" });
    expect(payg["X-ZCode-Agent"]).toBeUndefined();
    const other = chatHeaders({ adapter: "openai-chat", baseUrl: "https://api.deepseek.com", apiKey: "k" });
    expect(other["X-ZCode-Agent"]).toBeUndefined();
  });

  test("chat: configured provider headers keep winning over the injected identity", () => {
    const headers = chatHeaders({
      adapter: "openai-chat",
      baseUrl: "https://api.z.ai",
      chatCompletionsPath: "/api/coding/paas/v4/chat/completions",
      apiKey: "k",
      headers: { "X-ZCode-Agent": "custom", "X-Title": "My Title" },
    });
    expect(headers["X-ZCode-Agent"]).toBe("custom");
    expect(headers["X-Title"]).toBe("My Title");
  });

  test("responses: plan-metered responses path (zai preset shape) is attributed", () => {
    const headers = responsesHeaders({
      adapter: "openai-responses",
      baseUrl: "https://api.z.ai",
      responsesPath: "/api/v1/responses",
      apiKey: "k",
    });
    expect(headers["X-ZCode-Agent"]).toBe("glm");
    expect(headers["x-query-id"]).toBeDefined();
  });

  test("responses: forward mode (ChatGPT backend) is never attributed", () => {
    const headers = responsesHeaders({
      adapter: "openai-responses",
      baseUrl: "https://chatgpt.com/backend-api/codex",
      authMode: "forward",
    });
    expect(headers["X-ZCode-Agent"]).toBeUndefined();
    expect(headers["x-query-id"]).toBeUndefined();
  });

  test("responses: default (non-metered) path is not attributed", () => {
    const headers = responsesHeaders({ adapter: "openai-responses", baseUrl: "https://api.x.ai/v1", apiKey: "k" });
    expect(headers["X-ZCode-Agent"]).toBeUndefined();
  });
});
