import { describe, expect, test } from "bun:test";
import { mkdtempSync} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OAUTH_PROVIDERS, upsertOAuthProvider } from "../../src/oauth";
import { migrateXaiResponsesDefault } from "../../src/providers/xai-responses-opt-in";
import { resolveWireProtocolOverride } from "../../src/server/adapter-resolve";
import {
  apiKeyPoolEntryId,
  listProviderApiKeys,
  removeProviderApiKey,
  setActiveProviderApiKey,
} from "../../src/providers/api-keys";
import { routeModel } from "../../src/router";
import type { OcxConfig } from "../../src/types";
import { removeTreeWithRetry } from "../helpers/remove-tree";

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
  test.each([undefined, 1, 2])("Grok login preserves wire choice and migration version %j", version => {
    const config = configWithKey("xai", "openai-chat", "https://api.x.ai/v1");
    const before = config.providers.xai!;
    before.authMode = "oauth";
    before.xaiResponsesDefaultVersion = version;
    before.modelAdapters = { "grok-4.6": "openai-chat", "grok-4.5": "openai-chat", other: "openai-responses" };
    upsertOAuthProvider(config, "xai");
    expect(config.providers.xai!.modelAdapters).toEqual(before.modelAdapters);
    expect(config.providers.xai!.modelAdapters).not.toBe(before.modelAdapters);
    expect(config.providers.xai!.xaiResponsesDefaultVersion).toBe(version);
    expect(migrateXaiResponsesDefault(config)).toBe(version === undefined);
    const expected = version === undefined ? "openai-responses" : "openai-chat";
    for (const model of ["grok-4.5", "grok-4.6"]) {
      expect(resolveWireProtocolOverride("xai", model, config.providers.xai!).adapter).toBe(expected);
    }
    expect(config.providers.xai!.modelAdapters!.other).toBe("openai-responses");
    upsertOAuthProvider(config, "xai");
    expect(migrateXaiResponsesDefault(config)).toBe(false);
  });

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

  test("carries user-configured modelCosts across a re-login upsert", () => {
    const config = configWithKey("xai", "openai-chat", "https://api.x.ai/v1");
    const costs = { "grok-4": { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0 } };
    config.providers.xai!.modelCosts = costs;
    upsertOAuthProvider(config, "xai");
    expect(config.providers.xai!.modelCosts).toEqual(costs);
  });

  test("carries the per-provider account-failover opt-out across a re-login upsert (#2568d)", () => {
    // The sequence that makes this load-bearing: an operator switches rotation off, then logs in
    // a SECOND account. That login rebuilds this row from the preset and simultaneously creates
    // the 2-account quorum that turns presence-driven rotation on — so losing the opt-out here
    // enables the exact behaviour the operator declined, during an unrelated action.
    const config = configWithKey("xai", "openai-chat", "https://api.x.ai/v1");
    config.providers.xai!.oauthAccountFailover = { enabled: false };
    upsertOAuthProvider(config, "xai");
    expect(config.providers.xai!.oauthAccountFailover).toEqual({ enabled: false });
  });

  test("an opt-IN survives too: preservation is about operator intent, not a preferred answer", () => {
    const config = configWithKey("xai", "openai-chat", "https://api.x.ai/v1");
    config.providers.xai!.oauthAccountFailover = { enabled: true };
    upsertOAuthProvider(config, "xai");
    expect(config.providers.xai!.oauthAccountFailover).toEqual({ enabled: true });
  });

  test("carries the key over without changing oauth billing when the user did not pick key mode", () => {
    const config = configWithKey("xai", "openai-chat", "https://api.x.ai/v1");
    config.providers.xai!.authMode = "oauth";
    upsertOAuthProvider(config, "xai");
    const provider = config.providers.xai!;
    expect(provider.apiKey).toBe("stored-key-sentinel");
    expect(provider.authMode).toBe("oauth");
  });

  test("sets key mode when authMode was omitted but a stored key remains", () => {
    const config = configWithKey("xai", "openai-chat", "https://api.x.ai/v1");
    delete config.providers.xai!.authMode;
    upsertOAuthProvider(config, "xai");
    const provider = config.providers.xai!;
    expect(provider.apiKey).toBe("stored-key-sentinel");
    expect(provider.authMode).toBe("key");
    expect(routeModel(config, "xai/grok-4.5").provider.authMode).toBe("key");
  });

  test("persists key mode for env-backed keys without consulting the login CLI environment", () => {
    const config = configWithKey("xai", "openai-chat", "https://api.x.ai/v1");
    config.providers.xai!.apiKey = "${OCX_TEST_XAI_API_KEY}";
    config.providers.xai!.apiKeyPool = [{ id: "env-key", key: "${OCX_TEST_XAI_API_KEY}" }];
    const previous = process.env.OCX_TEST_XAI_API_KEY;
    delete process.env.OCX_TEST_XAI_API_KEY;
    try {
      upsertOAuthProvider(config, "xai");
      const provider = config.providers.xai!;
      expect(provider.apiKey).toBe("${OCX_TEST_XAI_API_KEY}");
      expect(provider.apiKeyPool).toEqual([{ id: "env-key", key: "${OCX_TEST_XAI_API_KEY}" }]);
      expect(provider.authMode).toBe("key");
    } finally {
      if (previous === undefined) delete process.env.OCX_TEST_XAI_API_KEY;
      else process.env.OCX_TEST_XAI_API_KEY = previous;
    }
  });

  test("falls back to OAuth at routing time when the proxy cannot resolve the active key", () => {
    const config = configWithKey("xai", "openai-chat", "https://api.x.ai/v1");
    config.providers.xai!.apiKey = "${OCX_TEST_XAI_API_KEY_MISSING}";
    config.providers.xai!.apiKeyPool = [{ id: "env-key", key: "${OCX_TEST_XAI_API_KEY_MISSING}" }];
    upsertOAuthProvider(config, "xai");
    expect(config.providers.xai!.authMode).toBe("key");

    const previous = process.env.OCX_TEST_XAI_API_KEY_MISSING;
    delete process.env.OCX_TEST_XAI_API_KEY_MISSING;
    try {
      const routed = routeModel(config, "xai/grok-4.5").provider;
      expect(routed.authMode).toBe("oauth");
      expect(routed.apiKey).toBeUndefined();
      expect(config.providers.xai!.authMode).toBe("key");
    } finally {
      if (previous === undefined) delete process.env.OCX_TEST_XAI_API_KEY_MISSING;
      else process.env.OCX_TEST_XAI_API_KEY_MISSING = previous;
    }
  });

  test("uses key billing at routing time when the proxy resolves the env-backed active key", () => {
    const config = configWithKey("xai", "openai-chat", "https://api.x.ai/v1");
    config.providers.xai!.apiKey = "${OCX_TEST_XAI_API_KEY}";
    config.providers.xai!.apiKeyPool = [{ id: "env-key", key: "${OCX_TEST_XAI_API_KEY}" }];
    upsertOAuthProvider(config, "xai");
    expect(config.providers.xai!.authMode).toBe("key");

    const previous = process.env.OCX_TEST_XAI_API_KEY;
    process.env.OCX_TEST_XAI_API_KEY = "resolved-xai-secret";
    try {
      const routed = routeModel(config, "xai/grok-4.5").provider;
      expect(routed.authMode).toBe("key");
      expect(routed.apiKey).toBe("resolved-xai-secret");
      expect(config.providers.xai!.authMode).toBe("key");
    } finally {
      if (previous === undefined) delete process.env.OCX_TEST_XAI_API_KEY;
      else process.env.OCX_TEST_XAI_API_KEY = previous;
    }
  });

  test("CLI and proxy env visibility can diverge without rewriting stored authMode", () => {
    const config = configWithKey("xai", "openai-chat", "https://api.x.ai/v1");
    config.providers.xai!.apiKey = "${OCX_TEST_XAI_SPLIT_ENV}";
    config.providers.xai!.apiKeyPool = [{ id: "env-key", key: "${OCX_TEST_XAI_SPLIT_ENV}" }];
    const previous = process.env.OCX_TEST_XAI_SPLIT_ENV;

    // Login CLI sees the secret; upsert still records key intent, not CLI resolution.
    process.env.OCX_TEST_XAI_SPLIT_ENV = "cli-only-secret";
    upsertOAuthProvider(config, "xai");
    expect(config.providers.xai!.authMode).toBe("key");

    // Running proxy lacks the env var: route on OAuth without touching stored mode.
    delete process.env.OCX_TEST_XAI_SPLIT_ENV;
    const oauthFallback = routeModel(config, "xai/grok-4.5").provider;
    expect(oauthFallback.authMode).toBe("oauth");
    expect(oauthFallback.apiKey).toBeUndefined();
    expect(config.providers.xai!.authMode).toBe("key");

    // Proxy later gains the env var: key billing resumes without a config rewrite.
    process.env.OCX_TEST_XAI_SPLIT_ENV = "proxy-secret";
    const keyRoute = routeModel(config, "xai/grok-4.5").provider;
    expect(keyRoute.authMode).toBe("key");
    expect(keyRoute.apiKey).toBe("proxy-secret");
    expect(config.providers.xai!.authMode).toBe("key");

    if (previous === undefined) delete process.env.OCX_TEST_XAI_SPLIT_ENV;
    else process.env.OCX_TEST_XAI_SPLIT_ENV = previous;
  });

  test("inserts a missing active key into the pool so listing matches routing", () => {
    const config = {
      port: 10100,
      defaultProvider: "xai",
      providers: {
        xai: {
          adapter: "openai-chat",
          baseUrl: "https://api.x.ai/v1",
          authMode: "key",
          apiKey: "routing-only-key",
          apiKeyPool: [{ id: "pool-visible", key: "pool-visible-key" }],
        },
      },
    } as OcxConfig;
    const previousHome = process.env.OPENCODEX_HOME;
    const testHome = mkdtempSync(join(tmpdir(), "ocx-oauth-upsert-pool-"));
    process.env.OPENCODEX_HOME = testHome;
    try {
      upsertOAuthProvider(config, "xai");
      const provider = config.providers.xai!;
      const activeId = apiKeyPoolEntryId("routing-only-key");
      expect(provider.authMode).toBe("key");
      expect(provider.apiKey).toBe("routing-only-key");
      expect(provider.apiKeyPool).toEqual([
        { id: "pool-visible", key: "pool-visible-key" },
        { id: activeId, key: "routing-only-key" },
      ]);

      const listed = listProviderApiKeys(config, "xai");
      expect(listed.activeId).toBe(activeId);
      expect(listed.keys.find(entry => entry.id === activeId)?.active).toBe(true);
      expect(listed.keys.find(entry => entry.id === "pool-visible")?.active).toBe(false);

      expect(setActiveProviderApiKey(config, "xai", "pool-visible")).toBe(true);
      expect(config.providers.xai!.apiKey).toBe("pool-visible-key");
      expect(listProviderApiKeys(config, "xai").activeId).toBe("pool-visible");

      expect(setActiveProviderApiKey(config, "xai", activeId)).toBe(true);
      expect(config.providers.xai!.apiKey).toBe("routing-only-key");
      expect(removeProviderApiKey(config, "xai", activeId)).toBe(true);
      expect(config.providers.xai!.apiKey).toBe("pool-visible-key");
      expect(config.providers.xai!.apiKeyPool).toEqual([{ id: "pool-visible", key: "pool-visible-key" }]);
      expect(listProviderApiKeys(config, "xai").activeId).toBe("pool-visible");
    } finally {
      if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
      else process.env.OPENCODEX_HOME = previousHome;
      removeTreeWithRetry(testHome);
    }
  });

  test("drops malformed stored key fields instead of breaking OAuth routing", () => {
    const config = {
      port: 10100,
      defaultProvider: "xai",
      providers: {
        xai: {
          adapter: "openai-chat",
          baseUrl: "https://api.x.ai/v1",
          authMode: "key",
          apiKey: 12345,
          apiKeyPool: [{ id: "bad-key", key: 67890 }],
        },
      },
    } as unknown as OcxConfig;
    upsertOAuthProvider(config, "xai");
    expect(config.providers.xai!.authMode).toBe("oauth");
    expect(config.providers.xai!.apiKey).toBeUndefined();
    expect(config.providers.xai!.apiKeyPool).toBeUndefined();
    expect(routeModel(config, "xai/grok-4.5").provider.authMode).toBe("oauth");
  });

  test("rejects an unsafe active key and promotes the first safe pool entry", () => {
    const config = {
      port: 10100,
      defaultProvider: "xai",
      providers: {
        xai: {
          adapter: "openai-chat",
          baseUrl: "https://api.x.ai/v1",
          authMode: "key",
          apiKey: "unsafe\r\nheader",
          apiKeyPool: [
            { id: "safe", key: " safe-alternate " },
            { id: "unsafe", key: "bad\r\nheader" },
          ],
        },
      },
    } as OcxConfig;
    upsertOAuthProvider(config, "xai");
    const provider = config.providers.xai!;
    expect(provider.authMode).toBe("key");
    expect(provider.apiKey).toBe("safe-alternate");
    expect(provider.apiKeyPool).toEqual([{ id: "safe", key: "safe-alternate" }]);
    expect(routeModel(config, "xai/grok-4.5").provider.authMode).toBe("key");
  });

  test("filters malformed and duplicate pool data without deleting valid keys", () => {
    const config = configWithKey("xai", "openai-chat", "https://api.x.ai/v1");
    config.providers.xai!.apiKeyPool = [
      { id: "primary", key: "stored-key-sentinel" },
      { id: "alternate", key: " alternate-key " },
      { id: "alternate", key: "duplicate-id" },
      { id: "duplicate-key", key: "alternate-key" },
      { id: "bad-added-at", key: "bad-metadata", addedAt: Number.NaN },
    ];
    upsertOAuthProvider(config, "xai");
    const provider = config.providers.xai!;
    expect(provider.authMode).toBe("key");
    expect(provider.apiKey).toBe("stored-key-sentinel");
    expect(provider.apiKeyPool).toEqual([
      { id: "primary", key: "stored-key-sentinel" },
      { id: "alternate", key: "alternate-key" },
      { id: "bad-added-at", key: "bad-metadata" },
    ]);
  });

  test("returns to oauth after the last stored API key is removed", () => {
    const config = configWithKey("xai", "openai-chat", "https://api.x.ai/v1");
    const previousHome = process.env.OPENCODEX_HOME;
    const testHome = mkdtempSync(join(tmpdir(), "ocx-oauth-upsert-"));
    process.env.OPENCODEX_HOME = testHome;
    try {
      expect(removeProviderApiKey(config, "xai", "aaaaaaaa")).toBe(true);
      expect(config.providers.xai!.authMode).toBe("key");
      expect(config.providers.xai!.apiKey).toBeUndefined();
      expect(config.providers.xai!.apiKeyPool).toBeUndefined();

      upsertOAuthProvider(config, "xai");
      const provider = config.providers.xai!;
      expect(provider.authMode).toBe("oauth");
      expect(provider.apiKey).toBeUndefined();
      expect(provider.apiKeyPool).toBeUndefined();
    } finally {
      if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
      else process.env.OPENCODEX_HOME = previousHome;
      removeTreeWithRetry(testHome);
    }
  });

  test("applies OAuth credentials while preserving notes for oauth-only providers", () => {
    const config = {
      port: 10100,
      defaultProvider: "anthropic",
      providers: {
        anthropic: {
          adapter: "anthropic",
          baseUrl: "https://api.anthropic.com",
          authMode: "key",
          apiKey: "stale-key",
          apiKeyPool: [{ id: "stale", key: "stale-key" }],
          note: "stale-note",
        },
      },
    } as unknown as OcxConfig;
    upsertOAuthProvider(config, "anthropic");
    const provider = config.providers.anthropic!;
    expect(provider.authMode).toBe("oauth");
    expect(provider.apiKey).toBeUndefined();
    expect(provider.apiKeyPool).toBeUndefined();
    expect(provider.note).toBe("stale-note");
  });

  test("replaces stale login transport fields instead of retaining an alternate credential destination", () => {
    const config = configWithKey("anthropic", "openai-chat", "https://stale.example.invalid");
    const existing = config.providers.anthropic!;
    existing.headers = { Authorization: "Bearer stale-header-sentinel" };
    existing.apiKeyTransport = "x-api-key";
    existing.responsesPath = "/stale-responses";
    existing.googleMode = "vertex";
    existing.keyOptional = true;
    const before = structuredClone(existing);
    const preset = OAUTH_PROVIDERS.anthropic!.providerConfig;

    upsertOAuthProvider(config, "anthropic");

    const provider = config.providers.anthropic!;
    expect(provider.adapter).toBe("anthropic");
    expect(provider.baseUrl).toBe("https://api.anthropic.com");
    expect(provider.authMode).toBe("oauth");
    expect(provider.headers).toEqual(preset.headers);
    expect(provider.apiKeyTransport).toBe(preset.apiKeyTransport);
    expect(provider.responsesPath).toBeUndefined();
    expect(provider.googleMode).toBeUndefined();
    expect(provider.keyOptional).toBeUndefined();
    expect(provider.apiKey).toBeUndefined();
    expect(provider.apiKeyPool).toBeUndefined();
    expect(existing).toEqual(before);
  });

  test("clears the previous CCA project only after resolving the canonical login mode", () => {
    const config = configWithKey("google-antigravity", "google", "https://stale.example.invalid");
    const existing = config.providers["google-antigravity"]!;
    existing.googleMode = "vertex";
    existing.project = "previous-account-project";

    upsertOAuthProvider(config, "google-antigravity");

    expect(config.providers["google-antigravity"]!.googleMode).toBe("cloud-code-assist");
    expect(config.providers["google-antigravity"]!.project).toBeUndefined();
    expect(existing.project).toBe("previous-account-project");
  });

  test("preserves an operator project when the canonical login mode is not CCA", () => {
    const config = configWithKey("xai", "openai-chat", "https://api.x.ai/v1");
    const existing = config.providers.xai!;
    existing.googleMode = "cloud-code-assist";
    existing.project = "operator-project";

    upsertOAuthProvider(config, "xai");

    expect(config.providers.xai!.googleMode).toBeUndefined();
    expect(config.providers.xai!.project).toBe("operator-project");
  });

  test("isolates nested operator and unchanged catalog data from the previous row and registry", () => {
    const preset = OAUTH_PROVIDERS.anthropic!.providerConfig;
    const presetBefore = structuredClone(preset);
    const existing = {
      ...structuredClone(preset),
      modelCosts: { "operator-model": { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 } },
      forwardCompatibleFlag: { labels: ["keep"] },
    };
    const before = structuredClone(existing);
    const config: OcxConfig = { port: 10100, defaultProvider: "anthropic", providers: { anthropic: existing } };

    upsertOAuthProvider(config, "anthropic");

    const provider = config.providers.anthropic! as typeof existing;
    expect(provider.models).not.toBe(preset.models);
    expect(provider.models).not.toBe(existing.models);
    provider.modelCosts["operator-model"]!.input = 99;
    provider.forwardCompatibleFlag.labels.push("changed");
    provider.models!.push("test-only-model");
    expect(existing).toEqual(before);
    expect(preset).toEqual(presetBefore);
  });

  test("refreshes registry-owned catalog fields immediately without losing operator fields", () => {
    const config = {
      port: 10100,
      defaultProvider: "anthropic",
      providers: {
        anthropic: {
          adapter: "anthropic",
          baseUrl: "https://api.anthropic.com",
          authMode: "oauth",
          models: ["retired-model"],
          defaultModel: "retired-model",
          contextWindow: 1,
          disabled: true,
          note: "operator-note",
        },
      },
    } as unknown as OcxConfig;

    upsertOAuthProvider(config, "anthropic");

    const provider = config.providers.anthropic!;
    const preset = OAUTH_PROVIDERS.anthropic!.providerConfig;
    expect(provider.models).toEqual(preset.models);
    expect(provider.contextWindow).toBe(preset.contextWindow);
    expect(provider.defaultModel).toBe(preset.defaultModel);
    expect(provider.disabled).toBe(true);
    expect(provider.note).toBe("operator-note");
  });

  test.each(["login", "add-account", "reauthentication"])(
    "preserves operator policy and unknown fields during %s-shaped upsert",
    operation => {
      const config = configWithKey("xai", "openai-chat", "https://api.x.ai/v1");
      const existing = config.providers.xai! as OcxConfig["providers"][string] & Record<string, unknown>;
      existing.disabled = true;
      existing.requestPacing = { enabled: true, minIntervalMs: 250 };
      existing.retryOn429 = { attempts: 4, intervalMs: 900 };
      existing.refreshPolicy = "lazy-only";
      existing.selectedModels = ["grok-4"];
      existing.note = `operator-${operation}`;
      existing.modelCosts = { "grok-4": { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 } };
      existing.oauthAccountFailover = { enabled: false };
      existing.forwardCompatibleFlag = { enabled: true };

      upsertOAuthProvider(config, "xai");

      const provider = config.providers.xai! as typeof existing;
      expect(provider.disabled).toBe(true);
      expect(provider.requestPacing).toEqual({ enabled: true, minIntervalMs: 250 });
      expect(provider.retryOn429).toEqual({ attempts: 4, intervalMs: 900 });
      expect(provider.refreshPolicy).toBe("lazy-only");
      expect(provider.selectedModels).toEqual(["grok-4"]);
      expect(provider.note).toBe(`operator-${operation}`);
      expect(provider.modelCosts).toEqual({ "grok-4": { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 } });
      expect(provider.oauthAccountFailover).toEqual({ enabled: false });
      expect(provider.forwardCompatibleFlag).toEqual({ enabled: true });
      expect(provider.apiKey).toBe("stored-key-sentinel");
    },
  );

  test("removes incompatible API-key and Azure credentials while preserving unknown fields", () => {
    const config = {
      port: 10100,
      defaultProvider: "anthropic",
      providers: {
        anthropic: {
          adapter: "anthropic",
          baseUrl: "https://api.anthropic.com",
          authMode: "key",
          apiKey: "stale-key",
          apiKeyPool: [{ id: "stale", key: "stale-key" }],
          azureCredential: { token: "stale" },
          disabled: true,
          forwardCompatibleFlag: "retain-me",
        },
      },
    } as unknown as OcxConfig;

    upsertOAuthProvider(config, "anthropic");

    const provider = config.providers.anthropic! as OcxConfig["providers"][string] & Record<string, unknown>;
    expect(provider.apiKey).toBeUndefined();
    expect(provider.apiKeyPool).toBeUndefined();
    expect(provider.azureCredential).toBeUndefined();
    expect(provider.disabled).toBe(true);
    expect(provider.forwardCompatibleFlag).toBe("retain-me");
    expect(provider.authMode).toBe("oauth");
  });

  test("a fresh login on an unconfigured provider gets the untouched preset", () => {
    const config = { port: 10100, defaultProvider: "openai", providers: {} } as unknown as OcxConfig;
    const preset = OAUTH_PROVIDERS.xai!.providerConfig;
    const before = structuredClone(preset);
    upsertOAuthProvider(config, "xai");
    const provider = config.providers.xai!;
    expect(provider.authMode).toBe("oauth");
    expect(provider.apiKey).toBeUndefined();
    expect(provider.apiKeyPool).toBeUndefined();
    expect(provider.models).not.toBe(preset.models);
    provider.models!.push("test-only-model");
    expect(preset).toEqual(before);
  });

  test("promotes the legacy Command Code static catalog during OAuth upsert", () => {
    const config = {
      port: 10100,
      defaultProvider: "command-code",
      providers: {
        "command-code": {
          adapter: "command-code",
          baseUrl: "https://api.commandcode.ai",
          authMode: "oauth",
          liveModels: false,
          defaultModel: "deepseek-v4-flash",
          models: ["deepseek-v4-flash", "kimi-k3", "glm-5.2"],
          note: "operator-note",
        },
      },
    } as unknown as OcxConfig;

    upsertOAuthProvider(config, "command-code");

    expect(config.providers["command-code"]!.liveModels).toBe(true);
    expect(config.providers["command-code"]!.note).toBe("operator-note");
  });
});
