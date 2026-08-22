import { EVIDENCE_LAYERS, VERDICTS, type EvidenceLayer } from "../constants";
import { isSha256Hex } from "../digest";
import { publicEvidenceId } from "./ids";
import { findPublicRouteRegistryEntry } from "./registry";
import {
  PUBLIC_ADAPTER_FAMILIES,
  PUBLIC_ROUTE_REGISTRY_SCHEMA_VERSION,
  type PublicAdapterFamily,
  type PublicAssertionSummaryV1,
  type PublicEvidenceRecordV1,
  type PublicEvidenceSubjectV1,
  type PublicIncidentRefV1,
  type PublicProtocolSubjectV1,
  type PublicRouteRegistryEntryV1,
  type PublicRouteRegistryManifestV1,
  type PublicRouteSubjectV1,
  type PublicTaskSubjectV1,
} from "./types";

const MAX_PUBLIC_STRING_BYTES = 4 * 1024;
const MAX_PUBLIC_ASSERTIONS = 64;
const MAX_PUBLIC_INCIDENT_REFS = 32;
const MAX_PUBLIC_ARTIFACT_REFS = 16;
const PUBLIC_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:+-]{0,255}$/;
const UTC_DAY = /^\d{4}-\d{2}-\d{2}$/;
const SOURCE_COMMIT = /^[0-9a-f]{40}$/;

const PUBLIC_INCIDENT_CORPUS_IDS = new Set(
  Array.from({ length: 21 }, (_, index) => `IC-${String(index + 1).padStart(3, "0")}`),
);

export class PublicEvidenceValidationError extends Error {
  override readonly name = "PublicEvidenceValidationError";

