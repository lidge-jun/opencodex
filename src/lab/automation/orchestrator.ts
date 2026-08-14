import { readConfigDiagnostics } from "../../config";
import { registerCurrentServerResourceCleanup } from "../../lib/server-resource-ownership";
import { registerOptionalShutdownHook } from "../../lib/optional-shutdown-hooks";
import { queryLabStatus } from "../query";
import { rebuildLabProjection } from "../projection/rebuild";
import { planLabAutomationRuns } from "./planner";
import {
  loadLabAutomationState,
  mutateLabAutomationState,
} from "./persistence";
import { loadLabAutomationConfig } from "./config-persistence";
import {
  rollBudgetWindow,
  runBudgetRemaining,
  liveRequestBudgetRemaining,
  isRunBudgetExhausted,
  isLiveRequestBudgetExhausted,
} from "./budgets";
import {
  canReserveScheduledCooldown,
  clearCooldown,
  cooldownForFailure,
  setCooldown,
} from "./cooldown";
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

type SchedulerOwner = {
  timer: ReturnType<typeof setInterval>;
  ownerToken: symbol;
};

type DispatchOwner = {
  token: symbol;
  deps: AutomationDispatchDeps;
};

const schedulerTimers = new Map<string, SchedulerOwner>();
const ticksInProgress = new Set<string>();
let shutdownRequested = false;
const dispatchDepsByConfigDir = new Map<string, DispatchOwner>();
const inFlightControllers = new Map<string, AbortController>();
const cancellingRunIds = new Set<string>();

function configKey(configDir?: string): string {
  return configDir ?? "";
}

function dispatchDepsFor(configDir?: string): AutomationDispatchDeps {
  return dispatchDepsByConfigDir.get(configKey(configDir))?.deps ?? {};
}

function cancellationCooldownUntil(policy: LabAutomationPolicyV1, now: number): number {
  return now + Math.max(policy.failureCooldownMs, LAB_AUTOMATION_HARD_MAX.schedulerTickMs);
}

/**
 * Register process-local dispatch authority for one runtime owner.
 *
 * The returned receipt releases only the authority that this call installed. If a same-root
 * successor has already replaced it, releasing the predecessor is a no-op for the successor.
 */
export function setLabAutomationDispatchDeps(deps: AutomationDispatchDeps): () => void {
  const key = configKey(deps.configDir);
  if (Object.keys(deps).length === 0) {
    dispatchDepsByConfigDir.delete(key);
    return () => {};
  }

  const token = Symbol("lab-automation-runtime-owner");
  dispatchDepsByConfigDir.set(key, { token, deps });
  const existingScheduler = schedulerTimers.get(key);
  if (existingScheduler) existingScheduler.ownerToken = token;

  let released = false;
  let detachServerCleanup = () => {};
  let detachShutdownHook = () => {};
  const release = () => {
    if (released) return;
    released = true;
    detachServerCleanup();
    detachShutdownHook();
    const current = dispatchDepsByConfigDir.get(key);
    if (current?.token !== token) return;
    dispatchDepsByConfigDir.delete(key);
    const scheduler = schedulerTimers.get(key);
    if (scheduler?.ownerToken === token) {
      clearInterval(scheduler.timer);
      schedulerTimers.delete(key);
    }
  };
  detachServerCleanup = registerCurrentServerResourceCleanup(release);
  // Shutdown teardown is registered here, at activation, so `server/lifecycle.ts` never has
  // to import Lab in order to stop it. Scoped to this configDir, unlike the previous
  // unscoped call from the shutdown path.
  detachShutdownHook = registerOptionalShutdownHook(`lab-automation:${key}`, () => {
    requestLabAutomationShutdown();
    stopLabAutomationScheduler(deps.configDir);
  });
  return release;
}

export function isLabAutomationSchedulerRunning(configDir?: string): boolean {
  return schedulerTimers.has(configKey(configDir));
}

export function requestLabAutomationShutdown(): void {
  shutdownRequested = true;
  for (const controller of inFlightControllers.values()) {
    controller.abort(new Error("cancelled"));
  }
}

