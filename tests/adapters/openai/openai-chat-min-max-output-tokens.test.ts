import { describe, expect, test } from "bun:test";
import { createOpenAIChatAdapter } from "../../../src/adapters/openai-chat";
import { resolveMaxTokens } from "../../../src/adapters/openai-chat/summary-budget";
import type { OcxParsedRequest, OcxProviderConfig } from "../../../src/types";

function provider(overrides: Partial<OcxProviderConfig> = {}): OcxProviderConfig {
  return {
    adapter: "openai-chat",
    baseUrl: "https://example.test/v1",
    apiKey: "sk-test",
    authMode: "key",
    ...overrides,
  };
}

function parsed(maxOutputTokens?: number): OcxParsedRequest {
  return {
    modelId: "test-model",
    context: { messages: [{ role: "user", content: "hi", timestamp: 0 }] },
    stream: false,
    options: maxOutputTokens === undefined ? {} : { maxOutputTokens },
  };
}

describe("resolveMaxTokens minMaxOutputTokens floor", () => {
  test("raises a declared maxOutputTokens below the floor", () => {
    const p = provider({ minMaxOutputTokens: 4096 });
    expect(resolveMaxTokens(p, parsed(512))).toBe(4096);
  });

  test("leaves a declared maxOutputTokens at or above the floor untouched", () => {
    const p = provider({ minMaxOutputTokens: 4096 });
    expect(resolveMaxTokens(p, parsed(8192))).toBe(8192);
    expect(resolveMaxTokens(p, parsed(4096))).toBe(4096);
  });

  test("uses the floor itself when nothing is declared", () => {
    const p = provider({ minMaxOutputTokens: 4096 });
    expect(resolveMaxTokens(p, parsed())).toBe(4096);
  });

  test("a modelMaxOutputTokens record value counts as declared", () => {
    const p = provider({ minMaxOutputTokens: 4096, modelMaxOutputTokens: { "test-model": 2048 } });
    expect(resolveMaxTokens(p, parsed())).toBe(4096);
  });

  test("a defaultMaxOutputTokens value below the floor is raised", () => {
    const p = provider({ minMaxOutputTokens: 4096, defaultMaxOutputTokens: 1024 });
    expect(resolveMaxTokens(p, parsed())).toBe(4096);
  });

  test.each([0, -1, undefined] as const)("min %s is off and passes the declared value through", min => {
    const p = provider(min === undefined ? {} : { minMaxOutputTokens: min });
    expect(resolveMaxTokens(p, parsed(512))).toBe(512);
  });

  test("the floor reaches the wire on buildRequest", () => {
    const body = JSON.parse(
      createOpenAIChatAdapter(provider({ minMaxOutputTokens: 4096 }))
        .buildRequest(parsed(512)).body as string,
    ) as Record<string, unknown>;
    expect(body.max_tokens).toBe(4096);
  });
});
