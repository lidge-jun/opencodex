import { createPublicKey, verify as verifyBytes } from "node:crypto";
import { publicEvidenceId } from "./ids";
import {
  loadExistingPublicPublisher,
  signPublicPublisherDigest,
  verifyPublicEvidenceBundle,
} from "./signature";
import {
  PUBLIC_EVIDENCE_REVOCATION_SCHEMA_VERSION,
  type PublicEvidenceBundleV1,
  type PublicEvidenceRevocationV1,
  type PublicPublisherV1,
  type PublicRevocationReasonV1,
  type PublicRevocationTargetV1,
  type PublicRevocationVerificationResult,
} from "./types";
import { PublicEvidenceValidationError } from "./validate";

const REASONS = new Set<PublicRevocationReasonV1>([
  "publisher_retracted",
  "privacy_retraction",
  "evidence_invalidated",
  "superseded",
]);
const MAX_TARGETS = 256;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function closedKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const allowed = new Set(keys);
  return Object.keys(value).every((key) => allowed.has(key)) && keys.every((key) => key in value);
}

function validId(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

function validDay(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function targetKey(target: PublicRevocationTargetV1): string {
  return `${target.kind}:${target.id}`;
}

function compareCanonicalText(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

function canonicalTargets(targets: readonly PublicRevocationTargetV1[]): PublicRevocationTargetV1[] {
  if (targets.length === 0 || targets.length > MAX_TARGETS) {
    throw new PublicEvidenceValidationError("revocation_targets", "revocation must contain 1..256 targets");
  }
  const normalized = targets.map((target) => {
    if ((target.kind !== "bundle" && target.kind !== "record") || !validId(target.id)) {
      throw new PublicEvidenceValidationError("revocation_target", "invalid revocation target");
    }
    return { kind: target.kind, id: target.id } as PublicRevocationTargetV1;
  }).sort((a, b) => compareCanonicalText(targetKey(a), targetKey(b)));
  if (new Set(normalized.map(targetKey)).size !== normalized.length) {
    throw new PublicEvidenceValidationError("revocation_target_duplicate", "revocation targets must be unique");
  }
  return normalized;
}

function samePublisher(a: PublicPublisherV1, b: PublicPublisherV1): boolean {
  return a.algorithm === b.algorithm && a.keyId === b.keyId && a.publicKey === b.publicKey;
}

function validateTargetsAgainstBundle(targets: readonly PublicRevocationTargetV1[], bundle: PublicEvidenceBundleV1): boolean {
  const records = new Set(bundle.records.map((record) => record.recordId));
  return targets.every((target) => target.kind === "bundle" ? target.id === bundle.bundleId : records.has(target.id));
}

function revocationPayload(
  issuedDayUtc: string,
  publisher: PublicPublisherV1,
  targets: PublicRevocationTargetV1[],
  reason: PublicRevocationReasonV1,
): Record<string, unknown> {
  return {
    schemaVersion: PUBLIC_EVIDENCE_REVOCATION_SCHEMA_VERSION,
    issuedDayUtc,
    publisher,
    targets,
    reason,
  };
}

export function createPublicEvidenceRevocation(input: {
  configDir?: string;
  targetBundle: PublicEvidenceBundleV1;
  issuedDayUtc: string;
  targets: PublicRevocationTargetV1[];
  reason: PublicRevocationReasonV1;
}): PublicEvidenceRevocationV1 {
  // Validate the target and every caller-controlled field before touching publisher state.
  if (verifyPublicEvidenceBundle(input.targetBundle).status !== "cryptographically_valid") {
    throw new PublicEvidenceValidationError("revocation_target", "revocation target bundle is not cryptographically valid");
  }
  if (!validDay(input.issuedDayUtc)) {
    throw new PublicEvidenceValidationError("revocation_day", "issuedDayUtc is invalid");
  }
  if (!REASONS.has(input.reason)) {
    throw new PublicEvidenceValidationError("revocation_reason", "unsupported revocation reason");
  }
  const targets = canonicalTargets(input.targets);
  if (!validateTargetsAgainstBundle(targets, input.targetBundle)) {
    throw new PublicEvidenceValidationError("revocation_target", "revocation target is unknown to target bundle");
  }

  const handle = loadExistingPublicPublisher(input.configDir);
  if (!handle || !samePublisher(handle.publisher, input.targetBundle.publisher)) {
    throw new PublicEvidenceValidationError(
      "revocation_publisher",
      "revocation requires the existing publisher key that signed the target bundle",
    );
  }
  const revocationId = publicEvidenceId(
    "revocation",
    revocationPayload(input.issuedDayUtc, handle.publisher, targets, input.reason),
  );
  const signature = signPublicPublisherDigest(handle, revocationId);
  return Object.freeze({
    schemaVersion: PUBLIC_EVIDENCE_REVOCATION_SCHEMA_VERSION,
    revocationId,
    issuedDayUtc: input.issuedDayUtc,
    publisher: handle.publisher,
    targets,
    reason: input.reason,
    signature: Object.freeze({ algorithm: "ed25519" as const, signedDigest: revocationId, signature }),
  });
}

export function verifyPublicEvidenceRevocation(
  raw: unknown,
  targetBundle: PublicEvidenceBundleV1,
): PublicRevocationVerificationResult {
  try {
    if (!isPlainObject(raw) || !closedKeys(raw, [
      "schemaVersion", "revocationId", "issuedDayUtc", "publisher", "targets", "reason", "signature",
    ])) {
      return { status: "schema_rejected", detail: "closed revocation schema mismatch" };
    }
    if (
      raw.schemaVersion !== PUBLIC_EVIDENCE_REVOCATION_SCHEMA_VERSION
      || !validId(raw.revocationId)
      || !validDay(raw.issuedDayUtc)
      || !REASONS.has(raw.reason as PublicRevocationReasonV1)
    ) {
      return { status: "schema_rejected", detail: "revocation version/id/day/reason invalid" };
    }
    if (
      !isPlainObject(raw.publisher)
      || !closedKeys(raw.publisher, ["algorithm", "keyId", "publicKey"])
      || raw.publisher.algorithm !== "ed25519"
      || !validId(raw.publisher.keyId)
      || typeof raw.publisher.publicKey !== "string"
      || raw.publisher.publicKey.length > 1024
    ) {
      return { status: "schema_rejected", detail: "revocation publisher invalid" };
    }
    const publicKeyBytes = Buffer.from(raw.publisher.publicKey, "base64");
    if (publicKeyBytes.toString("base64") !== raw.publisher.publicKey) {
      return { status: "schema_rejected", detail: "revocation publisher key is non-canonical" };
    }
    const publisher: PublicPublisherV1 = {
      algorithm: "ed25519",
      keyId: raw.publisher.keyId,
      publicKey: raw.publisher.publicKey,
    };
    if (publicEvidenceId("publisher_key", { algorithm: "ed25519", publicKey: publisher.publicKey }) !== publisher.keyId) {
      return { status: "schema_rejected", detail: "revocation publisher key id mismatch" };
    }
    if (!samePublisher(publisher, targetBundle.publisher)) {
      return { status: "publisher_mismatch", detail: "revocation publisher does not match target bundle" };
    }
    if (!Array.isArray(raw.targets) || raw.targets.length === 0 || raw.targets.length > MAX_TARGETS) {
      return { status: "schema_rejected", detail: "revocation targets invalid" };
    }
    const targets: PublicRevocationTargetV1[] = [];
    for (const [index, value] of raw.targets.entries()) {
      if (
        !isPlainObject(value)
        || !closedKeys(value, ["kind", "id"])
        || (value.kind !== "bundle" && value.kind !== "record")
        || !validId(value.id)
      ) {
        return { status: "schema_rejected", detail: `revocation target ${index} invalid` };
      }
      targets.push({ kind: value.kind, id: value.id });
    }
    const canonical = canonicalTargets(targets);
    if (canonical.some((target, index) => target.kind !== targets[index]!.kind || target.id !== targets[index]!.id)) {
      return { status: "schema_rejected", detail: "revocation targets must be sorted" };
    }
    if (!validateTargetsAgainstBundle(targets, targetBundle)) {
      return { status: "unknown_target", detail: "revocation target not present in target bundle" };
    }
    if (
      !isPlainObject(raw.signature)
      || !closedKeys(raw.signature, ["algorithm", "signedDigest", "signature"])
      || raw.signature.algorithm !== "ed25519"
      || raw.signature.signedDigest !== raw.revocationId
      || typeof raw.signature.signature !== "string"
    ) {
      return { status: "schema_rejected", detail: "revocation signature schema invalid" };
    }
    const expected = publicEvidenceId(
      "revocation",
      revocationPayload(raw.issuedDayUtc, publisher, targets, raw.reason as PublicRevocationReasonV1),
    );
    if (expected !== raw.revocationId) {
      return { status: "digest_invalid", detail: "revocation id does not match canonical bytes" };
    }
    const key = createPublicKey({ key: publicKeyBytes, type: "spki", format: "der" });
    if (key.asymmetricKeyType !== "ed25519") {
      return { status: "signature_invalid", detail: "revocation publisher key is not Ed25519" };
    }
    const signatureBytes = Buffer.from(raw.signature.signature, "base64");
    if (signatureBytes.toString("base64") !== raw.signature.signature) {
      return { status: "signature_invalid", detail: "revocation signature is non-canonical" };
    }
    if (!verifyBytes(null, Buffer.from(raw.revocationId, "hex"), key, signatureBytes)) {
      return { status: "signature_invalid", detail: "revocation signature invalid" };
    }
    return {
      status: "cryptographically_valid",
      revocation: {
        schemaVersion: PUBLIC_EVIDENCE_REVOCATION_SCHEMA_VERSION,
        revocationId: raw.revocationId,
        issuedDayUtc: raw.issuedDayUtc,
        publisher,
        targets,
        reason: raw.reason as PublicRevocationReasonV1,
        signature: {
          algorithm: "ed25519",
          signedDigest: raw.revocationId,
          signature: raw.signature.signature,
        },
      },
    };
  } catch (error) {
    return { status: "schema_rejected", detail: error instanceof Error ? error.message : String(error) };
  }
}