export function buildLabAutomationStatus(configDir?: string): LabAutomationStatusV1 {
  const { policy, routes } = loadLabAutomationConfig(configDir);
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
    schedulerRunning: isLabAutomationSchedulerRunning(configDir),
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
  const { policy, routes } = loadLabAutomationConfig(configDir);
  const now = Date.now();
  mutateLabAutomationState(configDir, (state) => ({
    state: trimTerminalRuns(reconcileQueuedState(state, policy, routes, now), now),
    value: undefined,
  }));
}

function loadPlannerConfig(configDir?: string): import("../../types").OcxConfig | undefined {
  const runtimeDeps = dispatchDepsFor(configDir);
  try {
    return runtimeDeps.loadConfig?.() ?? readConfigDiagnostics().config;
  } catch {
    return undefined;
  }
}

/**
 * Scheduled planning is projection-backed. Rebuild once when the disposable SQLite projection
 * is missing/incompatible; if replay/rebuild cannot establish a readable projection, fail closed
 * instead of treating every scenario as missing and generating provider traffic.
 */
function ensureAutomationProjection(configDir?: string): boolean {
  const status = queryLabStatus(configDir);
  if (status.projectionAvailable) return true;
  try {
    rebuildLabProjection(configDir);
  } catch {
    return false;
  }
  return queryLabStatus(configDir).projectionAvailable;
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
      if (run.trigger === "scheduled" && !canReserveScheduledCooldown(state, run.runKey, now)) {
        return false;
      }
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
      if (run.trigger === "scheduled") {
        next = setCooldown(
          next,
          run.runKey,
          cancellationCooldownUntil(policy, completedAt),
          completedAt,
        );
      }
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
          completedAt,
        );
      }
      return { state: trimTerminalRuns(next, completedAt), value: undefined };
    }
    const terminalCode = error instanceof LabAutomationError ? error.code : "dispatch_failure";
    next = transitionRun(next, run.runId, "failed", completedAt, terminalCode);
    next = setCooldown(
      next,
      run.runKey,
      cooldownForFailure(policy, "harness_failure", completedAt),
      completedAt,
    );
    return { state: trimTerminalRuns(next, completedAt), value: undefined };
  });
}

