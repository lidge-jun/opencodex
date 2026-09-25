/**
 * Devin live-discovery collapse and advertised-catalog propagation for
 * ClientModelConfig field #5 (supportsImages).
 *
 * Catalogs are hand-encoded protobuf run through the real parser
 * (parseCatalogBuffer) and installed through setCachedCatalogForTests, so the
 * tests cover the collapse in fetchDevinUsableModels and the Devin branch of
 * fetchProviderModels without touching the network. KEY is unique to this
 * file and HOST is the stripped default host: getCachedCatalog hits only on
 * an exact (apiKey, host) match with a fresh fetchedAt.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as oauth from "../../src/oauth";
import { fetchDevinUsableModels } from "../../src/adapters/devin/live-models";
import { parseCatalogBuffer, setCachedCatalogForTests } from "../../src/adapters/devin/cloud-direct/catalog";
import { encodeMessage, encodeString, encodeVarintField } from "../../src/adapters/devin/cloud-direct/wire";
import { fetchProviderModels } from "../../src/codex/catalog/provider-fetch";
import { clearModelCache, providerCacheGenerations } from "../../src/codex/model-cache";
import type { OcxProviderConfig } from "../../src/types";

const HOST = "https://server.codeium.com";
const KEY = "devin-live-models-test-key";

/** One ClientModelConfig body; field #5 stays absent unless opts asserts it. */
function catalogEntry(
  uid: string,
  opts: { disabled?: boolean; supportsImages?: boolean; contextWindow?: number } = {},
): Buffer {
  return Buffer.concat([
    encodeString(1, uid),
    ...(opts.disabled === true ? [encodeVarintField(4, 1)] : []),
    // encodeVarintField(5, 0) is a measured text-only vote — real bytes, not
    // an omission — while leaving field #5 out keeps the row unknown.
    ...(opts.supportsImages !== undefined ? [encodeVarintField(5, opts.supportsImages ? 1 : 0)] : []),
    ...(opts.contextWindow !== undefined ? [encodeVarintField(18, opts.contextWindow)] : []),
    encodeString(22, uid),
  ]);
}

function seedCatalog(...entries: Buffer[]): void {
  setCachedCatalogForTests(parseCatalogBuffer(
    Buffer.concat(entries.map((entry) => encodeMessage(1, entry))),
    KEY,
    HOST,
  ));
}

// A cache miss must fail the test, never dial Cognition: every case here is
// supposed to be served by the seeded catalog, so the network is a bug.
let realFetch: typeof globalThis.fetch;
let networkCalls = 0;
beforeEach(() => {
  networkCalls = 0;
  realFetch = globalThis.fetch;
  globalThis.fetch = (() => {
    networkCalls++;
    throw new Error("devin-live-models.test.ts reached the network — the seeded catalog cache missed");
  }) as typeof globalThis.fetch;
  setCachedCatalogForTests(null);
  clearModelCache("devin-test");
  providerCacheGenerations.delete("devin-test");
});
afterEach(() => {
  globalThis.fetch = realFetch;
  setCachedCatalogForTests(null);
  clearModelCache("devin-test");
  providerCacheGenerations.delete("devin-test");
  expect(networkCalls).toBe(0);
});

describe("devin live model discovery", () => {
  test("collapses per-variant supportsImages votes into per-base input modalities", async () => {
    seedCatalog(
      // Unanimous measured rows advertise.
      catalogEntry("vision-model", { supportsImages: true, contextWindow: 262_000 }),
      catalogEntry("vision-model-high", { supportsImages: true, contextWindow: 1_000_000 }),
      catalogEntry("text-model-low", { supportsImages: false }),
      catalogEntry("text-model-high", { supportsImages: false }),
      // An unsuffixed row that never asserted field #5 abstains instead of
      // poisoning a measured image base.
      catalogEntry("abstain-model"),
      catalogEntry("abstain-model-high", { supportsImages: true }),
      // Measured disagreement stays unadvertised — a single false is not
      // outvoted by its siblings.
      catalogEntry("split-model", { supportsImages: true }),
      catalogEntry("split-model-low", { supportsImages: true }),
      catalogEntry("split-model-high", { supportsImages: false }),
      catalogEntry("mixed-model-low", { supportsImages: true }),
      catalogEntry("mixed-model-high", { supportsImages: false }),
      // Zero measured rows advertise nothing.
      catalogEntry("mystery-model"),
      catalogEntry("mystery-model-high"),
      // Disabled and MODEL_* rows are skipped before they can vote: if the
      // disabled true voted, text-off-model would read as disagreement.
      catalogEntry("text-off-model", { supportsImages: false }),
      catalogEntry("text-off-model-high", { disabled: true, supportsImages: true }),
      catalogEntry("ghost-model-high", { disabled: true, supportsImages: true }),
      catalogEntry("MODEL_INTERNAL_VISION", { supportsImages: true }),
    );
    const result = await fetchDevinUsableModels({ apiKey: KEY, baseUrl: HOST });
    if (!result.ok) throw new Error(`expected ok, got ${result.error}`);
    expect(result.models).toEqual([
      "abstain-model",
      "mixed-model",
      "mystery-model",
      "split-model",
      "text-model",
      "text-off-model",
      "vision-model",
    ]);
    expect(result.inputModalities).toEqual({
      "vision-model": ["text", "image"],
      "text-model": ["text"],
      "abstain-model": ["text", "image"],
      "text-off-model": ["text"],
    });
    // The collapse adds a field; the existing projections are unchanged.
    expect(result.contextWindows["vision-model"]).toBe(262_000);
    expect(result.efforts["text-model"]).toEqual(["low", "high"]);
  });

  test("a catalog with no measured rows still carries an empty record", async () => {
    seedCatalog(catalogEntry("plain-model"), catalogEntry("plain-model-high"));
    const result = await fetchDevinUsableModels({ apiKey: KEY, baseUrl: HOST });
    if (!result.ok) throw new Error(`expected ok, got ${result.error}`);
    expect(result.inputModalities).toEqual({});
  });
});

