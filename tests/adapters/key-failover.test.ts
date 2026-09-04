import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createOpenAIChatAdapter } from "../../src/adapters/openai-chat";
import {
  getConfigPath,
  loadConfig,
  mutatePersistedConfig,
  saveConfig,
} from "../../src/config";
import {
  clearKeyCooldowns,
  getKeyCooldownUntil,
  hasKeyPoolFailover,
  rotateKeyOn429,
  rotateProviderTransportOn429,
} from "../../src/providers/key-failover";
import { resolveOpenCodeGoTransport } from "../../src/providers/opencode-go-transport";
import { deriveXaiConvId } from "../../src/providers/xai-transport";
import { routeModel } from "../../src/router";
import type { OcxConfig, OcxParsedRequest, OcxProviderConfig } from "../../src/types";
import { removeTreeWithRetry } from "../helpers/remove-tree";

let home: string;

function makeConfig(provider: Partial<OcxProviderConfig>): OcxConfig {
  const config = {
    port: 10199,
    defaultProvider: "p",
    providers: {
      p: {
        adapter: "openai-chat",
        baseUrl: "https://api.example.com/v1",
        ...provider,
      } as OcxProviderConfig,
    },
  } as OcxConfig;
  saveConfig(config);
  return config;
}

function pool3(): OcxProviderConfig["apiKeyPool"] {
  return [
    { id: "k1", key: "key-alpha-000111222333", addedAt: 1 },
    { id: "k2", key: "key-beta-444555666777", addedAt: 2 },
    { id: "k3", key: "key-gamma-888999000111", addedAt: 3 },
  ];
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ocx-keyfailover-"));
  process.env.OPENCODEX_HOME = home;
  clearKeyCooldowns();
});

afterEach(() => {
  delete process.env.OPENCODEX_HOME;
  removeTreeWithRetry(home);
  clearKeyCooldowns();
});

describe("hasKeyPoolFailover", () => {
  test("true only for key-auth providers with 2+ pool entries", () => {
    expect(hasKeyPoolFailover({ adapter: "openai-chat", baseUrl: "x", apiKeyPool: pool3() } as OcxProviderConfig)).toBe(true);
    expect(hasKeyPoolFailover({ adapter: "openai-chat", baseUrl: "x", apiKeyPool: [pool3()![0]] } as OcxProviderConfig)).toBe(false);
    expect(hasKeyPoolFailover({ adapter: "openai-chat", baseUrl: "x" } as OcxProviderConfig)).toBe(false);
    expect(hasKeyPoolFailover({ adapter: "anthropic", baseUrl: "x", authMode: "oauth", apiKeyPool: pool3() } as OcxProviderConfig)).toBe(false);
    expect(hasKeyPoolFailover({ adapter: "openai-responses", baseUrl: "x", authMode: "forward", apiKeyPool: pool3() } as OcxProviderConfig)).toBe(false);
  });
});

