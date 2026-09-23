import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OcxProviderConfig } from "../../src/types";

/**
 * Data-driven reasoning ladders (models.dev snapshot + learned refusals).
 *
 * OpenCode Zen Go publishes model ids only, so the catalog used to advertise whatever the
 * registry hardcoded -- including rungs the upstream refuses (muse-spark max -> 400 "requires an
 * active Muse Code subscription"). These cases pin the metadata fallback, the wire clamp and the
 * learned-refusal filter that keeps a rejected rung out of every later request.
 */

const ZEN_GO: OcxProviderConfig = {
  adapter: "openai-chat",
  baseUrl: "https://opencode.ai/zen/go/v1",
  apiKey: "test-zen-go-key",
} as OcxProviderConfig;

const MUSE_SPARK = "muse-spark-1.3-contributor";
const DEEPSEEK_FLASH = "deepseek-v4.1-flash";

const REJECTION_BODY = JSON.stringify({
  model: MUSE_SPARK,
  error: {
    param: "reasoning.effort",
    type: "invalid_request_error",
    message: "Error from provider (Console Go): Upstream request failed: [invalid_request_error] reasoning_effort max requires an active Muse Code subscription for model muse-spark-1.3-contributor.",
  },
});

const roots: string[] = [];
const originalOpenCodexHome = process.env["OPENCODEX_HOME"];

function snapshotFile(providers: Record<string, unknown>): Record<string, unknown> {
  return { version: 1, fetchedAt: Date.now(), source: "test", providers };
}

function sandbox(files: Record<string, string> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "ocx-reasoning-metadata-"));
  roots.push(dir);
  for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body);
  process.env["OPENCODEX_HOME"] = dir;
  return dir;
}

async function load(files: Record<string, string> = {}) {
  sandbox(files);
  const metadata = await import("../../src/providers/reasoning-metadata");
  const effort = await import("../../src/reasoning-effort");
  metadata.resetReasoningMetadataCachesForTests();
  return { metadata, effort };
}

function metadataFile(providers: Record<string, unknown>): Record<string, string> {
  return { "reasoning-metadata-cache.json": JSON.stringify(snapshotFile(providers)) };
}

function metadataFileV2(providers: Record<string, unknown>, apis: Record<string, string>): Record<string, string> {
  return {
    "reasoning-metadata-cache.json": JSON.stringify({ ...snapshotFile(providers), version: 2, apis }),
  };
}

function supportFile(rows: Record<string, unknown>, version = 2): Record<string, string> {
  return { "reasoning-support-cache.json": JSON.stringify({ version, rows }) };
}

afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
  // Restore rather than delete. Unsetting it entirely pointed every later test file in the same
  // bun process at the real ~/.opencodex, which read the machine's actual configuration and
  // failed unrelated suites (tests/web-search) depending on file order.
  if (originalOpenCodexHome === undefined) delete process.env["OPENCODEX_HOME"];
  else process.env["OPENCODEX_HOME"] = originalOpenCodexHome;
});

