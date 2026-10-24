import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { JevCandidate, JevDecision } from "../../src/combos/jev";
import {
  JEV_SESSION_PIN_TTL_MAX_MS,
  JEV_SESSION_PIN_TTL_MIN_MS,
  normalizeJevSessionPin,
  parseJevSessionPinDuration,
} from "../../src/combos/jev-session-pin-config";
import { comboConfigIssues, normalizeComboConfig } from "../../src/combos/types";
import { captureConfigGeneration, reconcileStateGeneration } from "../../src/lib/state-store-sweeper";
import type { DataPlaneAdmission } from "../../src/server/auth-cors";
import {
  clearJevSessionPinsForTests,
  JEV_SESSION_PIN_CAPACITY,
  jevSessionPinCountForTests,
  jevSessionPinScope,
} from "../../src/server/responses/jev-session-pin";
import { createJevStatsAccumulator, normalizePersistedJevDecision } from "../../src/usage/jev-stats";
import type { PersistedUsageEntry } from "../../src/usage/log";
import type { OcxProviderConfig } from "../../src/types";

const TTL = 120_000;
const combo = { strategy: "jev" as const, sessionPin: { ttlMs: TTL } };
const LOOPBACK: DataPlaneAdmission = { kind: "loopback", source: "loopback" };
const sol: JevCandidate = { key: "sol/gpt-5.6-sol", provider: "sol", model: "gpt-5.6-sol", reasoningEfforts: ["low", "high"] };
const luna: JevCandidate = { key: "luna/gpt-5.6-luna", provider: "luna", model: "gpt-5.6-luna", reasoningEfforts: ["low"] };
const applied: JevDecision = { backend: "typesafe", targetKey: sol.key, effort: "high", gate: "apply", latencyMs: 12 };

let clock = 1_000_000;
const now = () => clock;

function scope(overrides: Partial<Parameters<typeof jevSessionPinScope>[0]> = {}) {
  return jevSessionPinScope({ combo, comboId: "auto", admission: LOOPBACK, lane: "lane-a", now, ...overrides })!;
}

function bumpConfigGeneration(): void {
  const empty = new Set<string>();
  reconcileStateGeneration({
    generation: 0,
    providerNames: empty,
    comboIds: empty,
    comboTargets: empty,
    codexAccountIds: empty,
    oauthAccountKeys: empty,
    configRoots: empty,
  });
}

beforeEach(() => {
  clock = 1_000_000;
  clearJevSessionPinsForTests();
});
afterEach(() => clearJevSessionPinsForTests());

describe("JEV session pin settings", () => {
  test("accept exactly { ttlMs } inside the documented range", () => {
    expect(normalizeJevSessionPin({ ttlMs: 1_200_000 })).toEqual({ ttlMs: 1_200_000 });
    for (const value of [null, [], {}, { ttlMs: JEV_SESSION_PIN_TTL_MIN_MS - 1 }, { ttlMs: JEV_SESSION_PIN_TTL_MAX_MS + 1 },
      { ttlMs: 90_000.5 }, { ttlMs: "20m" }, { ttlMs: 90_000, turns: 3 }]) {
      expect(normalizeJevSessionPin(value)).toBeUndefined();
    }
  });

  test("CLI durations use ms, s, m or h and stay in range", () => {
    expect(parseJevSessionPinDuration("20m")).toBe(1_200_000);
    expect(parseJevSessionPinDuration("90s")).toBe(90_000);
    expect(parseJevSessionPinDuration("1h")).toBe(3_600_000);
    expect(parseJevSessionPinDuration("60000")).toBe(60_000);
    for (const raw of ["59s", "25h", "20 m", "-1m", "1.5h", "m", ""]) expect(parseJevSessionPinDuration(raw)).toBeUndefined();
  });

  test("only a JEV Combo may carry the pin, null clears it and the default stays off", () => {
    const providers: Record<string, OcxProviderConfig> = { fixture: { adapter: "openai-chat", baseUrl: "https://fixture.invalid/v1", models: ["m"] } };
    const targets = [{ provider: "fixture", model: "m" }];
    expect(comboConfigIssues("auto", { strategy: "jev", targets, sessionPin: { ttlMs: TTL } }, providers)).toEqual([]);
    expect(comboConfigIssues("auto", { strategy: "jev", targets, sessionPin: null }, providers)).toEqual([]);
    expect(comboConfigIssues("auto", { strategy: "failover", targets, sessionPin: { ttlMs: TTL } }, providers)[0]?.path).toEqual(["sessionPin"]);
    expect(comboConfigIssues("auto", { strategy: "jev", targets, sessionPin: { ttlMs: 10 } }, providers)[0]?.path).toEqual(["sessionPin"]);
    expect(normalizeComboConfig({ strategy: "jev", targets })).not.toHaveProperty("sessionPin");
    expect(normalizeComboConfig({ strategy: "jev", targets, sessionPin: { ttlMs: TTL } }).sessionPin).toEqual({ ttlMs: TTL });
  });
});

