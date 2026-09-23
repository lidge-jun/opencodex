import { afterEach, describe, expect, test } from "bun:test";
import {
  clearComboTargetCooldowns,
  coolComboTarget,
  earliestComboCooldownExpiry,
  isComboTargetInCooldown,
  parseRetryAfterMs,
} from "../../src/combos/failover";

const target = { provider: "devin", model: "swe-2" };
const combo = "stated-reset-hardening-test";
const now = Date.UTC(2026, 8, 18, 8, 0, 0);
afterEach(() => clearComboTargetCooldowns(combo));

describe("explicit server cooldown versus local wait allowance", () => {
  test("keeps legacy bounded parsing unless preserving a server lower bound", () => {
    expect(parseRetryAfterMs("3600", now)).toBe(600_000);
    expect(parseRetryAfterMs("3600", now, { preserveServerDelay: true })).toBe(3_600_000);
  });

  test.each([301, 780, 1260, 3600, 7200])("keeps the full %i-second server delay", seconds => {
    coolComboTarget(combo, target, { now, retryAfter: String(seconds) });
    expect(earliestComboCooldownExpiry(combo, [target], now)).toBe(now + seconds * 1000);
    expect(isComboTargetInCooldown(combo, target, now + seconds * 1000 - 1)).toBe(true);
    expect(isComboTargetInCooldown(combo, target, now + seconds * 1000)).toBe(false);
  });

  test("HTTP-date reset also keeps the full hour", () => {
    coolComboTarget(combo, target, { now, retryAfter: new Date(now + 3_600_000).toUTCString() });
    expect(earliestComboCooldownExpiry(combo, [target], now)).toBe(now + 3_600_000);
  });

  test("a configured fallback is still bounded to ten minutes", () => {
    coolComboTarget(combo, target, { now, cooldownMs: 99_000_000 });
    expect(earliestComboCooldownExpiry(combo, [target], now)).toBe(now + 600_000);
  });

  test("explicit immediate retry stays immediate", () => {
    coolComboTarget(combo, target, { now, retryAfter: "0" });
    expect(earliestComboCooldownExpiry(combo, [target], now)).toBe(now + 1);
  });
});