  constructor(readonly code: string, message: string) {
    super(message);
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function assertObject(value: unknown, field: string): Record<string, unknown> {
  if (!isPlainObject(value)) {
    throw new PublicEvidenceValidationError("invalid_type", `${field} must be an object`);
  }
  return value;
}

function assertKnownKeys(
  raw: Record<string, unknown>,
  field: string,
  allowed: readonly string[],
): void {
  const allow = new Set(allowed);
  for (const key of Object.keys(raw)) {
    if (!allow.has(key)) {
      throw new PublicEvidenceValidationError("unknown_field", `${field}.${key} is not public schema`);
    }
  }
}

function assertString(value: unknown, field: string, max = MAX_PUBLIC_STRING_BYTES): string {
  if (typeof value !== "string") {
    throw new PublicEvidenceValidationError("invalid_type", `${field} must be a string`);
  }
  if (value.includes("\0")) {
    throw new PublicEvidenceValidationError("unsafe_public_field", `${field} contains NUL`);
  }
  if (new TextEncoder().encode(value).byteLength > max) {
    throw new PublicEvidenceValidationError("field_too_large", `${field} exceeds ${max} bytes`);
  }
  return value;
}

function assertPublicIdentifier(value: unknown, field: string): string {
  const result = assertString(value, field, 256);
  if (!PUBLIC_IDENTIFIER.test(result)) {
    throw new PublicEvidenceValidationError("unsafe_public_field", `${field} is not a closed public identifier`);
  }
  return result;
}

function assertBoolean(value: unknown, field: string): boolean {
  if (value !== true && value !== false) {
    throw new PublicEvidenceValidationError("invalid_type", `${field} must be boolean`);
  }
  return value;
}

function assertSha256(value: unknown, field: string): string {
  const result = assertString(value, field, 64);
  if (!isSha256Hex(result)) {
    throw new PublicEvidenceValidationError("invalid_digest", `${field} must be lowercase sha256 hex`);
  }
  return result;
}

function assertClosed<T extends string>(
  value: unknown,
  field: string,
  allowed: readonly T[],
): T {
  if (typeof value !== "string" || !(allowed as readonly string[]).includes(value)) {
    throw new PublicEvidenceValidationError("closed_set", `${field} is not in the public closed set`);
  }
  return value as T;
}

function assertUtcDay(value: unknown, field: string): string {
  const result = assertString(value, field, 10);
  if (!UTC_DAY.test(result)) {
    throw new PublicEvidenceValidationError("invalid_day", `${field} must be YYYY-MM-DD`);
  }
  const parsed = new Date(`${result}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== result) {
    throw new PublicEvidenceValidationError("invalid_day", `${field} must be a real UTC day`);
  }
  return result;
}

function validateAdapterFamily(value: unknown, field: string): PublicAdapterFamily {
  return assertClosed(value, field, PUBLIC_ADAPTER_FAMILIES);
}

function validateProtocolSubject(rawValue: unknown): PublicProtocolSubjectV1 {
  const raw = assertObject(rawValue, "subject");
  assertKnownKeys(raw, "subject", [
    "subjectKind",
    "compatibilityVersion",
    "adapterFamily",
    "inboundProtocol",
    "upstreamProtocol",
    "surface",
  ]);
  if (raw.subjectKind !== "protocol") {
    throw new PublicEvidenceValidationError("layer_subject_mismatch", "protocol layer requires protocol subject");
  }
  return {
    subjectKind: "protocol",
    compatibilityVersion: assertPublicIdentifier(raw.compatibilityVersion, "subject.compatibilityVersion"),
    adapterFamily: validateAdapterFamily(raw.adapterFamily, "subject.adapterFamily"),
    inboundProtocol: assertPublicIdentifier(raw.inboundProtocol, "subject.inboundProtocol"),
    upstreamProtocol: assertPublicIdentifier(raw.upstreamProtocol, "subject.upstreamProtocol"),
    surface: assertPublicIdentifier(raw.surface, "subject.surface"),
  };
}

function validateRouteSubject(rawValue: unknown): PublicRouteSubjectV1 {
  const raw = assertObject(rawValue, "subject");
  assertKnownKeys(raw, "subject", [
    "subjectKind",
    "providerId",
    "modelId",
    "adapterFamily",
    "compatibilityVersion",
  ]);
  if (raw.subjectKind !== "route") {
    throw new PublicEvidenceValidationError("layer_subject_mismatch", "route layer requires route subject");
  }
  const providerId = assertPublicIdentifier(raw.providerId, "subject.providerId");
  const modelId = assertPublicIdentifier(raw.modelId, "subject.modelId");
  const adapterFamily = validateAdapterFamily(raw.adapterFamily, "subject.adapterFamily");
  const entry = findPublicRouteRegistryEntry(providerId, modelId);
  if (!entry || !entry.adapterFamilies.includes(adapterFamily)) {
    throw new PublicEvidenceValidationError("public_registry_rejected", "route is not in the reviewed public registry");
  }
  return {
    subjectKind: "route",
    providerId,
    modelId,
    adapterFamily,
    compatibilityVersion: assertPublicIdentifier(raw.compatibilityVersion, "subject.compatibilityVersion"),
  };
}

function validateTaskSubject(rawValue: unknown): PublicTaskSubjectV1 {
  const raw = assertObject(rawValue, "subject");
  assertKnownKeys(raw, "subject", [
    "subjectKind",
    "route",
    "taskClassId",
    "taskClassVersion",
    "taskFixtureDigest",
    "verifierManifestDigest",
    "fabricCompatibilityVersion",
  ]);
  if (raw.subjectKind !== "task") {
    throw new PublicEvidenceValidationError("layer_subject_mismatch", "task layer requires task subject");
  }
  return {
    subjectKind: "task",
    route: validateRouteSubject(raw.route),
    taskClassId: assertPublicIdentifier(raw.taskClassId, "subject.taskClassId"),
    taskClassVersion: assertPublicIdentifier(raw.taskClassVersion, "subject.taskClassVersion"),
    taskFixtureDigest: assertSha256(raw.taskFixtureDigest, "subject.taskFixtureDigest"),
    verifierManifestDigest: assertSha256(raw.verifierManifestDigest, "subject.verifierManifestDigest"),
    fabricCompatibilityVersion: assertPublicIdentifier(
      raw.fabricCompatibilityVersion,
      "subject.fabricCompatibilityVersion",
    ),
  };
}

function validateSubject(raw: unknown, layer: EvidenceLayer): PublicEvidenceSubjectV1 {
  if (layer === "protocol_conformance") return validateProtocolSubject(raw);
  if (layer === "live_route_compatibility") return validateRouteSubject(raw);
  if (layer === "task_effectiveness") return validateTaskSubject(raw);
  const _exhaustive: never = layer;
  throw new PublicEvidenceValidationError("unsupported_layer", String(_exhaustive));
}

function validateAssertion(rawValue: unknown, index: number): PublicAssertionSummaryV1 {
  const raw = assertObject(rawValue, `assertions[${index}]`);
  assertKnownKeys(raw, `assertions[${index}]`, ["id", "required", "passed"]);
  return {
    id: assertPublicIdentifier(raw.id, `assertions[${index}].id`),
    required: assertBoolean(raw.required, `assertions[${index}].required`),
    passed: assertBoolean(raw.passed, `assertions[${index}].passed`),
  };
}

export function isPublicIncidentRef(value: unknown): value is string {
  return typeof value === "string" && PUBLIC_INCIDENT_CORPUS_IDS.has(value);
}

function validateIncidentRef(rawValue: unknown, index: number): PublicIncidentRefV1 {
  const raw = assertObject(rawValue, `incidentRefs[${index}]`);
  assertKnownKeys(raw, `incidentRefs[${index}]`, ["corpusId"]);
  const corpusId = assertString(raw.corpusId, `incidentRefs[${index}].corpusId`, 6);
  if (!isPublicIncidentRef(corpusId)) {
    throw new PublicEvidenceValidationError("incident_ref_rejected", `${corpusId} is not in the reviewed corpus`);
  }
  return { corpusId };
}

function validateUniqueIds(rawValue: unknown, field: string, max: number): string[] {
  if (!Array.isArray(rawValue)) {
    throw new PublicEvidenceValidationError("invalid_type", `${field} must be an array`);
  }
  if (rawValue.length > max) {
    throw new PublicEvidenceValidationError("array_too_large", `${field} exceeds ${max}`);
  }
  const values = rawValue.map((value, index) => assertSha256(value, `${field}[${index}]`));
  if (new Set(values).size !== values.length) {
    throw new PublicEvidenceValidationError("duplicate_id", `${field} contains duplicates`);
  }
  return values;
}

export function validatePublicEvidenceRecord(rawValue: unknown): PublicEvidenceRecordV1 {
  const raw = assertObject(rawValue, "record");
  assertKnownKeys(raw, "record", [
    "recordId",
    "subjectId",
    "evidenceLayer",
    "suiteId",
    "suiteVersion",
    "scenarioId",
    "scenarioVersion",
    "verdict",
    "observedDayUtc",
    "subject",
    "assertions",
    "incidentRefs",
    "artifactRefs",
  ]);

  const evidenceLayer = assertClosed(raw.evidenceLayer, "record.evidenceLayer", EVIDENCE_LAYERS);
  const subject = validateSubject(raw.subject, evidenceLayer);
  const subjectId = assertSha256(raw.subjectId, "record.subjectId");
  const expectedSubjectId = publicEvidenceId("subject", subject);
  if (subjectId !== expectedSubjectId) {
    throw new PublicEvidenceValidationError("subject_id_mismatch", "record.subjectId does not match public subject");
  }

  if (!Array.isArray(raw.assertions)) {
    throw new PublicEvidenceValidationError("invalid_type", "record.assertions must be an array");
  }
  if (raw.assertions.length > MAX_PUBLIC_ASSERTIONS) {
    throw new PublicEvidenceValidationError("array_too_large", `record.assertions exceeds ${MAX_PUBLIC_ASSERTIONS}`);
  }
  const assertions = raw.assertions.map(validateAssertion);

  let incidentRefs: PublicIncidentRefV1[] | undefined;
  if (raw.incidentRefs !== undefined) {
    if (!Array.isArray(raw.incidentRefs)) {
      throw new PublicEvidenceValidationError("invalid_type", "record.incidentRefs must be an array");
    }
    if (raw.incidentRefs.length > MAX_PUBLIC_INCIDENT_REFS) {
      throw new PublicEvidenceValidationError(
        "array_too_large",
        `record.incidentRefs exceeds ${MAX_PUBLIC_INCIDENT_REFS}`,
      );
    }
    incidentRefs = raw.incidentRefs.map(validateIncidentRef);
    const ids = incidentRefs.map((ref) => ref.corpusId);
    if (new Set(ids).size !== ids.length) {
      throw new PublicEvidenceValidationError("duplicate_id", "record.incidentRefs contains duplicates");
    }
  }

  const artifactRefs = raw.artifactRefs === undefined
    ? undefined
    : validateUniqueIds(raw.artifactRefs, "record.artifactRefs", MAX_PUBLIC_ARTIFACT_REFS);

  const withoutRecordId: Omit<PublicEvidenceRecordV1, "recordId"> = {
    subjectId,
    evidenceLayer,
    suiteId: assertPublicIdentifier(raw.suiteId, "record.suiteId"),
    suiteVersion: assertPublicIdentifier(raw.suiteVersion, "record.suiteVersion"),
    scenarioId: assertPublicIdentifier(raw.scenarioId, "record.scenarioId"),
    scenarioVersion: assertPublicIdentifier(raw.scenarioVersion, "record.scenarioVersion"),
    verdict: assertClosed(raw.verdict, "record.verdict", VERDICTS),
    observedDayUtc: assertUtcDay(raw.observedDayUtc, "record.observedDayUtc"),
    subject,
    assertions,
    ...(incidentRefs !== undefined ? { incidentRefs } : {}),
    ...(artifactRefs !== undefined ? { artifactRefs } : {}),
  };
  const recordId = assertSha256(raw.recordId, "record.recordId");
  const expectedRecordId = publicEvidenceId("record", withoutRecordId);
  if (recordId !== expectedRecordId) {
    throw new PublicEvidenceValidationError("record_id_mismatch", "record.recordId does not match public record");
  }
  return { recordId, ...withoutRecordId };
}

function validateRegistryEntry(rawValue: unknown, index: number): PublicRouteRegistryEntryV1 {
  const raw = assertObject(rawValue, `entries[${index}]`);
  assertKnownKeys(raw, `entries[${index}]`, ["providerId", "modelId", "adapterFamilies"]);
  if (!Array.isArray(raw.adapterFamilies) || raw.adapterFamilies.length === 0) {
    throw new PublicEvidenceValidationError("invalid_registry", `entries[${index}].adapterFamilies must be non-empty`);
  }
  const adapterFamilies = raw.adapterFamilies.map((value, adapterIndex) =>
    validateAdapterFamily(value, `entries[${index}].adapterFamilies[${adapterIndex}]`)
  );
  if (new Set(adapterFamilies).size !== adapterFamilies.length) {
    throw new PublicEvidenceValidationError("duplicate_id", `entries[${index}].adapterFamilies contains duplicates`);
  }
  return {
    providerId: assertPublicIdentifier(raw.providerId, `entries[${index}].providerId`),
    modelId: assertPublicIdentifier(raw.modelId, `entries[${index}].modelId`),
    adapterFamilies,
  };
}

export function validatePublicRouteRegistryManifest(rawValue: unknown): PublicRouteRegistryManifestV1 {
  const raw = assertObject(rawValue, "publicRouteRegistry");
  assertKnownKeys(raw, "publicRouteRegistry", [
    "schemaVersion",
    "registryVersion",
    "sourceCommit",
    "entries",
    "manifestDigest",
  ]);
  if (raw.schemaVersion !== PUBLIC_ROUTE_REGISTRY_SCHEMA_VERSION) {
    throw new PublicEvidenceValidationError("unsupported_version", "unsupported public route registry schema");
  }
  const registryVersion = assertPublicIdentifier(raw.registryVersion, "publicRouteRegistry.registryVersion");
  const sourceCommit = assertString(raw.sourceCommit, "publicRouteRegistry.sourceCommit", 40);
  if (!SOURCE_COMMIT.test(sourceCommit)) {
    throw new PublicEvidenceValidationError("invalid_registry", "publicRouteRegistry.sourceCommit must be a commit SHA");
  }
  if (!Array.isArray(raw.entries) || raw.entries.length === 0 || raw.entries.length > 512) {
    throw new PublicEvidenceValidationError("invalid_registry", "publicRouteRegistry.entries must contain 1..512 entries");
  }
  const entries = raw.entries.map(validateRegistryEntry);
  const identities = entries.map((entry) => `${entry.providerId}\0${entry.modelId}`);
  if (new Set(identities).size !== identities.length) {
    throw new PublicEvidenceValidationError("duplicate_id", "publicRouteRegistry.entries contains duplicates");
  }
  const manifestDigest = assertSha256(raw.manifestDigest, "publicRouteRegistry.manifestDigest");
  const expectedDigest = publicEvidenceId("route_registry", {
    schemaVersion: PUBLIC_ROUTE_REGISTRY_SCHEMA_VERSION,
    registryVersion,
    sourceCommit,
    entries,
  });
  if (manifestDigest !== expectedDigest) {
    throw new PublicEvidenceValidationError("digest_invalid", "publicRouteRegistry.manifestDigest mismatch");
  }
  return {
    schemaVersion: PUBLIC_ROUTE_REGISTRY_SCHEMA_VERSION,
    registryVersion,
    sourceCommit,
    entries,
    manifestDigest,
  };
}
