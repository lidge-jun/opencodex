import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { codexConfigDrift } from "../../src/codex/config-drift-heal";
import { ALL_LATER_EDITS_KEPT, NO_OPENCODEX_ROUTING, makeRestoreHomes, runRestoreChild } from "../helpers/codex-restore-child";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { SPAWN_BUDGET_MS } from "../helpers/test-budget";

/**
 * The Codex app rewrites config.toml from its own model and can drop or overwrite the keys
 * OpenCodex injected. OpenCodex re-asserts only its own keys, never adopts its own earlier
 * values as the user's, and a later restore never replays stale content.
 */
describe("Codex app rewrites of injected routing keys", () => {
  let root: string;
  beforeEach(() => { root = makeRestoreHomes("ocx-app-rewrite-"); });
  afterEach(() => removeTreeWithRetry(root));

  test("an app rewrite back to an earlier injection's values is re-pointed, never journaled as the user's", () => {
    const { report } = runRestoreChild(root, "app-stale-values");
    expect(report.syncedUrl).toBe("http://127.0.0.1:10200/v1");
    expect(report.snapshotHasLoopback).toBe(false);
    expect(report.routing).toEqual(NO_OPENCODEX_ROUTING);
    expect(report.kept).toEqual(ALL_LATER_EDITS_KEPT);
  }, SPAWN_BUDGET_MS);

  test("an app rewrite that drops the injected keys is re-injected at key level and snapshotted fresh", () => {
    const { report } = runRestoreChild(root, "app-drops-keys");
    expect(report.syncedUrl).toBe("http://127.0.0.1:10100/v1");
    expect(report.snapshotHasLaterEdit).toBe(true);
    expect(report.snapshotHasLoopback).toBe(false);
    expect(report.routing).toEqual(NO_OPENCODEX_ROUTING);
    expect(report.kept).toEqual(ALL_LATER_EDITS_KEPT);
  }, SPAWN_BUDGET_MS);
});

describe("config drift detection", () => {
  const url = "http://127.0.0.1:10100/v1";
  const journal = () => ({ injectedOpenaiBaseUrl: url, injectedRealtimeWsBaseUrl: null, injectedCatalogPath: "/fixture/opencodex-catalog.json" });

  test("a dropped model_catalog_json is drift even while the routing URL survives", () => {
    const drift = codexConfigDrift(journal, "/fixture/config.toml", () => 'openai_base_url = "' + url + '"\n', () => true);
    expect(drift).toEqual({ drifted: true, missingKeys: ["model_catalog_json"] });
  });

  test("the first heal of an app rewrite is reported once, later heals quietly", async () => {
    const heal = await import("../../src/codex/config-drift-heal") as Record<string, unknown>;
    expect(typeof heal.codexConfigHealNotice).toBe("function");
    const notice = heal.codexConfigHealNotice as (missing: readonly string[], firstReport: boolean) => { level: "warn" | "info"; message: string };
    const first = notice(["openai_base_url", "model_catalog_json"], true);
    expect(first.level).toBe("warn");
    expect(first.message).toContain("openai_base_url, model_catalog_json");
    expect(first.message).toContain("other settings were kept");
    expect(notice(["openai_base_url"], false).level).toBe("info");
  });
});
