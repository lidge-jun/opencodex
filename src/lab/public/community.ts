import { lstatSync, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { jcsStringify } from "../digest";
import { ensureLabDirs, labCommunityDir } from "../paths";
import { validateCommunityEvidenceAuthorities } from "./community-authority";
import { communityBundleFileName } from "./community-files";
import { privateRegularFileSize, readPrivateRegularFile } from "./file-safety";
import { withPublicEvidenceMutationLock } from "./mutation-lock";
import { recordLocalPublicOrigin } from "./origin";
import {
  cleanupStalePrivateFileStages,
  cleanupStalePrivateFileStagesInDir,
  isPrivateFileStageName,
  publishPrivateFileExclusive,
} from "./private-file";
import { validatePublicEvidencePrivacy } from "./privacy";
import { verifyPublicEvidenceRevocation } from "./revocation";
import { loadExistingPublicPublisher, verifyPublicEvidenceBundle } from "./signature";
import { parseStrictPublicJson } from "./strict-json";
import type {
  CommunityEvidenceSummaryV1,
  PublicEvidenceBundleV1,
  PublicEvidenceRevocationV1,
} from "./types";
import { PublicEvidenceValidationError } from "./validate";

const MAX_IMPORT_BYTES = 2 * 1024 * 1024;
const MAX_CACHE_FILES = 512;
const MAX_CACHE_BYTES = 64 * 1024 * 1024;
const MAX_DEPTH = 8;
const MAX_OBJECT_KEYS = 64;
const MAX_ARRAY_ELEMENTS = 512;
const MAX_GENERIC_STRING_BYTES = 384 * 1024;
const COMMUNITY_MUTATION_LOCK_NAME = ".mutation-lock";
const COMMUNITY_BUNDLE_FILE_RE = /^bundle-([0-9a-f]{64})-([0-9a-f]{64})\.json$/;
const COMMUNITY_REVOCATION_FILE_RE = /^revocation-([0-9a-f]{64})\.json$/;

const COMMUNITY_FILE_OPTIONS = {
  maxBytes: MAX_IMPORT_BYTES,
  errorCode: "community_unsafe_target",
  errorMessage: "community object is not a bounded private regular file",
  sizeErrorCode: "community_size",
  sizeErrorMessage: "community file exceeds bound",
} as const;

type CommunitySummaryCache = {
  directory: string;
  fingerprint: string;
  evidence: CommunityEvidenceSummaryV1[];
};

let communitySummaryCache: CommunitySummaryCache | null = null;

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
  let bytes: Buffer;
  if (raw instanceof Uint8Array) {
    bytes = Buffer.from(raw);
  } else if (typeof raw === "string") {
    bytes = Buffer.from(raw, "utf8");
  } else {
    scanStructure(raw);
    bytes = Buffer.from(jcsStringify(raw), "utf8");
  }
  if (bytes.byteLength > MAX_IMPORT_BYTES) {
    throw new PublicEvidenceValidationError("community_size", "community import exceeds 2 MiB");
  }
  const parsed = parseStrictPublicJson(bytes, "community import");
  scanStructure(parsed);
  return parsed;
}

function assertCommunityArtifactAuthority(bundle: PublicEvidenceBundleV1): void {
  if (bundle.artifacts.length !== 0) {
    throw new PublicEvidenceValidationError(
      "public_artifact_authority_required",
      "community artifact bytes require reviewed public_export policy authority",
    );
  }
}

function verifiedBundle(raw: unknown): PublicEvidenceBundleV1 {
  const result = verifyPublicEvidenceBundle(raw as PublicEvidenceBundleV1);
  if (result.status !== "cryptographically_valid") {
    throw new PublicEvidenceValidationError(result.status, "community bundle verification failed");
  }
  const bundle = validateCommunityEvidenceAuthorities(raw as PublicEvidenceBundleV1);
  assertCommunityArtifactAuthority(bundle);
  validatePublicEvidencePrivacy(bundle);
  return bundle;
}

function bundleObjectPath(publisherKeyId: string, bundleId: string, configDir?: string): string {
  return join(
    labCommunityDir(configDir),
    communityBundleFileName(assertId(publisherKeyId), assertId(bundleId)),
  );
}

