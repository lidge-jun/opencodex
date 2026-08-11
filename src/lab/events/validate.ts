import { enforceEventStructureLimits } from "./limits";
import { LabValidationError } from "./errors";
export { LabValidationError } from "./errors";
import {
  ARTIFACT_CLASSES,
  ARTIFACT_FILENAME_EXT,
  CLAIM_POLARITIES,
  CLAIM_SOURCE_KINDS,
  EVIDENCE_LAYERS,
  EVENT_KINDS,
  EXECUTION_MODES,
  INVALIDATION_REASONS,
  LAB_EVENT_SCHEMA_VERSION,
  MAX_INVALIDATION_TARGETS,
  MAX_SANITIZED_STRING_FIELD,
  MAX_SERIALIZED_EVENT_BYTES,
  OBSERVATION_LIMIT_NAMES,
  OUTCOMES,
  PURGE_ACTIONS,
  type ArtifactClass,
  type ClaimSourceKind,
  type EvidenceLayer,
  type LabEventKind,
} from "../constants";
import {
  claimSourceManifestDigest,
  eventIdForPayload,
  isSha256Hex,
  jcsStringify,
  subjectIdForSubject,
} from "../digest";
import { FAILURE_CLASSIFICATIONS } from "../conformance/types";
import type {
  ArtifactRefV1,
  ClaimCapabilityFactsV1,
  ClaimSnapshotEvent,
  ClaimSourceManifestV1,
  ClaimSourceV1,
  EvidenceSubjectV1,
  InvalidationEvent,
  LabEvent,
  ObservationEvent,
  ProtocolSubjectV1,
  PurgeTombstoneEvent,
  RouteCapabilityEvidenceV1,
  RouteSubjectV1,
  TaskSubjectV1,
} from "./types";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function assertString(value: unknown, field: string, max = MAX_SANITIZED_STRING_FIELD): string {
  if (typeof value !== "string") throw new LabValidationError("invalid_type", `${field} must be string`);
  const bytes = new TextEncoder().encode(value).byteLength;
  if (bytes > max) throw new LabValidationError("field_too_large", `${field} exceeds ${max} bytes`);
  if (value.includes("\0")) throw new LabValidationError("nul_forbidden", `${field} contains NUL`);
  return value;
}

function assertIntMs(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new LabValidationError("invalid_timestamp", `${field} must be UTC epoch milliseconds`);
  }
  return value;
}

function assertClosed<T extends string>(value: unknown, field: string, allowed: readonly T[]): T {
  if (typeof value !== "string" || !(allowed as readonly string[]).includes(value)) {
    throw new LabValidationError("closed_set", `${field} must be one of ${allowed.join("|")}`);
  }
  return value as T;
}

function utf8LexLess(a: string, b: string): boolean {
  const ae = new TextEncoder().encode(a);
  const be = new TextEncoder().encode(b);
  const n = Math.min(ae.length, be.length);
  for (let i = 0; i < n; i++) {
    if (ae[i]! < be[i]!) return true;
    if (ae[i]! > be[i]!) return false;
  }
  return ae.length < be.length;
}

/** Sorted unique lowercase SHA-256 hex IDs; rejects duplicates / unsorted / uppercase. */
export function validateSortedUniqueHexIds(
  ids: unknown,
  field: string,
  opts: { nonEmpty?: boolean; max?: number } = {},
): string[] {
  if (!Array.isArray(ids)) throw new LabValidationError("invalid_type", `${field} must be array`);
  if (opts.nonEmpty && ids.length === 0) {
    throw new LabValidationError("empty_targets", `${field} must be non-empty`);
  }
  if (opts.max !== undefined && ids.length > opts.max) {
    throw new LabValidationError("too_many_targets", `${field} exceeds ${opts.max}`);
  }
  const out: string[] = [];
  for (let i = 0; i < ids.length; i++) {
    const id = ids[i];
    if (typeof id !== "string" || !isSha256Hex(id)) {
      throw new LabValidationError("invalid_id", `${field}[${i}] must be lowercase sha256 hex`);
    }
    if (i > 0) {
      const prev = out[i - 1]!;
      if (id === prev) throw new LabValidationError("duplicate_id", `${field} contains duplicates`);
      if (!utf8LexLess(prev, id)) {
        throw new LabValidationError("unsorted_ids", `${field} must be UTF-8 lexicographically sorted`);
      }
    }
    out.push(id);
  }
  return out;
}

