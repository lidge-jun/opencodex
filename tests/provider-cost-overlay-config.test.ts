import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  getConfigPath,
  loadConfig,
  providerModelCostsConfigError,
  saveConfig,
} from "../src/config";
import { providerManagementConfigError, safeConfigDTO } from "../src/server/auth-cors";
import { activeUserCostOverlays, refreshUserCostOverlays, userCostOverlayVersion } from "../src/usage/user-cost-overlays";

const VALID_COSTS = {
  "deepseek-v4-flash": { input: 0.14, output: 0.28, cacheRead: 0.0028, cacheWrite: 0 },
  "glm-5.2": { input: 1.4, output: 4.4, cacheRead: 0.26, cacheWrite: 0 },
};

let testDir = "";

beforeEach(() => {
  testDir = mkdtempSync(join(tmpdir(), "ocx-model-costs-"));
  process.env.OPENCODEX_HOME = testDir;
});

afterEach(() => {
  // The overlay registry is module-level; reset it so rows loaded by DTO tests
  // cannot leak into other test files in a shared-process run.
  refreshUserCostOverlays({ providers: {} } as unknown as OcxConfig);
  delete process.env.OPENCODEX_HOME;
  if (testDir && existsSync(testDir)) rmSync(testDir, { recursive: true, force: true });
  testDir = "";
});

describe("providerModelCostsConfigError", () => {
  test("absent and valid modelCosts pass", () => {
    expect(providerModelCostsConfigError(undefined)).toBeNull();
    expect(providerModelCostsConfigError(VALID_COSTS)).toBeNull();
  });

  test("non-object or array value is rejected", () => {
    expect(providerModelCostsConfigError("nope")).toContain("plain object");
    expect(providerModelCostsConfigError([{ input: 1 }])).toContain("plain object");
  });

  test("blank model keys are rejected", () => {
    expect(providerModelCostsConfigError({ "": { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } }))
      .toContain("nonblank");
  });

  test("malformed entries are rejected with a field path", () => {
    expect(providerModelCostsConfigError({ m: "not-an-object" })).toContain("modelCosts.m");
    expect(providerModelCostsConfigError({ m: { input: 1, output: 1, cacheRead: 0 } }))
      .toContain("modelCosts.m.cacheWrite");
    expect(providerModelCostsConfigError({ m: { input: -1, output: 1, cacheRead: 0, cacheWrite: 0 } }))
      .toContain("modelCosts.m.input");
    expect(providerModelCostsConfigError({ m: { input: 1, output: Infinity, cacheRead: 0, cacheWrite: 0 } }))
      .toContain("modelCosts.m.output");
    expect(providerModelCostsConfigError({ m: { input: 1, output: 1, cacheRead: 0, cacheWrite: "0" } }))
      .toContain("modelCosts.m.cacheWrite");
  });
});

describe("modelCosts config persistence and registry refresh", () => {
  test("loadConfig preserves modelCosts and refreshes the overlay registry", () => {
    writeFileSync(getConfigPath(), JSON.stringify({
      port: 12345,
      providers: {
        blsc: {
          adapter: "openai-chat",
          baseUrl: "https://llmapi.blsc.cn",
          modelCosts: VALID_COSTS,
        },
      },
    }));
    const versionBefore = userCostOverlayVersion();
    const config = loadConfig();
    expect(config.providers.blsc.modelCosts).toEqual(VALID_COSTS);
    expect(userCostOverlayVersion()).toBe(versionBefore + 1);
    const rows = activeUserCostOverlays();
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      provider: "blsc",
      modelId: "deepseek-v4-flash",
      cost4: VALID_COSTS["deepseek-v4-flash"],
      status: "verified",
    });
    expect(rows[0].source).toBe("config:providers.blsc.modelCosts[deepseek-v4-flash]");
  });

  test("saveConfig round-trips modelCosts and refreshes the registry", () => {
    const config = loadConfig();
    config.providers.blsc = {
      adapter: "openai-chat",
      baseUrl: "https://llmapi.blsc.cn",
      modelCosts: VALID_COSTS,
    };
    saveConfig(config);
    const onDisk = JSON.parse(readFileSync(getConfigPath(), "utf-8"));
    expect(onDisk.providers.blsc.modelCosts).toEqual(VALID_COSTS);
    const reloaded = loadConfig();
    expect(reloaded.providers.blsc.modelCosts).toEqual(VALID_COSTS);
    expect(activeUserCostOverlays()).toHaveLength(2);
    // Removing the overlay clears the registry rows.
    delete reloaded.providers.blsc.modelCosts;
    saveConfig(reloaded);
    expect(activeUserCostOverlays()).toHaveLength(0);
  });
});

describe("modelCosts management validation and DTO", () => {
  const providerBase = {
    adapter: "openai-chat",
    baseUrl: "https://llmapi.blsc.cn",
  };

  test("providerManagementConfigError accepts valid modelCosts and rejects malformed ones", () => {
    expect(providerManagementConfigError("blsc", { ...providerBase, modelCosts: VALID_COSTS })).toBeNull();
    const error = providerManagementConfigError("blsc", {
      ...providerBase,
      modelCosts: { "deepseek-v4-flash": { input: -0.5, output: 1, cacheRead: 0, cacheWrite: 0 } },
    });
    expect(error).toContain("blsc");
    expect(error).toContain("modelCosts.deepseek-v4-flash.input");
  });

  test("safeConfigDTO exposes modelCosts for the dashboard", () => {
    writeFileSync(getConfigPath(), JSON.stringify({
      port: 12345,
      providers: { blsc: { ...providerBase, modelCosts: VALID_COSTS } },
    }));
    const dto = safeConfigDTO(loadConfig()) as {
      providers: Record<string, { modelCosts?: unknown }>;
    };
    expect(dto.providers.blsc.modelCosts).toEqual(VALID_COSTS);
  });

  test("safeConfigDTO serializes only the four rate fields of each modelCosts row", () => {
    writeFileSync(getConfigPath(), JSON.stringify({
      port: 12345,
      providers: {
        blsc: {
          ...providerBase,
          modelCosts: {
            "deepseek-v4-flash": {
              input: 0.14,
              output: 0.28,
              cacheRead: 0.0028,
              cacheWrite: 0,
              apiKey: "sekret-value",
            },
          },
        },
      },
    }));
    const dto = safeConfigDTO(loadConfig()) as {
      providers: Record<string, { modelCosts?: Record<string, Record<string, unknown>> }>;
    };
    expect(dto.providers.blsc.modelCosts).toEqual({
      "deepseek-v4-flash": { input: 0.14, output: 0.28, cacheRead: 0.0028, cacheWrite: 0 },
    });
    expect(dto.providers.blsc.modelCosts?.["deepseek-v4-flash"]?.apiKey).toBeUndefined();
  });

  test("safeConfigDTO keeps a __proto__ model id as an own row", () => {
    // JSON text (not an object literal) so "__proto__" is an own row key.
    writeFileSync(getConfigPath(), JSON.stringify({
      port: 12345,
      providers: { blsc: { ...providerBase, modelCosts: JSON.parse('{"__proto__":{"input":0.14,"output":0.28,"cacheRead":0.0028,"cacheWrite":0}}') } },
    }));
    const dto = safeConfigDTO(loadConfig()) as {
      providers: Record<string, { modelCosts?: Record<string, unknown> }>;
    };
    const rows = dto.providers.blsc.modelCosts;
    expect(rows && Object.keys(rows)).toContain("__proto__");
    expect(rows?.["__proto__"]).toEqual({ input: 0.14, output: 0.28, cacheRead: 0.0028, cacheWrite: 0 });
  });
});
