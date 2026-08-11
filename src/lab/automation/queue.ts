import { randomUUID } from "node:crypto";
import type {
  LabAutomationPolicyV1,
  LabAutomationRunRecordV1,
  LabAutomationRunState,
  LabAutomationStateV1,
  PlannedLabRunV1,
} from "./types";
import { LAB_AUTOMATION_HARD_MAX } from "./constants";

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
  for (const plan of planned) {
    if (existingActiveKeys.has(plan.runKey)) continue;
    if (runs.length >= LAB_AUTOMATION_HARD_MAX.maxPersistedRuns) break;
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
): LabAutomationRunRecordV1[] {
  const running = countRunsByState(state, "running");
  if (running >= policy.maxConcurrentRuns) return [];
  const slots = policy.maxConcurrentRuns - running;
  const queued = state.runs
    .filter((row) => row.state === "queued" && row.eligibleAt <= now)
    .sort((a, b) => {
      if (a.priority !== b.priority) return a.priority - b.priority;
      if (a.eligibleAt !== b.eligibleAt) return a.eligibleAt - b.eligibleAt;
      return a.runId < b.runId ? -1 : 1;
    });
  const selected: LabAutomationRunRecordV1[] = [];
  let liveRunning = countRunningLive(state);
  for (const row of queued) {
    if (selected.length >= slots) break;
    if (countRunsByState({ ...state, runs: [...state.runs, ...selected.map((s) => ({ ...s, state: "running" as const }))] }, "running") >= policy.maxConcurrentRuns) break;
    if (row.evidenceLayer === "live_route_compatibility") {
      if (liveRunning >= policy.maxConcurrentLiveRuns) continue;
      if (countRunningForRoute(state, row.subjectId) >= policy.maxConcurrentRunsPerRoute) continue;
    } else if (countRunningForRoute(state, row.subjectId) >= policy.maxConcurrentRunsPerRoute) {
      continue;
    }
    selected.push(row);
    if (row.evidenceLayer === "live_route_compatibility") liveRunning += 1;
  }
  return selected;
}

export function trimTerminalRuns(state: LabAutomationStateV1, now: number): LabAutomationStateV1 {
  const terminal = new Set<LabAutomationRunState>(["completed", "blocked", "failed", "cancelled", "abandoned"]);
  const keepMs = 7 * 24 * 60 * 60 * 1000;
  const runs = state.runs.filter((row) => {
    if (!terminal.has(row.state)) return true;
    const completedAt = row.completedAt ?? row.updatedAt;
    return now - completedAt < keepMs;
  });
  if (runs.length > LAB_AUTOMATION_HARD_MAX.maxPersistedRuns) {
    return { ...state, runs: runs.slice(-LAB_AUTOMATION_HARD_MAX.maxPersistedRuns) };
  }
  return { ...state, runs };
}
