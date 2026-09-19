import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getConfigPath, loadConfig, saveConfig } from "../../src/config";
import { migrateStartupVolcengineCodingPlanResponses } from "../../src/server/volcengine-coding-plan-responses-startup";
import type { OcxConfig } from "../../src/types";
import { removeTreeWithRetry } from "../helpers/remove-tree";

let testDir = "";

beforeEach(() => {
  testDir = mkdtempSync(join(tmpdir(), "ocx-volcengine-coding-plan-migration-"));
  process.env.OPENCODEX_HOME = testDir;
});

afterEach(() => {
  delete process.env.OPENCODEX_HOME;
  if (testDir && existsSync(testDir)) removeTreeWithRetry(testDir);
  testDir = "";
});

describe("Volcengine Coding Plan startup Responses migration", () => {
  test("persists the canonical Chat preset upgrade once", () => {
    const legacy: OcxConfig = {
      port: 10100,
      defaultProvider: "volcengine-coding-plan",
      providers: {
        "volcengine-coding-plan": {
          adapter: "openai-chat",
          baseUrl: "https://ark.cn-beijing.volces.com/api/coding/v3",
          authMode: "key",
          apiKey: "test-key",
          defaultModel: "glm-5.3",
        },
      },
    };
    saveConfig(legacy);

    const loaded = loadConfig();
    expect(loaded.providers["volcengine-coding-plan"]).toMatchObject({
      adapter: "openai-chat",
      baseUrl: "https://ark.cn-beijing.volces.com/api/coding/v3",
    });
    const upgraded = migrateStartupVolcengineCodingPlanResponses(loaded);
    expect(upgraded.providers["volcengine-coding-plan"]).toMatchObject({
      adapter: "openai-responses",
      baseUrl: "https://ark.cn-beijing.volces.com/api/coding/v3",
      responsesPath: "/responses",
      volcengineCodingPlanResponsesDefaultVersion: 1,
      apiKey: "test-key",
      defaultModel: "glm-5.3",
    });
    expect(loadConfig().providers["volcengine-coding-plan"]).toEqual(
      upgraded.providers["volcengine-coding-plan"],
    );

    const persisted = readFileSync(getConfigPath(), "utf8");
    const reloaded = loadConfig();
    expect(migrateStartupVolcengineCodingPlanResponses(reloaded)).toBe(reloaded);
    expect(readFileSync(getConfigPath(), "utf8")).toBe(persisted);
  });
});
