import { jcsStringify } from "../digest";
import { publicEvidenceId } from "./ids";
import {
  PUBLIC_EVIDENCE_BUNDLE_SCHEMA_VERSION,
  PUBLIC_EXPORT_POLICY_VERSION,
  type PublicArtifactV1,
  type PublicEvidenceBundleUnsignedV1,
  type PublicEvidenceRecordV1,
  type PublicPublisherV1,
} from "./types";
import { PublicEvidenceValidationError, validatePublicEvidenceRecord } from "./validate";

export const MAX_PUBLIC_BUNDLE_BYTES = 2 * 1024 * 1024;
export const MAX_PUBLIC_BUNDLE_RECORDS = 256;
export const MAX_PUBLIC_BUNDLE_ARTIFACTS = 16;
export const MAX_PUBLIC_ARTIFACT_BYTES = 256 * 1024;
export const MAX_PUBLIC_ARTIFACT_BYTES_TOTAL = 1024 * 1024;

export interface PublicEvidenceContentInput {
  records: PublicEvidenceRecordV1[];
  artifacts: PublicArtifactV1[];
  createdDayUtc: string;
}

export interface BuildPublicEvidenceBundleInput extends PublicEvidenceContentInput {
  publisher: PublicPublisherV1;
}

/** Deterministic, locale-independent code-unit ordering for canonical identity. */
function compareCanonicalId(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

function utcDay(value: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new PublicEvidenceValidationError("invalid_day", "createdDayUtc must be YYYY-MM-DD");
  }
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new PublicEvidenceValidationError("invalid_day", "createdDayUtc must be a real UTC day");
  }
  return value;
}

function validatePublisher(publisher: PublicPublisherV1): PublicPublisherV1 {
  const raw = publisher as unknown as Record<string, unknown>;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new PublicEvidenceValidationError("invalid_publisher", "publisher must be an object");
  }
  const keys = Object.keys(raw);
  if (keys.some((key) => !["algorithm", "keyId", "publicKey"].includes(key))) {
    throw new PublicEvidenceValidationError("unknown_field", "publisher contains unknown fields");
  }
  if (publisher.algorithm !== "ed25519") {
    throw new PublicEvidenceValidationError("unsupported_algorithm", "publisher must use ed25519");
  }
  if (!/^[0-9a-f]{64}$/.test(publisher.keyId)) {
    throw new PublicEvidenceValidationError("invalid_publisher", "publisher.keyId must be sha256 hex");
  }
  if (typeof publisher.publicKey !== "string" || publisher.publicKey.length === 0 || publisher.publicKey.length > 1024) {
    throw new PublicEvidenceValidationError("invalid_publisher", "publisher.publicKey is invalid");
  }
  const publicKeyBytes = Buffer.from(publisher.publicKey, "base64");
  if (publicKeyBytes.byteLength === 0 || publicKeyBytes.toString("base64") !== publisher.publicKey) {
    throw new PublicEvidenceValidationError("invalid_publisher", "publisher.publicKey must use canonical base64");
  }
  const expectedKeyId = publicEvidenceId("publisher_key", {
    algorithm: publisher.algorithm,
    publicKey: publisher.publicKey,
  });
  if (publisher.keyId !== expectedKeyId) {
    throw new PublicEvidenceValidationError("publisher_key_id_mismatch", "publisher.keyId does not match public key");
  }
  return { algorithm: "ed25519", keyId: publisher.keyId, publicKey: publisher.publicKey };
}

function validateArtifacts(artifacts: PublicArtifactV1[]): PublicArtifactV1[] {
  if (!Array.isArray(artifacts) || artifacts.length > MAX_PUBLIC_BUNDLE_ARTIFACTS) {
    throw new PublicEvidenceValidationError("array_too_large", `artifacts exceeds ${MAX_PUBLIC_BUNDLE_ARTIFACTS}`);
  }
  let aggregate = 0;
  const ids = new Set<string>();
  return artifacts.map((artifact, index) => {
    const raw = artifact as unknown as Record<string, unknown>;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new PublicEvidenceValidationError("invalid_artifact", `artifacts[${index}] must be an object`);
    }
    if (Object.keys(raw).some((key) => !["artifactId", "artifactClass", "mediaType", "byteCount", "contentBase64"].includes(key))) {
      throw new PublicEvidenceValidationError("unknown_field", `artifacts[${index}] contains unknown fields`);
    }
    if (!/^[0-9a-f]{64}$/.test(artifact.artifactId)) {
      throw new PublicEvidenceValidationError("invalid_artifact", `artifacts[${index}].artifactId is invalid`);
    }
    if (typeof artifact.artifactClass !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:+-]{0,255}$/.test(artifact.artifactClass)) {
      throw new PublicEvidenceValidationError("invalid_artifact", `artifacts[${index}].artifactClass is invalid`);
    }
    if (typeof artifact.mediaType !== "string" || artifact.mediaType.length === 0 || artifact.mediaType.length > 256) {
      throw new PublicEvidenceValidationError("invalid_artifact", `artifacts[${index}].mediaType is invalid`);
    }
    if (!Number.isInteger(artifact.byteCount) || artifact.byteCount < 0 || artifact.byteCount > MAX_PUBLIC_ARTIFACT_BYTES) {
      throw new PublicEvidenceValidationError("artifact_too_large", `artifacts[${index}].byteCount is invalid`);
    }
    let bytes: Buffer;
    try {
      bytes = Buffer.from(artifact.contentBase64, "base64");
    } catch {
      throw new PublicEvidenceValidationError("invalid_artifact", `artifacts[${index}].contentBase64 is invalid`);
    }
    if (bytes.byteLength !== artifact.byteCount || bytes.toString("base64") !== artifact.contentBase64) {
      throw new PublicEvidenceValidationError("invalid_artifact", `artifacts[${index}] byte count or base64 is non-canonical`);
    }
    const expectedArtifactId = publicEvidenceId("artifact", {
      artifactClass: artifact.artifactClass,
      mediaType: artifact.mediaType,
      byteCount: artifact.byteCount,
      contentBase64: artifact.contentBase64,
    });
    if (artifact.artifactId !== expectedArtifactId) {
      throw new PublicEvidenceValidationError("artifact_id_mismatch", `artifacts[${index}].artifactId mismatch`);
    }
    aggregate += artifact.byteCount;
    if (aggregate > MAX_PUBLIC_ARTIFACT_BYTES_TOTAL) {
      throw new PublicEvidenceValidationError("artifact_aggregate_too_large", "artifact aggregate exceeds 1 MiB");
    }
    if (ids.has(artifact.artifactId)) {
      throw new PublicEvidenceValidationError("duplicate_id", "artifacts contains duplicate ids");
    }
    ids.add(artifact.artifactId);
    return { ...artifact };
  });
}

