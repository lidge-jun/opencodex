import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeTreeWithRetry } from "../../helpers/remove-tree";
import { fetchProviderModels } from "../../../src/codex/catalog/provider-models";
import { readAntigravityWireSnapshot, writeAntigravityWireSnapshot } from "../../../src/providers/antigravity-wire-snapshot";
import { createGoogleAdapter } from "../../../src/adapters/google";
import { withTestTranslatorBudget } from "../../helpers/translator-budget";
import type { OcxConfig, OcxParsedRequest } from "../../../src/types";
import { antigravityEffortFamilyIds, antigravityFamilyDisabled, collapseAntigravityPublicModels, projectAntigravitySelectedModels, type AntigravityEffortFamilyRow } from "../../../src/providers/antigravity-effort-families";
import { expect, test } from "bun:test";
import { antigravityUserAgentForWireModel, ANTIGRAVITY_CLI_REQUEST_UA, ANTIGRAVITY_REQUEST_UA } from "../../../src/adapters/google-antigravity-wire";
import { parseAntigravityAvailableModels, registerAntigravityDiscoveredWireModels, resolveAntigravityEffortWireModel } from "../../../src/providers/antigravity-models";

// Vertex evidence 2026-11-13 from #8583's author; on CCA an entitled account listed exactly these
// four tiers on 2026-11-12.
test("discovered Hydrogen retains its four wire tiers", () => {
  const ids = ["low", "medium", "high", "xhigh"].map(tier => `gemini-4-hydrogen-${tier}`);
  const rows = parseAntigravityAvailableModels({ models: Object.fromEntries(ids.map(id => [id, {}])), agentModelSorts: [{ groups: [{ modelIds: ids }] }] })!;
  expect(rows.map(row => row.id)).toEqual(["gemini-4-hydrogen"]);
  expect(rows[0]?.effortWireModelIds).toEqual({ low: ids[0], medium: ids[1], high: ids[2], xhigh: ids[3] });
  registerAntigravityDiscoveredWireModels("https://hydrogen.test", rows);
  expect(resolveAntigravityEffortWireModel("gemini-4-hydrogen", "xhigh", "https://hydrogen.test").wireModelId).toBe(ids[3]!);
  for (const effort of ["max", "ultra"]) {
    expect(resolveAntigravityEffortWireModel("gemini-4-hydrogen", effort, "https://hydrogen.test").wireModelId).toBe(ids[3]!);
  }
  expect(resolveAntigravityEffortWireModel("gemini-4-hydrogen", "high", "https://hydrogen.test").wireModelId).toBe(ids[2]!);
  expect(resolveAntigravityEffortWireModel("gemini-4-hydrogen", undefined, "https://hydrogen.test").wireModelId).toBe(ids[2]!);
});

test("Hydrogen xhigh uses the CLI user agent", () => {
  expect(antigravityUserAgentForWireModel("gemini-4-hydrogen-xhigh")).toBe(ANTIGRAVITY_CLI_REQUEST_UA);
});

test("CLI matching includes Gemini 4 tiers and excludes near misses", () => {
  for (const base of ["argon", "carbon", "hydrogen"]) {
    for (const suffix of ["", "-low", "-medium", "-high", "-xhigh"]) {
      expect(antigravityUserAgentForWireModel(`gemini-4-${base}${suffix}`)).toBe(ANTIGRAVITY_CLI_REQUEST_UA);
    }
  }
  for (const id of ["gemini-4-hydrogen-max", "gemini-4-hydrogen-xxhigh", "gemini-4-hydrogen-tiered", "gemini-3.7-flash-tiered", "gemini-4-argon-max", "gemini-4-carbon-max"]) {
    expect(antigravityUserAgentForWireModel(id)).toBe(ANTIGRAVITY_REQUEST_UA);
  }
});

test("incomplete families stay separate and three-tier families clamp xhigh", () => {
  const lone = parseAntigravityAvailableModels({ models: { "gemini-4-hydrogen-xhigh": {} }, agentModelSorts: [{ groups: [{ modelIds: ["gemini-4-hydrogen-xhigh"] }] }] })!;
  expect(lone[0]?.effortWireModelIds).toBeUndefined();
  for (const base of ["gemini-4-argon", "gemini-4-carbon"]) {
    const ids = ["low", "medium", "high"].map(t => `${base}-${t}`);
    const rows = parseAntigravityAvailableModels({ models: Object.fromEntries(ids.map(id => [id, {}])), agentModelSorts: [{ groups: [{ modelIds: ids }] }] })!;
    registerAntigravityDiscoveredWireModels("https://three.example.test", rows);
    for (const effort of ["xhigh", "max", "ultra"]) {
      expect(resolveAntigravityEffortWireModel(base, effort, "https://three.example.test").wireModelId).toBe(`${base}-high`);
    }
  }
});

