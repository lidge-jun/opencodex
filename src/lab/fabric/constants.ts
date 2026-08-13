/** CL-07 frozen fabric-core / synthetic-patch constants. */

export const FABRIC_SUITE_ID = "fabric-core";
export const FABRIC_SUITE_VERSION = "1.0.0";
export const FABRIC_SCENARIO_ID = "fabric-core.task.synthetic-patch";
export const FABRIC_SCENARIO_VERSION = "1.0.0";
export const FABRIC_TASK_CLASS_ID = "fabric-core.task.synthetic-patch";
export const FABRIC_TASK_CLASS_VERSION = "1.0.0";
export const FABRIC_COMPATIBILITY_VERSION = "ocx-fabric-producer-v1";
export const FABRIC_VERIFIER_ID = "exact-tree-diff-v1";
export const FABRIC_EVIDENCE_LAYER = "task_effectiveness" as const;

export const SYNTHETIC_VALUE_PATH = "src/value.txt";
export const SYNTHETIC_BEFORE_UTF8 = "before\n";
export const SYNTHETIC_AFTER_UTF8 = "after\n";

export const FABRIC_LIMITS = Object.freeze({
  maxFiles: 1,
  /** Upper bound for scratch-tree walks (verifier may see unexpected extras). */
  maxScratchFiles: 8,
  maxAggregateIoBytes: 64 * 1024,
  maxPatchOperations: 1,
  totalTimeoutMs: 30_000,
  inactivityTimeoutMs: 5_000,
  aggregateArtifactBytes: 1024 * 1024,
  maxArtifacts: 8,
});

export const SANDBOX_PROFILE_V1 = Object.freeze({
  schemaVersion: 1,
  profileId: "lab-fabric-scratch-v1",
  allowNetwork: false,
  allowUserMcp: false,
  allowShell: false,
  allowUserRepository: false,
  followSymlinks: false,
  allowSpecialFiles: false,
  scratchOnly: true,
  limits: FABRIC_LIMITS,
});
