// Run with Node 18 for the required interoperability gate:
//   node tests/helpers/update-node-harness.mjs --require-node18
// This harness performs offline checks only; it never reads an installation.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { decodePublicKey, verifyMinisignBytes } from "../../src/update/minisign.mjs";
import { parseBoundedJson } from "../../src/update/update-bounded-json.mjs";
import { deriveCandidateId } from "../../src/update/update-candidate-id.mjs";
import { sameSignedVersion, trustedCommentMatchesVersion } from "../../src/update/update-signed-version.mjs";
import { bootstrapEmbeddedRoot } from "../../src/update/signed-supply.mjs";

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

const root = readFileSync(fileURLToPath(new URL("../../src/update/trust-root.json", import.meta.url)));
const expiry = Date.parse("2028-11-07T00:00:00Z");
assert.ok(Object.isFrozen(bootstrapEmbeddedRoot(root, expiry - 1)));
assert.throws(() => bootstrapEmbeddedRoot(root, expiry));
assert.throws(() => bootstrapEmbeddedRoot(Buffer.from("invalid"), expiry - 1));
console.log(`Offline update primitive harness passed on Node ${process.versions.node}`);
