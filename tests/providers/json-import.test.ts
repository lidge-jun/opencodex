import { describe, expect, test } from "bun:test";
import { parseAndNormalizeProviderJson } from "../../src/providers/json-import";

describe("Provider JSON import parser", () => {
  test("parses 9router connections export object", () => {
    const raw9Router = {
      connections: [
        {
          provider: "groq",
          name: "groq-fast",
          apiKey: "gsk_test123",
          baseUrl: "https://api.groq.com/openai/v1",
          defaultModel: "llama-3.3-70b-versatile",
          models: ["llama-3.3-70b-versatile"],
        },
        {
          provider: "deepseek",
          name: "deepseek-main",
          apiKey: "sk-ds456",
          baseUrl: "https://api.deepseek.com/v1",
        },
      ],
    };

    const result = parseAndNormalizeProviderJson(raw9Router);
    expect(result.sourceKind).toBe("9router-connections");
    expect(result.importedProviderNames).toEqual(["groq-fast", "deepseek-main"]);
    expect(result.providers["groq-fast"]?.apiKey).toBe("gsk_test123");
    expect(result.providers["groq-fast"]?.adapter).toBe("openai-chat");
    expect(result.providers["deepseek-main"]?.apiKey).toBe("sk-ds456");
  });

  test("parses 9router array of connection objects", () => {
    const arrayInput = [
      {
        provider: "poolside",
        apiKey: "ps_live_789",
      },
      {
        provider: "custom-relay",
        name: "my-relay",
        baseUrl: "https://relay.example.com/v1",
        apiKey: "relay_key",
      },
    ];

    const result = parseAndNormalizeProviderJson(JSON.stringify(arrayInput));
    expect(result.sourceKind).toBe("9router-connections");
    expect(result.importedProviderNames).toEqual(["poolside", "my-relay"]);
    expect(result.providers.poolside?.apiKey).toBe("ps_live_789");
    expect(result.providers["my-relay"]?.baseUrl).toBe("https://relay.example.com/v1");
    expect(result.providers["my-relay"]?.adapter).toBe("openai-chat");
  });

  test("parses 9router bulk codex accounts", () => {
    const codexAccounts = [
      {
        accessToken: "ey12345",
        refreshToken: "refresh123",
        idToken: "id123",
      },
    ];

    const result = parseAndNormalizeProviderJson(codexAccounts);
    expect(result.sourceKind).toBe("codex-account-bulk");
    expect(result.importedAccountCount).toBe(1);
    expect(result.codexAccounts[0]?.accessToken).toBe("ey12345");
  });

  test("parses standard OpenCodex providers object", () => {
    const opencodexExport = {
      providers: {
        "trae-coder": {
          adapter: "openai-chat",
          baseUrl: "https://core-normal.trae.ai/api/remote/v1",
          apiKey: "trae_secret",
        },
      },
    };

    const result = parseAndNormalizeProviderJson(opencodexExport);
    expect(result.sourceKind).toBe("opencodex-providers");
    expect(result.importedProviderNames).toEqual(["trae-coder"]);
    expect(result.providers["trae-coder"]?.apiKey).toBe("trae_secret");
  });
});
