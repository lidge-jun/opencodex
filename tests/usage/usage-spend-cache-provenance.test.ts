import { describe, expect, test } from "bun:test";
import {
  classifyCacheTelemetryProvenance,
  normalizeRequestSpend,
  normalizeUsageEntryForTest,
  type PersistedUsageEntry,
} from "../../src/usage/log";
import { cacheObservationFromUsage, summarizeUsage } from "../../src/usage/summary";
import { rawCacheTelemetry } from "../../src/usage/cache-telemetry";

const NOW = Date.UTC(2026, 8, 14, 12, 0, 0);

function entry(overrides: Partial<PersistedUsageEntry> & { requestId: string }): PersistedUsageEntry {
  return {
    timestamp: NOW - 1000,
    provider: "anthropic",
    model: "claude-sonnet-5",
    status: 200,
    durationMs: 10,
    usageStatus: "reported",
    ...overrides,
  };
}

describe("cache telemetry provenance", () => {
  test("zero classification follows original presence, not the wireParsed heuristic", () => {
    const zeroDetail = { inputTokens: 1000, outputTokens: 10, cachedInputTokens: 0, cacheReadInputTokens: 0 };
    expect(classifyCacheTelemetryProvenance(zeroDetail)).toBe("unknown");
    expect(classifyCacheTelemetryProvenance(zeroDetail, { wireParsed: true })).toBe("unknown");
    expect(classifyCacheTelemetryProvenance({ ...zeroDetail, cacheTelemetry: rawCacheTelemetry({ input_tokens_details: { cached_tokens: 0 } }) }, { wireParsed: true })).toBe("observed");
    expect(classifyCacheTelemetryProvenance({ ...zeroDetail, cacheTelemetry: rawCacheTelemetry({}) })).toBe("synthesized");
    // A positive reading is a measurement whatever carried it.
    expect(classifyCacheTelemetryProvenance({ ...zeroDetail, cacheReadInputTokens: 5 }, { wireParsed: true }))
      .toBe("observed");
    // No detail at all is not a zero.
    expect(classifyCacheTelemetryProvenance({ inputTokens: 1000, outputTokens: 10 })).toBe("unknown");
    expect(classifyCacheTelemetryProvenance(undefined)).toBe("unknown");
  });

  test("historical zeros without original evidence stay unknown regardless of the old label", () => {
    for (const label of [undefined, "observed", "synthesized"] as const) {
      expect(cacheObservationFromUsage({ inputTokens: 10, outputTokens: 1, cacheReadInputTokens: 0 }, label).provenance).toBe("unknown");
    }
    expect(cacheObservationFromUsage({ inputTokens: 10, outputTokens: 1, cacheReadInputTokens: 5 }, undefined).provenance).toBe("observed");
    expect(cacheObservationFromUsage({ inputTokens: 10, outputTokens: 1 }, undefined).provenance).toBe("unknown");
    expect(cacheObservationFromUsage(undefined, undefined).provenance).toBe("unknown");
    // A stored label cannot invent a denominator the row has no fields for.
    expect(cacheObservationFromUsage({ inputTokens: 10, outputTokens: 1 }, "observed").provenance).toBe("unknown");
  });
});

test("ledger reload retains exact zero evidence, strips unknown metadata, and never backfills old zero labels", () => {
  const evidence = { ...rawCacheTelemetry({ input_tokens_details: { cached_tokens: 0 } }), untrusted: "credential-sentinel" };
  const normalized = normalizeUsageEntryForTest(entry({ requestId: "evidence-zero", cacheProvenance: "observed",
    usage: { inputTokens: 10, outputTokens: 1, cacheReadInputTokens: 0, cacheTelemetry: evidence } }));
  expect(normalized.cacheProvenance).toBe("observed");
  expect(normalized.usage?.cacheTelemetry).toEqual({ source: "upstream", usagePresent: true, read: 0 });
  expect(JSON.stringify(normalized)).not.toContain("credential-sentinel");
  for (const cacheProvenance of ["observed", "synthesized"] as const) {
    const old = normalizeUsageEntryForTest(entry({ requestId: "historic-zero", cacheProvenance,
      usage: { inputTokens: 10, outputTokens: 1, cacheReadInputTokens: 0 } }));
    expect(old.cacheProvenance).toBe("unknown");
  }
});

