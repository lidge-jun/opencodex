import type { EvidenceLayer } from "../constants";
import { subjectIdForSubject, scenarioManifestDigest } from "../digest";
import { discoverScenarios, expandScenario, loadCaseAuthority } from "../conformance/manifest";
import { CL01_SUITES, CL03_LIVE_SUITES } from "../conformance/types";
import { resolveProtocolExecutionContext } from "../conformance/executor";
import { buildProtocolSubjectV1 } from "../subject/protocol-subject";
import { discoverLiveScenarios, expandLiveScenario, loadLiveCaseAuthority } from "../live/manifest";
import { isLiveCaseApplicableToRoute } from "../live/executor";
import { buildAutomationLiveRouteContext } from "./route-context";
import { liveSuiteManifestDigestForCase } from "../live/suite-manifest";
import { suiteManifestDigestForCase } from "../conformance/suite-manifest";
import { isScenarioApplicable } from "../projection/verification";
import { queryLatestLabObservation } from "../query/latest-observation";
import { LabProjectionUnavailableError } from "../query/errors";
import type { OcxConfig } from "../../types";
import { resolvePolicyCompatibilitySubjects } from "../../routing/compatibility/subject";
import type {
  LabAutomationLayer,
  LabAutomationPlanReason,
  LabAutomationPolicyV1,
  LabAutomationRoutesV1,
  LabAutomationRunRecordV1,
  LabAutomationStateV1,
  PlannedLabRunV1,
} from "./types";
import { LabAutomationError } from "./types";
import {
  buildLabAutomationRunKey,
  liveExecutionContractDigest,
  protocolExecutionContractDigest,
} from "./run-key";
import { cooldownActive, cooldownCapacityExhausted } from "./cooldown";
import { isLiveRequestBudgetExhausted, isRunBudgetExhausted } from "./budgets";
import { LAB_AUTOMATION_HARD_MAX } from "./constants";

export interface PlannerInput {
  policy: LabAutomationPolicyV1;
  routes: LabAutomationRoutesV1;
  state: LabAutomationStateV1;
  now: number;
  config?: OcxConfig;
  configDir?: string;
}

interface EvidenceIdentity {
  layer: EvidenceLayer;
  subjectId: string;
  suiteId: string;
  suiteVersion: string;
  suiteManifestDigest: string;
  scenarioId: string;
  scenarioVersion: string;
  scenarioManifestDigest: string;
}

function freshnessReason(
  latestCompletedAt: number | undefined,
  maxAgeMs: number | null,
  refreshBeforeStaleMs: number,
  now: number,
): LabAutomationPlanReason {
  if (latestCompletedAt === undefined) return "missing";
  if (maxAgeMs === null) return "fresh";
  const deadline = latestCompletedAt + maxAgeMs;
  const refreshAt = deadline - refreshBeforeStaleMs;
  if (now >= deadline) return "refresh_due";
  if (now >= refreshAt) return "refresh_due";
  return "fresh";
}

function activeRunForKey(state: LabAutomationStateV1, runKey: string): LabAutomationRunRecordV1 | undefined {
  return state.runs.find((row) => row.runKey === runKey && (row.state === "queued" || row.state === "running"));
}

function cancellationBackoffActive(
  state: LabAutomationStateV1,
  runKey: string,
  failureCooldownMs: number,
  now: number,
): boolean {
  const backoffMs = Math.max(failureCooldownMs, LAB_AUTOMATION_HARD_MAX.schedulerTickMs);
  return state.runs.some((row) =>
    row.runKey === runKey
    && row.trigger === "scheduled"
    && row.state === "cancelled"
    && row.terminalCode === "cancelled"
    && typeof row.completedAt === "number"
    && row.completedAt + backoffMs > now
  );
}

function latestMatchingObservationCompletedAt(
  identity: EvidenceIdentity,
  configDir?: string,
): number | undefined {
  try {
    return queryLatestLabObservation(identity, configDir);
  } catch (error) {
    if (error instanceof LabProjectionUnavailableError) return undefined;
    throw error;
  }
}

