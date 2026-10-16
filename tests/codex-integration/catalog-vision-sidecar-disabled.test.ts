import { afterEach, describe, expect, test } from "bun:test";
import { buildCatalogEntries, gatherRoutedModels, resolveComboCatalogMember } from "../../src/codex/catalog";
import { gatherFlightKey } from "../../src/codex/catalog/gather-capture";
import { fetchProviderModels } from "../../src/codex/catalog/provider-models";
import { clearModelCache } from "../../src/codex/model-cache";
import type { CatalogModel, OcxConfig } from "../../src/types";
import { withStubbedProviderFetch } from "../helpers/catalog-provider-fetch";

const providerName = "vision-disabled-fixture";
const originalFetch = globalThis.fetch;
const ids = ["declared-text", "no-vision", "vision-native", "vision-exact"];

/** Offline provider with independent text-only, native and exact capability declarations. */
function config(enabled?: boolean, liveModels = false): OcxConfig {
  return withStubbedProviderFetch({
    port: 10100,
    defaultProvider: providerName,
    ...(enabled === undefined ? {} : { visionSidecar: { enabled } }),
    providers: {
      [providerName]: {
        adapter: "openai-chat", baseUrl: "https://vision-fixture.example/v1",
        authMode: "key", apiKey: "fixture-key", liveModels, models: [...ids],
        noVisionModels: ["no-vision", "vision-exact"],
        modelInputModalities: {
          "declared-text": ["text"], "vision-native": ["text", "image"],
          "vision-exact": ["text"], "custom-text": ["text"],
        },
        modelCapabilities: { "vision-exact": { inputModalities: ["text", "image"] } },
        modelContextWindows: Object.fromEntries(ids.map(id => [id, 200_000])),
      },
    },
  });
}

/** Supply local model-list responses; no provider or user configuration is contacted. */
function modelsResponse(): Response {
  return Response.json({ data: ids.map(id => ({ id, input_modalities: ["text"] })) });
}

/** Compare published Codex modalities rather than only the intermediate gather rows. */
function modalities(models: CatalogModel[], id: string): unknown {
  return buildCatalogEntries(null, [], models)
    .find(row => row.slug === `${providerName}/${id}`)?.input_modalities;
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  clearModelCache(providerName);
});

