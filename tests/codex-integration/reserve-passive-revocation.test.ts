import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fetchMainAccountInfo } from "../../src/codex/auth-api";
import { resetMainCodexAccountIdentityTrackingForTests } from "../../src/codex/account-lifecycle";
import { setMainAccountPlan } from "../../src/codex/main-account";
import {
  captureMainQuotaWriter,
  clearMainAccountInfoCache,
  getMainQuotaCredentialGeneration,
  observeMainQuotaCredential,
} from "../../src/codex/main-account-cache";
import { clearAccountQuota } from "../../src/codex/quota";
import {
  getMainReserveAuthorization,
  isMainReserveAuthorizationLive,
} from "../../src/codex/reserve-availability";
import { flushConfigDirHardeningForTests } from "../../src/config/paths";
import { resetLifecycleDrainStateForTests } from "../../src/server/lifecycle";
import { setAsyncIcaclsRunnerForTests, setIcaclsRunnerForTests } from "../../src/lib/windows-secret-acl";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const ACCOUNT = "fixture-passive-reserve-main";
const TOKEN_A = "fixture-passive-reserve-token-a";
const TOKEN_B = "fixture-passive-reserve-token-b";
let directory: string;
let previousHome: string | undefined;
let previousCodexHome: string | undefined;
let previousFetch: typeof fetch;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

function writeCredential(accessToken: string): void {
  writeFileSync(join(directory, "auth.json"), JSON.stringify({ tokens: {
    access_token: accessToken, account_id: ACCOUNT,
  } }));
}

function ordinaryResponse(): Response {
  return Response.json({
    plan_type: "plus",
    rate_limit: { allowed: true, primary_window: { used_percent: 10, limit_window_seconds: 18_000 } },
  });
}

beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  previousCodexHome = process.env.CODEX_HOME;
  previousFetch = globalThis.fetch;
  directory = mkdtempSync(join(tmpdir(), "ocx-reserve-passive-"));
  process.env.OPENCODEX_HOME = directory;
  process.env.CODEX_HOME = directory;
  clearAccountQuota();
  clearMainAccountInfoCache();
  resetMainCodexAccountIdentityTrackingForTests();
  resetLifecycleDrainStateForTests();
  setMainAccountPlan(null);
  const aclOk = { success: true, exitCode: 0, timedOut: false, stdout: "" };
  setIcaclsRunnerForTests(() => aclOk);
  setAsyncIcaclsRunnerForTests(async () => aclOk);
});

afterEach(async () => {
  globalThis.fetch = previousFetch;
  // Clear the quota persistence timer while the fixture still owns both homes.
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
    removeTreeWithRetry(directory);
  }
});

describe("passive WHAM Reserve revocation producer", () => {
  test.each([false, true])("late A cannot revoke the new grant after token replacement, return to A=%s", async returnToA => {
    writeCredential(TOKEN_A);
    const started = deferred<void>();
    const delayed = deferred<Response>();
    let passiveCalls = 0;
    let capabilityCalls = 0;
    const currentToken = returnToA ? TOKEN_A : TOKEN_B;
    globalThis.fetch = Object.assign(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      expect(String(input)).toBe("https://chatgpt.com/backend-api/wham/usage");
      const headers = new Headers(init?.headers);
      expect(headers.get("chatgpt-account-id")).toBe(ACCOUNT);
      if (headers.get("x-openai-codex-luna-reserve") === "1") {
        capabilityCalls += 1;
        expect(headers.get("authorization")).toBe(`Bearer ${currentToken}`);
        return Response.json({
          rate_limit: { allowed: false },
          rate_limit_upsell: { banner_type: "luna_reserve" },
          additional_rate_limits: [{ limit_name: "gpt-reserve", rate_limit: { allowed: true } }],
        });
      }
      passiveCalls += 1;
      expect(headers.get("x-openai-codex-luna-reserve")).toBeNull();
      expect(headers.get("authorization")).toBe(`Bearer ${passiveCalls === 1 ? TOKEN_A : currentToken}`);
      if (passiveCalls === 1) {
        started.resolve();
        return delayed.promise;
      }
      return ordinaryResponse();
    }, { preconnect: previousFetch.preconnect });

    const pending = fetchMainAccountInfo(true);
    try {
      await Promise.race([started.promise, pending.then(() => { throw new Error("Passive WHAM never started"); })]);
      const oldWriter = captureMainQuotaWriter(ACCOUNT);
      const oldEpoch = getMainQuotaCredentialGeneration();
      expect(oldWriter).toBeDefined();
      writeCredential(TOKEN_B);
      observeMainQuotaCredential(TOKEN_B, ACCOUNT);
      if (returnToA) writeCredential(TOKEN_A);
      const writer = observeMainQuotaCredential(currentToken, ACCOUNT);
      expect(writer).toEqual(oldWriter); // Workspace identity did not change.
      expect(getMainQuotaCredentialGeneration()).toBeGreaterThan(oldEpoch);
      const token = { accessToken: currentToken, chatgptAccountId: ACCOUNT };
      const authorization = await getMainReserveAuthorization({ token, writer, observeOrdinaryQuota: () => {} });
      expect(authorization).toBeDefined();
      expect(isMainReserveAuthorizationLive(authorization, token)).toBe(true);

      delayed.resolve(ordinaryResponse());
      const info = await pending;
      // Only Reserve revocation is fenced; the existing ordinary producer still completes.
      expect(info.quota).toMatchObject({ shortPercent: 10, shortWindowSeconds: 18_000 });
      expect(isMainReserveAuthorizationLive(authorization, token)).toBe(true);
      expect(passiveCalls).toBe(1);
      expect(capabilityCalls).toBe(1);

      // Positive control: a newly started passive read of the current bearer can revoke.
      await fetchMainAccountInfo(true);
      expect(passiveCalls).toBe(2);
      expect(isMainReserveAuthorizationLive(authorization, token)).toBe(false);
    } finally {
      delayed.resolve(ordinaryResponse());
      await pending;
    }
  });
});
