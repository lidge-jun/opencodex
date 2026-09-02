import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  primeCodexPoolQuotas,
  getAccountQuota,
  updateAccountQuota,
  clearAccountQuota,
  clearCodexQuotaPrimeState,
  clearCodexQuotaPrimeSingleFlightForTests,
  clearMainAccountInfoCache,
  seedCodexAuthAdmissionForTests,
  setCodexPoolQuotaTokenResolverForTests,
} from "../src/codex/auth-api";
import {
  CodexCredentialGenerationConflictError,
  CodexCredentialRefreshLockTimeoutError,
  readCodexAccountRecord,
  saveCodexAccountCredential,
} from "../src/codex/account-store";
import { resetMainCodexAccountIdentityTrackingForTests } from "../src/codex/account-lifecycle";
import { MAIN_CODEX_ACCOUNT_ID } from "../src/codex/main-account";
import {
  completeNativeMainRecovery,
  initializeNativeMainStartupGate,
} from "../src/codex/native-profile-startup";
import { handleNativeProfileAPI } from "../src/codex/native-profile-api";
import type { NativeProfileManager } from "../src/codex/native-profile-manager";
import { resolveCodexAccountForThread, clearThreadAccountMap } from "../src/codex/routing";
import {
  acquireNativeMainProfileDrain,
  getNativeMainProfileRequestCount,
  resetLifecycleDrainStateForTests,
} from "../src/server/lifecycle";
import type { OcxConfig } from "../src/types";
import { removeTreeWithRetry } from "./helpers/remove-tree";

// Phase 20 (260630_wsl-account-autoswitch): startup/lazy quota priming.

const TEST_DIR = join(import.meta.dir, ".tmp-codex-quota-prime-test");
const TEST_CODEX_HOME = join(TEST_DIR, "codex");
let previousOpencodexHome: string | undefined;
let previousCodexHome: string | undefined;

function makeConfig(overrides: Partial<OcxConfig> = {}): OcxConfig {
  return {
    port: 10100,
    providers: {
      openai: {
        adapter: "openai-responses",
        baseUrl: "https://chatgpt.com/backend-api/codex",
        authMode: "forward",
        codexAccountMode: "pool",
      },
    },
    defaultProvider: "openai",
    codexAccounts: [],
    ...overrides,
  } as OcxConfig;
}

function seedPoolAccount(config: OcxConfig, id: string, plan?: string): void {
  config.codexAccounts = [
    ...(config.codexAccounts ?? []),
    { id, email: `${id}@example.test`, plan, isMain: false },
  ];
  saveCodexAccountCredential(id, {
    accessToken: `access-${id}`,
    refreshToken: `refresh-${id}`,
    expiresAt: Date.now() + 5 * 60_000,
    chatgptAccountId: `acct-${id}`,
  });
}

function whamResponse(weekly: number) {
  return new Response(JSON.stringify({
    rate_limit: {
      secondary_window: { used_percent: weekly, reset_at: 1782000000 },
    },
  }), { status: 200, headers: { "Content-Type": "application/json" } });
}

function seedMainAccount(accountId = "main-account", accessToken = "main-access"): void {
  writeFileSync(join(TEST_CODEX_HOME, "auth.json"), JSON.stringify({
    tokens: { access_token: accessToken, account_id: accountId },
  }));
}

function switchRequest(): Request {
  return new Request("http://localhost/api/native-main-profiles/switch", {
    method: "POST",
    body: JSON.stringify({ target: "replacement", confirmedStopped: true }),
  });
}

