import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAIN_CODEX_ACCOUNT_ID as MAIN } from "../../src/codex/account-id";
import { getMainAccountHardLockStatus } from "../../src/codex/main-account-hard-lock";
import { fetchMainAccountInfo } from "../../src/codex/auth-api";
import * as authCollision from "../../src/codex/auth-collision";
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
let observationTime: number;
let restoreObservationClock: () => void;

beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  previousCodexHome = process.env.CODEX_HOME;
  previousFetch = globalThis.fetch;
  observationTime = Date.now();
  const clock = spyOn(Date, "now").mockImplementation(() => observationTime);
  restoreObservationClock = () => clock.mockRestore();
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
  restoreObservationClock();
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
  for (const slot of ["primary", "secondary", "tertiary"] as const) {
    const invalidValues = [-1, "-1", -0.01, " -0.01 ", 101, "101", 100.01, "100.01",
      Infinity, -Infinity, "Infinity", "-Infinity", "NaN", "1e400", "-1e400"];
    test.each(invalidValues)(`owned WHAM ${slot} invalid %s stays unknown or retains short99 until valid zero`, async value => {
      const aclOk = { success: true, exitCode: 0, timedOut: false, stdout: "" };
      setIcaclsRunnerForTests(() => aclOk);
      setAsyncIcaclsRunnerForTests(async () => aclOk);
      writeFileSync(join(testDir, "auth.json"), JSON.stringify({ tokens: {
        access_token: "fixture-main-token", account_id: "fixture-main-a",
      } }));
      let calls = 0;
      let invalid = true;
      let percent = 0;
      globalThis.fetch = Object.assign(async (input: Parameters<typeof fetch>[0]) => {
        expect(String(input)).toBe("https://chatgpt.com/backend-api/wham/usage");
        calls += 1;
        const data = { plan_type: "plus", rate_limit: {
          primary_window: { used_percent: percent,
            limit_window_seconds: 18_000, reset_at: 1 },
          secondary_window: { used_percent: 0, limit_window_seconds: 604_800 },
          tertiary_window: { used_percent: 0 },
        } };
        // Raw JSON overflow reaches resp.json as a nonfinite number, not JSON.stringify's null.
        const body = JSON.stringify(data, (key, item: unknown) => key === `${slot}_window` && invalid
          ? { ...(item as object), used_percent: typeof value === "number" && !Number.isFinite(value) ? "raw-overflow" : value }
          : item).replace('"raw-overflow"', value === -Infinity ? "-1e400" : "1e400");
        return new Response(body, { headers: { "Content-Type": "application/json" } });
      }, { preconnect: previousFetch.preconnect });
      const enabled = { codexMainAccountHardLock: true };
      await fetchMainAccountInfo(true);
      expect(getMainAccountHardLockStatus(enabled).state).toBe("unknown");
      invalid = false;
      percent = 99;
      await fetchMainAccountInfo(true);
      const retained = getMainPolicyQuota();
      expect(getMainAccountHardLockStatus(enabled)).toEqual({ enabled: true, state: "blocked" });
      invalid = true;
      percent = 0;
      await fetchMainAccountInfo(true);
      if (slot === "primary" && Number.isFinite(Number(value))) {
        expect(getAccountQuota(MAIN)?.shortPercent).toBe(Number(value) < 0 ? 0 : 100);
      }
      expect(getMainPolicyQuota()).toEqual(retained);
      expect(getMainAccountHardLockStatus(enabled).state).toBe("blocked");
      invalid = false;
      await fetchMainAccountInfo(true);
      expect(getMainAccountHardLockStatus(enabled)).toEqual({ enabled: true, state: "ready" });
      percent = 99;
      await fetchMainAccountInfo(true);
      expect(calls).toBe(5);
      expect(getMainAccountHardLockStatus(enabled).state).toBe("blocked");
    });

    test.each(invalidValues)(`header ${slot} invalid %s stays unknown or retains short99 until valid zero`, value => {
      const writer = writerFor();
      const enabled = { codexMainAccountHardLock: true };
      const headers = new Headers({
        "x-codex-primary-used-percent": "0", "x-codex-primary-window-minutes": "300",
        "x-codex-primary-reset-at": "1", "x-codex-secondary-used-percent": "0",
        "x-codex-tertiary-used-percent": "0",
      });
      headers.set(`x-codex-${slot}-used-percent`, String(value));
      applyAccountQuotaFromUpstreamHeaders(MAIN, headers, undefined, writer);
      expect(getMainAccountHardLockStatus(enabled).state).toBe("unknown");
      headers.set(`x-codex-${slot}-used-percent`, "0");
      headers.set("x-codex-primary-used-percent", "99");
      applyAccountQuotaFromUpstreamHeaders(MAIN, headers, undefined, writer);
      const retained = getMainPolicyQuota();
      expect(getMainAccountHardLockStatus(enabled)).toEqual({ enabled: true, state: "blocked" });
      headers.set("x-codex-primary-used-percent", "0");
      headers.set(`x-codex-${slot}-used-percent`, String(value));
      applyAccountQuotaFromUpstreamHeaders(MAIN, headers, undefined, writer);
      if (slot === "primary" && Number.isFinite(Number(value))) {
        expect(getAccountQuota(MAIN)?.shortPercent).toBe(Number(value) < 0 ? 0 : 100);
      }
      expect(getMainPolicyQuota()).toEqual(retained);
      expect(getMainAccountHardLockStatus(enabled).state).toBe("blocked");
      headers.set(`x-codex-${slot}-used-percent`, "0");
      applyAccountQuotaFromUpstreamHeaders(MAIN, headers, undefined, writer);
      expect(getMainAccountHardLockStatus(enabled)).toEqual({ enabled: true, state: "ready" });
      headers.set("x-codex-primary-used-percent", "99");
      applyAccountQuotaFromUpstreamHeaders(MAIN, headers, undefined, writer);
      expect(getMainAccountHardLockStatus(enabled).state).toBe("blocked");
    });
  }

  for (const transport of ["wham", "headers"] as const) {
    for (const shape of ["supplementary", "primary", "missing-primary", "go", "free"] as const) {
      test(`${transport} ${shape} monthly requires governing evidence, preserving legacy bars`, async () => {
        const aclOk = { success: true, exitCode: 0, timedOut: false, stdout: "" };
        setIcaclsRunnerForTests(() => aclOk);
        setAsyncIcaclsRunnerForTests(async () => aclOk);
        writeFileSync(join(testDir, "auth.json"), JSON.stringify({ tokens: {
          access_token: "fixture-main-token", account_id: "fixture-main-a",
        } }));
        const writer = writerFor();
        const enabled = { codexMainAccountHardLock: true };
        const plan = shape === "go" || shape === "free" ? shape : "plus";
        // Even a cached plan must not cause headers to perform a physical auth lookup.
        setMainAccountPlan(plan);
        const accepted = shape === "primary" || (transport === "wham" && (shape === "go" || shape === "free"));
        let percent = 99;
        const publish = async () => {
          if (transport === "headers") {
            const headers = new Headers({ "x-codex-tertiary-used-percent": String(percent),
              "x-codex-tertiary-reset-at": "2000000000" });
            if (shape === "primary" || shape === "missing-primary") {
              headers.set("x-codex-primary-window-minutes", "43200");
              if (shape === "primary") headers.set("x-codex-primary-used-percent", String(percent));
            }
            const physicalRead = spyOn(authCollision, "readCodexTokensResult").mockImplementation(() => {
              throw new Error("Header observation must not read native credentials");
            });
            try {
              applyAccountQuotaFromUpstreamHeaders(MAIN, headers, undefined, writer);
              expect(physicalRead).not.toHaveBeenCalled();
            } finally { physicalRead.mockRestore(); }
          } else await fetchMainAccountInfo(true);
        };
        const calls: string[] = [];
        globalThis.fetch = Object.assign(async (input: Parameters<typeof fetch>[0]) => {
          calls.push(String(input));
          return Response.json({ plan_type: plan, rate_limit: {
            tertiary_window: { used_percent: percent, reset_at: 2_000_000_000 },
            ...(shape === "primary" || shape === "missing-primary" ? { primary_window: {
              limit_window_seconds: 2_592_000, ...(shape === "primary" ? { used_percent: percent } : {}),
            } } : {}),
          } });
        }, { preconnect: previousFetch.preconnect });
        await publish();
        expect(getAccountQuota(MAIN)?.monthlyPercent).toBe(99);
        expect(getMainAccountHardLockStatus(enabled).state).toBe(accepted ? "blocked" : "unknown");
        if (!accepted) {
          expect(getMainPolicyQuota()).toBeNull();
          // Filtered-empty input must neither replace an existing block nor alter its timestamp.
          setAccountQuotaFromParsed(MAIN, { monthlyPercent: 99, monthlyIsPrimaryWindow: true }, undefined,
            captureMainQuotaWriter("fixture-main-a"));
        }
        const retained = getMainPolicyQuota();
        percent = 0;
        await publish();
        expect(getAccountQuota(MAIN)?.monthlyPercent).toBe(0);
        expect(getMainAccountHardLockStatus(enabled).state).toBe(accepted ? "ready" : "blocked");
        if (!accepted) expect(getMainPolicyQuota()).toEqual(retained);
        percent = 99;
        await publish();
        expect(getMainAccountHardLockStatus(enabled).state).toBe("blocked");
        expect(calls).toEqual(transport === "headers" ? [] : Array(3).fill("https://chatgpt.com/backend-api/wham/usage"));
      });
    }
  }

  test.each([0, "0", 98.99, "98.99", 99, "99", 100, "100"])("owned WHAM and headers accept valid boundary %s", async value => {
    const aclOk = { success: true, exitCode: 0, timedOut: false, stdout: "" };
    setIcaclsRunnerForTests(() => aclOk);
    setAsyncIcaclsRunnerForTests(async () => aclOk);
    writeFileSync(join(testDir, "auth.json"), JSON.stringify({ tokens: {
      access_token: "fixture-main-token", account_id: "fixture-main-a",
    } }));
    let calls = 0;
    globalThis.fetch = Object.assign(async (input: Parameters<typeof fetch>[0]) => {
      expect(String(input)).toBe("https://chatgpt.com/backend-api/wham/usage");
      calls += 1;
      return Response.json({ plan_type: "plus", rate_limit: { primary_window: { used_percent: value } } });
    }, { preconnect: previousFetch.preconnect });
    await fetchMainAccountInfo(true);
    const cfg = { codexMainAccountHardLock: true };
    expect(getMainPolicyQuota()?.weeklyPercent).toBe(Number(value));
    expect(getMainAccountHardLockStatus(cfg).state).toBe(Number(value) < 99 ? "ready" : "blocked");
    clearAccountQuota();
    applyAccountQuotaFromUpstreamHeaders(MAIN, new Headers({ "x-codex-primary-used-percent": String(value) }),
      undefined, writerFor());
    expect(getMainPolicyQuota()?.weeklyPercent).toBe(Number(value));
    expect(getMainAccountHardLockStatus(cfg).state).toBe(Number(value) < 99 ? "ready" : "blocked");
    expect(calls).toBe(1);
  });

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
        expect(getMainPolicyQuota()).not.toHaveProperty("shortObservedAt");
        expect(matchesMainQuotaCredential(accessToken, "fixture-main-a")).toBe(true);
        expect(getMainAccountHardLockStatus({ codexMainAccountHardLock: true })).toEqual({ enabled: true, state: "unknown" });
        // Unknown metadata replaces the legacy tuple but must retain trusted policy short99.
        const firstShortObservedAt = observationTime;
        await fetchMainAccountInfo(true);
        expect(getMainPolicyQuota()?.shortObservedAt).toBe(firstShortObservedAt);
        observationTime += 60_000;
        await fetchMainAccountInfo(true);
        expect(calls).toBe(4);
        expect(getAccountQuota(MAIN)).toEqual({ weeklyPercent: 99, shortWindowSeconds: 3_600,
          shortResetAt: 4_000_000_000, updatedAt: observationTime });
        expect(getMainPolicyQuota()).toEqual({ weeklyPercent: 99, shortPercent: 99, shortWindowSeconds: 18_000,
          shortResetAt: 3_000_000_000, shortObservedAt: firstShortObservedAt, updatedAt: observationTime });
        const enabled = { codexMainAccountHardLock: true };
        expect(getMainAccountHardLockStatus(enabled, 3_000_000_000_000 - 1).state).toBe("blocked");
        expect(getMainAccountHardLockStatus(enabled, 3_000_000_000_000)).toEqual({ enabled: true, state: "blocked" });
        observationTime += 60_000;
        await fetchMainAccountInfo(true);
        expect(calls).toBe(5);
        expect(getMainPolicyQuota()).toMatchObject({ shortPercent: 0, shortResetAt: 4_000_000_000, shortObservedAt: observationTime });
        expect(getAccountQuota(MAIN)?.shortObservedAt).toBe(observationTime);
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
      expect(getMainPolicyQuota()).not.toHaveProperty("shortObservedAt");
      expect(getMainAccountHardLockStatus({ codexMainAccountHardLock: true })).toEqual({ enabled: true, state: "unknown" });
      const firstShortObservedAt = observationTime;
      applyAccountQuotaFromUpstreamHeaders(MAIN, new Headers({
        "x-codex-primary-used-percent": "99", "x-codex-primary-window-minutes": "300",
        "x-codex-primary-reset-at": "3000000000",
      }), undefined, writer);
      expect(getMainPolicyQuota()?.shortObservedAt).toBe(firstShortObservedAt);
      observationTime += 60_000;
      headers.set("x-codex-primary-window-minutes", "60");
      applyAccountQuotaFromUpstreamHeaders(MAIN, headers, undefined, writer);
      expect(getAccountQuota(MAIN)).toEqual({ weeklyPercent: 99, shortWindowSeconds: 3_600,
        shortResetAt: 4_000_000_000, updatedAt: observationTime });
      expect(getMainPolicyQuota()).toEqual({ weeklyPercent: 99, shortPercent: 99, shortWindowSeconds: 18_000,
        shortResetAt: 3_000_000_000, shortObservedAt: firstShortObservedAt, updatedAt: observationTime });
      const enabled = { codexMainAccountHardLock: true };
      expect(getMainAccountHardLockStatus(enabled, 3_000_000_000_000 - 1).state).toBe("blocked");
      expect(getMainAccountHardLockStatus(enabled, 3_000_000_000_000)).toEqual({ enabled: true, state: "blocked" });
      headers.set("x-codex-primary-used-percent", "0");
      observationTime += 60_000;
      applyAccountQuotaFromUpstreamHeaders(MAIN, headers, undefined, writer);
      expect(getMainPolicyQuota()).toMatchObject({ shortPercent: 0, shortWindowSeconds: 3_600,
        shortResetAt: 4_000_000_000, shortObservedAt: observationTime });
      expect(getAccountQuota(MAIN)?.shortObservedAt).toBe(observationTime);
      expect(getMainAccountHardLockStatus(enabled, 3_000_000_000_000 - 1).state).toBe("ready");
    });
  }
});
