import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  CODEX_FAILURE_WINDOW_MS,
  CODEX_QUOTA_PROBE_INTERVAL_MS,
  CODEX_TRANSIENT_SOFT_AVOID_MS,
  CODEX_THREAD_AFFINITY_IDLE_TTL_MS,
  CODEX_THREAD_AFFINITY_MAX_ENTRIES,
  CODEX_THREAD_AFFINITY_REEVAL_INTERVAL_MS,
  classifyCodexUpstreamOutcome,
  clearCodexAccountCooldown,
  clearCodexUpstreamHealth,
  clearCodexUpstreamHealthForAccount,
  clearThreadAccountMap,
  clearThreadAccountMapForAccount,
  computeCodexUsageScore,
  getCodexAccountCooldownUntil,
  getCodexAccountSoftAvoidUntil,
  getCodexUpstreamHealth,
  isCodexAccountInCooldown,
  isCodexAccountSoftAvoided,
  pickLowestUsageCodexAccount,
  parseRetryAfterMs,
  recordCodexUpstreamOutcome,
  resetCodexRoutingForManualSelection,
  resolveCodexAccountForThread,
  resolveCodexAccountForThreadDetailed,
  tryAcquireCodexQuotaProbeLease,
} from "../src/codex/routing";
import { removeCodexAccountCredential, saveCodexAccountCredential } from "../src/codex/account-store";
import {
  clearAccountNeedsReauth,
  clearAccountQuota,
  handleCodexAuthAPI,
  isAccountNeedsReauth,
  parseUsageQuota,
  updateAccountQuota,
} from "../src/codex/auth-api";
import { CODEX_UNKNOWN_USAGE_SCORE } from "../src/codex/quota";
import { MAIN_CODEX_ACCOUNT_ID } from "../src/codex/main-account";
import { routeModel } from "../src/router";
import { consumeForInspection } from "../src/server/relay";
import type { OcxConfig } from "../src/types";

const TEST_DIR = join(import.meta.dir, ".tmp-codex-routing-test");
let previousOpencodexHome: string | undefined;
let previousCodexHome: string | undefined;

function makeConfig(overrides: Partial<OcxConfig> = {}): OcxConfig {
  return {
    providers: {},
    codexAccounts: [
      { id: "a", email: "a@test", isMain: false },
      { id: "b", email: "b@test", isMain: false },
    ],
    activeCodexAccountId: "a",
    autoSwitchThreshold: 80,
    upstreamFailoverThreshold: 3,
    ...overrides,
  } as OcxConfig;
}

function saveTestCredential(id: string): void {
  saveCodexAccountCredential(id, {
    accessToken: `access-${id}`,
    refreshToken: `refresh-${id}`,
    expiresAt: Date.now() + 5 * 60_000,
    chatgptAccountId: `acct-${id}`,
  });
}

const inspectionTick = () => new Promise(resolve => setTimeout(resolve, 5));

function pendingInspectionStream(): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({ start() {}, pull() {} });
}

