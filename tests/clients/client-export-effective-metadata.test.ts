/**
 * Effective export metadata for custom model rows.
 *
 * A custom row's own `/api/models` fields are the operator's stored OVERRIDES — the edit
 * dialog reads them to show what the user set. Every client-facing surface (the management
 * export projection, `ocx export`, the `ocx opencode` launcher) has to serialize the
 * EFFECTIVE view instead: the canonical resolved catalog metadata for the same
 * `provider/modelId`, with explicit overrides (including `reasoningEfforts: []`) winning.
 *
 * These cases pin the whole chain — config + gathered roster → `listManagementModelRows` →
 * `toExportModel` / CLI projections — because a defect anywhere in it hands a client a
 * model that is missing its context window, output ceiling or ladder even though the proxy
 * routes with all of them.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import {
  effectiveModelDefaultReasoningEffort,
  listManagementModelRows,
  loadExportModels,
  resetExportSnapshotForTests,
  toExportModel,
} from "../../src/server/management/model-rows";
import { CODEX_CUSTOM_MODEL_CATALOG_KIND, type CatalogModel } from "../../src/codex/catalog/parsing";
import { exportModelsFromProxyRows } from "../../src/cli/export-command";
import { opencodeCatalogFromProxyRows } from "../../src/cli/opencode";
import { knownReasoningSupport, type EffectiveModelExportMetadata } from "../../src/clients/config-export/contracts";
import type { OcxConfig } from "../../src/types";

function config(extra?: Partial<OcxConfig>): OcxConfig {
  return {
    port: 10100,
    hostname: "127.0.0.1",
    defaultProvider: "acme",
    providers: { acme: { adapter: "openai-chat", baseUrl: "http://127.0.0.1/v1" } },
    ...extra,
  } as OcxConfig;
}

/**
 * The row the gather materializes for a custom model: explicit overrides folded in, provider
 * and native inheritance gap-filled. Tests build it by hand because a supplied roster is the
 * only hermetic way through `listManagementModelRows`.
 */
function gatheredCustomRow(
  provider: string,
  id: string,
  resolved: Partial<CatalogModel> = {},
): CatalogModel {
  return { id, provider, catalogKind: CODEX_CUSTOM_MODEL_CATALOG_KIND, ...resolved };
}

let configRoot = "";
let priorHome: string | undefined;

beforeEach(() => {
  configRoot = mkdtempSync(join(tmpdir(), "ocx-effective-export-"));
  priorHome = process.env.OPENCODEX_HOME;
  process.env.OPENCODEX_HOME = configRoot;
  mkdirSync(configRoot, { recursive: true });
  resetExportSnapshotForTests();
});

