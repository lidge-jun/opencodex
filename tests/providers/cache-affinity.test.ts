import { afterEach, describe, expect, test, beforeEach } from "bun:test";
import {
  clearProviderCacheAffinityForTests,
  consultProviderCacheAffinity,
  recordProviderCacheAffinity,
  releaseProviderCacheAffinity,
  sweepExpiredProviderCacheAffinity,
  reconcileProviderCacheAffinity,
  CACHE_AFFINITY_WORTH_TOKENS,
} from "../../src/providers/cache-affinity";
import type { OcxConfig, OcxProviderConfig } from "../../src/types";
import type { GenerationContext } from "../../src/lib/state-store-sweeper";
import { rotateKeyOn429, rotateProviderTransportOn429, selectProactiveApiKeyTransport, clearKeyCooldowns, forgetApiKeyRotationCursor } from "../../src/providers/key-failover";
import { providerApiKeySelectionIsCurrent, resolveCurrentProviderApiKeyTransport } from "../../src/providers/api-key-selection";
import { resetProviderRequestPacingForTest, waitForProviderRequestSlot } from "../../src/providers/request-pacing";
import { loadConfig, saveConfig } from "../../src/config";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { setKeyCooldown } from "../../src/providers/api-key-cooldowns";
import { routedProviderConfig } from "../../src/providers/routed-config";

const NOW = 1_700_000_000_000;
function provider(overrides: Partial<OcxProviderConfig> = {}): OcxProviderConfig {
  return {
    adapter: "openai-chat",
    baseUrl: "https://example.test/v1",
    apiKey: "key-a",
    apiKeyPool: [
      { id: "a", key: "key-a" },
      { id: "b", key: "key-b" },
    ],
    ...overrides,
  } as OcxProviderConfig;
}

function consult(lane: string, p: OcxProviderConfig, model = "m1", now = NOW) {
  return consultProviderCacheAffinity({ lane, providerName: "kimi", provider: p, model, now });
}

