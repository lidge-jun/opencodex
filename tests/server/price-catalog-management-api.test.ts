import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { clearModelCache } from "../../src/codex/model-cache";
import { resetCodexModelEntitlementCacheForTests } from "../../src/codex/model-entitlements";
import { saveConfig } from "../../src/config";
import { sanitizeModelCostsForLoad } from "../../src/config/load-degrade";
import { handleModelRoutes } from "../../src/server/management/model-routes";
import { listManagementModelRows } from "../../src/server/management/model-rows";
import type { OcxConfig } from "../../src/types";
import { refreshPriceCatalogs } from "../../src/usage/price-catalog";
import { refreshUserCostOverlays } from "../../src/usage/user-cost-overlays";
import { installCatalogSandbox, MODELS_DEV_URL, OPENROUTER_URL } from "../helpers/price-catalog-fixtures";

const sandbox = installCatalogSandbox();
const PROVIDER = "relay-test";
let previousCodexHome: string | undefined;

beforeEach(() => {
  previousCodexHome = process.env["CODEX_HOME"];
  process.env["CODEX_HOME"] = join(sandbox.dir, "codex");
});
afterEach(() => {
  clearModelCache();
  resetCodexModelEntitlementCacheForTests();
  if (previousCodexHome === undefined) delete process.env["CODEX_HOME"];
  else process.env["CODEX_HOME"] = previousCodexHome;
});

function fixture(extra: Record<string, unknown> = {}, models = ["zephyr-flash-2"]): OcxConfig {
  return {
    port: 10100,
    defaultProvider: PROVIDER,
    modelCacheTtlMs: 60_000,
    providers: { [PROVIDER]: { adapter: "openai-chat", baseUrl: "https://relay.example.invalid/v1", liveModels: false, models, ...extra } },
  } as unknown as OcxConfig;
}

function harness(config: OcxConfig, failPersist = false) {
  const persisted: OcxConfig[] = [];
  async function call(method: string, path: string, body?: unknown) {
    const url = new URL(`http://127.0.0.1:10100${path}`);
    const response = await handleModelRoutes({
      version: "test",
      req: new Request(url, { method, headers: { "Content-Type": "application/json" }, ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }) }),
      url,
      config,
      deps: { saveConfigPreservingClaudeCode: saved => { if (failPersist) throw new Error("disk full"); persisted.push(structuredClone(saved)); } },
      convergeCodexCatalog: async () => { throw new Error("price writes must not converge catalogs"); },
      syncClaudeAgentDefsBestEffort: async () => {},
    });
    if (!response) throw new Error(`${method} ${path} was not dispatched`);
    return response;
  }
  return { call, config, persisted };
}

/** Row building reloads the config from disk and rebuilds the price registries, so persist it first. */
async function rowsFor(config: OcxConfig) {
  saveConfig(config);
  refreshUserCostOverlays(config);
  return listManagementModelRows(config, { entitlementWaitMs: 0 });
}

const multiplierPath = `/api/providers/${PROVIDER}/price-multiplier`;

