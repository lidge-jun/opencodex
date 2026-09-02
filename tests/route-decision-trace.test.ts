import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { routeModel } from "../src/router";
import { requestLogEntryFromPersistedUsage } from "../src/server/request-log";
import {
  appendUsageEntry,
  normalizeUsageEntryForTest,
  readRecentUsageEntries,
  readUsageEntries,
  resetUsageReadCacheForTests,
  type PersistedUsageEntry,
} from "../src/usage/log";
import {
  MAX_EXCLUSIONS_PER_CANDIDATE,
  MAX_TRACE_CANDIDATES,
  MAX_TRACE_BYTES,
  MAX_TRACE_STRING,
  MAX_REQUIREMENTS,
  buildRouteDecisionTrace,
  normalizeRouteDecisionTrace,
  type RouteDecisionTraceV1,
} from "../src/routing/trace";
import type { OcxConfig } from "../src/types";
import { removeTreeWithRetry } from "./helpers/remove-tree";

/** Near-budget trace: 8 candidates x 16 exclusions with max-length strings. */
function oversizedTrace(): RouteDecisionTraceV1 {
  const longCode = "x".repeat(MAX_TRACE_STRING);
  const candidates = Array.from({ length: MAX_TRACE_CANDIDATES }, (_, index) => ({
    provider: "p".repeat(MAX_TRACE_STRING),
    model: `m${index}`.padEnd(MAX_TRACE_STRING, "y"),
    eligible: index === MAX_TRACE_CANDIDATES - 1,
    exclusions: Array.from({ length: 16 }, () => ({ code: longCode, detail: "z".repeat(MAX_TRACE_STRING) })),
  }));
  return buildRouteDecisionTrace({
    requestedModel: "combo/big",
    routeKind: "combo",
    selected: {
      provider: candidates[MAX_TRACE_CANDIDATES - 1]!.provider,
      model: candidates[MAX_TRACE_CANDIDATES - 1]!.model,
      reason: "combo-pick",
      candidateIndex: MAX_TRACE_CANDIDATES - 1,
    },
    candidates,
  });
}

let testDir = "";
let previousHome: string | undefined;

beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  testDir = mkdtempSync(join(tmpdir(), "ocx-route-trace-"));
  process.env.OPENCODEX_HOME = testDir;
  resetUsageReadCacheForTests();
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  if (testDir) removeTreeWithRetry(testDir);
});

function baseConfig(overrides: Partial<OcxConfig> = {}): OcxConfig {
  return {
    port: 10100,
    defaultProvider: "a",
    providers: {
      a: { adapter: "openai-chat", baseUrl: "https://a.example/v1", apiKey: "ka", models: ["m1"] },
      b: { adapter: "openai-chat", baseUrl: "https://b.example/v1", apiKey: "kb", models: ["m2"] },
      openai: {
        adapter: "openai-responses",
        authMode: "forward",
        baseUrl: "https://chatgpt.com/backend-api/codex",
      },
    },
    combos: {
      free: {
        strategy: "failover",
        targets: [
          { provider: "a", model: "m1" },
          { provider: "b", model: "m2" },
        ],
      },
    },
    codexAccountNamespaces: { work: "acct-1" },
    ...overrides,
  };
}

