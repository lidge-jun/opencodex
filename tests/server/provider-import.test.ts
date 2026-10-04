import { describe, expect, test } from "bun:test";
import { parseAndNormalizeProviderJson } from "../../src/providers/json-import";

describe("POST /api/providers/import route logic", () => {
  test("handles 9router JSON with multiple providers", () => {
    const raw9Router = {
      connections: [
        { provider: "groq", name: "groq-fast", apiKey: "gsk_123" },
        { provider: "poolside", apiKey: "ps_456" },
        { provider: "unknown-custom", baseUrl: "https://custom.ai/v1", apiKey: "ck_789" },
      ],
    };

    const result = parseAndNormalizeProviderJson(raw9Router);
    expect(result.sourceKind).toBe("9router-connections");
    expect(result.importedProviderNames).toHaveLength(3);
    expect(result.providers["groq-fast"]?.adapter).toBe("openai-chat");
    expect(result.providers.poolside?.baseUrl).toBe("https://inference.poolside.ai/v1");
    expect(result.providers["unknown-custom"]?.baseUrl).toBe("https://custom.ai/v1");
  });
});
