import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  captureConfigGeneration,
  reconcileStateGeneration,
  registerStateStore,
  resetStateStoreSweeperForTests,
  setGenerationContextBuilder,
  startStateStoreSweeper,
  stopStateStoreSweeper,
  sweepExpired,
  sweepExpiredOnWrite,
  sweepLiveness,
  type GenerationContext,
} from "../src/lib/state-store-sweeper";
import {
  ocxStartProcessCacheSizeForTests,
  setOcxStartProcessCacheForTests,
  setOcxStartProcessProbeForTests,
  sweepDeadOcxStartProcessCache,
} from "../src/config";
import { STATE_STORE_REGISTRATIONS } from "../src/lib/state-store-registrations";
import { getAccountSet, saveCredential } from "../src/oauth/store";
import {
  clearAccountQuotaCache,
  clearProviderQuotaCache,
  fetchProviderQuotaReports,
  getCachedProviderAccountQuota,
} from "../src/providers/quota";
import type { OcxConfig } from "../src/types";
import { __resetVertexTokenCache, getVertexAccessToken } from "../src/lib/gcp-adc";
import {
  configureAppOwnedMemoryBudget,
  registerRetainedStore,
  resetAppOwnedMemoryForTests,
} from "../src/lib/app-owned-memory";
import { registerAppOwnedMemorySweepFallback } from "../src/lib/app-owned-memory-stores";
import {
  clearResponseStateMemoryForTests,
  rememberResponseState,
  responseStateMetrics,
} from "../src/responses/state";
import {
  __resetAntigravityReplayCache,
  antigravityReplayMetrics,
  observeAntigravityReplay,
} from "../src/adapters/google-antigravity-replay";

function context(
  generation: number,
  overrides: Partial<Omit<GenerationContext, "generation">> = {},
): GenerationContext {
  return {
    generation,
    providerNames: new Set(),
    comboIds: new Set(),
    comboTargets: new Set(),
    codexAccountIds: new Set(),
    oauthAccountKeys: new Set(),
    configRoots: new Set(),
    ...overrides,
  };
}

// The responses-continuation store now reclaims abandoned atomic-write temps on the liveness
// tick, so any test that drives a real tick performs filesystem work under OPENCODEX_HOME.
// Without this isolation the suite would scan (and could unlink inside) a developer's real
// ~/.opencodex as a side effect of a unit test.
let sweeperHome: string;
let previousSweeperHome: string | undefined;

