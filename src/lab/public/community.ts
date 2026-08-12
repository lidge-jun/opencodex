import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readdirSync,
  readFileSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";
import { jcsStringify } from "../digest";
import { ensureLabDirs, labCommunityDir } from "../paths";
import { validateCommunityEvidenceAuthorities } from "./community-authority";
import { verifyPublicEvidenceRevocation } from "./revocation";
import { verifyPublicEvidenceBundle } from "./signature";
import { parseStrictPublicJson } from "./strict-json";
import type {
  CommunityEvidenceSummaryV1,
  PublicEvidenceBundleV1,
  PublicEvidenceRevocationV1,
} from "./types";
import { PublicEvidenceValidationError } from "./validate";

const MAX_IMPORT_BYTES = 2 * 1024 * 1024;
const MAX_CACHE_FILES = 4096;
const MAX_DEPTH = 8;
const MAX_OBJECT_KEYS = 64;
const MAX_ARRAY_ELEMENTS = 512;
const MAX_GENERIC_STRING_BYTES = 384 * 1024;
const O_NOFOLLOW = (fsConstants as { O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0;
const COMMUNITY_BUNDLE_FILE_RE = /^bundle-([0-9a-f]{64})-([0-9a-f]{64})\.json$/;
const COMMUNITY_REVOCATION_FILE_RE = /^revocation-([0-9a-f]{64})\.json$/;

function assertId(value: string): string {
  if (!/^[0-9a-f]{64}$/.test(value)) {
    throw new PublicEvidenceValidationError("community_id", "community object id invalid");
  }
  return value;
}

function scanStructure(value: unknown, depth = 0): void {
  if (depth > MAX_DEPTH) {
    throw new PublicEvidenceValidationError("community_depth", "community JSON nesting depth exceeded");
  }
  if (typeof value === "string") {
    if (new TextEncoder().encode(value).byteLength > MAX_GENERIC_STRING_BYTES || value.includes("\0")) {
      throw new PublicEvidenceValidationError("community_string", "community string invalid or oversized");
    }
    return;
  }
  if (Array.isArray(value)) {
    if (value.length > MAX_ARRAY_ELEMENTS) {
      throw new PublicEvidenceValidationError("community_array", "community array bound exceeded");
    }
    for (const item of value) scanStructure(item, depth + 1);
    return;
  }
  if (value && typeof value === "object") {
    const keys = Object.keys(value);
    if (keys.length > MAX_OBJECT_KEYS) {
      throw new PublicEvidenceValidationError("community_object", "community object key bound exceeded");
    }
    for (const key of keys) {
      if (new TextEncoder().encode(key).byteLength > 4096) {
        throw new PublicEvidenceValidationError("community_key", "community key oversized");
      }
      scanStructure((value as Record<string, unknown>)[key], depth + 1);
    }
  }
}

function boundedInput(raw: unknown): unknown {
  if (raw instanceof Uint8Array || typeof raw === "string") {
    const bytes = typeof raw === "string" ? Buffer.from(raw, "utf8") : Buffer.from(raw);
    if (bytes.byteLength > MAX_IMPORT_BYTES) {
      throw new PublicEvidenceValidationError("community_size", "community import exceeds 2 MiB");
    }
    const parsed = parseStrictPublicJson(bytes, "community import");
    scanStructure(parsed);
    return parsed;
  }
  scanStructure(raw);
  const bytes = Buffer.from(jcsStringify(raw), "utf8");
  if (bytes.byteLength > MAX_IMPORT_BYTES) {
    throw new PublicEvidenceValidationError("community_size", "community import exceeds 2 MiB");
  }
  return raw;
}

function verifiedBundle(raw: unknown): PublicEvidenceBundleV1 {
  const result = verifyPublicEvidenceBundle(raw as PublicEvidenceBundleV1);
  if (result.status !== "cryptographically_valid") {
    throw new PublicEvidenceValidationError(result.status, "community bundle verification failed");
  }
  return validateCommunityEvidenceAuthorities(raw as PublicEvidenceBundleV1);
}

function bundleObjectPath(publisherKeyId: string, bundleId: string, configDir?: string): string {
  return join(labCommunityDir(configDir), `bundle-${assertId(publisherKeyId)}-${assertId(bundleId)}.json`);
}

function revocationObjectPath(revocationId: string, configDir?: string): string {
  return join(labCommunityDir(configDir), `revocation-${assertId(revocationId)}.json`);
}

function assertRegular(path: string, fd: number): void {
  const stats = fstatSync(fd);
  if (!stats.isFile() || stats.isSymbolicLink() || stats.nlink !== 1 || stats.size > MAX_IMPORT_BYTES) {
    throw new PublicEvidenceValidationError("community_unsafe_target", `unsafe community file: ${path}`);
  }
}

function readBounded(path: string): Buffer {
  const before = lstatSync(path);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > MAX_IMPORT_BYTES) {
    throw new PublicEvidenceValidationError("community_unsafe_target", "unsafe community path");
  }
  const fd = openSync(path, fsConstants.O_RDONLY | O_NOFOLLOW);
  try {
    assertRegular(path, fd);
    const bytes = readFileSync(fd);
    if (bytes.byteLength > MAX_IMPORT_BYTES) {
      throw new PublicEvidenceValidationError("community_size", "community file exceeds bound");
    }
    return bytes;
  } finally {
    closeSync(fd);
  }
}

function writeAll(fd: number, bytes: Uint8Array): void {
  let offset = 0;
  while (offset < bytes.byteLength) {
    const count = writeSync(fd, bytes, offset, bytes.byteLength - offset);
    if (count <= 0) {
      throw new PublicEvidenceValidationError("community_write", "community write made no progress");
    }
    offset += count;
  }
}

function persistAt(path: string, kind: "bundle" | "revocation", value: unknown): { path: string; created: boolean } {
  const bytes = Buffer.from(jcsStringify(value), "utf8");
  if (bytes.byteLength > MAX_IMPORT_BYTES) {
    throw new PublicEvidenceValidationError("community_size", "community object exceeds bound");
  }
  let fd: number | null = null;
  try {
    fd = openSync(path, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | O_NOFOLLOW, 0o600);
    writeAll(fd, bytes);
    fsyncSync(fd);
    assertRegular(path, fd);
    closeSync(fd);
    fd = null;
    return { path, created: true };
  } catch (error) {
    if (fd !== null) closeSync(fd);
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    if (!readBounded(path).equals(bytes)) {
      throw new PublicEvidenceValidationError("community_conflict", `${kind} identity already exists with different bytes`);
    }
    return { path, created: false };
  }
}

function readJson(path: string): unknown {
  const parsed = parseStrictPublicJson(readBounded(path), "stored community object");
  scanStructure(parsed);
  return parsed;
}

function files(configDir?: string): string[] {
  ensureLabDirs(configDir);
  const names = readdirSync(labCommunityDir(configDir));
  if (names.length > MAX_CACHE_FILES) {
    throw new PublicEvidenceValidationError("community_cache_bound", "community cache file bound exceeded");
  }
  return names.sort();
}

function readVerifiedBundleAt(path: string): PublicEvidenceBundleV1 {
  return verifiedBundle(readJson(path));
}

export function importCommunityEvidenceBundle(
  raw: unknown,
  configDir?: string,
): { created: boolean; status: "cryptographically_valid"; bundleId: string; publisherKeyId: string; path: string } {
  const bundle = verifiedBundle(boundedInput(raw));
  ensureLabDirs(configDir);
  const stored = persistAt(
    bundleObjectPath(bundle.publisher.keyId, bundle.bundleId, configDir),
    "bundle",
    bundle,
  );
  return {
    ...stored,
    status: "cryptographically_valid",
    bundleId: bundle.bundleId,
    publisherKeyId: bundle.publisher.keyId,
  };
}

export function readCommunityEvidenceBundleForPublisher(
  bundleId: string,
  publisherKeyId: string,
  configDir?: string,
): PublicEvidenceBundleV1 {
  const bundle = readVerifiedBundleAt(bundleObjectPath(publisherKeyId, bundleId, configDir));
  if (bundle.bundleId !== bundleId || bundle.publisher.keyId !== publisherKeyId) {
    throw new PublicEvidenceValidationError("community_identity_mismatch", "stored community bundle does not match filename identity");
  }
  return bundle;
}

function allCommunityBundles(configDir?: string): PublicEvidenceBundleV1[] {
  return files(configDir).flatMap((name) => {
    const match = COMMUNITY_BUNDLE_FILE_RE.exec(name);
    if (!match) return [];
    return [readCommunityEvidenceBundleForPublisher(match[2]!, match[1]!, configDir)];
  });
}

function findTargetBundle(revocation: unknown, configDir?: string): PublicEvidenceBundleV1 {
  if (!revocation || typeof revocation !== "object") {
    throw new PublicEvidenceValidationError("revocation_target", "revocation target metadata unavailable");
  }
  const raw = revocation as { publisher?: { keyId?: unknown }; targets?: Array<{ kind?: unknown; id?: unknown }> };
  if (!Array.isArray(raw.targets) || typeof raw.publisher?.keyId !== "string") {
    throw new PublicEvidenceValidationError("revocation_target", "revocation targets or publisher unavailable");
  }
  const publisherKeyId = assertId(raw.publisher.keyId);
  const candidates = allCommunityBundles(configDir).filter((bundle) => bundle.publisher.keyId === publisherKeyId);
  const fullyMatching = candidates.filter((bundle) => raw.targets!.every((target) =>
    target.kind === "bundle"
      ? target.id === bundle.bundleId
      : target.kind === "record" && bundle.records.some((record) => record.recordId === target.id),
  ));
  if (fullyMatching.length !== 1) {
    throw new PublicEvidenceValidationError(
      "revocation_target",
      "revocation targets must resolve to one verified bundle for the same publisher",
    );
  }
  return fullyMatching[0]!;
}

export function importCommunityEvidenceRevocation(
  raw: unknown,
  configDir?: string,
): { created: boolean; status: "cryptographically_valid"; revocationId: string; path: string } {
  const parsed = boundedInput(raw);
  const targetBundle = findTargetBundle(parsed, configDir);
  const verified = verifyPublicEvidenceRevocation(parsed, targetBundle);
  if (verified.status !== "cryptographically_valid") {
    throw new PublicEvidenceValidationError(verified.status, verified.detail ?? "community revocation verification failed");
  }
  ensureLabDirs(configDir);
  const stored = persistAt(
    revocationObjectPath(verified.revocation.revocationId, configDir),
    "revocation",
    verified.revocation,
  );
  return { ...stored, status: "cryptographically_valid", revocationId: verified.revocation.revocationId };
}

function verifiedRevocationsForBundle(bundle: PublicEvidenceBundleV1, configDir?: string): PublicEvidenceRevocationV1[] {
  const result: PublicEvidenceRevocationV1[] = [];
  for (const name of files(configDir)) {
    if (!COMMUNITY_REVOCATION_FILE_RE.test(name)) continue;
    const verified = verifyPublicEvidenceRevocation(readJson(join(labCommunityDir(configDir), name)), bundle);
    if (verified.status === "cryptographically_valid") result.push(verified.revocation);
  }
  return result;
}

export function listCommunityEvidence(configDir?: string): CommunityEvidenceSummaryV1[] {
  return allCommunityBundles(configDir).map((bundle) => {
    const revoked = new Set<string>();
    for (const revocation of verifiedRevocationsForBundle(bundle, configDir)) {
      if (revocation.targets.some((target) => target.kind === "bundle" && target.id === bundle.bundleId)) {
        for (const record of bundle.records) revoked.add(record.recordId);
      }
      for (const target of revocation.targets) {
        if (target.kind === "record") revoked.add(target.id);
      }
    }
    return {
      trustClass: "community_untrusted_v1" as const,
      status: "cryptographically_valid" as const,
      bundleId: bundle.bundleId,
      publisherKeyId: bundle.publisher.keyId,
      activeRecordCount: bundle.records.filter((record) => !revoked.has(record.recordId)).length,
      revokedRecordCount: bundle.records.filter((record) => revoked.has(record.recordId)).length,
    };
  }).sort((a, b) => a.bundleId.localeCompare(b.bundleId) || a.publisherKeyId.localeCompare(b.publisherKeyId));
}
