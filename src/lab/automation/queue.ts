import { randomUUID } from "node:crypto";
import {
  LabAutomationError,
  type LabAutomationPolicyV1,
  type LabAutomationRunRecordV1,
  type LabAutomationRunState,
  type LabAutomationStateV1,
  type PlannedLabRunV1,
} from "./types";
import { LAB_AUTOMATION_HARD_MAX } from "./constants";

const TERMINAL_STATES = new Set<LabAutomationRunState>([
  "completed",
  "blocked",
  "failed",
  "cancelled",
  "abandoned",
]);

function isTerminal(run: LabAutomationRunRecordV1): boolean {
  return TERMINAL_STATES.has(run.state);
}

function isRollingBudgetEvidence(run: LabAutomationRunRecordV1, now: number): boolean {
  if (typeof run.startedAt !== "number") return false;
  const cutoff = now - LAB_AUTOMATION_HARD_MAX.budgetWindowMs;
  return run.startedAt > cutoff && run.startedAt <= now;
}

/** Evict only disposable terminal history; rolling budget records remain authority. */
function evictOldestTerminal(runs: LabAutomationRunRecordV1[], now: number): boolean {
  let oldestIndex = -1;
  let oldestTime = Number.POSITIVE_INFINITY;
  for (let index = 0; index < runs.length; index += 1) {
    const run = runs[index]!;
    if (!isTerminal(run) || isRollingBudgetEvidence(run, now)) continue;
    const terminalAt = run.completedAt ?? run.updatedAt;
    if (terminalAt < oldestTime) {
      oldestTime = terminalAt;
      oldestIndex = index;
    }
  }
  if (oldestIndex < 0) return false;
  runs.splice(oldestIndex, 1);
  return true;
}

export function countRunsByState(state: LabAutomationStateV1, runState: LabAutomationRunState): number {
  return state.runs.filter((row) => row.state === runState).length;
}

export function countRunningLive(state: LabAutomationStateV1): number {
  return state.runs.filter((row) => row.state === "running" && row.evidenceLayer === "live_route_compatibility").length;
}

export function countRunningForRoute(state: LabAutomationStateV1, subjectId: string): number {
  return state.runs.filter((row) => row.state === "running" && row.subjectId === subjectId).length;
}

export function findRunById(state: LabAutomationStateV1, runId: string): LabAutomationRunRecordV1 | undefined {
  return state.runs.find((row) => row.runId === runId);
}

export function enqueuePlannedRuns(
  state: LabAutomationStateV1,
  planned: PlannedLabRunV1[],
  trigger: LabAutomationRunRecordV1["trigger"],
  now: number,
): LabAutomationStateV1 {
  const existingActiveKeys = new Set(
    state.runs
      .filter((row) => row.state === "queued" || row.state === "running")
      .map((row) => row.runKey),
  );
  const runs = [...state.runs];
  let queuedCount = runs.filter((row) => row.state === "queued").length;
  for (const plan of planned) {
    if (existingActiveKeys.has(plan.runKey)) continue;
    if (queuedCount >= LAB_AUTOMATION_HARD_MAX.maxQueuedRuns) break;
    while (runs.length >= LAB_AUTOMATION_HARD_MAX.maxPersistedRuns) {
      if (!evictOldestTerminal(runs, now)) return { ...state, runs };
    }
    runs.push({
      runId: randomUUID(),
      runKey: plan.runKey,
      state: "queued",
      evidenceLayer: plan.evidenceLayer,
      suiteId: plan.suiteId,
      suiteVersion: plan.suiteVersion,
      suiteManifestDigest: plan.suiteManifestDigest,
      scenarioId: plan.scenarioId,
      scenarioVersion: plan.scenarioVersion,
      scenarioManifestDigest: plan.scenarioManifestDigest,
      subjectId: plan.subjectId,
      reason: plan.reason,
      priority: plan.priority,
      eligibleAt: plan.eligibleAt,
      trigger,
      createdAt: now,
      updatedAt: now,
      ...(plan.providerName ? { providerName: plan.providerName } : {}),
      ...(plan.modelId ? { modelId: plan.modelId } : {}),
    });
    queuedCount += 1;
    existingActiveKeys.add(plan.runKey);
  }
  return { ...state, runs };
}

