import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  codexQuotaAutoRefreshStatus,
  dueCodexQuotaAutoRefreshWindows,
  resetCodexQuotaAutoRefreshForTests,
  runCodexQuotaAutoRefresh,
  type CodexQuotaAutoRefreshWindows,
} from "../../src/codex/quota-auto-refresh";
import {
  clearAccountQuota,
  setAccountQuotaFromParsed,
  type StoredAccountQuota,
} from "../../src/codex/quota";
import { handleManagementAPI, type ManagementApiDeps } from "../../src/server/management-api";
import { loadConfig, readConfigDiagnostics, validateConfigCandidate } from "../../src/config";
import type { OcxConfig } from "../../src/types";
import { startupHealthFixture } from "../helpers/startup-health";

const NOW = 1_800_000_000_000;
const RESET_SECONDS = NOW / 1000;
let testHome = "";
let previousHome: string | undefined;

function config(): OcxConfig {
  return {
    defaultProvider: "openai",
    providers: {
      openai: {
        adapter: "openai-responses",
        baseUrl: "https://chatgpt.com/backend-api/codex",
        authMode: "forward",
        codexAccountMode: "pool",
      },
    },
    codexAccounts: [{ id: "pool-a", email: "p***a@example.test", plan: "team", isMain: false }],
    codexQuotaAutoRefresh: { "pool-a": { fiveHour: true, weekly: true } },
  };
}

function quota(overrides: Partial<StoredAccountQuota> = {}): StoredAccountQuota {
  return {
    shortWindowSeconds: 5 * 60 * 60,
    shortResetAt: RESET_SECONDS,
    weeklyResetAt: RESET_SECONDS,
    updatedAt: NOW,
    ...overrides,
  };
}

function recordMarkers(
  cfg: OcxConfig,
  accountId: string,
  completed: CodexQuotaAutoRefreshWindows,
): boolean {
  cfg.codexQuotaAutoRefresh = {
    ...cfg.codexQuotaAutoRefresh,
    [accountId]: {
      ...cfg.codexQuotaAutoRefresh?.[accountId],
      ...(completed.fiveHour !== undefined ? { lastFiveHourResetAt: completed.fiveHour } : {}),
      ...(completed.weekly !== undefined ? { lastWeeklyResetAt: completed.weekly } : {}),
    },
  };
  return true;
}

const routeDeps: ManagementApiDeps = {
  saveConfigPreservingClaudeCode: () => {},
  getCachedStartupHealth: async () => startupHealthFixture(),
};

function putSettings(cfg: OcxConfig, value: unknown): Promise<Response | null> {
  const request = new Request("http://127.0.0.1:10100/api/settings", {
    method: "PUT",
    headers: {
      "content-type": "application/json",
      host: "127.0.0.1:10100",
      origin: "http://127.0.0.1:10100",
    },
    body: JSON.stringify(value),
  });
  return handleManagementAPI(request, new URL(request.url), cfg, routeDeps);
}

beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  testHome = mkdtempSync(join(tmpdir(), "ocx-quota-auto-refresh-"));
  process.env.OPENCODEX_HOME = testHome;
  clearAccountQuota();
  resetCodexQuotaAutoRefreshForTests();
});

afterEach(() => {
  clearAccountQuota();
  resetCodexQuotaAutoRefreshForTests();
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  if (testHome && existsSync(testHome)) rmSync(testHome, { recursive: true, force: true });
});