describe("rotateKeyOn429", () => {
  test("rotates to the next key and cools down the exhausted one", () => {
    const config = makeConfig({ apiKey: "key-alpha-000111222333", apiKeyPool: pool3() });
    const now = 1_000_000;
    const rotated = rotateKeyOn429(config, "p", null, now);
    expect(rotated?.apiKey).toBe("key-beta-444555666777");
    expect(config.providers.p.apiKey).toBe("key-beta-444555666777");
    expect(getKeyCooldownUntil("p", "k1", now)).toBe(now + 60_000);
  });

  test("respects Retry-After seconds for the cooldown window", () => {
    const config = makeConfig({ apiKey: "key-alpha-000111222333", apiKeyPool: pool3() });
    const now = 1_000_000;
    rotateKeyOn429(config, "p", "120", now);
    expect(getKeyCooldownUntil("p", "k1", now)).toBe(now + 120_000);
  });

  test("caps absurd Retry-After at the max cooldown", () => {
    const config = makeConfig({ apiKey: "key-alpha-000111222333", apiKeyPool: pool3() });
    const now = 1_000_000;
    rotateKeyOn429(config, "p", "86400", now);
    expect(getKeyCooldownUntil("p", "k1", now)).toBe(now + 10 * 60_000);
  });

  test("skips keys already in cooldown and wraps around the pool", () => {
    const config = makeConfig({ apiKey: "key-alpha-000111222333", apiKeyPool: pool3() });
    const now = 1_000_000;
    expect(rotateKeyOn429(config, "p", null, now)?.apiKey).toBe("key-beta-444555666777");
    // beta 429s too: gamma is next
    expect(rotateKeyOn429(config, "p", null, now)?.apiKey).toBe("key-gamma-888999000111");
    // gamma 429s: alpha/beta still cooling -> null (all exhausted)
    expect(rotateKeyOn429(config, "p", null, now)).toBeNull();
    // after alpha's cooldown expires the pool recovers
    expect(rotateKeyOn429(config, "p", null, now + 61_000)?.apiKey).toBe("key-alpha-000111222333");
  });

  test("returns null for oauth/forward providers and single-key pools", () => {
    const oauth = makeConfig({ authMode: "oauth", apiKey: "t", apiKeyPool: pool3() });
    expect(rotateKeyOn429(oauth, "p", null)).toBeNull();
    const single = makeConfig({ apiKey: "key-alpha-000111222333", apiKeyPool: [pool3()![0]] });
    expect(rotateKeyOn429(single, "p", null)).toBeNull();
    expect(rotateKeyOn429(makeConfig({}), "missing", null)).toBeNull();
  });

  test("unavailable persistence does not publish a tentative cooldown", () => {
    const config = makeConfig({ apiKey: "key-alpha-000111222333", apiKeyPool: pool3() });
    const now = 1_000_000;
    unlinkSync(getConfigPath());

    expect(rotateKeyOn429(config, "p", null, now, "key-alpha-000111222333")).toBeNull();
    expect(getKeyCooldownUntil("p", "k1", now)).toBeNull();
    expect(config.providers.p.apiKey).toBe("key-alpha-000111222333");
  });

  test("clearKeyCooldowns scoped to a provider", () => {
    const config = makeConfig({ apiKey: "key-alpha-000111222333", apiKeyPool: pool3() });
    const now = 1_000_000;
    rotateKeyOn429(config, "p", null, now);
    expect(getKeyCooldownUntil("p", "k1", now)).not.toBeNull();
    clearKeyCooldowns("other");
    expect(getKeyCooldownUntil("p", "k1", now)).not.toBeNull();
    clearKeyCooldowns("p");
    expect(getKeyCooldownUntil("p", "k1", now)).toBeNull();
  });

  test("concurrent 429s from the SAME key do not cool the innocent replacement (CAS)", () => {
    const config = makeConfig({ apiKey: "key-alpha-000111222333", apiKeyPool: pool3() });
    const now = 1_000_000;
    // Request 1 (used alpha) rotates alpha -> beta.
    expect(rotateKeyOn429(config, "p", null, now, "key-alpha-000111222333")?.apiKey).toBe("key-beta-444555666777");
    // Request 2 also used alpha and 429s AFTER the rotation: it must NOT cool beta —
    // it re-cools alpha (harmless) and retries with the healthy live key.
    const second = rotateKeyOn429(config, "p", null, now, "key-alpha-000111222333");
    expect(second?.apiKey).toBe("key-beta-444555666777");
    expect(getKeyCooldownUntil("p", "k2", now)).toBeNull(); // beta never cooled
    expect(getKeyCooldownUntil("p", "k1", now)).not.toBeNull();
    // A REAL beta failure afterwards still rotates to gamma.
    expect(rotateKeyOn429(config, "p", null, now, "key-beta-444555666777")?.apiKey).toBe("key-gamma-888999000111");
  });

  test("two stale handlers adopt one committed rotation without rotating twice", () => {
    const first = makeConfig({ apiKey: "key-alpha-000111222333", apiKeyPool: pool3() });
    const second = loadConfig();
    const now = 1_000_000;

    expect(rotateKeyOn429(first, "p", null, now, "key-alpha-000111222333")?.apiKey)
      .toBe("key-beta-444555666777");
    expect(rotateKeyOn429(second, "p", null, now, "key-alpha-000111222333")?.apiKey)
      .toBe("key-beta-444555666777");
    expect(second.providers.p.apiKey).toBe("key-beta-444555666777");
    expect(getKeyCooldownUntil("p", "k2", now)).toBeNull();
  });

  test("rebases over a concurrent pool edit without resurrecting a removed key", () => {
    const stale = makeConfig({
      apiKey: "key-alpha-000111222333",
      apiKeyPool: pool3(),
      note: "stale",
    });
    const added = { id: "k4", key: "key-delta-222333444555", addedAt: 4 };
    const edit = mutatePersistedConfig(fresh => {
      fresh.providers.p.apiKeyPool = [fresh.providers.p.apiKeyPool![0]!, fresh.providers.p.apiKeyPool![2]!, added];
      fresh.providers.p.note = "concurrent";
      return { changed: true, value: undefined };
    });
    expect(edit.status).toBe("committed");

    const rotated = rotateKeyOn429(stale, "p", null, 1_000_000, "key-alpha-000111222333");
    expect(rotated?.apiKey).toBe("key-gamma-888999000111");
    expect(rotated?.apiKeyPool?.map(entry => entry.id)).toEqual(["k1", "k3", "k4"]);
    expect(rotated?.note).toBe("concurrent");
    expect(stale.providers.p).toEqual(loadConfig().providers.p);
  });
});