function validateArtifactRef(raw: unknown, index: number): ArtifactRefV1 {
  if (!isPlainObject(raw)) throw new LabValidationError("invalid_artifact_ref", `artifactRefs[${index}]`);
  const digest = assertString(raw.digest, `artifactRefs[${index}].digest`);
  if (!isSha256Hex(digest)) throw new LabValidationError("invalid_digest", `artifactRefs[${index}].digest`);
  const mediaType = assertString(raw.mediaType, `artifactRefs[${index}].mediaType`, 256);
  if (typeof raw.byteCount !== "number" || !Number.isInteger(raw.byteCount) || raw.byteCount < 0) {
    throw new LabValidationError("invalid_byte_count", `artifactRefs[${index}].byteCount`);
  }
  const redactionPolicy = assertString(raw.redactionPolicy, `artifactRefs[${index}].redactionPolicy`, 256);
  const relativePath = assertString(raw.relativePath, `artifactRefs[${index}].relativePath`, 128);
  if (relativePath !== `${digest}${ARTIFACT_FILENAME_EXT}`) {
    throw new LabValidationError("invalid_relative_path", `artifactRefs[${index}].relativePath must be digest-derived`);
  }
  if (relativePath.includes("/") || relativePath.includes("\\") || relativePath.includes("..")) {
    throw new LabValidationError("path_traversal", `artifactRefs[${index}].relativePath`);
  }
  const artifactClass = assertClosed(raw.artifactClass, `artifactRefs[${index}].artifactClass`, ARTIFACT_CLASSES);
  return { digest, mediaType, byteCount: raw.byteCount, redactionPolicy, relativePath, artifactClass };
}

function validateProtocolSubject(raw: Record<string, unknown>): ProtocolSubjectV1 {
  if (raw.subjectSchemaVersion !== 1 || raw.subjectKind !== "protocol") {
    throw new LabValidationError("invalid_subject", "protocol subject schema/kind mismatch");
  }
  return {
    subjectSchemaVersion: 1,
    subjectKind: "protocol",
    opencodexCompatibilityVersion: assertString(raw.opencodexCompatibilityVersion, "opencodexCompatibilityVersion"),
    effectiveAdapter: assertString(raw.effectiveAdapter, "effectiveAdapter"),
    inboundProtocol: assertString(raw.inboundProtocol, "inboundProtocol"),
    upstreamProtocol: assertString(raw.upstreamProtocol, "upstreamProtocol"),
    surface: assertString(raw.surface, "surface"),
    behaviorFingerprint: assertString(raw.behaviorFingerprint, "behaviorFingerprint"),
  };
}

function validateRouteSubject(raw: Record<string, unknown>): RouteSubjectV1 {
  if (raw.subjectSchemaVersion !== 1 || raw.subjectKind !== "route") {
    throw new LabValidationError("invalid_subject", "route subject schema/kind mismatch");
  }
  if (!Array.isArray(raw.dependencies)) {
    throw new LabValidationError("invalid_subject", "dependencies must be array");
  }
  const dependencies = raw.dependencies.map((dep, i) => {
    if (!isPlainObject(dep)) throw new LabValidationError("invalid_dependency", `dependencies[${i}]`);
    return {
      role: assertString(dep.role, `dependencies[${i}].role`),
      providerId: assertString(dep.providerId, `dependencies[${i}].providerId`),
      providerInstanceFingerprint: assertString(dep.providerInstanceFingerprint, `dependencies[${i}].providerInstanceFingerprint`),
      clientModelId: assertString(dep.clientModelId, `dependencies[${i}].clientModelId`),
      upstreamModelId: assertString(dep.upstreamModelId, `dependencies[${i}].upstreamModelId`),
      effectiveAdapter: assertString(dep.effectiveAdapter, `dependencies[${i}].effectiveAdapter`),
      upstreamProtocol: assertString(dep.upstreamProtocol, `dependencies[${i}].upstreamProtocol`),
      endpointFingerprint: assertString(dep.endpointFingerprint, `dependencies[${i}].endpointFingerprint`),
      behaviorFingerprint: assertString(dep.behaviorFingerprint, `dependencies[${i}].behaviorFingerprint`),
    };
  });
  return {
    subjectSchemaVersion: 1,
    subjectKind: "route",
    providerId: assertString(raw.providerId, "providerId"),
    providerInstanceFingerprint: assertString(raw.providerInstanceFingerprint, "providerInstanceFingerprint"),
    clientModelId: assertString(raw.clientModelId, "clientModelId"),
    upstreamModelId: assertString(raw.upstreamModelId, "upstreamModelId"),
    effectiveAdapter: assertString(raw.effectiveAdapter, "effectiveAdapter"),
    inboundProtocol: assertString(raw.inboundProtocol, "inboundProtocol"),
    upstreamProtocol: assertString(raw.upstreamProtocol, "upstreamProtocol"),
    surface: assertString(raw.surface, "surface"),
    opencodexCompatibilityVersion: assertString(raw.opencodexCompatibilityVersion, "opencodexCompatibilityVersion"),
    behaviorFingerprint: assertString(raw.behaviorFingerprint, "behaviorFingerprint"),
    endpointFingerprint: assertString(raw.endpointFingerprint, "endpointFingerprint"),
    dependencies,
  };
}