async function runDispatchBatch(
  configDir?: string,
  options: { manualRunId?: string; abortSignal?: AbortSignal } = {},
): Promise<void> {
  if (shutdownRequested) return;
  const initialConfig = loadLabAutomationConfig(configDir);
  const initialPolicy = initialConfig.policy;
  const initialRoutes = initialConfig.routes;
  if (initialPolicy.enabled && options.manualRunId === undefined && !ensureAutomationProjection(configDir)) {
    reconcileLabAutomationQueue(configDir);
    return;
  }
  const config = loadPlannerConfig(configDir);
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
  // Dispatch is intentionally sequential inside one tick. The concurrency fields still bound
  // atomic selection against already-running work and future parallel workers/processes.
  const maxDispatches = options.manualRunId ? 1 : Math.max(1, initialPolicy.maxConcurrentRuns);
  for (let dispatched = 0; dispatched < maxDispatches; dispatched += 1) {
    if (shutdownRequested) break;
    const { policy, routes } = loadLabAutomationConfig(configDir);
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
    const abortFromCaller = () => controller.abort(options.abortSignal?.reason ?? new Error("cancelled"));
    if (options.abortSignal?.aborted) abortFromCaller();
    else options.abortSignal?.addEventListener("abort", abortFromCaller, { once: true });
    inFlightControllers.set(run.runId, controller);
    let result: DispatchResult | null = null;
    let error: unknown;
    try {
      const runtimeDeps = dispatchDepsFor(configDir);
      const deps: AutomationDispatchDeps = {
        ...runtimeDeps,
        configDir,
        loadConfig: runtimeDeps.loadConfig ?? (() => readConfigDiagnostics().config),
        abortSignal: controller.signal,
        enforceRunIdentity: true,
      };
      result = await dispatchLabAutomationRun(run, deps);
    } catch (caught) {
      error = caught;
    } finally {
      options.abortSignal?.removeEventListener("abort", abortFromCaller);
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
  const key = configKey(configDir);
  if (ticksInProgress.has(key)) return;
  ticksInProgress.add(key);
  try {
    await runDispatchBatch(configDir);
  } finally {
    ticksInProgress.delete(key);
  }
}

export function startLabAutomationScheduler(configDir?: string): void {
  const key = configKey(configDir);
  const currentOwner = dispatchDepsByConfigDir.get(key)?.token;
  const existing = schedulerTimers.get(key);
  if (existing) {
    if (currentOwner) existing.ownerToken = currentOwner;
    return;
  }
  // The scheduler owns a live interval, so its teardown must be registered here rather
  // than only in setLabAutomationDispatchDeps: the management API and the CLI can start a
  // scheduler without ever installing dispatch deps (lab-automation-routes.ts
  // applySchedulerPolicy, cli/lab.ts), and core no longer imports this module to stop it.
  // Without this registration such a scheduler survives drainAndShutdown.
  registerOptionalShutdownHook(`lab-automation-scheduler:${key}`, () => {
    requestLabAutomationShutdown();
    stopLabAutomationScheduler(configDir);
  });
  shutdownRequested = false;
  const { policy, routes } = loadLabAutomationConfig(configDir);
  const now = Date.now();
  mutateLabAutomationState(configDir, (state) => {
    let next = recoverLabAutomationState(policy, state, now);
    next = reconcileQueuedState(next, policy, routes, now);
    return { state: trimTerminalRuns(next, now), value: undefined };
  });
  const timer = setInterval(() => {
    void runLabAutomationTick(configDir);
  }, LAB_AUTOMATION_HARD_MAX.schedulerTickMs);
  timer.unref?.();
  schedulerTimers.set(key, {
    timer,
    ownerToken: currentOwner ?? Symbol("lab-automation-manual-scheduler"),
  });
}

/** Stop periodic scheduling only. Process shutdown is a separate explicit signal. */
export function stopLabAutomationScheduler(configDir?: string): void {
  if (configDir !== undefined) {
    const key = configKey(configDir);
    const scheduler = schedulerTimers.get(key);
    if (scheduler) clearInterval(scheduler.timer);
    schedulerTimers.delete(key);
    return;
  }
  for (const scheduler of schedulerTimers.values()) clearInterval(scheduler.timer);
  schedulerTimers.clear();
}

/** Test-only reset of scheduler globals between isolated automation tests. */
export function resetLabAutomationSchedulerStateForTests(): void {
  stopLabAutomationScheduler();
  shutdownRequested = false;
  ticksInProgress.clear();
  dispatchDepsByConfigDir.clear();
  inFlightControllers.clear();
  cancellingRunIds.clear();
}

export async function enqueueManualLabRun(
  planned: import("./types").PlannedLabRunV1,
  configDir?: string,
  abortSignal?: AbortSignal,
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
  await runDispatchBatch(configDir, { manualRunId: created.runId, abortSignal });
  return loadLabAutomationState(configDir).runs.find((row) => row.runId === created.runId) ?? created;
}

export function cancelLabAutomationRun(runId: string, configDir?: string): boolean {
  const controller = inFlightControllers.get(runId);
  if (controller) {
    cancellingRunIds.add(runId);
    controller.abort(new Error("cancelled"));
    return true;
  }
  const policy = loadLabAutomationConfig(configDir).policy;
  const now = Date.now();
  return mutateLabAutomationState(configDir, (state) => {
    const run = state.runs.find((row) => row.runId === runId);
    if (!run || run.state !== "queued") return { state, value: false };
    let next = cancelQueuedRun(state, runId, now);
    if (run.trigger === "scheduled") {
      next = setCooldown(next, run.runKey, cancellationCooldownUntil(policy, now), now);
    }
    return { state: next, value: true };
  });
}