describe("rotateProviderTransportOn429", () => {
  test("preserves OpenCode Go session affinity across key rotation", () => {
    const config = makeConfig({
      authMode: "key",
      apiKey: "key-alpha-000111222333",
      apiKeyPool: pool3(),
    });
    config.defaultProvider = "opencode-go";
    config.providers["opencode-go"] = {
      ...config.providers.p,
      baseUrl: "https://opencode.ai/zen/go/v1",
    };
    delete config.providers.p;
    writeFileSync(getConfigPath(), `${JSON.stringify(config, null, 2)}\n`);

    const initial = resolveOpenCodeGoTransport(
      config.providers["opencode-go"],
      "hashed-parent\0hashed-child",
    );
    const initialSession = initial.headers?.["x-opencode-session"];
    expect(initialSession).toMatch(/^ocx_[0-9a-f]{32}$/);

    const rotated = rotateProviderTransportOn429(config, "opencode-go", initial, {
      now: 1_000_000,
      attemptedKey: "key-alpha-000111222333",
    });

    expect(rotated?.apiKey).toBe("key-beta-444555666777");
    expect(rotated?.headers?.["x-opencode-session"]).toBe(initialSession);
    expect(config.providers["opencode-go"].headers?.["x-opencode-session"]).toBeUndefined();
  });

  test("keeps Kimi prompt-cache forwarding after rotating a stale pre-upgrade config", () => {
    const promptCacheKey = "stable-kimi-conversation-429";
    const config = makeConfig({
      authMode: "key",
      apiKey: "key-alpha-000111222333",
      apiKeyPool: pool3(),
    });
    config.defaultProvider = "kimi-code";
    config.providers["kimi-code"] = {
      ...config.providers.p,
      baseUrl: "https://api.kimi.com/coding/v1",
    };
    delete config.providers.p;
    writeFileSync(getConfigPath(), `${JSON.stringify(config, null, 2)}\n`);
    expect(config.providers["kimi-code"].promptCacheKey).toBeUndefined();

    const parsed: OcxParsedRequest = {
      modelId: "k3",
      context: { messages: [{ role: "user", content: "hi", timestamp: 0 }] },
      stream: false,
      options: { promptCacheKey },
    };
    const initial = routeModel(config, "kimi-code/k3").provider;
    const initialBody = JSON.parse(createOpenAIChatAdapter(initial).buildRequest(parsed).body);
    expect(initialBody.prompt_cache_key).toBe(promptCacheKey);

    const rotated = rotateProviderTransportOn429(config, "kimi-code", initial, {
      now: 1_000_000,
      attemptedKey: "key-alpha-000111222333",
      promptCacheKey,
    });
    expect(rotated?.apiKey).toBe("key-beta-444555666777");
    expect(rotated?.promptCacheKey).toBe(true);
    expect(rotated?.modelContextWindows).toBeDefined();
    const retryBody = JSON.parse(createOpenAIChatAdapter(rotated!).buildRequest(parsed).body);
    expect(retryBody.prompt_cache_key).toBe(promptCacheKey);
  });

  test("drops stale routed configuration while persisted fields stay authoritative", () => {
    // Request-time configuration cannot revive fields absent from the committed snapshot.
    // Registry providers still receive their canonical backfills from routedProviderConfig.
    const config = makeConfig({ apiKey: "key-alpha-000111222333", apiKeyPool: pool3() });
    const routedProvider = {
      ...config.providers.p,
      baseUrl: "https://registry-pinned.example/v1",
      promptCacheKey: true,
      parallelToolCalls: false,
      modelContextWindows: { "some-model": 262_144 },
      noTemperatureModels: ["some-model"],
    } as OcxProviderConfig;

    const rotated = rotateProviderTransportOn429(config, "p", routedProvider, {
      now: 1_000_000,
      attemptedKey: "key-alpha-000111222333",
    });

    expect(rotated?.apiKey).toBe("key-beta-444555666777");
    expect(rotated?.baseUrl).toBe("https://api.example.com/v1");
    expect(rotated?.promptCacheKey).toBeUndefined();
    expect(rotated?.parallelToolCalls).toBeUndefined();
    expect(rotated?.modelContextWindows).toBeUndefined();
    expect(rotated?.noTemperatureModels).toBeUndefined();
    // The pool swap still lands in the persisted config.
    expect(config.providers.p.apiKey).toBe("key-beta-444555666777");
    expect(config.providers.p.promptCacheKey).toBeUndefined();
  });

  test("does not resurrect an optional provider field removed before rotation", () => {
    const config = makeConfig({
      apiKey: "key-alpha-000111222333",
      apiKeyPool: pool3(),
      headers: { "x-user-header": "stale" },
    });
    const routedProvider = { ...config.providers.p };
    const edit = mutatePersistedConfig(fresh => {
      delete fresh.providers.p.headers;
      return { changed: true, value: undefined };
    });
    expect(edit.status).toBe("committed");

    const rotated = rotateProviderTransportOn429(config, "p", routedProvider, {
      now: 1_000_000,
      attemptedKey: "key-alpha-000111222333",
    });

    expect(rotated?.apiKey).toBe("key-beta-444555666777");
    expect(rotated?.headers).toBeUndefined();
  });

  test("re-applies xAI cache affinity without OAuth CLI headers after key rotation", () => {
    const promptCacheKey = "stable-conversation-429";
    const config = makeConfig({
      authMode: "key",
      apiKey: "key-alpha-000111222333",
      apiKeyPool: pool3(),
    });
    config.providers.xai = config.providers.p;
    delete config.providers.p;
    config.defaultProvider = "xai";
    writeFileSync(getConfigPath(), `${JSON.stringify(config, null, 2)}\n`);

    const rotated = rotateProviderTransportOn429(config, "xai", { ...config.providers.xai }, {
      now: 1_000_000,
      attemptedKey: "key-alpha-000111222333",
      promptCacheKey,
    });

    expect(rotated?.apiKey).toBe("key-beta-444555666777");
    expect(rotated?.headers).toEqual({
      "x-grok-conv-id": deriveXaiConvId(promptCacheKey),
    });
    expect(rotated?.headers?.["x-grok-client-identifier"]).toBeUndefined();
    expect(rotated?.headers?.["x-grok-client-version"]).toBeUndefined();
    expect(rotated?.headers?.["x-xai-token-auth"]).toBeUndefined();
    expect(JSON.stringify(rotated?.headers)).not.toContain(promptCacheKey);
  });
});
