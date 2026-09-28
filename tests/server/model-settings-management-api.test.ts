import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearModelCache, getFreshCached, setCached } from "../../src/codex/model-cache";
import { resetCodexModelEntitlementCacheForTests } from "../../src/codex/model-entitlements";
import { handleModelRoutes } from "../../src/server/management/model-routes";
import { listManagementModelRows } from "../../src/server/management/model-rows";
import type { CatalogModel } from "../../src/codex/catalog";
import type { OcxConfig } from "../../src/types";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { ConfigWritePublishedError } from "../../src/config/persist-unlocked";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { readCodexCatalogPath } from "../../src/codex/catalog/parsing";
import { effectiveModelReasoningEfforts } from "../../src/server/management/model-rows";
import { routedSlug } from "../../src/providers/slug-codec";

/**
 * `PUT /api/model-settings` writes per-model overrides onto a routed row.
 *
 * The tests below pin the two properties the dashboard depends on and that are easy to lose:
 * only the axes the caller sent are written (an omitted field must not be pinned as an override),
 * and `null` clears rather than defaulting. Everything else here is the ingress validation that
 * keeps a rejected value out of a config the catalog then has to special-case.
 */
const PROVIDER = "model-settings-test";
const MODEL = "vendor/model";

let home: string;
let previousHome: string | undefined;
let previousCodexHome: string | undefined;

function fixture(): OcxConfig {
  return {
    port: 10100,
    defaultProvider: PROVIDER,
    modelCacheTtlMs: 60_000,
    providers: {
      [PROVIDER]: {
        adapter: "openai-chat",
        baseUrl: "https://settings.example.invalid/v1",
        liveModels: false,
        models: [MODEL, "vendor/other"],
      },
      openai: { adapter: "openai-responses", baseUrl: "https://api.openai.invalid/v1", models: ["gpt-5.6-luna"] },
      // The combo namespace is reserved, so a provider literally named "combo" is not something a
      // user configures. It is here to exercise the guard: the route refuses it by name.
      combo: { adapter: "openai-chat", baseUrl: "https://combo.invalid/v1", models: [] },
    },
  };
}

beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  previousCodexHome = process.env.CODEX_HOME;
  home = mkdtempSync(join(tmpdir(), "ocx-model-settings-"));
  process.env.OPENCODEX_HOME = home;
  process.env.CODEX_HOME = join(home, "codex");
});

afterEach(() => {
  clearModelCache();
  resetCodexModelEntitlementCacheForTests();
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = previousCodexHome;
  removeTreeWithRetry(home);
});

function harness(config = fixture(), converge?: () => Promise<never>, save?: (saved: OcxConfig) => void) {
  const persisted: OcxConfig[] = [];
  let convergeCalls = 0;
  async function call(body?: unknown, rawBody?: string) {
    const url = new URL("http://127.0.0.1:10100/api/model-settings");
    const response = await handleModelRoutes({
      version: "test",
      req: new Request(url, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: rawBody ?? JSON.stringify(body),
      }),
      url,
      config,
      deps: {
        saveConfigPreservingClaudeCode: saved => { if (save) save(saved); persisted.push(structuredClone(saved)); },
      },
      convergeCodexCatalog: async () => {
        convergeCalls += 1;
        if (converge) return converge();
        return { status: "committed", changed: true, degraded: false, notices: [] } as never;
      },
      syncClaudeAgentDefsBestEffort: async () => {},
    });
    if (!response) throw new Error("model-settings route was not dispatched");
    return response;
  }
  return { call, config, persisted, get convergeCalls() { return convergeCalls; } };
}

