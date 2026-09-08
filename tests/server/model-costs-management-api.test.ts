import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearModelCache } from "../../src/codex/model-cache";
import { resetCodexModelEntitlementCacheForTests } from "../../src/codex/model-entitlements";
import { armClaudeCodeBaseline, saveConfigPreservingClaudeCode } from "../../src/config";
import { handleManagementAPI } from "../../src/server/management-api";
import { handleModelRoutes } from "../../src/server/management/model-routes";
import { listManagementModelRows } from "../../src/server/management/model-rows";
import type { OcxConfig, ProviderCostOverlay } from "../../src/types";
import { activeUserCostOverlays, refreshUserCostOverlays } from "../../src/usage/user-cost-overlays";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const PROVIDER = "manual-price-test";
const COST: ProviderCostOverlay = { input: 1.25, output: 5, cacheRead: 0.125, cacheWrite: 2 };
const SIBLING: ProviderCostOverlay = { input: 3, output: 7, cacheRead: 0.5, cacheWrite: 4 };
const ZERO: ProviderCostOverlay = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
let home: string;
let previousHome: string | undefined;
let previousCodexHome: string | undefined;

function fixture(costs?: Record<string, ProviderCostOverlay>): OcxConfig {
  return {
    port: 10100,
    defaultProvider: PROVIDER,
    modelCacheTtlMs: 60_000,
    providers: {
      [PROVIDER]: {
        adapter: "openai-chat",
        baseUrl: "https://price.example.invalid/v1",
        alias: "price-alias",
        liveModels: false,
        models: ["org/model", "org/other", "sibling", "custom"],
        ...(costs ? { modelCosts: costs } : {}),
      },
    },
  };
}

beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  previousCodexHome = process.env.CODEX_HOME;
  home = mkdtempSync(join(tmpdir(), "ocx-model-prices-"));
  process.env.OPENCODEX_HOME = home;
  process.env.CODEX_HOME = join(home, "codex");
});

afterEach(() => {
  clearModelCache();
  resetCodexModelEntitlementCacheForTests();
  refreshUserCostOverlays(fixture());
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = previousCodexHome;
  removeTreeWithRetry(home);
});

function harness(config = fixture(), persist?: (saved: OcxConfig) => void) {
  const persisted: OcxConfig[] = [];
  let convergeCalls = 0;
  async function call(method: "GET" | "PUT", body?: unknown, provider = PROVIDER, rawBody?: string | ReadableStream<Uint8Array>, rawProvider?: string) {
    const url = new URL(`http://127.0.0.1:10100/api/providers/${rawProvider ?? encodeURIComponent(provider)}/model-costs`);
    const response = await handleModelRoutes({
      version: "test",
      req: new Request(url, {
        method,
        headers: { "Content-Type": "application/json" },
        ...(method === "PUT" ? { body: rawBody ?? JSON.stringify(body) } : {}),
      }),
      url,
      config,
      deps: {
        saveConfigPreservingClaudeCode: saved => {
          persist?.(saved);
          persisted.push(structuredClone(saved));
        },
      },
      convergeCodexCatalog: async () => {
        convergeCalls += 1;
        throw new Error("price writes must not converge catalogs");
      },
      syncClaudeAgentDefsBestEffort: async () => {},
    });
    if (!response) throw new Error("model-costs route was not dispatched");
    return response;
  }
  return { call, config, persisted, get convergeCalls() { return convergeCalls; } };
}

/** No eager buffering: requested resolves only when the request parser pulls the body. */
function deferredJsonBody(value: unknown) {
  let requestPull!: () => void;
  let release!: () => void;
  const requested = new Promise<void>(resolve => { requestPull = resolve; });
  const released = new Promise<void>(resolve => { release = resolve; });
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      requestPull();
      await released;
      controller.enqueue(new TextEncoder().encode(JSON.stringify(value)));
      controller.close();
    },
  }, { highWaterMark: 0 });
  return { body, requested, release };
}

