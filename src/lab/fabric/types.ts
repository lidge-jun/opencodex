import type { FailureClassification } from "../conformance/types";
import type { ObservationOutcome } from "../constants";
import type { FailureRecordV1, RouteSubjectV1, TaskSubjectV1 } from "../events/types";
import type { LabDestinationV1, LabRouteContext } from "../live/types";

export type FabricOutcomeKind = ObservationOutcome;

export type FabricFailureClass = FailureClassification;

export type FabricExecutionAuthority = "trusted_route" | "harness";

export interface FabricLimitsV1 {
  maxFiles: number;
  maxScratchFiles: number;
  maxAggregateIoBytes: number;
  maxPatchOperations: number;
  totalTimeoutMs: number;
  inactivityTimeoutMs: number;
  aggregateArtifactBytes: number;
  maxArtifacts: number;
}

export interface SyntheticPatchOperationV1 {
  op: "replace";
  path: string;
  contentUtf8: string;
}

export interface SyntheticPatchV1 {
  schemaVersion: 1;
  operations: SyntheticPatchOperationV1[];
}

export interface FabricUsageV1 {
  inputBytes: number;
  outputBytes: number;
  patchOperations: number;
  filesTouched: number;
  artifactBytes: number;
  elapsedMs: number;
  inactiveMs: number;
}

export interface ExactTreeDiffPathSummaryV1 {
  path: string;
  kind: "unchanged" | "modified" | "added" | "deleted" | "rejected";
  beforeDigest?: string;
  afterDigest?: string;
  reason?: string;
}

export interface ExactTreeDiffResultV1 {
  verifierId: string;
  manifestDigest: string;
  passed: boolean;
  pathSummaries: ExactTreeDiffPathSummaryV1[];
  reason?: string;
}

export interface FabricTaskOutcomeV1 {
  schemaVersion: 1;
  taskClassId: string;
  taskClassVersion: string;
  routeSubject: RouteSubjectV1;
  taskSubject: TaskSubjectV1;
  subjectId: string;
  taskFixtureDigest: string;
  verifierManifestDigest: string;
  fabricCompatibilityVersion: string;
  sandboxProfileDigest: string;
  startedAt: number;
  completedAt: number;
  limits: FabricLimitsV1;
  usage: FabricUsageV1;
  outcome: FabricOutcomeKind;
  verifier: ExactTreeDiffResultV1;
  failure?: FailureRecordV1;
  artifactDigests: string[];
  sourceRefs?: string[];
}

/** Authoritative route execution input for trusted fabric patch producers. */
export interface FabricPatchExecutorInput {
  routeContext: LabRouteContext;
  destination: LabDestinationV1;
  routeSubject: RouteSubjectV1;
  scratchRoot: string;
  reportActivity: () => void;
  signal: AbortSignal;
}

export type FabricPatchExecutor = (input: FabricPatchExecutorInput) => SyntheticPatchV1 | Promise<SyntheticPatchV1>;

/** Opaque host-issued capability for exact-route fabric patch production. */
export interface TrustedFabricPatchExecutor {
  execute(input: FabricPatchExecutorInput): Promise<SyntheticPatchV1>;
  readonly executorModulePath: string;
}

/** Sealed fabric run result including evidence authority (not part of outcome JSON). */
export interface FabricTaskRunResult {
  outcome: FabricTaskOutcomeV1;
  executionAuthority: FabricExecutionAuthority;
}

export type FabricHarnessProducerKind =
  | "deterministic_correct"
  | "deterministic_wrong"
  | "infinite_sync"
  | "never_resolve"
  | "mutate_after_delay"
  | "periodic_activity"
  | "activity_until_total"
  | "flood_stdout";

/** @deprecated Test-only harness producer; use FabricHarnessProducerKind via runFabricSyntheticPatchTaskHarness. */
export type SyntheticPatchProducer = (ctx: {
  taskClassId: string;
  taskClassVersion: string;
  scratchRoot: string;
  reportActivity: () => void;
}) => SyntheticPatchV1 | Promise<SyntheticPatchV1>;

/** Typed error for fabric task producer, verifier, and sandbox failures. */
export class FabricTaskError extends Error {
  override readonly name = "FabricTaskError";
  constructor(
    message: string,
    readonly code: FabricFailureClass,
    readonly attribution: FailureRecordV1["attribution"] = "harness",
  ) {
    super(message);
  }
}