describe("route decision traces (RI-01)", () => {
  test("explicit provider namespace records an explicit-provider trace", () => {
    const route = routeModel(baseConfig(), "a/m1");
    expect(route.providerName).toBe("a");
    expect(route.modelId).toBe("m1");
    const trace = route.routeDecision!;
    expect(trace.version).toBe(1);
    expect(trace.routeKind).toBe("explicit-provider");
    expect(trace.requestedModel).toBe("a/m1");
    expect(trace.selected.provider).toBe("a");
    expect(trace.selected.model).toBe("m1");
    expect(trace.selected.reason).toBe("explicit-provider-namespace");
    expect(trace.candidates.length).toBe(1);
    expect(trace.candidates[0]).toMatchObject({ provider: "a", model: "m1", eligible: true });
    expect(trace.selected.candidateIndex).toBe(0);
  });

  test("bare OpenAI family model records a native trace", () => {
    const route = routeModel(baseConfig(), "gpt-5.6");
    expect(route.providerName).toBe("openai");
    expect(route.routeDecision!.routeKind).toBe("native");
    expect(route.routeDecision!.selected.reason).toBe("native-family");
  });

  test("account namespace records an explicit-account trace with privacy-safe handle", () => {
    const route = routeModel(baseConfig(), "work/gpt-5.6");
    expect(route.routeDecision!.routeKind).toBe("explicit-account");
    expect(route.routeDecision!.selected.accountRef).toBe("work");
    expect(route.routeDecision!.selected.provider).toBe("openai");
    expect(route.codexAccountId).toBe("acct-1");
    // The opaque account id is never needed in the trace; the namespace handle is enough.
    expect(JSON.stringify(route.routeDecision)).not.toContain("acct-1");
  });

  test("combo route records every target with eligibility and exclusion reasons", () => {
    const config = baseConfig();
    const route = routeModel(config, "combo/free");
    const trace = route.routeDecision!;
    expect(trace.routeKind).toBe("combo");
    expect(trace.requestedModel).toBe("combo/free");
    expect(trace.candidates.length).toBe(2);
    const selected = trace.candidates[trace.selected.candidateIndex]!;
    expect(selected.eligible).toBe(true);
    for (const candidate of trace.candidates) {
      if (candidate === selected) continue;
      // Failover: the not-selected target is eligible but skipped.
      expect(candidate.eligible).toBe(true);
      expect(candidate.exclusions.map(exclusion => exclusion.code)).toContain("not-selected");
    }
  });

  test("default-provider fallback records a default-provider trace", () => {
    const route = routeModel(baseConfig(), "totally-unknown-model");
    expect(route.providerName).toBe("a");
    expect(route.routeDecision!.routeKind).toBe("default-provider");
    expect(route.routeDecision!.selected.reason).toBe("default-provider");
  });

  test("combo candidates are capped and the selected candidate survives truncation", () => {
    const targets = Array.from({ length: 12 }, (_, index) => ({
      provider: index % 2 === 0 ? "a" : "b",
      model: `m${index}`,
    }));
    const config = baseConfig({ combos: { big: { strategy: "failover", targets } } });
    const route = routeModel(config, "combo/big");
    const trace = route.routeDecision!;
    expect(trace.candidates.length).toBeLessThanOrEqual(MAX_TRACE_CANDIDATES);
    expect(trace.truncated?.candidates).toBe(true);
    expect(trace.candidates[trace.selected.candidateIndex]).toMatchObject({
      provider: "a",
      model: "m0",
    });
  });

  test("a selected candidate beyond the cap survives truncation at the last slot", () => {
    const candidates = Array.from({ length: 12 }, (_, index) => ({
      provider: "a",
      model: `m${index}`,
      eligible: index === 11,
      exclusions: index === 11 ? [] : [{ code: "not-selected" }],
    }));
    const trace = buildRouteDecisionTrace({
      requestedModel: "combo/big",
      routeKind: "combo",
      selected: { provider: "a", model: "m11", reason: "combo-pick", candidateIndex: 11 },
      candidates,
    });
    expect(trace.candidates.length).toBe(MAX_TRACE_CANDIDATES);
    expect(trace.truncated?.candidates).toBe(true);
    expect(trace.selected.candidateIndex).toBe(MAX_TRACE_CANDIDATES - 1);
    expect(trace.candidates[trace.selected.candidateIndex]).toMatchObject({ model: "m11" });
  });

  test("the byte-budget fallback keeps the selected candidate and re-points the index", () => {
    const trace = oversizedTrace();
    expect(trace.truncated?.candidates).toBe(true);
    expect(trace.selected.candidateIndex).toBe(MAX_TRACE_CANDIDATES / 2 - 1);
    expect(trace.candidates[trace.selected.candidateIndex]?.model)
      .toBe(`m${MAX_TRACE_CANDIDATES - 1}`.padEnd(MAX_TRACE_STRING, "y"));
    // The serialized trace respects the byte budget.
    expect(Buffer.byteLength(JSON.stringify(trace), "utf8")).toBeLessThanOrEqual(MAX_TRACE_BYTES);
  });

  test("normalization marks truncation applied to oversized persisted rows", () => {
    const raw = {
      version: 1,
      decisionId: "abcdef012345",
      createdAt: 1,
      requestedModel: "y".repeat(300),
      routeKind: "combo",
      requirements: Array.from({ length: 20 }, (_, index) => ({
        id: `req-${index}`,
        outcome: "satisfied",
      })),
      candidates: Array.from({ length: 12 }, (_, index) => ({
        provider: "a",
        model: `m${index}`,
        eligible: true,
        exclusions: Array.from({ length: 20 }, () => ({ code: "x" })),
      })),
      selected: { candidateIndex: 0, provider: "a", model: "m0", reason: "r" },
    };
    const trace = normalizeRouteDecisionTrace(raw)!;
    expect(trace.truncated).toMatchObject({
      candidates: true,
      exclusions: true,
      requirements: true,
      strings: true,
    });
    expect(trace.candidates).toHaveLength(MAX_TRACE_CANDIDATES);
    expect(trace.requirements).toHaveLength(MAX_REQUIREMENTS);
    expect(trace.candidates.every(candidate => candidate.exclusions.length === MAX_EXCLUSIONS_PER_CANDIDATE)).toBe(true);
  });

  test("normalization only inspects retained reasoning efforts", () => {
    const reasoningEfforts = Array.from({ length: 1_000_000 }) as unknown[];
    reasoningEfforts.fill("medium", 0, 8);
    reasoningEfforts[0] = "x".repeat(MAX_TRACE_STRING + 1);
    Object.defineProperty(reasoningEfforts, 8, {
      get: () => { throw new Error("reasoning effort outside the retained range was inspected"); },
    });
    const raw = {
      version: 1,
      decisionId: "abcdef012345",
      createdAt: 1,
      requestedModel: "a/m1",
      routeKind: "policy",
      requirements: [],
      candidates: [{
        provider: "a",
        model: "m1",
        eligible: true,
        exclusions: [],
        capability: { reasoningEfforts },
      }],
      selected: { candidateIndex: 0, provider: "a", model: "m1", reason: "policy" },
    };

    const normalized = normalizeRouteDecisionTrace(raw);
    expect(normalized).not.toBeNull();
    if (!normalized) throw new Error("trace normalization unexpectedly failed");
    expect(normalized.candidates[0]?.capability?.reasoningEfforts)
      .toEqual(["x".repeat(MAX_TRACE_STRING), ...Array.from({ length: 7 }, () => "medium")]);
    expect(normalized.truncated?.strings).toBe(true);
  });

  test("normalization rejects sparse retained reasoning efforts", () => {
    const reasoningEfforts = Array(8) as unknown[];
    reasoningEfforts[0] = "low";
    reasoningEfforts[7] = "high";
    const raw = {
      version: 1,
      decisionId: "abcdef012345",
      createdAt: 1,
      requestedModel: "a/m1",
      routeKind: "policy",
      requirements: [],
      candidates: [{
        provider: "a",
        model: "m1",
        eligible: true,
        exclusions: [],
        capability: { reasoningEfforts },
      }],
      selected: { candidateIndex: 0, provider: "a", model: "m1", reason: "policy" },
    };

    const normalized = normalizeRouteDecisionTrace(raw);
    expect(normalized).not.toBeNull();
    if (!normalized) throw new Error("trace normalization unexpectedly failed");
    expect(normalized.candidates).toHaveLength(1);
    expect(normalized.candidates[0]?.capability?.reasoningEfforts).toBeUndefined();
  });

  test("startup hydration reads trace-sized usage rows", () => {
    const trace = oversizedTrace();
    for (let index = 0; index < 20; index++) {
      appendUsageEntry({
        requestId: `big-${index}`,
        timestamp: 1_700_000_000_000 + index,
        provider: "a",
        model: "m1",
        status: 200,
        durationMs: 1,
        usageStatus: "reported",
        routeDecision: trace,
      });
    }
    const entries = readRecentUsageEntries(20);
    expect(entries.length).toBe(20);
    expect(entries.every(entry => entry.routeDecision?.routeKind === "combo")).toBe(true);
  });

  test("oversized candidate exclusions are capped with a truncation flag", () => {
    const exclusions = Array.from({ length: 30 }, (_, index) => ({
      code: `reason-${index}`,
      detail: "x".repeat(200),
    }));
    const trace = buildRouteDecisionTrace({
      requestedModel: "a/m1",
      routeKind: "policy",
      selected: { provider: "a", model: "m1", reason: "policy" },
      candidates: [{ provider: "a", model: "m1", eligible: false, exclusions }],
    });
    expect(trace.candidates[0]!.exclusions.length).toBe(MAX_EXCLUSIONS_PER_CANDIDATE);
    expect(trace.truncated?.exclusions).toBe(true);
    expect(trace.truncated?.strings).toBe(true);
    for (const exclusion of trace.candidates[0]!.exclusions) {
      expect(exclusion.detail!.length).toBeLessThanOrEqual(MAX_TRACE_STRING);
    }
  });

  test("long strings are capped deterministically", () => {
    const trace = buildRouteDecisionTrace({
      requestedModel: "x".repeat(500),
      routeKind: "policy",
      selected: { provider: "p".repeat(300), model: "m".repeat(300), reason: "r".repeat(300) },
    });
    expect(trace.requestedModel.length).toBe(MAX_TRACE_STRING);
    expect(trace.selected.provider.length).toBe(MAX_TRACE_STRING);
    expect(trace.selected.model.length).toBe(MAX_TRACE_STRING);
    expect(trace.selected.reason.length).toBe(MAX_TRACE_STRING);
    expect(trace.truncated?.strings).toBe(true);
  });

  test("caller-supplied evidence is whitelisted and bounded in the trace", () => {
    const trace = buildRouteDecisionTrace({
      requestedModel: "policy/p",
      routeKind: "policy",
      candidates: [{
        provider: "a",
        model: "m1",
        eligible: true,
        exclusions: [],
        capability: {
          serviceTier: "x".repeat(500),
          reasoningEfforts: ["y".repeat(500)],
          unknownNested: { z: "should-not-survive" },
        },
        quota: { known: true, source: "s".repeat(300) },
        cost: { estimatedUsd: 0.5, priceSource: "p".repeat(300) },
      }],
      selected: { provider: "a", model: "m1", reason: "policy-selected" },
    });
    const candidate = trace.candidates[0]!;
    expect(candidate.capability?.serviceTier?.length).toBe(MAX_TRACE_STRING);
    expect(candidate.capability?.reasoningEfforts?.[0]?.length).toBe(MAX_TRACE_STRING);
    expect(candidate.capability && "unknownNested" in candidate.capability).toBe(false);
    expect(candidate.quota?.source?.length).toBe(MAX_TRACE_STRING);
    expect(candidate.cost?.priceSource?.length).toBe(MAX_TRACE_STRING);
    expect(trace.truncated?.strings).toBe(true);
  });

  test("trace never contains credentials or prompt content", () => {
    const config = baseConfig();
    // Built at runtime so the privacy scanner's key-pattern grep does not
    // treat the fixture itself as a leaked credential.
    const secretKey = ["sk", "super-secret-token-12345"].join("-");
    config.providers.a = { ...config.providers.a!, apiKey: secretKey };
    const route = routeModel(config, "a/m1");
    const serialized = JSON.stringify(route.routeDecision);
    expect(serialized).not.toContain(secretKey);
    // The trace carries only provider/model identifiers and stable wire codes:
    // the provider config's credential-carrying fields never reach it.
    expect(serialized).not.toContain("apiKey");
    expect(serialized).not.toContain("baseUrl");
    expect(serialized).not.toContain("https://a.example/v1");
    expect(serialized).not.toContain("prompt");
  });

  test("trace round-trips through usage.jsonl and request-log hydration", () => {
    const route = routeModel(baseConfig(), "combo/free");
    const entry: PersistedUsageEntry = {
      requestId: "ocx-trace-roundtrip",
      timestamp: 1700000000000,
      provider: "combo",
      model: "combo/free",
      status: 200,
      durationMs: 42,
      usageStatus: "reported",
      routeDecision: route.routeDecision,
    };
    appendUsageEntry(entry);
    const persisted = readUsageEntries();
    expect(persisted.length).toBe(1);
    expect(persisted[0]!.routeDecision).toEqual(route.routeDecision);

    const hydrated = requestLogEntryFromPersistedUsage(persisted[0]!);
    expect(hydrated.routeDecision).toEqual(route.routeDecision);
  });

  test("old JSONL rows without a trace parse unchanged", () => {
    const entry: PersistedUsageEntry = {
      requestId: "ocx-legacy-row",
      timestamp: 1700000000000,
      provider: "a",
      model: "m1",
      status: 200,
      durationMs: 7,
      usageStatus: "reported",
    };
    const normalized = normalizeUsageEntryForTest(entry);
    expect(normalized.routeDecision).toBeUndefined();
    expect(normalized.requestId).toBe("ocx-legacy-row");
  });

  test("hand-edited corrupt trace rows are dropped or normalized, never poisoned", () => {
    const entry: PersistedUsageEntry = {
      requestId: "ocx-corrupt-trace",
      timestamp: 1700000000000,
      provider: "a",
      model: "m1",
      status: 200,
      durationMs: 7,
      usageStatus: "reported",
      routeDecision: { version: 1, decisionId: "d", createdAt: 1, requestedModel: "x",
        routeKind: "native", requirements: [], candidates: [], selected: { candidateIndex: 0, provider: "a", model: "m1", reason: "r" } } as RouteDecisionTraceV1,
    };
    const normalized = normalizeUsageEntryForTest(entry);
    expect(normalized.routeDecision).toBeUndefined();
    expect(normalizeRouteDecisionTrace({ version: 99 })).toBeNull();
    expect(normalizeRouteDecisionTrace("junk")).toBeNull();
    expect(normalizeRouteDecisionTrace(null)).toBeNull();
  });

  test("request-log hydration drops a corrupt persisted trace", () => {
    const entry: PersistedUsageEntry = {
      requestId: "ocx-corrupt-hydration",
      timestamp: 1700000000000,
      provider: "a",
      model: "m1",
      status: 200,
      durationMs: 7,
      usageStatus: "reported",
      // Empty candidates: normalizeRouteDecisionTrace rejects this row.
      routeDecision: {
        version: 1, decisionId: "d", createdAt: 1, requestedModel: "x",
        routeKind: "native", requirements: [], candidates: [],
        selected: { candidateIndex: 0, provider: "a", model: "m1", reason: "r" },
      } as RouteDecisionTraceV1,
    };
    const hydrated = requestLogEntryFromPersistedUsage(entry);
    expect(hydrated.routeDecision).toBeUndefined();
  });

  test("normalizer bounds hand-edited oversized rows", () => {
      const raw = {
        version: 1,
        decisionId: "0123456789ab",
      createdAt: 1,
      requestedModel: "y".repeat(400),
      routeKind: "native",
      requirements: [],
      candidates: [{
        provider: "a",
        model: "m1",
        eligible: true,
        exclusions: [],
        capability: { contextWindow: 100, tools: true, junk: "drop-me" },
        health: { sampleCount: 3, junkField: true },
        score: { total: 1, components: { health: 1 } },
      }],
      selected: { candidateIndex: 0, provider: "a", model: "m1", reason: "r" },
    };
    const trace = normalizeRouteDecisionTrace(raw)!;
    expect(trace.requestedModel.length).toBe(MAX_TRACE_STRING);
    expect(trace.candidates[0]!.capability).toEqual({ contextWindow: 100, tools: true });
    expect(trace.candidates[0]!.health).toEqual({ sampleCount: 3 });
    expect(trace.candidates[0]!.score).toEqual({ total: 1, components: { health: 1 } });
    expect(JSON.stringify(trace)).not.toContain("drop-me");
  });

  test("deterministic: same input produces identical traces except decisionId/createdAt", () => {
    const now = 1700000000000;
    const first = buildRouteDecisionTrace({
      requestedModel: "a/m1",
      routeKind: "explicit-provider",
      selected: { provider: "a", model: "m1", reason: "explicit-provider-namespace" },
      now,
    });
    const second = buildRouteDecisionTrace({
      requestedModel: "a/m1",
      routeKind: "explicit-provider",
      selected: { provider: "a", model: "m1", reason: "explicit-provider-namespace" },
      now,
    });
    expect(first.candidates).toEqual(second.candidates);
    expect(first.selected).toEqual(second.selected);
    expect(first.decisionId).not.toBe(second.decisionId);
    expect(first.decisionId).toMatch(/^[0-9a-f]{12}$/);
  });
});
