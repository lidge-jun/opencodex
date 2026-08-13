import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  getConfigPath,
  loadConfig,
  readConfigDiagnostics,
  saveConfig,
} from "../src/config";
import type { OcxConfig } from "../src/types";
import { resolveMatchedPrice } from "../src/usage/cost";
import {
  activeUserCostOverlays,
  refreshUserCostOverlays,
  resetPreservedDiskOnlyProvidersForTests,
} from "../src/usage/user-cost-overlays";
import {
  reconcileUserCostOverlaysFromDisk,
  resetUserCostOverlayReconcilerForTests,
  startUserCostOverlayReconciler,
  stopUserCostOverlayReconciler,
  userCostOverlayInvalidReconcileCountForTests,
} from "../src/usage/user-cost-overlay-reconciler";

const OVERLAY = { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0 };
const BASE_CONFIG: OcxConfig = {
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

function readDiskConfig(): OcxConfig {
  return JSON.parse(readFileSync(getConfigPath(), "utf8")) as OcxConfig;
}

function seedOverlay(): OcxConfig {
  const config = loadConfig();
  config.providers.acme!.modelCosts = { "model-x": OVERLAY };
  saveConfig(config);
  expect(resolveMatchedPrice("acme", "model-x")?.source).toBe("user");
  return config;
}

async function waitUntil(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await Bun.sleep(10);
  }
  throw new Error("timed out waiting for overlay reconciler observation");
}

beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  testDir = mkdtempSync(join(tmpdir(), "ocx-overlay-review-"));
  process.env.OPENCODEX_HOME = testDir;
  writeFileSync(getConfigPath(), `${JSON.stringify(BASE_CONFIG, null, 2)}\n`, "utf8");
});

afterEach(() => {
  stopUserCostOverlayReconciler();
  resetUserCostOverlayReconcilerForTests();
  refreshUserCostOverlays({ providers: {} } as unknown as OcxConfig);
  resetPreservedDiskOnlyProvidersForTests();
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  if (testDir) rmSync(testDir, { recursive: true, force: true });
  testDir = "";
});

describe("CodeRabbit overlay integrity regressions", () => {
  test("loadConfig keeps the last good overlays when an existing config becomes invalid", () => {
    seedOverlay();
    expect(activeUserCostOverlays()).toHaveLength(1);

    writeFileSync(getConfigPath(), "{ not json", "utf8");
    const fallback = loadConfig();

    expect(fallback.defaultProvider).toBe("openai");
    expect(readConfigDiagnostics().source).toBe("fallback");
    expect(activeUserCostOverlays()).toHaveLength(1);
    expect(resolveMatchedPrice("acme", "model-x")?.source).toBe("user");
  });

  test("loadConfig still clears stale overlays when config.json is genuinely missing", () => {
    seedOverlay();
    expect(activeUserCostOverlays()).toHaveLength(1);

    unlinkSync(getConfigPath());
    const defaults = loadConfig();

    expect(defaults.defaultProvider).toBe("openai");
    expect(activeUserCostOverlays()).toHaveLength(0);
    expect(resolveMatchedPrice("acme", "model-x")?.source).not.toBe("user");
  });

  test("one-shot reconciliation cannot drop preservation required by another registered owner", () => {
    const liveConfigA = loadConfig();
    const ownerA = startUserCostOverlayReconciler({ intervalMs: 60_000, liveConfig: liveConfigA });

    const edited = readDiskConfig();
    edited.providers.beta = {
      adapter: "openai-chat",
      baseUrl: "https://beta.example.invalid",
      apiKey: "sk-beta",
      modelCosts: { "beta-model": OVERLAY },
    };
    writeFileSync(getConfigPath(), `${JSON.stringify(edited, null, 2)}\n`, "utf8");
    expect(reconcileUserCostOverlaysFromDisk()).toBe(true);
    expect(liveConfigA.providers.beta).toBeUndefined();

    const liveConfigB = loadConfig();
    expect(liveConfigB.providers.beta).toBeDefined();
    const ownerB = startUserCostOverlayReconciler({ intervalMs: 60_000, liveConfig: liveConfigB });

    // The explicit liveConfig branch used to rebuild global preservation from B
    // alone. Because B owns beta, that dropped beta even though registered A
    // still lacked it, allowing A's next unrelated save to erase the provider.
    expect(reconcileUserCostOverlaysFromDisk(liveConfigB)).toBe(true);
    liveConfigA.providers.acme!.models = ["model-x", "model-extra"];
    saveConfig(liveConfigA);

    expect(readDiskConfig().providers.beta?.modelCosts).toEqual({ "beta-model": OVERLAY });

    ownerB.stop();
    ownerA.stop();
  });

  test("invalid transient config is observed by the poller before overlay retention is asserted", async () => {
    const liveConfig = seedOverlay();
    startUserCostOverlayReconciler({ intervalMs: 20, liveConfig });
    const invalidReadsBefore = userCostOverlayInvalidReconcileCountForTests();

    writeFileSync(getConfigPath(), "{ not json", "utf8");
    await waitUntil(
      () => userCostOverlayInvalidReconcileCountForTests() > invalidReadsBefore,
    );

    expect(readConfigDiagnostics().source).toBe("fallback");
    expect(activeUserCostOverlays()).toHaveLength(1);
    expect(resolveMatchedPrice("acme", "model-x")?.source).toBe("user");
  });
});
