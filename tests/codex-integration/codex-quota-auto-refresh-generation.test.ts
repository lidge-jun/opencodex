import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  NativeMainBusyError,
  resetCodexQuotaAutoRefreshForTests,
  runCodexQuotaAutoRefresh,
  type CodexQuotaAutoRefreshWindows,
} from "../../src/codex/quota-auto-refresh";
import { clearAccountQuota, type StoredAccountQuota } from "../../src/codex/quota";
import { readCodexAccountRecord, saveCodexAccountCredential } from "../../src/codex/account-store";
import type { OcxConfig } from "../../src/types";

/**
 * Retry evidence belongs to the credential it was observed under (#6020 review). A replaced or
 * reauthenticated credential must not wait out its predecessor's backoff, and a local admission
 * refusal that sent nothing upstream must not grow the upstream backoff.
 */
const NOW = 1_800_000_000_000;
const RESET_SECONDS = NOW / 1000;
let testHome = "";
let previousHome: string | undefined;

function writePoolCredential(accessToken: string): void {
  saveCodexAccountCredential("pool-a", {
    accessToken, refreshToken: "generation-refresh-fixture",
    expiresAt: NOW + 86_400_000, chatgptAccountId: "generation-workspace-fixture",
  });
}

function config(): OcxConfig {
  return {
    defaultProvider: "openai",
    providers: { openai: {
      adapter: "openai-responses", baseUrl: "https://chatgpt.com/backend-api/codex",
      authMode: "forward", codexAccountMode: "pool",
    } },
    codexAccounts: [{ id: "pool-a", email: "p***a@example.test", plan: "team", isMain: false }],
    codexQuotaAutoRefresh: { "pool-a": { fiveHour: true, weekly: true } },
  };
}

function quota(): StoredAccountQuota {
  return { shortWindowSeconds: 5 * 60 * 60, shortResetAt: RESET_SECONDS, weeklyResetAt: RESET_SECONDS, updatedAt: NOW };
}

function recordMarkers(cfg: OcxConfig, accountId: string, completed: CodexQuotaAutoRefreshWindows): boolean {
  cfg.codexQuotaAutoRefresh = { ...cfg.codexQuotaAutoRefresh, [accountId]: {
    ...cfg.codexQuotaAutoRefresh?.[accountId],
    ...(completed.fiveHour !== undefined ? { lastFiveHourResetAt: completed.fiveHour } : {}),
    ...(completed.weekly !== undefined ? { lastWeeklyResetAt: completed.weekly } : {}),
  } };
  return true;
}

beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  testHome = mkdtempSync(join(tmpdir(), "ocx-quota-generation-"));
  process.env.OPENCODEX_HOME = testHome;
  clearAccountQuota();
  resetCodexQuotaAutoRefreshForTests();
  writePoolCredential("generation-one");
});

afterEach(() => {
  clearAccountQuota();
  resetCodexQuotaAutoRefreshForTests();
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  if (testHome && existsSync(testHome)) rmSync(testHome, { recursive: true, force: true });
});

describe("quota auto-refresh retry evidence follows the credential", () => {
  test("a replaced credential does not wait out its predecessor's backoff", async () => {
    const cfg = config();
    let attempts = 0;
    const deps = {
      getQuota: () => quota(),
      warmAccount: async () => { attempts++; if (attempts === 1) throw new Error("fixture failure"); },
      persistCompleted: recordMarkers,
    };
    await runCodexQuotaAutoRefresh(cfg, NOW, deps);
    expect(attempts).toBe(1);
    // Same credential: the five-minute backoff holds.
    await runCodexQuotaAutoRefresh(cfg, NOW + 60_000, deps);
    expect(attempts).toBe(1);
    const before = readCodexAccountRecord("pool-a")?.generation;
    writePoolCredential("generation-two");
    expect(readCodexAccountRecord("pool-a")?.generation).not.toBe(before);
    // Replacement: the old backoff is spent and the new credential is tried at once.
    await runCodexQuotaAutoRefresh(cfg, NOW + 120_000, deps);
    expect(attempts).toBe(2);
    expect(cfg.codexQuotaAutoRefresh?.["pool-a"]?.lastFiveHourResetAt).toBe(NOW);
  });

  test("a failure that raced a replacement is not recorded against the new credential", async () => {
    const cfg = config();
    let attempts = 0;
    const deps = {
      getQuota: () => quota(),
      warmAccount: async () => {
        attempts++;
        if (attempts === 1) {
          writePoolCredential("rotated-during-warmup");
          throw new Error("fixture failure from the old credential");
        }
      },
      persistCompleted: recordMarkers,
    };
    await runCodexQuotaAutoRefresh(cfg, NOW, deps);
    expect(cfg.codexQuotaAutoRefresh?.["pool-a"]?.lastFiveHourResetAt).toBeUndefined();
    await runCodexQuotaAutoRefresh(cfg, NOW + 60_000, deps);
    expect(attempts).toBe(2);
    expect(cfg.codexQuotaAutoRefresh?.["pool-a"]?.lastFiveHourResetAt).toBe(NOW);
  });

  test("a local busy refusal retries every minute without growing the upstream backoff", async () => {
    const cfg = config();
    let attempts = 0;
    let outcome: "busy" | "fail" | "ok" = "busy";
    const deps = {
      getQuota: () => quota(),
      warmAccount: async () => {
        attempts++;
        if (outcome === "busy") throw new NativeMainBusyError();
        if (outcome === "fail") throw new Error("fixture upstream failure");
      },
      persistCompleted: recordMarkers,
    };
    await runCodexQuotaAutoRefresh(cfg, NOW, deps);
    await runCodexQuotaAutoRefresh(cfg, NOW + 60_000 - 1, deps);
    expect(attempts).toBe(1);
    await runCodexQuotaAutoRefresh(cfg, NOW + 60_000, deps);
    await runCodexQuotaAutoRefresh(cfg, NOW + 120_000, deps);
    expect(attempts).toBe(3);
    // The first real upstream failure starts from the base five minutes, not a doubled delay.
    outcome = "fail";
    await runCodexQuotaAutoRefresh(cfg, NOW + 180_000, deps);
    expect(attempts).toBe(4);
    outcome = "ok";
    await runCodexQuotaAutoRefresh(cfg, NOW + 180_000 + 5 * 60_000 - 1, deps);
    expect(attempts).toBe(4);
    await runCodexQuotaAutoRefresh(cfg, NOW + 180_000 + 5 * 60_000, deps);
    expect(attempts).toBe(5);
    expect(cfg.codexQuotaAutoRefresh?.["pool-a"]?.lastFiveHourResetAt).toBe(NOW);
  });
});
