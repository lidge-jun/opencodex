import { createArtifactStore, type ArtifactStore } from "../artifacts/store";
import { sanitizeDiagnostic, truncateUtf8 } from "../artifacts/sanitize";
import {
  LAB_EVENT_SCHEMA_VERSION,
  LAB_PRODUCER,
  LAB_PRODUCER_VERSION,
  OBSERVATION_LIMIT_NAMES,
  OUTCOMES,
} from "../constants";
import { FAILURE_CLASSIFICATIONS } from "../conformance/types";
import { fixtureDigest, isSha256Hex, jcsStringify, subjectIdForSubject } from "../digest";
import type { ObservationEvent, RouteSubjectV1, TaskSubjectV1 } from "../events/types";
import { LabValidationError } from "../events/errors";
import { assignEventId, validateSubject } from "../events/validate";
import { withLedgerMutation } from "../ledger/store";
import { ensureLabDirs } from "../paths";
import {
  FABRIC_EVIDENCE_LAYER,
  FABRIC_SCENARIO_ID,
  FABRIC_SCENARIO_VERSION,
  FABRIC_SUITE_ID,
  FABRIC_SUITE_VERSION,
  FABRIC_LIMITS,
  FABRIC_VERIFIER_ID,
} from "./constants";
import {
  expandFabricScenario,
  expandFabricSuiteManifest,
  fabricScenarioManifestDigest,
  fabricSuiteManifestDigest,
  loadFabricCaseAuthority,
} from "./manifest";
import type { FabricLimitsV1, FabricTaskOutcomeV1, FabricTaskRunResult } from "./types";
import { FabricTaskError } from "./types";

/** CL-07 fabric task outcome validation and observation persistence. */

/** Options for building or persisting a fabric observation event. */
export interface PersistFabricOptions {
  configDir?: string;
  recordedAt?: number;
  producerVersion?: string;
  artifactStore?: ArtifactStore;
  attempt?: number;
}

/** Result of appending a fabric observation to the compatibility ledger. */
export interface PersistedFabricObservation {
  event: ObservationEvent;
  ledgerPath: string;
}

const OUTCOME_KEYS = new Set([
  "schemaVersion",
  "taskClassId",
  "taskClassVersion",
  "routeSubject",
  "taskSubject",
  "subjectId",
  "taskFixtureDigest",
  "verifierManifestDigest",
  "fabricCompatibilityVersion",
  "sandboxProfileDigest",
  "startedAt",
  "completedAt",
  "limits",
  "usage",
  "outcome",
  "verifier",
  "failure",
  "artifactDigests",
  "sourceRefs",
]);

const VERIFIER_KEYS = new Set(["verifierId", "manifestDigest", "passed", "pathSummaries", "reason"]);
const PATH_SUMMARY_KEYS = new Set(["path", "kind", "beforeDigest", "afterDigest", "reason"]);
const PATH_SUMMARY_KINDS = new Set(["unchanged", "modified", "added", "deleted", "rejected"]);
const USAGE_KEYS = ["inputBytes", "outputBytes", "patchOperations", "filesTouched", "artifactBytes", "elapsedMs", "inactiveMs"] as const;
const LIMIT_KEYS = Object.keys(FABRIC_LIMITS) as Array<keyof FabricLimitsV1>;
const FAILURE_KEYS = new Set(["class", "code", "retryable", "attribution"]);
const FAILURE_ATTRIBUTIONS = new Set(["opencodex", "route", "environment", "harness"]);

/** Require a non-null plain object or throw a harness-class FabricTaskError. */
function assertPlainObject(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new FabricTaskError(`malformed producer outcome: ${label}`, "malformed_producer_outcome", "harness");
  }
  return value as Record<string, unknown>;
}

/** Require a non-empty string field on a producer outcome object. */
function assertStringField(obj: Record<string, unknown>, key: string): string {
  const value = obj[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new FabricTaskError(`malformed producer outcome: ${key}`, "malformed_producer_outcome", "harness");
  }
  return value;
}

/** Require an integer field on a producer outcome object. */
function assertIntegerField(obj: Record<string, unknown>, key: string): number {
  const value = obj[key];
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new FabricTaskError(`malformed producer outcome: ${key}`, "malformed_producer_outcome", "harness");
  }
  return value;
}

/** Require a non-negative integer field on a producer outcome object. */
function assertNonNegativeIntegerField(obj: Record<string, unknown>, key: string): number {
  const value = assertIntegerField(obj, key);
  if (value < 0) {
    throw new FabricTaskError(`malformed producer outcome: ${key}`, "malformed_producer_outcome", "harness");
  }
  return value;
}

