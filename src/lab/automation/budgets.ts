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

function rollingStartedRuns(state: LabAutomationStateV1, now: number): number {
  const cutoff = now - LAB_AUTOMATION_HARD_MAX.budgetWindowMs;
  return state.runs.filter((run) => typeof run.startedAt === "number" && run.startedAt > cutoff && run.startedAt <= now).length;
}

function rollingStartedLiveRuns(state: LabAutomationStateV1, now: number): number {
  const cutoff = now - LAB_AUTOMATION_HARD_MAX.budgetWindowMs;
  return state.runs.filter((run) =>
    run.evidenceLayer === "live_route_compatibility"
    && typeof run.startedAt === "number"
    && run.startedAt > cutoff
    && run.startedAt <= now
  ).length;
}

function legacyCounterActive(state: LabAutomationStateV1, now: number): boolean {
  return now - state.budgetWindowStartedAt < LAB_AUTOMATION_HARD_MAX.budgetWindowMs;
}

export function runBudgetRemaining(
  policy: LabAutomationPolicyV1,
  state: LabAutomationStateV1,
  now = Date.now(),
): number {
  const rolling = rollingStartedRuns(state, now);
  const legacy = legacyCounterActive(state, now) ? state.runsThisHour : 0;
  return Math.max(0, policy.maxRunsPerHour - Math.max(rolling, legacy));
}

export function liveRequestBudgetRemaining(
  policy: LabAutomationPolicyV1,
  state: LabAutomationStateV1,
  now = Date.now(),
): number {
  const rolling = rollingStartedLiveRuns(state, now);
  const legacy = legacyCounterActive(state, now) ? state.liveRequestsThisHour : 0;
  return Math.max(0, policy.maxLiveRequestsPerHour - Math.max(rolling, legacy));
}

export function isRunBudgetExhausted(
  policy: LabAutomationPolicyV1,
  state: LabAutomationStateV1,
  now = Date.now(),
): boolean {
  return runBudgetRemaining(policy, state, now) <= 0;
}

export function isLiveRequestBudgetExhausted(
  policy: LabAutomationPolicyV1,
  state: LabAutomationStateV1,
  now = Date.now(),
): boolean {
  return liveRequestBudgetRemaining(policy, state, now) <= 0;
}

/** Legacy persisted counters remain for schema compatibility; startedAt records are rolling authority. */
export function recordRunBudgetUse(state: LabAutomationStateV1, liveRequest: boolean): LabAutomationStateV1 {
  return {
    ...state,
    runsThisHour: Math.min(LAB_AUTOMATION_HARD_MAX.maxRunsPerHour, state.runsThisHour + 1),
    liveRequestsThisHour: liveRequest
      ? Math.min(LAB_AUTOMATION_HARD_MAX.maxLiveRequestsPerHour, state.liveRequestsThisHour + 1)
      : state.liveRequestsThisHour,
  };
}
