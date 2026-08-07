import { describe, expect, test } from "bun:test";
import { mergeKeyLoginProviderRow, providerConfigFromKeyLoginProvider } from "../src/oauth/login-cli";
import { KEY_LOGIN_PROVIDERS } from "../src/oauth/key-providers";
import type { OcxProviderConfig } from "../src/types";

describe("key login preserves user-configured price overlays", () => {
  test("rotating the API key carries modelCosts onto the replacement row", () => {
    const replacement = providerConfigFromKeyLoginProvider(KEY_LOGIN_PROVIDERS.umans, "sk-rotated");
    const existing: OcxProviderConfig = {
      adapter: "anthropic",
      baseUrl: "https://api.code.umans.ai",
      apiKey: "sk-old",
      modelCosts: {
        "umans-coder": { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0 },
      },
    };
    const merged = mergeKeyLoginProviderRow(replacement, existing);
    expect(merged.apiKey).toBe("sk-rotated");
    expect(merged.modelCosts).toEqual(existing.modelCosts);
  });

  test("a provider without an overlay does not gain the modelCosts key", () => {
    const replacement = providerConfigFromKeyLoginProvider(KEY_LOGIN_PROVIDERS.umans, "sk-new");
    const merged = mergeKeyLoginProviderRow(replacement, undefined);
    expect(merged.modelCosts).toBeUndefined();
  });

  test("an explicit empty overlay is preserved instead of being dropped", () => {
    const replacement = providerConfigFromKeyLoginProvider(KEY_LOGIN_PROVIDERS.umans, "sk-another");
    const existing: OcxProviderConfig = {
      adapter: "anthropic",
      baseUrl: "https://api.code.umans.ai",
      apiKey: "sk-old",
      modelCosts: {},
    };
    const merged = mergeKeyLoginProviderRow(replacement, existing);
    expect(merged.modelCosts).toEqual({});
  });
});