describe("devin advertised catalog input modalities", () => {
  // Devin discovery resolves token and tenant destination from one account
  // snapshot. Keep that pair together rather than mocking the token-only seam.
  const snapshot = (accessToken = KEY, apiBaseUrl = HOST, accountId = "fixture"): oauth.OAuthAccessSnapshot => ({
    provider: "devin-test", accountId, generation: `generation-${accountId}`, accessToken, apiBaseUrl,
  });
  let authSpy: ReturnType<typeof spyOn> | undefined;
  beforeEach(() => {
    authSpy = spyOn(oauth, "getValidAccessTokenSnapshot").mockResolvedValue(snapshot());
  });
  afterEach(() => {
    authSpy?.mockRestore();
    authSpy = undefined;
  });

  const devinProvider = (extra: Partial<OcxProviderConfig> = {}): OcxProviderConfig => ({
    adapter: "devin",
    baseUrl: HOST,
    apiKey: KEY,
    authMode: "oauth",
    liveModels: true,
    ...extra,
  } as OcxProviderConfig);

  test("a measured image base advertises text and image", async () => {
    seedCatalog(catalogEntry("img-model", { supportsImages: true }));
    const models = await fetchProviderModels("devin-test", devinProvider(), 60_000);
    expect(models.map((model) => model.id)).toEqual(["img-model"]);
    expect(models[0]?.inputModalities).toEqual(["text", "image"]);
  });

  test("an exact modelCapabilities declaration overwrites the live value", async () => {
    seedCatalog(catalogEntry("img-model", { supportsImages: true }));
    const models = await fetchProviderModels("devin-test", devinProvider({
      modelCapabilities: { "img-model": { inputModalities: ["audio"] } },
    }), 60_000);
    expect(models[0]?.inputModalities).toEqual(["audio"]);
  });

  test("an exact text-only declaration still takes the sidecar path", async () => {
    // A text-only modelCapabilities entry makes the row a vision-sidecar
    // consumer (src/vision/eligibility.ts): the declaration governs runtime
    // eligibility while the catalog keeps attachments unblocked.
    seedCatalog(catalogEntry("img-model", { supportsImages: true }));
    const models = await fetchProviderModels("devin-test", devinProvider({
      modelCapabilities: { "img-model": { inputModalities: ["text"] } },
    }), 60_000);
    expect(models[0]?.inputModalities).toEqual(["text", "image"]);
  });

  test("a noVisionModels entry upgrades a live text-only row through the sidecar", async () => {
    seedCatalog(catalogEntry("side-model", { supportsImages: false }));
    const models = await fetchProviderModels("devin-test", devinProvider({
      noVisionModels: ["side-model"],
    }), 60_000);
    expect(models[0]?.inputModalities).toEqual(["text", "image"]);
  });

  test("a measured text-only base is not upgraded without a sidecar consumer", async () => {
    seedCatalog(catalogEntry("plain-model", { supportsImages: false }));
    const models = await fetchProviderModels("devin-test", devinProvider(), 60_000);
    expect(models.map((model) => model.id)).toEqual(["plain-model"]);
    expect(models[0]?.inputModalities).toEqual(["text"]);
  });

  test("a credential change cannot reuse the previous account's live roster", async () => {
    // The live catalog is entitlement-specific: an observation made under one
    // credential must not be served to the next. Before the roster cache was
    // bound to the credential fingerprint, account B read account A's fresh
    // entry and never resolved its own token.
    const tenantHost = "https://eu.windsurf.com/_route/api_server";
    let account = snapshot("acct-a-key", tenantHost, "account-a");
    authSpy?.mockImplementation(async () => account);
    setCachedCatalogForTests(parseCatalogBuffer(encodeMessage(1, catalogEntry("acct-a-model")), "acct-a-key", tenantHost));
    const accountA = await fetchProviderModels("devin-test", devinProvider(), 60_000);

    account = snapshot("acct-b-key", HOST, "account-b");
    setCachedCatalogForTests(parseCatalogBuffer(encodeMessage(1, catalogEntry("acct-b-model")), "acct-b-key", HOST));
    const accountB = await fetchProviderModels("devin-test", devinProvider(), 60_000);

    expect(accountA.map((model) => model.id)).toEqual(["acct-a-model"]);
    expect(accountB.map((model) => model.id)).toEqual(["acct-b-model"]);
    expect(authSpy?.mock.calls.length).toBe(2);
    expect(authSpy?.mock.calls).toEqual([["devin-test"], ["devin-test"]]);
  });
});
