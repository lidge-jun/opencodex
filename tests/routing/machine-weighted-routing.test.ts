import { expect, test } from "bun:test";
import { resetNearWeightOf, type ResetNearQuota } from "../../src/routing/machine-weighted-routing";

const now = Date.UTC(2026, 9, 2);
const hour = 60 * 60_000;
const near = (override: ResetNearQuota = {}): ResetNearQuota => ({
  weeklyPercent: 40, weeklyResetAt: now + hour, weeklyObservedAt: now,
  fiveHourPercent: 59, fiveHourObservedAt: now, ...override,
});
const route = (quota: ResetNearQuota | null) => resetNearWeightOf(["a", "b", "c"], id => id === "b" ? quota : null, now);

test.each([2, 4, 8])("the nearest reset receives half the available weight in a pool of %i", size => {
  const ids = Array.from({ length: size }, (_, i) => `a${i}`);
  const weight = resetNearWeightOf(ids, id => near({ weeklyResetAt: now + (id === "a1" ? 1 : 12) * hour }), now);
  expect(ids.map(id => weight?.(id))).toEqual(ids.map(id => id === "a1" ? size - 1 : 1));
});

test("five-hour usage and weekly remaining enforce strict cutoffs", () => {
  expect(route(near({ fiveHourPercent: 59.9, weeklyPercent: 97.9 }))?.("b")).toBe(2);
  expect(route(near({ fiveHourPercent: 60 }))).toBeUndefined();
  expect(route(near({ weeklyPercent: 98 }))).toBeUndefined();
});

test("missing, stale, future-dated and invalid readings get no weight preference", () => {
  expect(route(null)).toBeUndefined();
  for (const override of [
    { weeklyObservedAt: undefined }, { weeklyObservedAt: now - 16 * 60_000 }, { weeklyObservedAt: now + 1 },
    { fiveHourObservedAt: undefined }, { fiveHourObservedAt: now - 16 * 60_000 }, { fiveHourObservedAt: now + 1 },
    { weeklyPercent: undefined }, { weeklyPercent: NaN }, { fiveHourPercent: undefined }, { fiveHourPercent: Infinity },
  ]) expect(route(near(override))).toBeUndefined();
  expect(route(near({ weeklyObservedAt: now - 15 * 60_000 }))?.("b")).toBe(2);
});

test("the weekly reset is future and within 24 hours and the five-hour window is still open", () => {
  expect(route(near({ weeklyResetAt: undefined }))).toBeUndefined();
  expect(route(near({ weeklyResetAt: now }))).toBeUndefined();
  expect(route(near({ weeklyResetAt: now + 24 * hour + 1 }))).toBeUndefined();
  expect(route(near({ weeklyResetAt: now + 24 * hour, fiveHourResetAt: now }))).toBeUndefined();
  expect(route(near({ weeklyResetAt: (now + 24 * hour) / 1000, fiveHourObservedAt: now / 1000 }))?.("b")).toBe(2);
});

test("a disqualified earlier reset leaves other accounts in the ring and ties use account ID", () => {
  const ids = ["b", "a", "c", "d"];
  const weight = resetNearWeightOf(ids, id => id === "c"
    ? near({ weeklyResetAt: now + 10, fiveHourPercent: 60 }) : near(), now);
  expect(ids.map(id => weight?.(id))).toEqual([1, 3, 1, 1]);
});

test("an empty or single-account pool needs no quota lookup", () => {
  for (const ids of [[], ["a"]]) {
    expect(resetNearWeightOf(ids, () => { throw new Error("unexpected lookup"); }, now)).toBeUndefined();
  }
});