describe("provider cache affinity store", () => {
  beforeEach(() => clearProviderCacheAffinityForTests());

  test("no binding before any recorded turn", () => {
    expect(consult("lane-1", provider())).toBeNull();
  });

  test("a turn with a worthy cache write binds, and auto keeps it while warm", () => {
    recordProviderCacheAffinity({
      lane: "lane-1", providerName: "kimi", entryId: "a", model: "m1",
      cacheRead: 0, cacheWrite: CACHE_AFFINITY_WORTH_TOKENS, inputTokens: 5000, now: NOW,
    });
    const hit = consult("lane-1", provider(), "m1", NOW + 60_000);
    expect(hit?.entryId).toBe("a");
    expect(hit?.reason).toBe("cache");
  });

  test("below the worth threshold, auto does not keep across turns but session does", () => {
    recordProviderCacheAffinity({
      lane: "lane-1", providerName: "kimi", entryId: "a", model: "m1",
      cacheRead: 10, cacheWrite: 20, inputTokens: 100, now: NOW,
    });
    expect(consult("lane-1", provider(), "m1", NOW + 120_000)).toBeNull();
    const sessional = provider({ cacheAffinity: "session" });
    expect(consult("lane-1", sessional, "m1", NOW + 120_000)?.entryId).toBe("a");
  });

  test("silent-cache provider: unreported cache counts the sent prompt as written", () => {
    recordProviderCacheAffinity({
      lane: "lane-1", providerName: "kimi", entryId: "a", model: "m1",
      inputTokens: CACHE_AFFINITY_WORTH_TOKENS + 1, now: NOW,
    });
    expect(consult("lane-1", provider(), "m1", NOW + 60_000)?.entryId).toBe("a");
  });

  test("a cold binding exerts no pull in auto mode", () => {
    recordProviderCacheAffinity({
      lane: "lane-1", providerName: "kimi", entryId: "a", model: "m1",
      cacheRead: 9000, cacheWrite: 0, inputTokens: 9000, now: NOW,
    });
    expect(consult("lane-1", provider(), "m1", NOW + 6 * 60_000)).toBeNull();
  });

  test("long-retention writes stay warm for an hour", () => {
    recordProviderCacheAffinity({
      lane: "lane-1", providerName: "kimi", entryId: "a", model: "m1",
      cacheRead: 0, cacheWrite: 4000, cacheWriteLong: 4000, inputTokens: 4000, now: NOW,
    });
    expect(consult("lane-1", provider(), "m1", NOW + 30 * 60_000)?.entryId).toBe("a");
    expect(consult("lane-1", provider(), "m1", NOW + 61 * 60_000)).toBeNull();
  });

  test("turn mode keeps only detected continuations, regardless of worth", () => {
    recordProviderCacheAffinity({
      lane: "lane-1", providerName: "kimi", entryId: "a", model: "m1",
      cacheRead: 0, cacheWrite: 0, inputTokens: 10, now: NOW,
    });
    const turn = provider({ cacheAffinity: "turn" });
    // A new user turn is not a continuation, however fresh the binding is.
    expect(consult("lane-1", turn, "m1", NOW + 60_000)).toBeNull();
    const hit = consultProviderCacheAffinity({
      lane: "lane-1", providerName: "kimi", provider: turn, model: "m1", continuation: true, now: NOW + 60_000,
    });
    expect(hit?.entryId).toBe("a");
    expect(hit?.reason).toBe("turn");
    // Even a continuation cannot use a cache that has gone cold.
    expect(consultProviderCacheAffinity({
      lane: "lane-1", providerName: "kimi", provider: turn, model: "m1", continuation: true, now: NOW + 6 * 60_000,
    })).toBeNull();
  });

  test("auto keeps a detected continuation before any cache evidence exists", () => {
    recordProviderCacheAffinity({
      lane: "lane-1",
      providerName: "kimi",
      entryId: "a",
      model: "m1",
      cacheRead: 0,
      cacheWrite: 0,
      inputTokens: 10,
      now: NOW,
    });
    const hit = consultProviderCacheAffinity({
      lane: "lane-1",
      providerName: "kimi",
      provider: provider(),
      model: "m1",
      continuation: true,
      now: NOW + 60_000,
    });
    expect(hit?.reason).toBe("continuation");
    expect(consult("lane-1", provider(), "m1", NOW + 60_000)).toBeNull();
  });

  test("reads-only reporters bind: no write counter means the sent prompt counts as written", () => {
    recordProviderCacheAffinity({
      lane: "lane-1", providerName: "kimi", entryId: "a", model: "m1",
      cacheRead: 0, inputTokens: CACHE_AFFINITY_WORTH_TOKENS + 1, now: NOW,
    });
    expect(consult("lane-1", provider(), "m1", NOW + 60_000)?.entryId).toBe("a");
    // An explicitly reported zero write count is believed instead.
    recordProviderCacheAffinity({
      lane: "lane-2", providerName: "kimi", entryId: "a", model: "m1",
      cacheRead: 0, cacheWrite: 0, inputTokens: CACHE_AFFINITY_WORTH_TOKENS + 1, now: NOW,
    });
    expect(consult("lane-2", provider(), "m1", NOW + 60_000)).toBeNull();
  });

  test("reconcile drops removed providers, disabled providers, and removed credentials", () => {
    const sessional = provider({ cacheAffinity: "session" });
    recordProviderCacheAffinity({
      lane: "lane-1", providerName: "kimi", entryId: "a", model: "m1",
      cacheRead: 9000, cacheWrite: 0, inputTokens: 9000, now: NOW,
    });
    recordProviderCacheAffinity({
      lane: "lane-2", providerName: "gone", entryId: "a", model: "m1",
      cacheRead: 9000, cacheWrite: 0, inputTokens: 9000, now: NOW,
    });
    const context = {
      generation: 1,
      providerNames: new Set(["kimi"]),
      comboIds: new Set<string>(), comboTargets: new Set<string>(),
      codexAccountIds: new Set<string>(), oauthAccountKeys: new Set<string>(),
      configRoots: new Set<string>(),
      providerKeyEntryIds: new Map([["kimi", new Set(["b"])]]),
    } as unknown as GenerationContext;
    // lane-1's entry "a" left the pool; lane-2's provider left the config.
    expect(reconcileProviderCacheAffinity(context)).toBe(2);
    expect(consult("lane-1", sessional, "m1", NOW + 1000)).toBeNull();
    recordProviderCacheAffinity({
      lane: "lane-3", providerName: "kimi", entryId: "b", model: "m1",
      cacheRead: 9000, cacheWrite: 0, inputTokens: 9000, now: NOW,
    });
    expect(reconcileProviderCacheAffinity({
      ...context, generation: 2, disabledProviderNames: new Set(["kimi"]),
    })).toBe(1);
    expect(consult("lane-3", sessional, "m1", NOW + 1000)).toBeNull();
  });

  test("capacity evicts the least recently recorded lane; oversize entries are refused", () => {
    const sessional = provider({ cacheAffinity: "session" });
    for (let i = 0; i < 513; i++) {
      recordProviderCacheAffinity({
        lane: `lane-${i}`, providerName: "kimi", entryId: "a", model: "m1",
        cacheRead: 9000, cacheWrite: 0, inputTokens: 9000, now: NOW + i,
      });
    }
    expect(consult("lane-0", sessional, "m1", NOW + 1000)).toBeNull();
    expect(consult("lane-512", sessional, "m1", NOW + 1000)?.entryId).toBe("a");
    recordProviderCacheAffinity({
      lane: "lane-big", providerName: "kimi", entryId: "a", model: `m-${"x".repeat(2000)}`,
      cacheRead: 9000, cacheWrite: 0, inputTokens: 9000, now: NOW,
    });
    expect(consultProviderCacheAffinity({
      lane: "lane-big", providerName: "kimi", provider: sessional, model: `m-${"x".repeat(2000)}`, now: NOW + 1000,
    })).toBeNull();
  });

  test("off mode never consults an existing binding", () => {
    const off = provider({ cacheAffinity: "off" });
    recordProviderCacheAffinity({
      lane: "lane-1",
      providerName: "kimi",
      entryId: "a",
      model: "m1",
      cacheRead: 9000,
      cacheWrite: 9000,
      inputTokens: 9000,
      now: NOW,
    });
    expect(consult("lane-1", off, "m1", NOW + 1000)).toBeNull();
  });

  test("a different model or provider does not inherit the binding", () => {
    recordProviderCacheAffinity({
      lane: "lane-1", providerName: "kimi", entryId: "a", model: "m1",
      cacheRead: 9000, cacheWrite: 0, inputTokens: 9000, now: NOW,
    });
    expect(consult("lane-1", provider(), "other-model", NOW + 1000)).toBeNull();
    expect(consultProviderCacheAffinity({
      lane: "lane-1", providerName: "other", provider: provider(), model: "m1", now: NOW + 1000,
    })).toBeNull();
  });

  test("release forgets the binding; sweep expires old entries", () => {
    recordProviderCacheAffinity({
      lane: "lane-1", providerName: "kimi", entryId: "a", model: "m1",
      cacheRead: 9000, cacheWrite: 0, inputTokens: 9000, now: NOW,
    });
    releaseProviderCacheAffinity("lane-1");
    expect(consult("lane-1", provider(), "m1", NOW + 1000)).toBeNull();

    recordProviderCacheAffinity({
      lane: "lane-2", providerName: "kimi", entryId: "b", model: "m1",
      cacheRead: 9000, cacheWrite: 0, inputTokens: 9000, now: NOW,
    });
    expect(sweepExpiredProviderCacheAffinity(NOW + 25 * 60 * 60_000)).toBe(1);
    expect(consult("lane-2", provider(), "m1", NOW + 25 * 60 * 60_000)).toBeNull();
  });

  test("release is scoped to the failed provider and pool entry", () => {
    recordProviderCacheAffinity({
      lane: "lane-1", providerName: "kimi", entryId: "a", model: "m1",
      cacheWrite: 9000, now: NOW,
    });
    expect(releaseProviderCacheAffinity("lane-1", "other", "a")).toBe(false);
    expect(consult("lane-1", provider())?.entryId).toBe("a");
    expect(releaseProviderCacheAffinity("lane-1", "kimi", "b")).toBe(false);
    expect(consult("lane-1", provider())?.entryId).toBe("a");
    expect(releaseProviderCacheAffinity("lane-1", "kimi", "a")).toBe(true);
    expect(releaseProviderCacheAffinity("lane-1", "kimi", "a")).toBe(false);
    expect(releaseProviderCacheAffinity(undefined)).toBe(false);
    expect(consult("lane-1", provider())).toBeNull();
  });

  test("single-credential providers never consult an existing binding", () => {
    const single = provider({ apiKeyPool: [{ id: "a", key: "key-a" }] });
    recordProviderCacheAffinity({
      lane: "lane-1",
      providerName: "kimi",
      entryId: "a",
      model: "m1",
      cacheRead: 9000,
      cacheWrite: 0,
      inputTokens: 9000,
      now: NOW,
    });
    expect(consult("lane-1", single, "m1", NOW + 1000)).toBeNull();
  });
});