/** Validate all publisher-independent bundle content before any signing-key state is touched. */
export function normalizePublicEvidenceContent(input: PublicEvidenceContentInput): PublicEvidenceContentInput {
  if (!Array.isArray(input.records) || input.records.length > MAX_PUBLIC_BUNDLE_RECORDS) {
    throw new PublicEvidenceValidationError("array_too_large", `records exceeds ${MAX_PUBLIC_BUNDLE_RECORDS}`);
  }
  const records = input.records
    .map(validatePublicEvidenceRecord)
    .sort((a, b) => compareCanonicalId(a.recordId, b.recordId));
  if (new Set(records.map((record) => record.recordId)).size !== records.length) {
    throw new PublicEvidenceValidationError("duplicate_id", "records contains duplicate ids");
  }
  const artifacts = validateArtifacts(input.artifacts)
    .sort((a, b) => compareCanonicalId(a.artifactId, b.artifactId));
  const artifactIds = new Set(artifacts.map((artifact) => artifact.artifactId));
  for (const record of records) {
    for (const artifactId of record.artifactRefs ?? []) {
      if (!artifactIds.has(artifactId)) {
        throw new PublicEvidenceValidationError("artifact_ref_missing", `record ${record.recordId} references a missing public artifact`);
      }
    }
  }
  return { records, artifacts, createdDayUtc: utcDay(input.createdDayUtc) };
}

export function canonicalPublicEvidenceContent(
  input: PublicEvidenceContentInput,
): { canonical: boolean; normalized: PublicEvidenceContentInput } {
  const normalized = normalizePublicEvidenceContent(input);
  const canonical = input.records.length === normalized.records.length
    && input.artifacts.length === normalized.artifacts.length
    && input.records.every((record, index) => record.recordId === normalized.records[index]!.recordId)
    && input.artifacts.every((artifact, index) => artifact.artifactId === normalized.artifacts[index]!.artifactId);
  return { canonical, normalized };
}

export function hasCanonicalPublicEvidenceOrder(input: PublicEvidenceContentInput): boolean {
  return canonicalPublicEvidenceContent(input).canonical;
}

function buildFromNormalizedContent(
  normalized: PublicEvidenceContentInput,
  publisherInput: PublicPublisherV1,
): PublicEvidenceBundleUnsignedV1 {
  const publisher = validatePublisher(publisherInput);
  const content = {
    schemaVersion: PUBLIC_EVIDENCE_BUNDLE_SCHEMA_VERSION,
    exportPolicyVersion: PUBLIC_EXPORT_POLICY_VERSION,
    createdDayUtc: normalized.createdDayUtc,
    publisher,
    records: normalized.records,
    artifacts: normalized.artifacts,
  };
  const bundleId = publicEvidenceId("bundle", content);
  const bundleDigest = publicEvidenceId("bundle_digest", { ...content, bundleId });
  const bundle: PublicEvidenceBundleUnsignedV1 = { ...content, bundleId, bundleDigest };
  if (new TextEncoder().encode(jcsStringify(bundle)).byteLength > MAX_PUBLIC_BUNDLE_BYTES) {
    throw new PublicEvidenceValidationError("bundle_too_large", "public bundle exceeds 2 MiB");
  }
  return bundle;
}

export function buildPublicEvidenceBundle(input: BuildPublicEvidenceBundleInput): PublicEvidenceBundleUnsignedV1 {
  return buildFromNormalizedContent(normalizePublicEvidenceContent(input), input.publisher);
}

export function expectedPublicBundleIdentityFromNormalized(
  normalized: PublicEvidenceContentInput,
  publisher: PublicPublisherV1,
): { bundleId: string; bundleDigest: string } {
  const rebuilt = buildFromNormalizedContent(normalized, publisher);
  return { bundleId: rebuilt.bundleId, bundleDigest: rebuilt.bundleDigest };
}

export function expectedPublicBundleIdentity(bundle: PublicEvidenceBundleUnsignedV1): { bundleId: string; bundleDigest: string } {
  return expectedPublicBundleIdentityFromNormalized(
    normalizePublicEvidenceContent({
      records: bundle.records,
      artifacts: bundle.artifacts,
      createdDayUtc: bundle.createdDayUtc,
    }),
    bundle.publisher,
  );
}
