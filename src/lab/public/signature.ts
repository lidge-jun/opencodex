import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign as signBytes,
  verify as verifyBytes,
} from "node:crypto";
import {
  closeSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { ensureLabDirs } from "../paths";
import { buildPublicEvidenceBundle, expectedPublicBundleIdentity, type BuildPublicEvidenceBundleInput } from "./bundle";
import { publicEvidenceId } from "./ids";
import type {
  PublicEvidenceBundleV1,
  PublicPublisherV1,
} from "./types";

const PUBLISHER_KEY_FILE = "publisher-ed25519.pem";

export interface PublicPublisherHandle {
  publisher: PublicPublisherV1;
  privateKeyPath: string;
}

function publicKeyBase64(privateKeyPem: string): string {
  const publicKey = createPublicKey(createPrivateKey(privateKeyPem));
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

function readRestrictedPrivateKey(path: string): string {
  const stats = lstatSync(path);
  if (stats.isSymbolicLink() || !stats.isFile() || stats.nlink !== 1) {
    throw new Error("public publisher key path is not a private regular file");
  }
  if (process.platform !== "win32" && (stats.mode & 0o777) !== 0o600) {
    throw new Error("public publisher key permissions must be 0600");
  }
  const pem = readFileSync(path, "utf8");
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
  let fd: number | undefined;
  try {
    fd = openSync(path, "wx", 0o600);
    writeFileSync(fd, privateKey, { encoding: "utf8" });
    fsyncSync(fd);
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
  return readRestrictedPrivateKey(path);
}

export function getOrCreatePublicPublisher(configDir?: string): PublicPublisherHandle {
  const paths = ensureLabDirs(configDir);
  const privateKeyPath = join(paths.root, PUBLISHER_KEY_FILE);
  let privateKeyPem: string;
  try {
    privateKeyPem = readRestrictedPrivateKey(privateKeyPath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") throw error;
    try {
      privateKeyPem = createPrivateKeyFile(privateKeyPath);
    } catch (createError) {
      if ((createError as NodeJS.ErrnoException).code !== "EEXIST") throw createError;
      privateKeyPem = readRestrictedPrivateKey(privateKeyPath);
    }
  }
  return { publisher: publisherForPrivateKey(privateKeyPem), privateKeyPath };
}

export interface SignPublicEvidenceBundleInput extends Omit<BuildPublicEvidenceBundleInput, "publisher"> {
  configDir?: string;
}

export function signPublicEvidenceBundle(input: SignPublicEvidenceBundleInput): PublicEvidenceBundleV1 {
  const handle = getOrCreatePublicPublisher(input.configDir);
  const unsigned = buildPublicEvidenceBundle({
    records: input.records,
    artifacts: input.artifacts,
    createdDayUtc: input.createdDayUtc,
    publisher: handle.publisher,
  });
  const privateKeyPem = readRestrictedPrivateKey(handle.privateKeyPath);
  const signature = signBytes(null, Buffer.from(unsigned.bundleDigest, "hex"), createPrivateKey(privateKeyPem));
  return {
    ...unsigned,
    signature: {
      algorithm: "ed25519",
      signedDigest: unsigned.bundleDigest,
      signature: signature.toString("base64"),
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
    const expected = expectedPublicBundleIdentity(bundle);
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
