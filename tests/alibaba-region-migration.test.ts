import { expect, test } from "bun:test";
import { mkdtempSync} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, saveConfig } from "../src/config";
import { projectAlibabaRegionMigration } from "../src/providers/alibaba-region-migration";
import { routeModel } from "../src/router";
import type { OcxConfig } from "../src/types";
import { removeTreeWithRetry } from "./helpers/remove-tree";

const INTL_URL = "https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1";

/** A config exhibiting the #457 mismatch: Beijing id, international endpoint. */
function migratableConfig(): OcxConfig {
  return {
    port: 10100,
    defaultProvider: "alibaba-token-plan",
    providers: {
      "alibaba-token-plan": { adapter: "openai-chat", apiKey: "sk-intl-key", baseUrl: INTL_URL },
    },
  } as unknown as OcxConfig;
}

function namespaceCollidingConfig(): OcxConfig {
  return {
    ...migratableConfig(),
    codexAccountNamespaces: { "alibaba-token-plan-intl": "pool-a" },
  };
}

test("moves a Beijing entry holding an international endpoint", () => {
  const config = migratableConfig();
  // Beijing catalog fields, as `ocx provider add` would have persisted them.
  Object.assign(config.providers["alibaba-token-plan"]!, {
    models: ["qwen3.8-max", "qwen3.7-max"],
    defaultModel: "qwen3.8-max",
  });

  const projection = projectAlibabaRegionMigration(config);

  expect(projection.changed).toBe(true);
  expect(projection.config.providers["alibaba-token-plan"]).toBeUndefined();
  const moved = projection.config.providers["alibaba-token-plan-intl"]!;
  expect(moved.apiKey).toBe("sk-intl-key");
  expect(projection.config.defaultProvider).toBe("alibaba-token-plan-intl");
  // The Beijing catalog did not come along: the intl registry contract applies,
  // so a Team-Edition-only model is present and routes.
  expect(moved.models).toContain("kimi-k2.7-code");
  expect(routeModel(projection.config, "alibaba-token-plan-intl/kimi-k2.7-code").provider.baseUrl)
    .toContain("ap-southeast-1");
});

test("the migrated config survives a reload", () => {
  // A stale combo target would fail validation and make loadConfig fall back to
  // defaults — this is the assertion that catches it.
  const config = migratableConfig();
  (config as unknown as Record<string, unknown>).combos = {
    fast: { targets: [{ provider: "alibaba-token-plan", model: "qwen3.7-max" }] },
  };
  const projection = projectAlibabaRegionMigration(config);
  expect(projection.changed).toBe(true);

  const home = mkdtempSync(join(tmpdir(), "ocx-alibaba-"));
  const prev = process.env.OPENCODEX_HOME;
  process.env.OPENCODEX_HOME = home;
  try {
    saveConfig(projection.config);
    const reloaded = loadConfig();
    expect(reloaded.providers["alibaba-token-plan-intl"]?.apiKey).toBe("sk-intl-key");
    expect(reloaded.combos?.fast?.targets[0]?.provider).toBe("alibaba-token-plan-intl");
  } finally {
    if (prev === undefined) delete process.env.OPENCODEX_HOME;
    else process.env.OPENCODEX_HOME = prev;
    removeTreeWithRetry(home);
  }
});

test("a genuine Beijing config is untouched", () => {
  for (const baseUrl of ["https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1", undefined]) {
    const config = {
      port: 10100,
      defaultProvider: "alibaba-token-plan",
      providers: { "alibaba-token-plan": { adapter: "openai-chat", apiKey: "sk-cn", ...(baseUrl ? { baseUrl } : {}) } },
    } as unknown as OcxConfig;
    const before = structuredClone(config);
    const projection = projectAlibabaRegionMigration(config);
    expect(projection.changed).toBe(false);
    expect(projection.warnings).toEqual([]);
    expect(projection.config).toEqual(before);
  }
});

