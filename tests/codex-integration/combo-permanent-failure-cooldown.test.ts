import { afterEach, describe, expect, test } from "bun:test";
import {
  clearComboTargetCooldowns,
  comboFailureCooldownScope,
  comboFailureDecision,
  coolComboTarget,
  isComboTargetInCooldown,
} from "../../src/combos/failover";

/**
 * A rejected or unpaid credential does not turn over in a minute, but without a stated deadline
 * it took the generic 60-second default, so the target was re-offered every minute until someone
 * fixed billing. The cooldown DURATION is the only thing these cases change: the scope stays
 * whatever `comboFailureCooldownScope` already said, which the hop case below pins.
 */
const combo = "permanent-failure-cooldown-test";
const target = { provider: "openai", model: "gpt-6-astra" };
const now = Date.UTC(2026, 8, 24, 12, 0, 0);
const TEN_MINUTES = 10 * 60_000;

afterEach(() => clearComboTargetCooldowns(combo));

describe("a permanent credential or billing failure", () => {
  test.each([
    "invalid_api_key",
    "insufficient_quota",
    "subscription_required",
    "payment_required",
    "billing_error",
    "insufficient_balance",
  ])("cools the target for ten minutes, not 60s (%s)", (code) => {
    coolComboTarget(combo, target, { now, status: 401, code });
    // The whole point: still cooling a minute later, when the 60s default would have expired.
    expect(isComboTargetInCooldown(combo, target, now + 60_000)).toBe(true);
    expect(isComboTargetInCooldown(combo, target, now + TEN_MINUTES - 1)).toBe(true);
    expect(isComboTargetInCooldown(combo, target, now + TEN_MINUTES)).toBe(false);
  });

  test("still blacks out the whole provider, exactly as before", () => {
    expect(comboFailureCooldownScope(401, "invalid key", { code: "invalid_api_key" })).toBe("provider");
    expect(comboFailureDecision(401, "invalid key", { code: "invalid_api_key" })).toBe("hop");
  });

  test("an unrelated 401 keeps the 60-second default", () => {
    coolComboTarget(combo, target, { now, status: 401, code: "authentication_error", message: "bad token" });
    expect(isComboTargetInCooldown(combo, target, now + 60_000 - 1)).toBe(true);
    expect(isComboTargetInCooldown(combo, target, now + 60_000)).toBe(false);
  });

  test("a stated deadline still outranks the ten-minute default", () => {
    for (const deadline of [{ retryAfter: "30" }, { resetAt: now + 30_000 }, { cooldownMs: 30_000 }]) {
      coolComboTarget(combo, target, { now, status: 401, code: "invalid_api_key", ...deadline });
      expect(isComboTargetInCooldown(combo, target, now + 29_999)).toBe(true);
      expect(isComboTargetInCooldown(combo, target, now + 30_000)).toBe(false);
    }
  });
});