/** Map LabValidationError into FabricTaskError for producer outcome parsing. */
function wrapValidationError(error: unknown): never {
  if (error instanceof LabValidationError) {
    throw new FabricTaskError(error.message, "malformed_producer_outcome", "harness");
  }
  throw error;
}

/** Validate verifier payload shape and reject unknown nested verifier fields. */
function validateFabricVerifier(raw: Record<string, unknown>): void {
  for (const key of Object.keys(raw)) {
    if (!VERIFIER_KEYS.has(key)) {
      throw new FabricTaskError(`unknown verifier field ${key}`, "malformed_producer_outcome", "harness");
    }
  }
  if (raw.verifierId !== FABRIC_VERIFIER_ID) {
    throw new FabricTaskError("malformed producer outcome: verifierId", "malformed_producer_outcome", "harness");
  }
  const manifestDigest = assertStringField(raw, "manifestDigest");
  if (!isSha256Hex(manifestDigest)) {
    throw new FabricTaskError("malformed producer outcome: manifestDigest", "malformed_producer_outcome", "harness");
  }
  if (typeof raw.passed !== "boolean") {
    throw new FabricTaskError("malformed producer outcome: passed", "malformed_producer_outcome", "harness");
  }
  if (!Array.isArray(raw.pathSummaries)) {
    throw new FabricTaskError("malformed producer outcome: pathSummaries", "malformed_producer_outcome", "harness");
  }
  for (const row of raw.pathSummaries) {
    const summary = assertPlainObject(row, "pathSummaries[]");
    for (const key of Object.keys(summary)) {
      if (!PATH_SUMMARY_KEYS.has(key)) {
        throw new FabricTaskError(`unknown path summary field ${key}`, "malformed_producer_outcome", "harness");
      }
    }
    assertStringField(summary, "path");
    const kind = assertStringField(summary, "kind");
    if (!PATH_SUMMARY_KINDS.has(kind)) {
      throw new FabricTaskError("malformed producer outcome: path summary kind", "malformed_producer_outcome", "harness");
    }
    if (summary.beforeDigest !== undefined && !isSha256Hex(assertStringField(summary, "beforeDigest"))) {
      throw new FabricTaskError("malformed producer outcome: beforeDigest", "malformed_producer_outcome", "harness");
    }
    if (summary.afterDigest !== undefined && !isSha256Hex(assertStringField(summary, "afterDigest"))) {
      throw new FabricTaskError("malformed producer outcome: afterDigest", "malformed_producer_outcome", "harness");
    }
    if (summary.reason !== undefined && typeof summary.reason !== "string") {
      throw new FabricTaskError("malformed producer outcome: path summary reason", "malformed_producer_outcome", "harness");
    }
  }
  if (raw.reason !== undefined && typeof raw.reason !== "string") {
    throw new FabricTaskError("malformed producer outcome: reason", "malformed_producer_outcome", "harness");
  }
}

/** Validate non-negative usage counters on a producer outcome. */
function validateFabricUsage(raw: Record<string, unknown>): void {
  for (const key of Object.keys(raw)) {
    if (!(USAGE_KEYS as readonly string[]).includes(key)) {
      throw new FabricTaskError(`unknown usage field ${key}`, "malformed_producer_outcome", "harness");
    }
  }
  for (const key of USAGE_KEYS) {
    assertNonNegativeIntegerField(raw, key);
  }
}

/** Validate non-negative limit fields on a producer outcome. */
function validateFabricLimits(raw: Record<string, unknown>): void {
  for (const key of Object.keys(raw)) {
    if (!(LIMIT_KEYS as readonly string[]).includes(key)) {
      throw new FabricTaskError(`unknown limit field ${key}`, "malformed_producer_outcome", "harness");
    }
  }
  for (const key of LIMIT_KEYS) {
    assertNonNegativeIntegerField(raw, key);
  }
}

/** Validate failure record shape and known attribution values. */
function validateFailureRecord(raw: Record<string, unknown>): void {
  for (const key of Object.keys(raw)) {
    if (!FAILURE_KEYS.has(key)) {
      throw new FabricTaskError(`unknown failure field ${key}`, "malformed_producer_outcome", "harness");
    }
  }
  const failureClass = assertStringField(raw, "class");
  if (!FAILURE_CLASSIFICATIONS.includes(failureClass as typeof FAILURE_CLASSIFICATIONS[number])) {
    throw new FabricTaskError("malformed producer outcome: failure.class", "malformed_producer_outcome", "harness");
  }
  assertStringField(raw, "code");
  if (typeof raw.retryable !== "boolean") {
    throw new FabricTaskError("malformed producer outcome: failure.retryable", "malformed_producer_outcome", "harness");
  }
  const attribution = assertStringField(raw, "attribution");
  if (!FAILURE_ATTRIBUTIONS.has(attribution)) {
    throw new FabricTaskError("malformed producer outcome: failure.attribution", "malformed_producer_outcome", "harness");
  }
}

