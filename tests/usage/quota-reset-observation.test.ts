import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  clearAccountQuota,
  flushQuotaObservationsForTests,
  setAccountQuotaFromParsed,
} from "../../src/codex/quota";
import type { QuotaResetEvent } from "../../src/quota/reset-detector";
import {
  hasQuotaResetSink,
  observeQuotaSnapshot,
  setQuotaResetSink,
} from "../../src/quota/reset-observer";
import { resetQuotaResetStoreForTests } from "../../src/quota/reset-seen-store";
import {
  isQuotaResetPollerRunning,
  resetQuotaResetPollerForTests,
  startQuotaResetPoller,
  stopQuotaResetPoller,
} from "../../src/quota/reset-poller";
import { resetQuotaResetNotifyCacheForTests } from "../../src/quota/reset-notify-config";

const ACCOUNT = "acct_reset_observation";
const HOUR = 60 * 60_000;

let captured: QuotaResetEvent[] = [];

/** Join the writer's ordered observation/forget chain, including cold imports. */
async function settle(): Promise<void> {
  await flushQuotaObservationsForTests();
}

beforeEach(async () => {
  await settle();
  captured = [];
  resetQuotaResetStoreForTests();
  resetQuotaResetNotifyCacheForTests();
  resetQuotaResetPollerForTests();
  clearAccountQuota();
  await settle();
  setQuotaResetSink(event => {
    captured.push(event);
  });
});

afterEach(async () => {
  await settle();
  setQuotaResetSink(null);
  resetQuotaResetPollerForTests();
  clearAccountQuota();
  await settle();
});

describe("codex quota seam", () => {
  test("a weekly rollover through the real writer fires exactly one scheduled event", async () => {
    const expired = Date.now() - 60_000;
    setAccountQuotaFromParsed(ACCOUNT, { weeklyPercent: 96, weeklyResetAt: expired });
    await settle();
    expect(captured).toEqual([]); // first write is a baseline

    setAccountQuotaFromParsed(ACCOUNT, { weeklyPercent: 2, weeklyResetAt: Date.now() + 7 * 24 * HOUR });
    await settle();
    expect(captured).toHaveLength(1);
    expect(captured[0]?.kind).toBe("scheduled");
    expect(captured[0]?.window).toBe("weekly");
    expect(captured[0]?.scope).toBe("codex");

    // Observing the same post-reset state again must not notify twice.
    setAccountQuotaFromParsed(ACCOUNT, { weeklyPercent: 3, weeklyResetAt: Date.now() + 7 * 24 * HOUR });
    await settle();
    expect(captured).toHaveLength(1);
  });

  test("a surprise reset through the real writer fires a surprise event", async () => {
    const future = Date.now() + 2 * HOUR;
    setAccountQuotaFromParsed(ACCOUNT, { shortPercent: 96, shortResetAt: future, shortWindowSeconds: 18_000 });
    await settle();
    captured = [];

    setAccountQuotaFromParsed(ACCOUNT, { shortPercent: 4, shortResetAt: future, shortWindowSeconds: 18_000 });
    await settle();
    expect(captured).toHaveLength(1);
    expect(captured[0]?.kind).toBe("surprise");
    expect(captured[0]?.window).toBe("5h");
  });

  test("a credits-only write fires nothing despite a fresh updatedAt", async () => {
    setAccountQuotaFromParsed(ACCOUNT, { weeklyPercent: 40, weeklyResetAt: Date.now() + 3 * 24 * HOUR });
    await settle();
    captured = [];

    // src/codex/quota.ts:276 copies every window field verbatim here.
    setAccountQuotaFromParsed(ACCOUNT, { resetCredits: 3 });
    await settle();
    expect(captured).toEqual([]);
  });

  test("credits-only refresh does not make later natural rolling decay look like a reset", async () => {
    const start = Date.now();
    let now = start;
    const clock = spyOn(Date, "now").mockImplementation(() => now);
    try {
      setAccountQuotaFromParsed(ACCOUNT, { shortPercent: 96, shortResetAt: start + 5 * HOUR, shortWindowSeconds: 18_000 });
      await flushQuotaObservationsForTests();
      expect(captured).toEqual([]);
      now = start + 59 * 60_000;
      setAccountQuotaFromParsed(ACCOUNT, { resetCredits: 3 });
      await flushQuotaObservationsForTests();
      expect(captured).toEqual([]);
      now = start + HOUR;
      setAccountQuotaFromParsed(ACCOUNT, { shortPercent: 4, shortResetAt: start + 6 * HOUR, shortWindowSeconds: 18_000 });
      await flushQuotaObservationsForTests();
      expect(captured).toEqual([]);
    } finally { clock.mockRestore(); }
  });

  test("a cleared row followed by a fresh low percent fires nothing", async () => {
    setAccountQuotaFromParsed(ACCOUNT, { weeklyPercent: 91, weeklyResetAt: Date.now() + 3 * 24 * HOUR });
    await settle();
    captured = [];

    // Reauth and account purge both do this deliberately — and they clear ONLY the quota row.
    // This test used to call resetQuotaResetStoreForTests() here too, which no production path
    // does: it wiped the observer's separate baseline file and so simulated a state that never
    // occurs. With that line removed the test failed (surprise, 91% -> 0%), which is what
    // clearAccountQuota now forgetting its baseline fixes.
    clearAccountQuota(ACCOUNT);
    setAccountQuotaFromParsed(ACCOUNT, { weeklyPercent: 0, weeklyResetAt: Date.now() + 7 * 24 * HOUR });
    await settle();
    expect(captured).toEqual([]);
  });

  test("no sink installed means no observation at all", async () => {
    setQuotaResetSink(null);
    expect(hasQuotaResetSink()).toBe(false);
    const expired = Date.now() - 60_000;
    setAccountQuotaFromParsed(ACCOUNT, { weeklyPercent: 96, weeklyResetAt: expired });
    await settle();
    setAccountQuotaFromParsed(ACCOUNT, { weeklyPercent: 1, weeklyResetAt: Date.now() + HOUR });
    await settle();
    expect(captured).toEqual([]);
  });
});