describe("cache affinity at the proactive selection seam", () => {
  beforeEach(() => {
    clearProviderCacheAffinityForTests();
    clearKeyCooldowns();
  });

  function configWith(committedKey: string): OcxConfig {
    return {
      providers: {
        kimi: provider({ apiKey: committedKey }),
      },
    } as unknown as OcxConfig;
  }

  function bind(lane: string, entryId: string) {
    recordProviderCacheAffinity({
      lane, providerName: "kimi", entryId, model: "m1",
      cacheRead: 9000, cacheWrite: 0, inputTokens: 9000, now: Date.now(),
    });
  }

  test("selection returns the bound credential's transport, marked request-local", () => {
    bind("lane-1", "a");
    const config = configWith("key-b");
    const routed = routedProviderConfig("kimi", config.providers.kimi!);
    const picked = selectProactiveApiKeyTransport(config, "kimi", routed, undefined, Date.now(),
      { lane: "lane-1", model: "m1", log: {} });
    expect(picked?.apiKey).toBe("key-a");
    expect(picked?._apiKeyAttempt?.cacheAffinity).toBe(true);
    // The global committed selection is untouched: affinity is per-request.
    expect(config.providers.kimi!.apiKey).toBe("key-b");
  });

  test("a cooling bound credential falls through to ordinary selection and keeps its binding", () => {
    bind("lane-1", "a");
    setKeyCooldown("kimi", "a", Date.now() + 60_000);
    const config = configWith("key-b");
    const routed = routedProviderConfig("kimi", config.providers.kimi!);
    const picked = selectProactiveApiKeyTransport(config, "kimi", routed, undefined, Date.now(),
      { lane: "lane-1", model: "m1", log: {} });
    expect(picked).toBeNull();
    clearKeyCooldowns();
    const after = selectProactiveApiKeyTransport(config, "kimi", routed, undefined, Date.now(),
      { lane: "lane-1", model: "m1", log: {} });
    expect(after?.apiKey).toBe("key-a");
  });

  test("a removed bound credential releases the binding", () => {
    bind("lane-1", "a");
    const config = configWith("key-b");
    config.providers.kimi!.apiKeyPool = [{ id: "b", key: "key-b" }, { id: "c", key: "key-c" }];
    const routed = routedProviderConfig("kimi", config.providers.kimi!);
    expect(selectProactiveApiKeyTransport(config, "kimi", routed, undefined, Date.now(),
      { lane: "lane-1", model: "m1", log: {} })).toBeNull();
    // Binding gone: even with the entry restored, no preference remains.
    config.providers.kimi!.apiKeyPool = provider().apiKeyPool;
    expect(selectProactiveApiKeyTransport(config, "kimi", routed, undefined, Date.now(),
      { lane: "lane-1", model: "m1", log: {} })).toBeNull();
  });
});