function revocationObjectPath(revocationId: string, configDir?: string): string {
  return join(labCommunityDir(configDir), `revocation-${assertId(revocationId)}.json`);
}

function readBounded(path: string): Buffer {
  cleanupStalePrivateFileStages(path);
  return readPrivateRegularFile(path, COMMUNITY_FILE_OPTIONS);
}

function cacheUsage(configDir?: string): { names: string[]; bytes: number } {
  ensureLabDirs(configDir);
  const dir = labCommunityDir(configDir);
  cleanupStalePrivateFileStagesInDir(dir);
  const names = readdirSync(dir)
    .filter((name) => name !== COMMUNITY_MUTATION_LOCK_NAME && !isPrivateFileStageName(name))
    .sort();
  if (names.length > MAX_CACHE_FILES) {
    throw new PublicEvidenceValidationError("community_cache_bound", "community cache file bound exceeded");
  }
  let bytes = 0;
  for (const name of names) {
    bytes += privateRegularFileSize(join(dir, name), COMMUNITY_FILE_OPTIONS);
    if (bytes > MAX_CACHE_BYTES) {
      throw new PublicEvidenceValidationError("community_cache_bound", "community cache byte bound exceeded");
    }
  }
  return { names, bytes };
}

function assertCacheCanAdd(byteCount: number, configDir?: string): void {
  const usage = cacheUsage(configDir);
  if (usage.names.length >= MAX_CACHE_FILES || usage.bytes + byteCount > MAX_CACHE_BYTES) {
    throw new PublicEvidenceValidationError("community_cache_bound", "community cache capacity exceeded");
  }
}

function persistAtLocked(
  path: string,
  kind: "bundle" | "revocation",
  value: unknown,
  configDir?: string,
  onCommit?: () => void,
): { path: string; created: boolean } {
  const bytes = Buffer.from(jcsStringify(value), "utf8");
  if (bytes.byteLength > MAX_IMPORT_BYTES) {
    throw new PublicEvidenceValidationError("community_size", "community object exceeds bound");
  }

  let created = false;
  try {
    try {
      const existing = readBounded(path);
      if (!existing.equals(bytes)) {
        throw new PublicEvidenceValidationError("community_conflict", `${kind} identity already exists with different bytes`);
      }
    } catch (error) {
      if (error instanceof PublicEvidenceValidationError) throw error;
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      assertCacheCanAdd(bytes.byteLength, configDir);
      const published = publishPrivateFileExclusive(path, bytes);
      if (!published.created) {
        const raced = readBounded(path);
        if (!raced.equals(bytes)) {
          throw new PublicEvidenceValidationError("community_conflict", `${kind} identity already exists with different bytes`);
        }
      } else {
        created = true;
        cacheUsage(configDir);
      }
    }

    onCommit?.();
    if (created) communitySummaryCache = null;
    return { path, created };
  } catch (error) {
    if (created) {
      try { unlinkSync(path); } catch { /* preserve commit error */ }
      communitySummaryCache = null;
    }
    throw error;
  }
}

function persistAt(
  path: string,
  kind: "bundle" | "revocation",
  value: unknown,
  configDir?: string,
  onCommit?: () => void,
): { path: string; created: boolean } {
  return withPublicEvidenceMutationLock(
    configDir,
    () => persistAtLocked(path, kind, value, configDir, onCommit),
  );
}

function readJson(path: string): unknown {
  const parsed = parseStrictPublicJson(readBounded(path), "stored community object");
  scanStructure(parsed);
  return parsed;
}

function files(configDir?: string): string[] {
  return cacheUsage(configDir).names;
}

function readVerifiedBundleAt(path: string): PublicEvidenceBundleV1 {
  return verifiedBundle(readJson(path));
}

function bundleFromName(name: string, configDir?: string): PublicEvidenceBundleV1 | null {
  const match = COMMUNITY_BUNDLE_FILE_RE.exec(name);
  if (!match) return null;
  const publisherKeyId = match[1]!;
  const bundleId = match[2]!;
  const bundle = readVerifiedBundleAt(bundleObjectPath(publisherKeyId, bundleId, configDir));
  if (bundle.bundleId !== bundleId || bundle.publisher.keyId !== publisherKeyId) {
    throw new PublicEvidenceValidationError("community_identity_mismatch", "stored community bundle does not match filename identity");
  }
  return bundle;
}

