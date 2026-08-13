import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { OcxConfig } from "../src/types";
import { LAB_PROJECTION_SPEC_VERSION } from "../src/lab/constants";
import { ensureLabDirs, labSqlitePath } from "../src/lab/paths";
import { LAB_SQLITE_DDL, LAB_SQLITE_SCHEMA_VERSION } from "../src/lab/projection/schema";
import { queryLatestLabObservation } from "../src/lab/query/latest-observation";
import { defaultLabAutomationPolicyV1 } from "../src/lab/automation/policy";
import {
  defaultLabAutomationStateV1,
  loadLabAutomationState,
  saveLabAutomationPolicy,
  saveLabAutomationRoutes,
  saveLabAutomationState,
} from "../src/lab/automation/persistence";
import { planLabAutomationRuns, planManualLabRun } from "../src/lab/automation/planner";
import {
  cancelLabAutomationRun,
  requestLabAutomationShutdown,
  resetLabAutomationSchedulerStateForTests,
  runLabAutomationTick,
  setLabAutomationDispatchDeps,
  stopLabAutomationScheduler,
} from "../src/lab/automation/orchestrator";
import { LAB_AUTOMATION_HARD_MAX } from "../src/lab/automation/constants";
import type { LabAutomationRunRecordV1 } from "../src/lab/automation/types";
import { createHostIssuedLabRouteExecutor } from "../src/lib/lab-live-host";
import type { NormalizedObservation } from "../src/lab/conformance/types";
import { readInstallationSalt } from "../src/lab/subject/installation-salt";
import {
  resetCompatibilityVersionCacheForTests,
  setCompatibilityVersionOverrideForTests,
} from "../src/routing/compatibility/version";

const HOMES: string[] = [];
const COMPAT_VERSION = "9".repeat(64);

function tempHome(): string {
  const dir = join(tmpdir(), `ocx-lab-final-review-${process.pid}-${Math.random().toString(16).slice(2)}`);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  HOMES.push(dir);
  process.env.OPENCODEX_HOME = dir;
  readInstallationSalt(dir);
  setCompatibilityVersionOverrideForTests(COMPAT_VERSION);
  return dir;
}

function protocolPolicy() {
  return {
    ...defaultLabAutomationPolicyV1(),
    enabled: true,
    layers: { protocolConformance: true, liveRouteCompatibility: false, taskEffectiveness: false },
    failureCooldownMs: 0,
  };
}

function livePolicy() {
  return {
    ...defaultLabAutomationPolicyV1(),
    enabled: true,
    layers: { protocolConformance: false, liveRouteCompatibility: true, taskEffectiveness: false },
    failureCooldownMs: 0,
  };
}

