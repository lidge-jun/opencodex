import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { OcxConfig } from "../src/types";
import { defaultLabAutomationPolicyV1, normalizeLabAutomationPolicyV1 } from "../src/lab/automation/policy";
import {
  defaultLabAutomationStateV1,
  loadLabAutomationPolicy,
  loadLabAutomationState,
  saveLabAutomationPolicy,
  saveLabAutomationState,
} from "../src/lab/automation/persistence";
import { loadLabAutomationConfig } from "../src/lab/automation/config-persistence";
import { LAB_AUTOMATION_HARD_MAX } from "../src/lab/automation/constants";
import { enqueuePlannedRuns } from "../src/lab/automation/queue";
import { runBudgetRemaining } from "../src/lab/automation/budgets";
import { cooldownActive, setCooldown } from "../src/lab/automation/cooldown";
import { listLabAutomationRuns } from "../src/lab/automation/runs-query";
import {
  cancelLabAutomationRun,
  requestLabAutomationShutdown,
  resetLabAutomationSchedulerStateForTests,
  stopLabAutomationScheduler,
} from "../src/lab/automation/orchestrator";
import type { LabAutomationRunRecordV1, PlannedLabRunV1 } from "../src/lab/automation/types";
import { LabAutomationError } from "../src/lab/automation/types";
import { ensureLabDirs, labAutomationStatePath } from "../src/lab/paths";
import { handleManagementAPI } from "../src/server/management-api";
import { ManagementRequest } from "./helpers/management-auth";
import { handleLabCommand } from "../src/cli/lab";
import { createProductionLabRouteExecutor } from "../src/lib/lab-live-route-production";
import { removeTreeWithRetry } from "./helpers/remove-tree";

const HOMES: string[] = [];

function tempHome(): string {
  const dir = join(tmpdir(), `ocx-lab-coderabbit-${process.pid}-${Math.random().toString(16).slice(2)}`);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  HOMES.push(dir);
  process.env.OPENCODEX_HOME = dir;
  return dir;
}

function emptyConfig(): OcxConfig {
  return { providers: {} } as OcxConfig;
}