describe("per-model settings API", () => {
  test("restoring modalities also clears the exact legacy declaration", async () => {
    const config = fixture();
    config.providers[PROVIDER]!.modelInputModalities = { [MODEL]: ["text"], "vendor/other": ["text", "image"] };
    const h = harness(config);
    const response = await h.call({ provider: PROVIDER, modelId: MODEL, inputModalities: null });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ changed: true, saved: true, hasOverrides: false, inputModalities: null });
    expect(h.persisted).toHaveLength(1);
    // Only the exact entry goes; another model's legacy declaration is not this request's to clear.
    expect(h.persisted[0]!.providers[PROVIDER]!.modelInputModalities).toEqual({ "vendor/other": ["text", "image"] });
    const noop = await h.call({ provider: PROVIDER, modelId: MODEL, inputModalities: null });
    expect(await noop.json()).toMatchObject({ changed: false, hasOverrides: false });
  });

  test("the catalog ladder fallback is looked up by the routed slug", () => {
    const config = fixture();
    const catalogPath = readCodexCatalogPath();
    mkdirSync(dirname(catalogPath), { recursive: true });
    writeFileSync(catalogPath, JSON.stringify({ models: [
      { slug: routedSlug(PROVIDER, MODEL), supported_reasoning_levels: [{ effort: "low" }, { effort: "high" }] },
    ] }));
    expect(effectiveModelReasoningEfforts(config, PROVIDER, MODEL)).toEqual(["low", "high"]);
  });

  test("each axis round-trips, persists once, and converges the catalog once", async () => {
    const h = harness();
    const response = await h.call({
      provider: PROVIDER,
      modelId: MODEL,
      contextWindow: 262_144,
      inputModalities: ["text", "image"],
      reasoningEfforts: ["low", "medium", "high"],
      defaultReasoningEffort: "medium",
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      ok: true,
      provider: PROVIDER,
      modelId: MODEL,
      contextWindow: 262_144,
      inputModalities: ["text", "image"],
      reasoningEfforts: ["low", "medium", "high"],
      defaultReasoningEffort: "medium",
      changed: true,
      saved: true,
      hasOverrides: true,
    });
    const provider = h.config.providers[PROVIDER]!;
    expect(provider.modelContextWindows).toEqual({ [MODEL]: 262_144 });
    expect(provider.modelCapabilities).toEqual({ [MODEL]: { inputModalities: ["text", "image"] } });
    expect(provider.modelReasoningEfforts).toEqual({ [MODEL]: ["low", "medium", "high"] });
    expect(provider.modelDefaultReasoningEfforts).toEqual({ [MODEL]: "medium" });
    expect(h.persisted).toHaveLength(1);
    expect(h.convergeCalls).toBe(1);
  });

  /*
   * The gather bakes resolved hints into the rows it caches, and a cache hit re-applies the config
   * through `clampObservedModelLimits`, where a configured window may only lower the observed one.
   * Without this clear, raising or clearing an override keeps reading back the previous answer for
   * the whole TTL — so the clear is part of the write, not an optimisation.
   */
  test("a real write drops the provider's discovery cache before converging", async () => {
    setCached(PROVIDER, [{ provider: PROVIDER, id: MODEL, contextWindow: 65_536 }]);
    let cacheWasClearAtConvergence = false;
    const h = harness(fixture(), async () => {
      cacheWasClearAtConvergence = getFreshCached(PROVIDER, 60_000) === null;
      return { status: "committed", changed: true, degraded: false, notices: [] } as never;
    });

    const response = await h.call({ provider: PROVIDER, modelId: MODEL, contextWindow: 200_000 });

    expect(response.status).toBe(200);
    expect(cacheWasClearAtConvergence).toBe(true);
  });

  test("a no-op request leaves the cache alone and never converges", async () => {
    setCached(PROVIDER, [{ provider: PROVIDER, id: MODEL }]);
    const h = harness();

    const response = await h.call({ provider: PROVIDER, modelId: MODEL });

    expect(await response.json()).toMatchObject({ changed: false, hasOverrides: false, saved: false });
    expect(getFreshCached(PROVIDER, 60_000)).not.toBeNull();
    expect(h.convergeCalls).toBe(0);
  });

  test("an identical write is a no-op while its override remains stored", async () => {
    const h = harness();
    await h.call({ provider: PROVIDER, modelId: MODEL, contextWindow: 200000 });
    const response = await h.call({ provider: PROVIDER, modelId: MODEL, contextWindow: 200000 });
    expect(await response.json()).toMatchObject({ changed: false, saved: false, hasOverrides: true });
    expect(h.persisted).toHaveLength(1);
  });

  test("an unpublished save failure rolls back the live graph and identical retry persists", async () => {
    let attempts = 0;
    const durable: OcxConfig[] = [];
    const h = harness(fixture(), undefined, saved => {
      if (++attempts === 1) throw new Error("private path must not escape");
      durable.push(structuredClone(saved));
    });
    setCached(PROVIDER, [{ provider: PROVIDER, id: MODEL }]);
    const body = { provider: PROVIDER, modelId: MODEL, contextWindow: 200000 };
    const failed = await h.call(body);
    expect(failed.status).toBe(500);
    expect(JSON.stringify(await failed.json())).not.toContain("private path");
    expect(h.config.providers[PROVIDER]!.modelContextWindows).toBeUndefined();
    expect(getFreshCached(PROVIDER, 60000)).not.toBeNull();
    expect(h.convergeCalls).toBe(0);
    const retried = await h.call(body);
    expect(await retried.json()).toMatchObject({ saved: true, changed: true });
    expect(durable[0]!.providers[PROVIDER]!.modelContextWindows).toEqual(h.config.providers[PROVIDER]!.modelContextWindows);
  });

  test("a published post-write error returns a saved receipt without claiming convergence", async () => {
    const h = harness(fixture(), undefined, () => { throw new ConfigWritePublishedError(new Error("postwrite")); });
    setCached(PROVIDER, [{ provider: PROVIDER, id: MODEL }]);
    const response = await h.call({ provider: PROVIDER, modelId: MODEL, contextWindow: 200000 });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ saved: true, changed: true, hasOverrides: true, catalogRefresh: { status: "skipped" } });
    expect(h.config.providers[PROVIDER]!.modelContextWindows).toEqual({ [MODEL]: 200000 });
    expect(getFreshCached(PROVIDER, 60000)).toBeNull();
    expect(h.convergeCalls).toBe(0);
  });

  test("an omitted axis is left alone rather than pinned", async () => {
    const h = harness();
    h.config.providers[PROVIDER]!.modelContextWindows = { [MODEL]: 131_072 };
    await h.call({ provider: PROVIDER, modelId: MODEL, inputModalities: ["text"] });
    const provider = h.config.providers[PROVIDER]!;
    expect(provider.modelContextWindows).toEqual({ [MODEL]: 131_072 });
    expect(provider.modelReasoningEfforts).toBeUndefined();
    expect(provider.modelDefaultReasoningEfforts).toBeUndefined();
  });

  test("null clears, an emptied map is removed, and a repeated clear reports changed:false", async () => {
    const h = harness();
    await h.call({ provider: PROVIDER, modelId: MODEL, contextWindow: 200_000, inputModalities: ["text"] });
    const cleared = await h.call({
      provider: PROVIDER,
      modelId: MODEL,
      contextWindow: null,
      inputModalities: null,
      reasoningEfforts: null,
      defaultReasoningEffort: null,
    });
    expect(await cleared.json()).toMatchObject({ changed: true, hasOverrides: false, contextWindow: null, inputModalities: null });
    const provider = h.config.providers[PROVIDER]!;
    expect(provider.modelContextWindows).toBeUndefined();
    expect(provider.modelCapabilities).toBeUndefined();
    expect(provider.modelReasoningEfforts).toBeUndefined();
    expect(provider.modelDefaultReasoningEfforts).toBeUndefined();
    // The second identical request must not claim it restored anything: the dashboard says
    // "already the computed values" on this answer instead of reporting a restore.
    const again = await h.call({ provider: PROVIDER, modelId: MODEL, contextWindow: null, inputModalities: null });
    expect(await again.json()).toMatchObject({ changed: false, hasOverrides: false });
    // The set and the clear each changed something; the repeated clear changed nothing.
    expect(h.persisted).toHaveLength(2);
    expect(h.convergeCalls).toBe(2);
  });

  test("an empty modality array clears the declaration instead of storing a text-only model", async () => {
    const h = harness();
    await h.call({ provider: PROVIDER, modelId: MODEL, inputModalities: ["text", "image"] });
    const response = await h.call({ provider: PROVIDER, modelId: MODEL, inputModalities: [] });
    expect(await response.json()).toMatchObject({ inputModalities: null });
    expect(h.config.providers[PROVIDER]!.modelCapabilities).toBeUndefined();
  });

  test("an explicit empty ladder is stored as the no-reasoning override", async () => {
    const h = harness();
    await h.call({ provider: PROVIDER, modelId: MODEL, reasoningEfforts: [] });
    expect(h.config.providers[PROVIDER]!.modelReasoningEfforts).toEqual({ [MODEL]: [] });
  });

  test("ingress validation rejects what the catalog could not represent", async () => {
    const h = harness();
    const cases: [unknown, string][] = [
      [{ provider: PROVIDER, modelId: MODEL, inputModalities: ["video"] }, "unsupported input modality"],
      [{ provider: PROVIDER, modelId: MODEL, contextWindow: -1 }, "contextWindow must be a positive safe integer"],
      [{ provider: PROVIDER, modelId: MODEL, contextWindow: 0.5 }, "contextWindow"],
      [{ provider: PROVIDER, modelId: MODEL, contextWindow: 2 ** 60 }, "contextWindow"],
      [{ provider: PROVIDER, modelId: MODEL, surprise: true }, "surprise"],
      ...["__proto__", "constructor", "prototype", " leading", "control\u0000char", "x".repeat(1025)]
        .map(id => [{ provider: PROVIDER, modelId: id, contextWindow: 200000 }, "modelId"] as [unknown, string]),
      [{ provider: PROVIDER, modelId: MODEL, reasoningEfforts: ["low"], defaultReasoningEffort: "max" }, "not in the declared reasoningEfforts ladder"],
      [{ provider: PROVIDER, modelId: MODEL, reasoningEfforts: ["turbo"] }, "unsupported reasoning effort"],
      [{ provider: PROVIDER }, "provider and modelId are required"],
      [{ provider: "nope", modelId: MODEL }, "unknown model settings provider"],
      [{ provider: "openai", modelId: "gpt-5.6-luna" }, "only available for routed providers"],
      [{ provider: "combo", modelId: MODEL }, "only available for routed providers"],
    ];
    for (const [body, expected] of cases) {
      const response = await h.call(body);
      expect(response.status).toBe(400);
      expect(String((await response.json() as { error?: string }).error)).toContain(expected);
    }
    expect(h.persisted).toHaveLength(0);
    expect(h.convergeCalls).toBe(0);
    expect(h.config.providers[PROVIDER]!.modelContextWindows).toBeUndefined();
  });

  test("a malformed body is a 400, not a crash", async () => {
    const h = harness();
    expect((await h.call(undefined, "{")).status).toBe(400);
    expect((await h.call(["nope"])).status).toBe(400);
    expect(h.persisted).toHaveLength(0);
  });

  test("the row projection reports the declaration and the reasoning verdict, not the catalog value", async () => {
    const h = harness();
    const roster: CatalogModel[] = [{
      id: MODEL,
      provider: PROVIDER,
      // What the provider published. The declaration below is what the operator stored, and the
      // two must stay distinguishable or an editor cannot round-trip its own writes.
      inputModalities: ["text", "image"],
      contextWindow: 200000,
    }];
    // Match on provider + upstream id: the Codex-facing slug escapes the model's own slash
    // (slug-codec), so the namespaced form is not provider + "/" + modelId.
    const rowOf = async () => (await listManagementModelRows(h.config, { models: roster, entitlementWaitMs: 0 }))
      .find(row => row.provider === PROVIDER && row.id === MODEL)!;
    const before = await rowOf();
    expect(before.inputModalitiesDeclared).toBeUndefined();
    expect(before.contextWindowDeclared).toBeUndefined();
    expect(before.contextWindow).toBe(200000);
    expect(before.reasoningOverridden).toBe(false);

    await h.call({ provider: PROVIDER, modelId: MODEL, contextWindow: 131072, inputModalities: ["text"], reasoningEfforts: ["low"] });
    const after = await rowOf();
    expect(after.inputModalitiesDeclared).toEqual(["text"]);
    expect(after.contextWindowDeclared).toBe(131072);
    expect(after.contextWindow).toBe(200000);
    expect(after.inputModalities).toEqual(["text", "image"]);
    expect(after.reasoningEfforts).toEqual(["low"]);
    expect(after.reasoningOverridden).toBe(true);
  });

  /*
   * "No rungs" is a declaration, not an absence. Reading an empty stored ladder as "inherit"
   * hands the editor a ladder the row does not have, and the next save persists it as the
   * operator's own edit — the exact drift this surface exists to prevent.
   */
  test("an explicit empty ladder survives the projection instead of inheriting one", async () => {
    const h = harness();
    h.config.providers[PROVIDER]!.modelReasoningEfforts = { [MODEL]: [] };
    const row = (await listManagementModelRows(h.config, {
      models: [{ id: MODEL, provider: PROVIDER }],
      entitlementWaitMs: 0,
    })).find(candidate => candidate.provider === PROVIDER && candidate.id === MODEL)!;

    expect(row.reasoningEfforts).toEqual([]);
    expect(row.reasoningOverridden).toBe(true);
  });

  /*
   * A ladder write can strand a stored default the model can no longer select. The caller said
   * nothing about the default, so only one that cannot survive the new ladder is cleared.
   */
  test("a shrunk ladder clears a stored default it can no longer select", async () => {
    const h = harness();
    h.config.providers[PROVIDER]!.modelReasoningEfforts = { [MODEL]: ["low", "medium", "high"] };
    h.config.providers[PROVIDER]!.modelDefaultReasoningEfforts = { [MODEL]: "high" };

    const response = await h.call({ provider: PROVIDER, modelId: MODEL, reasoningEfforts: ["low"] });

    expect(response.status).toBe(200);
    expect(h.config.providers[PROVIDER]!.modelReasoningEfforts).toEqual({ [MODEL]: ["low"] });
    expect(h.config.providers[PROVIDER]!.modelDefaultReasoningEfforts).toBeUndefined();
  });

  test("a default that survives the new ladder is left alone", async () => {
    const h = harness();
    h.config.providers[PROVIDER]!.modelReasoningEfforts = { [MODEL]: ["low", "medium"] };
    h.config.providers[PROVIDER]!.modelDefaultReasoningEfforts = { [MODEL]: "medium" };

    await h.call({ provider: PROVIDER, modelId: MODEL, reasoningEfforts: ["low", "medium", "high"] });

    expect(h.config.providers[PROVIDER]!.modelDefaultReasoningEfforts).toEqual({ [MODEL]: "medium" });
  });

  test("clearing the ladder clears a default nothing inherits any more", async () => {
    const h = harness();
    h.config.providers[PROVIDER]!.modelReasoningEfforts = { [MODEL]: ["low", "high"] };
    h.config.providers[PROVIDER]!.modelDefaultReasoningEfforts = { [MODEL]: "high" };

    await h.call({ provider: PROVIDER, modelId: MODEL, reasoningEfforts: null });

    expect(h.config.providers[PROVIDER]!.modelReasoningEfforts).toBeUndefined();
    expect(h.config.providers[PROVIDER]!.modelDefaultReasoningEfforts).toBeUndefined();
  });

  /*
   * A default-only request has no ladder in the body, so it must be judged against the ladder the
   * model actually resolves — a per-model entry is only one of four sources, and rejecting the
   * provider-level one would refuse a level the model really offers.
   */
  test("a default-only write is judged against the ladder the model inherits", async () => {
    const h = harness();
    h.config.providers[PROVIDER]!.reasoningEfforts = ["low", "medium", "high"];

    const response = await h.call({ provider: PROVIDER, modelId: MODEL, defaultReasoningEffort: "high" });

    expect(response.status).toBe(200);
    expect(h.config.providers[PROVIDER]!.modelDefaultReasoningEfforts).toEqual({ [MODEL]: "high" });
    expect(h.config.providers[PROVIDER]!.modelReasoningEfforts).toBeUndefined();
  });

  test("a default outside the inherited ladder is still refused", async () => {
    const h = harness();
    h.config.providers[PROVIDER]!.reasoningEfforts = ["low", "medium"];

    const response = await h.call({ provider: PROVIDER, modelId: MODEL, defaultReasoningEffort: "max" });

    expect(response.status).toBe(400);
    expect(h.config.providers[PROVIDER]!.modelDefaultReasoningEfforts).toBeUndefined();
  });

  test("clearing the per-model ladder judges the default against the inherited one", async () => {
    const h = harness();
    h.config.providers[PROVIDER]!.reasoningEfforts = ["low", "high"];
    h.config.providers[PROVIDER]!.modelReasoningEfforts = { [MODEL]: ["low", "medium", "high"] };

    const response = await h.call({
      provider: PROVIDER, modelId: MODEL, reasoningEfforts: null, defaultReasoningEffort: "high",
    });

    expect(response.status).toBe(200);
    expect(h.config.providers[PROVIDER]!.modelReasoningEfforts).toBeUndefined();
    expect(h.config.providers[PROVIDER]!.modelDefaultReasoningEfforts).toEqual({ [MODEL]: "high" });
  });

  test("duplicate modalities are deduplicated before the unchanged check", async () => {
    const h = harness();
    h.config.providers[PROVIDER]!.modelCapabilities = { [MODEL]: { inputModalities: ["text", "image"] } };

    const response = await h.call({ provider: PROVIDER, modelId: MODEL, inputModalities: ["text", "text"] });

    expect(await response.json()).toMatchObject({ changed: true, inputModalities: ["text"] });
    expect(h.config.providers[PROVIDER]!.modelCapabilities).toEqual({ [MODEL]: { inputModalities: ["text"] } });
  });
});
