import { describe, expect, test } from "bun:test";
import { upsertOAuthProvider } from "../src/oauth";
import type { OcxConfig } from "../src/types";

/**
 * Regression: `upsertOAuthProvider` used to overwrite the provider entry with the bare preset
 * on every OAuth login, deleting a stored `apiKey`/`apiKeyPool` and silently flipping an
 * explicit `authMode: "key"` billing choice back to the subscription. Providers whose registry
 * entry sets `allowKeyAuthOverride` (xai, github-copilot) are the ones that can hold both.
 */
function configWithKey(provider: string, adapter: string, baseUrl: string): OcxConfig {
  return {
    port: 10100,
    defaultProvider: provider,
    providers: {
      [provider]: {
        adapter,
        baseUrl,
        authMode: "key",
        apiKey: "stored-key-sentinel",
        apiKeyPool: [{ id: "aaaaaaaa", key: "stored-key-sentinel" }],
      },
    },
  } as unknown as OcxConfig;
}

describe("upsertOAuthProvider credential preservation", () => {
  test("keeps a stored API key and the explicit key billing mode for xai", () => {
    const config = configWithKey("xai", "openai-chat", "https://api.x.ai/v1");
    upsertOAuthProvider(config, "xai");
    const provider = config.providers.xai!;
    expect(provider.apiKey).toBe("stored-key-sentinel");
    expect(provider.apiKeyPool).toEqual([{ id: "aaaaaaaa", key: "stored-key-sentinel" }]);
    expect(provider.authMode).toBe("key");
  });

  test("keeps a stored API key for github-copilot", () => {
    const config = configWithKey("github-copilot", "openai-chat", "https://api.githubcopilot.com");
    upsertOAuthProvider(config, "github-copilot");
    const provider = config.providers["github-copilot"]!;
    expect(provider.apiKey).toBe("stored-key-sentinel");
    expect(provider.authMode).toBe("key");
  });

  test("carries the key over without changing oauth billing when the user did not pick key mode", () => {
    const config = configWithKey("xai", "openai-chat", "https://api.x.ai/v1");
    config.providers.xai!.authMode = "oauth";
    upsertOAuthProvider(config, "xai");
    const provider = config.providers.xai!;
    expect(provider.apiKey).toBe("stored-key-sentinel");
    expect(provider.authMode).toBe("oauth");
  });

  test("still applies the plain preset for oauth-only providers", () => {
    const config = {
      port: 10100,
      defaultProvider: "anthropic",
      providers: {
        anthropic: {
          adapter: "anthropic",
          baseUrl: "https://api.anthropic.com",
          authMode: "oauth",
          note: "stale-note",
        },
      },
    } as unknown as OcxConfig;
    upsertOAuthProvider(config, "anthropic");
    const provider = config.providers.anthropic!;
    expect(provider.authMode).toBe("oauth");
    expect(provider.apiKey).toBeUndefined();
    expect(provider.note).toBeUndefined();
  });

  test("a fresh login on an unconfigured provider gets the untouched preset", () => {
    const config = { port: 10100, defaultProvider: "openai", providers: {} } as unknown as OcxConfig;
    upsertOAuthProvider(config, "xai");
    const provider = config.providers.xai!;
    expect(provider.authMode).toBe("oauth");
    expect(provider.apiKey).toBeUndefined();
    expect(provider.apiKeyPool).toBeUndefined();
  });
});
