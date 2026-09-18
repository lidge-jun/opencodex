import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  clearAccountQuota, flushQuotaObservationsForTests, getAccountQuota, listAccountQuotas,
  setAccountQuotaFromParsed, withoutRetiredCodexQuota,
} from "../../src/codex/quota";
import { codexPoolQuotaEvidence } from "../../src/routing/quota";
import { loadConfig, saveConfig } from "../../src/config";
import { handleManagementAPI } from "../../src/server/management-api";
import { ManagementRequest } from "../helpers/management-auth";
import * as observer from "../../src/quota/reset-observer";
import type { OcxConfig } from "../../src/types";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const retired = [
  { label: "GPT-5.3-Codex-Spark 5h", percent: 99, resetAt: 2 },
  { label: "GPT-5.3-Codex-Spark Weekly", percent: 100, resetAt: 3 },
];
const custom = { label: "Custom weekly", percent: 40, resetAt: 4 };
const originalHome = process.env.OPENCODEX_HOME;
let home = "";

beforeEach(async () => {
  await flushQuotaObservationsForTests();
  home = mkdtempSync(join(tmpdir(), "ocx-spark-retirement-"));
  process.env.OPENCODEX_HOME = home;
  clearAccountQuota();
  await flushQuotaObservationsForTests();
});

afterEach(async () => {
  observer.setQuotaResetSink(null);
  await flushQuotaObservationsForTests();
  clearAccountQuota();
  await flushQuotaObservationsForTests();
  if (originalHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = originalHome;
  removeTreeWithRetry(home);
});

describe("retired Codex Spark quota tombstone", () => {
  test("removes only retired labels, preserving the source and generic windows", () => {
    const stored = { weeklyPercent: 11, customWindows: [...retired, custom], updatedAt: 1 };
    expect(withoutRetiredCodexQuota(stored)).toEqual({ weeklyPercent: 11, customWindows: [custom], updatedAt: 1 });
    expect(stored.customWindows).toHaveLength(3);
    expect(withoutRetiredCodexQuota({ customWindows: retired, updatedAt: 1 })).toBeNull();
    expect(withoutRetiredCodexQuota(null)).toBeNull();
  });

  test.each([true, "legacy-malformed"])("old config value %s stays loadable but cannot re-enable the setting", async legacyValue => {
    const legacy = { port: 10100, defaultProvider: "openai", providers: {}, showCodexSparkQuota: legacyValue };
    saveConfig(legacy as OcxConfig);
    const config = loadConfig();
    expect(config.port).toBe(10100);
    const url = new URL("http://localhost/api/settings");
    const response = await handleManagementAPI(new ManagementRequest(url), url, config);
    expect(response?.status).toBe(200);
    expect(await response!.json()).not.toHaveProperty("showCodexSparkQuota");
    const rejected = await handleManagementAPI(new ManagementRequest(url, {
      method: "PUT", headers: { "content-type": "application/json" },
      body: JSON.stringify({ showCodexSparkQuota: true }),
    }), url, config);
    expect(rejected?.status).toBe(400);
    expect(withoutRetiredCodexQuota({ customWindows: retired })).toBeNull();
  });

  test("hydration drops Spark-only cache entries before presence checks", () => {
    writeFileSync(join(home, "codex-quota-cache.json"), JSON.stringify({
      version: 1,
      quotas: {
        retired: { updatedAt: Date.now(), customWindows: retired },
        mixed: { updatedAt: Date.now(), weeklyPercent: 21, customWindows: [...retired, custom] },
      },
    }));
    expect(getAccountQuota("retired")).toBeNull();
    expect(codexPoolQuotaEvidence([{ accountId: "retired", plan: "plus" }])).toEqual({ known: false });
    expect([...listAccountQuotas()].map(([id]) => id)).toEqual(["mixed"]);
    expect(getAccountQuota("mixed")?.customWindows).toEqual([custom]);
    setAccountQuotaFromParsed("mixed", { resetCredits: 2 });
    expect(getAccountQuota("mixed")).toMatchObject({ weeklyPercent: 21, customWindows: [custom], resetCredits: 2 });
    setAccountQuotaFromParsed("mixed", { weeklyPercent: 22 });
    expect(getAccountQuota("mixed")).toMatchObject({ weeklyPercent: 22, customWindows: [custom], resetCredits: 2 });
  });

  test("Spark-only ingestion cannot refresh ordinary observation clocks or establish presence", () => {
    setAccountQuotaFromParsed("new", { customWindows: retired });
    expect(getAccountQuota("new")).toBeNull();
    setAccountQuotaFromParsed("credits", { customWindows: retired, resetCredits: 2 });
    expect(getAccountQuota("credits")).toMatchObject({ resetCredits: 2 });
    expect(getAccountQuota("credits")?.customWindows).toBeUndefined();
    expect(codexPoolQuotaEvidence([{ accountId: "credits", plan: "plus" }])).toEqual({ known: false });
    setAccountQuotaFromParsed("ordinary", { weeklyPercent: 88, customWindows: [custom] });
    const before = getAccountQuota("ordinary");
    setAccountQuotaFromParsed("ordinary", { customWindows: retired });
    expect(getAccountQuota("ordinary")).toBe(before);
    setAccountQuotaFromParsed("ordinary", { customWindows: retired, resetCredits: 3 });
    expect(getAccountQuota("ordinary")).toMatchObject({ weeklyPercent: 88, customWindows: [custom], resetCredits: 3 });
  });

  test("reset observation receives only surviving windows and ignores credits-only updates", async () => {
    observer.setQuotaResetSink(() => {});
    const observed = spyOn(observer, "observeQuotaSnapshot");
    try {
      setAccountQuotaFromParsed("observed", { weeklyPercent: 11, customWindows: [...retired, custom] });
      await flushQuotaObservationsForTests();
      expect(observed).toHaveBeenCalledTimes(1);
      expect(observed.mock.calls[0]?.[0].windows.map(window => window.window)).toEqual(["weekly", "custom:Custom weekly"]);
      setAccountQuotaFromParsed("observed", { customWindows: retired });
      setAccountQuotaFromParsed("observed", { resetCredits: 1, customWindows: retired });
      await flushQuotaObservationsForTests();
      expect(observed).toHaveBeenCalledTimes(1);
    } finally {
      observed.mockRestore();
    }
  });
});
