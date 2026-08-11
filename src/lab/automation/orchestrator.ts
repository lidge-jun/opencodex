import { readConfigDiagnostics } from "../../config";
import { planLabAutomationRuns } from "./planner";
import {
  loadLabAutomationPolicy,
  loadLabAutomationRoutes,
  loadLabAutomationState,
  saveLabAutomationState,
} from "./persistence";
import { rollBudgetWindow, recordRunBudgetUse, runBudgetRemaining, liveRequestBudgetRemaining, isRunBudgetExhausted, isLiveRequestBudgetExhausted } from "./budgets";
import { cooldownForFailure, setCooldown } from "./cooldown";
import {
  enqueuePlannedRuns,
  selectDispatchableRuns,
  transitionRun,
  trimTerminalRuns,
  countRunsByState,
} from "./queue";
import { dispatchLabAutomationRun, type DispatchResult } from "./dispatch";
import { recoverLabAutomationState } from "./recovery";
import type { AutomationDispatchDeps, LabAutomationRunRecordV1, LabAutomationStatusV1 } from "./types";
import { LabAutomationError } from "./types";
import { LAB_AUTOMATION_HARD_MAX } from "./constants";
import { cancelQueuedRun } from "./queue";

let schedulerTimer: ReturnType<typeof setInterval> | null = null;
let tickInProgress = false;
let shutdownRequested = false;
let dispatchDeps: AutomationDispatchDeps = {};
const inFlightControllers = new Map<string, AbortController>();
const cancellingRunIds = new Set<string>();

export function setLabAutomationDispatchDeps(deps: AutomationDispatchDeps): void {
  dispatchDeps = deps;
}

export function isLabAutomationSchedulerRunning(): boolean {
  return schedulerTimer !== null;
}

export function requestLabAutomationShutdown(): void {
  shutdownRequested = true;
  for (const controller of inFlightControllers.values()) {
    controller.abort(new Error("cancelled"));
  }
}

export function buildLabAutomationStatus(configDir?: string): LabAutomationStatusV1 {
  const policy = loadLabAutomationPolicy(configDir);
  const routes = loadLabAutomationRoutes(configDir);
  const state = loadLabAutomationState(configDir);
  const hourAgo = Date.now() - LAB_AUTOMATION_HARD_MAX.budgetWindowMs;
  const completedLastHour = state.runs.filter((row) => row.state === "completed" && (row.completedAt ?? 0) >= hourAgo).length;
  const blockedLastHour = state.runs.filter((row) => row.state === "blocked" && (row.completedAt ?? 0) >= hourAgo).length;
  return {
    policy,
    routes,
    counters: {
      queued: countRunsByState(state, "queued"),
      running: countRunsByState(state, "running"),
      completedLastHour,
      blockedLastHour,
      remainingRunBudget: runBudgetRemaining(policy, state),
      remainingLiveRequestBudget: liveRequestBudgetRemaining(policy, state),
    },
    schedulerRunning: isLabAutomationSchedulerRunning(),
  };
}