function planProtocolScenarios(input: PlannerInput): PlannedLabRunV1[] {
  if (!input.policy.enabled || !input.policy.layers.protocolConformance) return [];
  const authority = loadCaseAuthority();
  const scenarios = discoverScenarios(authority, CL01_SUITES);
  const planned: PlannedLabRunV1[] = [];
  for (const caseRecord of scenarios) {
    if (!isScenarioApplicable(caseRecord.id, "fixture", "protocol_conformance")) continue;
    let subject;
    try {
      const ctx = resolveProtocolExecutionContext(caseRecord);
      subject = buildProtocolSubjectV1(ctx);
    } catch {
      continue;
    }
    const subjectId = subjectIdForSubject(subject);
    const expanded = expandScenario(caseRecord, authority);
    const scenarioDigest = scenarioManifestDigest(expanded);
    const suiteDigest = suiteManifestDigestForCase(caseRecord, authority);
    const suiteVersion = authority.manifestDefaults.suiteVersion;
    const scenarioVersion = authority.manifestDefaults.version;
    const runKey = buildLabAutomationRunKey({
      evidenceLayer: "protocol_conformance",
      subjectId,
      suiteId: caseRecord.suite,
      suiteVersion,
      suiteManifestDigest: suiteDigest,
      scenarioId: caseRecord.id,
      scenarioVersion,
      scenarioManifestDigest: scenarioDigest,
      executionContractDigest: protocolExecutionContractDigest(),
    });
    if (activeRunForKey(input.state, runKey)) continue;
    if (cancellationBackoffActive(input.state, runKey, input.policy.failureCooldownMs, input.now)) continue;
    if (cooldownActive(input.state, runKey, input.now)) continue;
    const latestCompletedAt = latestMatchingObservationCompletedAt({
      layer: "protocol_conformance",
      subjectId,
      suiteId: caseRecord.suite,
      suiteVersion,
      suiteManifestDigest: suiteDigest,
      scenarioId: caseRecord.id,
      scenarioVersion,
      scenarioManifestDigest: scenarioDigest,
    }, input.configDir);
    // CL-00 freezes one freshness default into both suite and scenario manifests; there is no
    // independent case-level override in the current authority schema.
    const maxAge = authority.manifestDefaults.freshness.maxAgeMs;
    const freshness = freshnessReason(latestCompletedAt, maxAge, input.policy.refreshBeforeStaleMs, input.now);
    if (freshness === "fresh") continue;
    planned.push({
      runKey,
      evidenceLayer: "protocol_conformance",
      suiteId: caseRecord.suite,
      suiteVersion,
      suiteManifestDigest: suiteDigest,
      scenarioId: caseRecord.id,
      scenarioVersion,
      scenarioManifestDigest: scenarioDigest,
      subjectId,
      reason: freshness,
      priority: freshness === "missing" ? 0 : 1,
      eligibleAt: input.now,
    });
  }
  return planned;
}