afterEach(() => {
  if (priorHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = priorHome;
  removeTreeWithRetry(configRoot);
});

describe("custom rows carry an effective export projection beside the raw overrides", () => {
  test("inheritance: the gathered catalog row fills context, input/output ceilings, modalities and capabilities", async () => {
    const cfg = config({
      providers: {
        acme: {
          adapter: "openai-chat",
          baseUrl: "http://127.0.0.1/v1",
          // No per-model records: the provider-wide ladder is the inherited ladder here.
          reasoningEfforts: ["low", "high"],
        },
      },
      customModels: [{ id: "c1", provider: "acme", modelId: "writer" }],
    });
    const rows = await listManagementModelRows(cfg, {
      models: [gatheredCustomRow("acme", "writer", {
        contextWindow: 200_000,
        maxInputTokens: 150_000,
        maxOutputTokens: 64_000,
        inputModalities: ["text", "image"],
        capabilities: ["tools"],
        supportsReasoningSummaries: true,
        // The gather only lets an inherited default ride when it is a ladder member.
        defaultReasoningEffort: "high",
      })],
    });
    const row = rows.find(candidate => candidate.namespaced === "acme/writer");
    expect(row).toBeDefined();
    // The effective view: gathered limits, provider-wide ladder, gather-declared default.
    expect(row?.exportMetadata).toEqual({
      contextWindow: 200_000,
      maxInputTokens: 150_000,
      maxTokens: 64_000,
      inputModalities: ["text", "image"],
      reasoningEfforts: ["low", "high"],
      defaultReasoningEffort: "high",
      supportsTools: true,
      supportsReasoning: true,
      supportsReasoningSummaries: true,
    } satisfies EffectiveModelExportMetadata);
    // Raw editor semantics: nothing above leaked back into the stored-override fields.
    expect(row?.contextWindow).toBeUndefined();
    expect(row?.inputModalities).toBeUndefined();
    expect(row?.reasoningEfforts).toBeUndefined();
    expect(row?.defaultReasoningEffort).toBeUndefined();
    // The row-level booleans exist so a CLI reading /api/models needs no local policy.
    expect(row?.supportsTools).toBe(true);
    expect(row?.supportsReasoning).toBe(true);
    // And the export projection serializes the effective view, not the raw one.
    expect(toExportModel(row!)).toMatchObject({
      namespaced: "acme/writer",
      contextWindow: 200_000,
      maxTokens: 64_000,
      maxInputTokens: 150_000,
      inputModalities: ["text", "image"],
      reasoningEfforts: ["low", "high"],
      defaultReasoningEffort: "high",
      supportsTools: true,
      supportsReasoning: true,
      supportsReasoningSummaries: true,
    });
  });

  test("explicit overrides win, including the empty no-rungs ladder", async () => {
    const cfg = config({
      providers: {
        acme: {
          adapter: "openai-chat",
          baseUrl: "http://127.0.0.1/v1",
          reasoningEfforts: ["low", "medium", "high"],
        },
      },
      customModels: [{
        id: "c1", provider: "acme", modelId: "writer",
        contextWindow: 8_000,
        reasoningEfforts: [],
        defaultReasoningEffort: "low",
      }],
    });
    // No gathered row at all: the override has to win on its own, which is the case where a
    // rosterless rebuild used to lose it entirely.
    const rows = await listManagementModelRows(cfg, { models: [] });
    const row = rows.find(candidate => candidate.namespaced === "acme/writer");
    expect(row?.exportMetadata?.reasoningEfforts).toEqual([]);
    expect(row?.exportMetadata?.contextWindow).toBe(8_000);
    // An empty ladder has no rung to default to, so the projection drops the stored default
    // even though the editor keeps showing it — the settings route rejects the same
    // combination, and an export must not ship a default the row cannot act on.
    expect(row?.exportMetadata?.defaultReasoningEffort).toBeUndefined();
    expect(toExportModel(row!)).not.toHaveProperty("defaultReasoningEffort");
    // The raw picker view keeps the stored default: editor semantics are untouched.
    expect(row?.defaultReasoningEffort).toBe("low");
    // An empty ladder is "no adjustable effort", not "cannot reason": unknown stays absent.
    expect(row?.exportMetadata?.supportsReasoning).toBeUndefined();
    expect(row?.supportsReasoning).toBeUndefined();
    const exported = toExportModel(row!);
    expect(exported.reasoningEfforts).toEqual([]);
    expect(exported.supportsReasoning).toBeUndefined();
  });

  test("a stored default survives, and no default is fabricated when none is declared", async () => {
    const cfg = config({
      providers: {
        acme: {
          adapter: "openai-chat",
          baseUrl: "http://127.0.0.1/v1",
          // No medium rung, so the legacy preference order would answer "low".
          reasoningEfforts: ["low", "high"],
        },
      },
      customModels: [{ id: "c1", provider: "acme", modelId: "writer" }],
    });
    const rows = await listManagementModelRows(cfg, { models: [] });
    const row = rows.find(candidate => candidate.namespaced === "acme/writer");
    expect(row?.exportMetadata?.reasoningEfforts).toEqual(["low", "high"]);
    expect(row?.exportMetadata?.defaultReasoningEffort).toBeUndefined();
    // The boundary this projection deliberately does NOT copy: the picker reader derives a
    // preference from the ladder, and an export must not ship that as a declared default.
    expect(effectiveModelDefaultReasoningEffort(cfg, "acme", "writer", undefined, ["low", "high"])).toBe("low");

    // The operator's per-model record is a declared default and is carried.
    const declared = config({
      providers: {
        acme: {
          adapter: "openai-chat",
          baseUrl: "http://127.0.0.1/v1",
          reasoningEfforts: ["low", "high"],
          modelDefaultReasoningEfforts: { writer: "high" },
        },
      },
      customModels: [{ id: "c1", provider: "acme", modelId: "writer" }],
    });
    const declaredRows = await listManagementModelRows(declared, { models: [] });
    expect(declaredRows.find(candidate => candidate.namespaced === "acme/writer")?.exportMetadata?.defaultReasoningEffort)
      .toBe("high");
  });

  test("a registry-declared ladder and window reach a rosterless custom row", async () => {
    const { PROVIDER_REGISTRY } = await import("../../src/providers/registry");
    const { providerConfigSeed } = await import("../../src/providers/derive");
    const entry = PROVIDER_REGISTRY.find(candidate => candidate.id === "google-antigravity")!;
    const cfg = config({
      defaultProvider: "google-antigravity",
      providers: {
        "google-antigravity": { ...providerConfigSeed(entry), authMode: "key", apiKey: "test-token", liveModels: false },
      },
      customModels: [{ id: "c1", provider: "google-antigravity", modelId: "gemini-3.8-flash" }],
    });
    const rows = await listManagementModelRows(cfg, { models: [] });
    const row = rows.find(candidate => candidate.namespaced === "google-antigravity/gemini-3.8-flash");
    // ANTIGRAVITY_MODEL_EFFORTS and ANTIGRAVITY_MODEL_CONTEXT_WINDOWS, arrived at through the
    // same registry hydration a routed row of this provider gets — not a second fact table.
    expect(row?.exportMetadata?.reasoningEfforts).toEqual(["low", "medium", "high"]);
    expect(row?.exportMetadata?.contextWindow).toBe(1_048_576);
    expect(row?.exportMetadata?.inputModalities).toEqual(["text", "image"]);
  });

  test("delivered-reasoning evidence in the provider config reaches a rosterless custom row", async () => {
    const cfg = config({
      providers: {
        acme: {
          adapter: "openai-chat",
          baseUrl: "http://127.0.0.1/v1",
          modelSupportsReasoningSummaries: { writer: true },
        },
      },
      customModels: [{ id: "c1", provider: "acme", modelId: "writer" }],
    });
    const rows = await listManagementModelRows(cfg, { models: [] });
    const row = rows.find(candidate => candidate.namespaced === "acme/writer");
    // No ladder anywhere: reasoning support comes from the summaries declaration alone, which
    // is exactly the case where "no adjustable effort" must not be read as "cannot reason".
    expect(row?.exportMetadata?.reasoningEfforts).toBeUndefined();
    expect(row?.exportMetadata?.supportsReasoningSummaries).toBe(true);
    expect(row?.exportMetadata?.supportsReasoning).toBe(true);
    expect(row?.supportsReasoning).toBe(true);
    expect(row?.exportMetadata?.supportsTools).toBeUndefined();
  });

  test("effective metadata matches the row's own slug exactly and never a neighbouring id", async () => {
    const cfg = config({
      providers: {
        acme: {
          adapter: "openai-chat",
          baseUrl: "http://127.0.0.1/v1",
          modelDefaultReasoningEfforts: { "alpha-extra": "high" },
        },
      },
      customModels: [
        { id: "c1", provider: "acme", modelId: "alpha" },
        { id: "c2", provider: "acme", modelId: "alpha-extra" },
      ],
    });
    const rows = await listManagementModelRows(cfg, {
      models: [
        gatheredCustomRow("acme", "alpha", { contextWindow: 32_000, maxOutputTokens: 8_000 }),
        gatheredCustomRow("acme", "alpha-extra", { contextWindow: 256_000, maxOutputTokens: 64_000 }),
      ],
    });
    const alpha = rows.find(candidate => candidate.namespaced === "acme/alpha");
    const alphaExtra = rows.find(candidate => candidate.namespaced === "acme/alpha-extra");
    expect(alpha?.exportMetadata?.contextWindow).toBe(32_000);
    expect(alpha?.exportMetadata?.maxTokens).toBe(8_000);
    // The neighbouring row's default record did not leak through a prefix-ish match.
    expect(alpha?.exportMetadata?.defaultReasoningEffort).toBeUndefined();
    expect(alphaExtra?.exportMetadata?.contextWindow).toBe(256_000);
    expect(alphaExtra?.exportMetadata?.defaultReasoningEffort).toBe("high");
  });

  test("disabled custom rows stay out of the export roster and dedupe keeps the first row", async () => {
    const cfg = config({
      customModels: [
        { id: "c1", provider: "acme", modelId: "writer" },
        { id: "c2", provider: "acme", modelId: "gone" },
      ],
      disabledModels: ["acme/gone"],
    });
    const exported = (await loadExportModels(cfg, [gatheredCustomRow("acme", "writer", { contextWindow: 64_000 })]))
      .filter(model => model.provider === "acme");
    expect(exported.map(model => model.namespaced)).toEqual(["acme/writer"]);
    expect(exported[0]).toMatchObject({ contextWindow: 64_000 });
  });
});

describe("CLI projections consume the same effective metadata", () => {
  const customProxyRow = {
    provider: "acme",
    id: "writer",
    namespaced: "acme/writer",
    disabled: false,
    exportMetadata: {
      contextWindow: 200_000,
      maxInputTokens: 150_000,
      maxTokens: 64_000,
      inputModalities: ["text", "image"],
      reasoningEfforts: ["low", "high"],
      defaultReasoningEffort: "low",
      supportsTools: true,
      supportsReasoningSummaries: true,
    } satisfies EffectiveModelExportMetadata,
  };

  test("the launcher catalog prefers the effective projection for custom rows", () => {
    const [entry] = opencodeCatalogFromProxyRows([customProxyRow], config());
    expect(entry).toMatchObject({
      namespaced: "acme/writer",
      contextWindow: 200_000,
      maxTokens: 64_000,
      maxInputTokens: 150_000,
      inputModalities: ["text", "image"],
      reasoningEfforts: ["low", "high"],
      defaultReasoningEffort: "low",
      supportsTools: true,
      supportsReasoningSummaries: true,
    });
  });

  test("a projection whose default is absent means NO default, never the row's picker value", () => {
    // The shape a hub actually sends for a custom row whose stored ladder is empty: no
    // default key, while the row-level default still carries the operator's pick for the
    // editor. Falling back to the row here would resurrect a default with no rung.
    const emptyLadderRow = {
      provider: "acme",
      id: "writer",
      namespaced: "acme/writer",
      disabled: false,
      defaultReasoningEffort: "low",
      exportMetadata: { reasoningEfforts: [] } satisfies EffectiveModelExportMetadata,
    };
    const [entry] = opencodeCatalogFromProxyRows([emptyLadderRow], config());
    expect(entry?.reasoningEfforts).toEqual([]);
    expect(entry).not.toHaveProperty("defaultReasoningEffort");
    const [model] = exportModelsFromProxyRows([emptyLadderRow], config());
    expect(model?.reasoningEfforts).toEqual([]);
    expect(model).not.toHaveProperty("defaultReasoningEffort");
  });

  test("`ocx export` carries maxTokens, input ceilings and the empty-vs-undefined ladder", () => {
    const [model] = exportModelsFromProxyRows([customProxyRow], config());
    expect(model?.maxTokens).toBe(64_000);
    expect(model?.maxInputTokens).toBe(150_000);
    expect(model?.contextWindow).toBe(200_000);
    expect(model?.reasoningEfforts).toEqual(["low", "high"]);
    expect(model?.defaultReasoningEffort).toBe("low");

    // Routed rows keep working from their own fields, including the output limit the CLI
    // projection used to drop on the floor.
    const [routed] = exportModelsFromProxyRows([{
      provider: "acme", id: "routed", namespaced: "acme/routed",
      contextWindow: 400_000, maxOutputTokens: 32_000, maxInputTokens: 300_000,
      supportsTools: true, supportsReasoning: true, supportsReasoningSummaries: false,
    }], config());
    expect(routed?.maxTokens).toBe(32_000);
    expect(routed?.maxInputTokens).toBe(300_000);
    expect(routed?.supportsTools).toBe(true);
    expect(routed?.supportsReasoning).toBe(true);
    expect(routed?.supportsReasoningSummaries).toBe(false);

    // Undefined stays undefined: a row with no ladder exports no ladder key at all.
    const [plain] = exportModelsFromProxyRows([{
      provider: "acme", id: "plain", namespaced: "acme/plain",
    }], config());
    expect(plain).not.toHaveProperty("reasoningEfforts");
    expect(plain).not.toHaveProperty("maxTokens");
    expect(plain).not.toHaveProperty("supportsReasoning");
  });

  test("an explicit capability false survives the CLI hop; absence stays absence", () => {
    const [entry] = opencodeCatalogFromProxyRows([{
      provider: "acme", id: "writer", namespaced: "acme/writer",
      supportsTools: false, supportsReasoning: false,
    }], config());
    expect(entry?.supportsTools).toBe(false);
    expect(entry?.supportsReasoning).toBe(false);
    const [model] = exportModelsFromProxyRows([{
      provider: "acme", id: "writer", namespaced: "acme/writer",
      supportsTools: false, supportsReasoning: false,
    }], config());
    expect(model?.supportsTools).toBe(false);
    expect(model?.supportsReasoning).toBe(false);
    // Nothing infers a negative from missing evidence.
    const [unknown] = exportModelsFromProxyRows([{
      provider: "acme", id: "mystery", namespaced: "acme/mystery", reasoningEfforts: [],
    }], config());
    expect(unknown?.reasoningEfforts).toEqual([]);
    expect(unknown).not.toHaveProperty("supportsReasoning");
    expect(unknown).not.toHaveProperty("supportsTools");
  });

  test("a duplicate namespaced row cannot donate its effective metadata", () => {
    const duplicate = { ...customProxyRow, contextWindow: 999_999, maxOutputTokens: 1_000 };
    const catalog = opencodeCatalogFromProxyRows([customProxyRow, duplicate], config());
    expect(catalog).toHaveLength(1);
    expect(catalog[0]?.contextWindow).toBe(200_000);
    expect(catalog[0]?.maxTokens).toBe(64_000);

    // First row without the projection, second with it: the visible entry keeps the first
    // row's own fields rather than inheriting the duplicate's effective view.
    const bare = { provider: "acme", id: "writer", namespaced: "acme/writer", disabled: false };
    const [entry] = opencodeCatalogFromProxyRows([bare, customProxyRow], config());
    expect(entry?.contextWindow).toBeUndefined();
    expect(entry?.maxTokens).toBeUndefined();
    expect(entry?.maxInputTokens).toBeUndefined();
  });
});

describe("routed and native rows carry an authoritative declared default", () => {
  test("a ladder with no declared default exports no default while the picker still prefers low", async () => {
    const cfg = config();
    const rows = await listManagementModelRows(cfg, {
      models: [{ id: "routed", provider: "acme", reasoningEfforts: ["low", "high"] }],
    });
    const row = rows.find(candidate => candidate.namespaced === "acme/routed");
    // Raw picker semantics, unchanged: no medium rung, so the preference order answers low.
    expect(row?.reasoningEfforts).toEqual(["low", "high"]);
    expect(row?.defaultReasoningEffort).toBe("low");
    // The authoritative projection exists and declares nothing — that is the whole fix: the
    // picker's synthesized value must not ride into a client export.
    expect(row?.exportMetadata).toEqual({});
    const exported = toExportModel(row!);
    expect(exported.reasoningEfforts).toEqual(["low", "high"]);
    expect(exported).not.toHaveProperty("defaultReasoningEffort");
  });

  test("a gathered declared default is carried, and one outside the effective ladder is dropped", async () => {
    const rows = await listManagementModelRows(config(), {
      models: [
        { id: "declared", provider: "acme", reasoningEfforts: ["low", "high"], defaultReasoningEffort: "high" },
        { id: "outsider", provider: "acme", reasoningEfforts: ["low", "high"], defaultReasoningEffort: "xhigh" },
      ],
    });
    const declared = rows.find(candidate => candidate.namespaced === "acme/declared");
    expect(declared?.exportMetadata?.defaultReasoningEffort).toBe("high");
    expect(toExportModel(declared!).defaultReasoningEffort).toBe("high");
    // The row-level picker value survives for both; only the projection drops the outsider.
    const outsider = rows.find(candidate => candidate.namespaced === "acme/outsider");
    expect(outsider?.defaultReasoningEffort).toBe("xhigh");
    expect(outsider?.exportMetadata).toEqual({});
    expect(toExportModel(outsider!)).not.toHaveProperty("defaultReasoningEffort");
  });

  test("a native row's pinned default is carried verbatim", async () => {
    const rows = await listManagementModelRows(config(), { models: [] });
    const sol = rows.find(candidate => candidate.namespaced === "gpt-5.6-sol");
    expect(sol?.native).toBe(true);
    // Pinned upstream default, not a preference-order guess.
    expect(sol?.defaultReasoningEffort).toBe("low");
    expect(sol?.exportMetadata?.defaultReasoningEffort).toBe("low");
    expect(toExportModel(sol!).defaultReasoningEffort).toBe("low");
  });

  test("the wire shape a hub sends yields the same answer through the CLI", async () => {
    // Round-trip the management row the way /api/models serializes it, so the parity claim
    // covers the actual bytes the launcher reads rather than a hand-built lookalike.
    const rows = await listManagementModelRows(config(), {
      models: [{ id: "routed", provider: "acme", reasoningEfforts: ["low", "high"] }],
    });
    const wire = JSON.parse(JSON.stringify(rows.find(candidate => candidate.namespaced === "acme/routed")));
    const [entry] = opencodeCatalogFromProxyRows([wire], config());
    expect(entry?.reasoningEfforts).toEqual(["low", "high"]);
    // The row carries the picker's "low"; the projection's absence wins.
    expect(wire.defaultReasoningEffort).toBe("low");
    expect(entry).not.toHaveProperty("defaultReasoningEffort");
    const [model] = exportModelsFromProxyRows([wire], config());
    expect(model?.reasoningEfforts).toEqual(["low", "high"]);
    expect(model).not.toHaveProperty("defaultReasoningEffort");
  });
});

describe("the custom projection defers to the gather's resolved values", () => {
  test("a gathered context window beats a wider config map instead of widening past it", async () => {
    const cfg = config({
      providers: {
        acme: {
          adapter: "openai-chat",
          baseUrl: "http://127.0.0.1/v1",
          modelContextWindows: { writer: 200_000 },
        },
      },
      customModels: [{ id: "c1", provider: "acme", modelId: "writer" }],
    });
    const rows = await listManagementModelRows(cfg, {
      models: [gatheredCustomRow("acme", "writer", { contextWindow: 32_000 })],
    });
    // The gather already ran the canonical precedence and observed a tighter window; the
    // config map is a fallback for rows the gather never saw, not a way to widen.
    expect(rows.find(candidate => candidate.namespaced === "acme/writer")?.exportMetadata?.contextWindow)
      .toBe(32_000);
  });

  test("a gathered bounded ladder is authoritative over the raw stored override", async () => {
    const cfg = config({
      customModels: [{
        id: "c1", provider: "acme", modelId: "writer",
        reasoningEfforts: ["low", "medium", "high", "xhigh"],
      }],
    });
    // The shape the gather produces after the canonical bounds: the override, narrowed.
    const rows = await listManagementModelRows(cfg, {
      models: [gatheredCustomRow("acme", "writer", { reasoningEfforts: ["low", "high"] })],
    });
    const row = rows.find(candidate => candidate.namespaced === "acme/writer");
    expect(row?.exportMetadata?.reasoningEfforts).toEqual(["low", "high"]);
    // The editor still sees exactly what the operator stored.
    expect(row?.reasoningEfforts).toEqual(["low", "medium", "high", "xhigh"]);
  });

  test("an explicitly cleared ladder still beats a stale gathered row", async () => {
    const cfg = config({
      customModels: [{ id: "c1", provider: "acme", modelId: "writer", reasoningEfforts: [] }],
    });
    const rows = await listManagementModelRows(cfg, {
      models: [gatheredCustomRow("acme", "writer", { reasoningEfforts: ["low", "high"] })],
    });
    expect(rows.find(candidate => candidate.namespaced === "acme/writer")?.exportMetadata?.reasoningEfforts)
      .toEqual([]);
  });

  test("a stored default outside the effective ladder is omitted from the projection", async () => {
    const cfg = config({
      providers: { acme: { adapter: "openai-chat", baseUrl: "http://127.0.0.1/v1" } },
      customModels: [{
        id: "c1", provider: "acme", modelId: "writer",
        reasoningEfforts: ["low", "high"],
        defaultReasoningEffort: "max",
      }],
    });
    const rows = await listManagementModelRows(cfg, { models: [] });
    const row = rows.find(candidate => candidate.namespaced === "acme/writer");
    expect(row?.exportMetadata?.reasoningEfforts).toEqual(["low", "high"]);
    expect(row?.exportMetadata?.defaultReasoningEffort).toBeUndefined();
    expect(toExportModel(row!)).not.toHaveProperty("defaultReasoningEffort");
  });
});

describe("capability booleans come from positive evidence only", () => {
  test("an off-sentinel-only ladder is not an assertion that the model can reason", async () => {
    const cfg = config({
      customModels: [{ id: "c1", provider: "acme", modelId: "writer", reasoningEfforts: ["none"] }],
    });
    const rows = await listManagementModelRows(cfg, { models: [] });
    const row = rows.find(candidate => candidate.namespaced === "acme/writer");
    expect(row?.exportMetadata?.reasoningEfforts).toEqual(["none"]);
    expect(row?.exportMetadata?.supportsReasoning).toBeUndefined();
    expect(row?.supportsReasoning).toBeUndefined();

    // Directly, because the rule is the shared helper's: `none` offers an off variant and
    // says nothing about reasoning; any real rung alongside it does.
    expect(knownReasoningSupport({ reasoningEfforts: ["none"] })).toBeUndefined();
    expect(knownReasoningSupport({ reasoningEfforts: ["none", "low"] })).toBe(true);
    expect(knownReasoningSupport({ reasoningEfforts: ["minimal"] })).toBe(true);
    expect(knownReasoningSupport({ supportsReasoningSummaries: true })).toBe(true);
    expect(knownReasoningSupport({})).toBeUndefined();
  });

  test("an explicit false on a row is preserved by toExportModel", () => {
    const exported = toExportModel({
      namespaced: "acme/writer", provider: "acme", id: "writer", disabled: false,
      supportsTools: false, supportsReasoning: false,
    });
    expect(exported.supportsTools).toBe(false);
    expect(exported.supportsReasoning).toBe(false);
  });
});