async function runDispatchBatch(configDir?: string, now = Date.now()): Promise<void> {
  if (shutdownRequested) return;
  const policy = loadLabAutomationPolicy(configDir);
  if (!policy.enabled) return;
  let state = rollBudgetWindow(loadLabAutomationState(configDir), now);
  const routes = loadLabAutomationRoutes(configDir);
  let config: import("../../types").OcxConfig | undefined;
  try {
    config = readConfigDiagnostics().config;
  } catch {
    config = undefined;
  }
  const planned = planLabAutomationRuns({
    policy,
    routes,
    state,
    now,
    config,
    configDir,
  });
  state = enqueuePlannedRuns(state, planned, "scheduled", now);
  const dispatchable = selectDispatchableRuns(policy, state, now);
  for (const run of dispatchable) {
    if (shutdownRequested) break;
    if (isRunBudgetExhausted(policy, state)) break;
    if (run.evidenceLayer === "live_route_compatibility" && isLiveRequestBudgetExhausted(policy, state)) {
      continue;
    }
    state = transitionRun(state, run.runId, "running", now);
    saveLabAutomationState(state, configDir);
    const controller = new AbortController();
    inFlightControllers.set(run.runId, controller);
    try {
      const deps: AutomationDispatchDeps = {
        ...dispatchDeps,
        configDir,
        loadConfig: dispatchDeps.loadConfig ?? (() => readConfigDiagnostics().config),
        abortSignal: controller.signal,
      };
      const result: DispatchResult = await dispatchLabAutomationRun(run, deps);
      if (cancellingRunIds.has(run.runId) || controller.signal.aborted) {
        state = transitionRun(state, run.runId, "cancelled", Date.now(), "cancelled");
      } else {
        state = recordRunBudgetUse(state, result.liveRequest);
        state = transitionRun(state, run.runId, result.terminalState, Date.now(), result.terminalCode);
        if (result.terminalState !== "completed") {
          state = setCooldown(
            state,
            run.runKey,
            cooldownForFailure(policy, result.terminalCode, Date.now()),
          );
        }
      }
    } catch (error) {
      if (cancellingRunIds.has(run.runId) || (error instanceof LabAutomationError && error.code === "cancelled")) {
        state = transitionRun(state, run.runId, "cancelled", Date.now(), "cancelled");
      } else {
        const code = error instanceof Error ? error.message : "dispatch_failure";
        state = transitionRun(state, run.runId, "failed", Date.now(), code);
        state = setCooldown(state, run.runKey, cooldownForFailure(policy, "harness_failure", Date.now()));
      }
    } finally {
      inFlightControllers.delete(run.runId);
      cancellingRunIds.delete(run.runId);
    }
    state = trimTerminalRuns(state, Date.now());
    saveLabAutomationState(state, configDir);
  }
  saveLabAutomationState(trimTerminalRuns(state, now), configDir);
}

/** Single bounded scheduler tick — plan, enqueue, dispatch within concurrency limits. */
export async function runLabAutomationTick(configDir?: string): Promise<void> {
  if (tickInProgress) return;
  tickInProgress = true;
  try {
    await runDispatchBatch(configDir);
  } finally {
    tickInProgress = false;
  }
}

export function startLabAutomationScheduler(configDir?: string): void {
  if (schedulerTimer) return;
  shutdownRequested = false;
  const policy = loadLabAutomationPolicy(configDir);
  let state = loadLabAutomationState(configDir);
  state = recoverLabAutomationState(policy, state, Date.now());
  saveLabAutomationState(state, configDir);
  schedulerTimer = setInterval(() => {
    void runLabAutomationTick(configDir);
  }, LAB_AUTOMATION_HARD_MAX.schedulerTickMs);
  schedulerTimer.unref?.();
}

export function stopLabAutomationScheduler(): void {
  shutdownRequested = true;
  if (schedulerTimer) {
    clearInterval(schedulerTimer);
    schedulerTimer = null;
  }
}

/** Test-only reset of scheduler globals between isolated automation tests. */
export function resetLabAutomationSchedulerStateForTests(): void {
  shutdownRequested = false;
  tickInProgress = false;
  inFlightControllers.clear();
  cancellingRunIds.clear();
}

export async function enqueueManualLabRun(
  planned: import("./types").PlannedLabRunV1,
  configDir?: string,
): Promise<LabAutomationRunRecordV1 | null> {
  const now = Date.now();
  let state = loadLabAutomationState(configDir);
  state = enqueuePlannedRuns(state, [planned], "manual", now);
  saveLabAutomationState(state, configDir);
  const created = state.runs.find((row) => row.runKey === planned.runKey && row.trigger === "manual");
  if (!created) return null;
  await runLabAutomationTick(configDir);
  return loadLabAutomationState(configDir).runs.find((row) => row.runId === created.runId) ?? created;
}

export function cancelLabAutomationRun(runId: string, configDir?: string): boolean {
  const state = loadLabAutomationState(configDir);
  const run = state.runs.find((row) => row.runId === runId);
  if (!run) return false;
  if (run.state === "queued") {
    saveLabAutomationState(cancelQueuedRun(state, runId, Date.now()), configDir);
    return true;
  }
  if (run.state === "running") {
    cancellingRunIds.add(runId);
    const controller = inFlightControllers.get(runId);
    if (controller) controller.abort(new Error("cancelled"));
    return true;
  }
  return false;
}
