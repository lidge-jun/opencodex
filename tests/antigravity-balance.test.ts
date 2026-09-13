import { describe, expect, test } from "bun:test";
import { AntigravityBalancer, antigravityBalanceUsage, antigravityQuotaFamily } from "/Users/vanch/Documents/Codex/2026-08-05/https-github-com-lidge-jun-opencodex/outputs/upgrade-2.51.0/merged/src/oauth/antigravity-balance";

describe("Antigravity quota balancing", () => {
  test("uses requested family instead of unrelated quota", () => {
    const q = { updatedAt: 1000, customWindows: [{ label: "Gem", percent: 79 }, { label: "Cla", percent: 0 }] };
    expect(antigravityBalanceUsage(q, antigravityQuotaFamily("gemini-3.8-flash"), 1001)).toBe(79);
    expect(antigravityBalanceUsage(q, "Cla", 1001)).toBe(0);
  });
  test("stale, expired and invalid quota cannot pin routing", () => {
    expect(antigravityBalanceUsage({ updatedAt: 1, fiveHourPercent: 0 }, "Gem", 400000)).toBeNull();
    expect(antigravityBalanceUsage({ updatedAt: 1000, customWindows: [{ label: "Gem", percent: 99, resetAt: 1000 }] }, "Gem", 1001)).toBeNull();
    expect(antigravityBalanceUsage({ updatedAt: 1000, fiveHourPercent: NaN }, "Gem", 1001)).toBeNull();
  });
  test("80 equal requests spread exactly across eight accounts", () => {
    const b = new AntigravityBalancer();
    const candidates = Array.from({ length: 8 }, (_, i) => ({ id: String(i), usage: 0 }));
    const counts = new Map<string, number>();
    for (let i = 0; i < 80; i++) { const id = b.pick(candidates, "Gem")!; counts.set(id, (counts.get(id) ?? 0) + 1); }
    expect([...counts.values()]).toEqual(Array(8).fill(10));
  });
  test("avoids heavily used account and distributes close readings", () => {
    const b = new AntigravityBalancer();
    const rows = [{ id: "a", usage: 2 }, { id: "b", usage: 4 }, { id: "low", usage: 79 }];
    expect(Array.from({ length: 4 }, () => b.pick(rows, "Gem"))).toEqual(["a", "b", "a", "b"]);
  });
  test("unknown accounts get sampled and family counters are independent", () => {
    const b = new AntigravityBalancer();
    const rows = [{ id: "a", usage: 0 }, { id: "b", usage: null }];
    expect(b.pick(rows, "Gem")).toBe("a");
    expect(b.pick(rows, "Gem")).toBe("b");
    expect(b.pick(rows, "Cla")).toBe("a");
    expect(b.pick([], "Gem")).toBeNull();
  });
});
