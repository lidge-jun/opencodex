import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { OcxConfig } from "../src/types";
import { defaultLabAutomationPolicyV1, normalizeLabAutomationPolicyV1 } from "../src/lab/automation/policy";
import {
  defaultLabAutomationStateV1,
  loadLabAutomationState,
  saveLabAutomationPolicy,
  saveLabAutomationRoutes,
  saveLabAutomationState,
} from "../src/lab/automation/persistence";
import { planLabAutomationRuns, planManualLabRun } from "../src/lab/automation/planner";
import { enqueuePlannedRuns } from "../src/lab/automation/queue";
import { rollBudgetWindow, runBudgetRemaining } from "../src/lab/automation/budgets";
import {
  enqueueManualLabRun,
  requestLabAutomationShutdown,
  resetLabAutomationSchedulerStateForTests,
  runLabAutomationTick,
  setLabAutomationDispatchDeps,
  stopLabAutomationScheduler,
} from "../src/lab/automation/orchestrator";
import { dispatchLabAutomationRun } from "../src/lab/automation/dispatch";
import type {
  LabAutomationRunRecordV1,
  LabAutomationStateV1,
  PlannedLabRunV1,
} from "../src/lab/automation/types";
import { LabAutomationError } from "../src/lab/automation/types";
import { LAB_AUTOMATION_HARD_MAX } from "../src/lab/automation/constants";
import { createHostIssuedLabRouteExecutor } from "../src/lib/lab-live-host";
import { readInstallationSalt } from "../src/lab/subject/installation-salt";
import type { NormalizedObservation } from "../src/lab/conformance/types";
import {
  resetCompatibilityVersionCacheForTests,
  setCompatibilityVersionOverrideForTests,
} from "../src/routing/compatibility/version";

const COMPAT_VERSION = "e".repeat(64);
const HOMES: string[] = [];

function tempHome(): string {
  const dir = join(tmpdir(), `ocx-lab-cl08-review-${process.pid}-${Math.random().toString(16).slice(2)}`);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  HOMES.push(dir);
  return dir;
}

function prepareHome(home: string): void {
  process.env.OPENCODEX_HOME = home;
  readInstallationSalt(home);
  setCompatibilityVersionOverrideForTests(COMPAT_VERSION);
}

function fixtureDnsResolve() {
  return async () => [{ address: "93.184.216.34", family: 4 as const }];
}

function providerConfig(baseUrl = "https://api.example.com/v1", providerName = "fixture-provider"): OcxConfig {
  return {
    providers: {
      [providerName]: {
        adapter: "openai-responses",
        baseUrl,
        apiKey: "sk-fixture-test-key",
        models: ["fixture-model"],
        defaultModel: "fixture-model",
      },
    },
  } as OcxConfig;
}

function twoRouteConfig(): OcxConfig {
  return {
    providers: {
      "route-a": {
        adapter: "openai-responses",
        baseUrl: "https://a.example.com/v1",
        apiKey: "sk-fixture-a",
        models: ["fixture-model"],
        defaultModel: "fixture-model",
      },
      "route-b": {
        adapter: "openai-responses",
        baseUrl: "https://b.example.com/v1",
        apiKey: "sk-fixture-b",
        models: ["fixture-model"],
        defaultModel: "fixture-model",
      },
    },
  } as OcxConfig;
}

function passObservation(): NormalizedObservation {
  return {
    client: {
      request: { status: 200, headers: {}, json: {}, rawBytes: 0 },
      response: {
        status: 200,
        headers: {},
        json: { status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: "OK" }] }] },
        events: [],
        toolCalls: [],
        mcpCalls: [],
        terminal: "completed",
        normalizedText: "OK",
      },
    },
    upstream: { requests: [], responses: [] },
    process: { exitCode: null },
    verifiers: {},
  };
}

function recordFor(plan: PlannedLabRunV1, trigger: "scheduled" | "manual" = "scheduled"): LabAutomationRunRecordV1 {
  const now = Date.now();
  return {
    ...plan,
    runId: `review-${Math.random().toString(16).slice(2)}`,
    state: "queued",
    trigger,
    createdAt: now,
    updatedAt: now,
  };
}

