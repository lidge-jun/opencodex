/** Anthropic response observations must preserve account usage and probe semantics. */
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  clearAnthropicAccountCooldown,
  clearAnthropicAccountPoolState,
  forgetAnthropicFailoverQuorum,
  getAnthropicAccountHealthSnapshot,
  rotateAnthropicAccountOn429,
  resetAnthropicRoutingForManualSelection,
  resolveAnthropicAccountForSession,
} from "../../../src/oauth/anthropic-routing";
import { projectStoredOAuthAccountHealth } from "../../../src/oauth/health";
import { quotaEvidenceForCandidate } from "../../../src/routing/quota";
import {
  clearAccountQuotaCache,
  fetchProviderAccountQuotas,
  getCachedProviderAccountQuota,
  parseAnthropicRateLimitHeaders,
  recordAnthropicAccountQuotaFromHeaders,
  reconcileProviderAccountQuotaRows,
  resetProviderQuotaReconcileStateForTests,
  setCachedProviderAccountQuotaForTests,
  sweepExpiredProviderAccountQuotaRows,
} from "../../../src/providers/quota";
import { getAccountSet, saveCredential, setActiveAccount } from "../../../src/oauth/store";
import { clearPoolRotationState } from "../../../src/codex/pool-rotation";
import { removeTreeWithRetry } from "../../helpers/remove-tree";
import type { OcxConfig } from "../../../src/types";

const originalHome = process.env.OPENCODEX_HOME;
const originalFetch = globalThis.fetch;
const originalNow = Date.now;
let home: string;

