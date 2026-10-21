import { describe, expect, test } from "bun:test";
import type { CacheTelemetry, OcxUsage } from "../../src/types/request";
import { aggregateCacheTelemetry, cacheProvenance, normalizeCacheTelemetry, rawCacheTelemetry,
  usageFromResponsesPayload, withAdapterCacheTelemetry } from "../../src/usage/cache-telemetry";

const usage = (extra: Partial<OcxUsage> = {}): OcxUsage => ({ inputTokens: 100, outputTokens: 1, ...extra });
const observed = (extra: Partial<OcxUsage> = {}) => withAdapterCacheTelemetry(usage(extra))!;

describe("cache evidence counters", () => {
  test.each([[40, 10], [4, 10], [0, 10]])("canonical read %i is not reduced by write %i", (read, creation) => {
    const value = observed({ cachedInputTokens: read, cacheCreationInputTokens: creation });
    expect(value.cacheTelemetry).toEqual({ source: "adapter", usagePresent: true, read, creation });
    expect(cacheProvenance(value)).toBe("observed");
    expect(aggregateCacheTelemetry([value, value])).toEqual({ source: "aggregate", usagePresent: true,
      complete: true, read: read * 2, creation: creation * 2, readComplete: true, creationComplete: true });
  });

  test("explicit read is authoritative and legacy positive read remains read-only", () => {
    expect(observed({ cachedInputTokens: 40, cacheReadInputTokens: 12, cacheCreationInputTokens: 10 }).cacheTelemetry?.read).toBe(12);
    expect(aggregateCacheTelemetry([usage({ cachedInputTokens: 40, cacheCreationInputTokens: 10 })])).toMatchObject({ read: 40, creation: 10 });
    expect(aggregateCacheTelemetry([usage({ cachedInputTokens: 0, cacheCreationInputTokens: 10 })])).toMatchObject({ readComplete: false, creation: 10 });
    expect(aggregateCacheTelemetry([usage({ cachedInputTokens: 0, cacheCreationInputTokens: 10 })]).read).toBeUndefined();
  });

  test.each([-1, NaN, Infinity, -Infinity])("invalid counter %s never becomes observed zero", invalid => {
    const value = observed({ cachedInputTokens: invalid, cacheCreationInputTokens: invalid });
    expect(value.cacheTelemetry).toEqual({ source: "adapter", usagePresent: true });
    expect(cacheProvenance(value)).toBe("unknown");
    expect(rawCacheTelemetry({ input_tokens_details: { cached_tokens: invalid, cache_write_tokens: invalid } }))
      .toEqual({ source: "upstream", usagePresent: true });
    expect(normalizeCacheTelemetry({ source: "adapter", usagePresent: true, read: invalid })).toBeUndefined();
  });

  test("invalid metadata cannot fall back to otherwise positive canonical counters", () => {
    const value = usage({ cachedInputTokens: 40,
      cacheTelemetry: { source: "adapter", usagePresent: true, read: -1 } });
    expect(cacheProvenance(value)).toBe("unknown");
    expect(cacheProvenance(withAdapterCacheTelemetry(value))).toBe("unknown");
    expect(aggregateCacheTelemetry([value])).toMatchObject({ complete: false, readComplete: false });
  });

  test.each([["client"], ["aggregate"], ["upstream"], ["adapter"], { toString: () => "upstream" }, { source: "adapter" }].map(source => ({ source })))(
    "a non-string provenance source cannot become observed",
    ({ source }) => {
      const malformed = { source, usagePresent: true, read: 40 };
      expect(normalizeCacheTelemetry(malformed)).toBeUndefined();
      const value = usage({ cachedInputTokens: 40, cacheTelemetry: malformed as unknown as CacheTelemetry });
      expect(cacheProvenance(value)).toBe("unknown");
      expect(cacheProvenance(withAdapterCacheTelemetry(value))).toBe("unknown");
      // The closed unknown marker remains unknown after repeated JSON persistence/reload.
      let persisted = withAdapterCacheTelemetry(value)!;
      for (let i = 0; i < 2; i++) {
        const decoded = JSON.parse(JSON.stringify(persisted)) as OcxUsage;
        persisted = { ...decoded, cacheTelemetry: normalizeCacheTelemetry(decoded.cacheTelemetry) };
        expect(cacheProvenance(persisted)).toBe("unknown");
        expect(persisted.cacheTelemetry).toEqual({ source: "aggregate", usagePresent: true, complete: false });
      }
    },
  );

  test("client payloads and estimates cannot impersonate raw upstream evidence", () => {
    const raw = { input_tokens: 100, output_tokens: 1, input_tokens_details: { cached_tokens: 40 } };
    const client = usageFromResponsesPayload(raw);
    expect(client?.cacheTelemetry).toEqual({ source: "client", usagePresent: true });
    expect(cacheProvenance(withAdapterCacheTelemetry(client))).toBe("unknown");
    expect(cacheProvenance(usageFromResponsesPayload(raw, "upstream"))).toBe("observed");
    expect(aggregateCacheTelemetry([observed({ cachedInputTokens: 2 }), observed({ cachedInputTokens: 40, estimated: true })]))
      .toMatchObject({ complete: false, read: 2, readComplete: false });
  });
});

describe("cache aggregate evidence", () => {
  test("read/write evidence stays asymmetric and nested partial sums stay partial", () => {
    const combined = aggregateCacheTelemetry([observed({ cachedInputTokens: 40 }), observed({ cacheCreationInputTokens: 10 })]);
    expect(combined).toEqual({ source: "aggregate", usagePresent: true, complete: true,
      read: 40, creation: 10, readComplete: false, creationComplete: false });
    expect(cacheProvenance(usage({ cacheTelemetry: combined }))).toBe("observed");
    expect(aggregateCacheTelemetry([usage({ cacheTelemetry: combined }), observed({ cachedInputTokens: 5, cacheCreationInputTokens: 2 })]))
      .toEqual({ source: "aggregate", usagePresent: true, complete: true,
        read: 45, creation: 12, readComplete: false, creationComplete: false });
  });

  test("missing usage is a contributing unknown but an empty collection proves nothing", () => {
    expect(aggregateCacheTelemetry([])).toEqual({ source: "aggregate", usagePresent: false,
      complete: false, readComplete: false, creationComplete: false });
    expect(aggregateCacheTelemetry([undefined, observed({ cachedInputTokens: 0 })]))
      .toEqual({ source: "aggregate", usagePresent: true, complete: false,
        read: 0, readComplete: false, creationComplete: false });
  });

  test("closed aggregate flags survive normalization without arbitrary metadata", () => {
    const evidence: CacheTelemetry = { source: "aggregate", usagePresent: true, complete: true,
      read: 0, readComplete: true, creationComplete: false };
    expect(normalizeCacheTelemetry({ ...evidence, raw: "never retain" })).toEqual(evidence);
    expect(normalizeCacheTelemetry({ ...evidence, source: "upstream" })).toBeUndefined();
    expect(normalizeCacheTelemetry({ ...evidence, readComplete: "yes" })).toBeUndefined();
  });

  test("overflowed sums cannot produce infinite cache evidence", () => {
    const value = observed({ cachedInputTokens: Number.MAX_VALUE });
    const aggregate = aggregateCacheTelemetry([value, value]);
    expect(aggregate.read).toBeUndefined();
    expect(aggregate.readComplete).toBe(false);
    expect(normalizeCacheTelemetry(aggregate)).toEqual(aggregate);
  });
});
