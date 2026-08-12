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
import { readCommunityEvidenceBundle } from "./community";
import { publicPublisherKeyId } from "./ids";
import { PublicEvidenceValidationError } from "./validate";

const O_NOFOLLOW = (fsConstants as { O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0;
const MAX_PRIVATE_KEY_BYTES = 8 * 1024;
const EXPORT_FILE_RE = /^([0-9a-f]{64})\.json$/;
const COMMUNITY_BUNDLE_RE = /^bundle-([0-9a-f]{64})\.json$/;

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
    const privatePem = privateKey.export({ type: "pkcs8", format: "pem" });
    const publicKey = createPublicKey(privatePem);
    const publicKeyDer = publicKey.export({ type: "spki", format: "der" });
    return publicPublisherKeyId(publicKeyDer);
  } finally {
    closeSync(fd);
  }
}

function localExportBundleIds(configDir?: string): Set<string> {
  const ids = new Set<string>();
  for (const entry of readdirSync(labPublicExportsDir(configDir), { withFileTypes: true })) {
    const match = EXPORT_FILE_RE.exec(entry.name);
    if (match) ids.add(match[1]!);
  }
  return ids;
}

function purgeAllExports(configDir?: string): number {
  const exportsDir = labPublicExportsDir(configDir);
  let deleted = 0;
  for (const entry of readdirSync(exportsDir, { withFileTypes: true })) {
    rmSync(join(exportsDir, entry.name), { recursive: entry.isDirectory(), force: true });
    deleted++;
  }
  return deleted;
}

/**
 * CL-10 sensitive-purge bridge.
 *
 * The pre-CL-10 purge contract already removes every local export when the
 * `export` action is selected. CL-10 additionally removes quarantined community
 * bundle copies that can be proven locally-originated, either because their
 * content id is currently present in the local export store or because their
 * publisher key is this installation's existing publisher key.
 *
 * Third-party community evidence is deliberately preserved. When local
 * provenance cannot be inspected safely, this function fails closed rather than
 * pretending the purge completed.
 */
export function purgeLocalPublicEvidenceCopies(configDir?: string): {
  deletedExports: number;
  deletedCommunityBundles: number;
} {
  ensureLabDirs(configDir);
  const exportedBundleIds = localExportBundleIds(configDir);
  const localPublisherKeyId = readExistingPublisherKeyId(configDir);
  const communityDir = labCommunityDir(configDir);

  let deletedCommunityBundles = 0;
  for (const entry of readdirSync(communityDir, { withFileTypes: true })) {
    const match = COMMUNITY_BUNDLE_RE.exec(entry.name);
    if (!match) continue;
    const bundleId = match[1]!;

    let locallyOriginated = exportedBundleIds.has(bundleId);
    if (!locallyOriginated && localPublisherKeyId) {
      const bundle = readCommunityEvidenceBundle(bundleId, configDir);
      locallyOriginated = bundle.publisher.keyId === localPublisherKeyId;
    }
    if (!locallyOriginated) continue;

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