test("adapter sends the discovered Hydrogen tier", async () => {
  const ids = ["low", "medium", "high", "xhigh"].map(t => `gemini-4-hydrogen-${t}`);
  const rows = parseAntigravityAvailableModels({ models: Object.fromEntries(ids.map(id => [id, {}])), agentModelSorts: [{ groups: [{ modelIds: ids }] }] })!;
  const baseUrl = "https://hydrogen-adapter.example.test";
  registerAntigravityDiscoveredWireModels(baseUrl, rows);
  // Without a configured ladder, and with the ladder the discovered catalog row publishes.
  for (const ladder of [undefined, { "gemini-4-hydrogen": ["low", "medium", "high", "xhigh"] }]) {
    const adapter = withTestTranslatorBudget(createGoogleAdapter({ adapter: "google", baseUrl, googleMode: "cloud-code-assist", project: "fixture", apiKey: "fixture",
      ...(ladder ? { modelReasoningEfforts: ladder } : {}) }));
    for (const [effort, wire] of [["xhigh", ids[3]], ["max", ids[3]], ["ultra", ids[3]], ["high", ids[2]], [undefined, ids[2]]] as const) {
      const request = await adapter.buildRequest({ modelId: "gemini-4-hydrogen", stream: false, context: { messages: [{ role: "user", content: "hello" }], systemPrompt: [], tools: [] }, options: effort ? { reasoning: effort } : {} } as OcxParsedRequest);
      expect({ ladder: !!ladder, effort, model: JSON.parse(request.body).model }).toEqual({ ladder: !!ladder, effort, model: wire });
      expect(request.headers["User-Agent"]).toBe(ANTIGRAVITY_CLI_REQUEST_UA);
    }
  }
});

test("a family restored from the persisted snapshot routes max and ultra to xhigh", () => {
  const previousHome = process.env.OPENCODEX_HOME;
  const home = mkdtempSync(join(tmpdir(), "ocx-hydrogen-restore-"));
  process.env.OPENCODEX_HOME = home;
  const dest = "https://hydrogen-restore.example.test";
  const tiers = { low: "gemini-4-hydrogen-low", medium: "gemini-4-hydrogen-medium", high: "gemini-4-hydrogen-high" };
  try {
    writeAntigravityWireSnapshot(dest, { version: 1, provider: "google-antigravity", families: { "gemini-4-hydrogen": { ...tiers, xhigh: "gemini-4-hydrogen-xhigh" } } });
    for (const effort of ["xhigh", "max", "ultra"]) {
      expect(resolveAntigravityEffortWireModel("gemini-4-hydrogen", effort, dest).wireModelId).toBe("gemini-4-hydrogen-xhigh");
    }
    expect(resolveAntigravityEffortWireModel("gemini-4-hydrogen", undefined, dest).wireModelId).toBe("gemini-4-hydrogen-high");
    const threeTier = "https://argon-restore.example.test";
    writeAntigravityWireSnapshot(threeTier, { version: 1, provider: "google-antigravity", families: { "gemini-4-carbon": {
      low: "gemini-4-carbon-low", medium: "gemini-4-carbon-medium", high: "gemini-4-carbon-high" } } });
    for (const effort of ["xhigh", "max", "ultra"]) {
      expect(resolveAntigravityEffortWireModel("gemini-4-carbon", effort, threeTier).wireModelId).toBe("gemini-4-carbon-high");
    }
  } finally {
    if (previousHome === undefined) delete process.env.OPENCODEX_HOME; else process.env.OPENCODEX_HOME = previousHome;
    removeTreeWithRetry(home);
  }
});

