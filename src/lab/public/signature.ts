import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign as signBytes,
  verify as verifyBytes,
} from "node:crypto";
import { ensureLabDirs, labPublicPublisherKeyPath } from "../paths";
import { hardenSecretPath } from "../../lib/windows-secret-acl";
import {
  buildPublicEvidenceBundle,
  canonicalPublicEvidenceContent,
  expectedPublicBundleIdentityFromNormalized,
  normalizePublicEvidenceContent,
  type BuildPublicEvidenceBundleInput,
} from "./bundle";
import { validatePublicEvidenceAuthorities } from "./community-authority";
import { privateRegularFileSize, readPrivateRegularFile } from "./file-safety";
import { publicEvidenceId } from "./ids";
import { cleanupStalePrivateFileStages, publishPrivateFileExclusive } from "./private-file";
import { validatePublicEvidencePrivacy, validatePublicEvidenceRecordPrivacy } from "./privacy";
import type {
  PublicEvidenceBundleV1,
  PublicPublisherV1,
} from "./types";
import { PublicEvidenceValidationError } from "./validate";

const MAX_PRIVATE_KEY_BYTES = 8 * 1024;
const PRIVATE_KEY_FILE_OPTIONS = {
  maxBytes: MAX_PRIVATE_KEY_BYTES,
  errorCode: "public_publisher_key_unsafe",
  errorMessage: "public publisher key path is not a bounded private regular file with 0600 permissions",
  requireMode600: true,
} as const;

export interface PublicPublisherHandle {
  publisher: PublicPublisherV1;
  privateKeyPath: string;
}

function publicKeyBase64(privateKeyPem: string): string {
  const publicKey = createPublicKey(privateKeyPem);
  return publicKey.export({ type: "spki", format: "der" }).toString("base64");
}

function publisherForPrivateKey(privateKeyPem: string): PublicPublisherV1 {
  const publicKey = publicKeyBase64(privateKeyPem);
  return {
    algorithm: "ed25519",
    keyId: publicEvidenceId("publisher_key", { algorithm: "ed25519", publicKey }),
    publicKey,
  };
}

/**
 * The bounded errno-shaped code from a failed ACL harden, or null when the cause
 * carries none.
 *
 * Only the code is allowed into the message. `hardenSecretPath` already sanitizes
 * its own diagnostic prose, but this error is what reaches a CI log, so what
 * crosses that boundary is re-checked here rather than trusted: an errno code has
 * no separator, no lowercase and a bounded length, and therefore cannot carry the
 * key pathname or the username component inside it.
 */
function aclFailureCode(error: unknown): string | null {
  if (!(error instanceof Error) || !("code" in error)) return null;
  const code = (error as NodeJS.ErrnoException).code;
  return typeof code === "string" && /^[A-Z][A-Z0-9_]{1,30}$/.test(code) ? code : null;
}

function requirePublisherKeyAcl(path: string, timeoutMemoKey = path): void {
  privateRegularFileSize(path, PRIVATE_KEY_FILE_OPTIONS);
  let hardened: { ok: boolean };
  let hardeningError: unknown;
  try {
    hardened = hardenSecretPath(path, { required: true, timeoutMemoKey });
  } catch (error) {
    hardeningError = error;
    hardened = { ok: false };
  }
  if (!hardened.ok) {
    // Name the cause in the message, not only on `cause`. Every harden failure
    // reaches a CI log as this one string, and the three that occur there need
    // different fixes: ETIMEDOUT is the budget, EACLIDENTITY is the effective-SID
    // lookup, EICACLS is icacls refusing the path. A message identical across all
    // three cannot be acted on without a Windows box to re-run it under (#2152).
    const code = aclFailureCode(hardeningError);
    const failure = new PublicEvidenceValidationError(
      "public_publisher_key_unsafe",
      code
        ? `public publisher key ACL hardening did not complete (${code})`
        : "public publisher key ACL hardening did not complete",
    );
    if (hardeningError !== undefined) {
      (failure as Error & { cause?: unknown }).cause = hardeningError;
    }
    throw failure;
  }
}

function readRestrictedPrivateKey(path: string): string {
  cleanupStalePrivateFileStages(path);
  // Prove the pathname is the expected private regular file before applying any
  // platform ACL operation, then fail closed if Windows per-user ACL hardening
  // cannot be established. The helper is a no-op success on non-Windows.
  requirePublisherKeyAcl(path);
  const pem = readPrivateRegularFile(path, PRIVATE_KEY_FILE_OPTIONS).toString("utf8");
  const key = createPrivateKey(pem);
  if (key.asymmetricKeyType !== "ed25519") {
    throw new Error("public publisher key must be Ed25519");
  }
  return pem;
}