describe("models.dev reasoning metadata", () => {
  test("an expired snapshot read refreshes in the background with Codex integration off; a missing snapshot does not", async () => {
    const stale = snapshotFile({
      "opencode-go": {
        [MUSE_SPARK]: { reasoning: true, options: [{ type: "effort", values: ["low", "high"] }] },
      },
    });
    stale.fetchedAt = Date.now() - 25 * 60 * 60 * 1000;
    const { effort, metadata } = await load({
      "config.json": JSON.stringify({ clientIntegrations: { codex: false } }),
      "reasoning-metadata-cache.json": JSON.stringify(stale),
    });
    const previousFetch = globalThis.fetch;
    let requests = 0;
    try {
      globalThis.fetch = (() => {
        requests += 1;
        return Promise.reject(new Error("offline fixture"));
      }) as typeof fetch;
      expect(effort.configuredReasoningEfforts(ZEN_GO, MUSE_SPARK)).toEqual(["low", "high"]);
      expect(requests).toBe(1);

      await load({ "config.json": JSON.stringify({ clientIntegrations: { codex: false } }) });
      expect(effort.configuredReasoningEfforts(ZEN_GO, MUSE_SPARK)).toBeUndefined();
      expect(effort.configuredReasoningEfforts({ ...ZEN_GO, thinkingToggleModels: [MUSE_SPARK] }, MUSE_SPARK)).toEqual(["low", "medium", "high", "xhigh", "max"]);
      expect(requests).toBe(1);
    } finally {
      globalThis.fetch = previousFetch;
      metadata.resetReasoningMetadataCachesForTests();
    }
  });

  test("a hung fetch cannot hold either a new or coalesced bounded refresh", async () => {
    const { metadata } = await load();
    const previousFetch = globalThis.fetch;
    let releaseFetch: (() => void) | undefined;
    try {
      globalThis.fetch = (() => new Promise((_resolve, reject) => {
        releaseFetch = () => reject(new Error("fixture released"));
      })) as typeof fetch;
      const fresh = metadata.refreshReasoningMetadata({ force: true, waitMs: 25 });
      const coalesced = metadata.refreshReasoningMetadata({ force: true, waitMs: 25 });
      expect(await Promise.all([fresh, coalesced])).toEqual([
        { ok: false, reason: "wait budget exceeded" },
        { ok: false, reason: "wait budget exceeded" },
      ]);
    } finally {
      releaseFetch?.();
      globalThis.fetch = previousFetch;
      await new Promise(resolve => setTimeout(resolve, 0));
      metadata.resetReasoningMetadataCachesForTests();
    }
  });

  test("advertises the published effort rungs and strips the none/minimal sentinels", async () => {
    const { effort } = await load(metadataFile({
      "opencode-go": {
        [MUSE_SPARK]: { reasoning: true, options: [{ type: "effort", values: ["minimal", "low", "medium", "high", "xhigh"] }] },
      },
    }));
    expect(effort.configuredReasoningEfforts(ZEN_GO, MUSE_SPARK)).toEqual(["low", "medium", "high", "xhigh"]);
  });

  test("clamps a rung the model does not publish instead of failing upstream", async () => {
    const { effort } = await load(metadataFile({
      "opencode-go": {
        [MUSE_SPARK]: { reasoning: true, options: [{ type: "effort", values: ["minimal", "low", "medium", "high", "xhigh"] }] },
        [DEEPSEEK_FLASH]: { reasoning: true, options: [{ type: "effort", values: ["low", "high", "max"] }] },
      },
    }));
    expect(effort.mapReasoningEffort(ZEN_GO, MUSE_SPARK, "max")).toBe("xhigh");
    expect(effort.mapReasoningEffort(ZEN_GO, DEEPSEEK_FLASH, "max")).toBe("max");
    expect(effort.mapReasoningEffort(ZEN_GO, DEEPSEEK_FLASH, "ultra")).toBe("max");
  });

  test("a hand-written ladder stays authoritative and unknown models stay untouched", async () => {
    const { effort } = await load(metadataFile({
      "opencode-go": { [MUSE_SPARK]: { reasoning: true, options: [{ type: "effort", values: ["low", "medium", "high", "xhigh"] }] } },
    }));
    const pinned = { ...ZEN_GO, modelReasoningEfforts: { [MUSE_SPARK]: ["low", "high"] } } as OcxProviderConfig;
    expect(effort.configuredReasoningEfforts(pinned, MUSE_SPARK)).toEqual(["low", "high"]);
    expect(effort.configuredReasoningEfforts(ZEN_GO, "not-a-model")).toBeUndefined();
  });

  test("a destination the snapshot does not describe keeps the previous behaviour", async () => {
    const { effort } = await load(metadataFile({
      "opencode-go": { [MUSE_SPARK]: { reasoning: true, options: [{ type: "effort", values: ["low", "high"] }] } },
    }));
    const elsewhere = { ...ZEN_GO, baseUrl: "https://api.deepseek.com/v1" } as OcxProviderConfig;
    expect(effort.configuredReasoningEfforts(elsewhere, MUSE_SPARK)).toBeUndefined();
  });

  test("a toggle-only entry never invents wire semantics for an unclassified model", async () => {
    const { effort } = await load(metadataFile({
      "opencode-go": { "minimax-m3": { reasoning: true, options: [{ type: "toggle" }] } },
    }));
    expect(effort.configuredReasoningEfforts(ZEN_GO, "minimax-m3")).toBeUndefined();
  });

  test("a corrupt or missing snapshot falls back to the status quo", async () => {
    const { effort } = await load({ "reasoning-metadata-cache.json": "{not json" });
    expect(effort.configuredReasoningEfforts(ZEN_GO, MUSE_SPARK)).toBeUndefined();
    expect(effort.mapReasoningEffort(ZEN_GO, MUSE_SPARK, "max")).toBe("max");
  });
});