describe("cache affinity against committed-key movement (persisted config)", () => {
  let home = "";
  let previousHome: string | undefined;

  beforeEach(() => {
    previousHome = process.env.OPENCODEX_HOME;
    home = mkdtempSync(join(tmpdir(), "ocx-cache-affinity-fence-"));
    process.env.OPENCODEX_HOME = home;
    forgetApiKeyRotationCursor();
    clearProviderCacheAffinityForTests();
    clearKeyCooldowns();
    resetProviderRequestPacingForTest();
  });

  afterEach(() => {
    clearKeyCooldowns();
    clearProviderCacheAffinityForTests();
    resetProviderRequestPacingForTest();
    if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
    else process.env.OPENCODEX_HOME = previousHome;
    if (home) removeTreeWithRetry(home);
  });

  function persistedConfig(overrides: Partial<OcxProviderConfig> = {}): OcxConfig {
    const config = {
      port: 0,
      providers: {
        "affinity-pool": provider({
          apiKey: "key-b",
          apiKeyPool: [
            { id: "a", key: "key-a" },
            { id: "b", key: "key-b" },
            { id: "c", key: "key-c" },
          ],
          ...overrides,
        }),
      },
    } as unknown as OcxConfig;
    saveConfig(config);
    return config;
  }

  function bindA(lane = "lane-1") {
    recordProviderCacheAffinity({
      lane, providerName: "affinity-pool", entryId: "a", model: "m1",
      cacheRead: 9000, cacheWrite: 0, inputTokens: 9000, now: Date.now(),
    });
  }

  function pick(config: OcxConfig, lane = "lane-1") {
    const routed = routedProviderConfig("affinity-pool", config.providers["affinity-pool"]!);
    return selectProactiveApiKeyTransport(config, "affinity-pool", routed, undefined, Date.now(),
      { lane, model: "m1", log: {} });
  }

  test.each([false, true])("round-robin failover stays request-local with affinity=%s", (affinity) => {
    const config = persistedConfig({
      apiKey: "key-a", apiKeySelectionRevision: "original",
      requestPacing: { enabled: true, keySelection: "round-robin" },
    });
    if (affinity) bindA();
    const selected = pick(config)!;
    expect(selected.apiKey).toBe("key-a");
    const recovered = rotateProviderTransportOn429(config, "affinity-pool", selected, { attemptedKey: "key-a" });
    expect(recovered?.apiKey).toBe("key-b");
    expect(recovered?._apiKeyAttempt?.distributed).toBe(true);
    expect(config.providers["affinity-pool"]!.apiKey).toBe("key-a");
    expect(loadConfig().providers["affinity-pool"]!.apiKey).toBe("key-a");
    expect(loadConfig().providers["affinity-pool"]!.apiKeySelectionRevision).toBe("original");
  });

  test("round-robin affinity survives revision movement through re-read and failover", () => {
    const config = persistedConfig({
      requestPacing: { enabled: true, keySelection: "round-robin", keys: { maxConcurrentRequests: 1 } },
      apiKeySelectionRevision: "before",
    });
    bindA();
    const selected = pick(config)!;
    expect(selected.apiKey).toBe("key-a");
    expect(selected._apiKeyAttempt?.distributed).toBe(true);
    config.providers["affinity-pool"]!.apiKey = "key-c";
    config.providers["affinity-pool"]!.apiKeySelectionRevision = "after";
    saveConfig(config);
    expect(providerApiKeySelectionIsCurrent(config, "affinity-pool", selected)).toBe(true);
    const rebuilt = resolveCurrentProviderApiKeyTransport(config, "affinity-pool", selected)!;
    expect(rebuilt.apiKey).toBe("key-a");
    expect(rebuilt._apiKeyAttempt?.distributed).toBe(true);
    const recovered = rotateProviderTransportOn429(config, "affinity-pool", rebuilt, { attemptedKey: "key-a" });
    expect(recovered?.apiKey).toBe("key-b");
    expect(loadConfig().providers["affinity-pool"]!.apiKey).toBe("key-c");
    expect(loadConfig().providers["affinity-pool"]!.apiKeySelectionRevision).toBe("after");
  });

  test.each(["disabled", "removed", "replaced"])("round-robin affinity fences a %s entry before failover", (change) => {
    const config = persistedConfig({ requestPacing: { enabled: true, keySelection: "round-robin" } });
    bindA();
    const selected = pick(config)!;
    const entry = config.providers["affinity-pool"]!.apiKeyPool![0]!;
    if (change === "disabled") entry.disabled = true;
    else if (change === "removed") config.providers["affinity-pool"]!.apiKeyPool!.shift();
    else entry.key = "replacement-key";
    saveConfig(config);
    expect(providerApiKeySelectionIsCurrent(config, "affinity-pool", selected)).toBe(false);
    expect(rotateProviderTransportOn429(config, "affinity-pool", selected, { attemptedKey: "key-a" })).toBeNull();
    expect(loadConfig().providers["affinity-pool"]!.apiKey).toBe("key-b");
  });

  test("an affinity pick survives another conversation's rotation (revision bump)", () => {
    const config = persistedConfig();
    bindA();
    const affinityTransport = pick(config);
    expect(affinityTransport?.apiKey).toBe("key-a");
    // Another conversation's 429 rotates the committed key b -> c, which bumps
    // the selection revision. The pin is fenced on entry liveness, not on that
    // revision, so dispatch re-reads still honor it.
    expect(rotateKeyOn429(config, "affinity-pool", null, Date.now(), "key-b")?.apiKey).toBe("key-c");
    expect(providerApiKeySelectionIsCurrent(config, "affinity-pool", affinityTransport!)).toBe(true);
    const rebuilt = resolveCurrentProviderApiKeyTransport(config, "affinity-pool", affinityTransport!);
    expect(rebuilt?.apiKey).toBe("key-a");
    expect(providerApiKeySelectionIsCurrent(config, "affinity-pool", rebuilt!)).toBe(true);
    expect(resolveCurrentProviderApiKeyTransport(config, "affinity-pool", rebuilt!)?.apiKey).toBe("key-a");
  });

  test("a 429 on the pinned key still rotates after the committed key moved", () => {
    const config = persistedConfig();
    bindA();
    const affinityTransport = pick(config);
    expect(affinityTransport?.apiKey).toBe("key-a");
    // Committed key moves b -> c (revision bump) before the pinned send fails.
    expect(rotateKeyOn429(config, "affinity-pool", null, Date.now(), "key-b")?.apiKey).toBe("key-c");
    const rotated = rotateProviderTransportOn429(config, "affinity-pool", affinityTransport!, {
      attemptedKey: "key-a",
      attemptedSelection: affinityTransport!._apiKeyAttempt,
      now: Date.now(),
    });
    // b is cooling from the earlier rotation; the spare is c, not a 429 surface.
    expect(rotated?.apiKey).toBe("key-c");
  });

  test("a bound key inside a long minimum interval falls through until its slot approaches", async () => {
    const config = persistedConfig({
      requestPacing: { enabled: true, keys: { minIntervalMs: 120_000 } },
    });
    bindA();
    const rowA = { ...config.providers["affinity-pool"]!, apiKey: "key-a" };
    // One start on key-a pushes its next permitted start two minutes out:
    // past what the send queue tolerates, so affinity must not pin to it.
    (await waitForProviderRequestSlot("affinity-pool", rowA, "m1")).release();
    expect(pick(config)).toBeNull();
    resetProviderRequestPacingForTest();
    expect(pick(config)?.apiKey).toBe("key-a");
  });

  test("a pacing-saturated bound key falls through to ordinary selection", async () => {
    const config = persistedConfig({
      requestPacing: { enabled: true, keys: { maxConcurrentRequests: 1 } },
    });
    bindA();
    const rowA = { ...config.providers["affinity-pool"]!, apiKey: "key-a" };
    const held = await waitForProviderRequestSlot("affinity-pool", rowA, "m1");
    try {
      expect(pick(config)).toBeNull();
    } finally {
      held.release();
    }
    expect(pick(config)?.apiKey).toBe("key-a");
  });
});
