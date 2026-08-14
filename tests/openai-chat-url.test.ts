import { describe, expect, test } from "bun:test";
import { createOpenAIChatAdapter } from "../src/adapters/openai-chat";
import { openaiChatCompletionsUrl } from "../src/adapters/openai-chat-url";
import type { OcxParsedRequest, OcxProviderConfig } from "../src/types";

describe("openai-chat URL normalization", () => {
  test("maps the four common paste shapes to the canonical chat endpoint", () => {
    const expected = "https://api.teamwicked.me/v1/chat/completions";
    expect(openaiChatCompletionsUrl("https://api.teamwicked.me/v1")).toBe(expected);
    expect(openaiChatCompletionsUrl("https://api.teamwicked.me/v1/")).toBe(expected);
    expect(openaiChatCompletionsUrl("https://api.teamwicked.me/v1/chat/completions")).toBe(expected);
    expect(openaiChatCompletionsUrl("https://api.teamwicked.me/v1/chat/completions/")).toBe(expected);
  });

  test("trims surrounding whitespace before joining", () => {
    expect(openaiChatCompletionsUrl("  https://api.example.test/v1/  ")).toBe(
      "https://api.example.test/v1/chat/completions",
    );
  });

  test("does not strip /chat/completions from the middle of a path", () => {
    expect(openaiChatCompletionsUrl("https://proxy.example.com/v1/relay")).toBe(
      "https://proxy.example.com/v1/relay/chat/completions",
    );
  });

  test("does not false-positive on a path that only ends in somechat/completions", () => {
    expect(openaiChatCompletionsUrl("https://api.example.com/somechat/completions")).toBe(
      "https://api.example.com/somechat/completions/chat/completions",
    );
  });

  test("buildRequest uses the normalized URL when baseUrl already includes /chat/completions/", () => {
    const provider: OcxProviderConfig = {
      adapter: "openai-chat",
      baseUrl: "https://api.example.test/v1/chat/completions/",
      apiKey: "sk-test",
      authMode: "key",
    };
    const parsed: OcxParsedRequest = {
      modelId: "teamwicked-kimi-k3",
      context: { messages: [{ role: "user", content: "hi", timestamp: 0 }] },
      stream: false,
      options: {},
    };
    const request = createOpenAIChatAdapter(provider).buildRequest(parsed);
    expect(request.url).toBe("https://api.example.test/v1/chat/completions");
  });
});
