import {
  LAB_AUTOMATION_DEFAULT_POLICY,
  LAB_AUTOMATION_HARD_MAX,
  LAB_AUTOMATION_POLICY_SCHEMA_VERSION,
} from "./constants";
import type { LabAutomationPolicyV1 } from "./types";
import { LabAutomationError } from "./types";

const POLICY_KEYS = new Set([
  "schemaVersion",
  "enabled",
  "layers",
  "refreshBeforeStaleMs",
  "maxConcurrentRuns",
  "maxConcurrentLiveRuns",
  "maxConcurrentRunsPerRoute",
  "maxRunsPerHour",
  "maxLiveRequestsPerHour",
  "failureCooldownMs",
  "blockedCooldownMs",
  "taskEffectivenessBackgroundEnabled",
]);
const LAYER_KEYS = new Set([
  "protocolConformance",
  "liveRouteCompatibility",
  "taskEffectiveness",
]);

function assertClosedKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>, field: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw new LabAutomationError(`unknown ${field} field ${key}`, "invalid_policy");
    }
  }
}

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

function assertPositiveInt(value: unknown, field: string, max: number): number {
  const parsed = assertNonNegativeInt(value, field, max);
  if (parsed === 0) {
    throw new LabAutomationError(`policy field ${field} must be at least 1`, "invalid_policy");
  }
  return parsed;
}

/** Validate and normalize automation policy with a closed schema and hard upper bounds. */
export function normalizeLabAutomationPolicyV1(raw: unknown): LabAutomationPolicyV1 {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new LabAutomationError("policy must be an object", "invalid_policy");
  }
  const obj = raw as Record<string, unknown>;
  assertClosedKeys(obj, POLICY_KEYS, "policy");
  if (obj.schemaVersion !== LAB_AUTOMATION_POLICY_SCHEMA_VERSION) {
    throw new LabAutomationError("unsupported policy schemaVersion", "invalid_policy");
  }
  const layersRaw = obj.layers;
  if (!layersRaw || typeof layersRaw !== "object" || Array.isArray(layersRaw)) {
    throw new LabAutomationError("invalid policy layers", "invalid_policy");
  }
  const layersObj = layersRaw as Record<string, unknown>;
  assertClosedKeys(layersObj, LAYER_KEYS, "layers");
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
    maxConcurrentRuns: assertPositiveInt(
      obj.maxConcurrentRuns,
      "maxConcurrentRuns",
      LAB_AUTOMATION_HARD_MAX.maxConcurrentRuns,
    ),
    maxConcurrentLiveRuns: assertPositiveInt(
      obj.maxConcurrentLiveRuns,
      "maxConcurrentLiveRuns",
      LAB_AUTOMATION_HARD_MAX.maxConcurrentLiveRuns,
    ),
    maxConcurrentRunsPerRoute: assertPositiveInt(
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
