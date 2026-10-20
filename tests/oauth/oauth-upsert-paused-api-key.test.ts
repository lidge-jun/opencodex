import { describe, expect, test } from "bun:test";
import { upsertOAuthProvider } from "../../src/oauth";
import type { OcxConfig, OcxProviderConfig } from "../../src/types";

function fixture(provider: string, fields: Partial<OcxProviderConfig>): OcxConfig {
  return { port: 10100, defaultProvider: provider, providers: { [provider]: {
    adapter: "openai-chat", baseUrl: "https://api.example.test/v1", authMode: "key", ...fields,
  } } };
}

const paused = {
  id: "paused", key: "paused-key-fixture", label: "Paused slot", addedAt: 42,
  disabled: true, pauseRevision: "pause-revision-fixture",
  pauseDetails: { reason: "subscription_expired", pausedAt: 1234 },
} as const;

describe("OAuth upsert preserves paused API keys", () => {
  for (const provider of ["xai", "github-copilot"]) {
    test.each([undefined, paused.key])(`${provider}: all-paused pool stays inactive (active=%s)`, apiKey => {
      const config = fixture(provider, { apiKey, apiKeyPool: [structuredClone(paused)] });
      const before = config.providers[provider]!;
      upsertOAuthProvider(config, provider);
      const after = config.providers[provider]!;
      expect(after.apiKeyPool).toEqual([paused]);
      expect(after.apiKeyPool).not.toBe(before.apiKeyPool);
      expect(after.apiKeyPool![0]!.pauseDetails).not.toBe(before.apiKeyPool![0]!.pauseDetails);
      expect(after.apiKey).toBeUndefined();
      expect(after.authMode).toBe("oauth");
      expect(before.apiKeyPool).toEqual([paused]);
    });

    test(`${provider}: promotes the first enabled key and preserves pause metadata`, () => {
      const enabled = { id: "enabled", key: "enabled-key-fixture", disabled: false, pauseRevision: "resumed" };
      const config = fixture(provider, { apiKeyPool: [structuredClone(paused), enabled] });
      upsertOAuthProvider(config, provider);
      expect(config.providers[provider]!.apiKey).toBe(enabled.key);
      expect(config.providers[provider]!.apiKeyPool).toEqual([paused, enabled]);
      expect(config.providers[provider]!.authMode).toBe("key");
    });
  }

  test("malformed pause fields degrade independently while valid credentials survive", () => {
    const badEntries = [
      { id: "bad-types", key: "bad-types-key-fixture", disabled: "true", pauseRevision: 12,
        pauseDetails: { reason: "subscription_expired", pausedAt: -1 } },
      { ...paused, id: "bad-reason", key: "bad-reason-key-fixture",
        pauseDetails: { reason: "unknown", pausedAt: 1234 } },
      { ...paused, id: "bad-extra", key: "bad-extra-key-fixture",
        pauseDetails: { ...paused.pauseDetails, extra: true } },
    ];
    const config = fixture("xai", { apiKeyPool: badEntries as unknown as OcxProviderConfig["apiKeyPool"] });
    upsertOAuthProvider(config, "xai");
    expect(config.providers.xai!.apiKeyPool).toEqual([
      { id: "bad-types", key: "bad-types-key-fixture" },
      { id: "bad-reason", key: "bad-reason-key-fixture", label: paused.label, addedAt: 42,
        disabled: true, pauseRevision: paused.pauseRevision },
      { id: "bad-extra", key: "bad-extra-key-fixture", label: paused.label, addedAt: 42,
        disabled: true, pauseRevision: paused.pauseRevision },
    ]);
  });
});