describe("persisted spend record", () => {
  test("counts must be whole, non-negative and internally consistent", () => {
    expect(normalizeRequestSpend({ sends: 4, settled: 3, unresolved: 1, reserved: 4 }))
      .toEqual({ sends: 4, settled: 3, unresolved: 1, reserved: 4 });
    // More settled spend than was ever sent understates the unexplained remainder.
    expect(normalizeRequestSpend({ sends: 2, settled: 3, unresolved: 0 })).toBeUndefined();
    expect(normalizeRequestSpend({ sends: 2.5, settled: 1, unresolved: 1 })).toBeUndefined();
    expect(normalizeRequestSpend({ sends: 2, settled: 1, unresolved: -1 })).toBeUndefined();
    expect(normalizeRequestSpend({ sends: 1, settled: 1, unresolved: 0, moveReasons: ["quota_refusal", "nonsense"] }))
      .toEqual({ sends: 1, settled: 1, unresolved: 0, moveReasons: ["quota_refusal"] });
  });

  test("the ledger keeps spend, provenance and a well-formed logical request id", () => {
    const normalized = normalizeUsageEntryForTest(entry({
      requestId: "ocx-1",
      logicalRequestId: "lr-abc-1",
      usage: { inputTokens: 100, outputTokens: 5, cachedInputTokens: 0, cacheTelemetry: rawCacheTelemetry({}) },
      spend: { sends: 4, settled: 4, unresolved: 0, reserved: 4, policyVersion: "guarded-v1" },
      cacheProvenance: "synthesized",
    }));
    expect(normalized.logicalRequestId).toBe("lr-abc-1");
    expect(normalized.spend?.sends).toBe(4);
    expect(normalized.spend?.policyVersion).toBe("guarded-v1");
    expect(normalized.cacheProvenance).toBe("synthesized");

    const rejected = normalizeUsageEntryForTest(entry({
      requestId: "ocx-2",
      logicalRequestId: "lr abc\nnewline",
      spend: { sends: 1, settled: 2, unresolved: 0 },
      cacheProvenance: "made-up" as PersistedUsageEntry["cacheProvenance"],
    }));
    expect(rejected).not.toHaveProperty("logicalRequestId");
    expect(rejected).not.toHaveProperty("spend");
    expect(rejected).not.toHaveProperty("cacheProvenance");
  });
});

