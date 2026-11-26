import { describe, expect, test } from "bun:test";
import {
  calibrateContext, contextHealth, type ContextBreakdown,
} from "../src/pages/route-live/context-tiles";
import { cacheHitPercent, cacheMeterOf, contextInputTokens, parseRouteRows, type RouteRow } from "../src/pages/route-live/route-rows";

const breakdown = (over: Partial<ContextBreakdown> = {}): ContextBreakdown => ({
  v: 1,
  parts: { system: 100, tools: 100, skills: 0, memory: 0, files: 0, results: 0, chat: 200 },
  turns: [50, 150], toolCount: 4, ...over,
});

describe("context calibration", () => {
  test("scales every part and turn by counted / estimated and marks the result calibrated", () => {
    const shares = calibrateContext(breakdown({ turnsEarlier: 10 }), 800);
    expect(shares.calibrated).toBe(true);
    expect(shares.used).toBeCloseTo(800, 6);
    expect(shares.parts.system).toBeCloseTo(200, 6);
    expect(shares.parts.chat).toBeCloseTo(400, 6);
    expect(shares.turns[0]).toBeCloseTo(100, 6);
    expect(shares.turns[1]).toBeCloseTo(300, 6);
    expect(shares.turnsEarlier).toBeCloseTo(20, 6);
  });

  test("without a counted size the estimate stands and is marked as such", () => {
    for (const counted of [undefined, 0]) {
      const shares = calibrateContext(breakdown(), counted);
      expect(shares.calibrated).toBe(false);
      expect(shares.used).toBe(400);
      expect(shares.parts.tools).toBe(100);
    }
  });

  test("a held upstream history is not scaled: the counted input also holds turns this body never carried", () => {
    const shares = calibrateContext(breakdown({ held: true }), 5000);
    expect(shares.held).toBe(true);
    expect(shares.calibrated).toBe(false);
    expect(shares.used).toBe(400);
  });

  test("health words flip at 75% and 90%", () => {
    expect([0.1, 0.749, 0.75, 0.899, 0.9, 1.2].map(contextHealth)).toEqual(["ok", "ok", "filling", "filling", "near", "near"]);
  });
});

describe("cache meter and parsing", () => {
  const row = (usage: RouteRow["usage"]) => ({ timestamp: 1, model: "m", provider: "anthropic", status: 200, durationMs: 5, usage }) as RouteRow;

  test("an unreported cache is unknown, a reported zero is a real 0%", () => {
    expect(cacheMeterOf(row({ inputTokens: 1000, outputTokens: 10 }))).toBeUndefined();
    expect(cacheHitPercent(row({ inputTokens: 1000, outputTokens: 10 }))).toBeUndefined();
    expect(cacheMeterOf(row(undefined))).toBeUndefined();
    expect(cacheMeterOf(row({ inputTokens: 1000, outputTokens: 10, cacheReadInputTokens: 0 }))).toEqual({ read: 0, total: 1000 });
    expect(cacheMeterOf(row({ inputTokens: 1000, outputTokens: 10, cacheReadInputTokens: 250 }))).toEqual({ read: 250, total: 1000 });
    expect(cacheHitPercent(row({ inputTokens: 1000, outputTokens: 10, cacheReadInputTokens: 250 }))).toBe(25);
  });

  test("a retried row sizes its context from the serving attempt, not the summed usage", () => {
    const attempt = (inputTokens?: number) => ({ provider: "p", model: "m", status: 200, ...(inputTokens === undefined ? {} : { usage: { inputTokens } }) });
    const summed = { ...row({ inputTokens: 80_000, outputTokens: 10 }) };
    expect(contextInputTokens({ ...summed, attempts: [attempt(40_000), attempt(40_000)] })).toBe(40_000);
    expect(contextInputTokens({ ...summed, attempts: [attempt(40_000), attempt()] })).toBeUndefined();
    expect(contextInputTokens({ ...summed, attempts: [attempt(80_000)] })).toBe(80_000);
    expect(contextInputTokens(summed)).toBe(80_000);
  });

  test("the parser keeps a valid breakdown and window and drops malformed ones", () => {
    const base = { timestamp: 1, model: "m", provider: "p", status: 200, durationMs: 5 };
    const good = breakdown();
    const rows = parseRouteRows([
      { ...base, requestId: "good", timestamp: 9, contextBreakdown: { ...good, extra: "ignored", held: true, turnsEarlier: 5 }, contextWindow: 200_000 },
      { ...base, requestId: "negative", timestamp: 8, contextBreakdown: { ...good, parts: { ...good.parts, tools: -1 } }, contextWindow: -5 },
      { ...base, requestId: "missing", timestamp: 7, contextBreakdown: { ...good, parts: { system: 1 } }, contextWindow: "big" },
      { ...base, requestId: "turns", timestamp: 6, contextBreakdown: { ...good, turns: [1, "2"] }, contextWindow: 0 },
      { ...base, requestId: "version", timestamp: 5, contextBreakdown: { ...good, v: 2 } },
      { ...base, requestId: "shape", timestamp: 4, contextBreakdown: "nope", contextWindow: Number.NaN },
      { ...base, requestId: "old", timestamp: 3 },
    ]);
    const byId = Object.fromEntries(rows.map(r => [r.requestId, r]));
    expect(byId.good!.contextBreakdown).toEqual({ ...good, held: true, turnsEarlier: 5 });
    expect(byId.good!.contextWindow).toBe(200_000);
    for (const id of ["negative", "missing", "turns", "version", "shape", "old"]) {
      expect(byId[id]!.contextBreakdown).toBeUndefined();
      expect(byId[id]!.contextWindow).toBeUndefined();
    }
  });
});
