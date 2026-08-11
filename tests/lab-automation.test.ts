import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { handleManagementAPI } from "../src/server/management-api";
import { ManagementRequest } from "./helpers/management-auth";
import type { OcxConfig } from "../src/types";
import { defaultLabAutomationPolicyV1 } from "../src/lab/automation/policy";
import {
  loadLabAutomationPolicy,
  loadLabAutomationState,
  saveLabAutomationPolicy,
  saveLabAutomationRoutes,
  saveLabAutomationState,
} from "../src/lab/automation/persistence";
import { planLabAutomationRuns, planManualLabRun } from "../src/lab/automation/planner";
import { enqueuePlannedRuns, selectDispatchableRuns } from "../src/lab/automation/queue";
import { recoverLabAutomationState } from "../src/lab/automation/recovery";
import {
  buildLabAutomationStatus,
  cancelLabAutomationRun,
  enqueueManualLabRun,
  runLabAutomationTick,
  setLabAutomationDispatchDeps,
  stopLabAutomationScheduler,
  requestLabAutomationShutdown,
  resetLabAutomationSchedulerStateForTests,
} from "../src/lab/automation/orchestrator";
import { dispatchLabAutomationRun } from "../src/lab/automation/dispatch";
import { LAB_AUTOMATION_HARD_MAX } from "../src/lab/automation/constants";
import { LabAutomationError } from "../src/lab/automation/types";
import { createHostIssuedLabRouteExecutor } from "../src/lib/lab-live-host";
import { isTrustedLabRouteExecutor } from "../src/lib/lab-live-execution-authority";
import { createProductionLabRouteExecutor } from "../src/lib/lab-live-route-production";
import { readInstallationSalt } from "../src/lab/subject/installation-salt";
import { loadLiveCaseAuthority } from "../src/lab/live/manifest";
import { TransportError } from "../src/lab/live/transport";
import type { NormalizedObservation } from "../src/lab/conformance/types";
import {
  resetCompatibilityVersionCacheForTests,
  setCompatibilityVersionOverrideForTests,
} from "../src/routing/compatibility/version";

const COMPAT_VERSION = "f".repeat(64);
const HOMES: string[] = [];

function tempHome(): string {
  const dir = join(tmpdir(), `ocx-lab-cl08-${process.pid}-${Math.random().toString(16).slice(2)}`);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  HOMES.push(dir);
  return dir;
}

