import { expect, test } from "bun:test";
import { providerMatchesRegistryTransport, registryEntryForProviderDestination } from "../../src/providers/registry";
import { captureRouteStaticPolicy, routedProviderConfig } from "../../src/router";
import type { OcxProviderConfig } from "../../src/types";

test("a metadata alias on another adapter does not grant registry transport ownership", () => {
  // Volcengine's canonical row moved to Responses; saved Chat rows remain Chat.
  const provider: OcxProviderConfig = {
    adapter: "openai-chat", authMode: "key", apiKey: "test-key",
    baseUrl: "https://ark.cn-beijing.volces.com/api/coding/v3",
  };
  expect(registryEntryForProviderDestination(provider)?.id).toBe("volcengine-coding-plan");
  expect(providerMatchesRegistryTransport("volcengine-coding-plan", provider)).toBe(false);
  expect(routedProviderConfig("volcengine-coding-plan", provider).adapter).toBe("openai-chat");
  expect(captureRouteStaticPolicy("volcengine-coding-plan", "doubao-seed-2.0-code", provider).provider.adapter).toBe("openai-chat");
});

test("the Go inference alias identifies renamed destinations while the preset remains pinned", () => {
  const provider: OcxProviderConfig = {
    adapter: "openai-chat", authMode: "key", apiKey: "test-key",
    baseUrl: "https://opencode.ai/inference/go/v1",
  };
  expect(registryEntryForProviderDestination(provider)?.id).toBe("opencode-go");
  expect(providerMatchesRegistryTransport("opencode-go", provider)).toBe(true);
  expect(routedProviderConfig("opencode-go", provider).baseUrl).toBe("https://opencode.ai/zen/go/v1");
  expect(routedProviderConfig("renamed-go", provider).baseUrl).toBe(provider.baseUrl);
});
