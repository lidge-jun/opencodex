import { describe, expect, test } from "bun:test";

import {
  clampAutoCompactTokenLimit,
  modelAutoCompactTokenLimitsConfigError,
} from "../src/providers/auto-compact-budget";

describe("per-model auto-compaction budgets", () => {
  test("configuration only lowers the effective hard-limit envelope", () => {
    expect(clampAutoCompactTokenLimit(1_000)).toBe(900);
    expect(clampAutoCompactTokenLimit(1_000, 800)).toBe(800);
    expect(clampAutoCompactTokenLimit(1_000, 800, 700)).toBe(700);
    expect(clampAutoCompactTokenLimit(1_000, 800, 5_000)).toBe(800);
  });

  test("one validation contract handles config, native ids, and PATCH tombstones", () => {
    expect(modelAutoCompactTokenLimitsConfigError({ model: 64_000 })).toBeNull();
    expect(modelAutoCompactTokenLimitsConfigError(
      { "gpt-5.6-sol": 64_000 },
      { requireNativeIds: true },
    )).toBeNull();
    expect(modelAutoCompactTokenLimitsConfigError(
      { model: null },
      { allowTombstones: true },
    )).toBeNull();
    expect(modelAutoCompactTokenLimitsConfigError(null, { allowTombstones: true })).toBeNull();

    for (const invalid of [
      null,
      [],
      { model: 0 },
      { model: 1.5 },
      { model: Number.MAX_SAFE_INTEGER + 1 },
      { model: null },
      JSON.parse('{"__proto__": 1000}'),
      { constructor: 1000 },
      Object.create({ inherited: 1000 }),
    ]) {
      expect(modelAutoCompactTokenLimitsConfigError(invalid)).not.toBeNull();
    }
    expect(modelAutoCompactTokenLimitsConfigError(
      { "team/gpt-5.6-sol": 64_000 },
      { requireNativeIds: true },
    )).toContain("exact supported native model id");
    expect(modelAutoCompactTokenLimitsConfigError(
      { "team/gpt-5.6-sol": null },
      { allowTombstones: true, requireNativeIds: true },
    )).toContain("exact supported native model id");
  });

  test("validation errors redact secret-shaped model ids", () => {
    const secret = "api_key=sk-secret-provider-key";
    const error = modelAutoCompactTokenLimitsConfigError({ [secret]: 0 });
    expect(error).toContain("[REDACTED]");
    expect(error).not.toContain("sk-secret-provider-key");
  });
});