function validateTaskSubject(raw: Record<string, unknown>): TaskSubjectV1 {
  if (raw.subjectSchemaVersion !== 1 || raw.subjectKind !== "task") {
    throw new LabValidationError("invalid_subject", "task subject schema/kind mismatch");
  }
  if (!isPlainObject(raw.routeSubject)) {
    throw new LabValidationError("invalid_subject", "task.routeSubject required");
  }
  return {
    subjectSchemaVersion: 1,
    subjectKind: "task",
    routeSubject: validateRouteSubject(raw.routeSubject),
    taskClassId: assertString(raw.taskClassId, "taskClassId"),
    taskClassVersion: assertString(raw.taskClassVersion, "taskClassVersion"),
    taskFixtureDigest: assertString(raw.taskFixtureDigest, "taskFixtureDigest"),
    verifierManifestDigest: assertString(raw.verifierManifestDigest, "verifierManifestDigest"),
    fabricCompatibilityVersion: assertString(raw.fabricCompatibilityVersion, "fabricCompatibilityVersion"),
    sandboxProfileDigest: assertString(raw.sandboxProfileDigest, "sandboxProfileDigest"),
  };
}

export function validateSubject(raw: unknown, layer: EvidenceLayer): EvidenceSubjectV1 {
  if (!isPlainObject(raw)) throw new LabValidationError("invalid_subject", "subject must be object");
  const kind = raw.subjectKind;
  if (layer === "protocol_conformance") {
    if (kind !== "protocol") throw new LabValidationError("layer_subject_mismatch", "protocol layer requires protocol subject");
    return validateProtocolSubject(raw);
  }
  if (layer === "live_route_compatibility") {
    if (kind !== "route") throw new LabValidationError("layer_subject_mismatch", "live layer requires route subject");
    return validateRouteSubject(raw);
  }
  if (layer === "task_effectiveness") {
    if (kind !== "task") throw new LabValidationError("layer_subject_mismatch", "task layer requires task subject");
    return validateTaskSubject(raw);
  }
  const _exhaustive: never = layer;
  throw new LabValidationError("unknown_layer", String(_exhaustive));
}

function stripEventId(event: Record<string, unknown>): Record<string, unknown> {
  const { eventId: _omit, ...rest } = event;
  return rest;
}

function enforceEventId(event: LabEvent): void {
  const recomputed = eventIdForPayload(stripEventId(event as unknown as Record<string, unknown>));
  if (event.eventId !== recomputed) {
    throw new LabValidationError("event_id_mismatch", `eventId mismatch: got ${event.eventId}, expected ${recomputed}`);
  }
}

function enforceSerializedSize(event: LabEvent): void {
  const bytes = new TextEncoder().encode(jcsStringify(event)).byteLength;
  if (bytes > MAX_SERIALIZED_EVENT_BYTES) {
    throw new LabValidationError("event_too_large", `serialized event exceeds ${MAX_SERIALIZED_EVENT_BYTES} bytes`);
  }
}

function validateAssertionRecord(raw: unknown, index: number): ObservationEvent["assertions"][number] {
  if (!isPlainObject(raw)) throw new LabValidationError("invalid_assertions", `assertions[${index}]`);
  const allowed = new Set(["id", "operator", "required", "passed", "expectedSummary", "observedSummary", "reason"]);
  for (const key of Object.keys(raw)) {
    if (!allowed.has(key)) {
      throw new LabValidationError("unknown_assertion_key", `assertions[${index}].${key}`);
    }
  }
  const record = {
    id: assertString(raw.id, `assertions[${index}].id`),
    operator: assertString(raw.operator, `assertions[${index}].operator`),
    required: raw.required === true || raw.required === false
      ? raw.required
      : (() => { throw new LabValidationError("invalid_assertions", `assertions[${index}].required`); })(),
    passed: raw.passed === true || raw.passed === false
      ? raw.passed
      : (() => { throw new LabValidationError("invalid_assertions", `assertions[${index}].passed`); })(),
    expectedSummary: assertString(raw.expectedSummary, `assertions[${index}].expectedSummary`),
    observedSummary: assertString(raw.observedSummary, `assertions[${index}].observedSummary`),
    ...(raw.reason !== undefined ? { reason: assertString(raw.reason, `assertions[${index}].reason`) } : {}),
  };
  return record;
}

