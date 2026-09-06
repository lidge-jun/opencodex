import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OcxConfig } from "../../src/types";
import { saveCodexAccountCredential } from "../../src/codex/account-store";
import { clearAccountQuota, setAccountQuotaFromParsed, updateAccountQuota } from "../../src/codex/quota";
import { clearCodexUpstreamHealth, recordCodexUpstreamOutcome } from "../../src/codex/routing";
import { captureMainQuotaWriter, observeMainQuotaIdentity } from "../../src/codex/main-account-cache";
import { getCodexQuotaRevision } from "../../src/codex/quota-events";
import { getCodexStrictQuotaStatus } from "../../src/codex/strict-quota";
import { refreshStrictCodexQuotasOnDemand, setStrictCodexQuotaRefreshForTests,
  strictCodexQuotaWaiterCount, waitForStrictCodexQuotaChange } from "../../src/codex/strict-quota-refresh";

let dir: string;
let previousHome: string | undefined;
let previousCodexHome: string | undefined;
let restore: (() => void) | undefined;
let now: number;
let calls: string[][];
const timers = new Map<ReturnType<typeof setTimeout>, { fn: () => void; delay: number }>();
let cancellations: number;
const config = (): OcxConfig => ({ providers: {}, codexAccountStrictQuota: true, autoSwitchThreshold: 95,
  pausedCodexAccountIds: ["__main__"], codexAccounts: [{ id: "a" }, { id: "b" }, { id: "c" }] } as OcxConfig);