describe("catalog respects the disabled vision sidecar", () => {
  test.each([false, true, undefined])("static rows use enabled=%s without widening native authority", async enabled => {
    globalThis.fetch = (() => { throw new Error("static catalog must not fetch"); }) as typeof fetch;
    const rows = await gatherRoutedModels(config(enabled));
    expect(modalities(rows, "declared-text")).toEqual(enabled === false ? ["text"] : ["text", "image"]);
    expect(modalities(rows, "no-vision")).toEqual(enabled === false ? ["text"] : ["text", "image"]);
    expect(modalities(rows, "vision-native")).toEqual(["text", "image"]);
    expect(modalities(rows, "vision-exact")).toEqual(["text", "image"]);
  });

  test.each([false, true])("custom rows preserve explicit modalities with enabled=%s", async enabled => {
    const fixture = config(enabled);
    fixture.customModels = [
      { id: "custom", provider: providerName, modelId: "custom-text", inputModalities: ["text"], addedAt: "2026-01-01" },
      { id: "override", provider: providerName, modelId: "no-vision", inputModalities: ["text", "image"], addedAt: "2026-01-01" },
    ];
    const rows = await gatherRoutedModels(fixture);
    expect(modalities(rows, "custom-text")).toEqual(enabled ? ["text", "image"] : ["text"]);
    expect(modalities(rows, "no-vision")).toEqual(["text", "image"]);
  });

  test.each([false, true])("missing combo members use enabled=%s", enabled => {
    const fixture = config(enabled);
    const member = resolveComboCatalogMember(
      { provider: providerName, model: "declared-text" }, new Map(),
      new Map(Object.entries(fixture.providers)), undefined, undefined, undefined, undefined, enabled,
    );
    expect(member?.inputModalities).toEqual(enabled ? ["text", "image"] : ["text"]);
  });

  test.each([false, true])("gathered combos follow enabled=%s", async enabled => {
    const fixture = config(enabled);
    fixture.combos = { selected: { targets: [{ provider: providerName, model: "declared-text" }] } };
    const rows = buildCatalogEntries(null, [], await gatherRoutedModels(fixture));
    expect(rows.find(row => row.slug === "combo/selected")?.input_modalities)
      .toEqual(enabled ? ["text", "image"] : ["text"]);
  });

  test.each(["declared-text", "custom-text"])("disabled sidecar preserves explicit custom image input in combo target %s", async modelId => {
    const fixture = config(false);
    fixture.customModels = [
      { id: "custom", provider: providerName, modelId, inputModalities: ["text", "image"], addedAt: "2026-01-01" },
    ];
    fixture.combos = { selected: { targets: [{ provider: providerName, model: modelId }] } };
    const models = await gatherRoutedModels(fixture);
    expect(modalities(models, modelId)).toEqual(["text", "image"]);
    expect(buildCatalogEntries(null, [], models).find(row => row.slug === "combo/selected")?.input_modalities)
      .toEqual(["text", "image"]);
  });

  test("warm live cache does not retain synthetic image input across disable and re-enable", async () => {
    let calls = 0;
    globalThis.fetch = (async () => { calls++; return modelsResponse(); }) as typeof fetch;
    const on = await gatherRoutedModels(config(true, true));
    const off = await gatherRoutedModels(config(false, true));
    const onAgain = await gatherRoutedModels(config(undefined, true));
    for (const id of ["declared-text", "no-vision"]) {
      expect(modalities(on, id)).toEqual(["text", "image"]);
      expect(modalities(off, id)).toEqual(["text"]);
      expect(modalities(onAgain, id)).toEqual(["text", "image"]);
    }
    expect(modalities(off, "vision-native")).toEqual(["text", "image"]);
    expect(calls).toBe(1);
  });

  test("provider-only default advertisement cannot widen a later disabled gather", async () => {
    let calls = 0;
    globalThis.fetch = (async () => { calls++; return modelsResponse(); }) as typeof fetch;
    const fixture = config(false, true);
    const providerRows = await fetchProviderModels(providerName, fixture.providers[providerName]!, 60_000);
    expect(modalities(providerRows, "no-vision")).toEqual(["text", "image"]);
    expect(modalities(await gatherRoutedModels(fixture), "no-vision")).toEqual(["text"]);
    expect(calls).toBe(1);
  });

  test("stale cache and failure cooldown reproject the current sidecar setting", async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return calls === 1 ? modelsResponse() : new Response("unavailable", { status: 503 });
    }) as typeof fetch;
    const on = config(true, true);
    on.modelCacheTtlMs = 0;
    expect(modalities(await gatherRoutedModels(on), "no-vision")).toEqual(["text", "image"]);
    const off = config(false, true);
    off.modelCacheTtlMs = 0;
    expect(modalities(await gatherRoutedModels(off), "no-vision")).toEqual(["text"]);
    expect(modalities(await gatherRoutedModels(on), "no-vision")).toEqual(["text", "image"]);
    expect(modalities(await gatherRoutedModels(off), "no-vision")).toEqual(["text"]);
    expect(calls).toBe(2);
  });

  test("disabled projection preserves live native image evidence without widening discovery-only text rows", async () => {
    globalThis.fetch = (async () => Response.json({ data: [
      { id: "live-native", input_modalities: ["text", "image"] },
      { id: "live-text", input_modalities: ["text"] },
    ] })) as typeof fetch;
    const off = await gatherRoutedModels(config(false, true));
    const on = await gatherRoutedModels(config(true, true));
    for (const rows of [off, on]) {
      expect(modalities(rows, "live-native")).toEqual(["text", "image"]);
      expect(modalities(rows, "live-text")).toEqual(["text"]);
    }
  });

  test.each([false, true])("mixed native and exact text-only combo uses enabled=%s", async enabled => {
    const fixture = config(enabled);
    fixture.providers[providerName]!.modelCapabilities!["declared-text"] = { inputModalities: ["text"] };
    fixture.combos = { mixed: { targets: [
      { provider: providerName, model: "declared-text" },
      { provider: providerName, model: "vision-native" },
    ] } };
    const entries = buildCatalogEntries(null, [], await gatherRoutedModels(fixture));
    expect(entries.find(row => row.slug === "combo/mixed")?.input_modalities)
      .toEqual(enabled ? ["text", "image"] : ["text"]);
  });

  test("opposite settings cannot join the same pending gather", async () => {
    let started!: () => void;
    let release!: () => void;
    const firstStarted = new Promise<void>(resolve => { started = resolve; });
    const pending = new Promise<void>(resolve => { release = resolve; });
    let calls = 0;
    globalThis.fetch = (async () => {
      if (++calls === 1) { started(); await pending; }
      return modelsResponse();
    }) as typeof fetch;
    const onPromise = gatherRoutedModels(config(true, true));
    await firstStarted;
    const offPromise = gatherRoutedModels(config(false, true));
    release();
    const [on, off] = await Promise.all([onPromise, offPromise]);
    expect(modalities(on, "no-vision")).toEqual(["text", "image"]);
    expect(modalities(off, "no-vision")).toEqual(["text"]);
  });

  test("a pending gather keeps the enabled setting it admitted", async () => {
    let started!: () => void;
    let release!: () => void;
    const firstStarted = new Promise<void>(resolve => { started = resolve; });
    const pending = new Promise<void>(resolve => { release = resolve; });
    globalThis.fetch = (async () => { started(); await pending; return modelsResponse(); }) as typeof fetch;
    const fixture = config(true, true);
    const result = gatherRoutedModels(fixture);
    await firstStarted;
    fixture.visionSidecar!.enabled = false;
    release();
    expect(modalities(await result, "no-vision")).toEqual(["text", "image"]);
  });

  test("gather identity distinguishes disabled from the default enabled policy", () => {
    expect(gatherFlightKey(config(false))).not.toBe(gatherFlightKey(config(true)));
    expect(gatherFlightKey(config())).toBe(gatherFlightKey(config(true)));
  });
});
