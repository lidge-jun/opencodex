import { LAB_AUTOMATION_HARD_MAX } from "./constants";
import type { LabAutomationPolicyV1, LabAutomationStateV1 } from "./types";

/**
 * A persisted, expiring tombstone used only when the bounded per-key cooldown map
 * cannot accept another key. While active, scheduled planning fails closed for all
 * run keys. Its expiry covers every cooldown that was collapsed into it.
 */
const COOLDOWN_SATURATION_KEY = "__ocx_cooldown_saturation__";

function saturationActive(cooldowns: Record<string, number>, now: number): boolean {
  const until = cooldowns[COOLDOWN_SATURATION_KEY];
  return typeof until === "number" && until > now;
}

export function cooldownActive(state: LabAutomationStateV1, key: string, now: number): boolean {
  const cooldowns = activeCooldowns(state, now);
  if (saturationActive(cooldowns, now)) return true;
  const until = cooldowns[key];
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
  const cooldowns = activeCooldowns(state, now);
  if (saturationActive(cooldowns, now)) return true;
  return reservedCooldownKeys({ ...state, cooldownUntilByKey: cooldowns }, now).size
    >= LAB_AUTOMATION_HARD_MAX.maxPersistedRuns;
}

/** Reserve capacity implicitly through the running scheduled record before dispatch. */
export function canReserveScheduledCooldown(
  state: LabAutomationStateV1,
  runKey: string,
  now: number,
): boolean {
  const cooldowns = activeCooldowns(state, now);
  if (saturationActive(cooldowns, now)) return false;
  const reserved = reservedCooldownKeys({ ...state, cooldownUntilByKey: cooldowns }, now);
  return reserved.has(runKey) || reserved.size < LAB_AUTOMATION_HARD_MAX.maxPersistedRuns;
}

export function setCooldown(
  state: LabAutomationStateV1,
  key: string,
  untilMs: number,
  now: number,
): LabAutomationStateV1 {
  const next = activeCooldowns(state, now);
  const saturationUntil = next[COOLDOWN_SATURATION_KEY];
  if (typeof saturationUntil === "number") {
    next[COOLDOWN_SATURATION_KEY] = Math.max(saturationUntil, untilMs);
    return { ...state, cooldownUntilByKey: next };
  }
  if (!(key in next) && Object.keys(next).length >= LAB_AUTOMATION_HARD_MAX.maxPersistedRuns) {
    const longestExistingUntil = Math.max(now, ...Object.values(next));
    return {
      ...state,
      cooldownUntilByKey: {
        [COOLDOWN_SATURATION_KEY]: Math.max(longestExistingUntil, untilMs),
      },
    };
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