/** Compare top-level and nested route subjects by canonical JCS representation. */
function routeSubjectsMatch(top: RouteSubjectV1, nested: RouteSubjectV1): boolean {
  return jcsStringify(top) === jcsStringify(nested);
}

/** Build an allowlisted verifier_summary artifact with sanitized diagnostics. */
function sanitizedVerifierSummary(outcome: FabricTaskOutcomeV1): Record<string, unknown> {
  const verifier = {
    verifierId: outcome.verifier.verifierId,
    manifestDigest: outcome.verifier.manifestDigest,
    passed: outcome.verifier.passed,
    pathSummaries: outcome.verifier.pathSummaries.map((row) => ({
      path: row.path,
      kind: row.kind,
      ...(row.beforeDigest ? { beforeDigest: row.beforeDigest } : {}),
      ...(row.afterDigest ? { afterDigest: row.afterDigest } : {}),
      ...(row.reason ? { reason: truncateUtf8(sanitizeDiagnostic(row.reason), 512) } : {}),
    })),
    ...(outcome.verifier.reason
      ? { reason: truncateUtf8(sanitizeDiagnostic(outcome.verifier.reason), 512) }
      : {}),
  };
  return {
    scenarioId: FABRIC_SCENARIO_ID,
    passed: outcome.verifier.passed,
    verifier,
    usage: outcome.usage,
    outcome: outcome.outcome,
  };
}

