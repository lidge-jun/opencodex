import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  fetchCodeBuddyModels,
  parseCodeBuddyConfigRoster,
  setFetchCodeBuddyModelsForTests,
} from "../../src/adapters/codebuddy/live-models";
import { CODEBUDDY_CN_PROFILE, CODEBUDDY_GLOBAL_PROFILE } from "../../src/adapters/codebuddy/profiles";
import { gatherRoutedModels, resetCatalogRuntimeStateForTests } from "../../src/codex/catalog";
import { clearModelCache, setCached } from "../../src/codex/model-cache";
import type { OcxConfig } from "../../src/types";

// Envelope captured 260923 from GET https://www.codebuddy.cn/v3/config with a valid CN key:
// data.agents[0].models is the same 17-id roster the CLI prints for --model on a signed-in
// account of that key, and data.models carries the wider per-account metadata catalog.
function authenticatedEnvelope(models: string[] = ["hy4-preview-f", "hy3", "hy3-x", "deepseek-v4.1-flash", "glm-5.3", "glm-5.3-flash", "glm-5.3-flashx", "glm-5.2", "glm-5.1", "glm-5v-turbo", "minimax-m3-pay", "minimax-m2.7", "kimi-k3-2", "kimi-k2.8-preview", "kimi-k2.7", "kimi-k2.6", "deepseek-v4-pro"]): unknown {
  return { code: 0, msg: "ok", requestId: "req-test", data: { agents: [{ name: "cli", models, tools: [] }], enterpriseId: "ent", models: models.map(id => ({ id, name: id })), productFeatures: {} } };
}

// Envelope measured 260923 for an absent or invalid key: the anonymous config answers no
// agents array at all and an empty models list, so no roster exists to misattribute.
const ANONYMOUS_ENVELOPE: unknown = { code: 0, msg: "ok", requestId: "req-test", data: { agent: {}, models: [], mcp: {}, codebase: {}, features: {} } };

describe("CodeBuddy configuration-roster parser", () => {
  test("parses the authenticated key's roster in order", () => {
    const result = parseCodeBuddyConfigRoster(authenticatedEnvelope());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.models).toHaveLength(17);
      expect(result.models[0]).toBe("hy4-preview-f");
      expect(result.models).toContain("kimi-k3-2");
      expect(result.models).toContain("deepseek-v4.1-flash");
    }
  });

  test("filters custom selectors, blanks, and duplicates", () => {
    const result = parseCodeBuddyConfigRoster(authenticatedEnvelope(["kimi-k3-2", "custom:mine", "kimi-k3-2", ""]));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.models).toEqual(["kimi-k3-2"]);
  });

  test("prefers the cli agent when several agents are declared", () => {
    const body = { data: { agents: [
      { name: "other", models: ["other-model"] },
      { name: "cli", models: ["cli-model"] },
    ] } };
    const result = parseCodeBuddyConfigRoster(body);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.models).toEqual(["cli-model"]);
  });

  test("the anonymous envelope an invalid key receives fails closed as empty", () => {
    const result = parseCodeBuddyConfigRoster(ANONYMOUS_ENVELOPE);
    expect(result).toMatchObject({ ok: false, error: "empty" });
    if (!result.ok) expect(result.detail).toContain("anonymous");
  });

  test("a missing data object fails closed", () => {
    expect(parseCodeBuddyConfigRoster({ code: 0, msg: "ok" })).toMatchObject({ ok: false, error: "invalid_output" });
    expect(parseCodeBuddyConfigRoster(null)).toMatchObject({ ok: false, error: "invalid_output" });
  });

  test("an authenticated envelope with an empty agent roster fails closed", () => {
    expect(parseCodeBuddyConfigRoster(authenticatedEnvelope([]))).toMatchObject({ ok: false, error: "empty" });
  });
});