describe("codex routing", () => {
  beforeEach(() => {
    previousOpencodexHome = process.env.OPENCODEX_HOME;
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    mkdirSync(TEST_DIR, { recursive: true });
    process.env.OPENCODEX_HOME = TEST_DIR;
    // Isolate the main-account credential source: TEST_DIR has no auth.json, so the main
    // account is deterministically absent (these cases test the pool-only scenario).
    previousCodexHome = process.env.CODEX_HOME;
    process.env.CODEX_HOME = TEST_DIR;
    clearThreadAccountMap();
    clearCodexUpstreamHealth();
    clearAccountQuota();
    clearAccountNeedsReauth("a");
    clearAccountNeedsReauth("b");
    clearAccountNeedsReauth("c");
    saveTestCredential("a");
    saveTestCredential("b");
  });

  afterEach(() => {
    clearAccountQuota();
    clearCodexUpstreamHealth();
    clearThreadAccountMap();
    clearAccountNeedsReauth("a");
    clearAccountNeedsReauth("b");
    clearAccountNeedsReauth("c");
    if (previousOpencodexHome === undefined) delete process.env.OPENCODEX_HOME;
    else process.env.OPENCODEX_HOME = previousOpencodexHome;
    if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousCodexHome;
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  });

  test("usage score uses the hottest known quota window", () => {
    expect(computeCodexUsageScore({ weeklyPercent: 81 })).toBe(81);
    expect(computeCodexUsageScore({ weeklyPercent: 15, monthlyPercent: 91 })).toBe(91);
    expect(computeCodexUsageScore({ weeklyPercent: 15 })).toBe(15);
  });

  test("go and free plans use only the 30d quota window", () => {
    expect(computeCodexUsageScore({ weeklyPercent: 99, monthlyPercent: 12 }, "go")).toBe(12);
    expect(computeCodexUsageScore({ weeklyPercent: 99, monthlyPercent: 13 }, "free")).toBe(13);
    expect(computeCodexUsageScore({ weeklyPercent: 1 }, "go")).toBe(CODEX_UNKNOWN_USAGE_SCORE);
  });

  test("usage score treats unknown quota conservatively", () => {
    expect(computeCodexUsageScore(null)).toBe(CODEX_UNKNOWN_USAGE_SCORE);
    expect(computeCodexUsageScore({})).toBe(CODEX_UNKNOWN_USAGE_SCORE);
  });

  test("weekly threshold breach switches new threads", () => {
    const config = makeConfig();
    updateAccountQuota("a", 85);
    updateAccountQuota("b", 20);
    expect(resolveCodexAccountForThread("new-thread", config)).toBe("b");
  });

  test("missing OpenAI mode defaults to pool and rotates from hot main to a cool added account", () => {
    writeFileSync(join(TEST_DIR, "auth.json"), JSON.stringify({
      tokens: { access_token: "main-access", account_id: "main-chatgpt-id" },
    }));
    const config = makeConfig({
      providers: {
        openai: {
          adapter: "openai-responses",
          baseUrl: "https://chatgpt.com/backend-api/codex",
          authMode: "forward",
        },
      },
      defaultProvider: "openai",
      codexAccounts: [{ id: "a", email: "a@test", isMain: false }],
      activeCodexAccountId: MAIN_CODEX_ACCOUNT_ID,
    });
    updateAccountQuota(MAIN_CODEX_ACCOUNT_ID, 95);
    updateAccountQuota("a", 5);

    expect(routeModel(config, "gpt-5.6-sol").codexAccountMode).toBe("pool");
    expect(resolveCodexAccountForThread("main-pressure", config)).toBe("a");
    expect(config.activeCodexAccountId).toBe("a");
    recordCodexUpstreamOutcome(config, "a", 200);
    expect(resolveCodexAccountForThread("after-success", config)).toBe("a");
  });

  test("go plan pool switching ignores the weekly window", () => {
    const config = makeConfig({
      codexAccounts: [
        { id: "a", email: "a@test", plan: "go", isMain: false },
        { id: "b", email: "b@test", plan: "go", isMain: false },
      ],
      activeCodexAccountId: "a",
    });
    updateAccountQuota("a", 99, undefined, 10);
    updateAccountQuota("b", 1, undefined, 50);
    expect(resolveCodexAccountForThread("go-monthly-thread", config)).toBe("a");
  });

  test("unknown active quota preserves the explicit selection until priming completes", () => {
    const config = makeConfig();
    updateAccountQuota("b", 20);
    expect(resolveCodexAccountForThread("unknown-active", config)).toBe("a");
  });

  test("unknown quota does not beat known low quota during lowest-usage selection", () => {
    const config = makeConfig({
      codexAccounts: [
        { id: "a", email: "a@test", isMain: false },
        { id: "b", email: "b@test", isMain: false },
        { id: "c", email: "c@test", isMain: false },
      ],
    });
    saveTestCredential("c");
    updateAccountQuota("b", 25);
    expect(pickLowestUsageCodexAccount(config)).toBe("b");
  });

  test("upstream outcome classifier separates caller, credential, and transient failures", () => {
    expect(classifyCodexUpstreamOutcome(200)).toBe("success");
    expect(classifyCodexUpstreamOutcome(401)).toBe("credential");
    expect(classifyCodexUpstreamOutcome(403)).toBe("credential");
    expect(classifyCodexUpstreamOutcome(429)).toBe("quota");
    expect(classifyCodexUpstreamOutcome(402)).toBe("quota");
    expect(classifyCodexUpstreamOutcome(422)).toBe("caller");
    expect(classifyCodexUpstreamOutcome(503)).toBe("transient");
    expect(classifyCodexUpstreamOutcome("connect_error")).toBe("transient");
    expect(classifyCodexUpstreamOutcome("timeout")).toBe("transient");
    expect(classifyCodexUpstreamOutcome(102)).toBe("unknown");
  });

  test("three consecutive transient failures fail over future new threads", () => {
    const config = makeConfig();
    updateAccountQuota("a", 10);
    updateAccountQuota("b", 20);
    expect(resolveCodexAccountForThread("existing", config)).toBe("a");
    recordCodexUpstreamOutcome(config, "a", 503);
    recordCodexUpstreamOutcome(config, "a", 503);
    recordCodexUpstreamOutcome(config, "a", 503);
    // After the failover streak trips, all affinities for "a" are cleared and
    // the account is soft-avoided — even the previously-bound thread rebinds.
    expect(resolveCodexAccountForThread("existing", config)).toBe("b");
    expect(resolveCodexAccountForThread("next", config)).toBe("b");
  });

  test("caller and model 4xx responses do not penalize account health", () => {
    const config = makeConfig();
    updateAccountQuota("a", 10);
    updateAccountQuota("b", 20);
    recordCodexUpstreamOutcome(config, "a", 400);
    recordCodexUpstreamOutcome(config, "a", 404);
    recordCodexUpstreamOutcome(config, "a", 422);
    expect(getCodexUpstreamHealth("a")).toBeNull();
    expect(resolveCodexAccountForThread("next", config)).toBe("a");
  });

  test("401 credential outcome quarantines the account for future threads", () => {
    const config = makeConfig();
    updateAccountQuota("a", 10);
    updateAccountQuota("b", 20);
    expect(resolveCodexAccountForThread("credential-existing", config)).toBe("a");

    recordCodexUpstreamOutcome(config, "a", 401);

    expect(isAccountNeedsReauth("a")).toBe(true);
    expect(getCodexUpstreamHealth("a")).toMatchObject({ consecutiveFailures: 1, lastFailureStatus: 401 });
    expect(resolveCodexAccountForThread("credential-existing", config)).toBe("b");
    expect(resolveCodexAccountForThread("credential-next", config)).toBe("b");
  });

  test("403 credential outcome quarantines the account under the conservative policy", () => {
    const config = makeConfig();
    updateAccountQuota("a", 10);
    updateAccountQuota("b", 20);

    recordCodexUpstreamOutcome(config, "a", 403);

    expect(isAccountNeedsReauth("a")).toBe(true);
    expect(getCodexUpstreamHealth("a")).toMatchObject({ consecutiveFailures: 1, lastFailureStatus: 403 });
    expect(resolveCodexAccountForThread("credential-403-next", config)).toBe("b");
  });

  test("connect failures contribute to transient failover", () => {
    const config = makeConfig();
    updateAccountQuota("a", 10);
    updateAccountQuota("b", 20);
    recordCodexUpstreamOutcome(config, "a", "connect_error");
    recordCodexUpstreamOutcome(config, "a", "timeout");
    recordCodexUpstreamOutcome(config, "a", "connect_error");
    expect(getCodexUpstreamHealth("a")).toMatchObject({ consecutiveFailures: 3, lastFailureStatus: 0 });
    expect(resolveCodexAccountForThread("connect-next", config)).toBe("b");
  });

  test("429 with Retry-After records an account cooldown", () => {
    const config = makeConfig();
    const now = 1_800_000_000_000;

    recordCodexUpstreamOutcome(config, "a", 429, { retryAfter: "120", now });

    expect(getCodexAccountCooldownUntil("a", now)).toBe(now + 120_000);
    expect(isCodexAccountInCooldown("a", now + 119_999)).toBe(true);
    expect(isCodexAccountInCooldown("a", now + 120_001)).toBe(false);
  });

  test("Retry-After HTTP date values are parsed as future cooldowns", () => {
    const now = Date.UTC(2026, 5, 24, 12, 0, 0);
    const retryAfter = new Date(now + 45_000).toUTCString();

    expect(parseRetryAfterMs(retryAfter, now)).toBe(45_000);
  });

  test("429 uses Codex reset headers as cooldown fallback", () => {
    const config = makeConfig();
    const now = 1_800_000_000_000;

    recordCodexUpstreamOutcome(config, "a", 429, {
      now,
      resetAt: [
        String((now + 90_000) / 1000),
        String((now + 240_000) / 1000),
      ],
    });

    expect(getCodexAccountCooldownUntil("a", now)).toBe(now + 90_000);
  });

  test("429 on the active account clears affinity and switches new threads to an available pool account", () => {
    const config = makeConfig();
    const now = 1_800_000_000_000;
    updateAccountQuota("a", 10);
    updateAccountQuota("b", 20);
    expect(resolveCodexAccountForThread("quota-existing", config)).toBe("a");

    recordCodexUpstreamOutcome(config, "a", 429, { retryAfter: "60", now });

    expect(config.activeCodexAccountId).toBe("b");
    expect(resolveCodexAccountForThread("quota-existing", config)).toBe("b");
    expect(resolveCodexAccountForThread("quota-next", config)).toBe("b");
  });

  test("2xx responses clear transient failures without clearing an unexpired cooldown", () => {
    const config = makeConfig();
    const now = 1_800_000_000_000;
    recordCodexUpstreamOutcome(config, "a", 429, { retryAfter: "120", now });

    recordCodexUpstreamOutcome(config, "a", 200, { now: now + 1_000 });

    expect(getCodexAccountCooldownUntil("a", now + 1_000)).toBe(now + 120_000);
    expect(getCodexUpstreamHealth("a")).toMatchObject({ consecutiveFailures: 0, cooldownUntil: now + 120_000 });
  });

  // --- #433: quota cooldown must not pin a recovered account -------------------

  test("far-future resetAt is capped well below the 24h ceiling", () => {
    const config = makeConfig();
    const now = 1_800_000_000_000;
    const fourDaysOut = Math.floor((now + 4 * 24 * 60 * 60_000) / 1000);

    recordCodexUpstreamOutcome(config, "a", 429, { resetAt: fourDaysOut, now });

    const cooldownUntil = getCodexAccountCooldownUntil("a", now)!;
    // Before the fix this clamped to the 24h Retry-After ceiling.
    expect(cooldownUntil - now).toBeLessThanOrEqual(15 * 60_000);
    expect(getCodexUpstreamHealth("a")).toMatchObject({ cooldownSource: "reset-derived" });
  });

  test("Retry-After keeps honoring long explicit delays", () => {
    const config = makeConfig();
    const now = 1_800_000_000_000;

    recordCodexUpstreamOutcome(config, "a", 429, { retryAfter: "7200", now });

    expect(getCodexAccountCooldownUntil("a", now)).toBe(now + 7_200_000);
    expect(getCodexUpstreamHealth("a")).toMatchObject({ cooldownSource: "retry-after" });
  });

  test("retry-after cooldown is never probed", () => {
    const config = makeConfig();
    const now = 1_800_000_000_000;
    recordCodexUpstreamOutcome(config, "a", 429, { retryAfter: "7200", now });

    // An explicit Retry-After is a literal retry directive, not a window hint.
    expect(tryAcquireCodexQuotaProbeLease("a", now + CODEX_QUOTA_PROBE_INTERVAL_MS + 1)).toBeNull();
    expect(tryAcquireCodexQuotaProbeLease("a", now + 60 * 60_000)).toBeNull();
  });

  test("probe lease is granted at most once per interval", () => {
    const config = makeConfig();
    const now = 1_800_000_000_000;
    const resetAt = Math.floor((now + 4 * 24 * 60 * 60_000) / 1000);
    recordCodexUpstreamOutcome(config, "a", 429, { resetAt, now });

    expect(tryAcquireCodexQuotaProbeLease("a", now)).toBeNull();
    const lease = tryAcquireCodexQuotaProbeLease("a", now + CODEX_QUOTA_PROBE_INTERVAL_MS);
    expect(lease).toBeTruthy();
    // Only one probe may be in flight at a time.
    expect(tryAcquireCodexQuotaProbeLease("a", now + CODEX_QUOTA_PROBE_INTERVAL_MS)).toBeNull();
  });

  test("leased probe success clears the hard cooldown", () => {
    const config = makeConfig();
    const now = 1_800_000_000_000;
    const resetAt = Math.floor((now + 4 * 24 * 60 * 60_000) / 1000);
    recordCodexUpstreamOutcome(config, "a", 429, { resetAt, now });
    const probeAt = now + CODEX_QUOTA_PROBE_INTERVAL_MS;
    const probeLeaseId = tryAcquireCodexQuotaProbeLease("a", probeAt)!;

    recordCodexUpstreamOutcome(config, "a", 200, { now: probeAt + 500, probeLeaseId });

    expect(getCodexUpstreamHealth("a")).toBeNull();
    expect(isCodexAccountInCooldown("a", probeAt + 500)).toBe(false);
  });

  test("unleased 2xx preserves the hard cooldown", () => {
    const config = makeConfig();
    const now = 1_800_000_000_000;
    const resetAt = Math.floor((now + 4 * 24 * 60 * 60_000) / 1000);
    recordCodexUpstreamOutcome(config, "a", 429, { resetAt, now });

    // A request that started before the 429 landed must not be mistaken for a probe.
    recordCodexUpstreamOutcome(config, "a", 200, { now: now + 1_000 });

    expect(isCodexAccountInCooldown("a", now + 1_000)).toBe(true);
  });

  test("mismatched lease id does not consume the probe", () => {
    const config = makeConfig();
    const now = 1_800_000_000_000;
    const resetAt = Math.floor((now + 4 * 24 * 60 * 60_000) / 1000);
    recordCodexUpstreamOutcome(config, "a", 429, { resetAt, now });
    const probeAt = now + CODEX_QUOTA_PROBE_INTERVAL_MS;
    const probeLeaseId = tryAcquireCodexQuotaProbeLease("a", probeAt)!;

    // Another in-flight request fails; it must not kill the live probe.
    recordCodexUpstreamOutcome(config, "a", 503, { now: probeAt + 100, probeLeaseId: "someone-else" });

    expect(getCodexUpstreamHealth("a")).toMatchObject({ probeLeaseId });
  });

  test("failed probe releases the lease and restarts the interval", () => {
    const config = makeConfig();
    const now = 1_800_000_000_000;
    const resetAt = Math.floor((now + 4 * 24 * 60 * 60_000) / 1000);
    recordCodexUpstreamOutcome(config, "a", 429, { resetAt, now });
    const probeAt = now + CODEX_QUOTA_PROBE_INTERVAL_MS;
    const probeLeaseId = tryAcquireCodexQuotaProbeLease("a", probeAt)!;

    recordCodexUpstreamOutcome(config, "a", 429, { resetAt, now: probeAt + 100, probeLeaseId });

    expect(getCodexUpstreamHealth("a")?.probeLeaseId).toBeUndefined();
    expect(tryAcquireCodexQuotaProbeLease("a", probeAt + 200)).toBeNull();
    expect(tryAcquireCodexQuotaProbeLease("a", probeAt + 100 + CODEX_QUOTA_PROBE_INTERVAL_MS)).toBeTruthy();
  });

  test("stale-generation lease cannot clear a newer cooldown", () => {
    const config = makeConfig();
    const now = 1_800_000_000_000;
    const resetAt = Math.floor((now + 4 * 24 * 60 * 60_000) / 1000);
    recordCodexUpstreamOutcome(config, "a", 429, { resetAt, now });
    const probeAt = now + CODEX_QUOTA_PROBE_INTERVAL_MS;
    const probeLeaseId = tryAcquireCodexQuotaProbeLease("a", probeAt)!;

    // A different in-flight request receives an explicit Retry-After.
    recordCodexUpstreamOutcome(config, "a", 429, { retryAfter: "7200", now: probeAt + 50 });
    // Now the original probe finally succeeds. It must NOT erase the new directive.
    recordCodexUpstreamOutcome(config, "a", 200, { now: probeAt + 100, probeLeaseId });

    const health = getCodexUpstreamHealth("a");
    expect(isCodexAccountInCooldown("a", probeAt + 100)).toBe(true);
    expect(health).toMatchObject({ cooldownSource: "retry-after" });
    // The finished probe still hands its lease back (it is no longer in flight).
    expect(health?.probeLeaseId).toBeUndefined();
    // ...but a retry-after cooldown is never probed again.
    expect(tryAcquireCodexQuotaProbeLease("a", probeAt + 100 + CODEX_QUOTA_PROBE_INTERVAL_MS)).toBeNull();
  });

  // --- manual cooldown escape (260726 lockout hardening) ----------------------

  test("clearCodexAccountCooldown lifts a live cooldown but keeps failure history", () => {
    const config = makeConfig();
    const now = 1_800_000_000_000;
    recordCodexUpstreamOutcome(config, "a", 429, { retryAfter: "7200", now });
    expect(isCodexAccountInCooldown("a", now + 1_000)).toBe(true);

    expect(clearCodexAccountCooldown("a", now + 1_000)).toBe(true);

    expect(isCodexAccountInCooldown("a", now + 1_000)).toBe(false);
    const health = getCodexUpstreamHealth("a");
    expect(health?.cooldownUntil).toBeUndefined();
    expect(health?.cooldownSource).toBeUndefined();
    // Clearing says "the quota window moved", not "this account is healthy":
    // failover must keep what it learned from the 429.
    expect(health?.lastFailureStatus).toBe(429);
  });

  test("clearing is a no-op without a live cooldown", () => {
    const config = makeConfig();
    const now = 1_800_000_000_000;
    expect(clearCodexAccountCooldown("a", now)).toBe(false);

    recordCodexUpstreamOutcome(config, "a", 429, { retryAfter: "60", now });
    // Already expired on its own.
    expect(clearCodexAccountCooldown("a", now + 120_000)).toBe(false);
  });

  test("manual clearing releases the in-flight lease, so a stale probe cannot erase the NEXT cooldown", () => {
    const config = makeConfig();
    const now = 1_800_000_000_000;
    const resetAt = Math.floor((now + 4 * 24 * 60 * 60_000) / 1000);
    recordCodexUpstreamOutcome(config, "a", 429, { resetAt, now });
    const probeAt = now + CODEX_QUOTA_PROBE_INTERVAL_MS;
    const staleLease = tryAcquireCodexQuotaProbeLease("a", probeAt)!;

    // User lifts the cooldown while that probe is still in flight. The lease is dropped
    // with it, so the stale probe no longer owns anything.
    expect(clearCodexAccountCooldown("a", probeAt + 10)).toBe(true);
    expect(getCodexUpstreamHealth("a")?.probeLeaseId).toBeUndefined();

    // Upstream is still exhausted, so the next request re-cools the account.
    recordCodexUpstreamOutcome(config, "a", 429, { retryAfter: "7200", now: probeAt + 20 });
    // The stale probe finally returns 200. It must not void the new limit.
    recordCodexUpstreamOutcome(config, "a", 200, { now: probeAt + 30, probeLeaseId: staleLease });

    expect(isCodexAccountInCooldown("a", probeAt + 30)).toBe(true);
    expect(getCodexUpstreamHealth("a")).toMatchObject({ cooldownSource: "retry-after" });
  });

  test("a stale probe cannot void a later cooldown even while a fresh probe is live", () => {
    const config = makeConfig();
    const now = 1_800_000_000_000;
    const resetAt = Math.floor((now + 4 * 24 * 60 * 60_000) / 1000);
    recordCodexUpstreamOutcome(config, "a", 429, { resetAt, now });
    const probeAt = now + CODEX_QUOTA_PROBE_INTERVAL_MS;
    const staleLease = tryAcquireCodexQuotaProbeLease("a", probeAt)!;

    expect(clearCodexAccountCooldown("a", probeAt + 10)).toBe(true);
    recordCodexUpstreamOutcome(config, "a", 429, { resetAt, now: probeAt + 20 });
    // A fresh probe is granted against the NEW cooldown, so the account holds a lease again.
    const freshAt = probeAt + 20 + CODEX_QUOTA_PROBE_INTERVAL_MS;
    const freshLease = tryAcquireCodexQuotaProbeLease("a", freshAt)!;
    expect(freshLease).not.toBe(staleLease);

    // The STALE probe reports success. Lease-id mismatch is what must hold here (the
    // generation guard is redundant defence): otherwise manual clearing would become a
    // way to void a later limit.
    recordCodexUpstreamOutcome(config, "a", 200, { now: freshAt + 100, probeLeaseId: staleLease });

    expect(isCodexAccountInCooldown("a", freshAt + 100)).toBe(true);
    // The live probe is untouched by an unrelated outcome.
    expect(getCodexUpstreamHealth("a")?.probeLeaseId).toBe(freshLease);
  });

  test("credential failure ends the probe", () => {
    const config = makeConfig();
    const now = 1_800_000_000_000;
    const resetAt = Math.floor((now + 4 * 24 * 60 * 60_000) / 1000);
    recordCodexUpstreamOutcome(config, "a", 429, { resetAt, now });
    const probeAt = now + CODEX_QUOTA_PROBE_INTERVAL_MS;
    const probeLeaseId = tryAcquireCodexQuotaProbeLease("a", probeAt)!;

    // Reauth quarantine supersedes quota state entirely.
    recordCodexUpstreamOutcome(config, "a", 401, { now: probeAt + 100, probeLeaseId });

    const health = getCodexUpstreamHealth("a");
    expect(health?.probeLeaseId).toBeUndefined();
    expect(health?.cooldownUntil).toBeUndefined();
  });

  test("unowned outcome preserves retry-after source", () => {
    const config = makeConfig();
    const now = 1_800_000_000_000;
    recordCodexUpstreamOutcome(config, "a", 429, { retryAfter: "7200", now });

    recordCodexUpstreamOutcome(config, "a", 200, { now: now + 1_000 });
    recordCodexUpstreamOutcome(config, "a", 503, { now: now + 2_000 });

    expect(getCodexUpstreamHealth("a")).toMatchObject({ cooldownSource: "retry-after" });
    expect(tryAcquireCodexQuotaProbeLease("a", now + 60 * 60_000)).toBeNull();
  });

  test("unowned outcome keeps a reset-derived cooldown probeable", () => {
    const config = makeConfig();
    const now = 1_800_000_000_000;
    const resetAt = Math.floor((now + 4 * 24 * 60 * 60_000) / 1000);
    recordCodexUpstreamOutcome(config, "a", 429, { resetAt, now });

    // A late unrelated response must not wipe the probe bookkeeping.
    recordCodexUpstreamOutcome(config, "a", 200, { now: now + 1_000 });
    recordCodexUpstreamOutcome(config, "a", 503, { now: now + 2_000 });

    expect(tryAcquireCodexQuotaProbeLease("a", now + CODEX_QUOTA_PROBE_INTERVAL_MS + 1)).toBeTruthy();
  });

  test("in-flight lease survives an unowned outcome", () => {
    const config = makeConfig();
    const now = 1_800_000_000_000;
    const resetAt = Math.floor((now + 4 * 24 * 60 * 60_000) / 1000);
    recordCodexUpstreamOutcome(config, "a", 429, { resetAt, now });
    const probeAt = now + CODEX_QUOTA_PROBE_INTERVAL_MS;
    const probeLeaseId = tryAcquireCodexQuotaProbeLease("a", probeAt)!;

    recordCodexUpstreamOutcome(config, "a", 200, { now: probeAt + 100 });
    expect(getCodexUpstreamHealth("a")).toMatchObject({ probeLeaseId });

    recordCodexUpstreamOutcome(config, "a", 503, { now: probeAt + 200 });
    expect(getCodexUpstreamHealth("a")).toMatchObject({ probeLeaseId });
  });

  test("stale transient failure streaks expire before failover thresholding", () => {
    const config = makeConfig();
    // Known low quota keeps "a" the deterministic active (this case tests failover
    // streak expiry, not the all-unknown quota rotation added in Phase 10).
    updateAccountQuota("a", 10);
    updateAccountQuota("b", 10);
    const now = 1_800_000_000_000;

    recordCodexUpstreamOutcome(config, "a", 503, { now });
    recordCodexUpstreamOutcome(config, "a", 503, { now: now + CODEX_FAILURE_WINDOW_MS + 1 });

    expect(getCodexUpstreamHealth("a")).toMatchObject({ consecutiveFailures: 1, lastFailureStatus: 503 });
    // Resolve after both the failure window AND the soft-avoid window have expired.
    const afterBoth = now + CODEX_FAILURE_WINDOW_MS + CODEX_TRANSIENT_SOFT_AVOID_MS + 2;
    expect(resolveCodexAccountForThread("stale-failure-next", config, afterBoth)).toBe("a");
  });

  test("2xx responses reset the failure streak", () => {
    const config = makeConfig();
    updateAccountQuota("a", 10);
    updateAccountQuota("b", 10);
    const now = 1_800_000_000_000;
    recordCodexUpstreamOutcome(config, "a", 503, { now });
    recordCodexUpstreamOutcome(config, "a", 200, { now: now + 1 });
    recordCodexUpstreamOutcome(config, "a", 503, { now: now + 2 });
    recordCodexUpstreamOutcome(config, "a", 503, { now: now + 3 });
    // The success reset the old streak, so the next two failures form escalation
    // level 2 (still below failover threshold 3) and avoid the account for 2m.
    const afterSoftAvoid = now + 3 + 2 * 60_000 + 1;
    expect(resolveCodexAccountForThread("next", config, afterSoftAvoid)).toBe("a");
  });

  test("failure failover can be disabled independently from quota switching", () => {
    const config = makeConfig({ upstreamFailoverThreshold: 0 });
    updateAccountQuota("a", 10);
    updateAccountQuota("b", 10);
    recordCodexUpstreamOutcome(config, "a", 503);
    recordCodexUpstreamOutcome(config, "a", 503);
    recordCodexUpstreamOutcome(config, "a", 503);
    expect(resolveCodexAccountForThread("next", config)).toBe("a");
  });

  test("inspection client cancellation records no terminal outcome or account penalty", async () => {
    const config = makeConfig();
    const record = (status: "completed" | "failed" | "incomplete", override?: number) => {
      recordCodexUpstreamOutcome(config, "a", status === "failed" ? (override ?? 502) : 200);
    };

    const preAborted = new AbortController();
    preAborted.abort();
    consumeForInspection(pendingInspectionStream(), record, preAborted.signal);
    expect(getCodexUpstreamHealth("a")).toBeNull();

    const midDrain = new AbortController();
    consumeForInspection(pendingInspectionStream(), record, midDrain.signal);
    midDrain.abort();
    await inspectionTick();
    expect(getCodexUpstreamHealth("a")).toBeNull();
  });

  test("one inspection read rejection records 502 without clearing affinity", async () => {
    const config = makeConfig();
    const now = 1_800_000_000_000;
    updateAccountQuota("a", 10);
    updateAccountQuota("b", 20);
    expect(resolveCodexAccountForThread("reset-thread", config, now)).toBe("a");
    const terminals: Array<[string, number | undefined]> = [];
    const resetStream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(new Error("socket reset"));
      },
    });

    consumeForInspection(resetStream, (status, override) => {
      terminals.push([status, override]);
      recordCodexUpstreamOutcome(config, "a", override ?? 200, { now: now + 1, threadId: "reset-thread" });
    });
    await inspectionTick();

    expect(terminals).toEqual([["failed", 502]]);
    expect(getCodexUpstreamHealth("a")).toMatchObject({ consecutiveFailures: 1, lastFailureStatus: 502 });
    expect(resolveCodexAccountForThread("reset-thread", config, now + 2)).toBe("a");
  });

  test("inspection clean EOF remains incomplete and success-like", async () => {
    const config = makeConfig();
    const terminals: Array<[string, number | undefined]> = [];
    const cleanEof = new ReadableStream<Uint8Array>({ start(controller) { controller.close(); } });

    consumeForInspection(cleanEof, (status, override) => {
      terminals.push([status, override]);
      recordCodexUpstreamOutcome(config, "a", status === "failed" ? (override ?? 502) : 200);
    });
    await inspectionTick();

    expect(terminals).toEqual([["incomplete", undefined]]);
    expect(getCodexUpstreamHealth("a")).toBeNull();
  });

  test("transient cooldown escalates to 2m, 10m, then the 30m cap", () => {
    const config = makeConfig();
    const now = 1_800_000_000_000;

    recordCodexUpstreamOutcome(config, "a", 503, { now });
    recordCodexUpstreamOutcome(config, "a", 503, { now: now + 1 });
    expect(getCodexAccountSoftAvoidUntil("a", now + 1)).toBeNull();
    recordCodexUpstreamOutcome(config, "a", 503, { now: now + 2 });
    expect(getCodexAccountSoftAvoidUntil("a", now + 2)).toBe(now + 2 + 30_000);
    recordCodexUpstreamOutcome(config, "a", 503, { now: now + 3 });
    expect(getCodexAccountSoftAvoidUntil("a", now + 3)).toBe(now + 3 + 2 * 60_000);
    recordCodexUpstreamOutcome(config, "a", 503, { now: now + 4 });
    expect(getCodexAccountSoftAvoidUntil("a", now + 4)).toBe(now + 4 + 10 * 60_000);
    recordCodexUpstreamOutcome(config, "a", 503, { now: now + 5 });
    expect(getCodexAccountSoftAvoidUntil("a", now + 5)).toBe(now + 5 + 30 * 60_000);
  });

  test("escalation level 2 requires two consecutive healthy terminals to clear", () => {
    const config = makeConfig();
    const now = 1_800_000_000_000;
    recordCodexUpstreamOutcome(config, "a", 503, { now });
    recordCodexUpstreamOutcome(config, "a", 503, { now: now + 1 });

    recordCodexUpstreamOutcome(config, "a", 200, { now: now + 2 });
    expect(getCodexUpstreamHealth("a")).toMatchObject({
      consecutiveFailures: 2,
      consecutiveSuccesses: 1,
    });
    expect(isCodexAccountSoftAvoided("a", now + 2)).toBe(false);

    recordCodexUpstreamOutcome(config, "a", 200, { now: now + 3 });
    expect(getCodexUpstreamHealth("a")).toBeNull();
  });

  test("stale thread affinity is revalidated before reuse", () => {
    const config = makeConfig();
    updateAccountQuota("a", 10);
    updateAccountQuota("b", 10);
    expect(resolveCodexAccountForThread("stale-thread", config)).toBe("a");

    config.codexAccounts = config.codexAccounts?.filter(account => account.id !== "a");
    removeCodexAccountCredential("a");

    expect(resolveCodexAccountForThread("stale-thread", config)).toBe("b");
  });

  test("expired thread affinity is not silently remapped", () => {
    const config = makeConfig();
    updateAccountQuota("a", 10);
    updateAccountQuota("b", 10);
    const now = 1_800_000_000_000;
    expect(resolveCodexAccountForThread("expired-thread", config, now)).toBe("a");

    expect(resolveCodexAccountForThread(
      "expired-thread",
      config,
      now + CODEX_THREAD_AFFINITY_IDLE_TTL_MS + 1,
    )).toBeNull();
  });

  test("detailed resolver reports expired thread affinity", () => {
    const config = makeConfig();
    updateAccountQuota("a", 10);
    updateAccountQuota("b", 10);
    const now = 1_800_000_000_000;
    expect(resolveCodexAccountForThreadDetailed("expired-detailed", config, now))
      .toEqual({ status: "selected", accountId: "a" });

    expect(resolveCodexAccountForThreadDetailed(
      "expired-detailed",
      config,
      now + CODEX_THREAD_AFFINITY_IDLE_TTL_MS + 1,
    )).toEqual({ status: "expired", accountId: "a" });
  });

  test("thread affinity LRU cap evicts the oldest mapping", () => {
    const config = makeConfig();
    updateAccountQuota("a", 10);
    updateAccountQuota("b", 10);
    const now = 1_800_000_000_000;
    for (let i = 0; i < CODEX_THREAD_AFFINITY_MAX_ENTRIES + 1; i += 1) {
      expect(resolveCodexAccountForThread(`lru-${i}`, config, now + i)).toBe("a");
    }

    config.activeCodexAccountId = "b";

    expect(resolveCodexAccountForThread("lru-1", config, now + CODEX_THREAD_AFFINITY_MAX_ENTRIES + 1)).toBe("a");
    expect(resolveCodexAccountForThread("lru-0", config, now + CODEX_THREAD_AFFINITY_MAX_ENTRIES + 2)).toBe("b");
  });

  test("generation mismatch invalidates a mapped thread before reuse", () => {
    const config = makeConfig();
    updateAccountQuota("a", 10);
    updateAccountQuota("b", 10);
    const now = 1_800_000_000_000;
    expect(resolveCodexAccountForThread("generation-thread", config, now)).toBe("a");

    saveCodexAccountCredential("a", {
      accessToken: "replacement-a",
      refreshToken: "replacement-refresh-a",
      expiresAt: Date.now() + 5 * 60_000,
      chatgptAccountId: "acct-a",
    });
    config.activeCodexAccountId = "b";

    expect(resolveCodexAccountForThread("generation-thread", config, now + 1)).toBe("b");
  });

  test("account-specific cleanup clears affinity and upstream health", () => {
    const config = makeConfig();
    updateAccountQuota("a", 10);
    updateAccountQuota("b", 10);
    expect(resolveCodexAccountForThread("cleanup-thread", config)).toBe("a");
    recordCodexUpstreamOutcome(config, "a", 503);
    expect(getCodexUpstreamHealth("a")).not.toBeNull();

    clearThreadAccountMapForAccount("a");
    clearCodexUpstreamHealthForAccount("a");
    config.activeCodexAccountId = "b";

    expect(getCodexUpstreamHealth("a")).toBeNull();
    expect(resolveCodexAccountForThread("cleanup-thread", config)).toBe("b");
  });

  test("manual selection clears affinity and transient state but preserves hard cooldown", () => {
    const config = makeConfig();
    const now = 1_800_000_000_000;
    updateAccountQuota("a", 10);
    updateAccountQuota("b", 20);
    expect(resolveCodexAccountForThread("manual-thread", config, now)).toBe("a");

    recordCodexUpstreamOutcome(config, "b", 429, { retryAfter: "120", now });
    recordCodexUpstreamOutcome(config, "b", 503, { now: now + 1 });
    recordCodexUpstreamOutcome(config, "b", 503, { now: now + 2 });
    recordCodexUpstreamOutcome(config, "b", 503, { now: now + 3 });
    expect(isCodexAccountSoftAvoided("b", now + 4)).toBe(true);

    config.activeCodexAccountId = "b";
    resetCodexRoutingForManualSelection("b");
    expect(isCodexAccountSoftAvoided("b", now + 4)).toBe(false);
    expect(isCodexAccountInCooldown("b", now + 4)).toBe(true);
    expect(getCodexUpstreamHealth("b")?.consecutiveFailures).toBe(0);
    expect(clearCodexAccountCooldown("b", now + 4)).toBe(true);
    expect(resolveCodexAccountForThread("manual-thread", config, now + 4)).toBe("b");
  });

  test("failover threshold API validates and mutates runtime config", async () => {
    const config = makeConfig();
    const badReq = new Request("http://localhost/api/codex-auth/failover", {
      method: "PUT",
      body: JSON.stringify({ threshold: 21 }),
    });
    expect((await handleCodexAuthAPI(badReq, new URL(badReq.url), config))!.status).toBe(400);
    const req = new Request("http://localhost/api/codex-auth/failover", {
      method: "PUT",
      body: JSON.stringify({ threshold: 4 }),
    });
    expect((await handleCodexAuthAPI(req, new URL(req.url), config))!.status).toBe(200);
    expect(config.upstreamFailoverThreshold).toBe(4);
  });

  test("clear-cooldown route lifts a live cooldown", async () => {
    const config = makeConfig();
    const now = Date.now();
    recordCodexUpstreamOutcome(config, "a", 429, { retryAfter: "7200", now });
    expect(isCodexAccountInCooldown("a", now + 1_000)).toBe(true);

    const req = new Request("http://localhost/api/codex-auth/accounts/clear-cooldown", {
      method: "POST",
      body: JSON.stringify({ id: "a" }),
    });
    const res = (await handleCodexAuthAPI(req, new URL(req.url), config))!;

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, id: "a", cleared: true });
    expect(isCodexAccountInCooldown("a", now + 1_000)).toBe(false);
  });

  test("clear-cooldown works for the main login, which is the single-account lockout case", async () => {
    const config = makeConfig();
    const now = Date.now();
    recordCodexUpstreamOutcome(config, MAIN_CODEX_ACCOUNT_ID, 429, { retryAfter: "7200", now });

    const req = new Request("http://localhost/api/codex-auth/accounts/clear-cooldown", {
      method: "POST",
      body: JSON.stringify({ id: MAIN_CODEX_ACCOUNT_ID }),
    });
    const res = (await handleCodexAuthAPI(req, new URL(req.url), config))!;

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ cleared: true });
    expect(isCodexAccountInCooldown(MAIN_CODEX_ACCOUNT_ID, now + 1_000)).toBe(false);
  });

  test("clear-cooldown does not disclose whether an account exists", async () => {
    const config = makeConfig();
    // Known account with no cooldown, and an id that is not configured at all: both must
    // answer identically so the route cannot be used to enumerate accounts.
    const known = new Request("http://localhost/api/codex-auth/accounts/clear-cooldown", {
      method: "POST",
      body: JSON.stringify({ id: "a" }),
    });
    const unknown = new Request("http://localhost/api/codex-auth/accounts/clear-cooldown", {
      method: "POST",
      body: JSON.stringify({ id: "nope-not-configured" }),
    });

    const knownRes = (await handleCodexAuthAPI(known, new URL(known.url), config))!;
    const unknownRes = (await handleCodexAuthAPI(unknown, new URL(unknown.url), config))!;

    expect(knownRes.status).toBe(unknownRes.status);
    expect(knownRes.status).toBe(200);
    expect(await knownRes.json()).toMatchObject({ cleared: false });
    expect(await unknownRes.json()).toMatchObject({ cleared: false });
  });

  test("clear-cooldown rejects a malformed account id", async () => {
    const config = makeConfig();
    const req = new Request("http://localhost/api/codex-auth/accounts/clear-cooldown", {
      method: "POST",
      body: JSON.stringify({ id: "../../etc/passwd" }),
    });

    expect((await handleCodexAuthAPI(req, new URL(req.url), config))!.status).toBe(400);
  });

  test("WHAM tertiary window parses as optional 30d quota", () => {
    const quota = parseUsageQuota({
      rate_limit: {
        secondary_window: { used_percent: 20, reset_at: 2 },
        tertiary_window: { used_percent: 30, reset_at: 3 },
      },
    });
    expect(quota).toMatchObject({
      weeklyPercent: 20,
      monthlyPercent: 30,
      weeklyResetAt: 2,
      monthlyResetAt: 3,
    });
  });

  test("WHAM primary window uses its explicit duration to distinguish weekly and monthly quotas", () => {
    expect(parseUsageQuota({
      plan_type: "team",
      rate_limit: {
        primary_window: { used_percent: 20, reset_at: 2, limit_window_seconds: 604_800 },
      },
    })).toEqual({ weeklyPercent: 20, weeklyResetAt: 2 });

    expect(parseUsageQuota({
      plan_type: "team",
      rate_limit: {
        primary_window: { used_percent: 39, reset_at: 3, limit_window_seconds: 2_628_000 },
      },
    })).toEqual({ monthlyPercent: 39, monthlyResetAt: 3 });
  });

  test("WHAM monthly primary preserves a legacy secondary weekly window", () => {
    expect(parseUsageQuota({
      plan_type: "team",
      rate_limit: {
        primary_window: { used_percent: 39, reset_at: 30, limit_window_seconds: 2_628_000 },
        secondary_window: { used_percent: 12, reset_at: 7, limit_window_seconds: 604_800 },
      },
    })).toEqual({
      weeklyPercent: 12,
      weeklyResetAt: 7,
      monthlyPercent: 39,
      monthlyResetAt: 30,
    });
  });

  test("WHAM primary window without duration keeps the legacy weekly fallback", () => {
    expect(parseUsageQuota({
      plan_type: "team",
      rate_limit: {
        primary_window: { used_percent: 6, reset_at: 7 },
      },
    })).toEqual({ weeklyPercent: 6, weeklyResetAt: 7 });
  });

  test("WHAM parser returns null when no valid quota window is present", () => {
    expect(parseUsageQuota({ rate_limit: {} })).toBeNull();
    expect(parseUsageQuota({
      rate_limit: {
        secondary_window: { used_percent: Number.POSITIVE_INFINITY },
      },
    })).toBeNull();
  });

  test("WHAM parser does not fabricate missing windows as zero", () => {
    const quota = parseUsageQuota({
      rate_limit: {
        tertiary_window: { used_percent: 30, reset_at: 3 },
      },
    });
    expect(quota).toEqual({ monthlyPercent: 30, monthlyResetAt: 3 });
  });

  test("WHAM parser clamps finite out-of-range percentages and drops invalid windows", () => {
    const quota = parseUsageQuota({
      rate_limit: {
        secondary_window: { used_percent: 150, reset_at: 2 },
        tertiary_window: { used_percent: -5, reset_at: -3 },
      },
    });
    expect(quota).toEqual({
      weeklyPercent: 100,
      monthlyPercent: 0,
      weeklyResetAt: 2,
    });
  });

  test("all-unknown pool preserves the active account until quota is known", () => {
    const config = makeConfig();
    // No updateAccountQuota calls: both a and b score the unknown sentinel.
    expect(resolveCodexAccountForThread("all-unknown-rotate", config)).toBe("a");
    expect(config.activeCodexAccountId).toBe("a");
  });

  test("all-unknown with no eligible rotation target stays put without throwing", () => {
    const config = makeConfig({
      codexAccounts: [{ id: "a", email: "a@test", isMain: false }],
      activeCodexAccountId: "a",
    });
    expect(resolveCodexAccountForThread("all-unknown-no-target", config)).toBe("a");
    expect(config.activeCodexAccountId).toBe("a");
  });

  test("mixed known/unknown still picks the truly-lower account, never an unknown", () => {
    const config = makeConfig({
      codexAccounts: [
        { id: "a", email: "a@test", isMain: false },
        { id: "b", email: "b@test", isMain: false },
        { id: "c", email: "c@test", isMain: false },
      ],
      activeCodexAccountId: "a",
    });
    saveTestCredential("c");
    updateAccountQuota("a", 90); // active over threshold
    // b stays unknown; c is genuinely low.
    updateAccountQuota("c", 5);
    expect(resolveCodexAccountForThread("mixed-pick-lower", config)).toBe("c");
    expect(config.activeCodexAccountId).toBe("c");
  });

  test("known-but-saturated active does not bounce to an unknown candidate", () => {
    const config = makeConfig();
    updateAccountQuota("a", 95); // real 95, not the unknown sentinel
    // b unknown.
    expect(resolveCodexAccountForThread("saturated-known", config)).toBe("a");
    expect(config.activeCodexAccountId).toBe("a");
  });

  test("threshold=0 disables auto-switch even when all quotas are unknown", () => {
    const config = makeConfig({ autoSwitchThreshold: 0 });
    expect(resolveCodexAccountForThread("threshold-disabled", config)).toBe("a");
    expect(config.activeCodexAccountId).toBe("a");
  });

  test("unknown active quota stays selected even when other candidates differ in health", () => {
    const config = makeConfig({
      codexAccounts: [
        { id: "a", email: "a@test", isMain: false },
        { id: "b", email: "b@test", isMain: false },
        { id: "c", email: "c@test", isMain: false },
      ],
      activeCodexAccountId: "a",
    });
    saveTestCredential("c");
    // Put b into cooldown via a 429 quota outcome; c remains a usable unknown.
    recordCodexUpstreamOutcome(config, "b", 429);
    expect(isCodexAccountInCooldown("b")).toBe(true);
    expect(resolveCodexAccountForThread("rotate-skip-cooldown", config)).toBe("a");
    expect(config.activeCodexAccountId).toBe("a");
  });

  // Phase 40 (260630_wsl-account-autoswitch): bound-thread quota re-eval.
  test("bound thread over threshold switches after the re-eval interval", () => {
    const config = makeConfig();
    const now = 1_800_000_000_000;
    updateAccountQuota("a", 10);
    updateAccountQuota("b", 10);
    // Bind t1 to a while a is cool.
    expect(resolveCodexAccountForThread("t1", config, now)).toBe("a");
    // a goes hot, b stays cool.
    updateAccountQuota("a", 95);
    updateAccountQuota("b", 5);
    const later = now + CODEX_THREAD_AFFINITY_REEVAL_INTERVAL_MS + 1;
    expect(resolveCodexAccountForThread("t1", config, later)).toBe("b");
    expect(config.activeCodexAccountId).toBe("b");
  });

  test("bound thread over threshold switches immediately without waiting for re-eval (#584)", () => {
    const config = makeConfig();
    const now = 1_800_000_000_000;
    updateAccountQuota("a", 10);
    updateAccountQuota("b", 10);
    expect(resolveCodexAccountForThread("t1", config, now)).toBe("a");
    updateAccountQuota("a", 95);
    updateAccountQuota("b", 5);
    // Depleted primary must not stay pinned for up to 60s while a cooler account exists.
    expect(resolveCodexAccountForThread("t1", config, now + 1_000)).toBe("b");
    expect(config.activeCodexAccountId).toBe("b");
  });

  test("bound thread under threshold stays even if a lower account exists", () => {
    const config = makeConfig();
    const now = 1_800_000_000_000;
    updateAccountQuota("a", 10);
    updateAccountQuota("b", 10);
    expect(resolveCodexAccountForThread("t1", config, now)).toBe("a");
    // a at 50 (under threshold 80), b lower at 5.
    updateAccountQuota("a", 50);
    updateAccountQuota("b", 5);
    const later = now + CODEX_THREAD_AFFINITY_REEVAL_INTERVAL_MS + 1;
    expect(resolveCodexAccountForThread("t1", config, later)).toBe("a");
    expect(config.activeCodexAccountId).toBe("a");
  });

  test("bound thread under threshold does not flap within the re-eval interval", () => {
    const config = makeConfig();
    const now = 1_800_000_000_000;
    updateAccountQuota("a", 10);
    updateAccountQuota("b", 10);
    expect(resolveCodexAccountForThread("t1", config, now)).toBe("a");
    // Still under threshold — must not rebind on every reuse.
    updateAccountQuota("a", 50);
    updateAccountQuota("b", 5);
    expect(resolveCodexAccountForThread("t1", config, now + 1_000)).toBe("a");
    const later = now + CODEX_THREAD_AFFINITY_REEVAL_INTERVAL_MS + 1;
    expect(resolveCodexAccountForThread("t1", config, later)).toBe("a");
  });

  test("bound thread over threshold switches once and does not ping-pong", () => {
    const config = makeConfig();
    const now = 1_800_000_000_000;
    updateAccountQuota("a", 10);
    updateAccountQuota("b", 10);
    expect(resolveCodexAccountForThread("t1", config, now)).toBe("a");
    updateAccountQuota("a", 95);
    updateAccountQuota("b", 5);
    expect(resolveCodexAccountForThread("t1", config, now + 1_000)).toBe("b");
    // A subsequent interval does not ping-pong back: b is now the lowest.
    const later2 = now + 1_000 + CODEX_THREAD_AFFINITY_REEVAL_INTERVAL_MS + 1;
    expect(resolveCodexAccountForThread("t1", config, later2)).toBe("b");
  });

  test("bound thread with an all-unknown pool does not flap on re-eval", () => {
    const config = makeConfig();
    const now = 1_800_000_000_000;
    updateAccountQuota("a", 10);
    updateAccountQuota("b", 10);
    expect(resolveCodexAccountForThread("t1", config, now)).toBe("a");
    // Both unknown now (over threshold sentinel, but strict < yields no better).
    clearAccountQuota();
    const later = now + CODEX_THREAD_AFFINITY_REEVAL_INTERVAL_MS + 1;
    expect(resolveCodexAccountForThread("t1", config, later)).toBe("a");
    expect(config.activeCodexAccountId).toBe("a");
  });

  test("bound thread reuse under the interval still slides the idle TTL", () => {
    const config = makeConfig();
    const now = 1_800_000_000_000;
    updateAccountQuota("a", 10);
    updateAccountQuota("b", 10);
    expect(resolveCodexAccountForThread("t1", config, now)).toBe("a");
    // Reuse just under the re-eval interval keeps the binding (slides lastUsedAt),
    // then a reuse just under the 24h idle TTL from THAT point still resolves a.
    const reuse = now + CODEX_THREAD_AFFINITY_REEVAL_INTERVAL_MS - 1;
    expect(resolveCodexAccountForThread("t1", config, reuse)).toBe("a");
    const nearIdle = reuse + CODEX_THREAD_AFFINITY_IDLE_TTL_MS - 1;
    expect(resolveCodexAccountForThread("t1", config, nearIdle)).toBe("a");
  });

  // Soft-avoid: transient failures block pool selection for a bounded window.
  test("transient failures soft-avoid only when the configured threshold is reached", () => {
    const config = makeConfig();
    const now = 1_800_000_000_000;
    updateAccountQuota("a", 10);
    updateAccountQuota("b", 20);

    recordCodexUpstreamOutcome(config, "a", 503, { now });
    recordCodexUpstreamOutcome(config, "a", 503, { now: now + 1 });
    expect(isCodexAccountSoftAvoided("a", now + 1)).toBe(false);
    expect(resolveCodexAccountForThread("soft-before", config, now + 1)).toBe("a");
    recordCodexUpstreamOutcome(config, "a", 503, { now: now + 2 });
    expect(isCodexAccountSoftAvoided("a", now + 3)).toBe(true);
    expect(getCodexAccountSoftAvoidUntil("a", now + 3)).toBe(now + 2 + CODEX_TRANSIENT_SOFT_AVOID_MS);
    // New threads skip the soft-avoided account.
    expect(resolveCodexAccountForThread("soft-next", config, now + 3)).toBe("b");
    // After the window expires, the account is selectable again.
    expect(isCodexAccountSoftAvoided("a", now + 2 + CODEX_TRANSIENT_SOFT_AVOID_MS + 1)).toBe(false);
  });

  test("2xx clears soft-avoid but preserves hard quota cooldown", () => {
    const config = makeConfig();
    const now = 1_800_000_000_000;
    // First put "a" into hard cooldown via 429.
    recordCodexUpstreamOutcome(config, "a", 429, { retryAfter: "120", now });
    // Then a transient failure adds soft-avoid on top.
    recordCodexUpstreamOutcome(config, "a", 503, { now: now + 1_000 });
    recordCodexUpstreamOutcome(config, "a", 503, { now: now + 1_001 });
    recordCodexUpstreamOutcome(config, "a", 503, { now: now + 1_002 });
    expect(isCodexAccountSoftAvoided("a", now + 1_003)).toBe(true);

    // Success clears soft-avoid but the hard cooldown survives.
    recordCodexUpstreamOutcome(config, "a", 200, { now: now + 2_000 });
    recordCodexUpstreamOutcome(config, "a", 200, { now: now + 2_001 });
    expect(isCodexAccountSoftAvoided("a", now + 2_002)).toBe(false);
    expect(isCodexAccountInCooldown("a", now + 2_002)).toBe(true);
  });

  test("soft-avoid extends on repeated transient failures", () => {
    const config = makeConfig();
    const now = 1_800_000_000_000;
    recordCodexUpstreamOutcome(config, "a", "connect_error", { now });
    recordCodexUpstreamOutcome(config, "a", "timeout", { now: now + 1 });
    recordCodexUpstreamOutcome(config, "a", 503, { now: now + 2 });
    expect(getCodexAccountSoftAvoidUntil("a", now + 3)).toBe(now + 2 + CODEX_TRANSIENT_SOFT_AVOID_MS);
    recordCodexUpstreamOutcome(config, "a", "timeout", { now: now + 10_000 });
    expect(getCodexAccountSoftAvoidUntil("a", now + 10_001)).toBe(now + 10_000 + 2 * 60_000);
  });

  test("soft-avoid is not applied when failover threshold is 0", () => {
    const config = makeConfig({ upstreamFailoverThreshold: 0 });
    const now = 1_800_000_000_000;
    updateAccountQuota("a", 10);
    updateAccountQuota("b", 20);

    recordCodexUpstreamOutcome(config, "a", 503, { now });
    recordCodexUpstreamOutcome(config, "a", 503, { now: now + 1 });
    recordCodexUpstreamOutcome(config, "a", 503, { now: now + 2 });

    expect(isCodexAccountSoftAvoided("a", now + 3)).toBe(false);
    expect(resolveCodexAccountForThread("disabled-next", config, now + 3)).toBe("a");
  });

  // Race-safe affinity: late failures must not delete a newer healthy binding.
  test("late failure from old account does not delete a newer healthy affinity", () => {
    const config = makeConfig();
    const now = 1_800_000_000_000;
    updateAccountQuota("a", 10);
    updateAccountQuota("b", 20);

    // Bind thread T to account A.
    expect(resolveCodexAccountForThread("race-thread", config, now)).toBe("a");

    // The configured third failure rebinds to B.
    recordCodexUpstreamOutcome(config, "a", 503, { now: now + 1, threadId: "race-thread" });
    recordCodexUpstreamOutcome(config, "a", 503, { now: now + 2, threadId: "race-thread" });
    recordCodexUpstreamOutcome(config, "a", 503, { now: now + 3, threadId: "race-thread" });
    expect(resolveCodexAccountForThread("race-thread", config, now + 4)).toBe("b");

    // Late failure from A arrives AFTER the thread is already on B.
    // Must NOT delete B's healthy mapping.
    recordCodexUpstreamOutcome(config, "a", 503, { now: now + 5, threadId: "race-thread" });
    expect(resolveCodexAccountForThread("race-thread", config, now + 6)).toBe("b");
  });

  test("threadId meta clears affinity only for the failing account", () => {
    const config = makeConfig();
    const now = 1_800_000_000_000;
    updateAccountQuota("a", 10);
    updateAccountQuota("b", 20);

    // Bind to A; only the configured third transient clears the pin.
    expect(resolveCodexAccountForThread("unbind-thread", config, now)).toBe("a");
    recordCodexUpstreamOutcome(config, "a", "connect_error", { now: now + 1, threadId: "unbind-thread" });
    recordCodexUpstreamOutcome(config, "a", "connect_error", { now: now + 2, threadId: "unbind-thread" });
    expect(resolveCodexAccountForThread("unbind-thread", config, now + 2)).toBe("a");
    recordCodexUpstreamOutcome(config, "a", "connect_error", { now: now + 3, threadId: "unbind-thread" });
    expect(resolveCodexAccountForThread("unbind-thread", config, now + 4)).toBe("b");
  });

  test("failover streak clears all affinities for the failing account", () => {
    const config = makeConfig();
    const now = 1_800_000_000_000;
    updateAccountQuota("a", 10);
    updateAccountQuota("b", 20);

    // Bind two threads to A.
    expect(resolveCodexAccountForThread("t1", config, now)).toBe("a");
    expect(resolveCodexAccountForThread("t2", config, now + 1)).toBe("a");

    // Three failures trip the failover streak, clearing ALL pins to A.
    recordCodexUpstreamOutcome(config, "a", 503, { now: now + 2 });
    recordCodexUpstreamOutcome(config, "a", 503, { now: now + 3 });
    recordCodexUpstreamOutcome(config, "a", 503, { now: now + 4 });

    // Both threads rebind to B.
    expect(resolveCodexAccountForThread("t1", config, now + 5)).toBe("b");
    expect(resolveCodexAccountForThread("t2", config, now + 6)).toBe("b");
  });
});