/** Parse and deeply validate a fabric producer outcome before persistence. */
export function assertFabricOutcomeV1(raw: unknown): FabricTaskOutcomeV1 {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new FabricTaskError("malformed producer outcome", "malformed_producer_outcome", "harness");
  }
  const obj = raw as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    if (!OUTCOME_KEYS.has(key)) {
      throw new FabricTaskError(`unknown outcome field ${key}`, "malformed_producer_outcome", "harness");
    }
  }
  if (obj.schemaVersion !== 1) {
    throw new FabricTaskError("schemaVersion must be 1", "malformed_producer_outcome", "harness");
  }

  const taskSubjectObj = assertPlainObject(obj.taskSubject, "taskSubject");
  const routeSubjectObj = assertPlainObject(obj.routeSubject, "routeSubject");

  let taskSubject!: TaskSubjectV1;
  let routeSubject!: RouteSubjectV1;
  try {
    taskSubject = validateSubject(taskSubjectObj, "task_effectiveness") as TaskSubjectV1;
    routeSubject = validateSubject(routeSubjectObj, "live_route_compatibility") as RouteSubjectV1;
  } catch (error) {
    wrapValidationError(error);
  }
  if (jcsStringify(taskSubjectObj) !== jcsStringify(taskSubject)) {
    throw new FabricTaskError("taskSubject contains undeclared fields", "malformed_producer_outcome", "harness");
  }
  if (jcsStringify(routeSubjectObj) !== jcsStringify(routeSubject)) {
    throw new FabricTaskError("routeSubject contains undeclared fields", "malformed_producer_outcome", "harness");
  }
  if (!routeSubjectsMatch(routeSubject, taskSubject.routeSubject)) {
    throw new FabricTaskError("contradictory route subjects", "layer_subject_mismatch", "harness");
  }

  const taskClassId = assertStringField(obj, "taskClassId");
  const taskClassVersion = assertStringField(obj, "taskClassVersion");
  const subjectId = assertStringField(obj, "subjectId");
  if (!isSha256Hex(subjectId)) {
    throw new FabricTaskError("malformed producer outcome: subjectId", "malformed_producer_outcome", "harness");
  }
  const taskFixtureDigest = assertStringField(obj, "taskFixtureDigest");
  const verifierManifestDigest = assertStringField(obj, "verifierManifestDigest");
  if (!isSha256Hex(taskFixtureDigest) || !isSha256Hex(verifierManifestDigest)) {
    throw new FabricTaskError("malformed producer outcome: digest field", "malformed_producer_outcome", "harness");
  }
  const fabricCompatibilityVersion = assertStringField(obj, "fabricCompatibilityVersion");
  const sandboxProfileDigest = assertStringField(obj, "sandboxProfileDigest");
  if (!isSha256Hex(sandboxProfileDigest)) {
    throw new FabricTaskError("malformed producer outcome: sandboxProfileDigest", "malformed_producer_outcome", "harness");
  }
  if (subjectId !== subjectIdForSubject(taskSubject)) {
    throw new FabricTaskError("subjectId does not match taskSubject", "malformed_producer_outcome", "harness");
  }
  if (
    taskClassId !== taskSubject.taskClassId
    || taskClassVersion !== taskSubject.taskClassVersion
    || taskFixtureDigest !== taskSubject.taskFixtureDigest
    || verifierManifestDigest !== taskSubject.verifierManifestDigest
    || fabricCompatibilityVersion !== taskSubject.fabricCompatibilityVersion
    || sandboxProfileDigest !== taskSubject.sandboxProfileDigest
  ) {
    throw new FabricTaskError("task identity fields do not match taskSubject", "malformed_producer_outcome", "harness");
  }
  const startedAt = assertNonNegativeIntegerField(obj, "startedAt");
  const completedAt = assertNonNegativeIntegerField(obj, "completedAt");
  if (completedAt < startedAt) {
    throw new FabricTaskError("invalid execution timestamps", "malformed_producer_outcome", "harness");
  }
  validateFabricLimits(assertPlainObject(obj.limits, "limits"));
  validateFabricUsage(assertPlainObject(obj.usage, "usage"));
  const verifier = assertPlainObject(obj.verifier, "verifier");
  validateFabricVerifier(verifier);
  if (verifier.manifestDigest !== verifierManifestDigest) {
    throw new FabricTaskError("verifier manifest digest does not match outcome", "malformed_producer_outcome", "harness");
  }
  if (!OUTCOMES.includes(obj.outcome as typeof OUTCOMES[number])) {
    throw new FabricTaskError("malformed producer outcome: outcome", "malformed_producer_outcome", "harness");
  }
  if (!Array.isArray(obj.artifactDigests)) {
    throw new FabricTaskError("malformed producer outcome: artifactDigests", "malformed_producer_outcome", "harness");
  }
  for (const digest of obj.artifactDigests) {
    if (typeof digest !== "string" || !isSha256Hex(digest)) {
      throw new FabricTaskError("malformed producer outcome: artifactDigests", "malformed_producer_outcome", "harness");
    }
  }
  if (obj.failure !== undefined) {
    validateFailureRecord(assertPlainObject(obj.failure, "failure"));
  }
  if (obj.sourceRefs !== undefined) {
    if (!Array.isArray(obj.sourceRefs) || !obj.sourceRefs.every((row) => typeof row === "string" && row.length > 0)) {
      throw new FabricTaskError("malformed producer outcome: sourceRefs", "malformed_producer_outcome", "harness");
    }
  }

  return raw as FabricTaskOutcomeV1;
}