function planLiveScenarios(input: PlannerInput): PlannedLabRunV1[] {
  if (!input.policy.enabled || !input.policy.layers.liveRouteCompatibility) return [];
  if (!input.config) return [];
  if (isLiveRequestBudgetExhausted(input.policy, input.state, input.now)) return [];
  const authority = loadLiveCaseAuthority();
  const scenarios = discoverLiveScenarios(authority, CL03_LIVE_SUITES);
  const planned: PlannedLabRunV1[] = [];
  for (const routeRef of input.routes.routes) {
    const routed = input.config.providers?.[routeRef.providerName];
    if (!routed) continue;
    const resolved = resolvePolicyCompatibilitySubjects(
      input.config,
      routeRef.providerName,
      routeRef.modelId,
      routed,
      input.configDir,
    );
    if (!resolved.route) continue;
    const routeContext = buildAutomationLiveRouteContext(
      resolved.route,
      routed.allowPrivateNetwork === true,
    );
    for (const caseRecord of scenarios) {
      if (!isLiveCaseApplicableToRoute(caseRecord, routeContext)) continue;
      const expanded = expandLiveScenario(caseRecord, authority);
      const scenarioDigest = scenarioManifestDigest(expanded);
      const suiteDigest = liveSuiteManifestDigestForCase(caseRecord, authority);
      const suiteVersion = authority.manifestDefaults.suiteVersion;
      const scenarioVersion = authority.manifestDefaults.version;
      const subjectId = resolved.route.subjectId;
      const runKey = buildLabAutomationRunKey({
        evidenceLayer: "live_route_compatibility",
        subjectId,
        suiteId: caseRecord.suite,
        suiteVersion,
        suiteManifestDigest: suiteDigest,
        scenarioId: caseRecord.id,
        scenarioVersion,
        scenarioManifestDigest: scenarioDigest,
        executionContractDigest: liveExecutionContractDigest(),
      });
      if (activeRunForKey(input.state, runKey)) continue;
      if (cancellationBackoffActive(input.state, runKey, input.policy.failureCooldownMs, input.now)) continue;
      if (cooldownActive(input.state, runKey, input.now)) continue;
      const latestCompletedAt = latestMatchingObservationCompletedAt({
        layer: "live_route_compatibility",
        subjectId,
        suiteId: caseRecord.suite,
        suiteVersion,
        suiteManifestDigest: suiteDigest,
        scenarioId: caseRecord.id,
        scenarioVersion,
        scenarioManifestDigest: scenarioDigest,
      }, input.configDir);
      const maxAge = authority.manifestDefaults.freshness.maxAgeMs;
      const freshness = freshnessReason(latestCompletedAt, maxAge, input.policy.refreshBeforeStaleMs, input.now);
      if (freshness === "fresh") continue;
      planned.push({
        runKey,
        evidenceLayer: "live_route_compatibility",
        suiteId: caseRecord.suite,
        suiteVersion,
        suiteManifestDigest: suiteDigest,
        scenarioId: caseRecord.id,
        scenarioVersion,
        scenarioManifestDigest: scenarioDigest,
        subjectId,
        reason: freshness,
        priority: freshness === "missing" ? 0 : 1,
        eligibleAt: input.now,
        providerName: routeRef.providerName,
        modelId: routeRef.modelId,
      });
    }
  }
  return planned;
}

/** Deterministic planner — no execution side effects. */
export function planLabAutomationRuns(input: PlannerInput): PlannedLabRunV1[] {
  if (!input.policy.enabled) return [];
  if (isRunBudgetExhausted(input.policy, input.state, input.now)) return [];
  // Cooldown persistence is bounded. If every slot contains an active backoff, fail closed rather
  // than enqueueing work whose retry suppression could not be recorded.
  if (cooldownCapacityExhausted(input.state, input.now)) return [];
  const protocol = planProtocolScenarios(input);
  const live = planLiveScenarios(input);
  const merged = [...protocol, ...live];
  merged.sort((a, b) => {
    if (a.priority !== b.priority) return a.priority - b.priority;
    if (a.eligibleAt !== b.eligibleAt) return a.eligibleAt - b.eligibleAt;
    return a.runKey < b.runKey ? -1 : a.runKey > b.runKey ? 1 : 0;
  });
  const cap = LAB_AUTOMATION_HARD_MAX.maxQueuedRuns;
  return merged.slice(0, cap);
}

export interface ManualLabRunInput {
  evidenceLayer: LabAutomationLayer;
  scenarioId: string;
  providerName?: string;
  modelId?: string;
  config?: OcxConfig;
  configDir?: string;
}