describe("observer contract", () => {
  test("the baseline comes from the persisted map, not the caller", () => {
    const expired = Date.now() - 60_000;
    expect(observeQuotaSnapshot({
      scope: "anthropic",
      accountKey: "anthropic\u0000acct-1",
      windows: [{ window: "weekly", percent: 88, resetAt: expired }],
    })).toEqual([]);

    const delivered = observeQuotaSnapshot({
      scope: "anthropic",
      accountKey: "anthropic\u0000acct-1",
      windows: [{ window: "weekly", percent: 2, resetAt: Date.now() + 7 * 24 * HOUR }],
    });
    expect(delivered).toHaveLength(1);
    expect(delivered[0]?.kind).toBe("scheduled");
  });

  test("two accounts of one provider do not inherit each other's history", () => {
    const expired = Date.now() - 60_000;
    observeQuotaSnapshot({
      scope: "anthropic",
      accountKey: "anthropic\u0000acct-A",
      windows: [{ window: "weekly", percent: 96, resetAt: expired }],
    });
    // A switch to a different account is an identity change, not a reset.
    const delivered = observeQuotaSnapshot({
      scope: "anthropic",
      accountKey: "anthropic\u0000acct-B",
      windows: [{ window: "weekly", percent: 1, resetAt: Date.now() + HOUR }],
    });
    expect(delivered).toEqual([]);
  });

  test("a throwing sink does not propagate to the caller", () => {
    setQuotaResetSink(() => {
      throw new Error("sink exploded");
    });
    const expired = Date.now() - 60_000;
    observeQuotaSnapshot({
      scope: "codex",
      accountKey: "throwing",
      windows: [{ window: "weekly", percent: 96, resetAt: expired }],
    });
    expect(() => observeQuotaSnapshot({
      scope: "codex",
      accountKey: "throwing",
      windows: [{ window: "weekly", percent: 1, resetAt: Date.now() + HOUR }],
    })).not.toThrow();
  });
});

