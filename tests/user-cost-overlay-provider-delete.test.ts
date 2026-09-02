import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  getConfigPath,
  loadConfig,
  saveConfig,
  saveConfigPreservingClaudeCode,
} from "../src/config";
import type { OcxConfig } from "../src/types";
import { resolveMatchedPrice } from "../src/usage/cost";
import {
  activeUserCostOverlays,
  refreshUserCostOverlays,
  resetPreservedDiskOnlyProvidersForTests,
  userCostOverlayVersion,
  withPreservedDiskOnlyProviders,
} from "../src/usage/user-cost-overlays";
import {
  reconcileUserCostOverlaysFromDisk,
  resetUserCostOverlayReconcilerForTests,
  startUserCostOverlayReconciler,
  stopUserCostOverlayReconciler,
} from "../src/usage/user-cost-overlay-reconciler";
import { removeTreeWithRetry } from "./helpers/remove-tree";

const OVERLAY = { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0 };

const DISK_CONFIG: OcxConfig = {
  port: 0,
  hostname: "127.0.0.1",
  defaultProvider: "acme",
  providers: {
    acme: {
      adapter: "openai-chat",
      baseUrl: "https://example.invalid",
      apiKey: "sk-test",
      models: ["model-x"],
    },
  },
} as OcxConfig;

let testDir = "";
let previousHome: string | undefined;

beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  testDir = mkdtempSync(join(tmpdir(), "ocx-overlay-delete-"));
  process.env.OPENCODEX_HOME = testDir;
  writeFileSync(getConfigPath(), `${JSON.stringify(DISK_CONFIG, null, 2)}\n`, "utf8");
});

afterEach(() => {
  stopUserCostOverlayReconciler();
  resetUserCostOverlayReconcilerForTests();
  refreshUserCostOverlays({ providers: {} } as unknown as OcxConfig);
  resetPreservedDiskOnlyProvidersForTests();
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  if (testDir) removeTreeWithRetry(testDir);
  testDir = "";
});

describe("provider deletion with disk-only preservation", () => {
  test("an owner that previously owned a provider can delete it without stale owners resurrecting it", () => {
    // A booted before beta existed and therefore must preserve beta on unrelated saves.
    const liveConfigA = loadConfig();
    const ownerA = startUserCostOverlayReconciler({ intervalMs: 20, liveConfig: liveConfigA });

    const externallyEdited = JSON.parse(readFileSync(getConfigPath(), "utf8")) as OcxConfig;
    externallyEdited.providers.beta = {
      adapter: "openai-chat",
      baseUrl: "https://beta.example.invalid",
      apiKey: "sk-beta",
      modelCosts: { "beta-model": OVERLAY },
    };
    writeFileSync(getConfigPath(), `${JSON.stringify(externallyEdited, null, 2)}\n`, "utf8");
    expect(reconcileUserCostOverlaysFromDisk()).toBe(true);
    expect(liveConfigA.providers.beta).toBeUndefined();
    expect(withPreservedDiskOnlyProviders(liveConfigA).providers.beta).toBeDefined();

    // B and C start later from disk and genuinely own beta in their live projections.
    const liveConfigB = loadConfig();
    const ownerB = startUserCostOverlayReconciler({ intervalMs: 20, liveConfig: liveConfigB });
    const liveConfigC = loadConfig();
    const ownerC = startUserCostOverlayReconciler({ intervalMs: 20, liveConfig: liveConfigC });
    expect(liveConfigB.providers.beta).toBeDefined();
    expect(liveConfigC.providers.beta).toBeDefined();
    expect(reconcileUserCostOverlaysFromDisk()).toBe(true);

    // The old-owner protection still works: A's unrelated save must keep beta.
    liveConfigA.providers.acme!.models = ["model-x", "model-extra"];
    saveConfig(liveConfigA);
    let persisted = JSON.parse(readFileSync(getConfigPath(), "utf8")) as OcxConfig;
    expect(persisted.providers.beta?.modelCosts).toEqual({ "beta-model": OVERLAY });
    expect(resolveMatchedPrice("beta", "beta-model")?.source).toBe("user");

    // This mirrors DELETE /api/providers: B owned beta, then intentionally removes it
    // and uses the live-config save wrapper. The real route has an await import after
    // deleting the row, so force a reconcile in that gap to prove ownership is retained
    // until disk confirms the deletion. Preservation must still not put beta back.
    const versionBeforeDelete = userCostOverlayVersion();
    delete liveConfigB.providers.beta;
    expect(reconcileUserCostOverlaysFromDisk()).toBe(true);
    saveConfigPreservingClaudeCode(liveConfigB);
    persisted = JSON.parse(readFileSync(getConfigPath(), "utf8")) as OcxConfig;
    expect(persisted.providers.beta).toBeUndefined();
    expect(activeUserCostOverlays().some(row => row.provider === "beta")).toBe(false);
    expect(resolveMatchedPrice("beta", "beta-model")?.source).not.toBe("user");
    expect(userCostOverlayVersion()).toBeGreaterThan(versionBeforeDelete);

    // Successful deletion converges every active owner so a third, older projection
    // that still had beta cannot recreate it on a later unrelated save.
    expect(liveConfigC.providers.beta).toBeUndefined();
    liveConfigC.providers.acme!.models = ["model-x", "model-c"];
    saveConfig(liveConfigC);
    persisted = JSON.parse(readFileSync(getConfigPath(), "utf8")) as OcxConfig;
    expect(persisted.providers.beta).toBeUndefined();

    ownerC.stop();
    ownerB.stop();
    ownerA.stop();
  });
});
