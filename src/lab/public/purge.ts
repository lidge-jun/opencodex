import { createPrivateKey, createPublicKey } from "node:crypto";
import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  unlinkSync,
} from "node:fs";
import { join } from "node:path";
import {
  ensureLabDirs,
  labCommunityDir,
  labExportDir,
  labPublicPublisherKeyPath,
} from "../paths";
import { publicEvidenceId } from "./ids";
import { readPublicEvidenceBundle } from "./storage";
import { PublicEvidenceValidationError } from "./validate";

const O_NOFOLLOW = (fsConstants as { O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0;
const MAX_PRIVATE_KEY_BYTES = 8 * 1024;
const EXPORT_FILE_RE = /^([0-9a-f]{64})\.json$/;
const COMMUNITY_BUNDLE_RE = /^bundle-([0-9a-f]{64})-([0-9a-f]{64})\.json$/;

/**
 * Publisher provenance is useful only for classifying local community copies. A corrupt
 * key must never block deletion of sensitive exports, so classification fails closed to
 * "unknown publisher" while the purge continues.
 */
function readExistingPublisherKeyId(configDir?: string): string | null {
  const path = labPublicPublisherKeyPath(configDir);
  let fd: number | null = null;
  try {
    fd = openSync(path, fsConstants.O_RDONLY | O_NOFOLLOW);
    const stats = fstatSync(fd);
    if (!stats.isFile() || stats.isSymbolicLink() || stats.nlink !== 1 || stats.size > MAX_PRIVATE_KEY_BYTES) {
      return null;
    }
    if (process.platform !== "win32" && (stats.mode & 0o777) !== 0o600) return null;
    const pem = readFileSync(fd, { encoding: "utf8" });
    if (Buffer.byteLength(pem) > MAX_PRIVATE_KEY_BYTES || !pem.includes("BEGIN PRIVATE KEY")) return null;
    const privateKey = createPrivateKey(pem);
    if (privateKey.asymmetricKeyType !== "ed25519") return null;
    const publicKey = createPublicKey(pem);
    const publicKeyDer = publicKey.export({ type: "spki", format: "der" }).toString("base64");
    return publicEvidenceId("publisher_key", { algorithm: "ed25519", publicKey: publicKeyDer });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    return null;
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

function publicIdentity(publisherKeyId: string, bundleId: string): string {
  return `${publisherKeyId}:${bundleId}`;
}

/** Best-effort classification only. Malformed exports are still deleted below. */
function localExportIdentities(configDir?: string): Set<string> {
  const identities = new Set<string>();
  for (const entry of readdirSync(labExportDir(configDir), { withFileTypes: true })) {
    const match = EXPORT_FILE_RE.exec(entry.name);
    if (!match) continue;
    try {
      const bundle = readPublicEvidenceBundle(match[1]!, configDir);
      identities.add(publicIdentity(bundle.publisher.keyId, bundle.bundleId));
    } catch {
      // Deletion is authoritative. Never retain a malformed export just because it
      // can no longer be parsed well enough to classify its community copy.
    }
  }
  return identities;
}

function purgeAllExports(configDir?: string): number {
  let deleted = 0;
  const exportDir = labExportDir(configDir);
  for (const entry of readdirSync(exportDir, { withFileTypes: true })) {
    rmSync(join(exportDir, entry.name), { recursive: entry.isDirectory(), force: true });
    deleted += 1;
  }
  return deleted;
}

function unlinkLocalCommunityFile(path: string, entryName: string): boolean {
  let fd: number | null = null;
  try {
    fd = openSync(path, fsConstants.O_RDONLY | O_NOFOLLOW);
    const stats = fstatSync(fd);
    if (!stats.isFile() || stats.isSymbolicLink() || stats.nlink !== 1) {
      throw new PublicEvidenceValidationError(
        "community_unsafe_target",
        `refusing to purge unsafe locally-originated community bundle path: ${entryName}`,
      );
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  } finally {
    if (fd !== null) closeSync(fd);
  }
  try {
    unlinkSync(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

export function purgeLocalPublicEvidenceCopies(configDir?: string): {
  deletedExports: number;
  deletedCommunityBundles: number;
} {
  ensureLabDirs(configDir);
  const exportedIdentities = localExportIdentities(configDir);
  const localPublisherKeyId = readExistingPublisherKeyId(configDir);
  const communityDir = labCommunityDir(configDir);

  // Sensitive local exports are the mandatory deletion target. Delete them before any
  // optional provenance-dependent community cleanup so malformed bytes cannot block purge.
  const deletedExports = purgeAllExports(configDir);

  let deletedCommunityBundles = 0;
  for (const entry of readdirSync(communityDir, { withFileTypes: true })) {
    const match = COMMUNITY_BUNDLE_RE.exec(entry.name);
    if (!match) continue;
    const publisherKeyId = match[1]!;
    const bundleId = match[2]!;
    const locallyOriginated = exportedIdentities.has(publicIdentity(publisherKeyId, bundleId))
      || publisherKeyId === localPublisherKeyId;
    if (!locallyOriginated) continue;

    if (unlinkLocalCommunityFile(join(communityDir, entry.name), entry.name)) {
      deletedCommunityBundles += 1;
    }
  }

  return { deletedExports, deletedCommunityBundles };
}