afterEach(() => {
  requestLabAutomationShutdown();
  stopLabAutomationScheduler();
  resetLabAutomationSchedulerStateForTests();
  setLabAutomationDispatchDeps({});
  resetCompatibilityVersionCacheForTests();
  for (const dir of HOMES.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
  delete process.env.OPENCODEX_HOME;
});

function withHome<T>(fn: (home: string) => T): T {
  const home = tempHome();
  process.env.OPENCODEX_HOME = home;
  return fn(home);
}

function prepareLiveRouteHome(home: string): void {
  readInstallationSalt(home);
  setCompatibilityVersionOverrideForTests(COMPAT_VERSION);
}

function fixtureDnsResolve() {
  return async () => [{ address: "93.184.216.34", family: 4 as const }];
}

function liveAutomationDeps(
  home: string,
  config: OcxConfig,
  routeExecutor?: ReturnType<typeof createHostIssuedLabRouteExecutor>,
) {
  return {
    configDir: home,
    loadConfig: () => config,
    resolve: fixtureDnsResolve(),
    ...(routeExecutor ? { routeExecutor } : {}),
  };
}

function enabledProtocolPolicy(): ReturnType<typeof defaultLabAutomationPolicyV1> {
  return {
    ...defaultLabAutomationPolicyV1(),
    enabled: true,
    layers: {
      protocolConformance: true,
      liveRouteCompatibility: false,
      taskEffectiveness: false,
    },
    maxConcurrentRuns: 2,
    maxRunsPerHour: 20,
    refreshBeforeStaleMs: 60_000,
  };
}

describe("CL-08 lab automation", () => {
  test("default policy schedules nothing", () => {
    withHome((home) => {
      const policy = loadLabAutomationPolicy(home);
      expect(policy.enabled).toBe(false);
      const planned = planLabAutomationRuns({
        policy,
        routes: { schemaVersion: 1, routes: [] },
        state: loadLabAutomationState(home),
        now: Date.now(),
        configDir: home,
      });
      expect(planned).toEqual([]);
    });
  });

  test("planner schedules protocol work when evidence is missing", () => {
    withHome((home) => {
      const policy = enabledProtocolPolicy();
      const planned = planLabAutomationRuns({
        policy,
        routes: { schemaVersion: 1, routes: [] },
        state: loadLabAutomationState(home),
        now: Date.now(),
        configDir: home,
      });
      expect(planned.length).toBeGreaterThan(0);
      expect(planned.every((row) => row.evidenceLayer === "protocol_conformance")).toBe(true);
    });
  });

  test("dedup prevents duplicate active run keys", () => {
    withHome((home) => {
      const policy = enabledProtocolPolicy();
      const input = {
        policy,
        routes: { schemaVersion: 1, routes: [] },
        state: loadLabAutomationState(home),
        now: Date.now(),
        configDir: home,
      };
      const planned = planLabAutomationRuns(input);
      let state = enqueuePlannedRuns(input.state, planned.slice(0, 1), "scheduled", Date.now());
      const again = planLabAutomationRuns({ ...input, state });
      expect(again.some((row) => row.runKey === planned[0]!.runKey)).toBe(false);
      state = enqueuePlannedRuns(state, planned.slice(0, 1), "scheduled", Date.now());
      expect(state.runs.filter((row) => row.runKey === planned[0]!.runKey).length).toBe(1);
    });
  });

  test("hourly run budget blocks planning", () => {
    withHome((home) => {
      const policy = enabledProtocolPolicy();
      const state = {
        ...loadLabAutomationState(home),
        runsThisHour: policy.maxRunsPerHour,
      };
      const planned = planLabAutomationRuns({
        policy,
        routes: { schemaVersion: 1, routes: [] },
        state,
        now: Date.now(),
        configDir: home,
      });
      expect(planned).toEqual([]);
    });
  });

  test("policy hard maximum cannot be exceeded via normalization", () => {
    withHome((home) => {
      expect(() => {
        saveLabAutomationPolicy({
          ...defaultLabAutomationPolicyV1(),
          enabled: true,
          maxRunsPerHour: LAB_AUTOMATION_HARD_MAX.maxRunsPerHour + 1,
        } as never, home);
      }).toThrow(LabAutomationError);
    });
  });

  test("recovery marks abandoned running runs", () => {
    withHome((home) => {
      const policy = enabledProtocolPolicy();
      const now = Date.now();
      saveLabAutomationState({
        schemaVersion: 1,
        runs: [{
          runId: "run-1",
          runKey: "key-1",
          state: "running",
          evidenceLayer: "protocol_conformance",
          suiteId: "responses-core",
          suiteVersion: "1",
          suiteManifestDigest: "digest",
          scenarioId: "responses-core.protocol.request-shape",
          scenarioVersion: "1",
          scenarioManifestDigest: "digest",
          subjectId: "subject",
          reason: "missing",
          priority: 0,
          eligibleAt: now,
          trigger: "scheduled",
          createdAt: now,
          updatedAt: now,
        }],
        budgetWindowStartedAt: now,
        runsThisHour: 0,
        liveRequestsThisHour: 0,
        cooldownUntilByKey: {},
      }, home);
      const state = loadLabAutomationState(home);
      const recovered = recoverLabAutomationState(policy, state, now + 1);
      expect(recovered.runs[0]?.state).toBe("abandoned");
      expect(recovered.cooldownUntilByKey["key-1"]).toBeGreaterThan(now);
    });
  });

  test("queued cancellation transitions to cancelled", () => {
    withHome((home) => {
      const now = Date.now();
      saveLabAutomationState({
        schemaVersion: 1,
        runs: [{
          runId: "queued-1",
          runKey: "key-q",
          state: "queued",
          evidenceLayer: "protocol_conformance",
          suiteId: "responses-core",
          suiteVersion: "1",
          suiteManifestDigest: "digest",
          scenarioId: "responses-core.protocol.request-shape",
          scenarioVersion: "1",
          scenarioManifestDigest: "digest",
          subjectId: "subject",
          reason: "missing",
          priority: 0,
          eligibleAt: now,
          trigger: "scheduled",
          createdAt: now,
          updatedAt: now,
        }],
        budgetWindowStartedAt: now,
        runsThisHour: 0,
        liveRequestsThisHour: 0,
        cooldownUntilByKey: {},
      }, home);
      expect(cancelLabAutomationRun("queued-1", home)).toBe(true);
      const state = loadLabAutomationState(home);
      expect(state.runs[0]?.state).toBe("cancelled");
    });
  });

  test("dispatch honours abort signal without persisting", async () => {
    await withHome(async (home) => {
      const controller = new AbortController();
      controller.abort();
      const now = Date.now();
      await expect(dispatchLabAutomationRun({
        runId: "abort-1",
        runKey: "key",
        state: "running",
        evidenceLayer: "protocol_conformance",
        suiteId: "responses-core",
        suiteVersion: "1",
        suiteManifestDigest: "digest",
        scenarioId: "responses-core.protocol.request-shape",
        scenarioVersion: "1",
        scenarioManifestDigest: "digest",
        subjectId: "subject",
        reason: "missing",
        priority: 0,
        eligibleAt: now,
        trigger: "manual",
        createdAt: now,
        updatedAt: now,
      }, { configDir: home, abortSignal: controller.signal })).rejects.toThrow(LabAutomationError);
      expect(existsSync(join(home, "lab", "ledger"))).toBe(false);
    });
  });

  test("automation persistence stores policy refs not credentials", () => {
    withHome((home) => {
      saveLabAutomationPolicy(enabledProtocolPolicy(), home);
      saveLabAutomationRoutes({
        schemaVersion: 1,
        routes: [{ providerName: "openai", modelId: "gpt-4.1" }],
      }, home);
      const policyBlob = readFileSync(join(home, "lab", "automation-policy.json"), "utf8");
      const routesBlob = readFileSync(join(home, "lab", "automation-routes.json"), "utf8");
      expect(policyBlob.includes("apiKey")).toBe(false);
      expect(policyBlob.includes("Authorization")).toBe(false);
      expect(routesBlob.includes("http://")).toBe(false);
      expect(routesBlob.includes("sk-")).toBe(false);
    });
  });

  test("concurrency limits cap dispatch selection", () => {
    const policy = enabledProtocolPolicy();
    policy.maxConcurrentRuns = 1;
    const now = Date.now();
    const state = {
      schemaVersion: 1,
      runs: [
        {
          runId: "r1", runKey: "k1", state: "running" as const, evidenceLayer: "protocol_conformance" as const,
          suiteId: "s", suiteVersion: "1", suiteManifestDigest: "d", scenarioId: "a", scenarioVersion: "1",
          scenarioManifestDigest: "d", subjectId: "sub", reason: "missing" as const, priority: 0, eligibleAt: now,
          trigger: "scheduled" as const, createdAt: now, updatedAt: now,
        },
        {
          runId: "r2", runKey: "k2", state: "queued" as const, evidenceLayer: "protocol_conformance" as const,
          suiteId: "s", suiteVersion: "1", suiteManifestDigest: "d", scenarioId: "b", scenarioVersion: "1",
          scenarioManifestDigest: "d", subjectId: "sub", reason: "missing" as const, priority: 0, eligibleAt: now,
          trigger: "scheduled" as const, createdAt: now, updatedAt: now,
        },
      ],
      budgetWindowStartedAt: now,
      runsThisHour: 0,
      liveRequestsThisHour: 0,
      cooldownUntilByKey: {},
    };
    const selected = selectDispatchableRuns(policy, state, now);
    expect(selected.length).toBe(0);
  });

  test("task background execution stays disabled by default", () => {
    withHome((home) => {
      const policy = {
        ...enabledProtocolPolicy(),
        layers: { protocolConformance: false, liveRouteCompatibility: false, taskEffectiveness: true },
        taskEffectivenessBackgroundEnabled: false,
      };
      const planned = planLabAutomationRuns({
        policy,
        routes: { schemaVersion: 1, routes: [] },
        state: loadLabAutomationState(home),
        now: Date.now(),
        configDir: home,
      });
      expect(planned).toEqual([]);
    });
  });

  test("GET lab automation API does not start scheduler", async () => {
    await withHome(async (home) => {
      const config = { providers: {} } as OcxConfig;
      const req = new ManagementRequest("http://127.0.0.1/api/lab/automation");
      const res = await handleManagementAPI(req, new URL(req.url), config);
      expect(res).not.toBeNull();
      expect(res?.status).toBe(200);
      const status = buildLabAutomationStatus(home);
      expect(status.schedulerRunning).toBe(false);
    });
  });

  test("production read paths do not reference automation scheduler", () => {
    const files = [
      "src/lab/query/queries.ts",
      "src/routing/profile.ts",
      "src/routing/evaluator.ts",
      "src/server/responses/core.ts",
    ];
    for (const file of files) {
      const src = readFileSync(join(process.cwd(), file), "utf8");
      expect(src.includes("runLabAutomationTick")).toBe(false);
      expect(src.includes("startLabAutomationScheduler")).toBe(false);
      expect(src.includes("planLabAutomationRuns")).toBe(false);
    }
  });

  test("corrupt scheduler state fails closed on load", () => {
    withHome((home) => {
      const path = join(home, "lab");
      mkdirSync(path, { recursive: true });
      const statePath = join(path, "automation-state.json");
      writeBadState(statePath);
      expect(() => loadLabAutomationState(home)).toThrow(LabAutomationError);
    });
  });

  test("production factory yields host-issued trusted executor", () => {
    const executor = createProductionLabRouteExecutor({
      loadConfig: () => ({ providers: {} } as OcxConfig),
    });
    expect(isTrustedLabRouteExecutor(executor)).toBe(true);
  });

  test("missing trusted executor fails closed without provider traffic", async () => {
    await withHome(async (home) => {
      prepareLiveRouteHome(home);
      const config = fixtureProviderConfig();
      const now = Date.now();
      const authority = loadLiveCaseAuthority();
      const scenario = authority.cases.find((c) => c.id === "responses-core.live.basic-turn")!;
      setLabAutomationDispatchDeps(liveAutomationDeps(home, config));
      const result = await dispatchLabAutomationRun({
        runId: "live-1",
        runKey: "live-key",
        state: "running",
        evidenceLayer: "live_route_compatibility",
        suiteId: scenario.suite,
        suiteVersion: "1",
        suiteManifestDigest: "digest",
        scenarioId: scenario.id,
        scenarioVersion: "1",
        scenarioManifestDigest: "digest",
        subjectId: "subject",
        reason: "missing",
        priority: 0,
        eligibleAt: now,
        trigger: "scheduled",
        createdAt: now,
        updatedAt: now,
        providerName: "fixture-provider",
        modelId: "fixture-model",
      }, { configDir: home, loadConfig: () => config });
      expect(result.terminalState).toBe("blocked");
      expect(result.terminalCode).toBe("route_ineligible");
      expect(result.liveRequest).toBe(false);
    });
  });

  test("trusted live dispatch invokes host executor exactly once", async () => {
    await withHome(async (home) => {
      prepareLiveRouteHome(home);
      const config = fixtureProviderConfig();
      let invokes = 0;
      const executor = createHostIssuedLabRouteExecutor(async () => {
        invokes += 1;
        return passObservation();
      });
      setLabAutomationDispatchDeps(liveAutomationDeps(home, config, executor));
      saveLabAutomationPolicy({
        ...enabledProtocolPolicy(),
        layers: { protocolConformance: false, liveRouteCompatibility: true, taskEffectiveness: false },
        maxConcurrentLiveRuns: 1,
        maxLiveRequestsPerHour: 6,
      }, home);
      saveLabAutomationRoutes({
        schemaVersion: 1,
        routes: [{ providerName: "fixture-provider", modelId: "fixture-model" }],
      }, home);
      const plan = planManualLabRun({
        evidenceLayer: "live_route_compatibility",
        scenarioId: "responses-core.live.basic-turn",
        providerName: "fixture-provider",
        modelId: "fixture-model",
        config,
        configDir: home,
      });
      const state = enqueuePlannedRuns(loadLabAutomationState(home), [plan], "scheduled", Date.now());
      saveLabAutomationState(state, home);
      await runLabAutomationTick(home);
      expect(invokes).toBe(1);
      const stored = loadLabAutomationState(home).runs.find((row) => row.runKey === plan.runKey);
      expect(stored?.state === "completed" || stored?.state === "failed").toBe(true);
    });
  });

  test("disabled automation never invokes trusted executor", async () => {
    await withHome(async (home) => {
      let invokes = 0;
      setLabAutomationDispatchDeps(liveAutomationDeps(home, fixtureProviderConfig(), createHostIssuedLabRouteExecutor(async () => {
          invokes += 1;
          return passObservation();
        })));
      await runLabAutomationTick(home);
      expect(invokes).toBe(0);
    });
  });

  test("live request budget blocks dispatch while leaving runs queued", async () => {
    await withHome(async (home) => {
      prepareLiveRouteHome(home);
      const config = fixtureProviderConfig();
      let invokes = 0;
      setLabAutomationDispatchDeps(liveAutomationDeps(home, config, createHostIssuedLabRouteExecutor(async () => {
          invokes += 1;
          return passObservation();
        })));
      const policy = {
        ...enabledProtocolPolicy(),
        enabled: true,
        layers: { protocolConformance: false, liveRouteCompatibility: true, taskEffectiveness: false },
        maxLiveRequestsPerHour: 0,
      };
      saveLabAutomationPolicy(policy, home);
      saveLabAutomationRoutes({
        schemaVersion: 1,
        routes: [{ providerName: "fixture-provider", modelId: "fixture-model" }],
      }, home);
      const plan = planManualLabRun({
        evidenceLayer: "live_route_compatibility",
        scenarioId: "responses-core.live.basic-turn",
        providerName: "fixture-provider",
        modelId: "fixture-model",
        config,
        configDir: home,
      });
      const state = enqueuePlannedRuns(loadLabAutomationState(home), [plan], "scheduled", Date.now());
      saveLabAutomationState(state, home);
      await runLabAutomationTick(home);
      expect(invokes).toBe(0);
      expect(loadLabAutomationState(home).runs.find((row) => row.runKey === plan.runKey)?.state).toBe("queued");
    });
  });

  test("authentication blocked from trusted executor stays orchestration blocked", async () => {
    await withHome(async (home) => {
      prepareLiveRouteHome(home);
      const config = fixtureProviderConfig();
      const executor = createHostIssuedLabRouteExecutor(async () => {
        throw new TransportError("auth_blocked", "HTTP 401");
      });
      setLabAutomationDispatchDeps(liveAutomationDeps(home, config, executor));
      const authority = loadLiveCaseAuthority();
      const scenario = authority.cases.find((c) => c.id === "responses-core.live.basic-turn")!;
      const now = Date.now();
      const result = await dispatchLabAutomationRun({
        runId: "auth-block",
        runKey: "auth-key",
        state: "running",
        evidenceLayer: "live_route_compatibility",
        suiteId: scenario.suite,
        suiteVersion: authority.manifestDefaults.suiteVersion,
        suiteManifestDigest: "digest",
        scenarioId: scenario.id,
        scenarioVersion: authority.manifestDefaults.version,
        scenarioManifestDigest: "digest",
        subjectId: "subject",
        reason: "missing",
        priority: 0,
        eligibleAt: now,
        trigger: "scheduled",
        createdAt: now,
        updatedAt: now,
        providerName: "fixture-provider",
        modelId: "fixture-model",
      }, liveAutomationDeps(home, config, executor));
      expect(result.terminalState).toBe("blocked");
      expect(result.terminalCode).toBe("auth_blocked");
      expect(result.liveRequest).toBe(true);
    });
  });

  test("management PUT cannot inject trusted executor authority", async () => {
    await withHome(async (home) => {
      prepareLiveRouteHome(home);
      const config = fixtureProviderConfig();
      let fakeInvokes = 0;
      const fakeExecutor = {
        execute: async () => {
          fakeInvokes += 1;
          return passObservation();
        },
        enforcedBoundaries: [],
      };
      const req = new ManagementRequest("http://127.0.0.1/api/lab/automation", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          policy: { enabled: true },
          routeExecutor: fakeExecutor,
        }),
      });
      const res = await handleManagementAPI(req, new URL(req.url), config);
      expect(res).not.toBeNull();
      expect(res?.status).toBe(200);
      const production = createProductionLabRouteExecutor({ loadConfig: () => config });
      expect(isTrustedLabRouteExecutor(production)).toBe(true);
      expect(isTrustedLabRouteExecutor(fakeExecutor)).toBe(false);

      const plan = planManualLabRun({
        evidenceLayer: "live_route_compatibility",
        scenarioId: "responses-core.live.basic-turn",
        providerName: "fixture-provider",
        modelId: "fixture-model",
        config,
        configDir: home,
      });
      const record = await enqueueManualLabRun(plan, home);
      expect(fakeInvokes).toBe(0);
      expect(record?.state).toBe("blocked");
      expect(record?.terminalCode).toBe("route_ineligible");
    });
  });

  test("shutdown stops new trusted dispatch", async () => {
    await withHome(async (home) => {
      prepareLiveRouteHome(home);
      const config = fixtureProviderConfig();
      let invokes = 0;
      setLabAutomationDispatchDeps(liveAutomationDeps(home, config, createHostIssuedLabRouteExecutor(async () => {
          invokes += 1;
          return passObservation();
        })));
      saveLabAutomationPolicy({
        ...enabledProtocolPolicy(),
        layers: { protocolConformance: false, liveRouteCompatibility: true, taskEffectiveness: false },
      }, home);
      const authority = loadLiveCaseAuthority();
      const scenario = authority.cases.find((c) => c.id === "responses-core.live.basic-turn")!;
      const now = Date.now();
      saveLabAutomationState({
        schemaVersion: 1,
        runs: [{
          runId: "shutdown-live",
          runKey: "shutdown-key",
          state: "queued",
          evidenceLayer: "live_route_compatibility",
          suiteId: scenario.suite,
          suiteVersion: authority.manifestDefaults.suiteVersion,
          suiteManifestDigest: "digest",
          scenarioId: scenario.id,
          scenarioVersion: authority.manifestDefaults.version,
          scenarioManifestDigest: "digest",
          subjectId: "pending",
          reason: "missing",
          priority: 0,
          eligibleAt: now,
          trigger: "scheduled",
          createdAt: now,
          updatedAt: now,
          providerName: "fixture-provider",
          modelId: "fixture-model",
        }],
        budgetWindowStartedAt: now,
        runsThisHour: 0,
        liveRequestsThisHour: 0,
        cooldownUntilByKey: {},
      }, home);
      requestLabAutomationShutdown();
      await runLabAutomationTick(home);
      expect(invokes).toBe(0);
    });
  });
});

function writeBadState(path: string): void {
  writeFileSync(path, JSON.stringify({ schemaVersion: 1, runs: [{ bad: true }] }), "utf8");
}

function fixtureProviderConfig(): OcxConfig {
  return {
    providers: {
      "fixture-provider": {
        adapter: "openai-responses",
        baseUrl: "https://api.example.com/v1",
        apiKey: "sk-fixture-test-key",
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