function livePolicy() {
  return {
    ...defaultLabAutomationPolicyV1(),
    enabled: true,
    layers: {
      protocolConformance: false,
      liveRouteCompatibility: true,
      taskEffectiveness: false,
    },
    maxConcurrentRuns: 2,
    maxConcurrentLiveRuns: 1,
    maxConcurrentRunsPerRoute: 1,
    maxRunsPerHour: 20,
    maxLiveRequestsPerHour: 10,
    failureCooldownMs: 1_000,
    blockedCooldownMs: 60_000,
  };
}

afterEach(() => {
  requestLabAutomationShutdown();
  stopLabAutomationScheduler();
  resetLabAutomationSchedulerStateForTests();
  setLabAutomationDispatchDeps({});
  resetCompatibilityVersionCacheForTests();
  delete process.env.OPENCODEX_HOME;
  for (const dir of HOMES.splice(0)) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

describe("CL-08 independent review regressions", () => {
  test("freshness is scoped to the exact route subject", async () => {
    const home = tempHome();
    prepareHome(home);
    const config = twoRouteConfig();
    const scenarioId = "responses-core.live.basic-turn";
    const executor = createHostIssuedLabRouteExecutor(async () => passObservation());
    const routeAPlan = planManualLabRun({
      evidenceLayer: "live_route_compatibility",
      scenarioId,
      providerName: "route-a",
      modelId: "fixture-model",
      config,
      configDir: home,
    });
    const routeAResult = await dispatchLabAutomationRun(
      { ...recordFor(routeAPlan, "manual"), state: "running" },
      { configDir: home, loadConfig: () => config, routeExecutor: executor, resolve: fixtureDnsResolve() },
    );
    expect(routeAResult.terminalState).toBe("completed");

    const planned = planLabAutomationRuns({
      policy: livePolicy(),
      routes: {
        schemaVersion: 1,
        routes: [
          { providerName: "route-a", modelId: "fixture-model" },
          { providerName: "route-b", modelId: "fixture-model" },
        ],
      },
      state: defaultLabAutomationStateV1(),
      now: Date.now(),
      config,
      configDir: home,
    });
    expect(planned.some((row) => row.scenarioId === scenarioId && row.providerName === "route-a")).toBe(false);
    expect(planned.some((row) => row.scenarioId === scenarioId && row.providerName === "route-b")).toBe(true);
  });

  test("dispatch rejects a queued live run whose exact route contract changed", async () => {
    const home = tempHome();
    prepareHome(home);
    const original = providerConfig("https://api.example.com/v1");
    const changed = providerConfig("https://changed.example.com/v1");
    const plan = planManualLabRun({
      evidenceLayer: "live_route_compatibility",
      scenarioId: "responses-core.live.basic-turn",
      providerName: "fixture-provider",
      modelId: "fixture-model",
      config: original,
      configDir: home,
    });
    let invokes = 0;
    const executor = createHostIssuedLabRouteExecutor(async () => {
      invokes += 1;
      return passObservation();
    });
    const result = await dispatchLabAutomationRun(
      { ...recordFor(plan), state: "running" },
      { configDir: home, loadConfig: () => changed, routeExecutor: executor, resolve: fixtureDnsResolve() },
    );
    expect(invokes).toBe(0);
    expect(result.terminalState).toBe("blocked");
    expect(result.terminalCode).toBe("run_contract_changed");
    expect(result.liveRequest).toBe(false);
  });

  test("manual protocol run executes while automation is disabled", async () => {
    const home = tempHome();
    prepareHome(home);
    saveLabAutomationPolicy(defaultLabAutomationPolicyV1(), home);
    const plan = planManualLabRun({
      evidenceLayer: "protocol_conformance",
      scenarioId: "responses-core.protocol.request-shape",
      configDir: home,
    });
    const result = await enqueueManualLabRun(plan, home);
    expect(result).not.toBeNull();
    expect(result?.state).not.toBe("queued");
    expect(result?.state).not.toBe("running");
  });

  test("disabling the live layer cancels previously queued scheduled live work", async () => {
    const home = tempHome();
    prepareHome(home);
    const config = providerConfig();
    const plan = planManualLabRun({
      evidenceLayer: "live_route_compatibility",
      scenarioId: "responses-core.live.basic-turn",
      providerName: "fixture-provider",
      modelId: "fixture-model",
      config,
      configDir: home,
    });
    let state = defaultLabAutomationStateV1();
    state = enqueuePlannedRuns(state, [plan], "scheduled", Date.now());
    saveLabAutomationState(state, home);
    saveLabAutomationPolicy({
      ...livePolicy(),
      layers: { protocolConformance: true, liveRouteCompatibility: false, taskEffectiveness: false },
    }, home);
    saveLabAutomationRoutes({
      schemaVersion: 1,
      routes: [{ providerName: "fixture-provider", modelId: "fixture-model" }],
    }, home);
    let invokes = 0;
    setLabAutomationDispatchDeps({
      configDir: home,
      loadConfig: () => config,
      resolve: fixtureDnsResolve(),
      routeExecutor: createHostIssuedLabRouteExecutor(async () => {
        invokes += 1;
        return passObservation();
      }),
    });
    await runLabAutomationTick(home);
    const stored = loadLabAutomationState(home).runs.find((row) => row.runKey === plan.runKey);
    expect(invokes).toBe(0);
    expect(stored?.state).toBe("cancelled");
    expect(stored?.terminalCode).toBe("layer_disabled");
  });

  test("queue saturation evicts terminal history and never exceeds queued-run ceiling", () => {
    const now = Date.now();
    const terminalRuns: LabAutomationRunRecordV1[] = Array.from({ length: LAB_AUTOMATION_HARD_MAX.maxPersistedRuns }, (_, index) => ({
      runId: `old-${index}`,
      runKey: `old-key-${index}`,
      state: "completed",
      evidenceLayer: "protocol_conformance",
      suiteId: "responses-core",
      suiteVersion: "1",
      suiteManifestDigest: "digest",
      scenarioId: `old-${index}`,
      scenarioVersion: "1",
      scenarioManifestDigest: "digest",
      subjectId: "subject",
      reason: "missing",
      priority: 0,
      eligibleAt: now,
      trigger: "scheduled",
      createdAt: now - 100_000 - index,
      updatedAt: now - 100_000 - index,
      completedAt: now - 100_000 - index,
    }));
    const base: LabAutomationStateV1 = {
      ...defaultLabAutomationStateV1(now),
      runs: terminalRuns,
    };
    const plan: PlannedLabRunV1 = {
      runKey: "new-key",
      evidenceLayer: "protocol_conformance",
      suiteId: "responses-core",
      suiteVersion: "1",
      suiteManifestDigest: "digest-new",
      scenarioId: "new-scenario",
      scenarioVersion: "1",
      scenarioManifestDigest: "digest-new",
      subjectId: "new-subject",
      reason: "missing",
      priority: 0,
      eligibleAt: now,
    };
    const withNew = enqueuePlannedRuns(base, [plan], "scheduled", now);
    expect(withNew.runs.some((row) => row.runKey === "new-key" && row.state === "queued")).toBe(true);
    expect(withNew.runs.length).toBeLessThanOrEqual(LAB_AUTOMATION_HARD_MAX.maxPersistedRuns);

    let queued = defaultLabAutomationStateV1(now);
    for (let index = 0; index < LAB_AUTOMATION_HARD_MAX.maxQueuedRuns + 10; index += 1) {
      queued = enqueuePlannedRuns(queued, [{ ...plan, runKey: `queued-${index}`, scenarioId: `scenario-${index}` }], "scheduled", now);
    }
    expect(queued.runs.filter((row) => row.state === "queued").length).toBe(LAB_AUTOMATION_HARD_MAX.maxQueuedRuns);
  });

  test("policy, route, and state persistence reject unknown or unsafe fields", () => {
    const home = tempHome();
    prepareHome(home);
    expect(() => normalizeLabAutomationPolicyV1({
      ...defaultLabAutomationPolicyV1(),
      unexpected: true,
    })).toThrow(LabAutomationError);
    expect(() => normalizeLabAutomationPolicyV1({
      ...defaultLabAutomationPolicyV1(),
      layers: { ...defaultLabAutomationPolicyV1().layers, unexpected: true },
    })).toThrow(LabAutomationError);
    expect(() => saveLabAutomationRoutes({
      schemaVersion: 1,
      routes: [{ providerName: "fixture-provider", modelId: "fixture-model", baseUrl: "https://should-not-persist.example" } as never],
    }, home)).toThrow(LabAutomationError);
    expect(() => saveLabAutomationState({
      ...defaultLabAutomationStateV1(),
      runsThisHour: -1,
    }, home)).toThrow(LabAutomationError);
  });

  test("trusted live cancellation cannot persist compatibility evidence", async () => {
    const home = tempHome();
    prepareHome(home);
    const config = providerConfig();
    const plan = planManualLabRun({
      evidenceLayer: "live_route_compatibility",
      scenarioId: "responses-core.live.basic-turn",
      providerName: "fixture-provider",
      modelId: "fixture-model",
      config,
      configDir: home,
    });
    const controller = new AbortController();
    const executor = createHostIssuedLabRouteExecutor(async () => {
      controller.abort(new Error("cancelled"));
      await Promise.resolve();
      return passObservation();
    });
    await expect(dispatchLabAutomationRun(
      { ...recordFor(plan, "manual"), state: "running" },
      {
        configDir: home,
        loadConfig: () => config,
        routeExecutor: executor,
        resolve: fixtureDnsResolve(),
        abortSignal: controller.signal,
      },
    )).rejects.toThrow(LabAutomationError);
    expect(existsSync(join(home, "lab", "ledger"))).toBe(false);
  });

  test("rolling run budget retains attempts from the trailing hour after the old window boundary", () => {
    const now = Date.now();
    const policy = { ...defaultLabAutomationPolicyV1(), maxRunsPerHour: 5 };
    const run = (id: string, startedAt: number): LabAutomationRunRecordV1 => ({
      runId: id,
      runKey: id,
      state: "completed",
      evidenceLayer: "protocol_conformance",
      suiteId: "responses-core",
      suiteVersion: "1",
      suiteManifestDigest: "digest",
      scenarioId: id,
      scenarioVersion: "1",
      scenarioManifestDigest: "digest",
      subjectId: "subject",
      reason: "missing",
      priority: 0,
      eligibleAt: startedAt,
      trigger: "scheduled",
      createdAt: startedAt,
      updatedAt: startedAt,
      startedAt,
      completedAt: startedAt,
    });
    const state: LabAutomationStateV1 = {
      ...defaultLabAutomationStateV1(now - 70 * 60_000),
      runs: [run("old", now - 70 * 60_000), run("recent", now - 30 * 60_000)],
      runsThisHour: 2,
    };
    const rolled = rollBudgetWindow(state, now);
    expect(runBudgetRemaining(policy, rolled, now)).toBe(4);
  });

  test("harness failures receive the stronger blocked cooldown and successful runs clear stale cooldown", async () => {
    const home = tempHome();
    prepareHome(home);
    const config = providerConfig();
    const policy = livePolicy();
    saveLabAutomationPolicy(policy, home);
    saveLabAutomationRoutes({ schemaVersion: 1, routes: [{ providerName: "fixture-provider", modelId: "fixture-model" }] }, home);
    const plan = planManualLabRun({
      evidenceLayer: "live_route_compatibility",
      scenarioId: "responses-core.live.basic-turn",
      providerName: "fixture-provider",
      modelId: "fixture-model",
      config,
      configDir: home,
    });
    let state = enqueuePlannedRuns(defaultLabAutomationStateV1(), [plan], "scheduled", Date.now());
    saveLabAutomationState(state, home);
    setLabAutomationDispatchDeps({
      configDir: home,
      loadConfig: () => config,
      resolve: fixtureDnsResolve(),
      routeExecutor: createHostIssuedLabRouteExecutor(async () => { throw new Error("executor exploded"); }),
    });
    const before = Date.now();
    await runLabAutomationTick(home);
    state = loadLabAutomationState(home);
    expect(state.cooldownUntilByKey[plan.runKey]).toBeGreaterThanOrEqual(before + policy.blockedCooldownMs - 1_000);

    state.runs = [];
    state.cooldownUntilByKey[plan.runKey] = Date.now() - 1;
    saveLabAutomationState(state, home);
    setLabAutomationDispatchDeps({
      configDir: home,
      loadConfig: () => config,
      resolve: fixtureDnsResolve(),
      routeExecutor: createHostIssuedLabRouteExecutor(async () => passObservation()),
    });
    state = enqueuePlannedRuns(loadLabAutomationState(home), [plan], "scheduled", Date.now());
    saveLabAutomationState(state, home);
    await runLabAutomationTick(home);
    expect(loadLabAutomationState(home).cooldownUntilByKey[plan.runKey]).toBeUndefined();
  });
});