function validateObservationLimits(raw: unknown): Record<string, number | null> {
  if (!isPlainObject(raw)) throw new LabValidationError("invalid_limits", "limits");
  const out: Record<string, number | null> = {};
  for (const key of Object.keys(raw)) {
    if (!(OBSERVATION_LIMIT_NAMES as readonly string[]).includes(key)) {
      throw new LabValidationError("unknown_limit", `limits.${key}`);
    }
    const value = raw[key];
    if (value === null) {
      out[key] = null;
      continue;
    }
    if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
      throw new LabValidationError("invalid_limits", `limits.${key}`);
    }
    out[key] = value;
  }
  return out;
}

function validateObservationEnvironment(raw: unknown): Record<string, unknown> {
  if (!isPlainObject(raw)) throw new LabValidationError("invalid_environment", "environment");
  const topKeys = Object.keys(raw);
  if (topKeys.length !== 1 || topKeys[0] !== "runtime") {
    throw new LabValidationError("invalid_environment", "environment must contain only runtime");
  }
  const runtime = raw.runtime;
  if (!isPlainObject(runtime)) throw new LabValidationError("invalid_environment", "environment.runtime");
  const runtimeKeys = Object.keys(runtime);
  const allowedRuntime = new Set(["platform", "arch", "bunVersion"]);
  for (const key of runtimeKeys) {
    if (!allowedRuntime.has(key)) {
      throw new LabValidationError("unknown_environment_key", `environment.runtime.${key}`);
    }
  }
  const out: Record<string, unknown> = {
    runtime: {
      platform: assertString(runtime.platform, "environment.runtime.platform"),
      arch: assertString(runtime.arch, "environment.runtime.arch"),
      ...(runtime.bunVersion !== undefined
        ? { bunVersion: assertString(runtime.bunVersion, "environment.runtime.bunVersion") }
        : {}),
    },
  };
  return out;
}

function validateExpectedFailure(raw: unknown): Record<string, unknown> {
  if (!isPlainObject(raw)) throw new LabValidationError("invalid_expected_failure", "expectedFailure");
  const allowed = new Set([
    "controlKind",
    "expectedClass",
    "expectedCode",
    "assertionIds",
    "onMatch",
    "onMismatch",
  ]);
  for (const key of Object.keys(raw)) {
    if (!allowed.has(key)) {
      throw new LabValidationError("unknown_expected_failure_key", `expectedFailure.${key}`);
    }
  }
  if (!Array.isArray(raw.assertionIds) || !raw.assertionIds.every((id) => typeof id === "string")) {
    throw new LabValidationError("invalid_expected_failure", "expectedFailure.assertionIds");
  }
  return {
    controlKind: assertClosed(raw.controlKind, "expectedFailure.controlKind", [
      "conformance_negative_control",
      "capability_absence_control",
    ] as const),
    expectedClass: assertString(raw.expectedClass, "expectedFailure.expectedClass"),
    expectedCode: assertString(raw.expectedCode, "expectedFailure.expectedCode"),
    assertionIds: raw.assertionIds as string[],
    onMatch: assertClosed(raw.onMatch, "expectedFailure.onMatch", ["pass", "unsupported"] as const),
    onMismatch: assertClosed(raw.onMismatch, "expectedFailure.onMismatch", ["fail", "inconclusive"] as const),
  };
}

function validateSourceRefs(raw: unknown): string[] {
  if (!Array.isArray(raw)) throw new LabValidationError("invalid_source_refs", "sourceRefs");
  return raw.map((r, i) => assertString(r, `sourceRefs[${i}]`));
}

