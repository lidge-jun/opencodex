import { lstatSync, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { jcsStringify } from "../digest";
import { ensureLabDirs, labCommunityDir, labExportDir, labPublicOriginDir } from "../paths";
import { communityBundleFileName } from "./community-files";
import { readPrivateRegularFile } from "./file-safety";
import {
  cleanupStalePrivateFileStagesInDir,
  isPrivateFileStageName,
  publishPrivateFileExclusive,
} from "./private-file";
import { parseStrictPublicJson } from "./strict-json";
import { PublicEvidenceValidationError } from "./validate";

// The community cache itself is capped at 512 files. Keeping twice that many origin
// markers leaves headroom for in-flight/local exports while allowing unreferenced
// provenance to be reclaimed instead of permanently locking future exports.
const MAX_ORIGINS = 1024;
const MAX_ORIGIN_BYTES = 1024;
const ORIGIN_RE = /^origin-([0-9a-f]{64})-([0-9a-f]{64})\.json$/;

export interface PublicOriginIdentityV1 {
  publisherKeyId: string;
  bundleId: string;
}

function originPath(identity: PublicOriginIdentityV1, configDir?: string): string {
  if (!/^[0-9a-f]{64}$/.test(identity.publisherKeyId) || !/^[0-9a-f]{64}$/.test(identity.bundleId)) {
    throw new PublicEvidenceValidationError("public_origin_id", "public origin identity is invalid");
  }
  return join(
    labPublicOriginDir(configDir),
    `origin-${identity.publisherKeyId}-${identity.bundleId}.json`,
  );
}

function originBody(identity: PublicOriginIdentityV1): Buffer {
  return Buffer.from(jcsStringify({
    schemaVersion: "public_origin_v1",
    publisherKeyId: identity.publisherKeyId,
    bundleId: identity.bundleId,
  }), "utf8");
}

function readOrigin(path: string, expected?: PublicOriginIdentityV1): PublicOriginIdentityV1 {
  const bytes = readPrivateRegularFile(path, {
    maxBytes: MAX_ORIGIN_BYTES,
    errorCode: "public_origin_unsafe",
    errorMessage: "public origin marker is not a private regular file with 0600 permissions",
    sizeErrorCode: "public_origin_unsafe",
    sizeErrorMessage: "public origin marker exceeds its size bound",
    requireMode600: true,
  });
  const raw = parseStrictPublicJson(bytes, "public origin marker", "public_origin_json");
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new PublicEvidenceValidationError("public_origin_json", "public origin marker must be an object");
  }
  const row = raw as Record<string, unknown>;
  if (Object.keys(row).sort().join(",") !== "bundleId,publisherKeyId,schemaVersion"
    || row.schemaVersion !== "public_origin_v1"
    || typeof row.publisherKeyId !== "string"
    || typeof row.bundleId !== "string"
    || !/^[0-9a-f]{64}$/.test(row.publisherKeyId)
    || !/^[0-9a-f]{64}$/.test(row.bundleId)) {
    throw new PublicEvidenceValidationError("public_origin_json", "public origin marker schema is invalid");
  }
  const identity = { publisherKeyId: row.publisherKeyId, bundleId: row.bundleId };
  if (expected && (identity.publisherKeyId !== expected.publisherKeyId || identity.bundleId !== expected.bundleId)) {
    throw new PublicEvidenceValidationError("public_origin_conflict", "public origin marker identity mismatch");
  }
  return identity;
}

/** Marker names only. Quota accounting, reclaim, and listing must agree on this set. */
function originNames(dir: string): string[] {
  cleanupStalePrivateFileStagesInDir(dir);
  return readdirSync(dir)
    .filter((name) => !isPrivateFileStageName(name) && ORIGIN_RE.test(name))
    .sort();
}

function foreignOriginNames(dir: string): string[] {
  return readdirSync(dir)
    .filter((name) => !isPrivateFileStageName(name) && !ORIGIN_RE.test(name))
    .sort();
}

