/**
 * Anthropic states its own rate limits in band; the pool must believe them.
 *
 * Every `/v1/messages` response carries `anthropic-ratelimit-unified-*`: the five-hour and
 * seven-day utilization of the account that served the turn, and the epoch each window
 * reopens. Two defects follow from ignoring them, and these tests pin both fixes.
 *
 * The first is the cooldown. A drained five-hour window answers with `Retry-After: 7999`
 * (2h13m), which the rotator clamped to a 15-minute ceiling meant for a GUESSED backoff.
 * That does not shorten the ban -- upstream keeps refusing -- it re-offers the exhausted
 * account four times an hour, and each attempt spends a real request to earn another 429.
 *
 * The second is the measurement. `fiveHourScore` reads a cache that only a periodic
 * `/api/oauth/usage` probe of the ACTIVE account ever filled, so a pool of two accounts
 * routinely scored both at `UNKNOWN_USAGE_SCORE` and picked between them blind -- while the
 * exact numbers it wanted rode along with every answer it had already received.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  clearAnthropicAccountCooldown,
  clearAnthropicAccountPoolState,
  forgetAnthropicFailoverQuorum,
  getAnthropicAccountHealthSnapshot,
  rotateAnthropicAccountOn429,
} from "../../../src/oauth/anthropic-routing";
import { projectStoredOAuthAccountHealth } from "../../../src/oauth/health";
import {
  clearAccountQuotaCache,
  getCachedProviderAccountQuota,
  parseAnthropicRateLimitHeaders,
  recordAnthropicAccountQuotaFromHeaders,
  reconcileProviderAccountQuotaRows,
  resetProviderQuotaReconcileStateForTests,
  setCachedProviderAccountQuotaForTests,
} from "../../../src/providers/quota";
import { getAccountSet, saveCredential } from "../../../src/oauth/store";
import { clearPoolRotationState } from "../../../src/codex/pool-rotation";
import { removeTreeWithRetry } from "../../helpers/remove-tree";
import type { OcxConfig } from "../../../src/types";

const originalHome = process.env.OPENCODEX_HOME;
let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ocx-anthropic-ratelimit-"));
  process.env.OPENCODEX_HOME = home;
  clearAnthropicAccountPoolState();
  clearPoolRotationState();
  clearAccountQuotaCache();
  // `lastReconciledGeneration` is module-global and survives a cache clear, so the fence case
  // below would otherwise raise the floor for every test that runs after it in this file.
  resetProviderQuotaReconcileStateForTests();
  forgetAnthropicFailoverQuorum();
});

afterEach(() => {
  clearAnthropicAccountPoolState();
  clearPoolRotationState();
  // The argument-less form, deliberately: only it calls cancelPendingAccountQuotaPersist.
  // The observer ends in a 250ms-debounced write that resolves OPENCODEX_HOME at fire time,
  // so a provider-scoped clear would leave that write to land in whatever home is current a
  // quarter second later — the next test's sandbox, or the developer's real one.
  clearAccountQuotaCache();
  resetProviderQuotaReconcileStateForTests();
  forgetAnthropicFailoverQuorum();
  if (originalHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = originalHome;
  removeTreeWithRetry(home);
});

/** The store assigns its own slot ids, so the seeded `accountId` is never the cache key. */
async function seed(count: number): Promise<string[]> {
  for (let i = 0; i < count; i++) {
    await saveCredential("anthropic", {
      access: `access-${i}`,
      refresh: `refresh-${i}`,
      expires: Date.now() + 3_600_000,
      accountId: `uuid-${i}`,
      email: `user${i}@example.test`,
    } as never);
  }
  return getAccountSet("anthropic")?.accounts.map(a => a.id) ?? [];
}

function poolEnabled(): OcxConfig {
  return {
    port: 0,
    defaultProvider: "anthropic",
    providers: {
      anthropic: { adapter: "anthropic", baseUrl: "https://api.anthropic.com", authMode: "oauth" },
    },
    anthropicAccountPool: { enabled: true },
  } as OcxConfig;
}

/** A real 429 from a drained five-hour window, captured from api.anthropic.com. */
function drainedFiveHour(resetEpochSeconds: number): Headers {
  return new Headers({
    "anthropic-ratelimit-unified-status": "rejected",
    "anthropic-ratelimit-unified-5h-status": "rejected",
    "anthropic-ratelimit-unified-5h-reset": String(resetEpochSeconds),
    "anthropic-ratelimit-unified-5h-utilization": "1.0",
    "anthropic-ratelimit-unified-7d-status": "allowed",
    "anthropic-ratelimit-unified-7d-reset": String(resetEpochSeconds + 86_400),
    "anthropic-ratelimit-unified-7d-utilization": "0.36",
  });
}

