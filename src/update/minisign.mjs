// Offline minisign primitives. These results prove only cryptographic validity;
// update authority is assigned separately by the signed-supply policy.
import { createHash, createPublicKey, verify } from "node:crypto";
import { snapshotUpdateBytes } from "./update-bytes.mjs";

const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
const TRUSTED_PREFIX = "trusted comment: ";

function decodeBase64(text, what, expectedBytes) {
  const payload = Buffer.from(text, "base64");
  if (!text || payload.toString("base64") !== text
      || (expectedBytes !== undefined && payload.length !== expectedBytes)) {
    throw new Error(`Malformed ${what}: invalid base64 or decoded length`);
  }
  return payload;
}

function boxLines(text) {
  return text.replace(/\r\n/g, "\n").replace(/\n$/, "").split("\n");
}

/** Decode the text form of a minisign public key; this does not establish trust. */
export function decodePublicKey(text) {
  const lines = boxLines(text);
  if (lines.length !== 2 || !lines[0].startsWith("untrusted comment: ")) {
    throw new Error("Malformed minisign public key box");
  }
  const packet = decodeBase64(lines[1], "minisign public key", 42);
  const algorithm = packet.subarray(0, 2).toString("utf8");
  if (algorithm !== "Ed") {
    throw new Error(`Unsupported minisign public key algorithm: ${JSON.stringify(algorithm)}`);
  }
  const raw = packet.subarray(10);
  return Object.freeze({
    keyId: packet.subarray(2, 10).toString("hex"),
    publicKey: createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, raw]), format: "der", type: "spki" }),
    fingerprint: createHash("sha256").update(raw).digest("hex"),
  });
}

function verifyBox(bytes, signatureBox, key, legacy) {
  // The historical release adapter accepts surrounding transport whitespace.
  const outer = legacy ? signatureBox.trim() : signatureBox;
  if (!legacy && outer.length > 5464) throw new Error("Malformed Tauri signature: box exceeds limit");
  const encoded = decodeBase64(outer, "Tauri signature");
  if (!legacy && encoded.length > 4096) throw new Error("Malformed Tauri signature: box exceeds limit");
  const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(encoded);
  const lines = boxLines(text);
  if (lines.length !== 4 || !lines[0].startsWith("untrusted comment: ")
      || !lines[2].startsWith(TRUSTED_PREFIX)) {
    throw new Error("Malformed signature box");
  }
  const packet = decodeBase64(lines[1], "signature packet", 74);
  const commentSignature = decodeBase64(lines[3], "comment signature", 64);
  const algorithm = packet.subarray(0, 2).toString("utf8");
  if (algorithm !== "ED") throw new Error(`Unsupported signature algorithm: ${JSON.stringify(algorithm)}`);
  const keyId = packet.subarray(2, 10).toString("hex");
  const expectedKeyId = key.keyId;
  if (keyId !== expectedKeyId) throw new Error(`Signature was made by key ${keyId}, not the pinned updater key ${expectedKeyId}`);
  // Capture one public-key representation, then reconstruct a private verifier
  // so caller-controlled accessors cannot change the signer between checks.
  let publicKeyDer;
  try { publicKeyDer = snapshotUpdateBytes(key.publicKey.export({ format: "der", type: "spki" }), 44); }
  catch { throw new Error("Malformed minisign public key"); }
  if (publicKeyDer.length !== 44 || !Buffer.from(publicKeyDer.subarray(0, 12)).equals(ED25519_SPKI_PREFIX)) {
    throw new Error("Malformed minisign public key");
  }
  const publicKey = createPublicKey({ key: Buffer.from(publicKeyDer), format: "der", type: "spki" });
  const signature = packet.subarray(10);
  const digest = createHash("blake2b512").update(bytes).digest();
  if (!verify(null, digest, publicKey, signature)) throw new Error("Signature verification failed");
  const exactComment = lines[2].slice(TRUSTED_PREFIX.length);
  const trustedComment = legacy ? exactComment.trim() : exactComment;
  const message = Buffer.concat([signature, Buffer.from(trustedComment, "utf8")]);
  if (!verify(null, message, publicKey, commentSignature)) throw new Error("Comment signature verification failed");
  const fingerprint = createHash("sha256").update(publicKeyDer.subarray(-32)).digest("hex");
  return { keyId, fingerprint, trustedComment };
}

/** Verify both signatures using the exact trusted-comment bytes. */
export function verifyMinisignBytes(bytes, signatureBox, key) {
  return verifyBox(bytes, signatureBox, key, false);
}

/** Compatibility-only adapter for the existing release verifier's trimmed comment. */
export function verifyLegacyMinisignBytes(bytes, signatureBox, key) {
  return verifyBox(bytes, signatureBox, key, true);
}