function validateObservation(raw: Record<string, unknown>): ObservationEvent {
  const evidenceLayer = assertClosed(raw.evidenceLayer, "evidenceLayer", EVIDENCE_LAYERS);
  const subject = validateSubject(raw.subject, evidenceLayer);
  const subjectId = assertString(raw.subjectId, "subjectId");
  if (subjectId !== subjectIdForSubject(subject)) {
    throw new LabValidationError("subject_id_mismatch", "subjectId does not match subject");
  }
  if (!Array.isArray(raw.fixtureDigests) || raw.fixtureDigests.length === 0) {
    throw new LabValidationError("missing_fixture_digests", "fixtureDigests required");
  }
  const fixtureDigests = raw.fixtureDigests.map((d, i) => {
    const digest = assertString(d, `fixtureDigests[${i}]`);
    if (!isSha256Hex(digest)) throw new LabValidationError("invalid_digest", `fixtureDigests[${i}]`);
    return digest;
  });
  const scenarioManifestDigest = assertString(raw.scenarioManifestDigest, "scenarioManifestDigest");
  const suiteManifestDigest = assertString(raw.suiteManifestDigest, "suiteManifestDigest");
  if (!isSha256Hex(scenarioManifestDigest) || !isSha256Hex(suiteManifestDigest)) {
    throw new LabValidationError("invalid_digest", "scenario/suite manifest digest");
  }
  if (!Array.isArray(raw.assertions)) throw new LabValidationError("invalid_assertions", "assertions");
  if (!Array.isArray(raw.artifactRefs)) throw new LabValidationError("invalid_artifact_refs", "artifactRefs");
  const event: ObservationEvent = {
    schemaVersion: LAB_EVENT_SCHEMA_VERSION,
    eventId: assertString(raw.eventId, "eventId"),
    eventKind: "observation",
    recordedAt: assertIntMs(raw.recordedAt, "recordedAt"),
    producer: assertString(raw.producer, "producer"),
    producerVersion: assertString(raw.producerVersion, "producerVersion"),
    evidenceLayer,
    scenarioId: assertString(raw.scenarioId, "scenarioId"),
    scenarioVersion: assertString(raw.scenarioVersion, "scenarioVersion"),
    scenarioManifestDigest,
    suiteId: assertString(raw.suiteId, "suiteId"),
    suiteVersion: assertString(raw.suiteVersion, "suiteVersion"),
    suiteManifestDigest,
    fixtureDigests,
    subject,
    subjectId,
    startedAt: assertIntMs(raw.startedAt, "startedAt"),
    completedAt: assertIntMs(raw.completedAt, "completedAt"),
    executionMode: assertClosed(raw.executionMode, "executionMode", EXECUTION_MODES),
    attempt: typeof raw.attempt === "number" && Number.isInteger(raw.attempt) && raw.attempt >= 1
      ? raw.attempt
      : (() => { throw new LabValidationError("invalid_attempt", "attempt"); })(),
    limits: validateObservationLimits(raw.limits),
    outcome: assertClosed(raw.outcome, "outcome", OUTCOMES),
    assertions: raw.assertions.map(validateAssertionRecord),
    environment: validateObservationEnvironment(raw.environment),
    artifactRefs: raw.artifactRefs.map(validateArtifactRef),
  };
  if (raw.failure !== undefined) {
    if (!isPlainObject(raw.failure)) throw new LabValidationError("invalid_failure", "failure");
    event.failure = {
      class: assertClosed(raw.failure.class, "failure.class", FAILURE_CLASSIFICATIONS),
      code: assertString(raw.failure.code, "failure.code"),
      retryable: raw.failure.retryable === true,
      attribution: assertClosed(raw.failure.attribution, "failure.attribution", [
        "opencodex",
        "route",
        "environment",
        "harness",
      ] as const),
    };
  }
  if (raw.expectedFailure !== undefined) {
    event.expectedFailure = validateExpectedFailure(raw.expectedFailure);
  }
  if (raw.sourceRefs !== undefined) {
    event.sourceRefs = validateSourceRefs(raw.sourceRefs);
  }
  if (event.completedAt < event.startedAt) {
    throw new LabValidationError("invalid_time_range", "completedAt < startedAt");
  }
  return event;
}

function validateClaimSnapshot(raw: Record<string, unknown>): ClaimSnapshotEvent {
  if (raw.evidenceLayer !== "live_route_compatibility") {
    throw new LabValidationError("invalid_claim_layer", "claims exist only for live_route_compatibility");
  }
  const subject = validateSubject(raw.subject, "live_route_compatibility") as RouteSubjectV1;
  const subjectId = assertString(raw.subjectId, "subjectId");
  if (subjectId !== subjectIdForSubject(subject)) {
    throw new LabValidationError("subject_id_mismatch", "subjectId does not match subject");
  }
  const sourceManifestDigest = assertString(raw.sourceManifestDigest, "sourceManifestDigest");
  if (!isSha256Hex(sourceManifestDigest)) {
    throw new LabValidationError("invalid_digest", "sourceManifestDigest");
  }
  return {
    schemaVersion: LAB_EVENT_SCHEMA_VERSION,
    eventId: assertString(raw.eventId, "eventId"),
    eventKind: "claim_snapshot",
    recordedAt: assertIntMs(raw.recordedAt, "recordedAt"),
    producer: assertString(raw.producer, "producer"),
    producerVersion: assertString(raw.producerVersion, "producerVersion"),
    evidenceLayer: "live_route_compatibility",
    subject,
    subjectId,
    capability: assertString(raw.capability, "capability"),
    polarity: assertClosed(raw.polarity, "polarity", CLAIM_POLARITIES),
    sourceManifestDigest,
    sourceEventIds: validateSortedUniqueHexIds(raw.sourceEventIds, "sourceEventIds", {
      nonEmpty: false,
      max: MAX_INVALIDATION_TARGETS,
    }),
    supersedes: validateSortedUniqueHexIds(raw.supersedes, "supersedes", {
      nonEmpty: false,
      max: MAX_INVALIDATION_TARGETS,
    }),
    effectiveAt: assertIntMs(raw.effectiveAt, "effectiveAt"),
  };
}