function createPrivateKeyFile(path: string): string {
  const { privateKey } = generateKeyPairSync("ed25519", {
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  publishPrivateFileExclusive(path, Buffer.from(privateKey, "utf8"), {
    // On Windows, harden the empty stage before private key bytes are written.
    // A required ACL failure therefore cannot strand secret bytes in a stage.
    prepareStage: stagePath => requirePublisherKeyAcl(stagePath, path),
  });
  return readRestrictedPrivateKey(path);
}

export function loadExistingPublicPublisher(configDir?: string): PublicPublisherHandle | null {
  const privateKeyPath = labPublicPublisherKeyPath(configDir);
  try {
    const privateKeyPem = readRestrictedPrivateKey(privateKeyPath);
    return { publisher: publisherForPrivateKey(privateKeyPem), privateKeyPath };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export function getOrCreatePublicPublisher(configDir?: string): PublicPublisherHandle {
  ensureLabDirs(configDir);
  const existing = loadExistingPublicPublisher(configDir);
  if (existing) return existing;
  const privateKeyPath = labPublicPublisherKeyPath(configDir);
  const privateKeyPem = createPrivateKeyFile(privateKeyPath);
  return { publisher: publisherForPrivateKey(privateKeyPem), privateKeyPath };
}

/** Centralized descriptor-bound signing primitive for the installation publisher key. */
export function signPublicPublisherDigest(handle: PublicPublisherHandle, digestHex: string): string {
  if (!/^[0-9a-f]{64}$/.test(digestHex)) {
    throw new PublicEvidenceValidationError("invalid_digest", "publisher signing digest must be lowercase sha256 hex");
  }
  const privateKeyPem = readRestrictedPrivateKey(handle.privateKeyPath);
  return signBytes(null, Buffer.from(digestHex, "hex"), createPrivateKey(privateKeyPem)).toString("base64");
}

export interface SignPublicEvidenceBundleInput extends Omit<BuildPublicEvidenceBundleInput, "publisher"> {
  configDir?: string;
}

function assertLocalArtifactExportAuthority(input: SignPublicEvidenceBundleInput): void {
  if (input.artifacts.length !== 0) {
    throw new PublicEvidenceValidationError(
      "public_artifact_authority_required",
      "artifact bytes require reviewed public_export policy authority before local signing",
    );
  }
}

export function signPublicEvidenceBundle(input: SignPublicEvidenceBundleInput): PublicEvidenceBundleV1 {
  // Validate every caller-controlled invariant before publisher identity state is touched.
  assertLocalArtifactExportAuthority(input);
  const normalized = normalizePublicEvidenceContent({
    records: input.records,
    artifacts: input.artifacts,
    createdDayUtc: input.createdDayUtc,
  });
  validatePublicEvidenceAuthorities(normalized.records);
  for (const record of normalized.records) validatePublicEvidenceRecordPrivacy(record);

  const handle = getOrCreatePublicPublisher(input.configDir);
  const unsigned = buildPublicEvidenceBundle({ ...normalized, publisher: handle.publisher });
  validatePublicEvidencePrivacy(unsigned);
  return {
    ...unsigned,
    signature: {
      algorithm: "ed25519",
      signedDigest: unsigned.bundleDigest,
      signature: signPublicPublisherDigest(handle, unsigned.bundleDigest),
    },
  };
}

export type PublicBundleVerificationResult =
  | { status: "cryptographically_valid" }
  | { status: "digest_invalid" }
  | { status: "signature_invalid" }
  | { status: "schema_rejected" };

export function verifyPublicEvidenceBundle(bundle: PublicEvidenceBundleV1): PublicBundleVerificationResult {
  try {
    const raw = bundle as unknown as Record<string, unknown>;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { status: "schema_rejected" };
    const allowed = new Set([
      "schemaVersion",
      "exportPolicyVersion",
      "bundleId",
      "createdDayUtc",
      "publisher",
      "records",
      "artifacts",
      "bundleDigest",
      "signature",
    ]);
    if (Object.keys(raw).some((key) => !allowed.has(key))) return { status: "schema_rejected" };
    if (bundle.schemaVersion !== "public_evidence_bundle_v1" || bundle.exportPolicyVersion !== "public_export_policy_v1") {
      return { status: "schema_rejected" };
    }
    if (!bundle.signature || bundle.signature.algorithm !== "ed25519") return { status: "schema_rejected" };
    if (Object.keys(bundle.signature).some((key) => !["algorithm", "signedDigest", "signature"].includes(key))) {
      return { status: "schema_rejected" };
    }
    const canonical = canonicalPublicEvidenceContent(bundle);
    if (!canonical.canonical) return { status: "schema_rejected" };
    const expected = expectedPublicBundleIdentityFromNormalized(canonical.normalized, bundle.publisher);
    if (bundle.bundleId !== expected.bundleId || bundle.bundleDigest !== expected.bundleDigest) {
      return { status: "digest_invalid" };
    }
    if (bundle.signature.signedDigest !== bundle.bundleDigest) return { status: "signature_invalid" };
    const key = createPublicKey({
      key: Buffer.from(bundle.publisher.publicKey, "base64"),
      type: "spki",
      format: "der",
    });
    if (key.asymmetricKeyType !== "ed25519") return { status: "signature_invalid" };
    const signature = Buffer.from(bundle.signature.signature, "base64");
    if (signature.toString("base64") !== bundle.signature.signature) return { status: "signature_invalid" };
    const valid = verifyBytes(null, Buffer.from(bundle.bundleDigest, "hex"), key, signature);
    return valid ? { status: "cryptographically_valid" } : { status: "signature_invalid" };
  } catch {
    return { status: "schema_rejected" };
  }
}