describe("idle poller", () => {
  test("starting twice creates one timer and stop clears it", () => {
    expect(isQuotaResetPollerRunning()).toBe(false);
    startQuotaResetPoller(60_000);
    startQuotaResetPoller(60_000);
    expect(isQuotaResetPollerRunning()).toBe(true);
    stopQuotaResetPoller();
    expect(isQuotaResetPollerRunning()).toBe(false);
  });

  test("a disabled config makes a tick a no-op", async () => {
    const { runQuotaResetPollerTickForTests, quotaResetPollerTickCountForTests } = await import(
      "../../src/quota/reset-poller"
    );
    await runQuotaResetPollerTickForTests();
    expect(quotaResetPollerTickCountForTests()).toBe(0);
  });

  test("the interval floor matches the documented per-account TTL", async () => {
    // The docstring claims the floor sits above the 10-minute per-account TTL; 60s did not.
    const { MIN_INTERVAL_MS } = await import("../../src/quota/reset-poller");
    expect(MIN_INTERVAL_MS).toBe(600_000);
  });

  test("the configured pollSeconds reaches the poller interval", async () => {
    const { quotaResetPollerIntervalForTests } = await import("../../src/quota/reset-poller");
    // Above the floor, so the configured cadence is what must survive to setInterval.
    startQuotaResetPoller(1_800_000);
    expect(quotaResetPollerIntervalForTests()).toBe(1_800_000);
    stopQuotaResetPoller();

    // Below the floor: clamped rather than accepted, so no timer outruns the account TTL.
    startQuotaResetPoller(60_000);
    expect(quotaResetPollerIntervalForTests()).toBe(600_000);
    stopQuotaResetPoller();
  });

  test("an overlapping tick is skipped and a tick completing after stop does not publish", async () => {
    const {
      runQuotaResetPollerTickForTests,
      quotaResetPollerTickCountForTests,
    } = await import("../../src/quota/reset-poller");
    // A real enabled config is what carries a tick past its early returns; the resolver reads
    // the config file rather than exposing an injection seam.
    const home = mkdtempSync(join(tmpdir(), "ocx-poller-"));
    writeFileSync(join(home, "config.json"), JSON.stringify({
      port: 10100,
      defaultProvider: "openai",
      providers: {
        openai: { adapter: "openai-responses", baseUrl: "https://api.openai.com/v1", authMode: "forward" },
      },
      quotaResetNotify: { enabled: true, command: ["true"], pollSeconds: 900 },
    }));
    const previousHome = process.env["OPENCODEX_HOME"];
    process.env["OPENCODEX_HOME"] = home;
    resetQuotaResetNotifyCacheForTests();
    try {
      startQuotaResetPoller(900_000);
      const before = quotaResetPollerTickCountForTests();

      // Two ticks launched without awaiting the first: the second must return immediately
      // rather than issuing a second forced probe against a rate-limited endpoint.
      const first = runQuotaResetPollerTickForTests();
      const second = runQuotaResetPollerTickForTests();
      await Promise.all([first, second]);
      expect(quotaResetPollerTickCountForTests()).toBe(before + 1);

      // A tick that starts and then loses the timer under it must not count as a probe:
      // its result belongs to a generation that no longer owns the poller.
      const late = runQuotaResetPollerTickForTests();
      stopQuotaResetPoller();
      await late;
      expect(quotaResetPollerTickCountForTests()).toBe(before + 1);
    } finally {
      stopQuotaResetPoller();
      if (previousHome === undefined) delete process.env["OPENCODEX_HOME"];
      else process.env["OPENCODEX_HOME"] = previousHome;
      resetQuotaResetNotifyCacheForTests();
    }
  });
});

describe("observation ordering under a burst", () => {
  test("a rising-usage burst in a COLD process fires nothing", async () => {
    // The regression this pins: the seam awaited two import() calls before swapping the
    // baseline, and Bun does not resolve concurrent dynamic imports in call order. A burst of
    // monotonically RISING usage — no reset anywhere in it — arrived reordered and produced a
    // false "surprise" event on every run. The false event also claimed the durable
    // idempotence key, so the genuine reset on that window was then suppressed permanently.
    //
    // Runs in a CHILD PROCESS deliberately. An in-process version of this test passed against
    // the unfixed seam, because earlier tests in this file leave the observer module cached and
    // a cached import resolves in call order. Only a cold module registry reproduces it. Driven
    // red before the fix: 3/3 child runs reported a false surprise (82->58, 26->10, 42->22);
    // after the fix, 3/3 report none.
    const child = fileURLToPath(new URL("../helpers/quota-reset-burst-child.ts", import.meta.url));
    const proc = Bun.spawn([process.execPath, child], {
      // A private OPENCODEX_HOME: the baseline is persisted, so a shared home would let one
      // run seed the next and turn this into a test of leftover state.
      env: { ...process.env, OPENCODEX_HOME: mkdtempSync(join(tmpdir(), "ocx-burst-")) },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, out, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    expect(exitCode, `cold burst probe failed: ${stderr}\nstdout: ${out}`).toBe(0);
    expect(JSON.parse(out.trim())).toEqual([]);
  });

  test("a real rollover at the end of a burst still fires exactly once", async () => {
    // The ordering fix must not buy its silence by dropping observations. Usage climbs, then
    // the weekly window genuinely rolls over on the final write.
    const expired = Date.now() - 60_000;
    for (let percent = 60; percent <= 96; percent += 4) {
      setAccountQuotaFromParsed(ACCOUNT, { weeklyPercent: percent, weeklyResetAt: expired });
    }
    await flushQuotaObservationsForTests();
    await settle();
    captured = [];

    setAccountQuotaFromParsed(ACCOUNT, {
      weeklyPercent: 1,
      weeklyResetAt: Date.now() + 7 * 24 * HOUR,
    });
    await flushQuotaObservationsForTests();
    await settle();

    expect(captured).toHaveLength(1);
    expect(captured[0]?.kind).toBe("scheduled");
    expect(captured[0]?.window).toBe("weekly");
  });
});