function queuedRun(overrides: Partial<LabAutomationRunRecordV1> = {}): LabAutomationRunRecordV1 {
  const now = 1_000_000;
  return {
    runId: "run-1",
    runKey: "key-1",
    state: "queued",
    evidenceLayer: "protocol_conformance",
    suiteId: "responses-core",
    suiteVersion: "1",
    suiteManifestDigest: "suite-digest",
    scenarioId: "responses-core.protocol.request-shape",
    scenarioVersion: "1",
    scenarioManifestDigest: "scenario-digest",
    subjectId: "subject-1",
    reason: "missing",
    priority: 0,
    eligibleAt: now,
    trigger: "scheduled",
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function plan(overrides: Partial<PlannedLabRunV1> = {}): PlannedLabRunV1 {
  return {
    runKey: "new-key",
    evidenceLayer: "protocol_conformance",
    suiteId: "responses-core",
    suiteVersion: "1",
    suiteManifestDigest: "suite-digest",
    scenarioId: "responses-core.protocol.request-shape",
    scenarioVersion: "1",
    scenarioManifestDigest: "scenario-digest",
    subjectId: "subject-new",
    reason: "missing",
    priority: 0,
    eligibleAt: 1_000_000,
    ...overrides,
  };
}

afterEach(() => {
  requestLabAutomationShutdown();
  stopLabAutomationScheduler();
  resetLabAutomationSchedulerStateForTests();
  for (const dir of HOMES.splice(0)) removeTreeWithRetry(dir);
  delete process.env.OPENCODEX_HOME;
});

describe("CL-08 CodeRabbit regressions", () => {
  test("zero concurrency policy values are rejected", () => {
    const base = defaultLabAutomationPolicyV1();
    for (const field of ["maxConcurrentRuns", "maxConcurrentLiveRuns", "maxConcurrentRunsPerRoute"] as const) {
      expect(() => normalizeLabAutomationPolicyV1({ ...base, [field]: 0 })).toThrow(LabAutomationError);
    }
  });

  test("recent terminal attempts cannot be evicted out of the rolling budget window", () => {
    const now = 2_000_000;
    const runs = Array.from({ length: LAB_AUTOMATION_HARD_MAX.maxPersistedRuns }, (_, index) => queuedRun({
      runId: `done-${index}`,
      runKey: `done-key-${index}`,
      state: "completed",
      createdAt: now - 500,
      updatedAt: now - 100,
      startedAt: now - 200,
      completedAt: now - 100,
      terminalCode: undefined,
    }));
    const state = { ...defaultLabAutomationStateV1(now), runs };
    const next = enqueuePlannedRuns(state, [plan({ eligibleAt: now })], "scheduled", now);
    expect(next.runs).toHaveLength(LAB_AUTOMATION_HARD_MAX.maxPersistedRuns);
    expect(next.runs.some((row) => row.runKey === "new-key")).toBe(false);
    const policy = { ...defaultLabAutomationPolicyV1(), maxRunsPerHour: LAB_AUTOMATION_HARD_MAX.maxRunsPerHour };
    expect(runBudgetRemaining(policy, next, now)).toBe(0);
  });

  test("setting cooldown prunes expired entries and never exceeds persistence capacity", () => {
    const now = 5_000;
    const expired = Object.fromEntries(
      Array.from({ length: LAB_AUTOMATION_HARD_MAX.maxPersistedRuns }, (_, index) => [`expired-${index}`, now - 1]),
    );
    const pruned = setCooldown(
      { ...defaultLabAutomationStateV1(now), cooldownUntilByKey: expired },
      "fresh-key",
      now + 1_000,
      now,
    );
    expect(pruned.cooldownUntilByKey).toEqual({ "fresh-key": now + 1_000 });

    const active = Object.fromEntries(
      Array.from({ length: LAB_AUTOMATION_HARD_MAX.maxPersistedRuns }, (_, index) => [`active-${index}`, now + 10_000]),
    );
    const saturated = setCooldown(
      { ...defaultLabAutomationStateV1(now), cooldownUntilByKey: active },
      "overflow",
      now + 20_000,
      now,
    );
    expect(Object.keys(saturated.cooldownUntilByKey).length).toBeLessThanOrEqual(LAB_AUTOMATION_HARD_MAX.maxPersistedRuns);
    expect(saturated.cooldownUntilByKey.overflow).toBeUndefined();
    expect(cooldownActive(saturated, "active-0", now)).toBe(true);
    expect(cooldownActive(saturated, "overflow", now)).toBe(true);
    expect(cooldownActive(saturated, "unrelated-key", now)).toBe(true);
    expect(cooldownActive(saturated, "unrelated-key", now + 20_001)).toBe(false);
  });

  test("persisted state rejects duplicate identities and impossible lifecycle fields", () => {
    const home = tempHome();
    ensureLabDirs(home);
    const writeState = (runs: unknown[]) => {
      writeFileSync(labAutomationStatePath(home), JSON.stringify({
        schemaVersion: 1,
        runs,
        budgetWindowStartedAt: 1,
        runsThisHour: 0,
        liveRequestsThisHour: 0,
        cooldownUntilByKey: {},
      }), "utf8");
    };

    writeState([queuedRun(), queuedRun({ runKey: "other-key" })]);
    expect(() => loadLabAutomationState(home)).toThrow(LabAutomationError);

    writeState([queuedRun(), queuedRun({ runId: "run-2" })]);
    expect(() => loadLabAutomationState(home)).toThrow(LabAutomationError);

    writeState([queuedRun({ completedAt: 1_000_001 })]);
    expect(() => loadLabAutomationState(home)).toThrow(LabAutomationError);
  });

  test("unknown run cursor is an explicit invalid_cursor error", () => {
    expect(() => listLabAutomationRuns(defaultLabAutomationStateV1(), 10, "evicted-run"))
      .toThrow(LabAutomationError);
    try {
      listLabAutomationRuns(defaultLabAutomationStateV1(), 10, "evicted-run");
    } catch (error) {
      expect((error as LabAutomationError).code).toBe("invalid_cursor");
    }
  });

  test("operator cancellation gives scheduled work a positive backoff even when failure cooldown is zero", () => {
    const home = tempHome();
    const policy = {
      ...defaultLabAutomationPolicyV1(),
      enabled: true,
      layers: { protocolConformance: true, liveRouteCompatibility: false, taskEffectiveness: false },
      failureCooldownMs: 0,
    };
    saveLabAutomationPolicy(policy, home);
    saveLabAutomationState({ ...defaultLabAutomationStateV1(), runs: [queuedRun()] }, home);
    const before = Date.now();
    expect(cancelLabAutomationRun("run-1", home)).toBe(true);
    const state = loadLabAutomationState(home);
    expect(state.runs[0]?.state).toBe("cancelled");
    expect(state.cooldownUntilByKey["key-1"]).toBeGreaterThanOrEqual(before + LAB_AUTOMATION_HARD_MAX.schedulerTickMs);
  });

  test("management cancel rejects malformed percent encoding", async () => {
    tempHome();
    const req = new ManagementRequest("http://127.0.0.1/api/lab/automation/runs/%E0%A4%A/cancel", { method: "POST" });
    const res = await handleManagementAPI(req, new URL(req.url), emptyConfig());
    expect(res).not.toBeNull();
    expect(res!.status).toBe(400);
    expect((await res!.json()).error.code).toBe("invalid_run_id");
  });

  test("management run listing rejects invalid limits and stale cursors", async () => {
    tempHome();
    for (const suffix of ["?limit=0", "?limit=101"]) {
      const req = new ManagementRequest(`http://127.0.0.1/api/lab/automation/runs${suffix}`);
      const res = await handleManagementAPI(req, new URL(req.url), emptyConfig());
      expect(res).not.toBeNull();
      expect(res!.status).toBe(400);
      expect((await res!.json()).error.code).toBe("invalid_limit");
    }

    const staleReq = new ManagementRequest("http://127.0.0.1/api/lab/automation/runs?cursor=evicted");
    const staleRes = await handleManagementAPI(staleReq, new URL(staleReq.url), emptyConfig());
    expect(staleRes).not.toBeNull();
    expect(staleRes!.status).toBe(400);
    expect((await staleRes!.json()).error.code).toBe("invalid_cursor");
  });

  test("invalid routes cannot partially persist an otherwise valid policy update", async () => {
    const home = tempHome();
    expect(loadLabAutomationPolicy(home).enabled).toBe(false);
    const req = new ManagementRequest("http://127.0.0.1/api/lab/automation", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        policy: { enabled: true },
        routes: { schemaVersion: 1, routes: [{ providerName: "fixture-provider" }] },
      }),
    });
    const res = await handleManagementAPI(req, new URL(req.url), emptyConfig());
    expect(res).not.toBeNull();
    expect(res!.status).toBe(400);
    expect(loadLabAutomationPolicy(home).enabled).toBe(false);
  });

  test("manual management body rejects unknown capability injection keys", async () => {
    tempHome();
    const req = new ManagementRequest("http://127.0.0.1/api/lab/automation/run", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        evidenceLayer: "protocol_conformance",
        scenarioId: "responses-core.protocol.request-shape",
        routeExecutor: { execute: "forged" },
      }),
    });
    const res = await handleManagementAPI(req, new URL(req.url), emptyConfig());
    expect(res).not.toBeNull();
    expect(res!.status).toBe(400);
    expect((await res!.json()).error.code).toBe("invalid_body");
  });

  test("CLI re-enable without layer flags preserves prior selections", async () => {
    const home = tempHome();
    saveLabAutomationPolicy({
      ...defaultLabAutomationPolicyV1(),
      enabled: false,
      layers: { protocolConformance: false, liveRouteCompatibility: true, taskEffectiveness: false },
    }, home);
    expect(await handleLabCommand(["automation", "enable", "--json"], { configDir: home })).toBe(0);
    const policy = loadLabAutomationConfig(home).policy;
    expect(policy.enabled).toBe(true);
    expect(policy.layers.protocolConformance).toBe(false);
    expect(policy.layers.liveRouteCompatibility).toBe(true);
  });

  test("OAuth live probes reject cleartext destinations before transport", async () => {
    const config = {
      providers: {
        xai: {
          adapter: "openai-responses",
          baseUrl: "http://example.com/v1",
          authMode: "oauth",
          models: ["grok"],
        },
      },
    } as OcxConfig;
    const executor = createProductionLabRouteExecutor({ loadConfig: () => config });
    await expect(executor.execute({
      routeContext: {
        providerId: "xai",
        providerInstanceKey: "fixture",
        clientModelId: "grok",
        upstreamModelId: "grok",
        effectiveAdapter: "openai-responses",
        inboundProtocol: "responses",
        upstreamProtocol: "responses",
        surface: "responses",
        baseUrl: "http://example.com/v1",
        opencodexCompatibilityVersion: "f".repeat(64),
        behaviorValues: {},
      },
      destination: {
        scheme: "http",
        host: "example.com",
        port: 80,
        basePath: "/v1",
        sniHost: "example.com",
        addresses: [{ address: "93.184.216.34", family: 4 }],
        privateNetwork: false,
        fingerprint: "destination",
      },
      routeSubject: {} as never,
      scenarioId: "responses-core.live.basic-turn",
      initiatingRequest: "{}",
      limits: {
        totalTimeoutMs: 1_000,
        connectTimeoutMs: 500,
        firstByteTimeoutMs: 500,
        inactivityTimeoutMs: 500,
        maxRequests: 1,
        maxInputBytes: 1024,
        maxOutputBytes: 1024,
        maxOutputTokens: 128,
        maxToolCalls: 0,
        maxMemoryBytes: 1024 * 1024,
        maxChildProcesses: 0,
        maxArtifacts: 0,
        perArtifactBytes: 0,
        aggregateArtifactBytes: 0,
      },
      signal: new AbortController().signal,
      environment: {},
    })).rejects.toThrow("OAuth lab probes require HTTPS");
  });
});