/** Build a single manual run plan — independent of automation enablement. */
export function planManualLabRun(input: ManualLabRunInput): PlannedLabRunV1 {
  const now = Date.now();
  if (input.evidenceLayer === "task_effectiveness") {
    throw new LabAutomationError("manual task_effectiveness uses CL-07 tooling", "task_background_disabled");
  }
  if (input.evidenceLayer === "protocol_conformance") {
    const authority = loadCaseAuthority();
    const caseRecord = authority.cases.find((row) => row.id === input.scenarioId);
    if (!caseRecord) throw new LabAutomationError("unknown protocol scenario", "scenario_inapplicable");
    const ctx = resolveProtocolExecutionContext(caseRecord);
    const subject = buildProtocolSubjectV1(ctx);
    const subjectId = subjectIdForSubject(subject);
    const expanded = expandScenario(caseRecord, authority);
    const scenarioDigest = scenarioManifestDigest(expanded);
    const suiteDigest = suiteManifestDigestForCase(caseRecord, authority);
    return {
      runKey: buildLabAutomationRunKey({
        evidenceLayer: "protocol_conformance",
        subjectId,
        suiteId: caseRecord.suite,
        suiteVersion: authority.manifestDefaults.suiteVersion,
        suiteManifestDigest: suiteDigest,
        scenarioId: caseRecord.id,
        scenarioVersion: authority.manifestDefaults.version,
        scenarioManifestDigest: scenarioDigest,
        executionContractDigest: protocolExecutionContractDigest(),
      }),
      evidenceLayer: "protocol_conformance",
      suiteId: caseRecord.suite,
      suiteVersion: authority.manifestDefaults.suiteVersion,
      suiteManifestDigest: suiteDigest,
      scenarioId: caseRecord.id,
      scenarioVersion: authority.manifestDefaults.version,
      scenarioManifestDigest: scenarioDigest,
      subjectId,
      reason: "missing",
      priority: 0,
      eligibleAt: now,
    };
  }
  if (!input.config || !input.providerName || !input.modelId) {
    throw new LabAutomationError("live manual run requires providerName and modelId", "route_ineligible");
  }
  const routed = input.config.providers?.[input.providerName];
  if (!routed) throw new LabAutomationError("unknown provider route", "route_ineligible");
  const resolved = resolvePolicyCompatibilitySubjects(
    input.config,
    input.providerName,
    input.modelId,
    routed,
    input.configDir,
  );
  if (!resolved.route) throw new LabAutomationError("route ineligible for compatibility subject", "route_ineligible");
  const authority = loadLiveCaseAuthority();
  const caseRecord = authority.cases.find((row) => row.id === input.scenarioId);
  if (!caseRecord) throw new LabAutomationError("unknown live scenario", "scenario_inapplicable");
  const routeContext = buildAutomationLiveRouteContext(
    resolved.route,
    routed.allowPrivateNetwork === true,
  );
  if (!isLiveCaseApplicableToRoute(caseRecord, routeContext)) {
    throw new LabAutomationError("scenario inapplicable to route", "scenario_inapplicable");
  }
  const expanded = expandLiveScenario(caseRecord, authority);
  const scenarioDigest = scenarioManifestDigest(expanded);
  const suiteDigest = liveSuiteManifestDigestForCase(caseRecord, authority);
  const subjectId = resolved.route.subjectId;
  return {
    runKey: buildLabAutomationRunKey({
      evidenceLayer: "live_route_compatibility",
      subjectId,
      suiteId: caseRecord.suite,
      suiteVersion: authority.manifestDefaults.suiteVersion,
      suiteManifestDigest: suiteDigest,
      scenarioId: caseRecord.id,
      scenarioVersion: authority.manifestDefaults.version,
      scenarioManifestDigest: scenarioDigest,
      executionContractDigest: liveExecutionContractDigest(),
    }),
    evidenceLayer: "live_route_compatibility",
    suiteId: caseRecord.suite,
    suiteVersion: authority.manifestDefaults.suiteVersion,
    suiteManifestDigest: suiteDigest,
    scenarioId: caseRecord.id,
    scenarioVersion: authority.manifestDefaults.version,
    scenarioManifestDigest: scenarioDigest,
    subjectId,
    reason: "missing",
    priority: 0,
    eligibleAt: now,
    providerName: input.providerName,
    modelId: input.modelId,
  };
}
