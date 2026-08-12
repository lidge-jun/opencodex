import { EVIDENCE_LAYERS, VERDICTS } from "../constants";
import { isSha256Hex, jcsStringify } from "../digest";
import {
  PUBLIC_ADAPTER_FAMILIES,
  PUBLIC_ROUTE_REGISTRY_SCHEMA_VERSION,
  type PublicAdapterFamilyV1,
  type PublicEvidenceRecordV1,
  type PublicEvidenceSubjectV1,
  type PublicIncidentRefV1,
  type PublicProtocolSubjectV1,
  type PublicRouteRegistryEntryV1,
  type PublicRouteRegistryManifestV1,
  type PublicRouteSubjectV1,
  type PublicTaskSubjectV1,
} from "./types";
import { publicRouteRegistryDigest } from "./registry";

const MAX_STRING_BYTES = 4 * 1024;
const MAX_ASSERTIONS = 64;
const MAX_INCIDENT_REFS = 32;
const MAX_ARTIFACT_REFS = 16;
const MAX_RECORD_BYTES = 64 * 1024;
const MAX_REGISTRY_ENTRIES = 512;
const PUBLIC_INCIDENT_REFS = new Set(
  Array.from({ length: 21 }, (_, index) => `IC-${String(index + 1).padStart(3, "0")}`),
);

export class PublicEvidenceValidationError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "PublicEvidenceValidationError";
    this.code = code;
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function assertClosedKeys(raw: Record<string, unknown>, allowed: readonly string[], field: string): void {
  const set = new Set(allowed);
  for (const key of Object.keys(raw)) {
    if (!set.has(key)) throw new PublicEvidenceValidationError("unknown_field", `${field}.${key}`);
  }
}

function assertString(value: unknown, field: string, max = MAX_STRING_BYTES): string {
  if (typeof value !== "string") throw new PublicEvidenceValidationError("invalid_type", `${field} must be string`);
  if (value.includes("\0")) throw new PublicEvidenceValidationError("nul_forbidden", `${field} contains NUL`);
  if (new TextEncoder().encode(value).byteLength > max) throw new PublicEvidenceValidationError("field_too_large", `${field} exceeds ${max} bytes`);
  return value;
}

function assertPublicToken(value: unknown, field: string, max = 256): string {
  const text = assertString(value, field, max);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/+-]*$/.test(text)) throw new PublicEvidenceValidationError("unsafe_string", `${field} contains unsupported characters`);
  return text;
}

function assertHex(value: unknown, field: string): string {
  const text = assertString(value, field, 64);
  if (!isSha256Hex(text)) throw new PublicEvidenceValidationError("invalid_id", `${field} must be lowercase sha256 hex`);
  return text;
}

function assertGitCommit(value: unknown, field: string): string {
  const text = assertString(value, field, 40);
  if (!/^[0-9a-f]{40}$/.test(text)) throw new PublicEvidenceValidationError("invalid_git_commit", `${field} must be a lowercase 40-character git commit id`);
  return text;
}

function assertAdapter(value: unknown, field: string): PublicAdapterFamilyV1 {
  const text = assertString(value, field, 64);
  if (!(PUBLIC_ADAPTER_FAMILIES as readonly string[]).includes(text)) throw new PublicEvidenceValidationError("closed_set", `${field} is not a public adapter family`);
  return text as PublicAdapterFamilyV1;
}

function assertBoolean(value: unknown, field: string): boolean {
  if (value !== true && value !== false) throw new PublicEvidenceValidationError("invalid_type", `${field} must be boolean`);
  return value;
}