export function transitionRun(
  state: LabAutomationStateV1,
  runId: string,
  next: LabAutomationRunState,
  now: number,
  terminalCode?: string,
): LabAutomationStateV1 {
  const runs = state.runs.map((row) => {
    if (row.runId !== runId) return row;
    return {
      ...row,
      state: next,
      updatedAt: now,
      ...(next === "running" ? { startedAt: now } : {}),
      ...(next === "completed" || next === "blocked" || next === "failed" || next === "cancelled" || next === "abandoned"
        ? { completedAt: now, ...(terminalCode ? { terminalCode } : {}) }
        : {}),
    };
  });
  return { ...state, runs };
}

export function cancelQueuedRun(state: LabAutomationStateV1, runId: string, now: number): LabAutomationStateV1 {
  const run = findRunById(state, runId);
  if (!run || run.state !== "queued") return state;
  return transitionRun(state, runId, "cancelled", now, "cancelled");
}

export function selectDispatchableRuns(
  policy: LabAutomationPolicyV1,
  state: LabAutomationStateV1,
  now: number,
  predicate: (run: LabAutomationRunRecordV1) => boolean = () => true,
): LabAutomationRunRecordV1[] {
  const running = countRunsByState(state, "running");
  if (running >= policy.maxConcurrentRuns) return [];
  const slots = policy.maxConcurrentRuns - running;
  const queued = state.runs
    .filter((row) => row.state === "queued" && row.eligibleAt <= now && predicate(row))
    .sort((a, b) => {
      if (a.priority !== b.priority) return a.priority - b.priority;
      if (a.eligibleAt !== b.eligibleAt) return a.eligibleAt - b.eligibleAt;
      return a.runId < b.runId ? -1 : 1;
    });
  const selected: LabAutomationRunRecordV1[] = [];
  const selectedPerRoute = new Map<string, number>();
  let liveRunning = countRunningLive(state);
  for (const row of queued) {
    if (selected.length >= slots) break;
    const runningForRoute = countRunningForRoute(state, row.subjectId);
    const selectedForRoute = selectedPerRoute.get(row.subjectId) ?? 0;
    if (runningForRoute + selectedForRoute >= policy.maxConcurrentRunsPerRoute) continue;
    if (row.evidenceLayer === "live_route_compatibility") {
      if (liveRunning >= policy.maxConcurrentLiveRuns) continue;
    }
    selected.push(row);
    selectedPerRoute.set(row.subjectId, selectedForRoute + 1);
    if (row.evidenceLayer === "live_route_compatibility") liveRunning += 1;
  }
  return selected;
}

export function trimTerminalRuns(state: LabAutomationStateV1, now: number): LabAutomationStateV1 {
  const keepMs = LAB_AUTOMATION_HARD_MAX.terminalRunRetentionMs;
  const runs = state.runs.filter((row) => {
    if (!isTerminal(row)) return true;
    // The retention window exceeds the rolling budget window. Keep budget evidence explicit
    // so a future retention reduction cannot over-grant the hourly run budgets.
    if (isRollingBudgetEvidence(row, now)) return true;
    const completedAt = row.completedAt ?? row.updatedAt;
    return now - completedAt < keepMs;
  });
  while (runs.length > LAB_AUTOMATION_HARD_MAX.maxPersistedRuns) {
    if (!evictOldestTerminal(runs, now)) {
      throw new LabAutomationError(
        "persisted run ceiling exceeded by non-disposable run records",
        "invalid_state",
      );
    }
  }
  return { ...state, runs };
}
