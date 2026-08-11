import { readConfigDiagnostics } from "../../config";
import { planLabAutomationRuns } from "./planner";
import {
  loadLabAutomationPolicy,
  loadLabAutomationRoutes,
  loadLabAutomationState,
  mutateLabAutomationState,
} from "./persistence";
import {
  rollBudgetWindow,
  runBudgetRemaining,
  liveRequestBudgetRemaining,
  isRunBudgetExhausted,
  isLiveRequestBudgetExhausted,
} from "./budgets";
import { clearCooldown, cooldownForFailure, setCooldown } from "./cooldown";
import {
  enqueuePlannedRuns,
  selectDispatchableRuns,
  transitionRun,
  trimTerminalRuns,
  countRunsByState,
} from "./queue";
import { dispatchLabAutomationRun, type DispatchResult } from "./dispatch";
import { recoverLabAutomationState } from "./recovery";
import type {
  AutomationDispatchDeps,
  LabAutomationPolicyV1,
  LabAutomationRoutesV1,
  LabAutomationRunRecordV1,
  LabAutomationStatusV1,
} from "./types";
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
  const now = Date.now();
  const hourAgo = now - LAB_AUTOMATION_HARD_MAX.budgetWindowMs;
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
      remainingRunBudget: runBudgetRemaining(policy, state, now),
      remainingLiveRequestBudget: liveRequestBudgetRemaining(policy, state, now),
    },
    schedulerRunning: isLabAutomationSchedulerRunning(),
  };
}

function scheduledEligibilityCode(
  policy: LabAutomationPolicyV1,
  routes: LabAutomationRoutesV1,
  run: LabAutomationRunRecordV1,
): string | null {
  if (run.trigger !== "scheduled") return null;
  if (!policy.enabled) return "automation_disabled";
  switch (run.evidenceLayer) {
    case "protocol_conformance":
      return policy.layers.protocolConformance ? null : "layer_disabled";
    case "live_route_compatibility": {
      if (!policy.layers.liveRouteCompatibility) return "layer_disabled";
      if (!run.providerName || !run.modelId) return "route_ineligible";
      const enrolled = routes.routes.some((route) =>
        route.providerName === run.providerName && route.modelId === run.modelId
      );
      return enrolled ? null : "route_ineligible";
    }
    case "task_effectiveness":
      if (!policy.layers.taskEffectiveness) return "layer_disabled";
      return policy.taskEffectivenessBackgroundEnabled ? null : "task_background_disabled";
  }
}

function reconcileQueuedState(
  state: ReturnType<typeof loadLabAutomationState>,
  policy: LabAutomationPolicyV1,
  routes: LabAutomationRoutesV1,
  now: number,
): ReturnType<typeof loadLabAutomationState> {
  let next = state;
  for (const run of state.runs) {
    if (run.state !== "queued" || run.trigger !== "scheduled") continue;
    const code = scheduledEligibilityCode(policy, routes, run);
    if (code) next = transitionRun(next, run.runId, "cancelled", now, code);
  }
  return next;
}

/** Apply current policy/route enrollment to already queued scheduled work without executing it. */
export function reconcileLabAutomationQueue(configDir?: string): void {
  const policy = loadLabAutomationPolicy(configDir);
  const routes = loadLabAutomationRoutes(configDir);
  const now = Date.now();
  mutateLabAutomationState(configDir, (state) => ({
    state: trimTerminalRuns(reconcileQueuedState(state, policy, routes, now), now),
    value: undefined,
  }));
}

function loadPlannerConfig(): import("../../types").OcxConfig | undefined {
  try {
    return dispatchDeps.loadConfig?.() ?? readConfigDiagnostics().config;
  } catch {
    return undefined;
  }
}

function claimNextRun(
  policy: LabAutomationPolicyV1,
  routes: LabAutomationRoutesV1,
  planned: ReturnType<typeof planLabAutomationRuns>,
  enqueuePlan: boolean,
  configDir: string | undefined,
  now: number,
  manualRunId?: string,
): LabAutomationRunRecordV1 | null {
  return mutateLabAutomationState(configDir, (loaded) => {
    let state = rollBudgetWindow(loaded, now);
    if (policy.enabled && manualRunId === undefined && enqueuePlan) {
      state = enqueuePlannedRuns(state, planned, "scheduled", now);
    }
    // Policy/route checks must happen after enqueue as well: a plan can become stale between
    // the pure planning snapshot and this atomic state claim.
    state = reconcileQueuedState(state, policy, routes, now);
    if (isRunBudgetExhausted(policy, state, now)) {
      return { state: trimTerminalRuns(state, now), value: null };
    }
    const predicate = (run: LabAutomationRunRecordV1): boolean => {
      if (manualRunId !== undefined) return run.runId === manualRunId && run.trigger === "manual";
      return policy.enabled && run.trigger === "scheduled";
    };
    const dispatchable = selectDispatchableRuns(policy, state, now, (run) => {
      if (!predicate(run)) return false;
      if (run.evidenceLayer === "live_route_compatibility" && isLiveRequestBudgetExhausted(policy, state, now)) {
        return false;
      }
      return scheduledEligibilityCode(policy, routes, run) === null;
    });
    const selected = dispatchable[0];
    if (!selected) return { state: trimTerminalRuns(state, now), value: null };
    state = transitionRun(state, selected.runId, "running", now);
    const running = state.runs.find((run) => run.runId === selected.runId) ?? null;
    return { state: trimTerminalRuns(state, now), value: running };
  });
}

