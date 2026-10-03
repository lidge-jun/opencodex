import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeTreeWithRetry } from "../../helpers/remove-tree";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { parseAntigravityAvailableModels, registerAntigravityDiscoveredWireModels, resolveAntigravityEffortWireModel } from "../../../src/providers/antigravity-models";
import { captureModelCacheGeneration, clearModelCache } from "../../../src/codex/model-cache";
import { createGoogleAdapter } from "../../../src/adapters/google";
import { withTestTranslatorBudget } from "../../helpers/translator-budget";
import type { OcxParsedRequest } from "../../../src/types";

const originalHome = process.env.OPENCODEX_HOME;
let testHome: string;
beforeEach(() => { testHome = mkdtempSync(join(tmpdir(), "ocx-agy-family-")); process.env.OPENCODEX_HOME = testHome; });
afterEach(() => {
  if (originalHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = originalHome;
  removeTreeWithRetry(testHome);
});

const baseUrl = "https://antigravity-families.example.test";
const efforts = ["low", "medium", "high"] as const;
function payload(base: string, tiers: readonly string[] = efforts) {
  const ids = tiers.map(effort => `${base}-${effort}`);
  return { models: Object.fromEntries(ids.map(id => [id, {
    displayName: "Shared display name", maxTokens: 350_000, supportsImages: true,
  }])), agentModelSorts: [{ groups: [{ modelIds: ids }] }] };
}
afterEach(() => { registerAntigravityDiscoveredWireModels(baseUrl, []); clearModelCache("family-test"); });

for (const base of ["claude-opus-5-5", "claude-sonnet-5-5", "claude-opus-6-2", "future-flash"]) {
  test(`${base}: complete discovery collapses independent of version, label and order`, () => {
    const rows = parseAntigravityAvailableModels(payload(base, ["high", "low", "medium"]))!;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: base, contextWindow: 350_000, inputModalities: ["text", "image"],
      effortWireModelIds: { low: `${base}-low`, medium: `${base}-medium`, high: `${base}-high` } });
    registerAntigravityDiscoveredWireModels(baseUrl, rows);
    for (const effort of efforts) expect(resolveAntigravityEffortWireModel(base, effort, baseUrl))
      .toEqual({ wireModelId: `${base}-${effort}` });
    expect(resolveAntigravityEffortWireModel(base, undefined, baseUrl)).toEqual({ wireModelId: `${base}-medium` });
    expect(resolveAntigravityEffortWireModel(`${base}-low`, "high", baseUrl)).toEqual({ wireModelId: `${base}-low` });
  });
}

test("partial tiers keep their wire identity even with identical display labels", () => {
  const rows = parseAntigravityAvailableModels(payload("claude-sonnet-5-5", ["high", "low"]))!;
  expect(rows.map(row => row.id)).toEqual(["claude-sonnet-5-5-high", "claude-sonnet-5-5-low"]);
  expect(rows.every(row => row.effortWireModelIds === undefined)).toBe(true);
});

test("family metadata uses the lower common capability instead of first-tier metadata", () => {
  const data = payload("claude-opus-5-5", ["high", "medium", "low"]);
  data.models["claude-opus-5-5-low"]!.maxTokens = 200_000;
  data.models["claude-opus-5-5-low"]!.supportsImages = false;
  expect(parseAntigravityAvailableModels(data)?.[0]).toMatchObject({ contextWindow: 200_000, inputModalities: ["text"] });
  const unknown = data.models["claude-opus-5-5-low"] as Record<string, unknown>;
  delete unknown.maxTokens;
  delete unknown.supportsImages;
  const row = parseAntigravityAvailableModels(data)?.[0];
  expect(row?.contextWindow).toBeUndefined();
  expect(row?.inputModalities).toBeUndefined();
});

test("discovery mapping remains URL scoped and retires with cache generation", () => {
  const base = "claude-opus-5-5";
  registerAntigravityDiscoveredWireModels(baseUrl, parseAntigravityAvailableModels(payload(base))!, {
    provider: "family-test", cacheGeneration: captureModelCacheGeneration("family-test"),
  });
  expect(resolveAntigravityEffortWireModel(base, "high", baseUrl)).toEqual({ wireModelId: `${base}-high` });
  expect(resolveAntigravityEffortWireModel(base, "high", "https://other.example.test")).toEqual({ wireModelId: base });
  clearModelCache("family-test");
  expect(resolveAntigravityEffortWireModel(base, "high", baseUrl)).toEqual({ wireModelId: base });
});

test("5.5 adapter sends selected wire suffix without contradictory thinkingLevel", async () => {
  registerAntigravityDiscoveredWireModels(baseUrl, parseAntigravityAvailableModels(payload("claude-opus-5-5"))!);
  const adapter = withTestTranslatorBudget(createGoogleAdapter({ adapter: "google", baseUrl,
    googleMode: "cloud-code-assist", project: "fixture-project", apiKey: "fixture-token" }));
  for (const effort of efforts) {
    const request: OcxParsedRequest = { modelId: "claude-opus-5-5", stream: false,
      context: { messages: [{ role: "user", content: "hello" }], systemPrompt: [], tools: [] },
      options: { reasoning: effort } } as OcxParsedRequest;
    const body = JSON.parse((await adapter.buildRequest(request)).body);
    expect(body.model).toBe(`claude-opus-5-5-${effort}`);
    expect(body.request.generationConfig?.thinkingConfig).toBeUndefined();
  }
});

test("an evidenced overlapping base takes routing precedence over a parent tier alias", () => {
  const first = payload("foo");
  const second = payload("foo-low");
  const rows = parseAntigravityAvailableModels({ models: { ...first.models, ...second.models },
    agentModelSorts: [{ groups: [{ modelIds: [...Object.keys(second.models), ...Object.keys(first.models)] }] }] })!;
  registerAntigravityDiscoveredWireModels(baseUrl, rows);
  expect(rows.map(row => row.id).sort()).toEqual(["foo", "foo-low"]);
  expect(resolveAntigravityEffortWireModel("foo-low", "high", baseUrl)).toEqual({ wireModelId: "foo-low-high" });
  expect(resolveAntigravityEffortWireModel("foo", "low", baseUrl)).toEqual({ wireModelId: "foo-low" });
});
