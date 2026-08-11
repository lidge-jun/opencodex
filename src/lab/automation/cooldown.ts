import { LAB_AUTOMATION_HARD_MAX } from "./constants";
import type { LabAutomationPolicyV1, LabAutomationStateV1 } from "./types";

export function cooldownActive(state: LabAutomationStateV1, key: string, now: number): boolean {
  const until = state.cooldownUntilByKey[key];
  return typeof until === "number" && until > now;
}

function activeCooldowns(state: LabAutomationStateV1, now: number): Record<string, number> {
  const next: Record<string, number> = {};
  for (const [key, until] of Object.entries(state.cooldownUntilByKey)) {
    if (until > now) next[key] = until;
  }
  return next;
}

function reservedCooldownKeys(state: LabAutomationStateV1, now: number): Set<string> {
  const reserved = new Set(Object.keys(activeCooldowns(state, now)));
  for (const run of state.runs) {
    if (run.trigger === "scheduled" && run.state === "running") reserved.add(run.runKey);
  }
  return reserved;
}

/** True when another scheduled run could no longer reserve a durable failure cooldown. */
export function cooldownCapacityExhausted(state: LabAutomationStateV1, now: number): boolean {
  return reservedCooldownKeys(state, now).size >= LAB_AUTOMATION_HARD_MAX.maxPersistedRuns;
}

/** Reserve capacity implicitly through the running scheduled record before dispatch. */
export function canReserveScheduledCooldown(
  state: LabAutomationStateV1,
  runKey: string,
  now: number,
): boolean {
  const reserved = reservedCooldownKeys(state, now);
  return reserved.has(runKey) || reserved.size < LAB_AUTOMATION_HARD_MAX.maxPersistedRuns;
}

export function setCooldown(
  state: LabAutomationStateV1,
  key: string,
  untilMs: number,
  now: number,
): LabAutomationStateV1 {
  const next = activeCooldowns(state, now);
  if (!(key in next) && Object.keys(next).length >= LAB_AUTOMATION_HARD_MAX.maxPersistedRuns) {
    return { ...state, cooldownUntilByKey: next };
  }
  next[key] = untilMs;
  return { ...state, cooldownUntilByKey: next };
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