beforeEach(() => {
  globalThis.fetch = (async () => { throw new Error("Unexpected network request in quota test"); }) as typeof fetch;
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
  globalThis.fetch = originalFetch;
  Date.now = originalNow;
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

  test("a week-long Retry-After retains its stated deadline", async () => {
    const start = Date.now();
    const ids = await seed(2);
    rotateAnthropicAccountOn429(poolEnabled(), ids[0]!, "604800", null, start);
    expect(getAnthropicAccountHealthSnapshot(ids[0]!, start)?.cooldownUntil)
      .toBe(start + 604_800_000);
  });

  test("an HTTP-date Retry-After is honoured beyond six hours", async () => {
    const start = Date.now();
    const ids = await seed(2);
    // RFC 9110 allows either form, and both are upstream STATING when it will serve again --
    // the date branch had its own clamp and would have kept the 15-minute truncation.
    rotateAnthropicAccountOn429(poolEnabled(), ids[0]!, new Date(start + 2 * 60 * 60_000).toUTCString(), null, start);
    const cooldown = getAnthropicAccountHealthSnapshot(ids[0]!, start)?.cooldownUntil;
    // toUTCString drops sub-second precision, so the deadline lands within a second of target.
    expect(cooldown).toBeGreaterThan(start + 2 * 60 * 60_000 - 1_000);
    expect(cooldown).toBeLessThanOrEqual(start + 2 * 60 * 60_000);

    const reset = Math.floor(start / 1000) * 1000 + 48 * 60 * 60_000;
    rotateAnthropicAccountOn429(poolEnabled(), ids[1]!, new Date(reset).toUTCString(), null, start);
    expect(getAnthropicAccountHealthSnapshot(ids[1]!, start)?.cooldownUntil).toBe(reset);
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
    const weeklyReset = Math.floor((start + 5 * 24 * 60 * 60_000) / 1000);
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

describe("Anthropic observation and probe clocks", () => {
  function observe(accountId: string, percent = "0.41"): void {
    recordAnthropicAccountQuotaFromHeaders(accountId, new Headers({
      "anthropic-ratelimit-unified-5h-utilization": percent,
    }), 0);
  }

  function usageResponse(): Response {
    return Response.json({ five_hour: { utilization: 12 }, seven_day_opus: { utilization: 63 } });
  }

  test("a cold header-only row does not defer the first usage probe", async () => {
    const [id] = await seed(1);
    let calls = 0;
    globalThis.fetch = (async () => { calls++; return usageResponse(); }) as typeof fetch;
    observe(id!);
    expect(getCachedProviderAccountQuota("anthropic", id!)?.fiveHourPercent).toBe(41);
    const [row] = await fetchProviderAccountQuotas("anthropic");
    expect(calls).toBe(1);
    expect(row?.quota).toMatchObject({ fiveHourPercent: 12, customWindows: [{ label: "Opus", percent: 63 }] });
    expect(row?.unavailable).toBeUndefined();
  });

  test("fresh header observations survive sweeping until their own TTL expires", async () => {
    const [id] = await seed(1);
    const observedAt = originalNow();
    Date.now = () => observedAt;
    observe(id!);
    expect(sweepExpiredProviderAccountQuotaRows(observedAt + 1)).toBe(0);
    expect(getCachedProviderAccountQuota("anthropic", id!)?.fiveHourPercent).toBe(41);
    expect(sweepExpiredProviderAccountQuotaRows(observedAt + 10 * 60_000 - 1)).toBe(0);
    expect(sweepExpiredProviderAccountQuotaRows(observedAt + 10 * 60_000)).toBe(1);
    expect(getCachedProviderAccountQuota("anthropic", id!)).toBeNull();
  });

  test("headers preserve the probe TTL instead of renewing it", async () => {
    const [id] = await seed(1);
    let now = originalNow();
    Date.now = () => now;
    let calls = 0;
    globalThis.fetch = (async () => { calls++; return usageResponse(); }) as typeof fetch;
    await fetchProviderAccountQuotas("anthropic");
    now += 9 * 60_000;
    observe(id!);
    expect((await fetchProviderAccountQuotas("anthropic"))[0]?.quota?.fiveHourPercent).toBe(41);
    expect(calls).toBe(1);
    now += 60_001;
    await fetchProviderAccountQuotas("anthropic");
    expect(calls).toBe(2);
  });

  for (const observeAfterRestart of [false, true]) {
    test(`restart keeps Anthropic probes due with new headers: ${observeAfterRestart}`, async () => {
      const [id] = await seed(1);
      const updatedAt = Date.now();
      const saved = { fiveHourPercent: 41, customWindows: [{ label: "Opus", percent: 63 }], updatedAt };
      writeFileSync(join(home, "provider-account-quota-cache.json"), JSON.stringify({
        version: 1,
        rows: { [`anthropic\u0000${id}`]: saved, "kiro\u0000other": { monthlyPercent: 17, updatedAt } },
      }));
      clearAccountQuotaCache();
      // Cover both dashboard-first and response-first hydration after restart.
      if (observeAfterRestart) observe(id!, "0.52");
      let calls = 0;
      globalThis.fetch = (async () => { calls++; return new Response("busy", { status: 429 }); }) as typeof fetch;
      const [row] = await fetchProviderAccountQuotas("anthropic");
      expect(calls).toBe(1);
      expect(row?.quota).toMatchObject({ fiveHourPercent: observeAfterRestart ? 52 : 41, customWindows: saved.customWindows });
      expect(getCachedProviderAccountQuota("kiro", "other")?.monthlyPercent).toBe(17);
      expect(row?.unavailable).toBe(true);
    });
  }

  for (const [failure, warm] of [["http", true], ["network", true], ["http", false]] as const) {
    test(`joined ${failure} probe failures preserve in-flight headers (warm cache: ${warm})`, async () => {
      const [id] = await seed(1);
      if (warm) setCachedProviderAccountQuotaForTests("anthropic", id!, {
        fiveHourPercent: 10, weeklyPercent: 20, customWindows: [{ label: "Opus", percent: 63 }], updatedAt: Date.now(),
      });
      let started!: () => void;
      const dispatched = new Promise<void>(resolve => { started = resolve; });
      let finish!: (response: Response) => void;
      let fail!: (error: Error) => void;
      const response = new Promise<Response>((resolve, reject) => { finish = resolve; fail = reject; });
      let calls = 0;
      globalThis.fetch = (async () => { calls++; started(); return response; }) as typeof fetch;
      const first = fetchProviderAccountQuotas("anthropic", true);
      await dispatched;
      const second = fetchProviderAccountQuotas("anthropic", true);
      observe(id!);
      const latest = getCachedProviderAccountQuota("anthropic", id!);
      if (failure === "http") finish(new Response("busy", { status: 429 }));
      else fail(new Error("offline"));
      const [a, b] = await Promise.all([first, second]);
      expect(calls).toBe(1);
      expect(a).toEqual(b);
      expect(a[0]?.quota).toEqual(latest);
      expect(a[0]?.quota?.fiveHourPercent).toBe(41);
      if (warm) expect(a[0]?.quota).toMatchObject({ weeklyPercent: 20, customWindows: [{ label: "Opus", percent: 63 }] });
      expect(a[0]?.unavailable).toBe(true);
      expect(getCachedProviderAccountQuota("anthropic", id!)).toEqual(latest);
      // A later partial observation cannot claim that the failed usage probe succeeded.
      observe(id!, "0.53");
      const [cached] = await fetchProviderAccountQuotas("anthropic");
      expect(cached?.unavailable).toBe(true);
      expect(cached?.quota?.fiveHourPercent).toBe(53);
      expect(calls).toBe(1);
      globalThis.fetch = (async () => usageResponse()) as typeof fetch;
      expect((await fetchProviderAccountQuotas("anthropic", true))[0]?.unavailable).toBeUndefined();
    });
  }
});

describe("Anthropic malformed deadlines and partial windows", () => {
  for (const invalid of ["NaN", "Infinity", "1e309", "1e308", "8640000000001", "not-a-date", "-1", "0"]) {
    test(`invalid reset ${invalid} cannot establish a cooldown deadline`, async () => {
      const start = Date.now();
      const [id] = await seed(1);
      const headers = new Headers({
        "anthropic-ratelimit-unified-7d-status": "rejected",
        "anthropic-ratelimit-unified-7d-reset": invalid,
        "anthropic-ratelimit-unified-7d-utilization": "0.74",
      });
      rotateAnthropicAccountOn429(poolEnabled(), id!, null, null, start, headers);
      expect(getAnthropicAccountHealthSnapshot(id!, start)).toMatchObject({
        cooldownUntil: start + 60_000, cooldownSource: "default",
      });
      expect(parseAnthropicRateLimitHeaders(headers)?.weeklyResetAt).toBeUndefined();
    });
  }

  test("overflowing Retry-After falls back to a valid rejected reset", async () => {
    const start = Date.now();
    const [id] = await seed(1);
    const reset = Math.floor(start / 1000) + 432_000;
    for (const invalid of ["9".repeat(400), "8640000000001", "invalid-date"]) {
      rotateAnthropicAccountOn429(poolEnabled(), id!, invalid, null, start, drainedFiveHour(reset));
      expect(getAnthropicAccountHealthSnapshot(id!, start)).toMatchObject({
        cooldownUntil: reset * 1000, cooldownSource: "reset-derived",
      });
    }
  });

  test("a malformed weekly deadline cannot hide a valid five-hour reset", async () => {
    const start = Date.now();
    const [id] = await seed(1);
    const reset = Math.floor(start / 1000) + 180;
    const headers = drainedFiveHour(reset);
    headers.set("anthropic-ratelimit-unified-7d-status", "rejected");
    headers.set("anthropic-ratelimit-unified-7d-reset", "1e308");
    rotateAnthropicAccountOn429(poolEnabled(), id!, null, null, start, headers);
    expect(getAnthropicAccountHealthSnapshot(id!, start)?.cooldownUntil).toBe(reset * 1000);
  });

  test("partial zero utilization preserves other and model-specific windows", async () => {
    const [id] = await seed(1);
    const customWindows = [{ label: "Opus", percent: 63 }];
    setCachedProviderAccountQuotaForTests("anthropic", id!, {
      fiveHourPercent: 10, weeklyPercent: 20, weeklyResetAt: 1_800_000_000_000, customWindows, updatedAt: Date.now(),
    });
    recordAnthropicAccountQuotaFromHeaders(id!, new Headers({
      "anthropic-ratelimit-unified-5h-utilization": "0",
      "anthropic-ratelimit-unified-7d-utilization": "NaN",
      "anthropic-ratelimit-unified-7d-reset": "1e308",
    }), 0);
    expect(getCachedProviderAccountQuota("anthropic", id!)).toMatchObject({
      fiveHourPercent: 0, weeklyPercent: 20, weeklyResetAt: 1_800_000_000_000, customWindows,
    });
  });
});

describe("Anthropic known-reset expiry", () => {
  const start = 1_800_000_000_000;
  let now: number;

  beforeEach(() => {
    now = start;
    Date.now = () => now;
  });

  function observe(id: string, headers: Record<string, string> = {
    "anthropic-ratelimit-unified-5h-utilization": "0.41",
  }): void {
    recordAnthropicAccountQuotaFromHeaders(id, new Headers(headers), 0);
  }

  test("headers expire only known elapsed custom windows without mutating their source", async () => {
    const [id] = await seed(1);
    const saved = {
      fiveHourPercent: 10,
      customWindows: [
        { label: "Opus", percent: 100, resetAt: start + 60_000 },
        { label: "Sonnet", percent: 90, resetAt: start + 600_000 },
        { label: "Fable", percent: 70 },
        { label: "Unknown reset", percent: 60, resetAt: 0 },
      ],
      updatedAt: start,
    };
    setCachedProviderAccountQuotaForTests("anthropic", id!, saved);
    now += 120_000;
    observe(id!);
    const quota = getCachedProviderAccountQuota("anthropic", id!);
    const retained = [saved.customWindows[1], saved.customWindows[2], { label: "Unknown reset", percent: 60 }];
    expect(quota?.customWindows).toEqual(retained);
    expect(quota?.fiveHourPercent).toBe(41);
    expect(quota?.updatedAt).toBe(now);
    expect(saved.customWindows).toHaveLength(4);
    expect(saved.updatedAt).toBe(start);
    now += 30_000;
    observe(id!);
    expect(getCachedProviderAccountQuota("anthropic", id!)?.customWindows).toEqual(retained);
  });

  test("custom windows reject empty labels and invalid percentages while preserving valid objects", async () => {
    const [id] = await seed(1);
    const valid = [{ label: "Opus", percent: 0 }, { label: "Sonnet", percent: 100, resetAt: start + 60_000 }];
    const saved = { customWindows: [
      ...valid,
      { label: "", percent: 50 }, { label: "   ", percent: 50 },
      { label: "negative", percent: -1 }, { label: "too high", percent: 101 },
      { label: "not finite", percent: Number.NaN }, { label: "infinite", percent: Infinity },
    ], updatedAt: start };
    setCachedProviderAccountQuotaForTests("anthropic", id!, saved);
    const normalized = getCachedProviderAccountQuota("anthropic", id!);
    expect(normalized?.customWindows).toEqual(valid);
    expect(normalized?.customWindows?.[0]).toBe(valid[0]);
    expect(saved.customWindows).toHaveLength(8);
    setCachedProviderAccountQuotaForTests("anthropic", id!, normalized!);
    expect(getCachedProviderAccountQuota("anthropic", id!)).toBe(normalized);
  });

  test("invalid reset metadata is removed without discarding valid usage", async () => {
    const [id] = await seed(1);
    const invalidResets = [0, -1, Number.NaN, Infinity, 8_640_000_000_000_001];
    const saved = {
      fiveHourPercent: 40, fiveHourResetAt: 0,
      weeklyPercent: 50, weeklyResetAt: Infinity,
      monthlyPercent: 60, monthlyResetAt: 8_640_000_000_000_001,
      customWindows: invalidResets.map((resetAt, index) => ({ label: `window-${index}`, percent: 70, resetAt })),
      updatedAt: start,
    };
    setCachedProviderAccountQuotaForTests("anthropic", id!, saved);
    const normalized = getCachedProviderAccountQuota("anthropic", id!);
    expect(normalized).toEqual({
      fiveHourPercent: 40, weeklyPercent: 50, monthlyPercent: 60,
      customWindows: invalidResets.map((_, index) => ({ label: `window-${index}`, percent: 70 })),
      updatedAt: start,
    });
    expect(saved.customWindows[0]?.resetAt).toBe(0);
    expect(saved.fiveHourResetAt).toBe(0);
    setCachedProviderAccountQuotaForTests("anthropic", id!, normalized!);
    expect(getCachedProviderAccountQuota("anthropic", id!)).toBe(normalized);
  });

  for (const [percent, reset, observedWindow] of [
    ["fiveHourPercent", "fiveHourResetAt", "7d"],
    ["weeklyPercent", "weeklyResetAt", "5h"],
    ["monthlyPercent", "monthlyResetAt", "5h"],
  ] as const) {
    test(`partial headers remove the expired ${percent} pair without inventing zero`, async () => {
      const [id] = await seed(1);
      setCachedProviderAccountQuotaForTests("anthropic", id!, {
        [percent]: 100, [reset]: start + 60_000, updatedAt: start,
      });
      now += 60_000;
      observe(id!, { [`anthropic-ratelimit-unified-${observedWindow}-utilization`]: "0.2" });
      const quota = getCachedProviderAccountQuota("anthropic", id!);
      expect(quota).not.toBeNull();
      expect(quota?.[percent]).toBeUndefined();
      expect(quota?.[reset]).toBeUndefined();
    });
  }

  test("standard windows without reset evidence remain known", async () => {
    const [id] = await seed(1);
    setCachedProviderAccountQuotaForTests("anthropic", id!, { weeklyPercent: 100, updatedAt: start });
    now += 120_000;
    observe(id!);
    expect(getCachedProviderAccountQuota("anthropic", id!)?.weeklyPercent).toBe(100);
  });

  test("a reset-only header cannot extend retained usage even before the original reset", async () => {
    const [id] = await seed(1);
    setCachedProviderAccountQuotaForTests("anthropic", id!, {
      fiveHourPercent: 10, weeklyPercent: 100, weeklyResetAt: start + 60_000, updatedAt: start,
    });
    now += 30_000;
    observe(id!, {
      "anthropic-ratelimit-unified-5h-utilization": "0.2",
      "anthropic-ratelimit-unified-7d-utilization": "invalid",
      "anthropic-ratelimit-unified-7d-reset": String((start + 600_000) / 1000),
    });
    expect(getCachedProviderAccountQuota("anthropic", id!)?.weeklyResetAt).toBe(start + 60_000);
    now += 30_000;
    expect(getCachedProviderAccountQuota("anthropic", id!)?.weeklyPercent).toBeUndefined();
    expect(getCachedProviderAccountQuota("anthropic", id!)?.weeklyResetAt).toBeUndefined();
    observe(id!, {
      "anthropic-ratelimit-unified-7d-utilization": "0.3",
      "anthropic-ratelimit-unified-7d-reset": String((start + 600_000) / 1000),
    });
    expect(getCachedProviderAccountQuota("anthropic", id!)).toMatchObject({
      weeklyPercent: 30, weeklyResetAt: start + 600_000,
    });
  });

  test("idle cache reads cross a reset without another observation or probe", async () => {
    const [id] = await seed(1);
    const quota = { customWindows: [{ label: "Opus", percent: 100, resetAt: start + 60_000 }], updatedAt: start };
    setCachedProviderAccountQuotaForTests("anthropic", id!, quota);
    setCachedProviderAccountQuotaForTests("kiro", "untouched", quota);
    const candidate = { provider: "anthropic", model: "claude-opus-4-6", accountRef: id! };
    now += 59_999;
    expect(getCachedProviderAccountQuota("anthropic", id!)).toEqual(quota);
    expect(quotaEvidenceForCandidate(candidate)).toMatchObject({ known: true, exhausted: true, headroom: 0 });
    now++;
    expect(getCachedProviderAccountQuota("anthropic", id!)).toBeNull();
    expect(quotaEvidenceForCandidate(candidate)).toEqual({ known: false });
    const [row] = await fetchProviderAccountQuotas("anthropic");
    expect(row?.quota).toBeNull();
    expect(row?.unavailable).toBeUndefined();
    expect(getCachedProviderAccountQuota("kiro", "untouched")).toBe(quota);
  });

  test("expired Opus evidence stops suppressing an otherwise healthy manual selection", async () => {
    const [a, b] = await seed(2);
    setCachedProviderAccountQuotaForTests("anthropic", a!, {
      fiveHourPercent: 30, customWindows: [{ label: "Opus", percent: 100, resetAt: start + 60_000 }], updatedAt: start,
    });
    setCachedProviderAccountQuotaForTests("anthropic", b!, { fiveHourPercent: 11, updatedAt: start });
    await setActiveAccount("anthropic", a!);
    resetAnthropicRoutingForManualSelection(a!);
    const config = poolEnabled();
    config.anthropicAccountPool = { enabled: true, strategy: "quota", autoSwitchThreshold: 20 };
    const candidate = { provider: "anthropic", model: "claude-opus-4-6", accountRef: a! };
    expect(resolveAnthropicAccountForSession(null, config, now).accountId).toBe(b);
    expect(quotaEvidenceForCandidate(candidate)).toMatchObject({ known: true, exhausted: true, headroom: 0 });
    now += 60_000;
    expect(resolveAnthropicAccountForSession(null, config, now)).toMatchObject({ accountId: a, reason: "manual" });
    expect(quotaEvidenceForCandidate(candidate)).toMatchObject({ known: true, exhausted: false, headroom: 0.7 });
  });

  for (const failure of ["http", "network"] as const) {
    test(`joined ${failure} failures remove windows expiring during the shared probe`, async () => {
      const [id] = await seed(1);
      setCachedProviderAccountQuotaForTests("anthropic", id!, {
        fiveHourPercent: 10, weeklyPercent: 100, weeklyResetAt: start + 60_000,
        customWindows: [{ label: "Opus", percent: 100, resetAt: start + 60_000 }, { label: "Fable", percent: 63 }],
        updatedAt: start,
      });
      let started!: () => void;
      const dispatched = new Promise<void>(resolve => { started = resolve; });
      let finish!: (response: Response) => void;
      let fail!: (error: Error) => void;
      const response = new Promise<Response>((resolve, reject) => { finish = resolve; fail = reject; });
      let calls = 0;
      globalThis.fetch = (async () => { calls++; started(); return response; }) as typeof fetch;
      const first = fetchProviderAccountQuotas("anthropic", true);
      await dispatched;
      const second = fetchProviderAccountQuotas("anthropic", true);
      now += 30_000;
      observe(id!);
      now += 30_000;
      if (failure === "http") finish(new Response("busy", { status: 429 }));
      else fail(new Error("offline"));
      const [a, b] = await Promise.all([first, second]);
      expect(calls).toBe(1);
      expect(a).toEqual(b);
      expect(a[0]?.unavailable).toBe(true);
      expect(a[0]?.quota).toEqual({ fiveHourPercent: 41, customWindows: [{ label: "Fable", percent: 63 }], updatedAt: start + 30_000 });
      expect(getCachedProviderAccountQuota("anthropic", id!)).toEqual(a[0]?.quota);
      expect((await fetchProviderAccountQuotas("anthropic"))[0]).toEqual(a[0]);
      expect(calls).toBe(1);
    });
  }

  test("restart cannot revive expired bars from a recently updated disk row", async () => {
    const [id] = await seed(1);
    now += 120_000;
    writeFileSync(join(home, "provider-account-quota-cache.json"), JSON.stringify({ version: 1, rows: {
      [`anthropic\u0000${id}`]: {
        fiveHourPercent: 41, weeklyPercent: 100, weeklyResetAt: start + 60_000,
        customWindows: [{ label: "Opus", percent: 100, resetAt: start + 60_000 }, { label: "Fable", percent: 63 }],
        updatedAt: now,
      },
    } }));
    clearAccountQuotaCache();
    let calls = 0;
    globalThis.fetch = (async () => { calls++; return new Response("busy", { status: 429 }); }) as typeof fetch;
    const [row] = await fetchProviderAccountQuotas("anthropic");
    expect(calls).toBe(1);
    expect(row?.unavailable).toBe(true);
    expect(row?.quota).toEqual({ fiveHourPercent: 41, customWindows: [{ label: "Fable", percent: 63 }], updatedAt: now });
  });

  for (const malformed of [null, {}, [null, "bad", { label: "invalid", percent: "100" }]]) {
    test(`malformed persisted custom windows stay unknown without breaking other rows: ${JSON.stringify(malformed)}`, async () => {
      const [id] = await seed(1);
      writeFileSync(join(home, "provider-account-quota-cache.json"), JSON.stringify({ version: 1, rows: {
        [`anthropic\u0000${id}`]: { customWindows: malformed, updatedAt: now },
        "kiro\u0000untouched": { monthlyPercent: 17, updatedAt: now },
      } }));
      clearAccountQuotaCache();
      let calls = 0;
      globalThis.fetch = (async () => { calls++; return new Response("busy", { status: 429 }); }) as typeof fetch;
      const [row] = await fetchProviderAccountQuotas("anthropic");
      expect(calls).toBe(1);
      expect(row?.quota).toBeNull();
      expect(row?.unavailable).toBe(true);
      expect(getCachedProviderAccountQuota("kiro", "untouched")).toEqual({ monthlyPercent: 17, updatedAt: now });
    });
  }

  test("persisted nonnumeric reset metadata does not erase otherwise valid windows", async () => {
    const [id] = await seed(1);
    writeFileSync(join(home, "provider-account-quota-cache.json"), JSON.stringify({ version: 1, rows: {
      [`anthropic\u0000${id}`]: {
        weeklyPercent: 80, weeklyResetAt: "unknown",
        customWindows: [{ label: "Opus", percent: 70, resetAt: null }, { label: "Sonnet", percent: 60, resetAt: "later" }],
        updatedAt: now,
      },
    } }));
    clearAccountQuotaCache();
    globalThis.fetch = (async () => new Response("busy", { status: 429 })) as typeof fetch;
    const [row] = await fetchProviderAccountQuotas("anthropic");
    expect(row?.quota).toEqual({ weeklyPercent: 80,
      customWindows: [{ label: "Opus", percent: 70 }, { label: "Sonnet", percent: 60 }], updatedAt: now });
    expect(row?.unavailable).toBe(true);
  });

  test("fresh utilization without a reset does not inherit an expired reset", async () => {
    const [id] = await seed(1);
    setCachedProviderAccountQuotaForTests("anthropic", id!, {
      fiveHourPercent: 100, fiveHourResetAt: start + 60_000, updatedAt: start,
    });
    now += 60_000;
    observe(id!);
    expect(getCachedProviderAccountQuota("anthropic", id!)).toEqual({ fiveHourPercent: 41, updatedAt: now });
  });

  test("deferred persistence evaluates expiry at write time and leaves other providers intact", async () => {
    const [id] = await seed(1);
    const saved = { weeklyPercent: 100, weeklyResetAt: start + 60_000, updatedAt: start };
    setCachedProviderAccountQuotaForTests("anthropic", id!, saved);
    setCachedProviderAccountQuotaForTests("kiro", "untouched", saved);
    let flush!: () => void;
    const timer = spyOn(globalThis, "setTimeout").mockImplementation(((callback: () => void) => {
      flush = callback;
      return 0 as unknown as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout);
    try { observe(id!); } finally { timer.mockRestore(); }
    now += 60_000;
    flush();
    const disk = JSON.parse(readFileSync(join(home, "provider-account-quota-cache.json"), "utf8"));
    expect(disk.rows[`anthropic\u0000${id}`]).toEqual({ fiveHourPercent: 41, updatedAt: start });
    expect(disk.rows["kiro\u0000untouched"]).toEqual(saved);
  });
});