beforeEach(() => {
  previousSweeperHome = process.env.OPENCODEX_HOME;
  sweeperHome = mkdtempSync(join(tmpdir(), "ocx-sweeper-home-"));
  process.env.OPENCODEX_HOME = sweeperHome;
  resetStateStoreSweeperForTests();
  resetAppOwnedMemoryForTests();
  clearResponseStateMemoryForTests();
  __resetAntigravityReplayCache();
});
afterEach(() => {
  resetStateStoreSweeperForTests();
  resetAppOwnedMemoryForTests();
  clearResponseStateMemoryForTests();
  __resetAntigravityReplayCache();
  setOcxStartProcessCacheForTests([]);
  setOcxStartProcessProbeForTests(null);
  if (previousSweeperHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousSweeperHome;
  rmSync(sweeperHome, { recursive: true, force: true });
});

describe("state-store sweeper", () => {
  test("production registrations cover the hand-maintained owner inventory", () => {
    expect(STATE_STORE_REGISTRATIONS.map(registration => registration.name)).toEqual([
      "subagent-model-health",
      "api-key-cooldowns",
      "provider-request-pacing",
      "combo-target-cooldowns",
      "anthropic-routing-health",
      "xai-refresh-verdicts",
      "responses-continuation",
      "antigravity-replay",
      "config-warning-memos",
      "catalog-warning-memos",
      "provider-fetch-warning-memos",
      "combo-warning-memos",
      "router-warning-memos",
      "codex-quota",
      "provider-quota-history",
      "codex-routing-health",
      "model-cache-history",
      "pool-rotation",
      "combo-rotation",
      "guardian-backoff",
      "codex-reauth",
      "oauth-reauth",
      "gcp-adc",
      "config-ownership",
      "oauth-flow-state",
      "ocx-start-process-cache",
    ]);
  });

  test("a sweeper tick expires continuation and Antigravity rows without store traffic", () => {
    rememberResponseState({ input: "old" }, { id: "resp_sweeper_ttl", output: [], status: "completed" });
    observeAntigravityReplay("gemini-3-pro", "session-old", [{
      thoughtSignature: "signature-long-enough-for-sweep",
      functionCall: { name: "lookup", args: { q: "old" } },
    }]);
    expect(responseStateMetrics().count).toBe(1);
    expect(antigravityReplayMetrics().sessions).toBe(1);

    for (const name of ["responses-continuation", "antigravity-replay"]) {
      registerStateStore(STATE_STORE_REGISTRATIONS.find(registration => registration.name === name)!);
    }
    const result = sweepExpired(Date.now() + 60 * 60 * 1_000 + 1);
    expect(result.rowsRemoved).toBe(2);
    expect(responseStateMetrics().count).toBe(0);
    expect(antigravityReplayMetrics().sessions).toBe(0);
  });

  test("global fake-clock sweep invokes every production clock registration", () => {
    const visits: string[] = [];
    for (const registration of STATE_STORE_REGISTRATIONS) {
      registerStateStore({
        ...registration,
        ...(registration.sweepExpired ? {
          sweepExpired: (now: number) => {
            visits.push(`${registration.name}:ttl:${now}`);
            return registration.sweepExpired!(now);
          },
        } : {}),
        ...(registration.sweepLiveness ? {
          sweepLiveness: () => {
            visits.push(`${registration.name}:liveness`);
            return registration.sweepLiveness!();
          },
        } : {}),
      });
    }

    sweepExpired(123);
    sweepLiveness();
    // Two separate passes over the table, not one interleaved pass: sweepExpired visits every
    // TTL owner, then sweepLiveness visits every liveness owner. The previous per-registration
    // flatMap only matched because the single liveness owner happened to sit last in the table.
    expect(visits).toEqual([
      ...STATE_STORE_REGISTRATIONS.flatMap(registration => (
        registration.sweepExpired ? [`${registration.name}:ttl:123`] : []
      )),
      ...STATE_STORE_REGISTRATIONS.flatMap(registration => (
        registration.sweepLiveness ? [`${registration.name}:liveness`] : []
      )),
    ]);
  });

  test("expiry boundary removes expired rows and preserves live rows", () => {
    const rows = new Map([["past", 99], ["boundary", 100], ["live", 101]]);
    registerStateStore({
      name: "ttl",
      sweepExpired: now => {
        let removed = 0;
        for (const [key, deadline] of rows) {
          if (deadline > now) continue;
          rows.delete(key);
          removed += 1;
        }
        return removed;
      },
    });

    expect(sweepExpired(100).rowsRemoved).toBe(2);
    expect([...rows]).toEqual([["live", 101]]);
  });

  test("one throwing owner does not block later sweep owners", () => {
    const warning = spyOn(console, "warn").mockImplementation(() => {});
    let later = 0;
    registerStateStore({ name: "throws", sweepExpired: () => { throw new Error("secret detail"); } });
    registerStateStore({ name: "later", sweepExpired: () => { later += 1; return 1; } });

    expect(sweepExpired(0)).toEqual({ storesVisited: 2, rowsRemoved: 1 });
    expect(later).toBe(1);
    expect(warning.mock.calls[0]?.[0]).toBe("[state-store-sweeper] throws failed");
    expect(String(warning.mock.calls[0]?.[0])).not.toContain("secret detail");
    warning.mockRestore();
  });

  test("write-trigger uses the same callbacks synchronously without creating a queue", () => {
    const order: string[] = [];
    registerStateStore({ name: "a", sweepExpired: () => { order.push("a"); return 1; } });
    registerStateStore({ name: "b", sweepExpired: () => { order.push("b"); return 1; } });

    const result = sweepExpiredOnWrite(5);
    order.push("returned");
    expect(result).toEqual({ storesVisited: 2, rowsRemoved: 2 });
    expect(order).toEqual(["a", "b", "returned"]);
  });

  test("timer start is singleton unrefed and stop is idempotent", () => {
    const timers: Array<{ callback: () => void; unrefCalls: number }> = [];
    const cleared: unknown[] = [];
    const setSpy = spyOn(globalThis, "setInterval").mockImplementation(((callback: () => void) => {
      const timer = { callback, unrefCalls: 0, unref() { this.unrefCalls += 1; } };
      timers.push(timer);
      return timer;
    }) as typeof setInterval);
    const clearSpy = spyOn(globalThis, "clearInterval").mockImplementation((timer => {
      cleared.push(timer);
    }) as typeof clearInterval);
    let ttl = 0;
    let liveness = 0;
    registerStateStore({
      name: "both",
      sweepExpired: () => { ttl += 1; return 0; },
      sweepLiveness: () => { liveness += 1; return 0; },
    });

    startStateStoreSweeper({ intervalMs: 10, now: () => 42 });
    startStateStoreSweeper({ intervalMs: 20, now: () => 43 });
    expect(timers).toHaveLength(2);
    expect(timers[0]!.unrefCalls).toBe(1);
    expect(timers[1]!.unrefCalls).toBe(1);
    expect(cleared).toEqual([timers[0]]);
    timers[1]!.callback();
    expect({ ttl, liveness }).toEqual({ ttl: 1, liveness: 1 });

    stopStateStoreSweeper();
    stopStateStoreSweeper();
    expect(cleared).toEqual([timers[0], timers[1]]);
    setSpy.mockRestore();
    clearSpy.mockRestore();
  });

  test("periodic sweep enforces bytes that become evictable via TTL expiry without write traffic", () => {
    const timers: Array<() => void> = [];
    const setSpy = spyOn(globalThis, "setInterval").mockImplementation(((callback: () => void) => {
      timers.push(callback);
      return { unref() {} };
    }) as typeof setInterval);
    const clearSpy = spyOn(globalThis, "clearInterval").mockImplementation(() => {});
    let expired = false;
    let retained = 4;
    registerStateStore({
      name: "ttl-transition",
      sweepExpired: now => { expired = now >= 42; return 0; },
    });
    registerRetainedStore({
      id: "sweep-transition",
      category: "caches",
      snapshot: () => ({
        count: retained > 0 ? 1 : 0,
        bytes: retained,
        evictableBytes: expired ? retained : 0,
        pinnedBytes: expired ? 0 : retained,
        oldestAt: expired && retained > 0 ? 1 : null,
      }),
      evictOldest: () => {
        const released = retained;
        retained = 0;
        return released;
      },
    });
    configureAppOwnedMemoryBudget(0);
    registerAppOwnedMemorySweepFallback();

    startStateStoreSweeper({ intervalMs: 10, now: () => 42 });
    expect(retained).toBe(4);
    timers[0]!();

    expect(retained).toBe(0);
    stopStateStoreSweeper();
    setSpy.mockRestore();
    clearSpy.mockRestore();
  });

  test("reconciliation runs only for a newer complete generation", () => {
    const seen: number[] = [];
    registerStateStore({ name: "owner", reconcileGeneration: next => { seen.push(next.generation); return 1; } });

    expect(reconcileStateGeneration(context(1)).rowsRemoved).toBe(1);
    expect(captureConfigGeneration()).toBe(1);
    expect(reconcileStateGeneration(context(1)).rowsRemoved).toBe(1);
    expect(captureConfigGeneration()).toBe(2);
    expect(seen).toEqual([1, 2]);
  });

  test("stale or duplicate generation cannot delete current keys", () => {
    const rows = new Set(["live", "removed"]);
    let last = 0;
    const reconcileOwner = (next: GenerationContext): number => {
      if (next.generation <= last) return 0;
      let removed = 0;
      for (const row of rows) {
        if (next.providerNames.has(row)) continue;
        rows.delete(row);
        removed += 1;
      }
      last = next.generation;
      return removed;
    };

    reconcileOwner(context(1, { providerNames: new Set(["live"]) }));
    expect([...rows]).toEqual(["live"]);
    reconcileOwner(context(1, { providerNames: new Set() }));
    expect([...rows]).toEqual(["live"]);
  });

  test("partial reconciliation retries every owner with a fresh context and a higher candidate", () => {
    const warning = spyOn(console, "warn").mockImplementation(() => {});
    let fail = true;
    let builds = 0;
    let ownerGeneration = 0;
    let liveProviders = new Set<string>();
    registerStateStore({
      name: "ok",
      reconcileGeneration: next => {
        if (next.generation <= ownerGeneration) return 0;
        ownerGeneration = next.generation;
        liveProviders = new Set(next.providerNames);
        return 0;
      },
    });
    registerStateStore({
      name: "flaky",
      reconcileGeneration: () => {
        if (fail) throw new Error("first");
        return 0;
      },
    });
    setGenerationContextBuilder(() => context(0, {
      providerNames: new Set([`build-${++builds}`]),
    }));

    reconcileStateGeneration(context(0, { providerNames: new Set(["first"]) }));
    expect(captureConfigGeneration()).toBe(0);
    expect(ownerGeneration).toBe(1);
    expect([...liveProviders]).toEqual(["first"]);
    fail = false;
    sweepExpiredOnWrite(0);
    expect(builds).toBe(1);
    expect(captureConfigGeneration()).toBe(2);
    expect(ownerGeneration).toBe(2);
    expect([...liveProviders]).toEqual(["build-1"]);
    warning.mockRestore();
  });

  test("partial reconcile failure keeps live-key writes accepted for new owners", async () => {
    const warning = spyOn(console, "warn").mockImplementation(() => {});
    const previousCredentials = process.env.GOOGLE_APPLICATION_CREDENTIALS;
    const previousCloudSdk = process.env.CLOUDSDK_CONFIG;
    const home = mkdtempSync(join(tmpdir(), "ocx-sweeper-gcp-live-"));
    delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
    process.env.CLOUDSDK_CONFIG = home;
    __resetVertexTokenCache();
    let release!: () => void;
    let started!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const startedPromise = new Promise<void>(resolve => { started = resolve; });
    let fetches = 0;
    const fetchImpl = (async () => {
      fetches += 1;
      started();
      await gate;
      return new Response(JSON.stringify({ access_token: "metadata-live", expires_in: 3600 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
    try {
      const gcp = STATE_STORE_REGISTRATIONS.find(row => row.name === "gcp-adc")!;
      registerStateStore(gcp);
      registerStateStore({ name: "later-failure", reconcileGeneration: () => { throw new Error("partial"); } });
      const late = getVertexAccessToken({ fetch: fetchImpl });
      await startedPromise;
      reconcileStateGeneration(context(0));
      expect(captureConfigGeneration()).toBe(0);
      release();
      expect(await late).toBe("metadata-live");
      expect(await getVertexAccessToken({ fetch: fetchImpl })).toBe("metadata-live");
      expect(fetches).toBe(1);
    } finally {
      release();
      __resetVertexTokenCache();
      warning.mockRestore();
      if (previousCredentials === undefined) delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
      else process.env.GOOGLE_APPLICATION_CREDENTIALS = previousCredentials;
      if (previousCloudSdk === undefined) delete process.env.CLOUDSDK_CONFIG;
      else process.env.CLOUDSDK_CONFIG = previousCloudSdk;
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("liveness callbacks are separate from write-trigger sweeps", () => {
    let probes = 0;
    registerStateStore({ name: "pid", sweepLiveness: () => { probes += 1; return 0; } });
    sweepExpiredOnWrite(0);
    expect(probes).toBe(0);
    expect(sweepLiveness()).toEqual({ storesVisited: 1, rowsRemoved: 0 });
    expect(probes).toBe(1);
  });

  test("provider-quota late completion cannot resurrect a deleted provider or account row", async () => {
    const previousHome = process.env.OPENCODEX_HOME;
    const home = mkdtempSync(join(tmpdir(), "ocx-sweeper-quota-"));
    const originalFetch = globalThis.fetch;
    process.env.OPENCODEX_HOME = home;
    clearAccountQuotaCache();
    clearProviderQuotaCache();
    try {
      await saveCredential("anthropic", {
        access: "late-quota-token",
        refresh: "late-quota-refresh",
        expires: Date.now() + 60_000,
        accountId: "late-quota-account",
      });
      const accountId = getAccountSet("anthropic")!.activeAccountId;
      let release!: () => void;
      let started!: () => void;
      const startedPromise = new Promise<void>(resolve => { started = resolve; });
      const gate = new Promise<void>(resolve => { release = resolve; });
      let calls = 0;
      globalThis.fetch = (async () => {
        calls += 1;
        started();
        if (calls === 1) await gate;
        return new Response(JSON.stringify({
          five_hour: { utilization: 12 },
          seven_day: { utilization: 34 },
        }), { status: 200 });
      }) as typeof fetch;
      const config = {
        defaultProvider: "anthropic",
        providers: {
          anthropic: { adapter: "anthropic", authMode: "oauth", baseUrl: "https://api.anthropic.com/v1" },
        },
      } as OcxConfig;
      const staleConfig = { ...config, providers: { ...config.providers } } as OcxConfig;
      const quotaRegistration = STATE_STORE_REGISTRATIONS.find(row => row.name === "provider-quota-history")!;
      registerStateStore(quotaRegistration);

      const late = fetchProviderQuotaReports(config, true);
      await startedPromise;
      delete config.providers.anthropic;
      reconcileStateGeneration(context(0));
      release();
      await late;

      expect(getCachedProviderAccountQuota("anthropic", accountId)).toBeNull();
      expect((await fetchProviderQuotaReports(staleConfig, false)).reports).toEqual([]);
      expect(calls).toBe(1);
    } finally {
      globalThis.fetch = originalFetch;
      clearAccountQuotaCache();
      clearProviderQuotaCache();
      if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
      else process.env.OPENCODEX_HOME = previousHome;
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("PID liveness probes at most 64, rotates, and deletes only ESRCH", () => {
    setOcxStartProcessCacheForTests(Array.from({ length: 70 }, (_, index) => [index + 1, true] as const));
    const probed: number[] = [];
    setOcxStartProcessProbeForTests(pid => {
      probed.push(pid);
      if (pid === 1) {
        const error = new Error("gone") as NodeJS.ErrnoException;
        error.code = "ESRCH";
        throw error;
      }
      if (pid === 2) {
        const error = new Error("denied") as NodeJS.ErrnoException;
        error.code = "EPERM";
        throw error;
      }
      if (pid === 3) throw new Error("unknown");
    });

    expect(sweepDeadOcxStartProcessCache()).toBe(1);
    expect(probed).toHaveLength(64);
    expect(ocxStartProcessCacheSizeForTests()).toBe(69);
    probed.length = 0;
    sweepDeadOcxStartProcessCache();
    expect(probed.length).toBeLessThanOrEqual(64);
    expect(probed).toContain(70);
    expect(ocxStartProcessCacheSizeForTests()).toBe(69);
  });

  test("PID liveness discards invalid keys without probing them", () => {
    setOcxStartProcessCacheForTests([[0, true], [-1, true], [1.5, true], [42, true]]);
    const probed: number[] = [];
    setOcxStartProcessProbeForTests(pid => { probed.push(pid); });

    expect(sweepDeadOcxStartProcessCache()).toBe(3);
    expect(probed).toEqual([42]);
    expect(ocxStartProcessCacheSizeForTests()).toBe(1);
  });
});
