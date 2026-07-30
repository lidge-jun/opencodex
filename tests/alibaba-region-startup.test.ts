import { expect, test } from "bun:test";
import { AlibabaBackupIntegrityError } from "../src/providers/alibaba-region-backup";
import { projectAlibabaRegionMigration } from "../src/providers/alibaba-region-migration";
import { runAlibabaRegionStartupMigration } from "../src/providers/alibaba-region-startup";
import type { OcxConfig } from "../src/types";

const INTL_URL = "https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1";

function migratableConfig(): OcxConfig {
  return {
    port: 10100,
    defaultProvider: "alibaba-token-plan",
    providers: {
      "alibaba-token-plan": { adapter: "openai-chat", apiKey: "sk-intl-key", baseUrl: INTL_URL },
    },
  } as unknown as OcxConfig;
}

function collidingConfig(): OcxConfig {
  const config = migratableConfig();
  config.providers["alibaba-token-plan-intl"] = { adapter: "openai-chat", apiKey: "sk-other" } as never;
  return config;
}

function namespaceCollidingConfig(): OcxConfig {
  return {
    ...migratableConfig(),
    codexAccountNamespaces: { "alibaba-token-plan-intl": "pool-a" },
  };
}

test("backs up strictly before saving, exactly once, when the projection changed", () => {
  const order: string[] = [];
  const saved: OcxConfig[] = [];
  const result = runAlibabaRegionStartupMigration(migratableConfig(), {
    project: projectAlibabaRegionMigration,
    backup: () => { order.push("backup"); },
    save: config => { order.push("save"); saved.push(config); },
  });
  expect(order).toEqual(["backup", "save"]);
  expect(saved).toHaveLength(1);
  expect(saved[0]).toBe(result);
  expect(result.providers["alibaba-token-plan-intl"]).toBeDefined();
});

test("a no-op never backs up or saves, but a collision still warns", () => {
  const order: string[] = [];
  const saved: OcxConfig[] = [];
  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(" ")); };
  try {
    runAlibabaRegionStartupMigration(collidingConfig(), {
      project: projectAlibabaRegionMigration,
      backup: () => { order.push("backup"); },
      save: config => { saved.push(config); },
    });
  } finally {
    console.warn = originalWarn;
  }
  expect(order).toEqual([]);
  expect(saved).toEqual([]);
  expect(warnings).toHaveLength(1);
  expect(warnings[0]).toContain("[alibaba-region-migration]");
});

test("an account namespace collision warns without backing up or saving", () => {
  const order: string[] = [];
  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(" ")); };
  try {
    const config = namespaceCollidingConfig();
    const result = runAlibabaRegionStartupMigration(config, {
      project: projectAlibabaRegionMigration,
      backup: () => { order.push("backup"); },
      save: () => { order.push("save"); },
    });
    expect(result).toBe(config);
  } finally {
    console.warn = originalWarn;
  }
  expect(order).toEqual([]);
  expect(warnings).toHaveLength(1);
  expect(warnings[0]).toContain("reserved by a configured Codex account namespace");
});

test("a backup failure prevents the migration from saving", () => {
  // The fail-closed posture: no rollback point, no credential rewrite. The throw
  // propagates out of startServer, the same stance the OpenAI tier migration takes.
  const saved: OcxConfig[] = [];
  expect(() => runAlibabaRegionStartupMigration(migratableConfig(), {
    project: projectAlibabaRegionMigration,
    backup: () => { throw new AlibabaBackupIntegrityError("disk full"); },
    save: config => { saved.push(config); },
  })).toThrow(AlibabaBackupIntegrityError);
  expect(saved).toEqual([]);
});
