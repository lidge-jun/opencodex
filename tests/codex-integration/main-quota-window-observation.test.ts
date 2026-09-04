import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAIN_CODEX_ACCOUNT_ID as MAIN } from "../../src/codex/account-id";
import { getMainAccountHardLockStatus } from "../../src/codex/main-account-hard-lock";
import { fetchMainAccountInfo } from "../../src/codex/auth-api";
import { setMainAccountPlan } from "../../src/codex/main-account";
import { resetLifecycleDrainStateForTests } from "../../src/server/lifecycle";
import { setAsyncIcaclsRunnerForTests, setIcaclsRunnerForTests } from "../../src/lib/windows-secret-acl";
import { flushConfigDirHardeningForTests } from "../../src/config/paths";
import { resetMainCodexAccountIdentityTrackingForTests } from "../../src/codex/account-lifecycle";
import {
  captureMainQuotaWriter, clearMainAccountInfoCache, matchesMainQuotaCredential, observeMainQuotaIdentity,
} from "../../src/codex/main-account-cache";
import {
  applyAccountQuotaFromUpstreamHeaders, clearAccountQuota, getAccountQuota, getMainPolicyQuota, setAccountQuotaFromParsed,
} from "../../src/codex/quota";
import { removeTreeWithRetry } from "../helpers/remove-tree";

let testDir: string;
let previousHome: string | undefined;
let previousCodexHome: string | undefined;
let previousFetch: typeof fetch;

beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  previousCodexHome = process.env.CODEX_HOME;
  previousFetch = globalThis.fetch;
  testDir = mkdtempSync(join(tmpdir(), "ocx-main-window-"));
  process.env.OPENCODEX_HOME = testDir;
  process.env.CODEX_HOME = testDir;
  clearAccountQuota();
  clearMainAccountInfoCache();
  resetMainCodexAccountIdentityTrackingForTests();
  resetLifecycleDrainStateForTests();
  setMainAccountPlan(null);
});

afterEach(async () => {
  globalThis.fetch = previousFetch;
  clearAccountQuota();
  clearMainAccountInfoCache();
  resetMainCodexAccountIdentityTrackingForTests();
  resetLifecycleDrainStateForTests();
  setMainAccountPlan(null);
  try {
    await flushConfigDirHardeningForTests();
  } finally {
    setIcaclsRunnerForTests(null);
    setAsyncIcaclsRunnerForTests(null);
    if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
    else process.env.OPENCODEX_HOME = previousHome;
    if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousCodexHome;
    removeTreeWithRetry(testDir);
  }
});

function writerFor() {
  observeMainQuotaIdentity("fixture-main-a");
  const writer = captureMainQuotaWriter("fixture-main-a");
  if (!writer) throw new Error("Expected an observed main quota writer");
  return writer;
}