function liveConfig(): OcxConfig {
  return {
    providers: {
      "fixture-provider": {
        adapter: "openai-responses",
        baseUrl: "https://api.example.com/v1",
        apiKey: "sk-fixture",
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

function activeCooldowns(count: number, now: number): Record<string, number> {
  return Object.fromEntries(
    Array.from({ length: count }, (_, index) => [`occupied-${index}`, now + 60 * 60_000]),
  );
}

function scheduledRecord(plan: ReturnType<typeof planManualLabRun>, runId: string, now: number): LabAutomationRunRecordV1 {
  return {
    ...plan,
    runId,
    state: "queued",
    trigger: "scheduled",
    createdAt: now,
    updatedAt: now,
  };
}

function buildFreshnessProjection(home: string): void {
  ensureLabDirs(home);
  const db = new Database(labSqlitePath(home), { create: true });
  try {
    db.exec(LAB_SQLITE_DDL);
    const insertMeta = db.query("INSERT INTO schema_meta(key, value) VALUES (?, ?)");
    insertMeta.run("schema_version", String(LAB_SQLITE_SCHEMA_VERSION));
    insertMeta.run("projection_spec_version", LAB_PROJECTION_SPEC_VERSION);
    insertMeta.run("built_at_ms", "1");

    const insertEvent = db.query(
      "INSERT INTO events(event_id, event_kind, recorded_at, producer, producer_version, payload_json, excluded) VALUES (?, 'observation', ?, 'test', '1', '{}', 0)",
    );
    const insertObservation = db.query(
      `INSERT INTO observations(
        event_id, subject_id, evidence_layer, suite_id, suite_version, suite_manifest_digest,
        scenario_id, scenario_version, scenario_manifest_digest, outcome, completed_at, execution_mode
      ) VALUES (?, 'subject', 'protocol_conformance', 'suite', '1', ?, ?, '1', ?, 'pass', ?, 'fixture')`,
    );

    db.transaction(() => {
      insertEvent.run("target", 10);
      insertObservation.run("target", "suite-digest", "target-scenario", "target-digest", 10);
      for (let index = 0; index < 2_000; index += 1) {
        const eventId = `irrelevant-${index}`;
        insertEvent.run(eventId, 1_000 + index);
        insertObservation.run(
          eventId,
          `irrelevant-suite-${index}`,
          `irrelevant-scenario-${index}`,
          `irrelevant-digest-${index}`,
          1_000 + index,
        );
      }
    })();
  } finally {
    db.close();
  }
}

afterEach(() => {
  requestLabAutomationShutdown();
  stopLabAutomationScheduler();
  resetLabAutomationSchedulerStateForTests();
  resetCompatibilityVersionCacheForTests();
  delete process.env.OPENCODEX_HOME;
  for (const dir of HOMES.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("CL-08 final CodeRabbit regressions", () => {
  test("freshness lookup stays exact and bounded across large irrelevant history", () => {
    const home = tempHome();
    buildFreshnessProjection(home);
    const plannerSource = readFileSync(join(import.meta.dir, "../src/lab/automation/planner.ts"), "utf8");
    expect(plannerSource).not.toContain("FRESHNESS_QUERY_PAGE_SIZE");
    expect(plannerSource).toContain("queryLatestLabObservation");
    expect(LAB_SQLITE_DDL).toContain("idx_observations_exact_identity");
    expect(queryLatestLabObservation({
      layer: "protocol_conformance",
      subjectId: "subject",
      suiteId: "suite",
      suiteVersion: "1",
      suiteManifestDigest: "suite-digest",
      scenarioId: "target-scenario",
      scenarioVersion: "1",
      scenarioManifestDigest: "target-digest",
    }, home)).toBe(10);
  });

  test("queued cancellation remains a planner-honored backoff when cooldown storage is saturated", () => {
    const home = tempHome();
    const policy = protocolPolicy();
    saveLabAutomationPolicy(policy, home);
    const plan = planManualLabRun({
      evidenceLayer: "protocol_conformance",
      scenarioId: "responses-core.protocol.request-shape",
      configDir: home,
    });
    const now = Date.now();
    saveLabAutomationState({
      ...defaultLabAutomationStateV1(now),
      runs: [scheduledRecord(plan, "queued-cancel", now)],
      cooldownUntilByKey: activeCooldowns(LAB_AUTOMATION_HARD_MAX.maxPersistedRuns, now),
    }, home);

    expect(cancelLabAutomationRun("queued-cancel", home)).toBe(true);
    let state = loadLabAutomationState(home);
    expect(state.runs.find((row) => row.runId === "queued-cancel")?.state).toBe("cancelled");
    expect(state.cooldownUntilByKey[plan.runKey]).toBeUndefined();

    delete state.cooldownUntilByKey["occupied-0"];
    saveLabAutomationState(state, home);
    state = loadLabAutomationState(home);
    const replanned = planLabAutomationRuns({
      policy,
      routes: { schemaVersion: 1, routes: [] },
      state,
      now: now + 1,
      configDir: home,
    });
    expect(replanned.some((row) => row.runKey === plan.runKey)).toBe(false);
  });

  test("in-flight cancellation remains a planner-honored backoff when cooldown storage saturates during dispatch", async () => {
    const home = tempHome();
    const config = liveConfig();
    const policy = livePolicy();
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
    const now = Date.now();
    saveLabAutomationState({
      ...defaultLabAutomationStateV1(now),
      runs: [scheduledRecord(plan, "inflight-cancel", now)],
      cooldownUntilByKey: activeCooldowns(LAB_AUTOMATION_HARD_MAX.maxPersistedRuns - 1, now),
    }, home);

    let startedResolve!: () => void;
    const started = new Promise<void>((resolve) => { startedResolve = resolve; });
    setLabAutomationDispatchDeps({
      configDir: home,
      loadConfig: () => config,
      resolve: async () => [{ address: "93.184.216.34", family: 4 as const }],
      routeExecutor: createHostIssuedLabRouteExecutor(async (input) => {
        startedResolve();
        if (!input.signal.aborted) {
          await new Promise<void>((resolve) => input.signal.addEventListener("abort", () => resolve(), { once: true }));
        }
        return passObservation();
      }),
    });

    const tick = runLabAutomationTick(home);
    await started;
    let state = loadLabAutomationState(home);
    const running = state.runs.find((row) => row.runId === "inflight-cancel");
    expect(running?.state).toBe("running");
    state.cooldownUntilByKey["late-slot"] = now + 60 * 60_000;
    saveLabAutomationState(state, home);

    expect(cancelLabAutomationRun("inflight-cancel", home)).toBe(true);
    await tick;
    state = loadLabAutomationState(home);
    expect(state.runs.find((row) => row.runId === "inflight-cancel")?.state).toBe("cancelled");
    expect(state.cooldownUntilByKey[plan.runKey]).toBeUndefined();

    delete state.cooldownUntilByKey["occupied-0"];
    saveLabAutomationState(state, home);
    state = loadLabAutomationState(home);
    const replanned = planLabAutomationRuns({
      policy,
      routes: { schemaVersion: 1, routes: [{ providerName: "fixture-provider", modelId: "fixture-model" }] },
      state,
      now: Date.now(),
      config,
      configDir: home,
    });
    expect(replanned.some((row) => row.runKey === plan.runKey)).toBe(false);
  });
});
