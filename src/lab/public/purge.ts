import { createPrivateKey, createPublicKey } from "node:crypto";
import {
  closeSync,
  constants as fsConstants,
  fsyncSync,
  openSync,
  readdirSync,
  rmSync,
  unlinkSync,
} from "node:fs";
import { join } from "node:path";
import {
  ensureLabDirs,
  labCommunityDir,
  labExportDir,
  labPublicOriginDir,
  labPublicPublisherKeyPath,
} from "../paths";
import {
  isCommunityRevocationFileName,
  parseCommunityBundleFileName,
} from "./community-files";
import { readPrivateRegularFile } from "./file-safety";
import { publicEvidenceId } from "./ids";
import { withPublicEvidenceMutationLock } from "./mutation-lock";
import { clearLocalPublicOrigins } from "./origin";
import { recoverPublicOriginsForPurge } from "./origin-purge";
import { publicEvidencePurgeFaultForTests } from "./purge-test-fault";
import { readPublicEvidenceBundle } from "./storage";
import { parseStrictPublicJson } from "./strict-json";
import { PublicEvidenceValidationError } from "./validate";

const MAX_PRIVATE_KEY_BYTES = 8 * 1024;
const MAX_COMMUNITY_OBJECT_BYTES = 2 * 1024 * 1024;
const EXPORT_FILE_RE = /^([0-9a-f]{64})\.json$/;