test("refuses to merge when the intl entry exists, and says why", () => {
  const config = migratableConfig();
  config.providers["alibaba-token-plan-intl"] = { adapter: "openai-chat", apiKey: "sk-other" } as never;
  const before = structuredClone(config);

  const projection = projectAlibabaRegionMigration(config);
  expect(projection.changed).toBe(false);
  expect(projection.config).toEqual(before);
  expect(projection.warnings).toHaveLength(1);
  expect(projection.warnings[0]).toContain("already exists");
});

test("refuses to replace an account namespace with the intl provider", () => {
  const config = namespaceCollidingConfig();
  const before = structuredClone(config);

  const projection = projectAlibabaRegionMigration(config);
  expect(projection.changed).toBe(false);
  expect(projection.config).toEqual(before);
  expect(projection.warnings).toHaveLength(1);
  expect(projection.warnings[0]).toContain("reserved by a configured Codex account namespace");
  expect(projection.warnings[0]).toContain("Rename the account selector");
});

test("refuses a mixed-case account namespace that owns the intl provider id", () => {
  const config = migratableConfig();
  config.codexAccountNamespaces = { "ALIBABA-TOKEN-PLAN-INTL": "pool-a" };
  const before = structuredClone(config);

  const projection = projectAlibabaRegionMigration(config);

  expect(projection.changed).toBe(false);
  expect(projection.config).toEqual(before);
  expect(projection.warnings).toHaveLength(1);
  expect(projection.warnings[0]).toContain("reserved by a configured Codex account namespace");
});

test("a namespace-blocked migration remains valid across reload", () => {
  const projection = projectAlibabaRegionMigration(namespaceCollidingConfig());
  expect(projection.changed).toBe(false);

  const home = mkdtempSync(join(tmpdir(), "ocx-alibaba-namespace-"));
  const prev = process.env.OPENCODEX_HOME;
  process.env.OPENCODEX_HOME = home;
  try {
    saveConfig(projection.config);
    const reloaded = loadConfig();
    expect(reloaded.providers["alibaba-token-plan"]).toBeDefined();
    expect(reloaded.providers["alibaba-token-plan-intl"]).toBeUndefined();
    expect(reloaded.codexAccountNamespaces).toEqual({ "alibaba-token-plan-intl": "pool-a" });
  } finally {
    if (prev === undefined) delete process.env.OPENCODEX_HOME;
    else process.env.OPENCODEX_HOME = prev;
    removeTreeWithRetry(home);
  }
});

test("aborts without changing anything when a destination key is occupied", () => {
  const config = migratableConfig();
  config.providerContextCaps = { "alibaba-token-plan": 500_000, "alibaba-token-plan-intl": 900_000 };
  const before = structuredClone(config);

  const projection = projectAlibabaRegionMigration(config);
  expect(projection.changed).toBe(false);
  expect(projection.config).toEqual(before);
  expect(projection.warnings[0]).toContain("providerContextCaps.alibaba-token-plan-intl");
});

test("is idempotent across repeated startups", () => {
  const first = projectAlibabaRegionMigration(migratableConfig());
  const second = projectAlibabaRegionMigration(first.config);
  expect(first.changed).toBe(true);
  expect(second.changed).toBe(false);
  expect(second.config).toEqual(first.config);
});

test("carries liveModels, modelCosts, and a user-authored note, but not the Beijing catalog", () => {
  const config = migratableConfig();
  const costs = { "kimi-k3": { input: 1.4, output: 4.4, cacheRead: 0.26, cacheWrite: 0 } };
  Object.assign(config.providers["alibaba-token-plan"]!, { liveModels: true, note: "my own note", modelCosts: costs });

  const moved = projectAlibabaRegionMigration(config).config.providers["alibaba-token-plan-intl"]!;
  expect(moved.liveModels).toBe(true);
  expect(moved.modelCosts).toEqual(costs);
  expect(moved.note).toBe("my own note");
  expect(moved.models).toContain("kimi-k2.7-code");
});
