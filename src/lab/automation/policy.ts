import {
  LAB_AUTOMATION_DEFAULT_POLICY,
  LAB_AUTOMATION_HARD_MAX,
  LAB_AUTOMATION_POLICY_SCHEMA_VERSION,
} from "./constants";
import type { LabAutomationPolicyV1 } from "./types";
import { LabAutomationError } from "./types";

function assertBoolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") throw new LabAutomationError(`invalid policy field ${field}`, "invalid_policy");
  return value;
}

function assertNonNegativeInt(value: unknown, field: string, max: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new LabAutomationError(`invalid policy field ${field}`, "invalid_policy");
  }
  if (value > max) {
    throw new LabAutomationError(`policy field ${field} exceeds hard maximum`, "invalid_policy");
  }
  return value;
}

/** Validate and normalize automation policy with hard upper bounds. */
export function normalizeLabAutomationPolicyV1(raw: unknown): LabAutomationPolicyV1 {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new LabAutomationError("policy must be an object", "invalid_policy");
  }
  const obj = raw as Record<string, unknown>;
  if (obj.schemaVersion !== LAB_AUTOMATION_POLICY_SCHEMA_VERSION) {
    throw new LabAutomationError("unsupported policy schemaVersion", "invalid_policy");
  }
  const layersRaw = obj.layers;
  if (!layersRaw || typeof layersRaw !== "object" || Array.isArray(layersRaw)) {
    throw new LabAutomationError("invalid policy layers", "invalid_policy");
  }
  const layersObj = layersRaw as Record<string, unknown>;
  const taskBackground = assertBoolean(obj.taskEffectivenessBackgroundEnabled, "taskEffectivenessBackgroundEnabled");
  const layers = {
    protocolConformance: assertBoolean(layersObj.protocolConformance, "layers.protocolConformance"),
    liveRouteCompatibility: assertBoolean(layersObj.liveRouteCompatibility, "layers.liveRouteCompatibility"),
    taskEffectiveness: assertBoolean(layersObj.taskEffectiveness, "layers.taskEffectiveness"),
  };
  if (taskBackground && !layers.taskEffectiveness) {
    throw new LabAutomationError("task background requires task_effectiveness layer", "invalid_policy");
  }
  return Object.freeze({
    schemaVersion: LAB_AUTOMATION_POLICY_SCHEMA_VERSION,
    enabled: assertBoolean(obj.enabled, "enabled"),
    layers: Object.freeze(layers),
    refreshBeforeStaleMs: assertNonNegativeInt(
      obj.refreshBeforeStaleMs,
      "refreshBeforeStaleMs",
      LAB_AUTOMATION_HARD_MAX.refreshBeforeStaleMs,
    ),
    maxConcurrentRuns: assertNonNegativeInt(
      obj.maxConcurrentRuns,
      "maxConcurrentRuns",
      LAB_AUTOMATION_HARD_MAX.maxConcurrentRuns,
    ),
    maxConcurrentLiveRuns: assertNonNegativeInt(
      obj.maxConcurrentLiveRuns,
      "maxConcurrentLiveRuns",
      LAB_AUTOMATION_HARD_MAX.maxConcurrentLiveRuns,
    ),
    maxConcurrentRunsPerRoute: assertNonNegativeInt(
      obj.maxConcurrentRunsPerRoute,
      "maxConcurrentRunsPerRoute",
      LAB_AUTOMATION_HARD_MAX.maxConcurrentRunsPerRoute,
    ),
    maxRunsPerHour: assertNonNegativeInt(
      obj.maxRunsPerHour,
      "maxRunsPerHour",
      LAB_AUTOMATION_HARD_MAX.maxRunsPerHour,
    ),
    maxLiveRequestsPerHour: assertNonNegativeInt(
      obj.maxLiveRequestsPerHour,
      "maxLiveRequestsPerHour",
      LAB_AUTOMATION_HARD_MAX.maxLiveRequestsPerHour,
    ),
    failureCooldownMs: assertNonNegativeInt(
      obj.failureCooldownMs,
      "failureCooldownMs",
      LAB_AUTOMATION_HARD_MAX.failureCooldownMs,
    ),
    blockedCooldownMs: assertNonNegativeInt(
      obj.blockedCooldownMs,
      "blockedCooldownMs",
      LAB_AUTOMATION_HARD_MAX.blockedCooldownMs,
    ),
    taskEffectivenessBackgroundEnabled: taskBackground,
  });
}

/** Default-off automation policy for new installations. */
export function defaultLabAutomationPolicyV1(): LabAutomationPolicyV1 {
  return normalizeLabAutomationPolicyV1({ ...LAB_AUTOMATION_DEFAULT_POLICY });
}
