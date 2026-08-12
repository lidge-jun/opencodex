/** CL-07 fabric module public surface (explicit allowlist re-exports). */
export {
  FABRIC_SUITE_ID,
  FABRIC_SUITE_VERSION,
  FABRIC_SCENARIO_ID,
  FABRIC_SCENARIO_VERSION,
  FABRIC_TASK_CLASS_ID,
  FABRIC_TASK_CLASS_VERSION,
  FABRIC_COMPATIBILITY_VERSION,
  FABRIC_VERIFIER_ID,
  FABRIC_EVIDENCE_LAYER,
  SYNTHETIC_VALUE_PATH,
  SYNTHETIC_BEFORE_UTF8,
  SYNTHETIC_AFTER_UTF8,
  FABRIC_LIMITS,
  SANDBOX_PROFILE_V1,
} from "./constants";
export type {
  FabricOutcomeKind,
  FabricFailureClass,
  FabricExecutionAuthority,
  FabricLimitsV1,
  SyntheticPatchOperationV1,
  SyntheticPatchV1,
  FabricUsageV1,
  ExactTreeDiffPathSummaryV1,
  ExactTreeDiffResultV1,
  FabricTaskOutcomeV1,
  FabricTaskRunResult,
  FabricHarnessProducerKind,
  FabricPatchExecutorInput,
  FabricPatchExecutor,
  TrustedFabricPatchExecutor,
} from "./types";
export { FabricTaskError } from "./types";
export {
  sandboxProfileDigest,
  verifierManifestObject,
  verifierManifestDigest,
  taskFixtureObject,
  taskFixtureDigest,
  buildTaskSubjectV1,
  taskSubjectId,
} from "./subject";
export {
  assertSafeRelativePosixPath,
  resolveInsideScratch,
  createSyntheticScratch,
  assertNotUnderUserRepo,
} from "./scratch";
export type { ScratchTree, WalkedFile } from "./scratch";
export { parseSyntheticPatchV1 } from "./patch";
export { verifyExactTreeDiffV1 } from "./verifier";
export {
  correctSyntheticPatch,
  runFabricSyntheticPatchTask,
  runFabricSyntheticPatchTaskForRoute,
  runFabricSyntheticPatchTaskHarness,
  fabricDeclaredSandboxPolicy,
  fabricScratchCapabilityProbe,
} from "./executor";
export type {
  RunFabricTaskHarnessOptions,
  RunFabricTaskForRouteOptions,
} from "./executor";
export {
  loadFabricCaseAuthority,
  discoverFabricScenarios,
  expandFabricScenario,
  expandFabricSuiteManifest,
  fabricScenarioManifestDigest,
  fabricSuiteManifestDigest,
} from "./manifest";
export type { FabricCaseAuthority } from "./manifest";
export {
  assertFabricOutcomeV1,
  observationFromFabricOutcome,
  persistFabricRunResult,
} from "./observe";
export type { PersistFabricOptions, PersistedFabricObservation } from "./observe";