function validateInvalidation(raw: Record<string, unknown>): InvalidationEvent {
  return {
    schemaVersion: LAB_EVENT_SCHEMA_VERSION,
    eventId: assertString(raw.eventId, "eventId"),
    eventKind: "invalidation",
    recordedAt: assertIntMs(raw.recordedAt, "recordedAt"),
    producer: assertString(raw.producer, "producer"),
    producerVersion: assertString(raw.producerVersion, "producerVersion"),
    targetEventIds: validateSortedUniqueHexIds(raw.targetEventIds, "targetEventIds", {
      nonEmpty: true,
      max: MAX_INVALIDATION_TARGETS,
    }),
    reason: assertClosed(raw.reason, "reason", INVALIDATION_REASONS),
  };
}

function validatePurge(raw: Record<string, unknown>): PurgeTombstoneEvent {
  const targetEventIds = validateSortedUniqueHexIds(raw.targetEventIds ?? [], "targetEventIds", {
    nonEmpty: false,
    max: MAX_INVALIDATION_TARGETS,
  });
  const targetArtifactDigests = validateSortedUniqueHexIds(
    raw.targetArtifactDigests ?? [],
    "targetArtifactDigests",
    { nonEmpty: false, max: MAX_INVALIDATION_TARGETS },
  );
  if (raw.reason !== "sensitive_evidence") {
    throw new LabValidationError("invalid_purge_reason", "reason must be sensitive_evidence");
  }
  if (!Array.isArray(raw.purgeActions) || raw.purgeActions.length === 0) {
    throw new LabValidationError("empty_purge_actions", "purgeActions required");
  }
  const purgeActions = raw.purgeActions.map((a, i) =>
    assertClosed(a, `purgeActions[${i}]`, PURGE_ACTIONS),
  );
  for (let i = 0; i < purgeActions.length; i++) {
    for (let j = i + 1; j < purgeActions.length; j++) {
      if (purgeActions[i] === purgeActions[j]) {
        throw new LabValidationError("duplicate_purge_action", "purgeActions must be unique");
      }
    }
  }
  const sortedActions = [...purgeActions].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  for (let i = 0; i < purgeActions.length; i++) {
    if (purgeActions[i] !== sortedActions[i]) {
      throw new LabValidationError("unsorted_purge_actions", "purgeActions must be sorted");
    }
  }
  // Directory-scoped actions (scratch/export) are meaningful without event or
  // artifact ids — default sensitive purge wipes those trees and still records
  // a tombstone. Ledger/sqlite/artifact-only tombstones still need a target.
  const hasDirectoryPurge = purgeActions.includes("scratch") || purgeActions.includes("export");
  if (
    targetEventIds.length === 0
    && targetArtifactDigests.length === 0
    && !hasDirectoryPurge
  ) {
    throw new LabValidationError("empty_purge_targets", "at least one purge target required");
  }
  return {
    schemaVersion: LAB_EVENT_SCHEMA_VERSION,
    eventId: assertString(raw.eventId, "eventId"),
    eventKind: "purge_tombstone",
    recordedAt: assertIntMs(raw.recordedAt, "recordedAt"),
    producer: assertString(raw.producer, "producer"),
    producerVersion: assertString(raw.producerVersion, "producerVersion"),
    targetEventIds,
    targetArtifactDigests,
    reason: "sensitive_evidence",
    purgeActions,
  };
}

/** Structural validation of a parsed JSON object into a LabEvent (fail-closed). */
export function validateLabEvent(raw: unknown): LabEvent {
  if (!isPlainObject(raw)) throw new LabValidationError("invalid_event", "event must be object");
  if (raw.schemaVersion !== LAB_EVENT_SCHEMA_VERSION) {
    throw new LabValidationError("schema_version", "unsupported schemaVersion");
  }
  const kind = assertClosed(raw.eventKind, "eventKind", EVENT_KINDS) as LabEventKind;
  let event: LabEvent;
  switch (kind) {
    case "observation":
      event = validateObservation(raw);
      break;
    case "claim_snapshot":
      event = validateClaimSnapshot(raw);
      break;
    case "invalidation":
      event = validateInvalidation(raw);
      break;
    case "purge_tombstone":
      event = validatePurge(raw);
      break;
    default: {
      const _never: never = kind;
      throw new LabValidationError("unknown_kind", String(_never));
    }
  }
  enforceEventId(event);
  enforceEventStructureLimits(event);
  enforceSerializedSize(event);
  return event;
}