describe("JEV session pin scope", () => {
  test("never exists without the opt-in, a JEV strategy or an explicit session lane", () => {
    expect(jevSessionPinScope({ combo: { strategy: "jev" }, comboId: "auto", admission: LOOPBACK, lane: "lane-a" })).toBeUndefined();
    expect(jevSessionPinScope({ combo: { ...combo, strategy: "failover" }, comboId: "auto", admission: LOOPBACK, lane: "lane-a" })).toBeUndefined();
    expect(jevSessionPinScope({ combo, comboId: "auto", admission: LOOPBACK, lane: undefined })).toBeUndefined();
  });

  test("an applied decision pins after it completes, and the pin replays its target and effort", () => {
    const pin = scope();
    expect(pin.reuse([sol, luna])).toEqual({});
    pin.complete(sol.key, applied, captureConfigGeneration());
    expect(pin.reuse([luna, sol])).toEqual({
      decision: { backend: "typesafe", targetKey: sol.key, effort: "high", gate: "apply", latencyMs: 0, pinned: true, pinReason: "session" },
    });
  });

  test("fail-open decisions and completions on another target never pin", () => {
    const pin = scope();
    pin.complete(sol.key, { ...applied, gate: "timeout" }, captureConfigGeneration());
    pin.complete(luna.key, applied, captureConfigGeneration());
    pin.complete(sol.key, undefined, captureConfigGeneration());
    expect(pin.reuse([sol, luna])).toEqual({});
    expect(jevSessionPinCountForTests()).toBe(0);
  });

  test("callers, Combos and sessions never share a pin", () => {
    scope().complete(sol.key, applied, captureConfigGeneration());
    const alice: DataPlaneAdmission = { kind: "configured", keyId: "alice", source: "bearer", contextPrincipalId: "p-alice" };
    const bob: DataPlaneAdmission = { kind: "configured", keyId: "bob", source: "bearer", contextPrincipalId: "p-bob" };
    expect(scope({ admission: alice }).reuse([sol])).toEqual({});
    scope({ admission: alice }).complete(sol.key, applied, captureConfigGeneration());
    expect(scope({ admission: bob }).reuse([sol])).toEqual({});
    expect(scope({ comboId: "other" }).reuse([sol])).toEqual({});
    expect(scope({ lane: "lane-b" }).reuse([sol])).toEqual({});
    expect(scope({ admission: alice }).reuse([sol]).decision?.pinned).toBe(true);
    expect(scope().reuse([sol]).decision?.pinned).toBe(true);
  });

  test("the idle window expires the pin and each completion on the pinned target renews it", () => {
    const pin = scope();
    pin.complete(sol.key, applied, captureConfigGeneration());
    clock += TTL - 1;
    // A tool-loop continuation or any other completion on the same target keeps the session warm.
    pin.complete(sol.key, undefined, captureConfigGeneration());
    clock += TTL - 1;
    expect(pin.reuse([sol]).decision?.pinned).toBe(true);
    clock += TTL;
    expect(pin.reuse([sol])).toEqual({ released: "expired" });
    expect(pin.reuse([sol])).toEqual({});
  });

  test("a target that left the current choices, or lost the pinned effort, releases the pin", () => {
    const pin = scope();
    pin.complete(sol.key, applied, captureConfigGeneration());
    expect(pin.reuse([luna])).toEqual({ released: "target_unavailable" });
    pin.complete(sol.key, applied, captureConfigGeneration());
    expect(pin.reuse([{ ...sol, reasoningEfforts: ["low"] }])).toEqual({ released: "effort_unavailable" });
    expect(jevSessionPinCountForTests()).toBe(0);
  });

  test("a config change releases the pin and discards completions that started before it", () => {
    const pin = scope();
    const before = captureConfigGeneration();
    pin.complete(sol.key, applied, before);
    bumpConfigGeneration();
    expect(pin.reuse([sol])).toEqual({ released: "config_changed" });
    pin.complete(sol.key, applied, before);
    expect(pin.reuse([sol])).toEqual({});
  });

  test("a failure forgets the pin", () => {
    const pin = scope();
    pin.complete(sol.key, applied, captureConfigGeneration());
    pin.forget();
    expect(pin.reuse([sol])).toEqual({});
  });

  test("a request already in flight when another one fails cannot restore the pin", () => {
    scope().complete(sol.key, applied, captureConfigGeneration());
    const inFlight = scope();
    const failing = scope();
    failing.forget();
    inFlight.complete(sol.key, { ...applied, pinned: true, pinReason: "session" }, captureConfigGeneration());
    inFlight.complete(sol.key, applied, captureConfigGeneration());
    expect(scope().reuse([sol])).toEqual({});
    // A request that starts after the failure decides afresh and may pin again.
    const next = scope();
    next.complete(sol.key, applied, captureConfigGeneration());
    expect(scope().reuse([sol]).decision?.pinned).toBe(true);
  });

  test("an evicted failure fence still refuses a writer that started before it", () => {
    scope().complete(sol.key, applied, captureConfigGeneration());
    const inFlight = scope();
    scope().forget();
    for (let lane = 0; lane <= JEV_SESSION_PIN_CAPACITY; lane += 1) scope({ lane: `other-${lane}` }).forget();
    inFlight.complete(sol.key, applied, captureConfigGeneration());
    expect(scope().reuse([sol])).toEqual({});
    const next = scope();
    next.complete(sol.key, applied, captureConfigGeneration());
    expect(scope().reuse([sol]).decision?.pinned).toBe(true);
  });

  test("the store is bounded and evicts the least recently written session", () => {
    for (let lane = 0; lane <= JEV_SESSION_PIN_CAPACITY; lane += 1) {
      scope({ lane: `lane-${lane}` }).complete(sol.key, applied, captureConfigGeneration());
    }
    expect(jevSessionPinCountForTests()).toBe(JEV_SESSION_PIN_CAPACITY);
    expect(scope({ lane: "lane-0" }).reuse([sol])).toEqual({});
    expect(scope({ lane: `lane-${JEV_SESSION_PIN_CAPACITY}` }).reuse([sol]).decision?.pinned).toBe(true);
  });
});

