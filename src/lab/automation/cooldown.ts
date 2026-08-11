import type { LabAutomationPolicyV1, LabAutomationStateV1 } from "./types";

export function cooldownActive(state: LabAutomationStateV1, key: string, now: number): boolean {
  const until = state.cooldownUntilByKey[key];
  return typeof until === "number" && until > now;
}

export function setCooldown(
  state: LabAutomationStateV1,
  key: string,
  untilMs: number,
): LabAutomationStateV1 {
  return {
    ...state,
    cooldownUntilByKey: {
      ...state.cooldownUntilByKey,
      [key]: untilMs,
    },
  };
}

export function clearCooldown(state: LabAutomationStateV1, key: string): LabAutomationStateV1 {
  if (!state.cooldownUntilByKey[key]) return state;
  const next = { ...state.cooldownUntilByKey };
  delete next[key];
  return { ...state, cooldownUntilByKey: next };
}

export function cooldownForFailure(
  policy: LabAutomationPolicyV1,
  classification: string,
  now: number,
): number {
  if (classification === "authentication_blocked" || classification === "auth_blocked" || classification === "quota_blocked" || classification === "region_blocked") {
    return now + policy.blockedCooldownMs;
  }
  if (classification === "harness_failure") {
    return now + policy.blockedCooldownMs;
  }
  return now + policy.failureCooldownMs;
}