const FORBIDDEN_FACT_KEYS = new Set([
  "baseUrl",
  "hostname",
  "url",
  "headers",
  "authorization",
  "apiKey",
  "credential",
  "account",
  "email",
  "path",
  "prompt",
  "repository",
]);

const ALLOWED_FACT_KEYS = new Set([
  "contextWindow",
  "inputModalities",
  "reasoningEfforts",
  "catalogCapabilityNames",
  "serviceTier",
  "toolCapable",
  "parallelToolCalls",
  "endpointLocality",
  "canonicalOpenAiForward",
]);

function validateFacts(raw: unknown, label: string): ClaimCapabilityFactsV1 {
  if (!isPlainObject(raw)) throw new LabValidationError("invalid_facts", label);
  for (const key of Object.keys(raw)) {
    if (FORBIDDEN_FACT_KEYS.has(key) || /url|host|header|secret|token|cookie|email|path/i.test(key)) {
      throw new LabValidationError("forbidden_fact", `${label}.${key} forbidden`);
    }
    if (!ALLOWED_FACT_KEYS.has(key)) {
      throw new LabValidationError("unknown_fact", `${label}.${key} unknown`);
    }
  }
  const facts: ClaimCapabilityFactsV1 = {};
  if (raw.contextWindow !== undefined) {
    if (typeof raw.contextWindow !== "number" || !Number.isInteger(raw.contextWindow) || raw.contextWindow < 0) {
      throw new LabValidationError("invalid_facts", "contextWindow");
    }
    facts.contextWindow = raw.contextWindow;
  }
  if (raw.inputModalities !== undefined) {
    if (!Array.isArray(raw.inputModalities) || !raw.inputModalities.every((x) => typeof x === "string")) {
      throw new LabValidationError("invalid_facts", "inputModalities");
    }
    facts.inputModalities = raw.inputModalities as string[];
  }
  if (raw.reasoningEfforts !== undefined) {
    if (!Array.isArray(raw.reasoningEfforts) || !raw.reasoningEfforts.every((x) => typeof x === "string")) {
      throw new LabValidationError("invalid_facts", "reasoningEfforts");
    }
    facts.reasoningEfforts = raw.reasoningEfforts as string[];
  }
  if (raw.catalogCapabilityNames !== undefined) {
    if (!Array.isArray(raw.catalogCapabilityNames) || !raw.catalogCapabilityNames.every((x) => typeof x === "string")) {
      throw new LabValidationError("invalid_facts", "catalogCapabilityNames");
    }
    facts.catalogCapabilityNames = raw.catalogCapabilityNames as string[];
  }
  if (raw.serviceTier !== undefined) {
    if (!Array.isArray(raw.serviceTier) || !raw.serviceTier.every((x) => typeof x === "string")) {
      throw new LabValidationError("invalid_facts", "serviceTier");
    }
    facts.serviceTier = raw.serviceTier as string[];
  }
  if (raw.toolCapable !== undefined) {
    if (typeof raw.toolCapable !== "boolean") throw new LabValidationError("invalid_facts", "toolCapable");
    facts.toolCapable = raw.toolCapable;
  }
  if (raw.parallelToolCalls !== undefined) {
    if (typeof raw.parallelToolCalls !== "boolean") throw new LabValidationError("invalid_facts", "parallelToolCalls");
    facts.parallelToolCalls = raw.parallelToolCalls;
  }
  if (raw.endpointLocality !== undefined) {
    facts.endpointLocality = assertClosed(raw.endpointLocality, "endpointLocality", [
      "local",
      "private",
      "unknown",
    ] as const);
  }
  if (raw.canonicalOpenAiForward !== undefined) {
    if (typeof raw.canonicalOpenAiForward !== "boolean") {
      throw new LabValidationError("invalid_facts", "canonicalOpenAiForward");
    }
    facts.canonicalOpenAiForward = raw.canonicalOpenAiForward;
  }
  return facts;
}