describe("provider model costs API", () => {
  test("GET returns the exact configured provider's sanitized map or an empty map", async () => {
    const h = harness();
    expect(await (await h.call("GET")).json()).toEqual({ provider: PROVIDER, modelCosts: {} });
    const costs = JSON.parse(JSON.stringify({
      "org/model": { ...COST, apiKey: "not-for-display" },
      bad: { ...COST, input: -1 },
      ["sk-" + "a".repeat(40)]: COST,
    }));
    h.config.providers[PROVIDER]!.modelCosts = costs;
    expect(await (await h.call("GET")).json()).toEqual({ provider: PROVIDER, modelCosts: { "org/model": COST } });
    expect(h.persisted).toHaveLength(0);
  });

  test("set, replace with explicit zero, and reset persist only the exact model key", async () => {
    const h = harness(fixture({ sibling: SIBLING, "org--model": SIBLING }));
    for (const cost of [COST, ZERO, null]) {
      const response = await h.call("PUT", { modelId: "org/model", cost });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ ok: true, provider: PROVIDER, modelId: "org/model", cost });
      const expected = { sibling: SIBLING, "org--model": SIBLING, ...(cost ? { "org/model": cost } : {}) };
      expect(h.config.providers[PROVIDER]!.modelCosts).toEqual(expected);
      expect(h.persisted.at(-1)!.providers[PROVIDER]!.modelCosts).toEqual(expected);
    }
    expect(h.persisted).toHaveLength(3);
    expect(h.convergeCalls).toBe(0);
  });

  test("reset of the last entry keeps an empty map and repeated reset remains successful", async () => {
    const h = harness(fixture({ "org/model": COST }));
    for (let attempt = 0; attempt < 2; attempt++) {
      expect((await h.call("PUT", { modelId: "org/model", cost: null })).status).toBe(200);
      expect(h.config.providers[PROVIDER]!.modelCosts).toEqual({});
      expect(await (await h.call("GET")).json()).toEqual({ provider: PROVIDER, modelCosts: {} });
    }
  });

  test("the normal persistence owner writes disk and refreshes the overlay registry", async () => {
    const config = fixture({ sibling: SIBLING });
    writeFileSync(join(home, "config.json"), JSON.stringify(config));
    const h = harness(config, saveConfigPreservingClaudeCode);
    await h.call("PUT", { modelId: "org/model", cost: COST });
    const disk = JSON.parse(readFileSync(join(home, "config.json"), "utf8")) as OcxConfig;
    expect(disk.providers[PROVIDER]!.modelCosts).toEqual({ sibling: SIBLING, "org/model": COST });
    expect(activeUserCostOverlays().find(row => row.provider === PROVIDER && row.modelId === "org/model")?.cost4).toEqual(COST);
    expect(await (await harness(disk).call("GET")).json()).toEqual({ provider: PROVIDER, modelCosts: { sibling: SIBLING, "org/model": COST } });
    await h.call("PUT", { modelId: "org/model", cost: null });
    expect(JSON.parse(readFileSync(join(home, "config.json"), "utf8")).providers[PROVIDER].modelCosts).toEqual({ sibling: SIBLING });
    expect(activeUserCostOverlays().some(row => row.provider === PROVIDER && row.modelId === "org/model")).toBe(false);
  });

  test("resetting the last live price preserves a sibling added by another disk writer", async () => {
    const config = fixture({ "org/model": COST });
    const path = join(home, "config.json");
    writeFileSync(path, JSON.stringify(config));
    armClaudeCodeBaseline(config);
    const concurrent = fixture({ "org/model": COST, sibling: SIBLING });
    writeFileSync(path, JSON.stringify(concurrent));
    const h = harness(config, saveConfigPreservingClaudeCode);

    expect((await h.call("PUT", { modelId: "org/model", cost: null })).status).toBe(200);
    const disk = JSON.parse(readFileSync(path, "utf8")) as OcxConfig;
    expect(disk.providers[PROVIDER]!.modelCosts).toEqual({ sibling: SIBLING });
    expect(config.providers[PROVIDER]!.modelCosts).toEqual({ sibling: SIBLING });
    expect(activeUserCostOverlays().find(row => row.provider === PROVIDER && row.modelId === "sibling")?.cost4).toEqual(SIBLING);
    expect(activeUserCostOverlays().some(row => row.provider === PROVIDER && row.modelId === "org/model")).toBe(false);
  });

  test("price PUT follows a provider row replaced by a pin edit while parsing its body", async () => {
    const config = fixture({ "org/model": ZERO, sibling: SIBLING });
    writeFileSync(join(home, "config.json"), JSON.stringify(config));
    const h = harness(config, saveConfigPreservingClaudeCode);
    const oldRow = config.providers[PROVIDER]!;
    const oldCosts = oldRow.modelCosts;
    const oldSnapshot = structuredClone(oldRow);
    const deferred = deferredJsonBody({ modelId: "org/model", cost: COST });
    const pending = h.call("PUT", undefined, PROVIDER, deferred.body);
    await deferred.requested;

    // Reproduce the provider PATCH ownership boundary without DNS or catalog side effects.
    // This exercises row replacement during body parsing, not the pin PATCH route itself.
    const newerSibling: ProviderCostOverlay = { input: 9, output: 11, cacheRead: 1, cacheWrite: 6 };
    const replacement = {
      ...oldRow,
      pinnedReasoningEffort: "high",
      modelCosts: { ...oldRow.modelCosts, sibling: newerSibling, "newer/sibling": SIBLING },
    };
    config.providers[PROVIDER] = replacement;
    deferred.release();

    const response = await pending;
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, provider: PROVIDER, modelId: "org/model", cost: COST });
    expect(config.providers[PROVIDER]).toBe(replacement);
    const expected = { "org/model": COST, sibling: newerSibling, "newer/sibling": SIBLING };
    expect(replacement.pinnedReasoningEffort).toBe("high");
    expect(replacement.modelCosts).toEqual(expected);
    expect(oldRow).toEqual(oldSnapshot);
    expect(oldRow.modelCosts).toBe(oldCosts);
    expect(h.persisted).toHaveLength(1);
    expect(h.persisted[0]!.providers[PROVIDER]!.pinnedReasoningEffort).toBe("high");
    expect(h.persisted[0]!.providers[PROVIDER]!.modelCosts).toEqual(expected);
    const disk = JSON.parse(readFileSync(join(home, "config.json"), "utf8")) as OcxConfig;
    expect(disk.providers[PROVIDER]!.pinnedReasoningEffort).toBe("high");
    expect(disk.providers[PROVIDER]!.modelCosts).toEqual(expected);
    expect(h.convergeCalls).toBe(0);
  });

  test("price PUT returns 404 without persisting if the provider is removed during body parsing", async () => {
    const config = fixture({ "org/model": ZERO, sibling: SIBLING });
    writeFileSync(join(home, "config.json"), JSON.stringify(config));
    const diskBefore = readFileSync(join(home, "config.json"), "utf8");
    const h = harness(config, saveConfigPreservingClaudeCode);
    const oldRow = config.providers[PROVIDER]!;
    const oldSnapshot = structuredClone(oldRow);
    const deferred = deferredJsonBody({ modelId: "org/model", cost: COST });
    const pending = h.call("PUT", undefined, PROVIDER, deferred.body);
    await deferred.requested;
    delete config.providers[PROVIDER];
    deferred.release();

    const response = await pending;
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "provider not found" });
    expect(Object.hasOwn(config.providers, PROVIDER)).toBe(false);
    expect(oldRow).toEqual(oldSnapshot);
    expect(h.persisted).toHaveLength(0);
    expect(readFileSync(join(home, "config.json"), "utf8")).toBe(diskBefore);
    expect(h.convergeCalls).toBe(0);
  });

  test("persist failure restores map identity and own-property absence for set and reset", async () => {
    for (const costs of [undefined, {}, { "org/model": COST, sibling: SIBLING }]) {
      for (const cost of [SIBLING, null]) {
        const config = fixture(costs);
        const provider = config.providers[PROVIDER]!;
        const previous = provider.modelCosts;
        const snapshot = structuredClone(previous);
        const hadMap = Object.hasOwn(provider, "modelCosts");
        const h = harness(config, () => { throw new Error("disk full"); });
        await expect(h.call("PUT", { modelId: "org/model", cost })).rejects.toThrow("disk full");
        expect(provider.modelCosts).toBe(previous);
        expect(provider.modelCosts).toEqual(snapshot);
        expect(Object.hasOwn(provider, "modelCosts")).toBe(hadMap);
        expect(h.persisted).toHaveLength(0);
        expect(h.convergeCalls).toBe(0);
      }
    }
  });

  test("missing, alias, case-folded and inherited provider names are not resolved", async () => {
    const h = harness();
    for (const method of ["GET", "PUT"] as const) {
      for (const provider of ["missing", "price-alias", PROVIDER.toUpperCase(), "__proto__", "constructor", "toString"]) {
        expect((await h.call(method, { modelId: "org/model", cost: COST }, provider)).status).toBe(404);
      }
      expect((await h.call(method, { modelId: "org/model", cost: COST }, PROVIDER, undefined, "%E0%A4%A")).status).toBe(400);
    }
    expect(h.persisted).toHaveLength(0);
  });

  test("malformed bodies, model IDs, rates and extra fields fail before mutation", async () => {
    const h = harness(fixture({ sibling: SIBLING }));
    const original = h.config.providers[PROVIDER]!.modelCosts;
    const invalid: unknown[] = [null, [], 4, {}, { modelId: "org/model" }, { cost: COST },
      ...["", " ", " model", "model ", "bad\nmodel", "x".repeat(1025), 42].map(modelId => ({ modelId, cost: null })),
      ...[null, [], "1", true, -1, 1_000_001].map(input => ({ modelId: "org/model", cost: { ...COST, input } })),
      ...[[], "auto", 0, { input: 1, output: 2 }, { ...COST, apiKey: "extra" }].map(cost => ({ modelId: "org/model", cost })),
      { modelId: "org/model", cost: COST, extra: true },
      JSON.parse('{"modelId":"org/model","cost":null,"__proto__":{"polluted":true}}'),
      JSON.parse('{"modelId":"org/model","cost":{"input":1,"output":2,"cacheRead":0,"cacheWrite":0,"constructor":{}}}'),
      JSON.parse('{"modelId":"org/model","cost":{"input":1,"output":2,"cacheRead":0,"cacheWrite":0,"__proto__":{}}}'),
    ];
    for (const body of invalid) expect((await h.call("PUT", body)).status).toBe(400);
    for (const raw of ["{", "", '{"modelId":"org/model","cost":{"input":1e309,"output":1,"cacheRead":0,"cacheWrite":0}}']) {
      expect((await h.call("PUT", undefined, PROVIDER, raw)).status).toBe(400);
    }
    expect(h.config.providers[PROVIDER]!.modelCosts).toBe(original);
    expect(h.persisted).toHaveLength(0);
  });

  test("prototype-shaped model keys are stored and reset as own data without touching prototypes", async () => {
    const h = harness(fixture({ sibling: SIBLING }));
    for (const modelId of ["__proto__", "constructor", "toString"]) {
      expect((await h.call("PUT", { modelId, cost: COST })).status).toBe(200);
      const map = h.config.providers[PROVIDER]!.modelCosts!;
      expect(Object.getPrototypeOf(map)).toBeNull();
      expect(Object.hasOwn(map, modelId)).toBe(true);
      expect(map[modelId]).toEqual(COST);
      const body = await (await h.call("GET")).json() as { modelCosts: Record<string, ProviderCostOverlay> };
      expect(Object.hasOwn(body.modelCosts, modelId)).toBe(true);
      expect(body.modelCosts[modelId]).toEqual(COST);
      await h.call("PUT", { modelId, cost: null });
      expect(Object.hasOwn(h.config.providers[PROVIDER]!.modelCosts!, modelId)).toBe(false);
    }
    expect(h.config.providers[PROVIDER]!.modelCosts).toEqual({ sibling: SIBLING });
    expect(Object.hasOwn(Object.prototype, "input")).toBe(false);
  });

  test("secret-shaped model IDs are rejected without echo on both set and reset", async () => {
    const modelId = "sk-" + "a".repeat(40);
    const h = harness(fixture({ [modelId]: COST, sibling: SIBLING }));
    const original = h.config.providers[PROVIDER]!.modelCosts;
    for (const cost of [COST, null]) {
      const response = await h.call("PUT", { modelId, cost });
      expect(response.status).toBe(400);
      expect(await response.text()).not.toContain(modelId);
    }
    expect(h.config.providers[PROVIDER]!.modelCosts).toBe(original);
    expect(h.persisted).toHaveLength(0);
  });

  test("management dispatch reaches GET/PUT and still rejects cross-origin writes", async () => {
    const config = fixture();
    const url = new URL(`http://127.0.0.1:10100/api/providers/${PROVIDER}/model-costs`);
    let writes = 0;
    for (const method of ["PUT", "GET"] as const) {
      const response = await handleManagementAPI(new Request(url, {
        method, headers: { Host: url.host, "Content-Type": "application/json" },
        ...(method === "PUT" ? { body: JSON.stringify({ modelId: "org/model", cost: COST }) } : {}),
      }), url, config, { saveConfigPreservingClaudeCode: () => { writes++; } });
      expect(response?.status).toBe(200);
    }
    const blocked = await handleManagementAPI(new Request(url, {
      method: "PUT", headers: { Host: url.host, Origin: "https://other.example.invalid" },
      body: JSON.stringify({ modelId: "org/model", cost: null }),
    }), url, config, { saveConfigPreservingClaudeCode: () => { writes++; } });
    expect(blocked?.status).toBe(403);
    expect(writes).toBe(1);
    expect(config.providers[PROVIDER]!.modelCosts).toEqual({ "org/model": COST });
  });

  test("set survives reload as manualPricing true and reset omits the badge field", async () => {
    const config = fixture({ "org--other": SIBLING });
    config.customModels = [{ id: "custom-row", provider: PROVIDER, modelId: "custom" }];
    const h = harness(config);
    expect((await h.call("PUT", { modelId: "org/model", cost: ZERO })).status).toBe(200);
    expect((await h.call("PUT", { modelId: "custom", cost: COST })).status).toBe(200);
    const reloaded = JSON.parse(JSON.stringify(config)) as OcxConfig;
    const rows = await listManagementModelRows(reloaded, { entitlementWaitMs: 0 });
    expect(rows.find(row => row.provider === PROVIDER && row.id === "org/model")?.manualPricing).toBe(true);
    for (const modelId of ["org/other", "sibling"]) {
      const row = rows.find(row => row.provider === PROVIDER && row.id === modelId);
      expect(row).toBeDefined();
      expect(Object.hasOwn(row!, "manualPricing")).toBe(false);
    }
    expect(rows.find(row => row.customId === "custom-row")?.manualPricing).toBe(true);
    expect(rows.filter(row => row.native).every(row => !Object.hasOwn(row, "manualPricing"))).toBe(true);
    for (const modelId of ["org/model", "custom"]) {
      expect((await harness(reloaded).call("PUT", { modelId, cost: null })).status).toBe(200);
    }
    const resetRows = await listManagementModelRows(reloaded, { entitlementWaitMs: 0 });
    for (const modelId of ["org/model", "custom"]) {
      const row = resetRows.find(row => row.provider === PROVIDER && row.id === modelId);
      expect(row).toBeDefined();
      expect(Object.hasOwn(row!, "manualPricing")).toBe(false);
    }
  });
});