describe("usage summary spend and cache provenance", () => {
  test("sends are totalled per logical request, with unresolved spend kept apart from settled", () => {
    const summary = summarizeUsage([
      entry({
        requestId: "ocx-a",
        logicalRequestId: "lr-a",
        usage: { inputTokens: 100, outputTokens: 5 },
        spend: { sends: 4, settled: 3, unresolved: 1, reserved: 4 },
      }),
      entry({
        requestId: "ocx-b",
        logicalRequestId: "lr-b",
        usage: { inputTokens: 100, outputTokens: 5 },
        spend: { sends: 2, settled: 2, unresolved: 0, reserved: 2 },
      }),
      // A row from before the record existed contributes no sends rather than a zero.
      entry({ requestId: "ocx-c", usage: { inputTokens: 100, outputTokens: 5 } }),
    ], "30d", NOW);

    expect(summary.summary.requests).toBe(3);
    expect(summary.summary.sends).toBe(6);
    expect(summary.summary.settledSends).toBe(5);
    expect(summary.summary.unresolvedSends).toBe(1);
    expect(summary.summary.spendRequests).toBe(2);
    // Two logical requests reached upstream six times; the attempt count alone would say three.
    expect(summary.summary.attemptCount).toBe(3);
  });

  test("an unknown or synthesized cache detail is never averaged as an observed zero", () => {
    const summary = summarizeUsage([
      entry({
        requestId: "ocx-observed",
        usage: { inputTokens: 1000, outputTokens: 10, cacheReadInputTokens: 400, cacheCreationInputTokens: 0 },
        cacheProvenance: "observed",
      }),
      entry({
        requestId: "ocx-unknown",
        usage: { inputTokens: 1000, outputTokens: 10 },
        cacheProvenance: "unknown",
      }),
      entry({
        requestId: "ocx-synth",
        usage: { inputTokens: 1000, outputTokens: 10, cachedInputTokens: 0, cacheReadInputTokens: 0, cacheTelemetry: rawCacheTelemetry({}) },
        cacheProvenance: "synthesized",
      }),
    ], "30d", NOW);

    const model = summary.models.find(row => row.model === "claude-sonnet-5");
    expect(model?.inputTokens).toBe(3000);
    expect(model?.cacheReadInputTokens).toBe(400);
    // 400 of the 1000 tokens that were actually measured, not 400 of all 3000.
    expect(model?.cacheObservedInputTokens).toBe(1000);
    expect(model?.cacheHitRate).toBeCloseTo(0.4);

    const provider = summary.providers.find(row => row.provider === "anthropic");
    expect(provider?.cacheHitRate).toBeCloseTo(0.4);
    const day = summary.days.find(row => row.models.some(m => m.model === "claude-sonnet-5"));
    expect(day?.models[0]?.cacheHitRate).toBeCloseTo(0.4);

    expect(summary.summary.cacheObservedRequests).toBe(1);
    expect(summary.summary.cacheUnknownRequests).toBe(1);
    expect(summary.summary.cacheSynthesizedRequests).toBe(1);
    expect(summary.summary.cacheObservedInputTokens).toBe(1000);
  });

  test("a window with no observed cache detail reports no rate rather than a zero one", () => {
    const summary = summarizeUsage([
      entry({
        requestId: "ocx-only-synth",
        usage: { inputTokens: 500, outputTokens: 10, cachedInputTokens: 0, cacheReadInputTokens: 0, cacheTelemetry: rawCacheTelemetry({}) },
        cacheProvenance: "synthesized",
      }),
    ], "30d", NOW);
    expect(summary.models[0]?.cacheHitRate).toBeNull();
    expect(summary.models[0]?.cacheObservedInputTokens).toBe(0);
  });

  test("a combo child without its own cache detail does not inherit a sibling's observation", () => {
    const summary = summarizeUsage([
      entry({
        requestId: "ocx-combo",
        provider: "combo",
        model: "combo/pair",
        usage: { inputTokens: 2000, outputTokens: 20 },
        cacheProvenance: "observed",
        attempts: [
          {
            ordinal: 1, provider: "anthropic", model: "claude-sonnet-5", adapter: "anthropic",
            status: 200, durationMs: 5, sendCount: 1, recoveryKinds: [], usageStatus: "reported",
            usage: { inputTokens: 1000, outputTokens: 10, cacheReadInputTokens: 500 },
            cacheProvenance: "observed",
          },
          {
            ordinal: 2, provider: "anthropic", model: "claude-opus-5", adapter: "anthropic",
            status: 200, durationMs: 5, sendCount: 1, recoveryKinds: [], usageStatus: "reported",
            usage: { inputTokens: 1000, outputTokens: 10, cachedInputTokens: 0, cacheReadInputTokens: 0, cacheTelemetry: rawCacheTelemetry({}) },
            cacheProvenance: "synthesized",
          },
        ],
      }),
    ], "30d", NOW);

    const sonnet = summary.models.find(row => row.model === "claude-sonnet-5");
    const opus = summary.models.find(row => row.model === "claude-opus-5");
    expect(sonnet?.cacheHitRate).toBeCloseTo(0.5);
    expect(opus?.cacheHitRate).toBeNull();
    expect(opus?.cacheObservedInputTokens).toBe(0);
  });
});

// Invalid evidence must not become a legacy positive reading after JSONL normalization.
test("invalid cache evidence stays unknown after repeated ledger normalization", () => {
  const source = entry({ requestId: "invalid-evidence", cacheProvenance: "observed", usage: {
    inputTokens: 100, outputTokens: 5, cachedInputTokens: 40,
    cacheTelemetry: { source: "invented", usagePresent: true, read: 40, secret: "metadata-sentinel" } as never,
  } });
  const once = normalizeUsageEntryForTest(source);
  const twice = normalizeUsageEntryForTest(JSON.parse(JSON.stringify(once)));
  expect(once.cacheProvenance).toBe("unknown");
  expect(twice.cacheProvenance).toBe("unknown");
  expect(cacheObservationFromUsage(twice.usage, twice.cacheProvenance).provenance).toBe("unknown");
  expect(JSON.stringify(twice)).not.toContain("metadata-sentinel");
});
