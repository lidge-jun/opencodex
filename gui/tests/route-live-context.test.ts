import { describe, expect, test } from "bun:test";
import {
  calibrateContext, contextHealth, layoutTiles, type ContextBreakdown, type ContextTile,
} from "../src/pages/route-live/context-tiles";
import { cacheHitPercent, cacheMeterOf, parseRouteRows, type RouteRow } from "../src/pages/route-live/route-rows";

const breakdown = (over: Partial<ContextBreakdown> = {}): ContextBreakdown => ({
  v: 1,
  parts: { system: 100, tools: 100, skills: 0, memory: 0, files: 0, results: 0, chat: 200 },
  turns: [50, 150], toolCount: 4, ...over,
});

const area = (tiles: ContextTile[]) => tiles.reduce((sum, tile) => sum + tile.w * tile.h, 0);

function overlap(a: ContextTile, b: ContextTile): number {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
}

function expectCovers(tiles: ContextTile[], width: number, height: number) {
  expect(area(tiles)).toBeCloseTo(width * height, 3);
  for (const tile of tiles) {
    expect(tile.x).toBeGreaterThanOrEqual(-1e-6);
    expect(tile.y).toBeGreaterThanOrEqual(-1e-6);
    expect(tile.x + tile.w).toBeLessThanOrEqual(width + 1e-6);
    expect(tile.y + tile.h).toBeLessThanOrEqual(height + 1e-6);
  }
  for (let i = 0; i < tiles.length; i++) {
    for (let j = i + 1; j < tiles.length; j++) expect(overlap(tiles[i]!, tiles[j]!)).toBeLessThan(1e-3);
  }
}

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

describe("context treemap layout", () => {
  const WIDTH = 600;
  const HEIGHT = 200;

  test("draws the used share as share^0.35 and fills the rest with one free tile, covering the box exactly", () => {
    const shares = calibrateContext(breakdown(), 4000);
    const tiles = layoutTiles(shares, 200_000, WIDTH, HEIGHT);
    expectCovers(tiles, WIDTH, HEIGHT);
    const free = tiles.filter(tile => tile.kind === "free");
    expect(free).toHaveLength(1);
    expect(free[0]!.tokens).toBeCloseTo(196_000, 3);
    expect(free[0]!.x).toBeCloseTo(WIDTH * Math.pow(4000 / 200_000, 0.35), 3);
    expect(tiles.filter(tile => tile.kind !== "free").reduce((sum, tile) => sum + tile.tokens, 0)).toBeCloseTo(4000, 3);
  });

  test("an unknown window, or a prompt past the window, has no free tile and the parts fill the box", () => {
    const shares = calibrateContext(breakdown(), 4000);
    for (const window of [undefined, 3000, 4000]) {
      const tiles = layoutTiles(shares, window, WIDTH, HEIGHT);
      expect(tiles.some(tile => tile.kind === "free")).toBe(false);
      expectCovers(tiles, WIDTH, HEIGHT);
    }
  });

  test("a tiny part still gets a tile large enough to point at", () => {
    const parts = { system: 50_000, tools: 30_000, skills: 3, memory: 0, files: 0, results: 0, chat: 20_000 };
    const shares = calibrateContext(breakdown({ parts, turns: [], toolCount: 1 }), undefined);
    const tiles = layoutTiles(shares, 200_000, WIDTH, HEIGHT);
    expectCovers(tiles, WIDTH, HEIGHT);
    const skills = tiles.find(tile => tile.kind === "skills")!;
    expect(Math.min(skills.w, skills.h)).toBeGreaterThanOrEqual(14);
  });

  test("an empty prompt with a known window is one free tile", () => {
    const parts = { system: 0, tools: 0, skills: 0, memory: 0, files: 0, results: 0, chat: 0 };
    const tiles = layoutTiles(calibrateContext(breakdown({ parts, turns: [] }), undefined), 1000, WIDTH, HEIGHT);
    expect(tiles.map(tile => tile.kind)).toEqual(["free"]);
    expectCovers(tiles, WIDTH, HEIGHT);
  });

  test("chat splits into per-turn tiles that add up to the chat part, with older turns merged", () => {
    const turns = Array.from({ length: 20 }, (_, i) => 3000 + i * 100);
    const chat = turns.reduce((s, v) => s + v, 0) + 500;
    const big = breakdown({
      parts: { system: 20_000, tools: 10_000, skills: 0, memory: 0, files: 0, results: 0, chat },
      turns, turnsEarlier: 500, toolCount: 9,
    });
    const tiles = layoutTiles(calibrateContext(big, undefined), 200_000, 900, 260);
    expectCovers(tiles, 900, 260);
    const chatTiles = tiles.filter(tile => tile.kind === "chat");
    const perTurn = chatTiles.filter(tile => tile.turn !== undefined);
    expect(perTurn.length).toBeGreaterThan(1);
    expect(perTurn.length).toBeLessThanOrEqual(12);
    expect(perTurn.every(tile => Math.min(tile.w, tile.h) >= 14)).toBe(true);
    expect(Math.max(...perTurn.map(tile => tile.turn!))).toBe(20);
    expect(chatTiles.filter(tile => tile.earlier)).toHaveLength(1);
    expect(chatTiles.reduce((sum, tile) => sum + tile.tokens, 0)).toBeCloseTo(chat, 3);
  });

  test("when the turns would be slivers, chat stays one tile", () => {
    const tiles = layoutTiles(calibrateContext(breakdown(), undefined), 200_000, 80, 40);
    expectCovers(tiles, 80, 40);
    expect(tiles.filter(tile => tile.kind === "chat")).toHaveLength(1);
    expect(tiles.find(tile => tile.kind === "chat")!.turn).toBeUndefined();
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