describe("learned rung refusals", () => {
  test("drops a refused rung from a metadata-derived ladder", async () => {
    const { effort, metadata } = await load({
      ...metadataFile({ "opencode-go": { [DEEPSEEK_FLASH]: { reasoning: true, options: [{ type: "effort", values: ["low", "high", "max"] }] } } }),
    });
    expect(metadata.recordUnsupportedReasoningEffort(ZEN_GO, DEEPSEEK_FLASH, "max")).toBe(true);
    expect(effort.configuredReasoningEfforts(ZEN_GO, DEEPSEEK_FLASH)).toEqual(["low", "high"]);
    expect(effort.mapReasoningEffort(ZEN_GO, DEEPSEEK_FLASH, "max")).toBe("high");
  });

  test("drops a refused rung from a ladder pinned in the registry too", async () => {
    const { effort, metadata } = await load();
    expect(metadata.recordUnsupportedReasoningEffort(ZEN_GO, DEEPSEEK_FLASH, "max")).toBe(true);
    const pinned = { ...ZEN_GO, modelReasoningEfforts: { [DEEPSEEK_FLASH]: ["low", "high", "max"] } } as OcxProviderConfig;
    expect(effort.configuredReasoningEfforts(pinned, DEEPSEEK_FLASH)).toEqual(["low", "high"]);
  });

  test("keeps learned refusals isolated between credentials at the same destination", async () => {
    const { effort, metadata } = await load(metadataFile({
      "opencode-go": { [DEEPSEEK_FLASH]: { reasoning: true, options: [{ type: "effort", values: ["low", "high", "max"] }] } },
    }));
    const lowEntitlement = { ...ZEN_GO, apiKey: "low-entitlement-key" } as OcxProviderConfig;
    const highEntitlement = { ...ZEN_GO, apiKey: "high-entitlement-key" } as OcxProviderConfig;
    expect(metadata.recordUnsupportedReasoningEffort(lowEntitlement, DEEPSEEK_FLASH, "max")).toBe(true);
    expect(effort.configuredReasoningEfforts(lowEntitlement, DEEPSEEK_FLASH)).toEqual(["low", "high"]);
    expect(effort.configuredReasoningEfforts(highEntitlement, DEEPSEEK_FLASH)).toEqual(["low", "high", "max"]);
  });

  // The catalog path carries the configured expression in apiKey; the request path carries the
  // resolved secret in apiKey and the configured expression in _apiKeyAttempt.reference. Both
  // must hash the same wire credential, or a refusal learned at request time never clamps the
  // advertised ladder for env/keychain users.
  test("a refusal learned under the resolved request key applies to the catalog's env reference", async () => {
    const { effort, metadata } = await load(metadataFile({
      "opencode-go": { [DEEPSEEK_FLASH]: { reasoning: true, options: [{ type: "effort", values: ["low", "high", "max"] }] } },
    }));
    process.env["OCX_REASONING_METADATA_TEST_KEY"] = "resolved-env-secret";
    try {
      const catalogSide = { ...ZEN_GO, apiKey: "${OCX_REASONING_METADATA_TEST_KEY}" } as OcxProviderConfig;
      const requestSide = {
        ...ZEN_GO,
        apiKey: "resolved-env-secret",
        _apiKeyAttempt: { reference: "${OCX_REASONING_METADATA_TEST_KEY}" },
      } as OcxProviderConfig;
      expect(metadata.recordUnsupportedReasoningEffort(requestSide, DEEPSEEK_FLASH, "max")).toBe(true);
      expect(effort.configuredReasoningEfforts(catalogSide, DEEPSEEK_FLASH)).toEqual(["low", "high"]);
    } finally {
      delete process.env["OCX_REASONING_METADATA_TEST_KEY"];
    }
  });

  test("a refusal learned under the catalog's env reference applies to the resolved request key", async () => {
    const { effort, metadata } = await load(metadataFile({
      "opencode-go": { [DEEPSEEK_FLASH]: { reasoning: true, options: [{ type: "effort", values: ["low", "high", "max"] }] } },
    }));
    process.env["OCX_REASONING_METADATA_TEST_KEY"] = "resolved-env-secret";
    try {
      const catalogSide = { ...ZEN_GO, apiKey: "${OCX_REASONING_METADATA_TEST_KEY}" } as OcxProviderConfig;
      const requestSide = {
        ...ZEN_GO,
        apiKey: "resolved-env-secret",
        _apiKeyAttempt: { reference: "${OCX_REASONING_METADATA_TEST_KEY}" },
      } as OcxProviderConfig;
      expect(metadata.recordUnsupportedReasoningEffort(catalogSide, DEEPSEEK_FLASH, "max")).toBe(true);
      expect(effort.configuredReasoningEfforts(requestSide, DEEPSEEK_FLASH)).toEqual(["low", "high"]);
    } finally {
      delete process.env["OCX_REASONING_METADATA_TEST_KEY"];
    }
  });

  test("a keychain-referenced key scopes refusals to the resolved secret on both paths", async () => {
    const { effort, metadata } = await load(metadataFile({
      "opencode-go": { [DEEPSEEK_FLASH]: { reasoning: true, options: [{ type: "effort", values: ["low", "high", "max"] }] } },
    }));
    const keyStore = await import("../../src/providers/api-key-resolve");
    const store = new Map<string, string>();
    store.set("opencodex.provider-api-key.v1 zen-go", "resolved-keychain-secret");
    keyStore.setProviderKeychainEntryFactoryForTests((service, account) => ({
      getPassword: () => store.get(service + " " + account) ?? null,
      setPassword: (password) => { store.set(service + " " + account, password); },
      deletePassword: () => store.delete(service + " " + account),
    }));
    try {
      const catalogSide = { ...ZEN_GO, apiKey: "keychain:zen-go" } as OcxProviderConfig;
      const requestSide = {
        ...ZEN_GO,
        apiKey: "resolved-keychain-secret",
        _apiKeyAttempt: { reference: "keychain:zen-go" },
      } as OcxProviderConfig;
      expect(metadata.recordUnsupportedReasoningEffort(requestSide, DEEPSEEK_FLASH, "max")).toBe(true);
      expect(effort.configuredReasoningEfforts(catalogSide, DEEPSEEK_FLASH)).toEqual(["low", "high"]);
    } finally {
      keyStore.setProviderKeychainEntryFactoryForTests(null);
    }
  });

  // The request path must hash the credential that served the request, not a live re-read of
  // the reference: a rotation between routing and refusal recording would otherwise bind the
  // learned refusal to the rotated credential and leave the refused one unclamped.
  test("a refusal learned at request time stays bound to the serving credential after rotation", async () => {
    const { effort, metadata } = await load(metadataFile({
      "opencode-go": { [DEEPSEEK_FLASH]: { reasoning: true, options: [{ type: "effort", values: ["low", "high", "max"] }] } },
    }));
    process.env["OCX_REASONING_METADATA_TEST_KEY"] = "serving-secret";
    const requestSide = {
      ...ZEN_GO,
      apiKey: "serving-secret",
      _apiKeyAttempt: { reference: "${OCX_REASONING_METADATA_TEST_KEY}" },
    } as OcxProviderConfig;
    // Rotate behind the stable reference after routing but before the refusal is recorded.
    process.env["OCX_REASONING_METADATA_TEST_KEY"] = "rotated-secret";
    try {
      expect(metadata.recordUnsupportedReasoningEffort(requestSide, DEEPSEEK_FLASH, "max")).toBe(true);
      const served = { ...ZEN_GO, apiKey: "serving-secret" } as OcxProviderConfig;
      const rotated = { ...ZEN_GO, apiKey: "rotated-secret" } as OcxProviderConfig;
      expect(effort.configuredReasoningEfforts(served, DEEPSEEK_FLASH)).toEqual(["low", "high"]);
      expect(effort.configuredReasoningEfforts(rotated, DEEPSEEK_FLASH)).toEqual(["low", "high", "max"]);
    } finally {
      delete process.env["OCX_REASONING_METADATA_TEST_KEY"];
    }
  });

  test("ignores legacy destination-wide support rows", async () => {
    const legacyRows = { ["opencode-go|" + DEEPSEEK_FLASH + "|max"]: { effort: "max", at: Date.now() } };
    const { effort } = await load({
      ...metadataFile({ "opencode-go": { [DEEPSEEK_FLASH]: { reasoning: true, options: [{ type: "effort", values: ["low", "high", "max"] }] } } }),
      ...supportFile(legacyRows, 1),
    });
    expect(effort.configuredReasoningEfforts(ZEN_GO, DEEPSEEK_FLASH)).toEqual(["low", "high", "max"]);
  });

  test("records the refusal and plans the next lower published rung once", async () => {
    const { metadata } = await load({
      ...metadataFile({ "opencode-go": { [DEEPSEEK_FLASH]: { reasoning: true, options: [{ type: "effort", values: ["low", "high", "max"] }] } } }),
    });
    const first = metadata.planReasoningEffortDowngrade({
      provider: ZEN_GO, modelId: DEEPSEEK_FLASH, requested: "max", rejectionText: REJECTION_BODY,
    });
    expect(first).toEqual({ effort: "high", recorded: true });
    metadata.flushReasoningSupportCache();
    const second = metadata.planReasoningEffortDowngrade({
      provider: ZEN_GO, modelId: DEEPSEEK_FLASH, requested: "max", rejectionText: REJECTION_BODY,
    });
    expect(second).toEqual({ effort: "high", recorded: false });
  });

  test("classifies only reasoning-effort refusals", async () => {
    const { metadata } = await load();
    expect(metadata.isReasoningEffortRejection(REJECTION_BODY)).toBe(true);
    expect(metadata.isReasoningEffortRejection(JSON.stringify({ error: { message: "Invalid upload request." } }))).toBe(false);
    expect(metadata.isReasoningEffortRejection(undefined)).toBe(false);
  });

  // The near miss the parameter name alone cannot tell apart: the upstream is refusing
  // `max_tokens` and merely echoing the request it received, `reasoning_effort` included.
  // Reading that as a refusal spends the turn's one downgrade replay and persists a refusal
  // that clamps the ladder for thirty days.
  test("an unrelated refusal that echoes reasoning_effort is not a reasoning-effort refusal", async () => {
    const { metadata } = await load();
    const echoed = JSON.stringify({
      error: {
        param: "max_tokens",
        type: "invalid_request_error",
        message: "max_tokens must be a positive integer.",
      },
      request: { model: "muse-spark-1.3-contributor", reasoning_effort: "max", max_tokens: -1 },
    });
    expect(metadata.isReasoningEffortRejection(echoed)).toBe(false);
  });

  test("still classifies a refusal that names the effort parameter without the word effort", async () => {
    const { metadata } = await load();
    expect(metadata.isReasoningEffortRejection(JSON.stringify({
      error: { param: "reasoning.effort", message: "Unsupported value for this model." },
    }))).toBe(true);
  });
});

