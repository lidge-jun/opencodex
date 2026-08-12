import { jcsStringify } from "../digest";
import { publicArtifactId, publicEvidenceId } from "./ids";
import { projectPublicEvidenceRecord, type ProjectPublicEvidenceRecordInput } from "./project";
import {
  PUBLIC_EVIDENCE_BUNDLE_SCHEMA_VERSION,
  PUBLIC_EXPORT_POLICY_VERSION,
  type PublicArtifactV1,
  type PublicEvidenceBundleUnsignedV1,
  type PublicProjectionNotExportableReason,
} from "./types";
import { PublicEvidenceValidationError, validatePublicEvidenceRecord } from "./validate";

const MAX_RECORDS = 256;
const MAX_ARTIFACTS = 16;
const MAX_ARTIFACT_BYTES = 256 * 1024;
const MAX_AGGREGATE_ARTIFACT_BYTES = 1024 * 1024;
const MAX_BUNDLE_BYTES = 2 * 1024 * 1024;
const MAX_STRING_BYTES = 4 * 1024;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function assertClosedKeys(raw: Record<string, unknown>, allowed: readonly string[], field: string): void {
  const set = new Set(allowed);
  for (const key of Object.keys(raw)) {
    if (!set.has(key)) throw new PublicEvidenceValidationError("unknown_field", `${field}.${key}`);
  }
}

function assertDay(value: unknown, field: string): string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new PublicEvidenceValidationError("invalid_day", `${field} must be YYYY-MM-DD`);
  }
  const date = new Date(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
    throw new PublicEvidenceValidationError("invalid_day", `${field} is invalid`);
  }
  return value;
}

function assertHex(value: unknown, field: string): string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) {
    throw new PublicEvidenceValidationError("invalid_id", `${field} must be lowercase sha256 hex`);
  }
  return value;
}

function decodeCanonicalBase64(value: unknown, field: string): Uint8Array {
  if (typeof value !== "string" || new TextEncoder().encode(value).byteLength > Math.ceil(MAX_ARTIFACT_BYTES * 4 / 3) + 8) {
    throw new PublicEvidenceValidationError("artifact_encoding", `${field} is invalid or oversized`);
  }
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new PublicEvidenceValidationError("artifact_encoding", `${field} is not canonical base64`);
  }
  const bytes = Uint8Array.from(Buffer.from(value, "base64"));
  if (Buffer.from(bytes).toString("base64") !== value) {
    throw new PublicEvidenceValidationError("artifact_encoding", `${field} is not canonical base64`);
  }
  return bytes;
}

function validateArtifact(raw: unknown, index: number): PublicArtifactV1 {
  if (!isPlainObject(raw)) throw new PublicEvidenceValidationError("invalid_artifact", `artifacts[${index}]`);
  assertClosedKeys(raw, ["artifactId", "mediaType", "byteCount", "contentBase64"], `artifacts[${index}]`);
  const artifactId = assertHex(raw.artifactId, `artifacts[${index}].artifactId`);
  if (raw.mediaType !== "application/json" && raw.mediaType !== "text/plain; charset=utf-8") {
    throw new PublicEvidenceValidationError("artifact_media_type", `artifacts[${index}].mediaType`);
  }
  if (!Number.isSafeInteger(raw.byteCount) || (raw.byteCount as number) < 0 || (raw.byteCount as number) > MAX_ARTIFACT_BYTES) {
    throw new PublicEvidenceValidationError("artifact_size", `artifacts[${index}].byteCount`);
  }
  const contentBase64 = typeof raw.contentBase64 === "string" ? raw.contentBase64 : "";
  const bytes = decodeCanonicalBase64(contentBase64, `artifacts[${index}].contentBase64`);
  if (bytes.byteLength !== raw.byteCount) throw new PublicEvidenceValidationError("artifact_size", `artifacts[${index}] byteCount mismatch`);
  if (publicArtifactId(bytes) !== artifactId) throw new PublicEvidenceValidationError("artifact_digest", `artifacts[${index}] id mismatch`);
  return { artifactId, mediaType: raw.mediaType, byteCount: raw.byteCount as number, contentBase64 };
}

function bundlePayload(bundle: Omit<PublicEvidenceBundleUnsignedV1, "bundleId">): Omit<PublicEvidenceBundleUnsignedV1, "bundleId"> {
  return bundle;
}