describe("CodeBuddy live model fetch", () => {
  function recordingFetch(status: number, body: unknown) {
    const seen: { url: string; headers: Record<string, string> }[] = [];
    const fetchLike = (async (url: RequestInfo | URL, init?: RequestInit) => {
      const headers: Record<string, string> = {};
      for (const [key, value] of Object.entries(init?.headers ?? {})) headers[key.toLowerCase()] = String(value);
      seen.push({ url: String(url), headers });
      return new Response(status === 200 ? JSON.stringify(body) : JSON.stringify(body), { status });
    }) as typeof fetch;
    return { fetchLike, seen };
  }

  test("requests the region's configuration endpoint with the key and returns the roster", async () => {
    const { fetchLike, seen } = recordingFetch(200, authenticatedEnvelope());
    const result = await fetchCodeBuddyModels(CODEBUDDY_CN_PROFILE, "cb-cn-key", { fetch: fetchLike });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.models).toContain("kimi-k3-2");
    expect(seen).toHaveLength(1);
    expect(seen[0]!.url).toBe("https://www.codebuddy.cn/v3/config");
    // The roster's authority is the key on the request: the header must carry it, and the
    // gateway requires a CLI-shaped User-Agent before it authenticates the key at all.
    expect(seen[0]!.headers["x-api-key"]).toBe("cb-cn-key");
    expect(seen[0]!.headers["user-agent"]).toMatch(/^CLI\/\d+\.\d+\.\d+ CodeBuddy\/\d+\.\d+\.\d+$/);
  });

  test("the global profile addresses the global configuration endpoint", async () => {
    const { fetchLike, seen } = recordingFetch(200, authenticatedEnvelope(["glm-5.3"]));
    const result = await fetchCodeBuddyModels(CODEBUDDY_GLOBAL_PROFILE, "cb-global-key", { fetch: fetchLike });
    expect(result.ok).toBe(true);
    expect(seen[0]!.url).toBe("https://www.codebuddy.ai/v3/config");
  });

  test("a non-200 answer is a clear error carrying the gateway's message", async () => {
    const { fetchLike } = recordingFetch(400, { code: 12403, msg: "check ua, get coding copilot version error" });
    const result = await fetchCodeBuddyModels(CODEBUDDY_CN_PROFILE, "cb-cn-key", { fetch: fetchLike });
    expect(result).toMatchObject({ ok: false, error: "http" });
    if (!result.ok) expect(result.detail).toContain("check ua");
  });

  test("a timed-out request is a timeout, never a crash", async () => {
    const fetchLike = (async () => {
      throw Object.assign(new Error("timed out"), { name: "TimeoutError" });
    }) as typeof fetch;
    const result = await fetchCodeBuddyModels(CODEBUDDY_CN_PROFILE, "cb-cn-key", { fetch: fetchLike });
    expect(result).toMatchObject({ ok: false, error: "timeout" });
  });

  test("a body that is not JSON fails closed as invalid output", async () => {
    const fetchLike = (async () => new Response("<html>gateway error page</html>", { status: 200 })) as typeof fetch;
    const result = await fetchCodeBuddyModels(CODEBUDDY_CN_PROFILE, "cb-cn-key", { fetch: fetchLike });
    expect(result).toMatchObject({ ok: false, error: "invalid_output" });
  });

  test("a chunked body that crosses the byte limit fails as too_large and cancels the stream", async () => {
    // 256 KiB chunks: the third crossing chunk must cancel the reader, so a compromised
    // upstream cannot keep discovery reading (or buffering) past the advertised cap.
    const chunk = new Uint8Array(256 * 1024).fill(0x61);
    let cancelled = false;
    let pulls = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        controller.enqueue(chunk);
      },
      cancel() { cancelled = true; },
    });
    const fetchLike = (async () => new Response(stream, { status: 200, headers: { "content-type": "application/json" } })) as typeof fetch;
    const result = await fetchCodeBuddyModels(CODEBUDDY_CN_PROFILE, "cb-cn-key", { fetch: fetchLike });
    expect(result).toMatchObject({ ok: false, error: "too_large" });
    expect(cancelled).toBe(true);
    // Two chunks fit under the cap; the third is the crossing one. The stream machinery
    // may prefetch one chunk ahead, so the bound is "a handful", never stream-sized.
    expect(pulls).toBeLessThanOrEqual(4);
  });

  test("a declared Content-Length above the cap is refused without reading the body", async () => {
    const chunk = new Uint8Array(16).fill(0x61);
    let pulls = 0;
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        controller.enqueue(chunk);
      },
      cancel() { cancelled = true; },
    });
    const fetchLike = (async () => new Response(stream, {
      status: 200,
      headers: { "content-type": "application/json", "content-length": String(600 * 1024) },
    })) as typeof fetch;
    const result = await fetchCodeBuddyModels(CODEBUDDY_CN_PROFILE, "cb-cn-key", { fetch: fetchLike });
    expect(result).toMatchObject({ ok: false, error: "too_large" });
    // The declared length is refused before the body is read; the wrapper's teardown may
    // still cost one prefetch chunk, never the declared 600 KiB.
    expect(pulls).toBeLessThanOrEqual(1);
    expect(cancelled).toBe(true);
  });
});

