import { describe, expect, test } from "bun:test";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { readFileSync } from "node:fs";
import { repoPath } from "../helpers/repo-root";
import { decodePublicKey, verifyMinisignBytes, verifyLegacyMinisignBytes } from "../../src/update/minisign.mjs";

describe("offline minisign verification", () => {
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
});
