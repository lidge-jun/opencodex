import { LAB_AUTOMATION_HARD_MAX } from "./constants";
import type { LabAutomationPolicyV1, LabAutomationStateV1 } from "./types";

export function rollBudgetWindow(state: LabAutomationStateV1, now: number): LabAutomationStateV1 {
  if (now - state.budgetWindowStartedAt < LAB_AUTOMATION_HARD_MAX.budgetWindowMs) return state;
  return {
    ...state,
    budgetWindowStartedAt: now,
    runsThisHour: 0,
    liveRequestsThisHour: 0,
  };
}

export function runBudgetRemaining(policy: LabAutomationPolicyV1, state: LabAutomationStateV1): number {
  return Math.max(0, policy.maxRunsPerHour - state.runsThisHour);
}

export function liveRequestBudgetRemaining(policy: LabAutomationPolicyV1, state: LabAutomationStateV1): number {
  return Math.max(0, policy.maxLiveRequestsPerHour - state.liveRequestsThisHour);
}

export function isRunBudgetExhausted(policy: LabAutomationPolicyV1, state: LabAutomationStateV1): boolean {
  return runBudgetRemaining(policy, state) <= 0;
}

export function isLiveRequestBudgetExhausted(policy: LabAutomationPolicyV1, state: LabAutomationStateV1): boolean {
  return liveRequestBudgetRemaining(policy, state) <= 0;
}

export function recordRunBudgetUse(state: LabAutomationStateV1, liveRequest: boolean): LabAutomationStateV1 {
  return {
    ...state,
    runsThisHour: state.runsThisHour + 1,
    liveRequestsThisHour: liveRequest ? state.liveRequestsThisHour + 1 : state.liveRequestsThisHour,
  };
}