describe("CodeBuddy catalog cache isolation", () => {
  afterEach(() => {
    setFetchCodeBuddyModelsForTests(null);
    clearModelCache();
    resetCatalogRuntimeStateForTests();
  });

  function codeBuddyConfig(apiKey: string): OcxConfig {
    return {
      providers: {
        "codebuddy-cn": {
          adapter: "codebuddy",
          baseUrl: "https://www.codebuddy.cn",
          authMode: "key",
          apiKey,
          liveModels: true,
          defaultModel: "default",
          // Mirrors the registry seed: the static list ships the vendor default even though
          // the key-scoped configuration roster does not list it.
          models: ["default"],
        },
      },
    } as unknown as OcxConfig;
  }

  test("a fetch-failure cooldown for one key does not suppress another key's discovery", async () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      let keyBFetches = 0;
      setFetchCodeBuddyModelsForTests((_profile, apiKey) => {
        if (apiKey === "cb-key-a") return { ok: false, error: "http", detail: "denied" };
        keyBFetches += 1;
        return { ok: true, models: ["roster-b-model"] };
      });

      // Seed a stale (TTL-expired) roster for key B so the cooldown branch is reachable.
      const identityB = createHash("sha256").update("cb-key-b").digest("hex");
      setCached("codebuddy-cn", [{ id: "roster-b-old", provider: "codebuddy-cn" }], Date.now() - 3_600_000, undefined, identityB);

      // Key A fails discovery: the cooldown must be recorded against A's fingerprint only.
      const withA = await gatherRoutedModels(codeBuddyConfig("cb-key-a"));
      expect(withA.filter(m => m.provider === "codebuddy-cn").map(m => m.id)).not.toContain("roster-b-model");

      // Key B still has its own stale roster, but A's cooldown is not B's: discovery must run.
      const withB = await gatherRoutedModels(codeBuddyConfig("cb-key-b"));
      expect(keyBFetches).toBe(1);
      expect(withB.filter(m => m.provider === "codebuddy-cn").map(m => m.id)).toContain("roster-b-model");
    } finally {
      warn.mockRestore();
    }
  });

  test("a second key never receives the first key's fresh or stale roster", async () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      setFetchCodeBuddyModelsForTests((_profile, apiKey) => (
        apiKey === "cb-key-a"
          ? { ok: true, models: ["roster-a-model"] }
          : { ok: false, error: "http", detail: "denied" }
      ));

      const first = await gatherRoutedModels(codeBuddyConfig("cb-key-a"));
      const firstIds = first.filter(model => model.provider === "codebuddy-cn").map(model => model.id);
      expect(firstIds).toContain("roster-a-model");
      // The vendor default is callable even though the live roster omits it.
      expect(firstIds).toContain("default");

      // Key B's fetch fails: neither the fresh nor the stale cache entry recorded for key A
      // may leak into key B's catalog.
      const second = await gatherRoutedModels(codeBuddyConfig("cb-key-b"));
      const secondIds = second.filter(model => model.provider === "codebuddy-cn").map(model => model.id);
      expect(secondIds).not.toContain("roster-a-model");
      expect(secondIds).toContain("default");
    } finally {
      warn.mockRestore();
    }
  });
});

// The roster authority is the key on the request, so the cached roster can only ever be the
// key's own answer. The remaining cross-key guard is the cooldown/fingerprint isolation above.
test("an invalid key answers the anonymous envelope and never caches a roster", async () => {
  setFetchCodeBuddyModelsForTests(() => ({ ok: false, error: "empty", detail: "anonymous" }));
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  try {
    clearModelCache();
    resetCatalogRuntimeStateForTests();
    const config = {
      providers: {
        "codebuddy-cn": {
          adapter: "codebuddy",
          baseUrl: "https://www.codebuddy.cn",
          authMode: "key",
          apiKey: "cb-wrong-key",
          liveModels: true,
          defaultModel: "default",
          models: ["default"],
        },
      },
    } as unknown as OcxConfig;
    const models = await gatherRoutedModels(config);
    const ids = models.filter(m => m.provider === "codebuddy-cn").map(m => m.id);
    // Degraded to the configured selector only — no roster from any other account.
    expect(ids).toEqual(["default"]);
  } finally {
    warn.mockRestore();
    setFetchCodeBuddyModelsForTests(null);
    clearModelCache();
    resetCatalogRuntimeStateForTests();
  }
});