/** Convert a validated fabric outcome into a ledger-ready observation and artifacts. */
export function observationFromFabricOutcome(
  outcomeRaw: unknown,
  opts: PersistFabricOptions = {},
): { event: ObservationEvent; artifacts: ReturnType<ArtifactStore["put"]>[] } {
  const outcome = assertFabricOutcomeV1(outcomeRaw);
  const taskSubject = outcome.taskSubject as TaskSubjectV1;
  const routeSubject = outcome.routeSubject as RouteSubjectV1;
  if (taskSubject.subjectKind !== "task") {
    throw new FabricTaskError("task layer requires TaskSubjectV1", "layer_subject_mismatch", "harness");
  }
  if (routeSubject.subjectKind !== "route") {
    throw new FabricTaskError("nested route subject required", "layer_subject_mismatch", "harness");
  }

  const paths = ensureLabDirs(opts.configDir);
  const ownsStore = !opts.artifactStore;
  const store = opts.artifactStore ?? createArtifactStore(paths.artifactsDir);
  try {
    const authority = loadFabricCaseAuthority();
    const caseRecord = authority.cases.find((row) => row.id === FABRIC_SCENARIO_ID);
    if (!caseRecord) {
      throw new FabricTaskError(`missing fabric scenario ${FABRIC_SCENARIO_ID}`, "harness_failure", "harness");
    }
    const scenarioDigest = fabricScenarioManifestDigest(caseRecord, authority);
    const suiteDigest = fabricSuiteManifestDigest(FABRIC_SUITE_ID, authority);
    const expandedScenario = expandFabricScenario(caseRecord, authority);
    const expandedSuite = expandFabricSuiteManifest(FABRIC_SUITE_ID, authority);
    const fixtureBytes = new TextEncoder().encode(caseRecord.fixture.bytesUtf8);
    const fixtureDigests = [fixtureDigest(fixtureBytes)];

    const artifacts: ReturnType<ArtifactStore["put"]>[] = [];
    artifacts.push(store.put({
      artifactClass: "fixture",
      payload: fixtureBytes,
      expectedDigest: fixtureDigests[0],
      mediaType: caseRecord.fixture.mediaType,
    }));
    artifacts.push(store.put({
      artifactClass: "scenario_manifest",
      payload: expandedScenario,
      expectedDigest: scenarioDigest,
    }));
    artifacts.push(store.put({
      artifactClass: "suite_manifest",
      payload: expandedSuite,
      expectedDigest: suiteDigest,
    }));
    artifacts.push(store.put({
      artifactClass: "verifier_summary",
      payload: sanitizedVerifierSummary(outcome),
    }));

    const limits: Record<string, number | null> = {};
    for (const key of OBSERVATION_LIMIT_NAMES) {
      if (key in authority.manifestDefaults.executionLimits) {
        limits[key] = authority.manifestDefaults.executionLimits[key] ?? null;
      }
    }

    const recordedAt = opts.recordedAt ?? outcome.completedAt;
    const eventWithoutId = {
      schemaVersion: LAB_EVENT_SCHEMA_VERSION,
      eventKind: "observation" as const,
      recordedAt,
      producer: LAB_PRODUCER,
      producerVersion: opts.producerVersion ?? LAB_PRODUCER_VERSION,
      evidenceLayer: FABRIC_EVIDENCE_LAYER,
      scenarioId: FABRIC_SCENARIO_ID,
      scenarioVersion: FABRIC_SCENARIO_VERSION,
      scenarioManifestDigest: scenarioDigest,
      suiteId: FABRIC_SUITE_ID,
      suiteVersion: FABRIC_SUITE_VERSION,
      suiteManifestDigest: suiteDigest,
      fixtureDigests,
      subject: outcome.taskSubject,
      subjectId: outcome.subjectId,
      startedAt: outcome.startedAt,
      completedAt: outcome.completedAt,
      executionMode: "fabric" as const,
      attempt: opts.attempt ?? 1,
      limits,
      outcome: outcome.outcome,
      assertions: [{
        id: "exact-tree-diff-pass",
        operator: "equals",
        required: true,
        passed: outcome.verifier.passed,
        expectedSummary: "pass",
        observedSummary: truncateUtf8(sanitizeDiagnostic(outcome.verifier.reason ?? (outcome.verifier.passed ? "pass" : "fail")), 512),
      }],
      environment: {
        runtime: {
          platform: process.platform,
          arch: process.arch,
          bunVersion: process.versions.bun ?? Bun.version,
        },
      },
      artifactRefs: artifacts,
      ...(outcome.failure ? { failure: outcome.failure } : {}),
      ...(outcome.sourceRefs ? { sourceRefs: [...outcome.sourceRefs] } : {}),
    };
    return { event: assignEventId(eventWithoutId) as ObservationEvent, artifacts };
  } finally {
    if (ownsStore) store.close();
  }
}

/** Module-private ledger append helper; production evidence must use {@link persistFabricRunResult}. */
function persistFabricOutcome(
  outcome: FabricTaskOutcomeV1,
  opts: PersistFabricOptions = {},
): PersistedFabricObservation {
  const paths = ensureLabDirs(opts.configDir);
  const ownsStore = !opts.artifactStore;
  const store = opts.artifactStore ?? createArtifactStore(paths.artifactsDir);
  try {
    return withLedgerMutation(paths.ledgerPath, (ledger) => {
      const { event } = observationFromFabricOutcome(outcome, { ...opts, artifactStore: store });
      ledger.appendIfAbsent(event);
      return { event, ledgerPath: paths.ledgerPath };
    });
  } finally {
    if (ownsStore) store.close();
  }
}

/** Persist production fabric evidence from a trusted-route run result. */
export function persistFabricRunResult(
  result: FabricTaskRunResult,
  opts: PersistFabricOptions = {},
): PersistedFabricObservation {
  if (result.executionAuthority !== "trusted_route") {
    throw new FabricTaskError(
      "fabric evidence requires trusted route execution authority",
      "malformed_producer_outcome",
      "harness",
    );
  }
  return persistFabricOutcome(result.outcome, opts);
}
