// Run with Node 18 for the required interoperability gate:
//   node tests/helpers/update-node-harness.mjs --require-node18
// This harness performs offline checks only; it never reads an installation.
import assert from "node:assert/strict";
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { decodePublicKey, verifyMinisignBytes } from "../../src/update/minisign.mjs";
import { parseBoundedJson } from "../../src/update/update-bounded-json.mjs";
import { deriveCandidateId } from "../../src/update/update-candidate-id.mjs";
import { sameSignedVersion, trustedCommentMatchesVersion } from "../../src/update/update-signed-version.mjs";
import { bootstrapEmbeddedRoot } from "../../src/update/signed-supply.mjs";
import { parseSignatureEnvelope, parseUpdateDocument } from "../../src/update/update-contracts.mjs";

const args = process.argv.slice(2);
assert.ok(args.length === 0 || (args.length === 1 && args[0] === "--require-node18"), "unsupported arguments");
if (args[0] === "--require-node18") assert.equal(Number(process.versions.node.split(".")[0]), 18, "Node 18 is required");

const fixture = JSON.parse(readFileSync(fileURLToPath(new URL("../fixtures/minisign/prehashed-vector.json", import.meta.url)), "utf8"));
const key = decodePublicKey(`untrusted comment: upstream key\n${fixture.publicKeyBase64}\n`);
const signature = Buffer.from(fixture.signatureBox).toString("base64");
assert.equal(verifyMinisignBytes(Buffer.from(fixture.payload), signature, key).keyId, key.keyId);
assert.throws(() => verifyMinisignBytes(Buffer.from("changed"), signature, key));

assert.equal(deriveCandidateId("00".repeat(32), "linux-x64-npm"), "496737c902f9e38cbd89b81b0ba6935e245a026f4d0a931904ddd4617eafc7c4");
assert.ok(sameSignedVersion("18446744073709551615.0.0+build", "v18446744073709551615.0.0+build"));
assert.ok(!sameSignedVersion("18446744073709551616.0.0", "18446744073709551616.0.0"));
assert.ok(!sameSignedVersion("1.2.3+one", "1.2.3+two"));
assert.ok(trustedCommentMatchesVersion("timestamp:1\tversion:v1.2.3+build", "1.2.3+build"));
assert.ok(!trustedCommentMatchesVersion("version:1.2.3\tversion:1.2.3", "1.2.3"));

const encode = (text) => new TextEncoder().encode(text);
assert.equal(parseBoundedJson(encode('{"a":[1,true]}'), 65536).a[0], 1);
assert.throws(() => parseBoundedJson(encode('{"a":1,"\\u0061":2}'), 65536));
const group = `[${Array(4096).fill("{}").join(",")}]`;
assert.throws(() => parseBoundedJson(encode(`[${Array(20).fill(group).join(",")}]`), 16777216));

const transitionSchema = "ocx.update.root-transition-signatures/1";
const signers = Array.from({ length: 33 }, (_, i) => ({ keyFingerprint: i.toString(16).padStart(64, "0"), signatureBox: signature }));
const transition = encode(JSON.stringify({ schema: transitionSchema, signatures: signers.slice(0, 32) }));
assert.equal(parseUpdateDocument(transition, transitionSchema).signatures.length, 32);
assert.throws(() => parseUpdateDocument(encode(JSON.stringify({ schema: transitionSchema, signatures: signers })), transitionSchema));
assert.throws(() => parseSignatureEnvelope(transition));
const capped = Buffer.concat([transition, Buffer.alloc(262144 - transition.length, 32)]);
assert.equal(parseUpdateDocument(capped, transitionSchema).signatures.length, 32);
assert.throws(() => parseUpdateDocument(Buffer.concat([capped, Buffer.from(" ")]), transitionSchema));

// Build an isolated fixture closure with a generated anchor; production trust
// is never overridden, and the exact kernel sources are copied unchanged.
const dir = mkdtempSync(join(tmpdir(), "ocx-node-supply-"));
try {
  for (const name of ["signed-supply.mjs", "update-bytes.mjs", "update-contracts.mjs", "update-bounded-json.mjs", "update-candidate-id.mjs", "update-signed-version.mjs", "update-signature-threshold.mjs", "minisign.mjs"]) {
    copyFileSync(fileURLToPath(new URL(`../../src/update/${name}`, import.meta.url)), join(dir, name));
  }
  const makeKey = (number) => {
    const pair = generateKeyPairSync("ed25519");
    const raw = Buffer.from(pair.publicKey.export({ format: "der", type: "spki" })).subarray(-32);
    const id = Buffer.alloc(8, number);
    const fingerprint = createHash("sha256").update(raw).digest("hex");
    const publicKey = Buffer.from(`untrusted comment: fixture\n${Buffer.concat([Buffer.from("Ed"), id, raw]).toString("base64")}\n`).toString("base64");
    return { pair, id, key: { keyId: fingerprint, algorithm: "minisign-ed25519-blake2b512/1", publicKey } };
  };
  const keys = [1, 2, 3, 4].map(makeKey);
  const buildRoot = (members, revision) => ({ schema: "ocx.update.root/1", revision, expiresAt: "2030-01-01T00:00:00Z", rootKeys: members.map(x => x.key), rootThreshold: 2, releaseKeys: [{ ...members[0].key, channels: ["latest"], roles: ["release"] }], releaseThreshold: 1, channels: ["latest"] });
  const before = Buffer.from(JSON.stringify(buildRoot(keys.slice(0, 2), 1)));
  const after = Buffer.from(JSON.stringify(buildRoot(keys.slice(2), 2)));
  writeFileSync(join(dir, "update-trust-anchor.mjs"), `export const EMBEDDED_ROOT_SHA256 = "${createHash("sha256").update(before).digest("hex")}";\n`);
  const supply = await import(pathToFileURL(join(dir, "signed-supply.mjs")).href);
  const basis = supply.bootstrapEmbeddedRoot(before, Date.parse("2027-01-01T00:00:00Z"));
  const signed = keys.map(({ pair, id, key }) => {
    const payload = sign(null, createHash("blake2b512").update(after).digest(), pair.privateKey);
    const global = sign(null, Buffer.concat([payload, Buffer.from("fixture")]), pair.privateKey);
    const packet = Buffer.concat([Buffer.from("ED"), id, payload]).toString("base64");
    const box = Buffer.from(`untrusted comment: fixture\n${packet}\ntrusted comment: fixture\n${global.toString("base64")}\n`).toString("base64");
    return { keyFingerprint: key.keyId, signatureBox: box };
  });
  const envelope = (entries) => Buffer.from(JSON.stringify({ schema: transitionSchema, signatures: entries }));
  const now = Date.parse("2027-01-01T00:00:00Z");
  assert.equal(supply.inspectTransition(supply.verifyRootTransition(basis, after, envelope(signed), now)).successorRevision, 2);
  assert.throws(() => supply.verifyRootTransition(basis, after, envelope(signed.slice(1)), now));
  assert.throws(() => supply.verifyRootTransition({}, after, envelope(signed), now));
} finally {
  rmSync(dir, { recursive: true, force: true });
}

const root = readFileSync(fileURLToPath(new URL("../../src/update/trust-root.json", import.meta.url)));
const expiry = Date.parse("2028-11-07T00:00:00Z");
assert.ok(Object.isFrozen(bootstrapEmbeddedRoot(root, expiry - 1)));
assert.throws(() => bootstrapEmbeddedRoot(root, expiry));
assert.throws(() => bootstrapEmbeddedRoot(Buffer.from("invalid"), expiry - 1));
console.log(`Offline update primitive harness passed on Node ${process.versions.node}`);