describe("Anthropic cooldown honours the stated window", () => {
  test("a multi-hour Retry-After is not truncated to the guessed-backoff ceiling", async () => {
    const start = Date.now();
    const ids = await seed(2);
    // 7999s is what a drained five-hour window actually answers; the old 15-minute clamp
    // turned a single refusal into sixteen wasted retries before the window reopened.
    rotateAnthropicAccountOn429(poolEnabled(), ids[0]!, "7999", null, start);
    const health = getAnthropicAccountHealthSnapshot(ids[0]!, start);
    expect(health?.cooldownUntil).toBe(start + 7_999_000);
    expect(health?.cooldownSource).toBe("retry-after");
  });

  test("an absurd Retry-After is still bounded", async () => {
    const start = Date.now();
    const ids = await seed(2);
    // The ceiling did not disappear, it moved: a stated reset is trusted up to the longest
    // window Anthropic publishes, so a wire anomaly cannot bench an account for a week.
    rotateAnthropicAccountOn429(poolEnabled(), ids[0]!, "604800", null, start);
    expect(getAnthropicAccountHealthSnapshot(ids[0]!, start)?.cooldownUntil)
      .toBe(start + 6 * 60 * 60_000);
  });

  test("an HTTP-date Retry-After is honoured, and bounded by the same ceiling", async () => {
    const start = Date.now();
    const ids = await seed(2);
    // RFC 9110 allows either form, and both are upstream STATING when it will serve again --
    // the date branch had its own clamp and would have kept the 15-minute truncation.
    rotateAnthropicAccountOn429(poolEnabled(), ids[0]!, new Date(start + 2 * 60 * 60_000).toUTCString(), null, start);
    const cooldown = getAnthropicAccountHealthSnapshot(ids[0]!, start)?.cooldownUntil;
    // toUTCString drops sub-second precision, so the deadline lands within a second of target.
    expect(cooldown).toBeGreaterThan(start + 2 * 60 * 60_000 - 1_000);
    expect(cooldown).toBeLessThanOrEqual(start + 2 * 60 * 60_000);

    rotateAnthropicAccountOn429(poolEnabled(), ids[1]!, new Date(start + 48 * 60 * 60_000).toUTCString(), null, start);
    expect(getAnthropicAccountHealthSnapshot(ids[1]!, start)?.cooldownUntil).toBe(start + 6 * 60 * 60_000);
  });

  test("a 429 without Retry-After cools until the rejected window reopens", async () => {
    const start = Date.now();
    const ids = await seed(2);
    // The wire carries whole seconds, so the reset is built from an epoch second and the
    // expectation is derived from the same value rather than from `start + 90min` — an
    // assertion on the un-truncated millisecond would be testing the fixture, not the code.
    const resetEpochSeconds = Math.floor((start + 90 * 60_000) / 1000);
    // Retry-After is not guaranteed on an Anthropic 429; the rejected window's reset is.
    // Without reading it this refusal cooled for the 60s default and the drained account
    // was back in the rotation a minute later.
    rotateAnthropicAccountOn429(poolEnabled(), ids[0]!, null, null, start, drainedFiveHour(resetEpochSeconds));
    const health = getAnthropicAccountHealthSnapshot(ids[0]!, start);
    expect(health?.cooldownUntil).toBe(resetEpochSeconds * 1000);
    // Its own source, not "retry-after": the dashboard renders that one as request-rate
    // throttling, and a spent five-hour window is quota. Same vocabulary the Codex pool uses.
    expect(health?.cooldownSource).toBe("reset-derived");
  });

  test("an ALLOWED window's reset never cools the account", async () => {
    const start = Date.now();
    const ids = await seed(2);
    // Every response names when the current period ends, including a healthy one. Treating
    // that as a cooldown would bench an account with 4% used for the rest of its window.
    const healthy = new Headers({
      "anthropic-ratelimit-unified-status": "allowed",
      "anthropic-ratelimit-unified-5h-status": "allowed",
      "anthropic-ratelimit-unified-5h-reset": String(Math.floor((start + 3 * 60 * 60_000) / 1000)),
      "anthropic-ratelimit-unified-5h-utilization": "0.04",
    });
    rotateAnthropicAccountOn429(poolEnabled(), ids[0]!, null, null, start, healthy);
    const health = getAnthropicAccountHealthSnapshot(ids[0]!, start);
    expect(health?.cooldownUntil).toBe(start + 60_000);
    expect(health?.cooldownSource).toBe("default");
  });

  test("both windows rejected cools until the LAST one reopens", async () => {
    const start = Date.now();
    const ids = await seed(2);
    // The limiter is AND-composed: upstream refuses while ANY window rejects. An account whose
    // 5-hour bucket rolls in three minutes is still refused for the days its weekly window
    // needs, so cooling to the earliest reset would re-offer it every three minutes until the
    // weekly window finally reopens -- the exact loop this path exists to end.
    const fiveHourReset = Math.floor((start + 3 * 60_000) / 1000);
    const weeklyReset = Math.floor((start + 5 * 60 * 60_000) / 1000);
    const bothDrained = new Headers({
      "anthropic-ratelimit-unified-status": "rejected",
      "anthropic-ratelimit-unified-5h-status": "rejected",
      "anthropic-ratelimit-unified-5h-reset": String(fiveHourReset),
      "anthropic-ratelimit-unified-7d-status": "rejected",
      "anthropic-ratelimit-unified-7d-reset": String(weeklyReset),
    });
    rotateAnthropicAccountOn429(poolEnabled(), ids[0]!, null, null, start, bothDrained);
    expect(getAnthropicAccountHealthSnapshot(ids[0]!, start)?.cooldownUntil).toBe(weeklyReset * 1000);
  });

  test("a reset-derived cooldown surfaces as quota, a Retry-After as a rate limit", async () => {
    const start = Date.now();
    const ids = await seed(2);
    const account = getAccountSet("anthropic")!.accounts.find(a => a.id === ids[0]!)!;
    // The distinction is not cosmetic: the dashboard tells an operator to wait out a rate
    // limit and to switch accounts on spent quota. A drained five-hour window is the second.
    rotateAnthropicAccountOn429(
      poolEnabled(),
      ids[0]!,
      null,
      null,
      start,
      drainedFiveHour(Math.floor((start + 90 * 60_000) / 1000)),
    );
    expect(projectStoredOAuthAccountHealth("anthropic", account, start)).toMatchObject({
      status: "cooldown",
      reason: "quota",
    });

    clearAnthropicAccountCooldown(ids[0]!);
    rotateAnthropicAccountOn429(poolEnabled(), ids[0]!, "300", null, start);
    expect(projectStoredOAuthAccountHealth("anthropic", account, start)).toMatchObject({
      status: "cooldown",
      reason: "rate_limit",
    });
  });

  test("Retry-After wins over the header reset", async () => {
    const start = Date.now();
    const ids = await seed(2);
    // Retry-After is written for this decision; the reset epoch is a fallback for the
    // refusals that omit it. A disagreement must not silently prefer the fallback.
    rotateAnthropicAccountOn429(
      poolEnabled(),
      ids[0]!,
      "120",
      null,
      start,
      drainedFiveHour(Math.floor((start + 4 * 60 * 60_000) / 1000)),
    );
    expect(getAnthropicAccountHealthSnapshot(ids[0]!, start)?.cooldownUntil).toBe(start + 120_000);
  });
});

