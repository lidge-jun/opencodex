import { describe, expect, test } from "bun:test";
import { effectiveCodexQuotaRecoveryPolicy } from "../src/codex/reset-credit-policy";

describe("effectiveCodexQuotaRecoveryPolicy", () => {
  test("defaults to a frozen disabled alternate-first policy", () => {
    for (const raw of [undefined, null, false, [], {}, { enabled: "true" }]) {
      const policy = effectiveCodexQuotaRecoveryPolicy(raw);
      expect(policy).toEqual({
        enabled: false,
        autoRedeemResetCredit: false,
        priority: "alternate-first",
        automaticRedemptionAllowed: false,
      });
      expect(Object.isFrozen(policy)).toBe(true);
    }
  });

  test("requires both exact opt-ins before authorizing automatic redemption", () => {
    expect(effectiveCodexQuotaRecoveryPolicy({ enabled: true }).automaticRedemptionAllowed).toBe(false);
    expect(effectiveCodexQuotaRecoveryPolicy({ autoRedeemResetCredit: true }).automaticRedemptionAllowed).toBe(false);
    expect(effectiveCodexQuotaRecoveryPolicy({
      enabled: false,
      autoRedeemResetCredit: true,
      priority: "reset-first",
    }).automaticRedemptionAllowed).toBe(false);
    expect(effectiveCodexQuotaRecoveryPolicy({
      enabled: true,
      autoRedeemResetCredit: true,
      priority: "alternate-first",
    })).toMatchObject({ priority: "alternate-first", automaticRedemptionAllowed: true });
    expect(effectiveCodexQuotaRecoveryPolicy({
      enabled: true,
      autoRedeemResetCredit: true,
      priority: "reset-first",
    })).toMatchObject({ priority: "reset-first", automaticRedemptionAllowed: true });
  });

  test("does not broaden authorization for malformed priority or inherited values", () => {
    const inherited = Object.create({ enabled: true, autoRedeemResetCredit: true });
    expect(effectiveCodexQuotaRecoveryPolicy(inherited).automaticRedemptionAllowed).toBe(false);
    const accessor = Object.defineProperties({}, {
      enabled: { get: () => { throw new Error("must not run"); } },
      autoRedeemResetCredit: { value: true },
      priority: { value: "alternate-first" },
    });
    expect(() => effectiveCodexQuotaRecoveryPolicy(accessor)).not.toThrow();
    expect(effectiveCodexQuotaRecoveryPolicy(accessor).automaticRedemptionAllowed).toBe(false);
    expect(effectiveCodexQuotaRecoveryPolicy({
      enabled: true,
      autoRedeemResetCredit: true,
      priority: "unexpected",
    })).toEqual({
      enabled: true,
      autoRedeemResetCredit: true,
      priority: "alternate-first",
      automaticRedemptionAllowed: false,
    });
  });

  test("treats a throwing descriptor Proxy as a disabled policy", () => {
    let descriptorCalls = 0;
    const hostile = new Proxy({
      enabled: true,
      autoRedeemResetCredit: true,
      priority: "reset-first",
    }, {
      getOwnPropertyDescriptor() {
        descriptorCalls++;
        throw new Error("must not escape");
      },
    });

    const policy = effectiveCodexQuotaRecoveryPolicy(hostile);
    expect(policy).toEqual({
      enabled: false,
      autoRedeemResetCredit: false,
      priority: "alternate-first",
      automaticRedemptionAllowed: false,
    });
    expect(Object.isFrozen(policy)).toBe(true);
    expect(descriptorCalls).toBe(1);
  });

  test("treats a revoked Proxy as a disabled policy", () => {
    const { proxy, revoke } = Proxy.revocable({
      enabled: true,
      autoRedeemResetCredit: true,
      priority: "reset-first",
    }, {});
    revoke();

    const policy = effectiveCodexQuotaRecoveryPolicy(proxy);
    expect(policy).toEqual({
      enabled: false,
      autoRedeemResetCredit: false,
      priority: "alternate-first",
      automaticRedemptionAllowed: false,
    });
    expect(Object.isFrozen(policy)).toBe(true);
  });
});