function credential(id: string) {
  saveCodexAccountCredential(id, { accessToken: `test-access-${id}`, refreshToken: `test-refresh-${id}`,
    chatgptAccountId: `test-owner-${id}`, expiresAt: Date.now() + 3600000 });
}
function runtime(refresh: (cfg: OcxConfig, ids: readonly string[]) => Promise<void> = async () => {}) {
  restore = setStrictCodexQuotaRefreshForTests(async (cfg, ids) => {
    calls.push([...ids]); await refresh(cfg, ids);
  }, { now: () => now,
    setTimeout: (fn, delay) => {
      const timer = { unref() {} } as ReturnType<typeof setTimeout>;
      timers.set(timer, { fn, delay }); return timer;
    },
    clearTimeout: timer => { cancellations++; timers.delete(timer); },
  });
}
function fireTimer() {
  const [timer, { fn, delay }] = [...timers][0]!;
  timers.delete(timer); now += delay; fn();
}
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ocx-strict-refresh-"));
  previousHome = process.env.OPENCODEX_HOME; previousCodexHome = process.env.CODEX_HOME;
  process.env.OPENCODEX_HOME = dir; process.env.CODEX_HOME = dir;
  clearAccountQuota(); clearCodexUpstreamHealth(); for (const id of ["a", "b", "c"]) credential(id);
  now = Date.now(); calls = []; cancellations = 0;
});
afterEach(() => {
  expect(strictCodexQuotaWaiterCount()).toBe(0); expect(timers.size).toBe(0);
  restore?.(); restore = undefined; clearAccountQuota(); clearCodexUpstreamHealth();
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME; else process.env.OPENCODEX_HOME = previousHome;
  if (previousCodexHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = previousCodexHome;
  rmSync(dir, { recursive: true, force: true });
});
describe("strict quota request refresh", () => {
  test("one batch for simultaneous callers, with no idle timers", async () => {
    let release!: () => void;
    runtime(async () => await new Promise<void>(resolve => { release = resolve; }));
    const cfg = config();
    const work = Array.from({ length: 20 }, () => refreshStrictCodexQuotasOnDemand(cfg));
    await Promise.resolve(); expect(calls).toEqual([["a", "b", "c"]]);
    release(); const results = await Promise.all(work);
    expect(results.every(result => result.status === "attempted")).toBe(true);
    expect(calls).toHaveLength(1); expect(timers.size).toBe(0);
  });
  test("overlapping batches serialize across config instances instead of multiplying API concurrency", async () => {
    let firstRelease!: () => void;
    let active = 0; let maximum = 0;
    runtime(async () => {
      active++; maximum = Math.max(maximum, active);
      if (calls.length === 1) await new Promise<void>(resolve => { firstRelease = resolve; });
      active--;
    });
    const first = refreshStrictCodexQuotasOnDemand(config(), new Set(["a", "b"]));
    const second = refreshStrictCodexQuotasOnDemand(config(), new Set(["b", "c"]));
    await Promise.resolve(); firstRelease(); await Promise.all([first, second]);
    expect(calls).toEqual([["a", "b"], ["c"]]); expect(maximum).toBe(1);
  });
  test("failure is observable and earns five-minute backoff without changing eligibility", async () => {
    runtime(async () => { throw new Error("sensitive upstream failure detail"); });
    const cfg = config();
    expect(await refreshStrictCodexQuotasOnDemand(cfg, new Set(["a"]))).toEqual({ status: "failed", accountIds: ["a"] });
    now += 299999;
    expect((await refreshStrictCodexQuotasOnDemand(cfg, new Set(["a"]))).status).toBe("idle");
    expect(getCodexStrictQuotaStatus(cfg, "a").state).toBe("unknown");
    now++;
    expect((await refreshStrictCodexQuotasOnDemand(cfg, new Set(["a"]))).status).toBe("failed");
    expect(calls).toHaveLength(2);
  });
  test("unknown after credential repair does not inherit old-attempt backoff", async () => {
    runtime(); const cfg = config();
    await refreshStrictCodexQuotasOnDemand(cfg, new Set(["a"]));
    credential("a");
    await refreshStrictCodexQuotasOnDemand(cfg, new Set(["a"]));
    expect(calls).toEqual([["a"], ["a"]]);
  });
  for (const unit of ["seconds", "milliseconds"] as const) {
    test(`${unit} reset permits one early read, never automatic recovery`, async () => {
      runtime(); const cfg = config();
      const reset = Date.now() + 10000;
      setAccountQuotaFromParsed("a", { weeklyPercent: 99, weeklyResetAt: unit === "seconds" ? reset / 1000 : reset });
      now = reset - 1;
      await refreshStrictCodexQuotasOnDemand(cfg, new Set(["a"])); expect(calls).toHaveLength(0);
      now = reset + 1000;
      await refreshStrictCodexQuotasOnDemand(cfg, new Set(["a"])); expect(calls).toEqual([["a"]]);
      expect(getCodexStrictQuotaStatus(cfg, "a", "shared", now).state).toBe("blocked");
      now += 1000;
      await refreshStrictCodexQuotasOnDemand(cfg, new Set(["a"])); expect(calls).toHaveLength(1);
    });
  }
  test("requested ready account does not trigger reads of other blocked accounts", async () => {
    runtime(); updateAccountQuota("a", 1); updateAccountQuota("b", 99);
    now = Date.now();
    await refreshStrictCodexQuotasOnDemand(config(), new Set(["a"]));
    expect(calls).toHaveLength(0);
  });
});
describe("strict quota live waiters", () => {
  test("manual quota update wakes all waiters and removes their sole timer", async () => {
    runtime(); const cfg = config();
    const one = waitForStrictCodexQuotaChange(cfg); const two = waitForStrictCodexQuotaChange(cfg);
    expect(timers.size).toBe(1); expect(strictCodexQuotaWaiterCount()).toBe(2);
    updateAccountQuota("a", 0); await Promise.all([one, two]);
    expect(cancellations).toBe(1); expect(calls).toHaveLength(0);
  });
  test("last cancellation removes timer and subscription with no idle poll", async () => {
    runtime(); const cfg = config(); const a = new AbortController(); const b = new AbortController();
    const first = waitForStrictCodexQuotaChange(cfg, a.signal).catch(error => error.name);
    const second = waitForStrictCodexQuotaChange(cfg, b.signal).catch(error => error.name);
    a.abort(); expect(timers.size).toBe(1); b.abort();
    expect(await first).toBe("AbortError"); expect(await second).toBe("AbortError");
    expect(timers.size).toBe(0); expect(cancellations).toBe(1);
    updateAccountQuota("a", 1); expect(calls).toHaveLength(0);
  });
  test("timer only wakes requests; it never refreshes by itself", async () => {
    runtime(); const cfg = config(); await refreshStrictCodexQuotasOnDemand(cfg);
    const waiting = waitForStrictCodexQuotaChange(cfg);
    expect([...timers.values()][0]!.delay).toBe(300000);
    fireTimer(); await waiting;
    expect(calls).toHaveLength(1); expect(strictCodexQuotaWaiterCount()).toBe(0);
    await refreshStrictCodexQuotasOnDemand(cfg); expect(calls).toHaveLength(2);
  });
  test("unobserved native main and unprobed accounts do not cause one-second wakeups", async () => {
    runtime(); const cfg = config(); cfg.pausedCodexAccountIds = [];
    await refreshStrictCodexQuotasOnDemand(cfg, new Set(["a"]));
    const waiting = waitForStrictCodexQuotaChange(cfg);
    expect([...timers.values()][0]!.delay).toBe(300000);
    fireTimer(); await waiting;
    expect(calls).toEqual([["a"]]);
  });
  test("stale observed but ineligible native main does not shorten a real pool attempt's backoff", async () => {
    runtime(); const cfg = config(); cfg.pausedCodexAccountIds = [];
    observeMainQuotaIdentity("strict-wait-ineligible-main");
    const writer = captureMainQuotaWriter("strict-wait-ineligible-main")!;
    setAccountQuotaFromParsed("__main__", { weeklyPercent: 99 }, undefined, writer);
    now = Date.now() + 300001;
    // The resolver cannot use physical main for this request, so it probes only its real pool candidate.
    await refreshStrictCodexQuotasOnDemand(cfg, new Set(["a"]));
    const waiting = waitForStrictCodexQuotaChange(cfg);
    const delay = [...timers.values()][0]!.delay;
    fireTimer(); await waiting;
    expect(delay).toBe(300000);
    expect(calls).toEqual([["a"]]);
    expect(getCodexStrictQuotaStatus(cfg, "__main__", "shared", now).state).toBe("blocked");
  });
  test("a wholly unobserved pool uses the default waiting interval", async () => {
    runtime(); const waiting = waitForStrictCodexQuotaChange(config());
    expect([...timers.values()][0]!.delay).toBe(300000);
    fireTimer(); await waiting;
    expect(calls).toHaveLength(0);
  });
  test("quota update between refusal and waiter registration is not lost", async () => {
    runtime(); const revision = getCodexQuotaRevision();
    updateAccountQuota("a", 0);
    await waitForStrictCodexQuotaChange(config(), undefined, revision);
    expect(timers.size).toBe(0); expect(strictCodexQuotaWaiterCount()).toBe(0);
    expect(calls).toHaveLength(0);
  });
  test("a live upstream cooldown wakes at expiry rather than the quota freshness interval", async () => {
    runtime(); const cfg = config(); updateAccountQuota("a", 20);
    now = Date.now();
    recordCodexUpstreamOutcome(cfg, "a", 429, { retryAfter: "30", modelId: "gpt-5.6-luna", now, fixedAccount: true });
    const waiting = waitForStrictCodexQuotaChange(cfg);
    expect([...timers.values()][0]!.delay).toBe(30000);
    fireTimer(); await waiting;
    const afterExpiry = waitForStrictCodexQuotaChange(cfg);
    expect([...timers.values()][0]!.delay).toBeGreaterThan(1000);
    fireTimer(); await afterExpiry;
    expect(calls).toHaveLength(0);
  });
  test("already cancelled requests do not subscribe or schedule", async () => {
    runtime(); const controller = new AbortController(); controller.abort();
    await expect(waitForStrictCodexQuotaChange(config(), controller.signal)).rejects.toThrow();
  });
});