describe("persisted session pin evidence", () => {
  const base = {
    version: 1,
    comboId: "auto",
    selected: { provider: "sol", model: "gpt-5.6-sol", effort: "high" },
    gate: "apply",
    latencyMs: 0,
    backend: "typesafe",
  };

  test("pinned turns and release reasons survive normalization; inconsistent pairs do not", () => {
    expect(normalizePersistedJevDecision({ ...base, pinned: true, pinReason: "session" })).toMatchObject({ pinned: true, pinReason: "session" });
    expect(normalizePersistedJevDecision({ ...base, pinReason: "expired" })).toMatchObject({ pinReason: "expired" });
    expect(normalizePersistedJevDecision({ ...base, pinReason: "expired" })).not.toHaveProperty("pinned");
    expect(normalizePersistedJevDecision({ ...base, pinReason: "bogus" })).not.toHaveProperty("pinReason");
    expect(normalizePersistedJevDecision({ ...base, pinned: true })).toBeUndefined();
    expect(normalizePersistedJevDecision({ ...base, pinReason: "session" })).toBeUndefined();
    expect(normalizePersistedJevDecision({ ...base, pinned: true, pinReason: "expired" })).toBeUndefined();
  });

  test("stats count pinned turns apart from decisions while keeping their physical tokens and request outcomes", () => {
    const entry = (jevDecision: Record<string, unknown>, timestamp: number, provider = "sol") => ({
      timestamp,
      status: 200,
      jevDecision,
      attempts: [{ provider, model: "gpt-5.6-sol", sendCount: 1, usageStatus: "reported", usage: { inputTokens: 100, outputTokens: 5, cacheReadInputTokens: 80 } }],
    }) as unknown as PersistedUsageEntry;
    const accumulator = createJevStatsAccumulator({ comboId: "auto" });
    accumulator.add(entry({ ...base, latencyMs: 40 }, 1));
    accumulator.add(entry({ ...base, pinned: true, pinReason: "session" }, 2));
    accumulator.add(entry({ ...base, pinned: true, pinReason: "session" }, 3, "luna"));
    const stats = accumulator.clone().summarize("all", 3);
    expect(stats.summary).toMatchObject({
      decisions: 1, appliedDecisions: 1, pinnedRequests: 2, successfulRequests: 3, requestsWithModelFallback: 1,
      modelAttempts: 3, modelCacheReadTokens: 240, averageLatencyMs: 40,
    });
    expect(stats.gates).toEqual([{ gate: "apply", decisions: 1 }]);
    expect(stats.models).toEqual([
      expect.objectContaining({ provider: "sol", picks: 1, attempts: 2, inputTokens: 200 }),
      expect.objectContaining({ provider: "luna", picks: 0, attempts: 1 }),
    ]);
  });
});