describe("PUT /api/providers/:name/price-multiplier", () => {
  test("round trip: set, read back, replace, and null deletes the key", async () => {
    const h = harness(fixture());
    const provider = () => h.config.providers[PROVIDER]!;
    expect(Object.hasOwn(provider(), "priceMultiplier")).toBe(false);
    expect(await (await h.call("GET", `/api/providers/${PROVIDER}/model-costs`)).json()).toEqual({ provider: PROVIDER, modelCosts: {} });

    const set = await h.call("PUT", multiplierPath, { multiplier: 1.5 });
    expect(set.status).toBe(200);
    expect(await set.json()).toEqual({ ok: true, provider: PROVIDER, multiplier: 1.5 });
    expect(provider().priceMultiplier).toBe(1.5);
    expect(h.persisted.at(-1)!.providers[PROVIDER]!.priceMultiplier).toBe(1.5);
    expect(await (await h.call("GET", `/api/providers/${PROVIDER}/model-costs`)).json()).toMatchObject({ priceMultiplier: 1.5 });

    expect((await h.call("PUT", multiplierPath, { multiplier: 0.25 })).status).toBe(200);
    expect(provider().priceMultiplier).toBe(0.25);

    const cleared = await h.call("PUT", multiplierPath, { multiplier: null });
    expect(await cleared.json()).toEqual({ ok: true, provider: PROVIDER, multiplier: null });
    expect(Object.hasOwn(provider(), "priceMultiplier")).toBe(false);
    expect(Object.hasOwn(h.persisted.at(-1)!.providers[PROVIDER]!, "priceMultiplier")).toBe(false);
    expect(Object.hasOwn(await (await h.call("GET", `/api/providers/${PROVIDER}/model-costs`)).json(), "priceMultiplier")).toBe(false);
    expect(h.persisted).toHaveLength(3);
  });

  test("clearing an already-unset multiplier succeeds and keeps the key absent", async () => {
    const h = harness(fixture());
    expect((await h.call("PUT", multiplierPath, { multiplier: null })).status).toBe(200);
    expect(Object.hasOwn(h.config.providers[PROVIDER]!, "priceMultiplier")).toBe(false);
  });

  test.each([
    ["zero", { multiplier: 0 }],
    ["negative", { multiplier: -2 }],
    ["above the cap", { multiplier: 1001 }],
    ["a numeric string", { multiplier: "2" }],
    ["a boolean", { multiplier: true }],
    ["missing", {}],
    ["an extra key", { multiplier: 2, note: "x" }],
    ["an array body", [2]],
  ])("%s is rejected and nothing is stored", async (_label, body) => {
    const h = harness(fixture({ priceMultiplier: 3 }));
    const response = await h.call("PUT", multiplierPath, body);
    expect(response.status).toBe(400);
    expect(h.config.providers[PROVIDER]!.priceMultiplier).toBe(3);
    expect(h.persisted).toHaveLength(0);
  });

  test("the cap itself is accepted, and a raw NaN or Infinity token is invalid JSON", async () => {
    const h = harness(fixture());
    expect((await h.call("PUT", multiplierPath, { multiplier: 1000 })).status).toBe(200);
    expect((await h.call("PUT", multiplierPath, '{"multiplier": NaN}')).status).toBe(400);
    expect((await h.call("PUT", multiplierPath, '{"multiplier": 1e999}')).status).toBe(400);
    expect(h.config.providers[PROVIDER]!.priceMultiplier).toBe(1000);
  });

  test("an unknown provider is 404 and a failed persist rolls the value back", async () => {
    const h = harness(fixture({ priceMultiplier: 2 }), true);
    expect((await h.call("PUT", "/api/providers/nope/price-multiplier", { multiplier: 2 })).status).toBe(404);
    await expect(h.call("PUT", multiplierPath, { multiplier: 5 })).rejects.toThrow("disk full");
    expect(h.config.providers[PROVIDER]!.priceMultiplier).toBe(2);
    const unset = harness(fixture(), true);
    await expect(unset.call("PUT", multiplierPath, { multiplier: 5 })).rejects.toThrow("disk full");
    expect(Object.hasOwn(unset.config.providers[PROVIDER]!, "priceMultiplier")).toBe(false);
  });

  test("a saved multiplier changes the price the estimator uses", async () => {
    const config = fixture();
    const h = harness(config);
    await refreshPriceCatalogs();
    await h.call("PUT", multiplierPath, { multiplier: 4 });
    const rows = await rowsFor(config);
    expect(rows.find(row => row.provider === PROVIDER && row.id === "zephyr-flash-2")?.price)
      .toMatchObject({ source: "models-dev", multiplier: 4, input: 0.4 });
  });
});