function assertDay(value: unknown, field: string): string {
  const text = assertString(value, field, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) throw new PublicEvidenceValidationError("invalid_day", `${field} must be YYYY-MM-DD`);
  const parsed = new Date(`${text}T00:00:00.000Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== text) throw new PublicEvidenceValidationError("invalid_day", `${field} is not a UTC calendar day`);
  return text;
}

function assertCanonicalHttpsBaseUrl(value: unknown, field: string): string {
  const text = assertString(value, field, 512);
  try {
    const url = new URL(text);
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) throw new Error("not canonical public https endpoint");
    const normalizedPath = url.pathname.replace(/\/+$/, "") || "/";
    url.pathname = normalizedPath;
    const normalized = url.toString().replace(/\/$/, normalizedPath === "/" ? "/" : "");
    if (normalized !== text) throw new Error("not canonical");
    return text;
  } catch {
    throw new PublicEvidenceValidationError("invalid_registry_endpoint", `${field} must be a canonical https base URL`);
  }
}

export function isPublicIncidentRef(value: unknown): value is string {
  return typeof value === "string" && PUBLIC_INCIDENT_REFS.has(value);
}

function validateIncidentRefs(raw: unknown): PublicIncidentRefV1[] {
  if (!Array.isArray(raw) || raw.length > MAX_INCIDENT_REFS) throw new PublicEvidenceValidationError("invalid_incident_refs", "incidentRefs is invalid or oversized");
  const seen = new Set<string>();
  return raw.map((value, index) => {
    if (!isPlainObject(value)) throw new PublicEvidenceValidationError("invalid_incident_ref", `incidentRefs[${index}]`);
    assertClosedKeys(value, ["corpusId"], `incidentRefs[${index}]`);
    const corpusId = assertString(value.corpusId, `incidentRefs[${index}].corpusId`, 6);
    if (!isPublicIncidentRef(corpusId) || seen.has(corpusId)) throw new PublicEvidenceValidationError("invalid_incident_ref", `incidentRefs[${index}].corpusId`);
    seen.add(corpusId);
    return { corpusId };
  });
}

function validateProtocolSubject(raw: Record<string, unknown>): PublicProtocolSubjectV1 {
  assertClosedKeys(raw, ["subjectKind", "adapterFamily", "inboundProtocol", "upstreamProtocol", "surface", "compatibilityVersion"], "subject");
  if (raw.subjectKind !== "protocol") throw new PublicEvidenceValidationError("subject_kind", "protocol subjectKind mismatch");
  return {
    subjectKind: "protocol",
    adapterFamily: assertAdapter(raw.adapterFamily, "subject.adapterFamily"),
    inboundProtocol: assertAdapter(raw.inboundProtocol, "subject.inboundProtocol"),
    upstreamProtocol: assertAdapter(raw.upstreamProtocol, "subject.upstreamProtocol"),
    surface: assertPublicToken(raw.surface, "subject.surface", 128),
    compatibilityVersion: assertPublicToken(raw.compatibilityVersion, "subject.compatibilityVersion", 128),
  };
}

function validateRouteSubject(raw: Record<string, unknown>): PublicRouteSubjectV1 {
  assertClosedKeys(raw, ["subjectKind", "providerId", "modelId", "adapterFamily", "inboundProtocol", "upstreamProtocol", "surface", "compatibilityVersion", "registryVersion", "registryDigest"], "subject");
  if (raw.subjectKind !== "route") throw new PublicEvidenceValidationError("subject_kind", "route subjectKind mismatch");
  return {
    subjectKind: "route",
    providerId: assertPublicToken(raw.providerId, "subject.providerId", 128),
    modelId: assertPublicToken(raw.modelId, "subject.modelId", 256),
    adapterFamily: assertAdapter(raw.adapterFamily, "subject.adapterFamily"),
    inboundProtocol: assertAdapter(raw.inboundProtocol, "subject.inboundProtocol"),
    upstreamProtocol: assertAdapter(raw.upstreamProtocol, "subject.upstreamProtocol"),
    surface: assertPublicToken(raw.surface, "subject.surface", 128),
    compatibilityVersion: assertPublicToken(raw.compatibilityVersion, "subject.compatibilityVersion", 128),
    registryVersion: assertPublicToken(raw.registryVersion, "subject.registryVersion", 128),
    registryDigest: assertHex(raw.registryDigest, "subject.registryDigest"),
  };
}

function validateTaskSubject(raw: Record<string, unknown>): PublicTaskSubjectV1 {
  assertClosedKeys(raw, ["subjectKind", "route", "taskClassId", "taskClassVersion", "verifierAuthorityId"], "subject");
  if (raw.subjectKind !== "task" || !isPlainObject(raw.route)) throw new PublicEvidenceValidationError("subject_kind", "task subject is invalid");
  return {
    subjectKind: "task",
    route: validateRouteSubject(raw.route),
    taskClassId: assertPublicToken(raw.taskClassId, "subject.taskClassId", 256),
    taskClassVersion: assertPublicToken(raw.taskClassVersion, "subject.taskClassVersion", 128),
    verifierAuthorityId: assertPublicToken(raw.verifierAuthorityId, "subject.verifierAuthorityId", 256),
  };
}

function validateSubject(raw: unknown, layer: string): PublicEvidenceSubjectV1 {
  if (!isPlainObject(raw)) throw new PublicEvidenceValidationError("invalid_subject", "subject must be object");
  if (layer === "protocol_conformance") {
    if (raw.subjectKind !== "protocol") throw new PublicEvidenceValidationError("layer_subject_mismatch", "protocol layer requires protocol subject");
    return validateProtocolSubject(raw);
  }
  if (layer === "live_route_compatibility") {
    if (raw.subjectKind !== "route") throw new PublicEvidenceValidationError("layer_subject_mismatch", "live layer requires route subject");
    return validateRouteSubject(raw);
  }
  if (layer === "task_effectiveness") {
    if (raw.subjectKind !== "task") throw new PublicEvidenceValidationError("layer_subject_mismatch", "task layer requires task subject");
    return validateTaskSubject(raw);
  }
  throw new PublicEvidenceValidationError("unknown_layer", layer);
}

export function validatePublicEvidenceRecord(raw: unknown): PublicEvidenceRecordV1 {
  if (!isPlainObject(raw)) throw new PublicEvidenceValidationError("invalid_record", "record must be object");
  assertClosedKeys(raw, ["recordId", "subjectId", "evidenceLayer", "suiteId", "suiteVersion", "scenarioId", "scenarioVersion", "verdict", "observedDayUtc", "subject", "assertions", "incidentRefs", "artifactRefs"], "record");
  const layer = assertString(raw.evidenceLayer, "evidenceLayer", 64);
  if (!(EVIDENCE_LAYERS as readonly string[]).includes(layer)) throw new PublicEvidenceValidationError("closed_set", "evidenceLayer");
  const verdict = assertString(raw.verdict, "verdict", 32);
  if (!(VERDICTS as readonly string[]).includes(verdict)) throw new PublicEvidenceValidationError("closed_set", "verdict");
  if (!Array.isArray(raw.assertions) || raw.assertions.length > MAX_ASSERTIONS) throw new PublicEvidenceValidationError("invalid_assertions", "assertions is invalid or oversized");
  const assertions = raw.assertions.map((value, index) => {
    if (!isPlainObject(value)) throw new PublicEvidenceValidationError("invalid_assertion", `assertions[${index}]`);
    assertClosedKeys(value, ["id", "required", "passed"], `assertions[${index}]`);
    return { id: assertPublicToken(value.id, `assertions[${index}].id`, 256), required: assertBoolean(value.required, `assertions[${index}].required`), passed: assertBoolean(value.passed, `assertions[${index}].passed`) };
  });
  let artifactRefs: string[] | undefined;
  if (raw.artifactRefs !== undefined) {
    if (!Array.isArray(raw.artifactRefs) || raw.artifactRefs.length > MAX_ARTIFACT_REFS) throw new PublicEvidenceValidationError("invalid_artifact_refs", "artifactRefs is invalid or oversized");
    artifactRefs = raw.artifactRefs.map((value, index) => assertHex(value, `artifactRefs[${index}]`));
    if (new Set(artifactRefs).size !== artifactRefs.length) throw new PublicEvidenceValidationError("duplicate_artifact_ref", "artifactRefs contains duplicates");
  }
  const record: PublicEvidenceRecordV1 = {
    recordId: assertHex(raw.recordId, "recordId"),
    subjectId: assertHex(raw.subjectId, "subjectId"),
    evidenceLayer: layer as PublicEvidenceRecordV1["evidenceLayer"],
    suiteId: assertPublicToken(raw.suiteId, "suiteId", 256),
    suiteVersion: assertPublicToken(raw.suiteVersion, "suiteVersion", 128),
    scenarioId: assertPublicToken(raw.scenarioId, "scenarioId", 256),
    scenarioVersion: assertPublicToken(raw.scenarioVersion, "scenarioVersion", 128),
    verdict: verdict as PublicEvidenceRecordV1["verdict"],
    observedDayUtc: assertDay(raw.observedDayUtc, "observedDayUtc"),
    subject: validateSubject(raw.subject, layer),
    assertions,
    ...(raw.incidentRefs !== undefined ? { incidentRefs: validateIncidentRefs(raw.incidentRefs) } : {}),
    ...(artifactRefs !== undefined ? { artifactRefs } : {}),
  };
  if (new TextEncoder().encode(jcsStringify(record)).byteLength > MAX_RECORD_BYTES) throw new PublicEvidenceValidationError("record_too_large", `record exceeds ${MAX_RECORD_BYTES} bytes`);
  return record;
}

export function validatePublicRouteRegistryManifest(raw: unknown): PublicRouteRegistryManifestV1 {
  if (!isPlainObject(raw)) throw new PublicEvidenceValidationError("invalid_registry", "registry must be object");
  assertClosedKeys(raw, ["schemaVersion", "registryVersion", "sourceCommit", "entries", "manifestDigest"], "registry");
  if (raw.schemaVersion !== PUBLIC_ROUTE_REGISTRY_SCHEMA_VERSION) throw new PublicEvidenceValidationError("unsupported_version", "public route registry schema version");
  const registryVersion = assertPublicToken(raw.registryVersion, "registryVersion", 128);
  const sourceCommit = assertGitCommit(raw.sourceCommit, "sourceCommit");
  if (!Array.isArray(raw.entries) || raw.entries.length === 0 || raw.entries.length > MAX_REGISTRY_ENTRIES) throw new PublicEvidenceValidationError("invalid_registry", "registry entries are invalid or oversized");
  const seen = new Set<string>();
  const entries: PublicRouteRegistryEntryV1[] = raw.entries.map((value, index) => {
    if (!isPlainObject(value)) throw new PublicEvidenceValidationError("invalid_registry_entry", `entries[${index}]`);
    assertClosedKeys(value, ["providerId", "modelId", "adapterFamilies", "canonicalBaseUrl"], `entries[${index}]`);
    const providerId = assertPublicToken(value.providerId, `entries[${index}].providerId`, 128);
    const modelId = assertPublicToken(value.modelId, `entries[${index}].modelId`, 256);
    if (!Array.isArray(value.adapterFamilies) || value.adapterFamilies.length === 0 || value.adapterFamilies.length > 3) throw new PublicEvidenceValidationError("invalid_registry_entry", `entries[${index}].adapterFamilies`);
    const adapterFamilies = value.adapterFamilies.map((adapter, adapterIndex) => assertAdapter(adapter, `entries[${index}].adapterFamilies[${adapterIndex}]`));
    if (new Set(adapterFamilies).size !== adapterFamilies.length) throw new PublicEvidenceValidationError("invalid_registry_entry", `entries[${index}].adapterFamilies duplicates`);
    const canonicalBaseUrl = assertCanonicalHttpsBaseUrl(value.canonicalBaseUrl, `entries[${index}].canonicalBaseUrl`);
    const key = `${providerId}\0${modelId}`;
    if (seen.has(key)) throw new PublicEvidenceValidationError("duplicate_registry_entry", `entries[${index}]`);
    seen.add(key);
    return { providerId, modelId, adapterFamilies, canonicalBaseUrl };
  });
  const manifestDigest = assertHex(raw.manifestDigest, "manifestDigest");
  const expected = publicRouteRegistryDigest({ schemaVersion: PUBLIC_ROUTE_REGISTRY_SCHEMA_VERSION, registryVersion, sourceCommit, entries });
  if (manifestDigest !== expected) throw new PublicEvidenceValidationError("registry_digest_mismatch", "manifestDigest does not match canonical registry bytes");
  return { schemaVersion: PUBLIC_ROUTE_REGISTRY_SCHEMA_VERSION, registryVersion, sourceCommit, entries, manifestDigest };
}
