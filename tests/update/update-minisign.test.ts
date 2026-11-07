import { describe, expect, test } from "bun:test";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { readFileSync } from "node:fs";
import { repoPath } from "../helpers/repo-root";
import { decodePublicKey, verifyMinisignBytes, verifyLegacyMinisignBytes } from "../../src/update/minisign.mjs";
import { verifySignatureThreshold } from "../../src/update/update-signature-threshold.mjs";

describe("offline minisign verification", () => {
  test("uses one key identity for both signatures and the returned fingerprint", () => {
    const a = generateKeyPairSync("ed25519"), b = generateKeyPairSync("ed25519"), c = generateKeyPairSync("ed25519");
    const bytes = Buffer.from("fixture"), id = Buffer.alloc(8, 7), comment = "version:1.2.3";
    const payload = sign(null, createHash("blake2b512").update(bytes).digest(), a.privateKey);
    const global = sign(null, Buffer.concat([payload, Buffer.from(comment)]), b.privateKey);
    const packet = Buffer.concat([Buffer.from("ED"), id, payload]).toString("base64");
    const box = Buffer.from(`untrusted comment: fixture\n${packet}\ntrusted comment: ${comment}\n${global.toString("base64")}\n`).toString("base64");
    let reads = 0;
    const key = { keyId: id.toString("hex"), get publicKey() { return [a.publicKey, b.publicKey, c.publicKey][reads++] ?? c.publicKey; }, fingerprint: "" };
    expect(() => verifyMinisignBytes(bytes, box, key)).toThrow();
    expect(reads).toBe(1);
    const sameKeyGlobal = sign(null, Buffer.concat([payload, Buffer.from(comment)]), a.privateKey);
    const sameKeyBox = Buffer.from(`untrusted comment: fixture\n${packet}\ntrusted comment: ${comment}\n${sameKeyGlobal.toString("base64")}\n`).toString("base64");
    Object.defineProperty(a.publicKey, "export", { value: () => c.publicKey.export({ format: "der", type: "spki" }) });
    expect(() => verifyMinisignBytes(bytes, sameKeyBox, { keyId: id.toString("hex"), publicKey: a.publicKey, fingerprint: "" })).toThrow(/Signature verification failed/);
  });
  test("accepts the independent upstream prehashed vector and rejects changed bytes", () => {
    const fixture = JSON.parse(readFileSync(repoPath("tests/fixtures/minisign/prehashed-vector.json"), "utf8"));
    const key = decodePublicKey(`untrusted comment: upstream key\n${fixture.publicKeyBase64}\n`);
    const box = Buffer.from(fixture.signatureBox).toString("base64");
    expect(verifyMinisignBytes(Buffer.from(fixture.payload), box, key).keyId).toBe(key.keyId);
    expect(() => verifyMinisignBytes(Buffer.from("altered"), box, key)).toThrow(/Signature verification failed/);
  });

  test("strict comment bytes and legacy normalization are separate", () => {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const raw = Buffer.from(publicKey.export({ format: "der", type: "spki" })).subarray(-32);
    const id = Buffer.from("0123456789abcdef", "hex");
    const key = decodePublicKey(`untrusted comment: fixture\n${Buffer.concat([Buffer.from("Ed"), id, raw]).toString("base64")}\n`);
    const bytes = Buffer.from("fixture payload");
    const signature = sign(null, createHash("blake2b512").update(bytes).digest(), privateKey);
    const packet = Buffer.concat([Buffer.from("ED"), id, signature]).toString("base64");
    const comment = "  version:1.2.3\t";
    const makeBox = (signedComment: string, newline: string) => {
      const global = sign(null, Buffer.concat([signature, Buffer.from(signedComment)]), privateKey).toString("base64");
      return Buffer.from(["untrusted comment: fixture", packet, `trusted comment: ${comment}`, global, ""].join(newline)).toString("base64");
    };
    const exact = makeBox(comment, "\r\n");
    const normalized = makeBox(comment.trim(), "\n");
    expect(verifyMinisignBytes(bytes, exact, key).trustedComment).toBe(comment);
    expect(() => verifyLegacyMinisignBytes(bytes, exact, key)).toThrow(/Comment signature verification failed/);
    expect(() => verifyMinisignBytes(bytes, normalized, key)).toThrow(/Comment signature verification failed/);
    expect(verifyLegacyMinisignBytes(bytes, normalized, key).trustedComment).toBe(comment.trim());
    expect(() => verifyMinisignBytes(bytes, `${exact}!`, key)).toThrow(/base64/);
    expect(verifyMinisignBytes(bytes, exact, { ...key, fingerprint: "0".repeat(64) }).fingerprint).toBe(key.fingerprint);
    expect(() => verifyMinisignBytes(bytes, "A".repeat(5468), key)).toThrow(/exceeds limit/);
  });

  test("counts distinct authorized signers and permits unrelated transition signatures", () => {
    const bytes = Buffer.from("signed metadata");
    const makeSigner = (idByte: number) => {
      const { publicKey, privateKey } = generateKeyPairSync("ed25519");
      const raw = Buffer.from(publicKey.export({ format: "der", type: "spki" })).subarray(-32);
      const id = Buffer.alloc(8, idByte);
      const text = `untrusted comment: fixture\n${Buffer.concat([Buffer.from("Ed"), id, raw]).toString("base64")}\n`;
      const fingerprint = createHash("sha256").update(raw).digest("hex");
      const signature = sign(null, createHash("blake2b512").update(bytes).digest(), privateKey);
      const global = sign(null, Buffer.concat([signature, Buffer.from("timestamp:1")]), privateKey);
      const packet = Buffer.concat([Buffer.from("ED"), id, signature]).toString("base64");
      const signatureBox = Buffer.from(`untrusted comment: fixture\n${packet}\ntrusted comment: timestamp:1\n${global.toString("base64")}\n`).toString("base64");
      return { key: { keyId: fingerprint, algorithm: "minisign-ed25519-blake2b512/1", publicKey: Buffer.from(text).toString("base64") }, signature: { keyFingerprint: fingerprint, signatureBox } };
    };
    const a = makeSigner(1), b = makeSigner(2), unrelated = makeSigner(3);
    const envelope = { signatures: [a.signature, b.signature, unrelated.signature] };
    expect(() => verifySignatureThreshold(bytes, envelope, [a.key, b.key], 2)).not.toThrow();
    expect(() => verifySignatureThreshold(bytes, envelope, [a.key], 1)).not.toThrow();
    expect(() => verifySignatureThreshold(bytes, { signatures: [a.signature] }, [a.key, b.key], 2)).toThrow();
    expect(() => verifySignatureThreshold(bytes, { signatures: [a.signature, a.signature] }, [a.key, b.key], 2)).toThrow();
    expect(() => verifySignatureThreshold(bytes, { signatures: [{ ...a.signature, signatureBox: b.signature.signatureBox }] }, [a.key], 1)).toThrow();
    expect(() => verifySignatureThreshold(bytes, envelope, [a.key, a.key], 2)).toThrow();
    expect(() => verifySignatureThreshold(bytes, envelope, [a.key, b.key], 0)).toThrow();
    expect(() => verifySignatureThreshold(Buffer.from("changed"), envelope, [a.key, b.key], 2)).toThrow();
    expect(() => verifySignatureThreshold(bytes, envelope, [{ ...a.key, keyId: "0".repeat(64) }], 1)).toThrow();
  });
});
