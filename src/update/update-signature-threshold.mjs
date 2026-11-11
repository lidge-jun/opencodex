import { decodePublicKey, verifyMinisignBytes } from "./minisign.mjs";

const FINGERPRINT = /^[0-9a-f]{64}$/;

/** Verify a supplied signer set; callers must separately establish its authority. */
export function verifySignatureThreshold(bytes, envelope, keys, threshold) {
  if (!(bytes instanceof Uint8Array) || !Array.isArray(keys) || keys.length < 1 || keys.length > 16
      || !Number.isSafeInteger(threshold) || threshold < 1 || threshold > keys.length
      || !Array.isArray(envelope?.signatures) || envelope.signatures.length < 1 || envelope.signatures.length > 16) {
    throw new Error("Invalid signature threshold input");
  }
  const authorized = new Map();
  for (const entry of keys) {
    if (!entry || typeof entry.keyId !== "string" || !FINGERPRINT.test(entry.keyId)
        || entry.algorithm !== "minisign-ed25519-blake2b512/1" || typeof entry.publicKey !== "string"
        || !entry.publicKey || entry.publicKey.length > 5464 || authorized.has(entry.keyId)) {
      throw new Error("Invalid signature threshold key");
    }
    const encoded = Buffer.from(entry.publicKey, "base64");
    if (encoded.length > 4096 || encoded.toString("base64") !== entry.publicKey) {
      throw new Error("Invalid signature threshold key encoding");
    }
    const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(encoded);
    const key = decodePublicKey(text);
    if (key.fingerprint !== entry.keyId) throw new Error("Signature threshold key fingerprint mismatch");
    authorized.set(entry.keyId, key);
  }
  const seen = new Set();
  let verified = 0;
  for (const signature of envelope.signatures) {
    if (!signature || typeof signature.keyFingerprint !== "string" || !FINGERPRINT.test(signature.keyFingerprint)
        || typeof signature.signatureBox !== "string" || !signature.signatureBox
        || signature.signatureBox.length > 5464 || seen.has(signature.keyFingerprint)) {
      throw new Error("Invalid signature threshold envelope");
    }
    seen.add(signature.keyFingerprint);
    const raw = Buffer.from(signature.signatureBox, "base64");
    if (raw.length > 4096 || raw.toString("base64") !== signature.signatureBox) {
      throw new Error("Invalid signature threshold envelope encoding");
    }
    const key = authorized.get(signature.keyFingerprint);
    if (!key) continue; // Root rotation may carry signatures from both key sets.
    verifyMinisignBytes(bytes, signature.signatureBox, key);
    verified++;
  }
  if (verified < threshold) throw new Error("Signature threshold not met");
}