function pathExistsConservatively(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    return true;
  }
}

function communityBundlePath(identity: PublicOriginIdentityV1, configDir?: string): string {
  return join(
    labCommunityDir(configDir),
    communityBundleFileName(identity.publisherKeyId, identity.bundleId),
  );
}

function localExportPath(identity: PublicOriginIdentityV1, configDir?: string): string {
  return join(labExportDir(configDir), `${identity.bundleId}.json`);
}

/**
 * Origin markers exist to recover local provenance for community copies when the export
 * or publisher key is later unavailable. A marker is reclaimable only when neither the
 * exact community copy nor its matching local export still exists.
 */
function reclaimUnreferencedOrigins(
  dir: string,
  preservePath: string,
  configDir?: string,
): void {
  for (const name of originNames(dir)) {
    const match = ORIGIN_RE.exec(name)!;
    const path = join(dir, name);
    if (path === preservePath) continue;
    const identity = { publisherKeyId: match[1]!, bundleId: match[2]! };
    if (pathExistsConservatively(communityBundlePath(identity, configDir))) continue;
    if (pathExistsConservatively(localExportPath(identity, configDir))) continue;
    try {
      unlinkSync(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

export function recordLocalPublicOrigin(identity: PublicOriginIdentityV1, configDir?: string): void {
  ensureLabDirs(configDir);
  const dir = labPublicOriginDir(configDir);
  const path = originPath(identity, configDir);
  try {
    readOrigin(path, identity);
    return;
  } catch (error) {
    if (error instanceof PublicEvidenceValidationError) throw error;
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  let names = originNames(dir);
  if (names.length >= MAX_ORIGINS) {
    reclaimUnreferencedOrigins(dir, path, configDir);
    names = originNames(dir);
  }
  if (names.length >= MAX_ORIGINS) {
    throw new PublicEvidenceValidationError("public_origin_bound", "public origin marker bound exceeded");
  }

  const bytes = originBody(identity);
  const published = publishPrivateFileExclusive(path, bytes);
  if (!published.created) {
    readOrigin(path, identity);
    return;
  }

  // Separate CLI processes can both observe one free slot before either publishes.
  // Reclaim unreferenced history after publication, then remove only this call's marker
  // if the directory still cannot converge inside the hard cap.
  if (originNames(dir).length > MAX_ORIGINS) {
    reclaimUnreferencedOrigins(dir, path, configDir);
    if (originNames(dir).length > MAX_ORIGINS) {
      try { unlinkSync(path); } catch { /* preserve the quota failure */ }
      throw new PublicEvidenceValidationError("public_origin_bound", "public origin marker bound exceeded");
    }
  }
}

export function listLocalPublicOrigins(configDir?: string): PublicOriginIdentityV1[] {
  ensureLabDirs(configDir);
  const dir = labPublicOriginDir(configDir);
  const names = originNames(dir);
  if (names.length > MAX_ORIGINS) {
    throw new PublicEvidenceValidationError("public_origin_bound", "public origin marker bound exceeded");
  }
  if (foreignOriginNames(dir).length > 0) {
    throw new PublicEvidenceValidationError("public_origin_unsafe", "unexpected public origin marker entry");
  }
  const identities: PublicOriginIdentityV1[] = [];
  for (const name of names) {
    const match = ORIGIN_RE.exec(name)!;
    const expected = { publisherKeyId: match[1]!, bundleId: match[2]! };
    identities.push(readOrigin(join(dir, name), expected));
  }
  return identities;
}

export function clearLocalPublicOrigins(configDir?: string): void {
  ensureLabDirs(configDir);
  const dir = labPublicOriginDir(configDir);
  cleanupStalePrivateFileStagesInDir(dir);
  for (const name of readdirSync(dir)) {
    if (!ORIGIN_RE.test(name)) continue;
    try { unlinkSync(join(dir, name)); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}