describe("Codex quota window auto refresh", () => {
  test("detects only reported 5-hour and weekly capabilities", () => {
    const cfg = config();
    expect(codexQuotaAutoRefreshStatus(cfg, "pool-a", quota())).toEqual({
      fiveHourAvailable: true,
      weeklyAvailable: true,
      fiveHourEnabled: true,
      weeklyEnabled: true,
    });
    expect(codexQuotaAutoRefreshStatus(cfg, "pool-a", quota({ shortWindowSeconds: 3600 })))
      .toMatchObject({ fiveHourAvailable: false, weeklyAvailable: true });
  });

  test("accepts reset timestamps in seconds or milliseconds and ignores completed windows", () => {
    const cfg = config();
    expect(dueCodexQuotaAutoRefreshWindows(cfg, "pool-a", quota(), NOW)).toEqual({
      fiveHour: NOW,
      weekly: NOW,
    });
    expect(dueCodexQuotaAutoRefreshWindows(
      cfg,
      "pool-a",
      quota({ shortResetAt: NOW, weeklyResetAt: NOW }),
      NOW,
    )).toEqual({ fiveHour: NOW, weekly: NOW });
    expect(dueCodexQuotaAutoRefreshWindows(
      cfg,
      "pool-a",
      quota(),
      NOW,
      { fiveHour: RESET_SECONDS, weekly: RESET_SECONDS },
    )).toBeNull();
  });

  test.each([
    [RESET_SECONDS, NOW],
    [NOW, RESET_SECONDS],
  ])("deduplicates saved and completed markers across units (%i -> %i)", (marker, observed) => {
    const cfg = config();
    const snapshot = quota({ shortResetAt: observed, weeklyResetAt: observed });
    expect(dueCodexQuotaAutoRefreshWindows(cfg, "pool-a", snapshot, NOW, {
      fiveHour: marker,
      weekly: marker,
    })).toBeNull();
    cfg.codexQuotaAutoRefresh = {
      "pool-a": { fiveHour: true, weekly: true, lastFiveHourResetAt: marker, lastWeeklyResetAt: marker },
    };
    expect(dueCodexQuotaAutoRefreshWindows(cfg, "pool-a", snapshot, NOW)).toBeNull();
    expect(dueCodexQuotaAutoRefreshWindows(cfg, "pool-a", quota({
      shortResetAt: RESET_SECONDS + 1,
      weeklyResetAt: NOW + 1000,
    }), NOW)).toBeNull();
    expect(dueCodexQuotaAutoRefreshWindows(cfg, "pool-a", quota({
      shortResetAt: RESET_SECONDS + 1,
      weeklyResetAt: NOW + 1000,
    }), NOW + 1000)).toEqual({ fiveHour: NOW + 1000, weekly: NOW + 1000 });
  });

  test.each([
    [RESET_SECONDS, NOW],
    [NOW, RESET_SECONDS],
  ])("persists canonical markers and avoids warmup after a unit change and restart (%i -> %i)", async (first, second) => {
    const cfg = config();
    writeFileSync(join(testHome, "config.json"), JSON.stringify(cfg));
    let observed = first;
    let warmups = 0;
    const deps = {
      getQuota: (id: string) => id === "pool-a"
        ? quota({ shortResetAt: observed, weeklyResetAt: observed }) : null,
      warmAccount: async () => { warmups += 1; },
    };
    await runCodexQuotaAutoRefresh(cfg, NOW, deps);
    expect(readConfigDiagnostics().config.codexQuotaAutoRefresh?.["pool-a"]).toMatchObject({
      lastFiveHourResetAt: NOW,
      lastWeeklyResetAt: NOW,
    });
    observed = second;
    await runCodexQuotaAutoRefresh(cfg, NOW + 1, deps);
    resetCodexQuotaAutoRefreshForTests();
    await runCodexQuotaAutoRefresh(loadConfig(), NOW + 2, deps);
    expect(warmups).toBe(1);
    observed = RESET_SECONDS + 1;
    await runCodexQuotaAutoRefresh(loadConfig(), NOW + 1000, deps);
    expect(warmups).toBe(2);
    expect(readConfigDiagnostics().config.codexQuotaAutoRefresh?.["pool-a"]).toMatchObject({
      lastFiveHourResetAt: NOW + 1000,
      lastWeeklyResetAt: NOW + 1000,
    });
  });

  test("coalesces simultaneous windows into one warmup and persists both markers", async () => {
    const cfg = config();
    const warmed: string[] = [];
    await runCodexQuotaAutoRefresh(cfg, NOW, {
      getQuota: id => id === "pool-a" ? quota() : null,
      warmAccount: async (_config, id) => { warmed.push(id); },
      persistCompleted: recordMarkers,
    });
    await runCodexQuotaAutoRefresh(cfg, NOW + 1, {
      getQuota: id => id === "pool-a" ? quota() : null,
      warmAccount: async (_config, id) => { warmed.push(id); },
      persistCompleted: recordMarkers,
    });
    expect(warmed).toEqual(["pool-a"]);
    expect(cfg.codexQuotaAutoRefresh?.["pool-a"]).toMatchObject({
      lastFiveHourResetAt: NOW,
      lastWeeklyResetAt: NOW,
    });
  });

  test("only false skips completion and backoff; existing void success still completes", async () => {
    const cfg = config();
    let attempts = 0;
    let writes = 0;
    const deps = {
      getQuota: (id: string) => id === "pool-a" ? quota() : null,
      warmAccount: async (): Promise<void | false> => {
        attempts += 1;
        if (attempts === 1) return false;
      },
      persistCompleted: (target: OcxConfig, id: string, completed: CodexQuotaAutoRefreshWindows) => {
        writes += 1;
        return recordMarkers(target, id, completed);
      },
    };
    await runCodexQuotaAutoRefresh(cfg, NOW, deps);
    expect(writes).toBe(0);
    expect(cfg.codexQuotaAutoRefresh?.["pool-a"]?.lastWeeklyResetAt).toBeUndefined();
    await runCodexQuotaAutoRefresh(cfg, NOW + 1, deps);
    expect(attempts).toBe(2);
    expect(writes).toBe(1);
    expect(cfg.codexQuotaAutoRefresh?.["pool-a"]?.lastWeeklyResetAt).toBe(NOW);
  });

  test("does not schedule pool-account warmups in Direct mode", async () => {
    const cfg = config();
    cfg.providers.openai.codexAccountMode = "direct";
    const warmed: string[] = [];
    await runCodexQuotaAutoRefresh(cfg, NOW, {
      getQuota: id => id === "pool-a" ? quota() : null,
      warmAccount: async (_config, id) => { warmed.push(id); },
      persistCompleted: recordMarkers,
    });
    expect(warmed).toEqual([]);
  });

  test("retries a failed marker write without sending a second warmup", async () => {
    const cfg = config();
    let warmups = 0;
    let writes = 0;
    let observed = RESET_SECONDS;
    const persist = (target: OcxConfig, id: string, completed: CodexQuotaAutoRefreshWindows) => {
      writes += 1;
      return writes > 2 ? recordMarkers(target, id, completed) : false;
    };
    const deps = {
      getQuota: (id: string) => id === "pool-a"
        ? quota({ shortResetAt: observed, weeklyResetAt: observed }) : null,
      warmAccount: async () => { warmups += 1; },
      persistCompleted: persist,
    };
    await runCodexQuotaAutoRefresh(cfg, NOW, deps);
    observed = NOW;
    await runCodexQuotaAutoRefresh(cfg, NOW + 1, deps);
    expect(warmups).toBe(1);
    expect(writes).toBe(2);
    await runCodexQuotaAutoRefresh(cfg, NOW + 2, deps);
    expect(warmups).toBe(1);
    expect(writes).toBe(3);
    expect(cfg.codexQuotaAutoRefresh?.["pool-a"]).toMatchObject({
      lastFiveHourResetAt: NOW,
      lastWeeklyResetAt: NOW,
    });
    // Equivalent legacy markers must not cause another persistence attempt either.
    cfg.codexQuotaAutoRefresh = {
      "pool-a": { fiveHour: true, weekly: true, lastFiveHourResetAt: RESET_SECONDS, lastWeeklyResetAt: RESET_SECONDS },
    };
    await runCodexQuotaAutoRefresh(cfg, NOW + 3, deps);
    expect(warmups).toBe(1);
    expect(writes).toBe(3);
  });

  test("backs a failed main-account claim or warmup off for five minutes", async () => {
    const cfg = config();
    cfg.codexQuotaAutoRefresh = { __main__: { fiveHour: true, weekly: true } };
    let attempts = 0;
    const deps = {
      getQuota: (id: string) => id === "__main__" ? quota() : null,
      warmAccount: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("busy");
      },
      persistCompleted: recordMarkers,
    };
    await runCodexQuotaAutoRefresh(cfg, NOW, deps);
    await runCodexQuotaAutoRefresh(cfg, NOW + 5 * 60_000 - 1, deps);
    await runCodexQuotaAutoRefresh(cfg, NOW + 5 * 60_000, deps);
    expect(attempts).toBe(2);
    expect(cfg.codexQuotaAutoRefresh?.__main__?.lastFiveHourResetAt).toBe(NOW);
  });

  test("settings route persists supported toggles and rejects unavailable windows", async () => {
    const cfg = config();
    cfg.codexQuotaAutoRefresh = {};
    setAccountQuotaFromParsed("pool-a", quota({
      shortResetAt: Math.floor(Date.now() / 1000) + 3600,
      weeklyResetAt: Math.floor(Date.now() / 1000) + 3600,
    }));
    const enabled = await putSettings(cfg, {
      codexQuotaAutoRefresh: { id: "pool-a", window: "fiveHour", enabled: true },
    });
    expect(enabled?.status).toBe(200);
    expect(cfg.codexQuotaAutoRefresh?.["pool-a"]?.fiveHour).toBe(true);

    clearAccountQuota();
    const rejected = await putSettings(cfg, {
      codexQuotaAutoRefresh: { id: "pool-a", window: "weekly", enabled: true },
    });
    expect(rejected?.status).toBe(409);
  });

  test("degrades reserved quota-map keys with a warning and rejects them at write boundaries", () => {
    const raw = '{"providers":{"openai":{"adapter":"openai-responses",'
      + '"baseUrl":"https://chatgpt.com/backend-api/codex","authMode":"forward"}},'
      + '"defaultProvider":"openai","codexQuotaAutoRefresh":{"__proto__":{"weekly":true}}}';
    writeFileSync(join(testHome, "config.json"), raw);

    const diagnostics = readConfigDiagnostics();
    expect(diagnostics.config.codexQuotaAutoRefresh).toBeUndefined();
    expect(diagnostics.warnings).toContainEqual(expect.stringContaining("automatic quota-window activation is disabled"));
    expect(validateConfigCandidate(JSON.parse(raw))).toMatchObject({
      ok: false,
      error: expect.stringContaining("codexQuotaAutoRefresh"),
    });

    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(loadConfig().codexQuotaAutoRefresh).toBeUndefined();
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("automatic quota-window activation is disabled"));
    } finally {
      warn.mockRestore();
    }
  });

  test("loads valid quota settings and rejects malformed entries without discarding config", () => {
    const valid = config();
    valid.codexQuotaAutoRefresh = {
      "pool-a": { fiveHour: true, lastFiveHourResetAt: RESET_SECONDS },
    };
    writeFileSync(join(testHome, "config.json"), JSON.stringify(valid));
    expect(readConfigDiagnostics().config.codexQuotaAutoRefresh).toEqual(valid.codexQuotaAutoRefresh);
    expect(validateConfigCandidate(valid)).toMatchObject({ ok: true });

    for (const codexQuotaAutoRefresh of [
      { "pool-a": true },
      { "pool-a": { weekly: true, lastWeeklyResetAt: -1 } },
      { "bad/id": { weekly: true } },
    ]) {
      const malformed = { ...config(), codexQuotaAutoRefresh };
      writeFileSync(join(testHome, "config.json"), JSON.stringify(malformed));
      const diagnostics = readConfigDiagnostics();
      expect(diagnostics.config.codexQuotaAutoRefresh).toBeUndefined();
      expect(diagnostics.warnings).toContainEqual(
        expect.stringContaining("automatic quota-window activation is disabled"),
      );
      expect(validateConfigCandidate(malformed)).toMatchObject({
        ok: false,
        error: expect.stringContaining("codexQuotaAutoRefresh"),
      });
    }
  });
});