function syncPurgeDirectory(dir: string, label: "export" | "community" | "origin"): void {
  if (process.platform === "win32") return;
  if (label === "export" && publicEvidencePurgeFaultForTests() === "export_directory_sync") {
    throw new Error("synthetic public export directory sync failure");
  }
  let fd: number | null = null;
  try {
    fd = openSync(dir, fsConstants.O_RDONLY);
    fsyncSync(fd);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`public ${label} purge directory sync failed: ${detail}`);
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

/**
 * Publisher provenance is useful only for classifying local community copies. A corrupt
 * key must never block deletion of sensitive exports, so classification fails closed to
 * "unknown publisher" while the purge continues.
 */
function readExistingPublisherKeyId(configDir?: string): string | null {
  const path = labPublicPublisherKeyPath(configDir);
  try {
    const pem = readPrivateRegularFile(path, {
      maxBytes: MAX_PRIVATE_KEY_BYTES,
      errorCode: "public_publisher_key_unsafe",
      errorMessage: "public publisher key is unsafe during purge",
      requireMode600: true,
    }).toString("utf8");
    if (!pem.includes("BEGIN PRIVATE KEY")) return null;
    const privateKey = createPrivateKey(pem);
    if (privateKey.asymmetricKeyType !== "ed25519") return null;
    const publicKey = createPublicKey(pem);
    const publicKeyDer = publicKey.export({ type: "spki", format: "der" }).toString("base64");
    return publicEvidenceId("publisher_key", { algorithm: "ed25519", publicKey: publicKeyDer });
  } catch {
    return null;
  }
}

function publicIdentity(publisherKeyId: string, bundleId: string): string {
  return `${publisherKeyId}:${bundleId}`;
}

/** Best-effort legacy classification only. Malformed exports are still deleted below. */
function localExportIdentities(configDir?: string): Set<string> {
  const identities = new Set<string>();
  for (const entry of readdirSync(labExportDir(configDir), { withFileTypes: true })) {
    const match = EXPORT_FILE_RE.exec(entry.name);
    if (!match) continue;
    try {
      const bundle = readPublicEvidenceBundle(match[1]!, configDir);
      identities.add(publicIdentity(bundle.publisher.keyId, bundle.bundleId));
    } catch {
      // Durable origin markers are the primary provenance source. Never retain a
      // malformed export merely because legacy recovery can no longer parse it.
    }
  }
  return identities;
}

function purgeAllExports(configDir?: string): number {
  if (publicEvidencePurgeFaultForTests() === "before_export_delete") {
    throw new Error("synthetic public export purge failure");
  }
  let deleted = 0;
  const exportDir = labExportDir(configDir);
  for (const entry of readdirSync(exportDir, { withFileTypes: true })) {
    rmSync(join(exportDir, entry.name), { recursive: entry.isDirectory(), force: true });
    deleted += 1;
  }
  // A previous attempt may already have removed all names but failed its directory
  // fsync. Re-sync even when this retry deletes zero entries before reporting success.
  syncPurgeDirectory(exportDir, "export");
  return deleted;
}

/**
 * Provenance classification happens before this call. Purge removes only the exact
 * community cache pathname, so a symlink or hardlink cannot redirect deletion to a peer.
 */
function unlinkLocalCommunityFile(path: string): boolean {
  try {
    unlinkSync(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function communityObjectPublisherKeyId(path: string): string | null {
  try {
    const raw = parseStrictPublicJson(
      readPrivateRegularFile(path, {
        maxBytes: MAX_COMMUNITY_OBJECT_BYTES,
        errorCode: "community_unsafe_target",
        errorMessage: "community object is unsafe during purge",
      }),
      "community object during purge",
    );
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    const publisher = (raw as { publisher?: unknown }).publisher;
    if (!publisher || typeof publisher !== "object" || Array.isArray(publisher)) return null;
    const keyId = (publisher as { keyId?: unknown }).keyId;
    return typeof keyId === "string" && /^[0-9a-f]{64}$/.test(keyId) ? keyId : null;
  } catch {
    return null;
  }
}

function purgeLocalPublicEvidenceCopiesLocked(configDir?: string): {
  deletedExports: number;
  deletedCommunityBundles: number;
  deletedCommunityRevocations: number;
} {
  const exportedIdentities = localExportIdentities(configDir);
  const originRecovery = recoverPublicOriginsForPurge(configDir);
  const localPublisherKeyIds = new Set<string>();
  for (const origin of originRecovery.identities) {
    exportedIdentities.add(publicIdentity(origin.publisherKeyId, origin.bundleId));
    localPublisherKeyIds.add(origin.publisherKeyId);
  }
  const currentPublisherKeyId = readExistingPublisherKeyId(configDir);
  if (currentPublisherKeyId) localPublisherKeyIds.add(currentPublisherKeyId);
  const communityDir = labCommunityDir(configDir);

  // Sensitive local exports are the mandatory deletion target. Provenance is captured
  // before this point, so cleanup remains possible even after the export bytes disappear.
  const deletedExports = purgeAllExports(configDir);

  let deletedCommunityBundles = 0;
  let deletedCommunityRevocations = 0;
  for (const entry of readdirSync(communityDir, { withFileTypes: true })) {
    const bundleIdentity = parseCommunityBundleFileName(entry.name);
    if (bundleIdentity) {
      const { publisherKeyId, bundleId } = bundleIdentity;
      const locallyOriginated = exportedIdentities.has(publicIdentity(publisherKeyId, bundleId))
        || localPublisherKeyIds.has(publisherKeyId);
      if (locallyOriginated && unlinkLocalCommunityFile(join(communityDir, entry.name))) {
        deletedCommunityBundles += 1;
      }
      continue;
    }

    if (isCommunityRevocationFileName(entry.name)) {
      const path = join(communityDir, entry.name);
      const publisherKeyId = communityObjectPublisherKeyId(path);
      if (publisherKeyId && localPublisherKeyIds.has(publisherKeyId)
        && unlinkLocalCommunityFile(path)) {
        deletedCommunityRevocations += 1;
      }
    }
  }
  // As with exports, a retry after a failed directory fsync may have no remaining
  // names to unlink. Re-sync the directory unconditionally before success.
  syncPurgeDirectory(communityDir, "community");

  if (originRecovery.skipped > 0) {
    // Preserve provenance markers for operator recovery. Sensitive exports are already
    // durably gone, but unknown community copies cannot be reported as fully purged.
    throw new PublicEvidenceValidationError(
      "public_origin_incomplete",
      `public origin classification incomplete: ${originRecovery.skipped} marker(s) could not be validated`,
    );
  }

  // Markers are purge-owned public provenance only. Remove them last, then establish
  // deletion durability before the caller may record an export purge tombstone.
  clearLocalPublicOrigins(configDir);
  syncPurgeDirectory(labPublicOriginDir(configDir), "origin");
  return { deletedExports, deletedCommunityBundles, deletedCommunityRevocations };
}

export function purgeLocalPublicEvidenceCopies(configDir?: string): {
  deletedExports: number;
  deletedCommunityBundles: number;
  deletedCommunityRevocations: number;
} {
  ensureLabDirs(configDir);
  return withPublicEvidenceMutationLock(
    configDir,
    () => purgeLocalPublicEvidenceCopiesLocked(configDir),
  );
}