describe("destination resolution", () => {
  const ZEN = { ...ZEN_GO, baseUrl: "https://opencode.ai/zen/v1" } as OcxProviderConfig;
  const MODEL = { [MUSE_SPARK]: { reasoning: true, options: [{ type: "effort", values: ["low", "high"] }] } };

  test("resolves the OpenCode family and tolerates a trailing slash", async () => {
    const { effort } = await load(metadataFile({ "opencode": MODEL, "opencode-go": MODEL }));
    expect(effort.configuredReasoningEfforts(ZEN, MUSE_SPARK)).toEqual(["low", "high"]);
    const trailingSlash = { ...ZEN_GO, baseUrl: "https://opencode.ai/zen/go/v1/" } as OcxProviderConfig;
    expect(effort.configuredReasoningEfforts(trailingSlash, MUSE_SPARK)).toEqual(["low", "high"]);
  });

  // 36 of the registry's 83 destinations match a models.dev provider, so resolving by URL alone
  // would move ladders for providers this change has no evidence for. The gate stays explicit.
  test("a destination that only matches by URL stays gated out", async () => {
    const { effort } = await load(metadataFileV2(
      { "some-upstream": MODEL },
      { "some-upstream": "https://api.some-upstream.example/v1" },
    ));
    const provider = { ...ZEN_GO, baseUrl: "https://api.some-upstream.example/v1" } as OcxProviderConfig;
    expect(effort.configuredReasoningEfforts(provider, MUSE_SPARK)).toBeUndefined();
  });

  test("the v2 snapshot confirms the gate against each provider's published api url", async () => {
    const { metadata } = await load(metadataFileV2(
      { "opencode-go": MODEL },
      { "opencode-go": "https://opencode.ai/zen/go" },
    ));
    expect(metadata.reasoningMetadataMapping()).toEqual([
      { destination: "https://opencode.ai/zen/go/v1", provider: "opencode-go", publishedApi: "https://opencode.ai/zen/go", confirmed: true, models: 1 },
      { destination: "https://opencode.ai/zen/v1", provider: "opencode", models: 0 },
    ]);
  });

  test("a v1 snapshot without published api urls still resolves through the table", async () => {
    const { metadata } = await load(metadataFile({ "opencode-go": MODEL }));
    const [zenGo] = metadata.reasoningMetadataMapping();
    expect(zenGo.publishedApi).toBeUndefined();
    expect(zenGo.confirmed).toBeUndefined();
    expect(zenGo.models).toBe(1);
  });
});
