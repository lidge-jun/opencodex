import { createPrivateKey, createPublicKey } from "node:crypto";
import {
  closeSync,
  constants as fsConstants,
  existsSync,
  fstatSync,
  lstatSync,
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
  labPublicExportsDir,
  labPublicPublisherKeyPath,
} from "../paths";
import { readCommunityEvidenceBundleForPublisher } from "./community";
import { publicEvidenceId } from "./ids";
import { readPublicEvidenceBundle } from "./storage";
import { PublicEvidenceValidationError } from "./validate";

const O_NOFOLLOW = (fsConstants as { O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0;
const MAX_PRIVATE_KEY_BYTES = 8 * 1024;
const EXPORT_FILE_RE = /^([0-9a-f]{64})\.json$/;
const COMMUNITY_BUNDLE_RE = /^bundle-([0-9a-f]{64})-([0-9a-f]{64})\.json$/;

function readExistingPublisherKeyId(configDir?: string): string | null {
  const path = labPublicPublisherKeyPath(configDir);
  if (!existsSync(path)) return null;

  const before = lstatSync(path);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > MAX_PRIVATE_KEY_BYTES) {
    throw new PublicEvidenceValidationError(
      "publisher_key_unsafe",
      "cannot establish local publisher provenance from an unsafe publisher key file",
    );
  }
  if (process.platform !== "win32" && (before.mode & 0o777) !== 0o600) {
    throw new PublicEvidenceValidationError(
      "publisher_key_unsafe",
      "cannot establish local publisher provenance from an incorrectly-permissioned publisher key file",
    );
  }

  const fd = openSync(path, fsConstants.O_RDONLY | O_NOFOLLOW);
  try {
    const stats = fstatSync(fd);
    if (!stats.isFile() || stats.isSymbolicLink() || stats.nlink !== 1 || stats.size > MAX_PRIVATE_KEY_BYTES) {
      throw new PublicEvidenceValidationError(
        "publisher_key_unsafe",
        "publisher key changed while establishing local public-evidence provenance",
      );
    }
    const pem = readFileSync(fd, { encoding: "utf8" });
    if (Buffer.byteLength(pem) > MAX_PRIVATE_KEY_BYTES || !pem.includes("BEGIN PRIVATE KEY")) {
      throw new PublicEvidenceValidationError("publisher_key_invalid", "local publisher key encoding is invalid");
    }
    const privateKey = createPrivateKey(pem);
    if (privateKey.asymmetricKeyType !== "ed25519") {
      throw new PublicEvidenceValidationError("publisher_key_invalid", "local publisher key is not Ed25519");
    }
    const publicKey = createPublicKey(pem);
    const publicKeyDer = publicKey.export({ type: "spki", format: "der" }).toString("base64");
    return publicEvidenceId("publisher_key", { algorithm: "ed25519", publicKey: publicKeyDer });
  } finally {
    closeSync(fd);
  }
}

function publicIdentity(publisherKeyId: string, bundleId: string): string {
  return `${publisherKeyId}:${bundleId}`;
}

function localExportIdentities(configDir?: string): Set<string> {
  const identities = new Set<string>();
  for (const entry of readdirSync(labPublicExportsDir(configDir), { withFileTypes: true })) {
    const match = EXPORT_FILE_RE.exec(entry.name);
    if (!match) continue;
    const bundle = readPublicEvidenceBundle(match[1]!, configDir);
    identities.add(publicIdentity(bundle.publisher.keyId, bundle.bundleId));
  }
  return identities;
}

function purgeAllExports(configDir?: string): number {
  let deleted = 0;
  for (const entry of readdirSync(labPublicExportsDir(configDir), { withFileTypes: true })) {
    rmSync(join(labPublicExportsDir(configDir), entry.name), { recursive: entry.isDirectory(), force: true });
    deleted++;
  }
  return deleted;
}

export function purgeLocalPublicEvidenceCopies(configDir?: string): {
  deletedExports: number;
  deletedCommunityBundles: number;
} {
  ensureLabDirs(configDir);
  const exportedIdentities = localExportIdentities(configDir);
  const localPublisherKeyId = readExistingPublisherKeyId(configDir);
  const communityDir = labCommunityDir(configDir);

  let deletedCommunityBundles = 0;
  for (const entry of readdirSync(communityDir, { withFileTypes: true })) {
    const match = COMMUNITY_BUNDLE_RE.exec(entry.name);
    if (!match) continue;
    const publisherKeyId = match[1]!;
    const bundleId = match[2]!;
    const locallyOriginated = exportedIdentities.has(publicIdentity(publisherKeyId, bundleId))
      || publisherKeyId === localPublisherKeyId;
    if (!locallyOriginated) continue;

    const bundle = readCommunityEvidenceBundleForPublisher(bundleId, publisherKeyId, configDir);
    if (bundle.publisher.keyId !== publisherKeyId || bundle.bundleId !== bundleId) {
      throw new PublicEvidenceValidationError(
        "community_identity_mismatch",
        `community bundle identity changed while purging: ${entry.name}`,
      );
    }

    const path = join(communityDir, entry.name);
    const before = lstatSync(path);
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) {
      throw new PublicEvidenceValidationError(
        "community_unsafe_target",
        `refusing to purge unsafe locally-originated community bundle path: ${entry.name}`,
      );
    }
    unlinkSync(path);
    deletedCommunityBundles++;
  }

  return {
    deletedExports: purgeAllExports(configDir),
    deletedCommunityBundles,
  };
}
