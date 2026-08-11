/** CL-08 automation hard ceilings — callers cannot raise policy above these values. */

export const LAB_AUTOMATION_POLICY_SCHEMA_VERSION = 1 as const;

export const LAB_AUTOMATION_HARD_MAX = Object.freeze({
  refreshBeforeStaleMs: 30 * 24 * 60 * 60 * 1000,
  maxConcurrentRuns: 4,
  maxConcurrentLiveRuns: 2,
  maxConcurrentRunsPerRoute: 2,
  maxRunsPerHour: 60,
  maxLiveRequestsPerHour: 30,
  failureCooldownMs: 24 * 60 * 60 * 1000,
  blockedCooldownMs: 7 * 24 * 60 * 60 * 1000,
  terminalRunRetentionMs: 7 * 24 * 60 * 60 * 1000,
  maxQueuedRuns: 256,
  maxPersistedRuns: 512,
  maxAutomationRoutes: 64,
  budgetWindowMs: 60 * 60 * 1000,
  schedulerTickMs: 60 * 1000,
});

export const LAB_AUTOMATION_DEFAULT_POLICY = Object.freeze({
  schemaVersion: LAB_AUTOMATION_POLICY_SCHEMA_VERSION,
  enabled: false,
  layers: Object.freeze({
    protocolConformance: false,
    liveRouteCompatibility: false,
    taskEffectiveness: false,
  }),
  refreshBeforeStaleMs: 24 * 60 * 60 * 1000,
  maxConcurrentRuns: 2,
  maxConcurrentLiveRuns: 1,
  maxConcurrentRunsPerRoute: 1,
  maxRunsPerHour: 12,
  maxLiveRequestsPerHour: 6,
  failureCooldownMs: 5 * 60 * 1000,
  blockedCooldownMs: 60 * 60 * 1000,
  taskEffectivenessBackgroundEnabled: false,
});