test("catalog publication uses the discovered Hydrogen default", async () => {
  const ids = ["low", "medium", "high", "xhigh"].map(t => `gemini-4-hydrogen-${t}`);
  const previousHome = process.env.OPENCODEX_HOME;
  const home = mkdtempSync(join(tmpdir(), "ocx-hydrogen-"));
  process.env.OPENCODEX_HOME = home;
  const fetch = (async () => Response.json({ models: Object.fromEntries(ids.map(id => [id, {}])), agentModelSorts: [{ groups: [{ modelIds: ids }] }] })) as typeof globalThis.fetch;
  try {
    const rows = await fetchProviderModels("hydrogen-catalog-test", { adapter: "google", baseUrl: "https://hydrogen-catalog.example.test", fetch, googleMode: "cloud-code-assist", project: "fixture", apiKey: "fixture", liveModels: true }, 0);
    const row = rows.find(row => row.id === "gemini-4-hydrogen");
    expect(row?.reasoningEfforts).toEqual(["low", "medium", "high", "xhigh"]);
    expect(row?.defaultReasoningEffort).toBe("high");
    expect(rows.some(row => row.id === "gemini-4-hydrogen-xhigh")).toBe(false);
  } finally {
    if (previousHome === undefined) delete process.env.OPENCODEX_HOME; else process.env.OPENCODEX_HOME = previousHome;
    removeTreeWithRetry(home);
  }
});

test("old snapshots load and optional xhigh is validated", () => {
  const previousHome = process.env.OPENCODEX_HOME;
  const home = mkdtempSync(join(tmpdir(), "ocx-hydrogen-snapshot-"));
  process.env.OPENCODEX_HOME = home;
  const dest = "https://snapshot.example.test";
  const old = { version: 1 as const, provider: "fixture", families: { "gemini-4-hydrogen": { low: "gemini-4-hydrogen-low", medium: "gemini-4-hydrogen-medium", high: "gemini-4-hydrogen-high" } } };
  try {
    writeAntigravityWireSnapshot(dest, old);
    expect(readAntigravityWireSnapshot(dest)).toEqual(old);
    const extended = { ...old, families: { "gemini-4-hydrogen": { ...old.families["gemini-4-hydrogen"], xhigh: "gemini-4-hydrogen-xhigh" } } };
    writeAntigravityWireSnapshot(dest, extended);
    expect(readAntigravityWireSnapshot(dest)).toEqual(extended);
    expect(() => writeAntigravityWireSnapshot(dest, { ...extended, families: { "gemini-4-hydrogen": { ...extended.families["gemini-4-hydrogen"], xhigh: "wrong" } } })).toThrow();
  } finally {
    if (previousHome === undefined) delete process.env.OPENCODEX_HOME; else process.env.OPENCODEX_HOME = previousHome;
    removeTreeWithRetry(home);
  }
});

test("an xhigh tier joins the family projection: selection, public collapse and disabled inheritance", () => {
  const provider = "google-antigravity";
  const base = "gemini-4-hydrogen";
  const tiers = ["low", "medium", "high", "xhigh"].map(tier => `${base}-${tier}`);
  const family: AntigravityEffortFamilyRow = { provider, id: base,
    antigravityEffortWireModelIds: { low: tiers[0]!, medium: tiers[1]!, high: tiers[2]!, xhigh: tiers[3]! } };
  expect(antigravityEffortFamilyIds(family)).toEqual(tiers);
  // A mismatched xhigh id is not exact family evidence; a three-tier family is unchanged.
  expect(antigravityEffortFamilyIds({ ...family, antigravityEffortWireModelIds: { ...family.antigravityEffortWireModelIds, xhigh: "other-xhigh" } })).toBeUndefined();
  expect(antigravityEffortFamilyIds({ ...family, antigravityEffortWireModelIds: { low: tiers[0]!, medium: tiers[1]!, high: tiers[2]! } })).toEqual(tiers.slice(0, 3));

  const rows = [family, ...tiers.map(id => ({ provider, id }))];
  expect(projectAntigravitySelectedModels(provider, [tiers[3]!], rows)).toEqual([tiers[3]!, base]);
  expect(collapseAntigravityPublicModels(rows)).toEqual([family]);

  const config: OcxConfig = { providers: { [provider]: {} }, disabledModels: tiers.map(id => `${provider}/${id}`),
    modelDiscovery: { newModelPolicy: "off", knownModels: { [provider]: { ids: [...tiers], removed: [], updatedAt: "2026-11-13T00:00:00Z" } } } } as OcxConfig;
  expect(antigravityFamilyDisabled(config, family, rows)).toBe(true);
  config.disabledModels = tiers.slice(0, 3).map(id => `${provider}/${id}`);
  expect(antigravityFamilyDisabled(config, family, rows)).toBe(false);
});
