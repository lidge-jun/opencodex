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
import { verifyPublicEvidenceBundle } from "./signing";
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

function assertId(value: string): string { if (!/^[0-9a-f]{64}$/.test(value)) throw new PublicEvidenceValidationError("community_id", "community object id invalid"); return value; }
function scanStructure(value: unknown, depth = 0): void {
  if (depth > MAX_DEPTH) throw new PublicEvidenceValidationError("community_depth", "community JSON nesting depth exceeded");
  if (typeof value === "string") {
    if (new TextEncoder().encode(value).byteLength > MAX_GENERIC_STRING_BYTES || value.includes("\0")) throw new PublicEvidenceValidationError("community_string", "community string invalid or oversized");
    return;
  }
  if (Array.isArray(value)) {
    if (value.length > MAX_ARRAY_ELEMENTS) throw new PublicEvidenceValidationError("community_array", "community array bound exceeded");
    for (const item of value) scanStructure(item, depth + 1);
    return;
  }
  if (value && typeof value === "object") {
    const keys = Object.keys(value);
    if (keys.length > MAX_OBJECT_KEYS) throw new PublicEvidenceValidationError("community_object", "community object key bound exceeded");
    for (const key of keys) { if (new TextEncoder().encode(key).byteLength > 4096) throw new PublicEvidenceValidationError("community_key", "community key oversized"); scanStructure((value as Record<string, unknown>)[key], depth + 1); }
  }
}
function boundedInput(raw: unknown): unknown {
  if (raw instanceof Uint8Array || typeof raw === "string") {
    const bytes = typeof raw === "string" ? Buffer.from(raw, "utf8") : Buffer.from(raw);
    if (bytes.byteLength > MAX_IMPORT_BYTES) throw new PublicEvidenceValidationError("community_size", "community import exceeds 2 MiB");
    let parsed: unknown;
    try { parsed = JSON.parse(bytes.toString("utf8")); } catch { throw new PublicEvidenceValidationError("community_json", "community import is not valid JSON"); }
    scanStructure(parsed);
    return parsed;
  }
  scanStructure(raw);
  const bytes = Buffer.from(jcsStringify(raw), "utf8");
  if (bytes.byteLength > MAX_IMPORT_BYTES) throw new PublicEvidenceValidationError("community_size", "community import exceeds 2 MiB");
  return raw;
}
function objectPath(kind: "bundle" | "revocation", id: string, configDir?: string): string { return join(labCommunityDir(configDir), `${kind}-${assertId(id)}.json`); }
function assertRegular(path: string, fd: number): void {
  const stats = fstatSync(fd);
  if (!stats.isFile() || stats.isSymbolicLink() || stats.nlink !== 1 || stats.size > MAX_IMPORT_BYTES) throw new PublicEvidenceValidationError("community_unsafe_target", `unsafe community file: ${path}`);
}
function readBounded(path: string): Buffer {
  const before = lstatSync(path);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > MAX_IMPORT_BYTES) throw new PublicEvidenceValidationError("community_unsafe_target", "unsafe community path");
  const fd = openSync(path, fsConstants.O_RDONLY | O_NOFOLLOW);
  try { assertRegular(path, fd); const bytes = readFileSync(fd); if (bytes.byteLength > MAX_IMPORT_BYTES) throw new PublicEvidenceValidationError("community_size", "community file exceeds bound"); return bytes; }
  finally { closeSync(fd); }
}
function writeAll(fd: number, bytes: Uint8Array): void { let offset = 0; while (offset < bytes.byteLength) { const count = writeSync(fd, bytes, offset, bytes.byteLength - offset); if (count <= 0) throw new PublicEvidenceValidationError("community_write", "community write made no progress"); offset += count; } }
function persist(kind: "bundle" | "revocation", id: string, value: unknown, configDir?: string): { path: string; created: boolean } {
  ensureLabDirs(configDir);
  const path = objectPath(kind, id, configDir);
  const bytes = Buffer.from(jcsStringify(value), "utf8");
  if (bytes.byteLength > MAX_IMPORT_BYTES) throw new PublicEvidenceValidationError("community_size", "community object exceeds bound");
  let fd: number | null = null;
  try {
    fd = openSync(path, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | O_NOFOLLOW, 0o600);
    writeAll(fd, bytes); fsyncSync(fd); assertRegular(path, fd); closeSync(fd); fd = null;
    return { path, created: true };
  } catch (error) {
    if (fd !== null) closeSync(fd);
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    if (!readBounded(path).equals(bytes)) throw new PublicEvidenceValidationError("community_conflict", `${kind} id already exists with different bytes`);
    return { path, created: false };
  }
}
function readJson(path: string): unknown { try { return JSON.parse(readBounded(path).toString("utf8")); } catch (error) { if (error instanceof PublicEvidenceValidationError) throw error; throw new PublicEvidenceValidationError("community_json", "stored community object is invalid JSON"); } }
function files(configDir?: string): string[] {
  ensureLabDirs(configDir);
  const names = readdirSync(labCommunityDir(configDir));
  if (names.length > MAX_CACHE_FILES) throw new PublicEvidenceValidationError("community_cache_bound", "community cache file bound exceeded");
  return names.sort();
}
export function importCommunityEvidenceBundle(raw: unknown, configDir?: string): { created: boolean; status: "cryptographically_valid"; bundleId: string; path: string } {
  const parsed = boundedInput(raw);
  const verified = verifyPublicEvidenceBundle(parsed);
  if (verified.status !== "cryptographically_valid") throw new PublicEvidenceValidationError(verified.status, verified.detail ?? "community bundle verification failed");
  validateCommunityEvidenceAuthorities(verified.bundle);
  const stored = persist("bundle", verified.bundle.bundleId, verified.bundle, configDir);
  return { ...stored, status: "cryptographically_valid", bundleId: verified.bundle.bundleId };
}
export function readCommunityEvidenceBundle(bundleId: string, configDir?: string): PublicEvidenceBundleV1 {
  const raw = readJson(objectPath("bundle", bundleId, configDir));
  const verified = verifyPublicEvidenceBundle(raw);
  if (verified.status !== "cryptographically_valid") throw new PublicEvidenceValidationError(verified.status, verified.detail ?? "stored community bundle invalid");
  return validateCommunityEvidenceAuthorities(verified.bundle);
}
function allCommunityBundles(configDir?: string): PublicEvidenceBundleV1[] {
  return files(configDir).filter((name) => /^bundle-[0-9a-f]{64}\.json$/.test(name)).map((name) => readCommunityEvidenceBundle(name.slice(7, 71), configDir));
}
function findTargetBundle(revocation: unknown, configDir?: string): PublicEvidenceBundleV1 {
  if (!revocation || typeof revocation !== "object" || !Array.isArray((revocation as { targets?: unknown }).targets)) throw new PublicEvidenceValidationError("revocation_target", "revocation targets unavailable");
  const ids = new Set((revocation as { targets: Array<{ id?: unknown }> }).targets.map((target) => typeof target?.id === "string" ? target.id : ""));
  const candidates = allCommunityBundles(configDir).filter((bundle) => ids.has(bundle.bundleId) || bundle.records.some((record) => ids.has(record.recordId)));
  const fullyMatching = candidates.filter((bundle) => (revocation as { targets: Array<{ kind?: unknown; id?: unknown }> }).targets.every((target) => target.kind === "bundle" ? target.id === bundle.bundleId : target.kind === "record" && bundle.records.some((record) => record.recordId === target.id)));
  if (fullyMatching.length !== 1) throw new PublicEvidenceValidationError("revocation_target", "revocation targets must resolve to one verified community bundle");
  return fullyMatching[0]!;
}
export function importCommunityEvidenceRevocation(raw: unknown, configDir?: string): { created: boolean; status: "cryptographically_valid"; revocationId: string; path: string } {
  const parsed = boundedInput(raw);
  const targetBundle = findTargetBundle(parsed, configDir);
  const verified = verifyPublicEvidenceRevocation(parsed, targetBundle);
  if (verified.status !== "cryptographically_valid") throw new PublicEvidenceValidationError(verified.status, verified.detail ?? "community revocation verification failed");
  const stored = persist("revocation", verified.revocation.revocationId, verified.revocation, configDir);
  return { ...stored, status: "cryptographically_valid", revocationId: verified.revocation.revocationId };
}
function verifiedRevocationsForBundle(bundle: PublicEvidenceBundleV1, configDir?: string): PublicEvidenceRevocationV1[] {
  const result: PublicEvidenceRevocationV1[] = [];
  for (const name of files(configDir).filter((value) => /^revocation-[0-9a-f]{64}\.json$/.test(value))) {
    const raw = readJson(join(labCommunityDir(configDir), name));
    const verified = verifyPublicEvidenceRevocation(raw, bundle);
    if (verified.status === "cryptographically_valid") result.push(verified.revocation);
  }
  return result;
}
export function listCommunityEvidence(configDir?: string): CommunityEvidenceSummaryV1[] {
  return allCommunityBundles(configDir).map((bundle) => {
    const revoked = new Set<string>();
    for (const revocation of verifiedRevocationsForBundle(bundle, configDir)) {
      if (revocation.targets.some((target) => target.kind === "bundle" && target.id === bundle.bundleId)) for (const record of bundle.records) revoked.add(record.recordId);
      for (const target of revocation.targets) if (target.kind === "record") revoked.add(target.id);
    }
    return { trustClass: "community_untrusted_v1" as const, status: "cryptographically_valid" as const, bundleId: bundle.bundleId, publisherKeyId: bundle.publisher.keyId, activeRecordCount: bundle.records.filter((record) => !revoked.has(record.recordId)).length, revokedRecordCount: bundle.records.filter((record) => revoked.has(record.recordId)).length };
  }).sort((a, b) => a.bundleId.localeCompare(b.bundleId));
}
