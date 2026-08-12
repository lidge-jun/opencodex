import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign as cryptoSign,
  verify as cryptoVerify,
  type KeyObject,
} from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants as fsConstants,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  writeSync,
} from "node:fs";
import { ensureLabDirs, labPublicPublisherKeyPath } from "../paths";
import { publicBundleDigest, publicPublisherKeyId } from "./ids";
import type {
  PublicEvidenceBundleUnsignedV1,
  PublicEvidenceBundleV1,
  PublicPublisherSignerV1,
  PublicPublisherV1,
  PublicBundleVerificationResult,
} from "./types";
import { PublicEvidenceValidationError } from "./validate";
import { validatePublicEvidenceBundleUnsigned } from "./bundle";

const signerKeys = new WeakMap<object, KeyObject>();
const O_NOFOLLOW = (fsConstants as { O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0;
const MAX_PRIVATE_KEY_BYTES = 8 * 1024;

function writeAll(fd: number, bytes: Uint8Array): void {
  let offset = 0;
  while (offset < bytes.byteLength) {
    const count = writeSync(fd, bytes, offset, bytes.byteLength - offset);
    if (count <= 0) throw new PublicEvidenceValidationError("publisher_key_write", "publisher key write made no progress");
    offset += count;
  }
}
function assertPrivateKeyFile(path: string, fd: number): void {
  const stats = fstatSync(fd);
  if (!stats.isFile() || stats.isSymbolicLink() || stats.nlink !== 1 || stats.size > MAX_PRIVATE_KEY_BYTES) throw new PublicEvidenceValidationError("publisher_key_unsafe", "publisher key target is not a bounded regular file");
  if (process.platform !== "win32" && (stats.mode & 0o777) !== 0o600) chmodSync(path, 0o600);
}
function loadPrivateKey(path: string): KeyObject {
  const before = lstatSync(path);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) throw new PublicEvidenceValidationError("publisher_key_unsafe", "publisher key path is unsafe");
  const fd = openSync(path, fsConstants.O_RDONLY | O_NOFOLLOW);
  try {
    assertPrivateKeyFile(path, fd);
    const pem = readFileSync(fd, { encoding: "utf8" });
    if (Buffer.byteLength(pem) > MAX_PRIVATE_KEY_BYTES || !pem.includes("BEGIN PRIVATE KEY")) throw new PublicEvidenceValidationError("publisher_key_invalid", "publisher key encoding invalid");
    const key = createPrivateKey(pem);
    if (key.asymmetricKeyType !== "ed25519") throw new PublicEvidenceValidationError("publisher_key_invalid", "publisher key must be Ed25519");
    return key;
  } finally { closeSync(fd); }
}
function createPrivateKeyFile(path: string): KeyObject {
  const { privateKey } = generateKeyPairSync("ed25519");
  const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  let fd: number | null = null;
  try {
    fd = openSync(path, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | O_NOFOLLOW, 0o600);
    writeAll(fd, Buffer.from(pem, "utf8"));
    fsyncSync(fd);
    assertPrivateKeyFile(path, fd);
    return privateKey;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return loadPrivateKey(path);
    throw error;
  } finally { if (fd !== null) closeSync(fd); }
}
function publisherForPrivateKey(privateKey: KeyObject): PublicPublisherV1 {
  const privatePem = privateKey.export({ type: "pkcs8", format: "pem" });
  const publicKey = createPublicKey(privatePem);
  const der = publicKey.export({ type: "spki", format: "der" });
  return Object.freeze({ algorithm: "ed25519" as const, keyId: publicPublisherKeyId(der), publicKey: der.toString("base64") });
}
export function getOrCreatePublicPublisher(configDir?: string): PublicPublisherSignerV1 {
  ensureLabDirs(configDir);
  const path = labPublicPublisherKeyPath(configDir);
  let key: KeyObject;
  try { key = loadPrivateKey(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    key = createPrivateKeyFile(path);
  }
  const signer: PublicPublisherSignerV1 = Object.freeze({ publisher: publisherForPrivateKey(key) });
  signerKeys.set(signer, key);
  return signer;
}

/** Internal CL-10 primitive. Not re-exported by the public barrel. */
export function signDigestWithPublicPublisherCapability(digest: string, signer: PublicPublisherSignerV1): string {
  if (!/^[0-9a-f]{64}$/.test(digest)) throw new PublicEvidenceValidationError("invalid_signing_digest", "signing digest must be lowercase sha256 hex");
  const privateKey = signerKeys.get(signer as object);
  if (!privateKey) throw new PublicEvidenceValidationError("publisher_signer_untrusted", "publisher signer is not a live local signer capability");
  return cryptoSign(null, Buffer.from(digest, "hex"), privateKey).toString("base64");
}

function signedPayload(unsigned: PublicEvidenceBundleUnsignedV1, publisher: PublicPublisherV1): Record<string, unknown> {
  return { schemaVersion: unsigned.schemaVersion, exportPolicyVersion: unsigned.exportPolicyVersion, bundleId: unsigned.bundleId, createdDayUtc: unsigned.createdDayUtc, publisher, records: unsigned.records, artifacts: unsigned.artifacts };
}
export function signPublicEvidenceBundle(rawUnsigned: PublicEvidenceBundleUnsignedV1, signer: PublicPublisherSignerV1): PublicEvidenceBundleV1 {
  const unsigned = validatePublicEvidenceBundleUnsigned(rawUnsigned);
  const digest = publicBundleDigest(signedPayload(unsigned, signer.publisher));
  const signature = signDigestWithPublicPublisherCapability(digest, signer);
  return Object.freeze({ ...unsigned, publisher: signer.publisher, bundleDigest: digest, signature: Object.freeze({ algorithm: "ed25519" as const, signedDigest: digest, signature }) });
}
function isPlainObject(value: unknown): value is Record<string, unknown> { return !!value && typeof value === "object" && !Array.isArray(value); }
function closedKeys(value: Record<string, unknown>, keys: readonly string[]): boolean { const allowed = new Set(keys); return Object.keys(value).every((key) => allowed.has(key)) && keys.every((key) => key in value); }
export function decodeCanonicalPublicBase64(value: unknown, maxBytes: number): Buffer | null {
  if (typeof value !== "string" || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) return null;
  const bytes = Buffer.from(value, "base64");
  if (bytes.byteLength > maxBytes || bytes.toString("base64") !== value) return null;
  return bytes;
}
export function verifyPublicPublisherSignature(digest: string, publisher: PublicPublisherV1, signature: string): boolean {
  if (!/^[0-9a-f]{64}$/.test(digest)) return false;
  const publicKeyDer = decodeCanonicalPublicBase64(publisher.publicKey, 1024);
  const signatureBytes = decodeCanonicalPublicBase64(signature, 128);
  if (!publicKeyDer || publicPublisherKeyId(publicKeyDer) !== publisher.keyId || !signatureBytes || signatureBytes.byteLength !== 64) return false;
  try {
    const publicKey = createPublicKey({ key: publicKeyDer, format: "der", type: "spki" });
    return publicKey.asymmetricKeyType === "ed25519" && cryptoVerify(null, Buffer.from(digest, "hex"), publicKey, signatureBytes);
  } catch { return false; }
}
export function verifyPublicEvidenceBundle(raw: unknown): PublicBundleVerificationResult {
  try {
    if (!isPlainObject(raw) || !closedKeys(raw, ["schemaVersion", "exportPolicyVersion", "bundleId", "createdDayUtc", "publisher", "records", "artifacts", "bundleDigest", "signature"])) return { status: "schema_rejected", detail: "closed bundle schema mismatch" };
    const unsignedRaw = { schemaVersion: raw.schemaVersion, exportPolicyVersion: raw.exportPolicyVersion, bundleId: raw.bundleId, createdDayUtc: raw.createdDayUtc, records: raw.records, artifacts: raw.artifacts };
    let unsigned: PublicEvidenceBundleUnsignedV1;
    try { unsigned = validatePublicEvidenceBundleUnsigned(unsignedRaw); }
    catch (error) {
      if (error instanceof PublicEvidenceValidationError && error.code === "bundle_digest") return { status: "digest_invalid", detail: error.message };
      return { status: "schema_rejected", detail: error instanceof Error ? error.message : String(error) };
    }
    if (!isPlainObject(raw.publisher) || !closedKeys(raw.publisher, ["algorithm", "keyId", "publicKey"]) || raw.publisher.algorithm !== "ed25519") return { status: "schema_rejected", detail: "publisher schema mismatch" };
    if (typeof raw.publisher.keyId !== "string" || !/^[0-9a-f]{64}$/.test(raw.publisher.keyId) || typeof raw.publisher.publicKey !== "string") return { status: "schema_rejected", detail: "publisher key invalid" };
    const publisher: PublicPublisherV1 = { algorithm: "ed25519", keyId: raw.publisher.keyId, publicKey: raw.publisher.publicKey };
    const publicKeyDer = decodeCanonicalPublicBase64(publisher.publicKey, 1024);
    if (!publicKeyDer || publicPublisherKeyId(publicKeyDer) !== publisher.keyId) return { status: "schema_rejected", detail: "publisher public key invalid" };
    if (typeof raw.bundleDigest !== "string" || !/^[0-9a-f]{64}$/.test(raw.bundleDigest)) return { status: "schema_rejected", detail: "bundle digest invalid" };
    if (!isPlainObject(raw.signature) || !closedKeys(raw.signature, ["algorithm", "signedDigest", "signature"]) || raw.signature.algorithm !== "ed25519" || typeof raw.signature.signature !== "string") return { status: "schema_rejected", detail: "signature schema mismatch" };
    if (raw.signature.signedDigest !== raw.bundleDigest) return { status: "digest_invalid", detail: "signed digest does not match bundle digest" };
    const expectedDigest = publicBundleDigest(signedPayload(unsigned, publisher));
    if (expectedDigest !== raw.bundleDigest) return { status: "digest_invalid", detail: "canonical bundle digest mismatch" };
    if (!verifyPublicPublisherSignature(raw.bundleDigest, publisher, raw.signature.signature)) return { status: "signature_invalid", detail: "Ed25519 signature verification failed" };
    return { status: "cryptographically_valid", bundle: { ...unsigned, publisher, bundleDigest: raw.bundleDigest, signature: { algorithm: "ed25519", signedDigest: raw.bundleDigest, signature: raw.signature.signature } } };
  } catch (error) { return { status: "schema_rejected", detail: error instanceof Error ? error.message : String(error) }; }
}