describe("declared short-window producer evidence", () => {
  const cases = [
    { name: "missing usage with weekly99", usage: undefined, weekly: true },
    { name: "invalid usage with weekly99", usage: "unreadable", weekly: true },
    { name: "metadata-only short window", usage: undefined, weekly: false },
  ];
  for (const sample of cases) {
    test(`owned WHAM fetch preserves ${sample.name} as unknown short-window policy`, async () => {
      resetLifecycleDrainStateForTests();
      const aclOk = { success: true, exitCode: 0, timedOut: false, stdout: "" };
      setIcaclsRunnerForTests(() => aclOk);
      setAsyncIcaclsRunnerForTests(async () => aclOk);
      const accessToken = "test-main";
      writeFileSync(join(testDir, "auth.json"), JSON.stringify({ tokens: {
        access_token: accessToken, account_id: "fixture-main-a",
      } }));
      let calls = 0;
      const stubFetch: typeof fetch = Object.assign(async (
        input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1],
      ) => {
        expect(String(input)).toBe("https://chatgpt.com/backend-api/wham/usage");
        expect(new Headers(init?.headers).get("chatgpt-account-id")).toBe("fixture-main-a");
        expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${accessToken}`);
        calls += 1;
        if (calls === 3 || calls === 5) {
          return Response.json({ plan_type: "plus", rate_limit: { primary_window: {
            used_percent: calls === 3 ? 99 : 0, limit_window_seconds: 18_000,
            reset_at: calls === 3 ? 3_000_000_000 : 4_000_000_000,
          } } });
        }
        return Response.json({ plan_type: "plus", rate_limit: calls === 1
          ? { primary_window: { used_percent: 99, limit_window_seconds: 604_800 } }
          : {
            primary_window: {
              used_percent: sample.usage, limit_window_seconds: calls === 4 ? 3_600 : 18_000, reset_at: 4_000_000_000,
            },
            ...(sample.weekly ? { secondary_window: { used_percent: 99, limit_window_seconds: 604_800 } } : {}),
          },
        });
      }, { preconnect: globalThis.fetch.preconnect });
      const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(stubFetch);
      try {
        await fetchMainAccountInfo(true);
        expect(getMainAccountHardLockStatus({ codexMainAccountHardLock: true }).state).toBe("blocked");
        const info = await fetchMainAccountInfo(true);
        expect(calls).toBe(2);
        expect(info.quota).toMatchObject({ shortWindowSeconds: 18_000, shortResetAt: 4_000_000_000 });
        expect(info.quota).not.toHaveProperty("shortPercent");
        expect(getMainPolicyQuota()).toMatchObject({ weeklyPercent: 99, shortWindowSeconds: 18_000 });
        expect(getMainPolicyQuota()).not.toHaveProperty("shortPercent");
        expect(matchesMainQuotaCredential(accessToken, "fixture-main-a")).toBe(true);
        expect(getMainAccountHardLockStatus({ codexMainAccountHardLock: true })).toEqual({ enabled: true, state: "unknown" });
        // The paired case: unknown metadata must not erase a previously measured short99.
        await fetchMainAccountInfo(true);
        await fetchMainAccountInfo(true);
        expect(calls).toBe(4);
        for (const stored of [getAccountQuota(MAIN), getMainPolicyQuota()]) {
          expect(stored).toMatchObject({ shortPercent: 99, shortWindowSeconds: 18_000, shortResetAt: 3_000_000_000 });
        }
        const enabled = { codexMainAccountHardLock: true };
        expect(getMainAccountHardLockStatus(enabled, 3_000_000_000_000 - 1).state).toBe("blocked");
        expect(getMainAccountHardLockStatus(enabled, 3_000_000_000_000).state).toBe("unknown");
        await fetchMainAccountInfo(true);
        expect(calls).toBe(5);
        expect(getMainPolicyQuota()).toMatchObject({ shortPercent: 0, shortResetAt: 4_000_000_000 });
        expect(getMainAccountHardLockStatus(enabled, 3_000_000_000_000 - 1).state).toBe("ready");
      } finally {
        fetchSpy.mockRestore();
        resetLifecycleDrainStateForTests();
        setMainAccountPlan(null);
        try {
          await flushConfigDirHardeningForTests();
        } finally {
          setIcaclsRunnerForTests(null);
          setAsyncIcaclsRunnerForTests(null);
        }
      }
    });

    test(`headers preserve ${sample.name} instead of falling back to weekly99`, () => {
      const writer = writerFor();
      setAccountQuotaFromParsed(MAIN, { weeklyPercent: 99 }, undefined, writer);
      expect(getMainAccountHardLockStatus({ codexMainAccountHardLock: true }).state).toBe("blocked");
      const headers = new Headers({
        "x-codex-primary-window-minutes": "300", "x-codex-primary-reset-at": "4000000000",
        ...(sample.usage === undefined ? {} : { "x-codex-primary-used-percent": sample.usage }),
        ...(sample.weekly ? { "x-codex-secondary-used-percent": "99" } : {}),
      });
      applyAccountQuotaFromUpstreamHeaders(MAIN, headers, undefined, writer);
      expect(getMainPolicyQuota()).toMatchObject({
        weeklyPercent: 99, shortWindowSeconds: 18_000, shortResetAt: 4_000_000_000,
      });
      expect(getMainPolicyQuota()).not.toHaveProperty("shortPercent");
      expect(getMainAccountHardLockStatus({ codexMainAccountHardLock: true })).toEqual({ enabled: true, state: "unknown" });
      applyAccountQuotaFromUpstreamHeaders(MAIN, new Headers({
        "x-codex-primary-used-percent": "99", "x-codex-primary-window-minutes": "300",
        "x-codex-primary-reset-at": "3000000000",
      }), undefined, writer);
      headers.set("x-codex-primary-window-minutes", "60");
      applyAccountQuotaFromUpstreamHeaders(MAIN, headers, undefined, writer);
      for (const stored of [getAccountQuota(MAIN), getMainPolicyQuota()]) {
        expect(stored).toMatchObject({ shortPercent: 99, shortWindowSeconds: 18_000, shortResetAt: 3_000_000_000 });
      }
      const enabled = { codexMainAccountHardLock: true };
      expect(getMainAccountHardLockStatus(enabled, 3_000_000_000_000 - 1).state).toBe("blocked");
      expect(getMainAccountHardLockStatus(enabled, 3_000_000_000_000).state).toBe("unknown");
      headers.set("x-codex-primary-used-percent", "0");
      applyAccountQuotaFromUpstreamHeaders(MAIN, headers, undefined, writer);
      expect(getMainPolicyQuota()).toMatchObject({ shortPercent: 0, shortWindowSeconds: 3_600, shortResetAt: 4_000_000_000 });
      expect(getMainAccountHardLockStatus(enabled, 3_000_000_000_000 - 1).state).toBe("ready");
    });
  }
});