export function validatePublicEvidenceBundleUnsigned(raw: unknown): PublicEvidenceBundleUnsignedV1 {
  if (!isPlainObject(raw)) throw new PublicEvidenceValidationError("invalid_bundle", "bundle must be object");
  assertClosedKeys(raw, ["schemaVersion", "exportPolicyVersion", "bundleId", "createdDayUtc", "records", "artifacts"], "bundle");
  if (raw.schemaVersion !== PUBLIC_EVIDENCE_BUNDLE_SCHEMA_VERSION) throw new PublicEvidenceValidationError("unsupported_version", "bundle schemaVersion");
  if (raw.exportPolicyVersion !== PUBLIC_EXPORT_POLICY_VERSION) throw new PublicEvidenceValidationError("unsupported_version", "bundle exportPolicyVersion");
  const bundleId = assertHex(raw.bundleId, "bundleId");
  const createdDayUtc = assertDay(raw.createdDayUtc, "createdDayUtc");
  if (!Array.isArray(raw.records) || raw.records.length > MAX_RECORDS) throw new PublicEvidenceValidationError("record_limit", "bundle records invalid or oversized");
  if (!Array.isArray(raw.artifacts) || raw.artifacts.length > MAX_ARTIFACTS) throw new PublicEvidenceValidationError("artifact_limit", "bundle artifacts invalid or oversized");

  const records = raw.records.map(validatePublicEvidenceRecord);
  const artifacts = raw.artifacts.map(validateArtifact);
  if (new Set(records.map((record) => record.recordId)).size !== records.length) throw new PublicEvidenceValidationError("duplicate_record", "bundle record ids must be unique");
  if (new Set(artifacts.map((artifact) => artifact.artifactId)).size !== artifacts.length) throw new PublicEvidenceValidationError("duplicate_artifact", "bundle artifact ids must be unique");
  const artifactIds = new Set(artifacts.map((artifact) => artifact.artifactId));
  for (const record of records) {
    for (const ref of record.artifactRefs ?? []) {
      if (!artifactIds.has(ref)) throw new PublicEvidenceValidationError("unknown_artifact_ref", `${record.recordId} references absent artifact`);
    }
  }
  const aggregateArtifactBytes = artifacts.reduce((sum, artifact) => sum + artifact.byteCount, 0);
  if (aggregateArtifactBytes > MAX_AGGREGATE_ARTIFACT_BYTES) throw new PublicEvidenceValidationError("artifact_limit", "aggregate public artifact bytes exceeded");

  const normalized: PublicEvidenceBundleUnsignedV1 = {
    schemaVersion: PUBLIC_EVIDENCE_BUNDLE_SCHEMA_VERSION,
    exportPolicyVersion: PUBLIC_EXPORT_POLICY_VERSION,
    bundleId,
    createdDayUtc,
    records,
    artifacts,
  };
  const expected = publicEvidenceId("bundle", bundlePayload({
    schemaVersion: normalized.schemaVersion,
    exportPolicyVersion: normalized.exportPolicyVersion,
    createdDayUtc,
    records,
    artifacts,
  }));
  if (expected !== bundleId) throw new PublicEvidenceValidationError("bundle_digest", "bundleId does not match canonical public bytes");
  if (new TextEncoder().encode(jcsStringify(normalized)).byteLength > MAX_BUNDLE_BYTES) throw new PublicEvidenceValidationError("bundle_limit", "serialized public bundle exceeds limit");
  for (const value of [createdDayUtc, ...records.flatMap((record) => [record.suiteId, record.suiteVersion, record.scenarioId, record.scenarioVersion])]) {
    if (new TextEncoder().encode(value).byteLength > MAX_STRING_BYTES) throw new PublicEvidenceValidationError("field_too_large", "public bundle string exceeds limit");
  }
  return normalized;
}

export function projectPublicEvidence(input: {
  createdDayUtc: string;
  records: ProjectPublicEvidenceRecordInput[];
  artifacts?: PublicArtifactV1[];
}): {
  bundle: PublicEvidenceBundleUnsignedV1;
  excluded: Array<{ index: number; reason: PublicProjectionNotExportableReason }>;
} {
  if (input.records.length > MAX_RECORDS) throw new PublicEvidenceValidationError("record_limit", "export scope exceeds public record limit");
  const records = [] as PublicEvidenceBundleUnsignedV1["records"];
  const excluded: Array<{ index: number; reason: PublicProjectionNotExportableReason }> = [];
  input.records.forEach((recordInput, index) => {
    const result = projectPublicEvidenceRecord(recordInput);
    if (result.status === "exportable") records.push(result.record);
    else excluded.push({ index, reason: result.reason });
  });
  records.sort((a, b) => a.recordId.localeCompare(b.recordId));
  const artifacts = [...(input.artifacts ?? [])].sort((a, b) => a.artifactId.localeCompare(b.artifactId));
  const withoutId: Omit<PublicEvidenceBundleUnsignedV1, "bundleId"> = {
    schemaVersion: PUBLIC_EVIDENCE_BUNDLE_SCHEMA_VERSION,
    exportPolicyVersion: PUBLIC_EXPORT_POLICY_VERSION,
    createdDayUtc: assertDay(input.createdDayUtc, "createdDayUtc"),
    records,
    artifacts,
  };
  const bundle: PublicEvidenceBundleUnsignedV1 = {
    bundleId: publicEvidenceId("bundle", bundlePayload(withoutId)),
    ...withoutId,
  };
  return { bundle: validatePublicEvidenceBundleUnsigned(bundle), excluded };
}