function validateResolvedEvidence(raw: unknown): RouteCapabilityEvidenceV1 {
  if (!isPlainObject(raw)) throw new LabValidationError("invalid_resolved", "resolvedEvidence");
  const out: RouteCapabilityEvidenceV1 = {};
  const copyBoolOrUnknown = (key: keyof RouteCapabilityEvidenceV1) => {
    const v = raw[key as string];
    if (v === undefined) return;
    if (v !== true && v !== false && v !== "unknown") {
      throw new LabValidationError("invalid_resolved", String(key));
    }
    (out as Record<string, unknown>)[key] = v;
  };
  if (raw.contextWindow !== undefined) {
    if (typeof raw.contextWindow !== "number" || !Number.isInteger(raw.contextWindow)) {
      throw new LabValidationError("invalid_resolved", "contextWindow");
    }
    out.contextWindow = raw.contextWindow;
  }
  copyBoolOrUnknown("tools");
  copyBoolOrUnknown("image");
  copyBoolOrUnknown("structuredOutput");
  copyBoolOrUnknown("localOnly");
  copyBoolOrUnknown("remoteAllowed");
  copyBoolOrUnknown("encryptedCodexTasks");
  if (raw.reasoningEfforts !== undefined) {
    if (!Array.isArray(raw.reasoningEfforts) || !raw.reasoningEfforts.every((x) => typeof x === "string")) {
      throw new LabValidationError("invalid_resolved", "reasoningEfforts");
    }
    out.reasoningEfforts = raw.reasoningEfforts as string[];
  }
  if (raw.serviceTier !== undefined) {
    if (typeof raw.serviceTier !== "string") throw new LabValidationError("invalid_resolved", "serviceTier");
    out.serviceTier = raw.serviceTier;
  }
  return out;
}

/** Validate ClaimSourceManifestV1 and return canonical object + digest. */
export function validateClaimSourceManifest(raw: unknown): {
  manifest: ClaimSourceManifestV1;
  digest: string;
} {
  if (!isPlainObject(raw)) throw new LabValidationError("invalid_claim_source", "manifest must be object");
  if (raw.schemaVersion !== 1) throw new LabValidationError("schema_version", "ClaimSourceManifest schemaVersion");
  if (!Array.isArray(raw.sources)) throw new LabValidationError("invalid_sources", "sources");
  const seen = new Set<ClaimSourceKind>();
  const sources: ClaimSourceV1[] = [];
  for (let i = 0; i < raw.sources.length; i++) {
    const src = raw.sources[i];
    if (!isPlainObject(src)) throw new LabValidationError("invalid_source", `sources[${i}]`);
    const kind = assertClosed(src.kind, `sources[${i}].kind`, CLAIM_SOURCE_KINDS);
    if (seen.has(kind)) throw new LabValidationError("duplicate_source_kind", kind);
    seen.add(kind);
    if (src.revision !== null && typeof src.revision !== "string") {
      throw new LabValidationError("invalid_revision", `sources[${i}].revision`);
    }
    sources.push({
      kind,
      revision: src.revision as string | null,
      facts: validateFacts(src.facts, `sources[${i}].facts`),
    });
  }
  // Closed kind order
  for (let i = 1; i < sources.length; i++) {
    const prevIdx = CLAIM_SOURCE_KINDS.indexOf(sources[i - 1]!.kind);
    const curIdx = CLAIM_SOURCE_KINDS.indexOf(sources[i]!.kind);
    if (curIdx <= prevIdx) {
      throw new LabValidationError("source_order", "sources must follow closed kind order");
    }
  }
  const manifest: ClaimSourceManifestV1 = {
    schemaVersion: 1,
    subjectId: assertString(raw.subjectId, "subjectId"),
    providerId: assertString(raw.providerId, "providerId"),
    clientModelId: assertString(raw.clientModelId, "clientModelId"),
    capability: assertString(raw.capability, "capability"),
    sources,
    resolvedEvidence: validateResolvedEvidence(raw.resolvedEvidence),
  };
  if (!isSha256Hex(manifest.subjectId)) {
    throw new LabValidationError("invalid_subject_id", "subjectId must be sha256 hex");
  }
  return { manifest, digest: claimSourceManifestDigest(manifest) };
}

export function assignEventId<T extends Omit<LabEvent, "eventId"> & { eventId?: string }>(
  eventWithoutId: T,
): T & { eventId: string } {
  const { eventId: _ignored, ...rest } = eventWithoutId as T & { eventId?: string };
  const eventId = eventIdForPayload(rest);
  return { ...rest, eventId } as T & { eventId: string };
}

export function artifactClassMediaType(artifactClass: ArtifactClass): string {
  switch (artifactClass) {
    case "scenario_manifest":
    case "suite_manifest":
    case "claim_source_manifest":
    case "assertion_report":
    case "request_shape":
    case "response_shape":
    case "event_trace":
    case "error_taxonomy":
    case "verifier_summary":
      return "application/json";
    case "fixture":
      return "application/octet-stream";
    default: {
      const _never: never = artifactClass;
      return _never;
    }
  }
}