describe("Anthropic rate-limit headers feed the routing cache", () => {
  test("utilization is read as a fraction, not as a percent", () => {
    // The header sends 0.74 for a 74%-spent window while the probe endpoint sends 74.0 for
    // the same account. Passing the header value through unscaled would file the emptiest
    // account as the freshest and route every new session straight at it.
    const quota = parseAnthropicRateLimitHeaders(new Headers({
      "anthropic-ratelimit-unified-5h-utilization": "0.42",
      "anthropic-ratelimit-unified-7d-utilization": "0.74",
    }));
    expect(quota?.fiveHourPercent).toBe(42);
    expect(quota?.weeklyPercent).toBe(74);
  });

  test("reset epochs are promoted from seconds to milliseconds", () => {
    const quota = parseAnthropicRateLimitHeaders(new Headers({
      "anthropic-ratelimit-unified-5h-utilization": "0.5",
      "anthropic-ratelimit-unified-5h-reset": "1788717000",
    }));
    expect(quota?.fiveHourResetAt).toBe(1_788_717_000_000);
  });

  test("a header set with no utilization yields no measurement", () => {
    // A renamed or dropped header must degrade to "unmeasured", which the router already
    // has a defined behaviour for -- never to a fabricated zero, which reads as a fresh
    // account and would pull traffic toward whichever account stopped reporting.
    expect(parseAnthropicRateLimitHeaders(new Headers({
      "anthropic-ratelimit-unified-5h-reset": "1788717000",
    }))).toBeNull();
  });

  test("a utilization above 1 is rejected rather than clamped", () => {
    // Above one is a wire change, not a full window. Inventing 100 from it would cool a
    // healthy account on a misread.
    expect(parseAnthropicRateLimitHeaders(new Headers({
      "anthropic-ratelimit-unified-5h-utilization": "42",
    }))).toBeNull();
  });

  test("an observed turn makes the serving account's usage known to the router", async () => {
    const ids = await seed(2);
    // Before the observation the account has no reading at all, which is what left a
    // two-account pool scoring both at UNKNOWN_USAGE_SCORE and picking between them blind.
    expect(getCachedProviderAccountQuota("anthropic", ids[0]!)).toBeNull();
    recordAnthropicAccountQuotaFromHeaders(ids[0]!, drainedFiveHour(Math.floor(Date.now() / 1000) + 3600), 0);
    expect(getCachedProviderAccountQuota("anthropic", ids[0]!)?.fiveHourPercent).toBe(100);
    // The other account stays unmeasured: an observation is attributed to the account that
    // served the turn, never spread across the roster.
    expect(getCachedProviderAccountQuota("anthropic", ids[1]!)).toBeNull();
  });

  test("headers with nothing parseable leave the previous reading intact", async () => {
    const ids = await seed(1);
    recordAnthropicAccountQuotaFromHeaders(ids[0]!, new Headers({
      "anthropic-ratelimit-unified-5h-utilization": "0.25",
    }), 0);
    recordAnthropicAccountQuotaFromHeaders(ids[0]!, new Headers({ "content-type": "application/json" }), 0);
    // A response that says nothing about quota is not evidence that the quota is gone.
    expect(getCachedProviderAccountQuota("anthropic", ids[0]!)?.fiveHourPercent).toBe(25);
  });

  test("an empty account id writes nothing", () => {
    // API-key providers and single-account installs below failover quorum reach the observer
    // with no account to attribute; that is an ordinary state, not an error. Asserting only
    // that it does not throw would pass with the guard deleted -- an empty-string cache key
    // is perfectly writable -- so this asserts the absence of the row instead.
    recordAnthropicAccountQuotaFromHeaders("", drainedFiveHour(Math.floor(Date.now() / 1000) + 3600), 0);
    expect(getCachedProviderAccountQuota("anthropic", "")).toBeNull();
  });

  test("a stale writer generation is refused", async () => {
    const ids = await seed(1);
    // The fence exists because a turn is a long await: an account or config change that lands
    // mid-turn must not be overwritten by a measurement taken before it. Every other test here
    // passes 0, which a fresh worker always accepts, so without this case the parameter is
    // carried but never actually exercised as a fence.
    reconcileProviderAccountQuotaRows({
      generation: 5,
      providerNames: new Set(),
      comboIds: new Set(),
      comboTargets: new Set(),
      codexAccountIds: new Set(),
      oauthAccountKeys: new Set(),
      configRoots: new Set(),
    });
    recordAnthropicAccountQuotaFromHeaders(ids[0]!, new Headers({
      "anthropic-ratelimit-unified-5h-utilization": "0.5",
    }), 1);
    expect(getCachedProviderAccountQuota("anthropic", ids[0]!)).toBeNull();
  });

  test("an observation keeps the model-scoped bars the probe filled", async () => {
    const ids = await seed(1);
    // The probe reports per-model weekly limits (Opus, Sonnet, Fable) that no header carries.
    // They are read by the manual-preference exhaustion check and by `headroomOf`, so a
    // wholesale replace would not merely blank the dashboard: it would route an Opus request
    // to an account whose Opus allowance is spent.
    setCachedProviderAccountQuotaForTests("anthropic", ids[0]!, {
      fiveHourPercent: 10,
      weeklyPercent: 20,
      customWindows: [{ label: "Opus", percent: 96 }],
      updatedAt: Date.now(),
    });
    recordAnthropicAccountQuotaFromHeaders(ids[0]!, new Headers({
      "anthropic-ratelimit-unified-5h-utilization": "0.41",
    }), 0);
    const quota = getCachedProviderAccountQuota("anthropic", ids[0]!);
    expect(quota?.fiveHourPercent).toBe(41);
    // Untouched by this observation, not erased by it.
    expect(quota?.weeklyPercent).toBe(20);
    expect(quota?.customWindows).toEqual([{ label: "Opus", percent: 96 }]);
  });

  test("a percent that is not exactly representable is rounded, not left as an artifact", () => {
    // `0.29 * 100` is 28.999999999999996 in binary floating point, and the CLI interpolates the
    // percent raw. A user reading `5h 28.999999999999996%` would reasonably file a bug.
    expect(parseAnthropicRateLimitHeaders(new Headers({
      "anthropic-ratelimit-unified-5h-utilization": "0.29",
    }))?.fiveHourPercent).toBe(29);
  });
});