function bundlesFromNames(names: readonly string[], configDir?: string): PublicEvidenceBundleV1[] {
  const bundles: PublicEvidenceBundleV1[] = [];
  for (const name of names) {
    const bundle = bundleFromName(name, configDir);
    if (bundle) bundles.push(bundle);
  }
  return bundles;
}

function restoreOwnPublisherOrigin(bundle: PublicEvidenceBundleV1, configDir?: string): void {
  const local = loadExistingPublicPublisher(configDir);
  if (!local) return;
  if (
    local.publisher.algorithm !== bundle.publisher.algorithm
    || local.publisher.keyId !== bundle.publisher.keyId
    || local.publisher.publicKey !== bundle.publisher.publicKey
  ) return;
  recordLocalPublicOrigin({ publisherKeyId: bundle.publisher.keyId, bundleId: bundle.bundleId }, configDir);
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
    configDir,
    () => restoreOwnPublisherOrigin(bundle, configDir),
  );
  return { ...stored, status: "cryptographically_valid", bundleId: bundle.bundleId, publisherKeyId: bundle.publisher.keyId };
}

function readCommunityEvidenceBundleForPublisherLocked(
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

export function readCommunityEvidenceBundleForPublisher(
  bundleId: string,
  publisherKeyId: string,
  configDir?: string,
): PublicEvidenceBundleV1 {
  return withPublicEvidenceMutationLock(
    configDir,
    () => readCommunityEvidenceBundleForPublisherLocked(bundleId, publisherKeyId, configDir),
  );
}

type RevocationMetadata = {
  publisher?: { keyId?: unknown };
  targets?: Array<{ kind?: unknown; id?: unknown }>;
};

function resolveTargetBundle(
  revocation: unknown,
  bundles: readonly PublicEvidenceBundleV1[],
): PublicEvidenceBundleV1 {
  if (!revocation || typeof revocation !== "object") {
    throw new PublicEvidenceValidationError("revocation_target", "revocation target metadata unavailable");
  }
  const raw = revocation as RevocationMetadata;
  if (!Array.isArray(raw.targets) || typeof raw.publisher?.keyId !== "string") {
    throw new PublicEvidenceValidationError("revocation_target", "revocation targets or publisher unavailable");
  }
  const publisherKeyId = assertId(raw.publisher.keyId);
  const publisherBundles = bundles
    .filter((bundle) => bundle.publisher.keyId === publisherKeyId)
    .sort((a, b) => a.bundleId.localeCompare(b.bundleId));
  const bundleTargets = raw.targets.filter((target) => target.kind === "bundle" && typeof target.id === "string");
  if (bundleTargets.length > 0) {
    const targetIds = new Set(bundleTargets.map((target) => target.id));
    if (targetIds.size !== 1) {
      throw new PublicEvidenceValidationError("revocation_target", "revocation bundle targets are ambiguous");
    }
    const id = [...targetIds][0]!;
    const candidate = publisherBundles.find((bundle) => bundle.bundleId === id);
    if (!candidate) throw new PublicEvidenceValidationError("revocation_target", "revocation target bundle not found");
    return candidate;
  }
  const fullyMatching = publisherBundles.filter((bundle) => raw.targets!.every((target) =>
    target.kind === "record" && typeof target.id === "string"
      && bundle.records.some((record) => record.recordId === target.id),
  ));
  if (fullyMatching.length === 0) {
    throw new PublicEvidenceValidationError(
      "revocation_target",
      "revocation targets do not resolve to a verified bundle for the same publisher",
    );
  }
  return fullyMatching[0]!;
}

function findTargetBundleLocked(revocation: unknown, configDir?: string): PublicEvidenceBundleV1 {
  const names = files(configDir);
  const raw = revocation as RevocationMetadata;
  const publisherKeyId = typeof raw?.publisher?.keyId === "string" ? assertId(raw.publisher.keyId) : null;
  const directBundleIds = Array.isArray(raw?.targets)
    ? [...new Set(raw.targets.filter((target) => target.kind === "bundle" && typeof target.id === "string").map((target) => target.id as string))]
    : [];
  if (publisherKeyId && directBundleIds.length === 1) {
    try {
      return readCommunityEvidenceBundleForPublisherLocked(
        assertId(directBundleIds[0]!),
        publisherKeyId,
        configDir,
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new PublicEvidenceValidationError(
          "revocation_target",
          "revocation target bundle not found",
        );
      }
      throw error;
    }
  }
  return resolveTargetBundle(revocation, bundlesFromNames(names, configDir));
}

export function importCommunityEvidenceRevocation(
  raw: unknown,
  configDir?: string,
): { created: boolean; status: "cryptographically_valid"; revocationId: string; path: string } {
  const parsed = boundedInput(raw);
  ensureLabDirs(configDir);
  return withPublicEvidenceMutationLock(configDir, () => {
    const targetBundle = findTargetBundleLocked(parsed, configDir);
    const verified = verifyPublicEvidenceRevocation(parsed, targetBundle);
    if (verified.status !== "cryptographically_valid") {
      throw new PublicEvidenceValidationError(verified.status, verified.detail ?? "community revocation verification failed");
    }
    const stored = persistAtLocked(
      revocationObjectPath(verified.revocation.revocationId, configDir),
      "revocation",
      verified.revocation,
      configDir,
    );
    return { ...stored, status: "cryptographically_valid", revocationId: verified.revocation.revocationId };
  });
}

function communityFingerprint(names: readonly string[], configDir?: string): string {
  const dir = labCommunityDir(configDir);
  return names.map((name) => {
    const stat = lstatSync(join(dir, name));
    return [name, stat.dev, stat.ino, stat.mode, stat.nlink, stat.size, stat.mtimeMs, stat.ctimeMs].join(":");
  }).join("\n");
}

function copySummaries(evidence: readonly CommunityEvidenceSummaryV1[]): CommunityEvidenceSummaryV1[] {
  return evidence.map((row) => ({ ...row }));
}

function listCommunityEvidenceLocked(configDir?: string): CommunityEvidenceSummaryV1[] {
  const names = files(configDir);
  const directory = labCommunityDir(configDir);
  const fingerprint = communityFingerprint(names, configDir);
  if (communitySummaryCache?.directory === directory && communitySummaryCache.fingerprint === fingerprint) {
    return copySummaries(communitySummaryCache.evidence);
  }

  const bundles = bundlesFromNames(names, configDir);
  const revocations: PublicEvidenceRevocationV1[] = [];

  for (const name of names) {
    if (!COMMUNITY_REVOCATION_FILE_RE.test(name)) continue;
    const raw = readJson(join(directory, name));
    let targetBundle: PublicEvidenceBundleV1;
    try {
      targetBundle = resolveTargetBundle(raw, bundles);
    } catch (error) {
      if (error instanceof PublicEvidenceValidationError) continue;
      throw error;
    }
    const verified = verifyPublicEvidenceRevocation(raw, targetBundle);
    if (verified.status === "cryptographically_valid") revocations.push(verified.revocation);
  }

  const evidence = bundles.map((bundle) => {
    const revoked = new Set<string>();
    const bundleRecordIds = new Set(bundle.records.map((record) => record.recordId));
    for (const revocation of revocations) {
      if (revocation.publisher.keyId !== bundle.publisher.keyId
        || revocation.publisher.publicKey !== bundle.publisher.publicKey) {
        continue;
      }
      if (revocation.targets.some((target) => target.kind === "bundle" && target.id === bundle.bundleId)) {
        for (const record of bundle.records) revoked.add(record.recordId);
      }
      for (const target of revocation.targets) {
        if (target.kind === "record" && bundleRecordIds.has(target.id)) revoked.add(target.id);
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

  communitySummaryCache = { directory, fingerprint, evidence: copySummaries(evidence) };
  return copySummaries(evidence);
}

export function listCommunityEvidence(configDir?: string): CommunityEvidenceSummaryV1[] {
  return withPublicEvidenceMutationLock(configDir, () => listCommunityEvidenceLocked(configDir));
}
