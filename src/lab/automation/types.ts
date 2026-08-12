import type { EvidenceLayer } from "../constants";

export type LabAutomationLayer =
  | "protocol_conformance"
  | "live_route_compatibility"
  | "task_effectiveness";

export interface LabAutomationPolicyV1 {
  schemaVersion: 1;
  enabled: boolean;
  layers: {
    protocolConformance: boolean;
    liveRouteCompatibility: boolean;
    taskEffectiveness: boolean;
  };
  refreshBeforeStaleMs: number;
  maxConcurrentRuns: number;
  maxConcurrentLiveRuns: number;
  maxConcurrentRunsPerRoute: number;
  maxRunsPerHour: number;
  maxLiveRequestsPerHour: number;
  failureCooldownMs: number;
  blockedCooldownMs: number;
  taskEffectivenessBackgroundEnabled: boolean;
}

export type LabAutomationPlanReason =
  | "automation_disabled"
  | "layer_disabled"
  | "fresh"
  | "refresh_due"
  | "missing"
  | "cooldown"
  | "budget_blocked"
  | "already_queued"
  | "already_running"
  | "route_ineligible"
  | "scenario_inapplicable"
  | "task_background_disabled";

export interface PlannedLabRunV1 {
  runKey: string;
  evidenceLayer: LabAutomationLayer;
  suiteId: string;
  suiteVersion: string;
  suiteManifestDigest: string;
  scenarioId: string;
  scenarioVersion: string;
  scenarioManifestDigest: string;
  subjectId: string;
  reason: LabAutomationPlanReason;
  priority: number;
  eligibleAt: number;
  providerName?: string;
  modelId?: string;
}

export type LabAutomationRunState =
  | "queued"
  | "running"
  | "completed"
  | "blocked"
  | "failed"
  | "cancelled"
  | "abandoned";

export type LabAutomationRunTrigger = "scheduled" | "manual";

export interface LabAutomationRunRecordV1 {
  runId: string;
  runKey: string;
  state: LabAutomationRunState;
  evidenceLayer: LabAutomationLayer;
  suiteId: string;
  suiteVersion: string;
  suiteManifestDigest: string;
  scenarioId: string;
  scenarioVersion: string;
  scenarioManifestDigest: string;
  subjectId: string;
  reason: LabAutomationPlanReason;
  priority: number;
  eligibleAt: number;
  trigger: LabAutomationRunTrigger;
  createdAt: number;
  updatedAt: number;
  startedAt?: number;
  completedAt?: number;
  terminalCode?: string;
  providerName?: string;
  modelId?: string;
}

export interface LabAutomationRouteRefV1 {
  providerName: string;
  modelId: string;
}

export interface LabAutomationRoutesV1 {
  schemaVersion: 1;
  routes: readonly LabAutomationRouteRefV1[];
}

export interface LabAutomationStateV1 {
  schemaVersion: 1;
  runs: LabAutomationRunRecordV1[];
  budgetWindowStartedAt: number;
  runsThisHour: number;
  liveRequestsThisHour: number;
  cooldownUntilByKey: Record<string, number>;
}

export interface LabAutomationStatusV1 {
  policy: LabAutomationPolicyV1;
  routes: LabAutomationRoutesV1;
  counters: {
    queued: number;
    running: number;
    completedLastHour: number;
    blockedLastHour: number;
    remainingRunBudget: number;
    remainingLiveRequestBudget: number;
  };
  schedulerRunning: boolean;
}

export interface AutomationDispatchDeps {
  configDir?: string;
  routeExecutor?: import("../live/types").TrustedLabRouteExecutor;
  patchExecutor?: import("../fabric/types").TrustedFabricPatchExecutor;
  loadConfig?: () => import("../../types").OcxConfig;
  abortSignal?: AbortSignal;
  /** Orchestrator-set guard that requires the queued identity to match current frozen contracts. */
  enforceRunIdentity?: boolean;
  /** Test-only DNS seam; production uses destination policy resolution when unset. */
  resolve?: import("../live/types").DnsResolver;
}

export class LabAutomationError extends Error {
  override readonly name = "LabAutomationError";
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
  }
}

export function evidenceLayerToAutomationLayer(layer: EvidenceLayer): LabAutomationLayer | null {
  switch (layer) {
    case "protocol_conformance":
      return "protocol_conformance";
    case "live_route_compatibility":
      return "live_route_compatibility";
    case "task_effectiveness":
      return "task_effectiveness";
    default:
      return null;
  }
}