describe("primeCodexPoolQuotas", () => {
  beforeEach(() => {
    previousOpencodexHome = process.env.OPENCODEX_HOME;
    previousCodexHome = process.env.CODEX_HOME;
    if (existsSync(TEST_DIR)) removeTreeWithRetry(TEST_DIR);
    mkdirSync(TEST_CODEX_HOME, { recursive: true });
    process.env.OPENCODEX_HOME = TEST_DIR;
    // Isolate the main-account source: TEST_CODEX_HOME has no auth.json, so the
    // main account is deterministically absent and priming only touches the pool.
    process.env.CODEX_HOME = TEST_CODEX_HOME;
    clearAccountQuota();
    clearThreadAccountMap();
    clearCodexQuotaPrimeState();
    clearMainAccountInfoCache();
    resetMainCodexAccountIdentityTrackingForTests();
    resetLifecycleDrainStateForTests();
  });

  afterEach(() => {
    clearAccountQuota();
    clearThreadAccountMap();
    clearCodexQuotaPrimeState();
    clearMainAccountInfoCache();
    resetMainCodexAccountIdentityTrackingForTests();
    resetLifecycleDrainStateForTests();
    if (previousOpencodexHome === undefined) delete process.env.OPENCODEX_HOME;
    else process.env.OPENCODEX_HOME = previousOpencodexHome;
    if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousCodexHome;
    if (existsSync(TEST_DIR)) removeTreeWithRetry(TEST_DIR);
  });

  test("prime populates stale/unknown pool accounts", async () => {
    const config = makeConfig();
    seedPoolAccount(config, "p1");
    seedPoolAccount(config, "p2");
    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = async (input: RequestInfo | URL) => {
        if (String(input).includes("/backend-api/wham/usage")) return whamResponse(20);
        return originalFetch(input);
      };
      expect(getAccountQuota("p1")).toBeNull();
      await primeCodexPoolQuotas(config, "test");
      expect(getAccountQuota("p1")).not.toBeNull();
      expect(getAccountQuota("p2")).not.toBeNull();
      expect(getAccountQuota("p1")).toMatchObject({ weeklyPercent: 20 });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("in-flight main publication completes before a profile switch mutates state", async () => {
    seedMainAccount();
    const config = makeConfig({ activeCodexAccountId: MAIN_CODEX_ACCOUNT_ID });
    const originalFetch = globalThis.fetch;
    let releaseUsage!: () => void;
    const usageGate = new Promise<void>(resolve => { releaseUsage = resolve; });
    let markUsageStarted!: () => void;
    const usageStarted = new Promise<void>(resolve => { markUsageStarted = resolve; });
    globalThis.fetch = (async (input, init) => {
      if (!String(input).includes("/backend-api/wham/usage")) return originalFetch(input, init);
      markUsageStarted();
      await usageGate;
      return whamResponse(41);
    }) as typeof fetch;
    let switches = 0;
    const manager = {
      switch: async () => {
        switches += 1;
        expect(getAccountQuota(MAIN_CODEX_ACCOUNT_ID)).toMatchObject({ weeklyPercent: 41 });
        clearAccountQuota(MAIN_CODEX_ACCOUNT_ID);
        return { ok: true };
      },
    } as unknown as NativeProfileManager;
    try {
      const prime = primeCodexPoolQuotas(config, "in-flight-switch");
      await usageStarted;
      expect(getNativeMainProfileRequestCount()).toBe(1);
      const switching = handleNativeProfileAPI(
        switchRequest(),
        new URL("http://localhost/api/native-main-profiles/switch"),
        config,
        { manager, drainTimeoutMs: 5_000 },
      );
      await Bun.sleep(20);
      expect(switches).toBe(0);
      releaseUsage();
      await prime;
      expect((await switching)?.status).toBe(200);
      expect(switches).toBe(1);
      expect(getAccountQuota(MAIN_CODEX_ACCOUNT_ID)).toBeNull();
      expect(getNativeMainProfileRequestCount()).toBe(0);
    } finally {
      releaseUsage();
      globalThis.fetch = originalFetch;
    }
  });

  test("main prime retains ownership through identity retry and final publication", async () => {
    seedMainAccount("main-account", "main-access");
    const config = makeConfig({ activeCodexAccountId: MAIN_CODEX_ACCOUNT_ID });
    const originalFetch = globalThis.fetch;
    const requestedAccounts: string[] = [];
    let releaseFirst!: () => void;
    let releaseRetry!: () => void;
    const firstGate = new Promise<void>(resolve => { releaseFirst = resolve; });
    const retryGate = new Promise<void>(resolve => { releaseRetry = resolve; });
    let markFirstStarted!: () => void;
    let markRetryStarted!: () => void;
    const firstStarted = new Promise<void>(resolve => { markFirstStarted = resolve; });
    const retryStarted = new Promise<void>(resolve => { markRetryStarted = resolve; });
    globalThis.fetch = (async (input, init) => {
      if (!String(input).includes("/backend-api/wham/usage")) return originalFetch(input, init);
      const accountId = new Headers(init?.headers).get("ChatGPT-Account-Id") ?? "";
      requestedAccounts.push(accountId);
      if (requestedAccounts.length === 1) {
        markFirstStarted();
        await firstGate;
        return whamResponse(91);
      }
      markRetryStarted();
      await retryGate;
      return whamResponse(12);
    }) as typeof fetch;
    let switches = 0;
    const manager = {
      switch: async () => {
        switches += 1;
        expect(getAccountQuota(MAIN_CODEX_ACCOUNT_ID)).toMatchObject({ weeklyPercent: 12 });
        clearAccountQuota(MAIN_CODEX_ACCOUNT_ID);
        return { ok: true };
      },
    } as unknown as NativeProfileManager;
    try {
      const prime = primeCodexPoolQuotas(config, "identity-retry");
      await firstStarted;
      seedMainAccount("replacement-account", "replacement-access");
      const switching = handleNativeProfileAPI(
        switchRequest(),
        new URL("http://localhost/api/native-main-profiles/switch"),
        config,
        { manager, drainTimeoutMs: 5_000 },
      );
      await Bun.sleep(20);
      expect(switches).toBe(0);
      releaseFirst();
      await retryStarted;
      expect(requestedAccounts).toEqual(["main-account", "replacement-account"]);
      expect(getNativeMainProfileRequestCount()).toBe(1);
      expect(switches).toBe(0);
      releaseRetry();
      await prime;
      expect((await switching)?.status).toBe(200);
      expect(switches).toBe(1);
      expect(getAccountQuota(MAIN_CODEX_ACCOUNT_ID)).toBeNull();
    } finally {
      releaseFirst();
      releaseRetry();
      globalThis.fetch = originalFetch;
    }
  });

  test("startup recovery skips every main operation while pool priming continues", async () => {
    seedMainAccount();
    const config = makeConfig({ activeCodexAccountId: MAIN_CODEX_ACCOUNT_ID });
    seedPoolAccount(config, "p1");
    const homeId = "quota-prime-recovery";
    await initializeNativeMainStartupGate({
      manager: { context: { homeId }, recover: async () => ({}) } as unknown as NativeProfileManager,
      probeRecoveryState: () => "manual",
    });
    const originalFetch = globalThis.fetch;
    let poolFetches = 0;
    let mainOperations = 0;
    globalThis.fetch = (async (input, init) => {
      if (!String(input).includes("/backend-api/wham/usage")) return originalFetch(input, init);
      if (new Headers(init?.headers).get("ChatGPT-Account-Id") === "acct-p1") poolFetches += 1;
      return whamResponse(22);
    }) as typeof fetch;
    try {
      await primeCodexPoolQuotas(config, "startup-recovery", {
        reconcileMainAccount: () => { mainOperations += 1; return false; },
        readMainTokens: () => { mainOperations += 1; return null; },
        fetchMainInfo: async () => {
          mainOperations += 1;
          return { email: null, plan: null, quota: null };
        },
      });
      expect(mainOperations).toBe(0);
      expect(poolFetches).toBe(1);
      expect(getAccountQuota("p1")).toMatchObject({ weeklyPercent: 22 });
      expect(getAccountQuota(MAIN_CODEX_ACCOUNT_ID)).toBeNull();
    } finally {
      completeNativeMainRecovery(homeId);
      globalThis.fetch = originalFetch;
    }
  });

  test("active main drain skips only main priming and preserves pool continuity", async () => {
    seedMainAccount();
    const config = makeConfig({ activeCodexAccountId: "p1" });
    seedPoolAccount(config, "p1");
    const drain = acquireNativeMainProfileDrain("quota-prime-pool-only");
    const originalFetch = globalThis.fetch;
    let poolFetches = 0;
    let mainOperations = 0;
    globalThis.fetch = (async (input, init) => {
      if (!String(input).includes("/backend-api/wham/usage")) return originalFetch(input, init);
      if (new Headers(init?.headers).get("ChatGPT-Account-Id") === "acct-p1") poolFetches += 1;
      return whamResponse(18);
    }) as typeof fetch;
    try {
      await primeCodexPoolQuotas(config, "active-drain", {
        reconcileMainAccount: () => { mainOperations += 1; return false; },
        readMainTokens: () => { mainOperations += 1; return null; },
        fetchMainInfo: async () => {
          mainOperations += 1;
          return { email: null, plan: null, quota: null };
        },
      });
      expect(mainOperations).toBe(0);
      expect(poolFetches).toBe(1);
      expect(getAccountQuota("p1")).toMatchObject({ weeklyPercent: 18 });
      expect(getNativeMainProfileRequestCount()).toBe(0);
    } finally {
      drain?.release();
      globalThis.fetch = originalFetch;
    }
  });

  test("direct, API-only, and disabled OpenAI configurations never prime the Codex pool", async () => {
    const originalFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = async () => {
      calls += 1;
      return whamResponse(20);
    };
    try {
      for (const providers of [
        { openai: { adapter: "openai-responses", baseUrl: "https://chatgpt.com/backend-api/codex", authMode: "forward" as const, codexAccountMode: "direct" as const } },
        { "openai-apikey": { adapter: "openai-responses", baseUrl: "https://api.openai.com/v1", apiKey: "sk-test" } },
        { openai: { adapter: "openai-responses", baseUrl: "https://chatgpt.com/backend-api/codex", authMode: "forward" as const, codexAccountMode: "pool" as const, disabled: true } },
      ]) {
        const cfg = makeConfig({ providers });
        seedPoolAccount(cfg, `disabled-${calls}-${Object.keys(providers)[0]}`);
        await primeCodexPoolQuotas(cfg, "disabled-test");
      }
      expect(calls).toBe(0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("single-flight coalesces concurrent callers into one pass", async () => {
    const config = makeConfig();
    seedPoolAccount(config, "p1");
    seedPoolAccount(config, "p2");
    const originalFetch = globalThis.fetch;
    let calls = 0;
    try {
      globalThis.fetch = async (input: RequestInfo | URL) => {
        if (String(input).includes("/backend-api/wham/usage")) {
          calls += 1;
          await new Promise(r => setTimeout(r, 5));
          return whamResponse(20);
        }
        return originalFetch(input);
      };
      const a = primeCodexPoolQuotas(config, "test-a");
      const b = primeCodexPoolQuotas(config, "test-b");
      await Promise.all([a, b]);
      expect(calls).toBe(2); // one per pool account, not 2x per account
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("fresh cached quota is skipped (TTL guard)", async () => {
    const config = makeConfig();
    seedPoolAccount(config, "p1");
    updateAccountQuota("p1", 30); // recent updatedAt
    const originalFetch = globalThis.fetch;
    let calls = 0;
    try {
      globalThis.fetch = async (input: RequestInfo | URL) => {
        if (String(input).includes("/backend-api/wham/usage")) { calls += 1; return whamResponse(99); }
        return originalFetch(input);
      };
      await primeCodexPoolQuotas(config, "test");
      expect(calls).toBe(0);
      expect(getAccountQuota("p1")).toMatchObject({ weeklyPercent: 30 });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("credential-less pool accounts are skipped and stay unknown", async () => {
    const config = makeConfig({
      codexAccounts: [{ id: "nocred", email: "nocred@example.test", isMain: false }],
    });
    const originalFetch = globalThis.fetch;
    let calls = 0;
    try {
      globalThis.fetch = async (input: RequestInfo | URL) => {
        if (String(input).includes("/backend-api/wham/usage")) { calls += 1; return whamResponse(20); }
        return originalFetch(input);
      };
      await primeCodexPoolQuotas(config, "test");
      expect(calls).toBe(0);
      expect(getAccountQuota("nocred")).toBeNull();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("a failed pool quota fetch is throttled for the rest of the TTL window", async () => {
    const config = makeConfig();
    seedPoolAccount(config, "p1");
    const originalFetch = globalThis.fetch;
    let calls = 0;
    try {
      // Upstream is unavailable, so no quota is ever stored for this account. The
      // account therefore stays "unknown" and, without an attempt record, every
      // later prime re-selects it as stale and re-issues the same failing fetch.
      globalThis.fetch = async (input: RequestInfo | URL) => {
        if (String(input).includes("/backend-api/wham/usage")) {
          calls += 1;
          return new Response("upstream unavailable", { status: 503 });
        }
        return originalFetch(input);
      };
      await primeCodexPoolQuotas(config, "test");
      expect(calls).toBe(1);
      expect(getAccountQuota("p1")).toBeNull();

      // Only the single-flight promise is dropped between passes; the throttle state
      // must survive so a later trigger does not repeat the failing lookup.
      clearCodexQuotaPrimeSingleFlightForTests();
      await primeCodexPoolQuotas(config, "test");
      clearCodexQuotaPrimeSingleFlightForTests();
      await primeCodexPoolQuotas(config, "test");

      // A failed lookup must back off for the same POOL_CACHE_TTL window that a
      // successful one gets, instead of retrying on every prime trigger.
      expect(calls).toBe(1);
      expect(getAccountQuota("p1")).toBeNull();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("a real failed pool quota probe becomes eligible after the TTL expires", async () => {
    const originalNow = Date.now;
    let now = 1_800_000_000_000;
    Date.now = () => now;
    const config = makeConfig();
    seedPoolAccount(config, "p1");
    saveCodexAccountCredential("p1", {
      accessToken: "access-p1-long-lived",
      refreshToken: "refresh-p1-long-lived",
      expiresAt: now + 60 * 60_000,
      chatgptAccountId: "acct-p1",
    });
    const originalFetch = globalThis.fetch;
    let calls = 0;
    let upstreamHealthy = false;
    try {
      globalThis.fetch = async (input: RequestInfo | URL) => {
        if (String(input).includes("/backend-api/wham/usage")) {
          calls += 1;
          return upstreamHealthy ? whamResponse(20) : new Response("upstream unavailable", { status: 503 });
        }
        return originalFetch(input);
      };

      await primeCodexPoolQuotas(config, "test");
      expect(calls).toBe(1);

      now += 5 * 60_000 - 1;
      clearCodexQuotaPrimeSingleFlightForTests();
      await primeCodexPoolQuotas(config, "test");
      expect(calls).toBe(1);

      now += 1;
      upstreamHealthy = true;
      clearCodexQuotaPrimeSingleFlightForTests();
      await primeCodexPoolQuotas(config, "test");
      expect(calls).toBe(2);
      expect(getAccountQuota("p1")).toMatchObject({ weeklyPercent: 20 });
    } finally {
      globalThis.fetch = originalFetch;
      Date.now = originalNow;
    }
  });

  test("removing an account from the pool purges its failed-prime backoff", async () => {
    const config = makeConfig();
    seedPoolAccount(config, "p1");
    const originalPool = [...(config.codexAccounts ?? [])];
    const originalFetch = globalThis.fetch;
    let calls = 0;
    let upstreamHealthy = false;
    try {
      globalThis.fetch = async (input: RequestInfo | URL) => {
        if (String(input).includes("/backend-api/wham/usage")) {
          calls += 1;
          return upstreamHealthy ? whamResponse(20) : new Response("upstream unavailable", { status: 503 });
        }
        return originalFetch(input);
      };

      await primeCodexPoolQuotas(config, "test");
      expect(calls).toBe(1);

      config.codexAccounts = [];
      clearCodexQuotaPrimeSingleFlightForTests();
      await primeCodexPoolQuotas(config, "removed");

      config.codexAccounts = originalPool;
      upstreamHealthy = true;
      clearCodexQuotaPrimeSingleFlightForTests();
      await primeCodexPoolQuotas(config, "restored");
      expect(calls).toBe(2);
      expect(getAccountQuota("p1")).toMatchObject({ weeklyPercent: 20 });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("removal purges the backoff even while the provider is disabled", async () => {
    // The prune used to sit AFTER the provider-eligibility early return, so a removal
    // that happened while the provider was disabled (or out of pool mode) left the
    // stale failure marker in place. Restoring the same account id within
    // POOL_CACHE_TTL then read that old failure as current and skipped the retry the
    // restored credential is entitled to.
    const config = makeConfig();
    seedPoolAccount(config, "p1");
    const originalPool = [...(config.codexAccounts ?? [])];
    const originalFetch = globalThis.fetch;
    let calls = 0;
    let upstreamHealthy = false;
    try {
      globalThis.fetch = async (input: RequestInfo | URL) => {
        if (String(input).includes("/backend-api/wham/usage")) {
          calls += 1;
          return upstreamHealthy ? whamResponse(20) : new Response("upstream unavailable", { status: 503 });
        }
        return originalFetch(input);
      };

      // One failed prime records the backoff marker.
      await primeCodexPoolQuotas(config, "test");
      expect(calls).toBe(1);

      // The account is removed while the provider is disabled: the prime returns early,
      // but the marker must still be pruned.
      config.codexAccounts = [];
      config.providers.openai!.disabled = true;
      clearCodexQuotaPrimeSingleFlightForTests();
      await primeCodexPoolQuotas(config, "removed-while-disabled");
      expect(calls).toBe(1);

      // Restored and re-enabled inside the TTL window: the prime must dispatch now.
      config.codexAccounts = originalPool;
      config.providers.openai!.disabled = false;
      upstreamHealthy = true;
      clearCodexQuotaPrimeSingleFlightForTests();
      await primeCodexPoolQuotas(config, "restored");
      expect(calls).toBe(2);
      expect(getAccountQuota("p1")).toMatchObject({ weeklyPercent: 20 });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("a late failed probe cannot restore backoff for an account removed in flight", async () => {
    const config = makeConfig();
    seedPoolAccount(config, "p1");
    const originalPool = [...(config.codexAccounts ?? [])];
    const originalFetch = globalThis.fetch;
    let calls = 0;
    let upstreamHealthy = false;
    let releaseFirst!: () => void;
    const firstDispatched = new Promise<void>(resolve => { releaseFirst = resolve; });
    let finishFirst!: () => void;
    const firstGate = new Promise<void>(resolve => { finishFirst = resolve; });
    try {
      globalThis.fetch = async (input: RequestInfo | URL) => {
        if (String(input).includes("/backend-api/wham/usage")) {
          calls += 1;
          if (calls === 1) {
            releaseFirst();
            await firstGate;
            return new Response("upstream unavailable", { status: 503 });
          }
          return upstreamHealthy ? whamResponse(20) : new Response("upstream unavailable", { status: 503 });
        }
        return originalFetch(input);
      };

      const firstPrime = primeCodexPoolQuotas(config, "test");
      await firstDispatched;
      config.codexAccounts = [];
      const removedPrime = primeCodexPoolQuotas(config, "removed");
      finishFirst();
      await Promise.all([firstPrime, removedPrime]);

      config.codexAccounts = originalPool;
      upstreamHealthy = true;
      clearCodexQuotaPrimeSingleFlightForTests();
      await primeCodexPoolQuotas(config, "restored");

      expect(calls).toBe(2);
      expect(getAccountQuota("p1")).toMatchObject({ weeklyPercent: 20 });
    } finally {
      finishFirst();
      globalThis.fetch = originalFetch;
    }
  });

  test("re-authenticating a failed account retries without waiting out the backoff", async () => {
    const config = makeConfig();
    seedPoolAccount(config, "p1");
    const originalFetch = globalThis.fetch;
    let calls = 0;
    let upstreamHealthy = false;
    try {
      globalThis.fetch = async (input: RequestInfo | URL) => {
        if (String(input).includes("/backend-api/wham/usage")) {
          calls += 1;
          return upstreamHealthy ? whamResponse(20) : new Response("down", { status: 503 });
        }
        return originalFetch(input);
      };
      await primeCodexPoolQuotas(config, "test");
      expect(calls).toBe(1);
      expect(getAccountQuota("p1")).toBeNull();

      // Throttled while the same credential keeps failing.
      clearCodexQuotaPrimeSingleFlightForTests();
      await primeCodexPoolQuotas(config, "test");
      expect(calls).toBe(1);

      // A re-authentication bumps the credential generation, which must invalidate the
      // backoff earned by the old credential instead of hiding a now-usable account.
      upstreamHealthy = true;
      saveCodexAccountCredential("p1", {
        accessToken: "access-p1-renewed",
        refreshToken: "refresh-p1-renewed",
        expiresAt: Date.now() + 5 * 60_000,
        chatgptAccountId: "acct-p1",
      });
      clearCodexQuotaPrimeSingleFlightForTests();
      await primeCodexPoolQuotas(config, "test");
      expect(calls).toBe(2);
      expect(getAccountQuota("p1")).toMatchObject({ weeklyPercent: 20 });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("an admission-busy prime does not back off an account it never probed", async () => {
    const config = makeConfig();
    seedPoolAccount(config, "p1");
    const originalFetch = globalThis.fetch;
    const releaseAdmission = seedCodexAuthAdmissionForTests({ quotaFlights: 16 });
    let whamCalls = 0;
    try {
      globalThis.fetch = async (input: RequestInfo | URL) => {
        if (String(input).includes("/backend-api/wham/usage")) {
          whamCalls += 1;
          return whamResponse(20);
        }
        return originalFetch(input);
      };
      await primeCodexPoolQuotas(config, "test");
      expect(whamCalls).toBe(0);
      expect(getAccountQuota("p1")).toBeNull();

      releaseAdmission();
      clearCodexQuotaPrimeSingleFlightForTests();
      await primeCodexPoolQuotas(config, "test");

      expect(whamCalls).toBe(1);
      expect(getAccountQuota("p1")).toMatchObject({ weeklyPercent: 20 });
    } finally {
      releaseAdmission();
      globalThis.fetch = originalFetch;
    }
  });

  test.each([
    ["credential generation conflict", () => new CodexCredentialGenerationConflictError()],
    ["refresh-lock timeout", () => new CodexCredentialRefreshLockTimeoutError()],
  ] as const)("a %s before dispatch does not back off the next prime", async (_label, makeError) => {
    const config = makeConfig();
    seedPoolAccount(config, "p1");
    const originalFetch = globalThis.fetch;
    let tokenAttempts = 0;
    let whamCalls = 0;
    try {
      globalThis.fetch = async (input: RequestInfo | URL) => {
        if (String(input).includes("/backend-api/wham/usage")) {
          whamCalls += 1;
          return whamResponse(20);
        }
        return originalFetch(input);
      };
      const getValidPoolToken = async () => {
        tokenAttempts += 1;
        if (tokenAttempts === 1) throw makeError();
        return {
          accessToken: "access-p1",
          chatgptAccountId: "acct-p1",
          generation: readCodexAccountRecord("p1")!.generation,
        };
      };
      const restoreTokenResolver = setCodexPoolQuotaTokenResolverForTests(getValidPoolToken);

      try {
        await primeCodexPoolQuotas(config, "test");
        clearCodexQuotaPrimeSingleFlightForTests();
        await primeCodexPoolQuotas(config, "test");
      } finally {
        restoreTokenResolver();
      }

      expect(tokenAttempts).toBe(2);
      expect(whamCalls).toBe(1);
      expect(getAccountQuota("p1")).toMatchObject({ weeklyPercent: 20 });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("a refreshed credential keeps the backoff earned by its failed WHAM request", async () => {
    const config = makeConfig();
    seedPoolAccount(config, "p1");
    saveCodexAccountCredential("p1", {
      accessToken: "expiring-p1",
      refreshToken: "refresh-p1",
      expiresAt: Date.now() + 30_000,
      chatgptAccountId: "acct-p1",
    });
    const startGeneration = readCodexAccountRecord("p1")?.generation;
    const originalFetch = globalThis.fetch;
    let oauthCalls = 0;
    let whamCalls = 0;
    try {
      globalThis.fetch = async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("/oauth/token")) {
          oauthCalls += 1;
          return Response.json({
            access_token: "fresh-p1",
            refresh_token: "fresh-refresh-p1",
            expires_in: 3600,
          });
        }
        if (url.includes("/backend-api/wham/usage")) {
          whamCalls += 1;
          return new Response("upstream unavailable", { status: 503 });
        }
        return originalFetch(input);
      };

      await primeCodexPoolQuotas(config, "test");
      expect(oauthCalls).toBe(1);
      expect(whamCalls).toBe(1);
      expect(readCodexAccountRecord("p1")?.generation).toBe((startGeneration ?? 0) + 1);
      expect(getAccountQuota("p1")).toBeNull();

      clearCodexQuotaPrimeSingleFlightForTests();
      await primeCodexPoolQuotas(config, "test");

      expect(oauthCalls).toBe(1);
      expect(whamCalls).toBe(1);
      expect(getAccountQuota("p1")).toBeNull();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("a failed 401 replay binds backoff to the replay credential generation", async () => {
    const config = makeConfig();
    seedPoolAccount(config, "p1");
    const originalFetch = globalThis.fetch;
    let oauthCalls = 0;
    let whamCalls = 0;
    try {
      globalThis.fetch = async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("/oauth/token")) {
          oauthCalls += 1;
          return Response.json({
            access_token: "fresh-p1",
            refresh_token: "fresh-refresh-p1",
            expires_in: 3600,
          });
        }
        if (url.includes("/backend-api/wham/usage")) {
          whamCalls += 1;
          if (whamCalls === 1) {
            return Response.json({ error: { code: "transient_edge_rejection" } }, { status: 401 });
          }
          throw new Error("replay transport unavailable");
        }
        return originalFetch(input);
      };

      await primeCodexPoolQuotas(config, "test");
      expect(oauthCalls).toBe(1);
      expect(whamCalls).toBe(2);
      expect(getAccountQuota("p1")).toBeNull();

      clearCodexQuotaPrimeSingleFlightForTests();
      await primeCodexPoolQuotas(config, "test");

      expect(oauthCalls).toBe(1);
      expect(whamCalls).toBe(2);
      expect(getAccountQuota("p1")).toBeNull();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("one blocked account does not sink the rest", async () => {
    const config = makeConfig();
    seedPoolAccount(config, "ok");
    seedPoolAccount(config, "blocked");
    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        if (String(input).includes("/backend-api/wham/usage")) {
          const auth = (init?.headers as Record<string, string> | undefined)?.Authorization ?? "";
          if (auth.includes("blocked")) throw new Error("network blocked");
          return whamResponse(20);
        }
        return originalFetch(input);
      };
      await primeCodexPoolQuotas(config, "test");
      expect(getAccountQuota("ok")).not.toBeNull();
      expect(getAccountQuota("blocked")).toBeNull();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("priming defuses the Phase 10 all-unknown deadlock", async () => {
    const config = makeConfig({ activeCodexAccountId: "p1", autoSwitchThreshold: 80 });
    seedPoolAccount(config, "p1");
    seedPoolAccount(config, "p2");
    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        if (String(input).includes("/backend-api/wham/usage")) {
          const auth = (init?.headers as Record<string, string> | undefined)?.Authorization ?? "";
          // p1 hot (over threshold), p2 cool -> strict pick should choose p2.
          return auth.includes("p2") ? whamResponse(10) : whamResponse(90);
        }
        return originalFetch(input);
      };
      await primeCodexPoolQuotas(config, "test");
      expect(resolveCodexAccountForThread("primed-thread", config)).toBe("p2");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
