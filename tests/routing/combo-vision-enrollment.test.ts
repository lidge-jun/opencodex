import { ManagementRequest as Request } from "../helpers/management-auth";
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { comboImagesSupported, comboVisionSidecarTargets } from "../../gui/src/combo-capabilities";
import type { ModelOption } from "../../gui/src/components/combo-workspace-types";
import { ConfigWritePublishedError } from "../../src/config/persist-unlocked";
import { getConfigPath, saveConfig } from "../../src/config";
import { handleManagementAPI } from "../../src/server/management-api";
import type { OcxConfig } from "../../src/types";
import { isModelVisionSidecarConsumer } from "../../src/vision/eligibility";
import { MODEL_DISCOVERY_MAX_MODELS } from "../../src/providers/model-discovery-limits";
import { catalogConvergenceFactory } from "../helpers/catalog-convergence";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const VALID_COMBO = { targets: [{ provider: "a", model: "m1" }] };
function baseConfig(overrides: Partial<OcxConfig> = {}): OcxConfig {
  return {
    port: 10100,
    defaultProvider: "a",
    providers: {
      a: { adapter: "openai-chat", baseUrl: "https://a.example/v1", apiKey: "ka", models: ["m1"], liveModels: false },
      b: { adapter: "openai-chat", baseUrl: "https://b.example/v1", apiKey: "kb", models: ["m2"], liveModels: false },
      c: { adapter: "openai-chat", baseUrl: "https://c.example/v1", apiKey: "kc", models: ["m3"], liveModels: false },
    },
    combos: {
      free: {
        strategy: "failover",
        targets: [
          { provider: "a", model: "m1" },
          { provider: "b", model: "m2" },
        ],
      },
    },
    ...overrides,
  };
}

async function withTempHome(run: (dir: string) => Promise<void>): Promise<void> {
  const previous = { ...process.env };
  const dir = mkdtempSync(join(tmpdir(), "ocx-combo-sidecar-"));
  process.env.OPENCODEX_HOME = dir;
  process.env.CODEX_HOME = join(dir, "codex");
  process.env.CLAUDE_CONFIG_DIR = join(dir, "claude");
  try { await run(dir); }
  finally {
    for (const key of ["OPENCODEX_HOME", "CODEX_HOME", "CLAUDE_CONFIG_DIR"] as const) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
    removeTreeWithRetry(dir);
  }
}

