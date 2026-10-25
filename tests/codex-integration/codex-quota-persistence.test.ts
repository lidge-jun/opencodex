import { afterEach, beforeEach, describe, expect, jest, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearAccountQuota, flushQuotaObservationsForTests, setAccountQuotaFromParsed } from "../../src/codex/quota";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const previousHome = process.env.OPENCODEX_HOME;
const FILE = "codex-quota-cache.json";
let homes: string[];
let home: string;
let elapsed: number;
let restoreClock: () => void;

function advance(ms: number): void {
  elapsed += ms;
  jest.advanceTimersByTime(ms);
}

function snapshot(): Record<string, { weeklyPercent: number }> {
  return JSON.parse(readFileSync(join(home, FILE), "utf8")).quotas;
}

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), "ocx-codex-quota-persist-"));
  homes = [home];
  process.env.OPENCODEX_HOME = home;
  clearAccountQuota();
  await flushQuotaObservationsForTests();
  jest.useFakeTimers();
  elapsed = 0;
  const clock = spyOn(performance, "now").mockImplementation(() => elapsed);
  restoreClock = () => clock.mockRestore();
});

afterEach(async () => {
  clearAccountQuota();
  await flushQuotaObservationsForTests();
  restoreClock();
  jest.clearAllTimers();
  jest.useRealTimers();
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  for (const path of homes) removeTreeWithRetry(path);
});

describe("Codex quota snapshot persistence", () => {
  test("a short burst keeps the 250 ms idle debounce and writes the latest quota", () => {
    setAccountQuotaFromParsed("pool-a", { weeklyPercent: 10 });
    advance(100);
    setAccountQuotaFromParsed("pool-a", { weeklyPercent: 20 });
    advance(249);
    expect(existsSync(join(home, FILE))).toBe(false);
    advance(1);
    expect(snapshot()["pool-a"]?.weeklyPercent).toBe(20);
  });

  test("sustained updates persist the latest quota at each one-second deadline", () => {
    for (let batch = 0; batch < 2; batch++) {
      for (let update = 1; update <= 10; update++) {
        setAccountQuotaFromParsed("pool-a", { weeklyPercent: batch * 10 + update });
        advance(100);
      }
      expect(snapshot()["pool-a"]?.weeklyPercent).toBe((batch + 1) * 10);
    }
  });

  test("clearing one account keeps the pending deadline and excludes its row", () => {
    setAccountQuotaFromParsed("removed", { weeklyPercent: 75 });
    for (let update = 1; update <= 9; update++) {
      setAccountQuotaFromParsed("kept", { weeklyPercent: update });
      advance(100);
    }
    clearAccountQuota("removed");
    advance(100);
    expect(snapshot()).toEqual({ kept: expect.objectContaining({ weeklyPercent: 9 }) });
  });

  test("clearing all accounts cancels the old write and resets the deadline for a new home", () => {
    const oldHome = home;
    for (let update = 0; update < 9; update++) {
      setAccountQuotaFromParsed("old-account", { weeklyPercent: update });
      advance(100);
    }
    clearAccountQuota();
    home = mkdtempSync(join(tmpdir(), "ocx-codex-quota-next-"));
    homes.push(home);
    process.env.OPENCODEX_HOME = home;
    setAccountQuotaFromParsed("new-account", { weeklyPercent: 15 });
    advance(249);
    expect(existsSync(join(home, FILE))).toBe(false);
    expect(existsSync(join(oldHome, FILE))).toBe(false);
    advance(1);
    expect(snapshot()).toEqual({ "new-account": expect.objectContaining({ weeklyPercent: 15 }) });
  });

  test("a failed write remains best-effort and the next update gets a fresh debounce", () => {
    mkdirSync(join(home, FILE));
    setAccountQuotaFromParsed("pool-a", { weeklyPercent: 10 });
    expect(() => advance(250)).not.toThrow();
    rmdirSync(join(home, FILE));
    advance(1_000);
    setAccountQuotaFromParsed("pool-a", { weeklyPercent: 20 });
    advance(249);
    expect(existsSync(join(home, FILE))).toBe(false);
    advance(1);
    expect(snapshot()["pool-a"]?.weeklyPercent).toBe(20);
  });
});