function finalizeRun(
  run: LabAutomationRunRecordV1,
  policy: LabAutomationPolicyV1,
  configDir: string | undefined,
  result: DispatchResult | null,
  error: unknown,
  cancelled: boolean,
): void {
  const completedAt = Date.now();
  mutateLabAutomationState(configDir, (state) => {
    const current = state.runs.find((row) => row.runId === run.runId);
    if (!current || current.state !== "running") {
      return { state: trimTerminalRuns(state, completedAt), value: undefined };
    }
    let next = state;
    if (cancelled || (error instanceof LabAutomationError && error.code === "cancelled")) {
      next = transitionRun(next, run.runId, "cancelled", completedAt, "cancelled");
      return { state: trimTerminalRuns(next, completedAt), value: undefined };
    }
    if (result) {
      next = transitionRun(next, run.runId, result.terminalState, completedAt, result.terminalCode);
      if (result.terminalState === "completed") {
        next = clearCooldown(next, run.runKey);
      } else {
        next = setCooldown(
          next,
          run.runKey,
          cooldownForFailure(policy, result.cooldownCode, completedAt),
        );
      }
      return { state: trimTerminalRuns(next, completedAt), value: undefined };
    }
    const terminalCode = error instanceof LabAutomationError ? error.code : "dispatch_failure";
    next = transitionRun(next, run.runId, "failed", completedAt, terminalCode);
    next = setCooldown(next, run.runKey, cooldownForFailure(policy, "harness_failure", completedAt));
    return { state: trimTerminalRuns(next, completedAt), value: undefined };
  });
}

async function runDispatchBatch(
  configDir?: string,
  options: { manualRunId?: string } = {},
): Promise<void> {
  if (shutdownRequested) return;
  const initialPolicy = loadLabAutomationPolicy(configDir);
  const initialRoutes = loadLabAutomationRoutes(configDir);
  const config = loadPlannerConfig();
  const snapshot = loadLabAutomationState(configDir);
  const planned = initialPolicy.enabled && options.manualRunId === undefined
    ? planLabAutomationRuns({
        policy: initialPolicy,
        routes: initialRoutes,
        state: snapshot,
        now: Date.now(),
        config,
        configDir,
      })
    : [];
  let enqueuePlan = true;
  const maxDispatches = options.manualRunId ? 1 : Math.max(1, initialPolicy.maxConcurrentRuns);
  for (let dispatched = 0; dispatched < maxDispatches; dispatched += 1) {
    if (shutdownRequested) break;
    // Re-read operational policy before every claim so disabling a layer/route stops the next
    // queued run immediately rather than after the whole batch.
    const policy = loadLabAutomationPolicy(configDir);
    const routes = loadLabAutomationRoutes(configDir);
    const run = claimNextRun(
      policy,
      routes,
      planned,
      enqueuePlan,
      configDir,
      Date.now(),
      options.manualRunId,
    );
    enqueuePlan = false;
    if (!run) break;
    const controller = new AbortController();
    inFlightControllers.set(run.runId, controller);
    let result: DispatchResult | null = null;
    let error: unknown;
    try {
      const deps: AutomationDispatchDeps = {
        ...dispatchDeps,
        configDir,
        loadConfig: dispatchDeps.loadConfig ?? (() => readConfigDiagnostics().config),
        abortSignal: controller.signal,
        enforceRunIdentity: true,
      };
      result = await dispatchLabAutomationRun(run, deps);
    } catch (caught) {
      error = caught;
    } finally {
      const cancelled = cancellingRunIds.has(run.runId) || controller.signal.aborted;
      finalizeRun(run, policy, configDir, result, error, cancelled);
      inFlightControllers.delete(run.runId);
      cancellingRunIds.delete(run.runId);
    }
    if (options.manualRunId !== undefined) break;
  }
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
  const routes = loadLabAutomationRoutes(configDir);
  const now = Date.now();
  mutateLabAutomationState(configDir, (state) => {
    let next = recoverLabAutomationState(policy, state, now);
    next = reconcileQueuedState(next, policy, routes, now);
    return { state: trimTerminalRuns(next, now), value: undefined };
  });
  schedulerTimer = setInterval(() => {
    void runLabAutomationTick(configDir);
  }, LAB_AUTOMATION_HARD_MAX.schedulerTickMs);
  schedulerTimer.unref?.();
}

/** Stop periodic scheduling only. Process shutdown is a separate explicit signal. */
export function stopLabAutomationScheduler(): void {
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
  const created = mutateLabAutomationState(configDir, (state) => {
    const next = enqueuePlannedRuns(state, [planned], "manual", now);
    const run = next.runs.find((row) =>
      row.runKey === planned.runKey && row.trigger === "manual" && row.state === "queued"
    ) ?? null;
    return { state: next, value: run };
  });
  if (!created) return null;
  // Manual execution is independent of automation enablement/layer toggles.
  await runDispatchBatch(configDir, { manualRunId: created.runId });
  return loadLabAutomationState(configDir).runs.find((row) => row.runId === created.runId) ?? created;
}

export function cancelLabAutomationRun(runId: string, configDir?: string): boolean {
  const controller = inFlightControllers.get(runId);
  if (controller) {
    cancellingRunIds.add(runId);
    controller.abort(new Error("cancelled"));
    return true;
  }
  return mutateLabAutomationState(configDir, (state) => {
    const run = state.runs.find((row) => row.runId === runId);
    if (!run || run.state !== "queued") return { state, value: false };
    return { state: cancelQueuedRun(state, runId, Date.now()), value: true };
  });
}