async function comboApi(
  config: OcxConfig,
  method: string,
  path: string,
  body?: unknown,
  refreshCodexCatalog: () => Promise<void> = async () => {},
): Promise<Response | null> {
  const req = new Request(`http://localhost${path}`, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return handleManagementAPI(req, new URL(req.url), config, {
    createManagementConvergeCodex: catalogConvergenceFactory(refreshCodexCatalog),
  });
}

async function responseJson(response: Response | null): Promise<Record<string, unknown>> {
  expect(response).not.toBeNull();
  return response!.json() as Promise<Record<string, unknown>>;
}

describe("combo Vision Sidecar enrollment", () => {
  test("PUT visionSidecarTargets declares exact members text-only and never persists the request field", async () => {
    await withTempHome(async () => {
      const base = baseConfig();
      const config = baseConfig({
        providers: {
          ...base.providers,
          b: {
            ...base.providers.b!,
            modelCapabilities: { m2: { contextTier: "long_context" } },
          },
        },
        combos: undefined,
      });
      saveConfig(config);
      const response = await comboApi(config, "PUT", "/api/combos", {
        id: "mixed",
        visionSidecarTargets: [
          { provider: "b", model: "m2" },
          { provider: "b", model: "m2" }, // exact duplicates are deduplicated
        ],
        combo: {
          targets: [
            { provider: "a", model: "m1" },
            { provider: "b", model: "m2" },
          ],
        },
      });
      expect(response?.status).toBe(200);
      // Exact text-only declaration added; the sibling capability axis survives.
      expect(config.providers?.b?.modelCapabilities).toEqual({
        m2: { contextTier: "long_context", inputModalities: ["text"] },
      });
      // Untouched member provider gains no declaration.
      expect(config.providers?.a?.modelCapabilities).toBeUndefined();
      // Request-only field never leaks into the persisted combo.
      expect(config.combos?.mixed).not.toHaveProperty("visionSidecarTargets");
    });
  });
  test("PUT rejects invalid visionSidecarTargets without mutating config", async () => {
    await withTempHome(async () => {
      const config = baseConfig({ combos: undefined });
      saveConfig(config);
      const before = readFileSync(getConfigPath(), "utf8");
      const bodies: unknown[] = [
        { id: "x", visionSidecarTargets: "nope", combo: VALID_COMBO },
        { id: "x", visionSidecarTargets: [{ provider: "a" }], combo: VALID_COMBO },
        // Not a target of the submitted combo.
        { id: "x", visionSidecarTargets: [{ provider: "c", model: "m3" }], combo: VALID_COMBO },
        // Enrollment only makes sense while images are accepted.
        {
          id: "x",
          visionSidecarTargets: [{ provider: "a", model: "m1" }],
          combo: { targets: [{ provider: "a", model: "m1" }], imageInput: "disabled" },
        },
      ];
      for (const body of bodies) {
        const response = await comboApi(config, "PUT", "/api/combos", body);
        expect(response?.status).toBe(400);
      }
      expect(readFileSync(getConfigPath(), "utf8")).toBe(before);
      expect(config.providers?.a?.modelCapabilities).toBeUndefined();
    });
  });
  test("PUT rejects enrollment that would push a provider's modelCapabilities past its limit", async () => {
    await withTempHome(async () => {
      const base = baseConfig();
      // A provider already at the cap: the patch alone is valid, the merged map is not.
      const full = Object.fromEntries(
        Array.from({ length: MODEL_DISCOVERY_MAX_MODELS }, (_, i) => [`filler-${i}`, { contextTier: "long_context" as const }]),
      );
      const config = baseConfig({
        providers: { ...base.providers, b: { ...base.providers.b!, modelCapabilities: full } },
        combos: undefined,
      });
      saveConfig(config);
      const before = readFileSync(getConfigPath(), "utf8");
      const response = await comboApi(config, "PUT", "/api/combos", {
        id: "mixed",
        visionSidecarTargets: [{ provider: "b", model: "m2" }],
        combo: { targets: [{ provider: "a", model: "m1" }, { provider: "b", model: "m2" }] },
      });
      expect(response?.status).toBe(400);
      expect(String((await responseJson(response)).error)).toContain("too many models");
      // Nothing is published: neither the combo nor a truncation-bound declaration.
      expect(readFileSync(getConfigPath(), "utf8")).toBe(before);
      expect(Object.keys(config.providers?.b?.modelCapabilities ?? {})).toHaveLength(MODEL_DISCOVERY_MAX_MODELS);
      expect(config.combos?.mixed).toBeUndefined();
    });
  });
  test("PUT rejects already-image-capable and audio-only sidecar targets instead of overwriting", async () => {
    await withTempHome(async () => {
      const cases: Array<{ name: string; config: OcxConfig }> = [
        {
          name: "capability axis already declares image",
          config: baseConfig({
            providers: {
              ...baseConfig().providers,
              b: { ...baseConfig().providers.b!, modelCapabilities: { m2: { inputModalities: ["text", "image"] } } },
            },
            combos: undefined,
          }),
        },
        {
          name: "capability axis declares audio only",
          config: baseConfig({
            providers: {
              ...baseConfig().providers,
              b: { ...baseConfig().providers.b!, modelCapabilities: { m2: { inputModalities: ["audio"] } } },
            },
            combos: undefined,
          }),
        },
        {
          name: "unrelated capability axis must not hide custom audio declaration",
          config: baseConfig({
            providers: {
              ...baseConfig().providers,
              b: { ...baseConfig().providers.b!, modelCapabilities: { m2: { contextTier: "long_context" } } },
            },
            customModels: [{ id: "custom-b-m2", provider: "b", modelId: "m2", inputModalities: ["audio"] }],
            combos: undefined,
          }),
        },
        {
          name: "custom row declares audio only",
          config: baseConfig({
            customModels: [{ id: "custom-b-m2", provider: "b", modelId: "m2", inputModalities: ["audio"] }],
            combos: undefined,
          }),
        },
        {
          name: "provider modality hint declares audio only",
          config: baseConfig({
            providers: {
              ...baseConfig().providers,
              b: { ...baseConfig().providers.b!, modelInputModalities: { m2: ["audio"] } },
            },
            combos: undefined,
          }),
        },
      ];
      for (const { config } of cases) {
        saveConfig(config);
        const before = readFileSync(getConfigPath(), "utf8");
        const response = await comboApi(config, "PUT", "/api/combos", {
          id: "mixed",
          visionSidecarTargets: [{ provider: "b", model: "m2" }],
          combo: {
            targets: [
              { provider: "a", model: "m1" },
              { provider: "b", model: "m2" },
            ],
          },
        });
        expect(response?.status).toBe(400);
        expect(config.combos).toBeUndefined();
        expect(readFileSync(getConfigPath(), "utf8")).toBe(before);
      }
    });
  });
  test("PUT treats an already-covered member as a no-op write", async () => {
    await withTempHome(async () => {
      const exactTextOnly = baseConfig({
        providers: {
          ...baseConfig().providers,
          b: { ...baseConfig().providers.b!, modelCapabilities: { m2: { inputModalities: ["text"] } } },
        },
        combos: undefined,
      });
      saveConfig(exactTextOnly);
      const viaCapability = await comboApi(exactTextOnly, "PUT", "/api/combos", {
        id: "mixed",
        visionSidecarTargets: [{ provider: "b", model: "m2" }],
        combo: { targets: [{ provider: "b", model: "m2" }] },
      });
      expect(viaCapability?.status).toBe(200);
      // The operator's declaration is preserved verbatim, never rewritten.
      expect(exactTextOnly.providers?.b?.modelCapabilities).toEqual({ m2: { inputModalities: ["text"] } });
      expect(isModelVisionSidecarConsumer(exactTextOnly.providers!.b!, "m2")).toBe(true);

      const viaNoVision = baseConfig({
        providers: {
          ...baseConfig().providers,
          b: { ...baseConfig().providers.b!, noVisionModels: ["m2"] },
        },
        combos: undefined,
      });
      saveConfig(viaNoVision);
      const response = await comboApi(viaNoVision, "PUT", "/api/combos", {
        id: "mixed",
        visionSidecarTargets: [{ provider: "b", model: "m2" }],
        combo: { targets: [{ provider: "b", model: "m2" }] },
      });
      expect(response?.status).toBe(200);
      expect(viaNoVision.providers?.b?.modelCapabilities).toBeUndefined();
      expect(isModelVisionSidecarConsumer(viaNoVision.providers!.b!, "m2")).toBe(true);
    });
  });
  test("PUT enrolls the member so the runtime treats it as a sidecar consumer", async () => {
    await withTempHome(async () => {
      const config = baseConfig({ combos: undefined });
      saveConfig(config);
      const response = await comboApi(config, "PUT", "/api/combos", {
        id: "mixed",
        visionSidecarTargets: [{ provider: "b", model: "m2" }],
        combo: { targets: [{ provider: "b", model: "m2" }] },
      });
      expect(response?.status).toBe(200);
      // The exact declaration the catalog's consumer check reads: text without image.
      expect(isModelVisionSidecarConsumer(config.providers!.b!, "m2")).toBe(true);
      const persisted = JSON.parse(readFileSync(getConfigPath(), "utf8")) as OcxConfig;
      expect(persisted.providers?.b?.modelCapabilities?.m2?.inputModalities).toEqual(["text"]);
    });
  });
  test("PUT rolls back combo, declarations, and migrated references when the save fails", async () => {
    await withTempHome(async () => {
      const config = baseConfig({
        disabledModels: ["combo/old"],
        injectionModel: "combo/old",
        claudeCode: { model: "combo/old", intercept: { modelMap: { upstream: "combo/old" } } },
        combos: {
          old: { strategy: "failover", targets: [{ provider: "a", model: "m1" }, { provider: "b", model: "m2" }] },
        },
        subagentModels: ["combo/old"],
      });
      saveConfig(config);
      const before = readFileSync(getConfigPath(), "utf8");
      const req = new Request("http://localhost/api/combos", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          id: "new",
          renameFrom: "old",
          visionSidecarTargets: [{ provider: "b", model: "m2" }],
          combo: { targets: [{ provider: "a", model: "m1" }, { provider: "b", model: "m2" }] },
        }),
      });
      const response = await handleManagementAPI(req, new URL(req.url), config, {
        createManagementConvergeCodex: catalogConvergenceFactory(),
        saveConfigPreservingClaudeCode: () => { throw new Error("disk full"); },
      });
      expect(response?.status).toBe(500);
      expect(await responseJson(response)).toEqual({ error: "combo could not be saved" });
      // Nothing moved: the combo keeps its old key, references stay unmigrated,
      // and the sidecar declaration was never applied.
      expect(Object.keys(config.combos!)).toEqual(["old"]);
      expect(config.subagentModels).toEqual(["combo/old"]);
      expect(config.disabledModels).toEqual(["combo/old"]);
      expect(config.injectionModel).toBe("combo/old");
      expect(config.claudeCode).toMatchObject({ model: "combo/old", intercept: { modelMap: { upstream: "combo/old" } } });
      expect(config.providers?.b?.modelCapabilities).toBeUndefined();
      expect(readFileSync(getConfigPath(), "utf8")).toBe(before);
    });
  });
  test("PUT rename commits enrollment and every public reference together", async () => {
    await withTempHome(async () => {
      const config = baseConfig({
        combos: { old: VALID_COMBO },
        disabledModels: ["combo/old"],
        subagentModels: ["combo/old"],
        injectionModel: "combo/old",
        claudeCode: { model: "combo/old", intercept: { modelMap: { upstream: "combo/old" } } },
      });
      saveConfig(config);
      const response = await comboApi(config, "PUT", "/api/combos", {
        id: "new", renameFrom: "old",
        visionSidecarTargets: [{ provider: "a", model: "m1" }],
        combo: VALID_COMBO,
      });
      expect(response?.status).toBe(200);
      expect(config.combos?.old).toBeUndefined();
      expect(config.combos?.new).toBeDefined();
      expect(config.providers.a?.modelCapabilities?.m1?.inputModalities).toEqual(["text"]);
      expect(config.disabledModels).toEqual(["combo/new"]);
      expect(config.subagentModels).toEqual(["combo/new"]);
      expect(config.injectionModel).toBe("combo/new");
      expect(config.claudeCode).toMatchObject({ model: "combo/new", intercept: { modelMap: { upstream: "combo/new" } } });
      const persisted = JSON.parse(readFileSync(getConfigPath(), "utf8"));
      expect(persisted.combos.new).toBeDefined();
      expect(persisted.providers.a.modelCapabilities.m1.inputModalities).toEqual(["text"]);
      expect(persisted.disabledModels).toEqual(["combo/new"]);
    });
  });

  test("published save failures retain live enrollment and surface the error", async () => {
    await withTempHome(async () => {
      const config = baseConfig({ combos: undefined });
      saveConfig(config);
      const req = new Request("http://localhost/api/combos", {
        method: "PUT", headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: "mixed", combo: VALID_COMBO,
          visionSidecarTargets: [{ provider: "a", model: "m1" }] }),
      });
      await expect(handleManagementAPI(req, new URL(req.url), config, {
        createManagementConvergeCodex: catalogConvergenceFactory(),
        saveConfigPreservingClaudeCode: (value) => {
          saveConfig(value);
          throw new ConfigWritePublishedError(new Error("bookkeeping failed"));
        },
      })).rejects.toBeInstanceOf(ConfigWritePublishedError);
      const persisted = JSON.parse(readFileSync(getConfigPath(), "utf8"));
      expect(config.combos?.mixed).toEqual(persisted.combos.mixed);
      expect(config.providers.a?.modelCapabilities).toEqual(persisted.providers.a.modelCapabilities);
    });
  });

  test("GET models flags a legacy noVisionModels member as the sidecar consumer the runtime sees", async () => {
    await withTempHome(async () => {
    const config = baseConfig();
    for (const provider of Object.values(config.providers)) provider.liveModels = false;
    config.providers.a!.noVisionModels = ["m1"];

    const response = await comboApi(config, "GET", "/api/models");
    expect(response?.status).toBe(200);
    const rows = await response!.json() as Array<{
      provider: string;
      id: string;
      inputModalities?: string[];
      inputModalitiesDeclared?: string[];
      visionSidecarConsumer?: boolean;
    }>;
    const row = rows.find(r => r.provider === "a" && r.id === "m1");
    // Legacy `noVisionModels` carries no declaration while the catalog widens the
    // row to image: only the flag keeps the GUI from calling this native vision.
    expect(row).toMatchObject({ visionSidecarConsumer: true });
    expect(row!.inputModalitiesDeclared).toBeUndefined();
    expect(row!.inputModalities).toContain("image");

    // The Combos page parses exactly these whitelisted fields off the row.
    const models: ModelOption[] = rows
      .filter(r => r.provider !== "combo")
      .map(r => ({
        provider: r.provider,
        id: r.id,
        ...(r.inputModalities?.length ? { inputModalities: r.inputModalities } : {}),
        ...(r.inputModalitiesDeclared?.length ? { inputModalitiesDeclared: r.inputModalitiesDeclared } : {}),
        ...(r.visionSidecarConsumer === true ? { visionSidecarConsumer: true } : {}),
      }));
    expect(comboImagesSupported([{ provider: "a", model: "m1" }], models)).toBe(true);
    expect(comboVisionSidecarTargets([{ provider: "a", model: "m1" }], models))
      .toEqual([{ provider: "a", model: "m1" }]);
    });
  });
  test("GET models flags registry-seeded noVisionModels rows as sidecar consumers", async () => {
    await withTempHome(async () => {
    const config = baseConfig({
      providers: {
        ...baseConfig().providers,
        umans: {
          adapter: "anthropic",
          baseUrl: "https://api.code.umans.ai",
          models: ["umans-glm-5.2"],
          liveModels: false,
        },
      },
    });
    for (const provider of Object.values(config.providers)) provider.liveModels = false;

    const response = await comboApi(config, "GET", "/api/models");
    expect(response?.status).toBe(200);
    const rows = await response!.json() as Array<{
      provider: string;
      id: string;
      inputModalities?: string[];
      inputModalitiesDeclared?: string[];
      visionSidecarConsumer?: boolean;
    }>;
    const row = rows.find(r => r.provider === "umans" && r.id === "umans-glm-5.2");
    // Registry enrichment classifies the row at read time and also seeds its
    // declaration, but the flag stays the authoritative verdict for the GUI.
    expect(row).toMatchObject({ visionSidecarConsumer: true });
    expect(row!.inputModalitiesDeclared).toEqual(["text"]);
    expect(row!.inputModalities).toContain("image");

    const models: ModelOption[] = rows
      .filter(r => r.provider !== "combo")
      .map(r => ({
        provider: r.provider,
        id: r.id,
        ...(r.inputModalities?.length ? { inputModalities: r.inputModalities } : {}),
        ...(r.inputModalitiesDeclared?.length ? { inputModalitiesDeclared: r.inputModalitiesDeclared } : {}),
        ...(r.visionSidecarConsumer === true ? { visionSidecarConsumer: true } : {}),
      }));
    expect(comboImagesSupported([{ provider: "umans", model: "umans-glm-5.2" }], models)).toBe(true);
    expect(comboVisionSidecarTargets([{ provider: "umans", model: "umans-glm-5.2" }], models))
      .toEqual([{ provider: "umans", model: "umans-glm-5.2" }]);
    });
  });
});
