import { describe, expect, test } from "bun:test";
import {
  DEFAULT_MEMORY_RECALL_SOAK_OPTIONS,
  deterministicPercent,
  deterministicToolCount,
  linearSlope,
  maxFinite,
  mulberry32,
  parseMemoryRecallSoakOptions,
  stableHash,
} from "../scripts/memory-recall-soak-lib";

describe("#820 memory recall soak probe helpers", () => {
  test("full defaults preserve the acceptance workload contract", () => {
    expect(parseMemoryRecallSoakOptions([])).toEqual(DEFAULT_MEMORY_RECALL_SOAK_OPTIONS);
    expect(DEFAULT_MEMORY_RECALL_SOAK_OPTIONS).toMatchObject({
      sustainedSessions: 32,
      sustainedRounds: 10,
      sustainedWaves: 3,
      burstSessions: 64,
      slowConsumerPercent: 25,
      cancelPercent: 25,
    });
  });

  test("quick mode stays bounded and explicit overrides win", () => {
    expect(parseMemoryRecallSoakOptions([
      "--quick",
      "--sessions", "6",
      "--rounds", "3",
      "--fault-sessions", "0",
    ])).toMatchObject({
      sustainedSessions: 6,
      sustainedRounds: 3,
      sustainedWaves: 2,
      burstSessions: 8,
      faultSessions: 0,
    });
  });

  test("invalid numeric and unknown options fail closed", () => {
    expect(() => parseMemoryRecallSoakOptions(["--sessions", "0"])).toThrow();
    expect(() => parseMemoryRecallSoakOptions(["--sessions", "97"])).toThrow();
    expect(() => parseMemoryRecallSoakOptions(["--slow-percent", "101"])).toThrow();
    expect(() => parseMemoryRecallSoakOptions(["--unknown"])).toThrow();
    expect(() => parseMemoryRecallSoakOptions(["positional"])).toThrow();
  });

  test("seeded workload decisions are reproducible and remain in bounds", () => {
    const first = mulberry32(820_001);
    const second = mulberry32(820_001);
    expect(Array.from({ length: 8 }, () => first())).toEqual(Array.from({ length: 8 }, () => second()));

    for (let index = 0; index < 128; index++) {
      const session = `session-${index}`;
      expect(stableHash(session, 7)).toBe(stableHash(session, 7));

      const toolCount = deterministicToolCount(session, index % 10, 7);
      expect(toolCount).toBeGreaterThanOrEqual(1);
      expect(toolCount).toBeLessThanOrEqual(8);

      const percent = deterministicPercent(session, "slow", 7);
      expect(percent).toBeGreaterThanOrEqual(0);
      expect(percent).toBeLessThanOrEqual(99);
    }
  });

  test("idle-wave slope reports direction without inventing an RSS pass threshold", () => {
    expect(linearSlope([])).toBeNull();
    expect(linearSlope([100])).toBeNull();
    expect(linearSlope([100, 120, 140])).toBe(20);
    expect(linearSlope([140, 120, 100])).toBe(-20);
    expect(linearSlope([100, 100, 100])).toBe(0);
    expect(maxFinite([1, 9, 3])).toBe(9);
    expect(maxFinite([])).toBeNull();
  });
});
