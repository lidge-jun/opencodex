import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  getConfigPath,
  loadConfig,
  providerModelCostsConfigError,
  saveConfig,
  validateConfigCandidate,
} from "../src/config";
import { providerManagementConfigError, safeConfigDTO } from "../src/server/auth-cors";
import { activeUserCostOverlays, refreshUserCostOverlays, userCostOverlayVersion } from "../src/usage/user-cost-overlays";
import type { OcxConfig } from "../src/types";

const VALID_COSTS = {
  "deepseek-v4-flash": { input: 0.14, output: 0.28, cacheRead: 0.0028, cacheWrite: 0 },
  "glm-5.2": { input: 1.4, output: 4.4, cacheRead: 0.26, cacheWrite: 0 },
};

let testDir = "";
let previousHome: string | undefined;

beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  testDir = mkdtempSync(join(tmpdir(), "ocx-model-costs-"));
  process.env.OPENCODEX_HOME = testDir;
});

afterEach(() => {
  // The overlay registry is module-level; reset it so rows loaded by DTO tests
  // cannot leak into other test files in a shared-process run.
  refreshUserCostOverlays({ providers: {} } as unknown as OcxConfig);
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
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
    expect(providerModelCostsConfigError({ m: "not-an-object" })).toContain('modelCosts."m"');
    expect(providerModelCostsConfigError({ m: { input: 1, output: 1, cacheRead: 0 } }))
      .toContain('modelCosts."m".cacheWrite');
    expect(providerModelCostsConfigError({ m: { input: -1, output: 1, cacheRead: 0, cacheWrite: 0 } }))
      .toContain('modelCosts."m".input');
    expect(providerModelCostsConfigError({ m: { input: 1, output: Infinity, cacheRead: 0, cacheWrite: 0 } }))
      .toContain('modelCosts."m".output');
    expect(providerModelCostsConfigError({ m: { input: 1, output: 1, cacheRead: 0, cacheWrite: "0" } }))
      .toContain('modelCosts."m".cacheWrite');
  });

  test("rates above the safe bound are rejected", () => {
    const error = providerModelCostsConfigError({
      m: { input: 1e308, output: 1, cacheRead: 0, cacheWrite: 0 },
    });
    expect(error).toContain('modelCosts."m".input');
    expect(error).toContain("at most 1000000");
    // The boundary itself is accepted.
    expect(providerModelCostsConfigError({
      m: { input: 1_000_000, output: 1, cacheRead: 0, cacheWrite: 0 },
    })).toBeNull();
  });

  test("modelCosts validation errors redact secret-shaped model ids", () => {
    const error = providerModelCostsConfigError({
      "sk-abcdef1234567890": { input: 1, output: 1, cacheRead: 0, cacheWrite: "0" },
    });
    expect(error).not.toContain("sk-abcdef1234567890");
    expect(error).toContain("[REDACTED]");
  });

  test("modelCosts rows with extra fields are rejected by the validator", () => {
    const error = providerModelCostsConfigError({
      m: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0, apiKey: "sk-leak" },
    });
    expect(error).toContain('modelCosts."m"');
    expect(error).toContain("unexpected fields");
    expect(error).toContain("apiKey");
    expect(error).not.toContain("sk-leak");
    expect(providerModelCostsConfigError(VALID_COSTS)).toBeNull();
  });

  test("loadConfig drops modelCosts rows with extra fields instead of persisting them", () => {
    writeFileSync(getConfigPath(), JSON.stringify({
      port: 12345,
      providers: {
        blsc: {
          adapter: "openai-chat",
          baseUrl: "https://llmapi.blsc.cn",
          modelCosts: {
            "deepseek-v4-flash": { input: 0.14, output: 0.28, cacheRead: 0.0028, cacheWrite: 0 },
            "glm-5.2": { input: 1.4, output: 4.4, cacheRead: 0.26, cacheWrite: 0, apiKey: "sk-leak" },
          },
        },
      },
    }));
    const config = loadConfig();
    expect(config.providers.blsc.modelCosts).toEqual({
      "deepseek-v4-flash": { input: 0.14, output: 0.28, cacheRead: 0.0028, cacheWrite: 0 },
    });
    expect(activeUserCostOverlays()).toHaveLength(1);
  });

  test("validateConfigCandidate redacts a token-shaped provider name in modelCosts schema errors", () => {
    const result = validateConfigCandidate({
      port: 12345,
      providers: {
        "sk-abcdef1234567890": {
          adapter: "openai-chat",
          baseUrl: "https://example.test/v1",
          modelCosts: { m: { input: -1, output: 1, cacheRead: 0, cacheWrite: 0 } },
        },
      },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).not.toContain("sk-abcdef1234567890");
      expect(result.error).toContain("[REDACTED]");
      expect(result.error).toContain("modelCosts");
    }
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

  test("an unchanged save still refreshes the overlay registry (cooperating CLI write)", () => {
    // Simulate a cooperating CLI process that wrote the overlay to disk without
    // this process ever seeing it (the ocx login key-provider notify scenario):
    // the bytes match, so persistConfigUnlocked's early-return path must still
    // refresh the registry, otherwise Logs/Usage keep catalog prices.
    const bytes = JSON.stringify({
      port: 12345,
      providers: {
        blsc: {
          adapter: "openai-chat",
          baseUrl: "https://llmapi.blsc.cn",
          modelCosts: VALID_COSTS,
        },
      },
    }, null, 2) + "\n";
    writeFileSync(getConfigPath(), bytes);
    refreshUserCostOverlays({ providers: {} } as unknown as OcxConfig);
    expect(activeUserCostOverlays()).toHaveLength(0);

    const config = JSON.parse(readFileSync(getConfigPath(), "utf8")) as OcxConfig;
    const versionBefore = userCostOverlayVersion();
    saveConfig(config);
    expect(activeUserCostOverlays()).toHaveLength(2);
    expect(userCostOverlayVersion()).toBeGreaterThan(versionBefore);
  });

  test("reloading an unchanged config does not bump the overlay version", () => {
    const config = {
      port: 12345,
      providers: {
        blsc: {
          adapter: "openai-chat",
          baseUrl: "https://llmapi.blsc.cn",
          modelCosts: VALID_COSTS,
        },
      },
    };
    writeFileSync(getConfigPath(), JSON.stringify(config));
    loadConfig();
    const versionAfterFirstLoad = userCostOverlayVersion();
    // Same bytes on disk: the load-time refresh must be a no-op for the version.
    writeFileSync(getConfigPath(), JSON.stringify(config));
    loadConfig();
    expect(userCostOverlayVersion()).toBe(versionAfterFirstLoad);
    expect(activeUserCostOverlays()).toHaveLength(2);
  });

  test("loadConfig degrades a malformed modelCosts row instead of falling back to defaults", () => {
    writeFileSync(getConfigPath(), JSON.stringify({
      port: 12345,
      defaultProvider: "blsc",
      providers: {
        blsc: {
          adapter: "openai-chat",
          baseUrl: "https://llmapi.blsc.cn",
          modelCosts: {
            "deepseek-v4-flash": VALID_COSTS["deepseek-v4-flash"],
            "broken-model": { input: "0.14", output: 0.28, cacheRead: 0, cacheWrite: 0 },
          },
        },
      },
    }));

    const config = loadConfig();
    // The provider and the valid row survive; only the malformed row is dropped.
    expect(config.providers.blsc).toBeDefined();
    expect(config.providers.blsc.modelCosts).toEqual({
      "deepseek-v4-flash": VALID_COSTS["deepseek-v4-flash"],
    });
    const rows = activeUserCostOverlays().map(row => row.modelId);
    expect(rows).toContain("deepseek-v4-flash");
    expect(rows).not.toContain("broken-model");
  });

  test("loadConfig drops a non-object modelCosts field without failing the parse", () => {
    writeFileSync(getConfigPath(), JSON.stringify({
      port: 12345,
      defaultProvider: "blsc",
      providers: {
        blsc: {
          adapter: "openai-chat",
          baseUrl: "https://llmapi.blsc.cn",
          modelCosts: "oops",
        },
      },
    }));

    const config = loadConfig();
    expect(config.providers.blsc).toBeDefined();
    expect(config.providers.blsc.modelCosts).toBeUndefined();
    expect(activeUserCostOverlays()).toHaveLength(0);
  });

  test("overlay registry keeps only the four rate fields of a modelCosts row", () => {
    refreshUserCostOverlays({
      providers: {
        blsc: {
          modelCosts: {
            "deepseek-v4-flash": {
              ...VALID_COSTS["deepseek-v4-flash"],
              apiKey: "sekret-value",
            },
          },
        },
      },
    } as unknown as OcxConfig);

    const rows = activeUserCostOverlays();
    expect(rows).toHaveLength(1);
    expect(rows[0].cost4).toEqual(VALID_COSTS["deepseek-v4-flash"]);
    expect(Object.keys(rows[0].cost4).sort()).toEqual(["cacheRead", "cacheWrite", "input", "output"]);
  });

  test("overlay registry skips rows whose rates exceed the safe bound", () => {
    refreshUserCostOverlays({
      providers: {
        blsc: {
          modelCosts: {
            "overflow-model": { input: 1e308, output: 1, cacheRead: 0, cacheWrite: 0 },
            "deepseek-v4-flash": VALID_COSTS["deepseek-v4-flash"],
          },
        },
      },
    } as unknown as OcxConfig);
    const rows = activeUserCostOverlays().map(row => row.modelId);
    expect(rows).toContain("deepseek-v4-flash");
    expect(rows).not.toContain("overflow-model");
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
    expect(error).toContain('modelCosts."deepseek-v4-flash".input');
  });

  test("providerManagementConfigError redacts a token-shaped provider name in modelCosts errors", () => {
    const error = providerManagementConfigError("sk-abcdef1234567890", {
      ...providerBase,
      modelCosts: { m: { input: -1, output: 1, cacheRead: 0, cacheWrite: 0 } },
    });
    expect(error).not.toContain("sk-abcdef1234567890");
    expect(error).toContain("[REDACTED]");
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

  test("a nested secret under a malformed modelCosts row never reaches the dashboard DTO", () => {
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
    // The malformed row (extra apiKey field) is rejected at load, so the DTO
    // carries no overlay for it and the nested secret never serializes.
    expect(dto.providers.blsc.modelCosts).toBeUndefined();
    expect(JSON.stringify(dto)).not.toContain("sekret-value");
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

  test("safeConfigDTO drops secret-shaped model ids from modelCosts", () => {
    writeFileSync(getConfigPath(), JSON.stringify({
      port: 12345,
      providers: {
        blsc: {
          ...providerBase,
          modelCosts: {
            "deepseek-v4-flash": VALID_COSTS["deepseek-v4-flash"],
            "sk-abcdef1234567890": VALID_COSTS["deepseek-v4-flash"],
          },
        },
      },
    }));
    const dto = safeConfigDTO(loadConfig()) as {
      providers: Record<string, { modelCosts?: Record<string, unknown> }>;
    };
    const keys = Object.keys(dto.providers.blsc.modelCosts ?? {});
    expect(keys).toContain("deepseek-v4-flash");
    expect(keys).not.toContain("sk-abcdef1234567890");
    // Dropped entirely — distinct secret-shaped rows must not collapse into a
    // single placeholder key in the dashboard DTO.
    expect(keys).not.toContain("[REDACTED]");
  });

  test("safeConfigDTO drops modelCosts rows whose rates exceed the safe bound", () => {
    // In-memory config, bypassing loadConfig: the DTO gate itself (validRate)
    // must drop the out-of-bound row — load-time sanitization would remove it
    // before safeConfigDTO ever sees it.
    const config = {
      port: 12345,
      providers: {
        blsc: {
          ...providerBase,
          modelCosts: {
            "deepseek-v4-flash": VALID_COSTS["deepseek-v4-flash"],
            "overflow-model": { input: 1e308, output: 1, cacheRead: 0, cacheWrite: 0 },
          },
        },
      },
    } as unknown as OcxConfig;
    const dto = safeConfigDTO(config) as {
      providers: Record<string, { modelCosts?: Record<string, unknown> }>;
    };
    const keys = Object.keys(dto.providers.blsc.modelCosts ?? {});
    expect(keys).toContain("deepseek-v4-flash");
    expect(keys).not.toContain("overflow-model");
  });
});