describe("config load", () => {
  test("an invalid priceMultiplier is dropped with a warning and a valid one is kept", () => {
    const warnings: string[] = [];
    const parsed = { providers: {
      bad0: { priceMultiplier: 0 }, bigger: { priceMultiplier: 5000 }, text: { priceMultiplier: "2" }, nan: { priceMultiplier: Number.NaN },
      good: { priceMultiplier: 2 }, none: {},
    } };
    sanitizeModelCostsForLoad(parsed, message => warnings.push(message));
    const providers = parsed.providers as Record<string, Record<string, unknown>>;
    for (const name of ["bad0", "bigger", "text", "nan"]) expect(Object.hasOwn(providers[name]!, "priceMultiplier"), name).toBe(false);
    expect(providers["good"]!["priceMultiplier"]).toBe(2);
    expect(warnings).toHaveLength(4);
  });
});

describe("POST /api/pricing/refresh", () => {
  test("forces both sources and reports per-source status", async () => {
    const h = harness(fixture());
    await refreshPriceCatalogs();
    const response = await h.call("POST", "/api/pricing/refresh", {});
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.ok).toBe(true);
    expect(body.sources["models-dev"]).toMatchObject({ ok: true, count: 4 });
    expect(body.sources["openrouter"]).toMatchObject({ ok: true, count: 2 });
    expect(sandbox.feeds.callsTo(MODELS_DEV_URL)).toBe(2);
    expect(sandbox.feeds.callsTo(OPENROUTER_URL)).toBe(2);
  });

  test("a failing source reports a short code and no response body", async () => {
    const h = harness(fixture());
    sandbox.feeds.failing.add(OPENROUTER_URL);
    const body = await (await h.call("POST", "/api/pricing/refresh", {})).json();
    expect(body.sources["models-dev"].ok).toBe(true);
    expect(body.sources["openrouter"]).toEqual({ ok: false, error: "fetch_failed" });
  });
});

describe("/api/models row price", () => {
  async function priceOf(config: OcxConfig, id: string) {
    const rows = await rowsFor(config);
    const row = rows.find(candidate => candidate.provider === PROVIDER && candidate.id === id);
    expect(row, id).toBeDefined();
    return row!.price;
  }

  test("reports manual, official, models-dev and openrouter sources, and omits an unknown price", async () => {
    const config = fixture({ modelCosts: { "manual-model-1": { input: 1.25, output: 5, cacheRead: 0.125, cacheWrite: 2 } } },
      ["manual-model-1", "gpt-6.1-terra", "zephyr-flash-2", "orb-only-7", "mystery-model-0"]);
    await refreshPriceCatalogs();
    expect(await priceOf(config, "manual-model-1")).toEqual({ source: "manual", input: 1.25, output: 5, cacheRead: 0.125, cacheWrite: 2 });
    expect((await priceOf(config, "gpt-6.1-terra"))?.source).toBe("official");
    const dev = await priceOf(config, "zephyr-flash-2");
    expect(dev).toMatchObject({ source: "models-dev", input: 0.1, output: 0.4, cacheRead: 0.01, cacheWrite: 0.2 });
    expect(Date.parse(dev!.fetchedAt!)).not.toBeNaN();
    expect(await priceOf(config, "orb-only-7")).toMatchObject({ source: "openrouter" });
    const rows = await rowsFor(config);
    const mystery = rows.find(row => row.provider === PROVIDER && row.id === "mystery-model-0")!;
    expect(Object.hasOwn(mystery, "price")).toBe(false);
  });

  test("effective rates include the multiplier and a subscription provider is labelled", async () => {
    const config = fixture({ priceMultiplier: 2 });
    await refreshPriceCatalogs();
    expect(await priceOf(config, "zephyr-flash-2")).toMatchObject({ source: "models-dev", input: 0.2, multiplier: 2 });
    const sub = fixture({ authMode: "oauth" });
    expect(await priceOf(sub, "zephyr-flash-2")).toMatchObject({ source: "models-dev", apiEquivalent: true });
  });
});
