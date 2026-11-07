// Run with Node 18 for the required interoperability gate:
//   node tests/helpers/update-node-harness.mjs --require-node18
// This harness performs offline checks only; it never reads an installation.
import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
const pairA = generateKeyPairSync("ed25519"), pairB = generateKeyPairSync("ed25519"), pairC = generateKeyPairSync("ed25519");
const hostileBytes = Buffer.from("key-snapshot"), hostileId = Buffer.alloc(8, 42), hostileComment = "version:1.2.3";
const hostilePayload = sign(null, createHash("blake2b512").update(hostileBytes).digest(), pairA.privateKey);
const hostileGlobal = sign(null, Buffer.concat([hostilePayload, Buffer.from(hostileComment)]), pairB.privateKey);
const hostilePacket = Buffer.concat([Buffer.from("ED"), hostileId, hostilePayload]).toString("base64");
const hostileBox = Buffer.from(`untrusted comment: fixture\n${hostilePacket}\ntrusted comment: ${hostileComment}\n${hostileGlobal.toString("base64")}\n`).toString("base64");
let keyReads = 0;
const hostileKey = { keyId: hostileId.toString("hex"), get publicKey() { return [pairA.publicKey, pairB.publicKey, pairC.publicKey][keyReads++] ?? pairC.publicKey; } };
assert.throws(() => verifyMinisignBytes(hostileBytes, hostileBox, hostileKey));
assert.equal(keyReads, 1);

assert.equal(deriveCandidateId("00".repeat(32), "linux-x64-npm"), "496737c902f9e38cbd89b81b0ba6935e245a026f4d0a931904ddd4617eafc7c4");
assert.ok(sameSignedVersion("18446744073709551615.0.0+build", "v18446744073709551615.0.0+build"));
assert.ok(!sameSignedVersion("18446744073709551616.0.0", "18446744073709551616.0.0"));
assert.ok(!sameSignedVersion("1.2.3+one", "1.2.3+two"));
assert.ok(trustedCommentMatchesVersion("timestamp:1\tversion:v1.2.3+build", "1.2.3+build"));
assert.ok(!trustedCommentMatchesVersion("version:1.2.3\tversion:1.2.3", "1.2.3"));

const encode = (text) => new TextEncoder().encode(text);
assert.equal(parseBoundedJson(encode('{"a":[1,true]}'), 65536).a[0], 1);
assert.throws(() => parseBoundedJson(encode('{"a":1,"\\u0061":2}'), 65536));
const oversizedView = Buffer.from(`{}${" ".repeat(4095)}`);
Object.defineProperty(oversizedView, "byteLength", { value: 0 });
assert.throws(() => parseBoundedJson(oversizedView, 4096));
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
  const buildRoot = (members, revision) => ({ schema: "ocx.update.root/1", revision, expiresAt: "2030-01-01T00:00:00Z", rootKeys: members.map(x => x.key), rootThreshold: 2, releaseKeys: [{ ...members[0].key, channels: ["latest"], roles: ["release", "tree"] }], releaseThreshold: 1, channels: ["latest"] });
  const before = Buffer.from(JSON.stringify(buildRoot(keys.slice(0, 2), 1)));
  const after = Buffer.from(JSON.stringify(buildRoot(keys.slice(2), 2)));
  writeFileSync(join(dir, "update-trust-anchor.mjs"), `export const EMBEDDED_ROOT_SHA256 = "${createHash("sha256").update(before).digest("hex")}";\n`);
  const supply = await import(pathToFileURL(join(dir, "signed-supply.mjs")).href);
  const basis = supply.bootstrapEmbeddedRoot(before, Date.parse("2027-01-01T00:00:00Z"));
  const signEntry = (bytes, { pair, id, key }, comment = "version:1.2.3", signedComment = comment, newline = "\n") => {
    const payload = sign(null, createHash("blake2b512").update(bytes).digest(), pair.privateKey);
    const global = sign(null, Buffer.concat([payload, Buffer.from(signedComment)]), pair.privateKey);
    const packet = Buffer.concat([Buffer.from("ED"), id, payload]).toString("base64");
    const box = Buffer.from(["untrusted comment: fixture", packet, `trusted comment: ${comment}`, global.toString("base64"), ""].join(newline)).toString("base64");
    return { keyFingerprint: key.keyId, signatureBox: box };
  };
  const signed = keys.map(key => signEntry(after, key));
  const envelope = (entries) => Buffer.from(JSON.stringify({ schema: transitionSchema, signatures: entries }));
  const now = Date.parse("2027-01-01T00:00:00Z");
  const successor = supply.verifyRootTransition(basis, after, envelope(signed), now);
  assert.equal(supply.inspectTransition(successor).successorRevision, 2);
  assert.throws(() => supply.verifyRootTransition(basis, after, envelope(signed.slice(1)), now));
  assert.throws(() => supply.verifyRootTransition({}, after, envelope(signed), now));
  const rootExpiry = Date.parse("2030-01-01T00:00:00Z");
  assert.equal(parseUpdateDocument(before, "ocx.update.root/1").expiresAt, "2030-01-01T00:00:00Z");
  assert.ok(Object.isFrozen(supply.verifyRootTransition(basis, after, envelope(signed), rootExpiry - 1)));
  for (const time of [rootExpiry, rootExpiry + 1, -1, NaN, Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => supply.verifyRootTransition(basis, after, envelope(signed), time));
  }
  const unionKeys = Array.from({ length: 33 }, (_, i) => makeKey(i + 10));
  for (const count of [9, 16]) {
    const fixtureDir = join(dir, `threshold-${count}`);
    mkdirSync(fixtureDir);
    for (const name of ["signed-supply.mjs", "update-bytes.mjs", "update-contracts.mjs", "update-bounded-json.mjs", "update-candidate-id.mjs", "update-signed-version.mjs", "update-signature-threshold.mjs", "minisign.mjs"]) copyFileSync(join(dir, name), join(fixtureDir, name));
    const oldRoot = Buffer.from(JSON.stringify({ ...buildRoot(unionKeys.slice(0, count), 1), rootThreshold: count }));
    const newRoot = Buffer.from(JSON.stringify({ ...buildRoot(unionKeys.slice(16, 16 + count), 2), rootThreshold: count }));
    writeFileSync(join(fixtureDir, "update-trust-anchor.mjs"), `export const EMBEDDED_ROOT_SHA256 = "${createHash("sha256").update(oldRoot).digest("hex")}";\n`);
    const unionSupply = await import(pathToFileURL(join(fixtureDir, "signed-supply.mjs")).href);
    const oldBasis = unionSupply.bootstrapEmbeddedRoot(oldRoot, now);
    const entries = [...unionKeys.slice(0, count), ...unionKeys.slice(16, 16 + count)].map(key => signEntry(newRoot, key));
    assert.equal(unionSupply.inspectTransition(unionSupply.verifyRootTransition(oldBasis, newRoot, envelope(entries), now)).successorRevision, 2);
    assert.throws(() => unionSupply.verifyRootTransition(oldBasis, newRoot, envelope(entries.slice(1)), now));
    assert.throws(() => unionSupply.verifyRootTransition(oldBasis, newRoot, envelope([...entries, entries[0]]), now));
    assert.throws(() => unionSupply.verifyRootTransition(oldBasis, newRoot, envelope([...entries, signEntry(newRoot, unionKeys[32])]), now));
    const changed = [...entries]; changed[0] = signEntry(Buffer.from("different"), unionKeys[0]);
    assert.throws(() => unionSupply.verifyRootTransition(oldBasis, newRoot, envelope(changed), now));
    if (count === 16) {
      const overlapping = [unionKeys[0], ...unionKeys.slice(16, 31)];
      const overlapObject = { ...buildRoot(overlapping, 2), rootThreshold: 16 };
      const overlapBytes = Buffer.from(JSON.stringify(overlapObject));
      const overlapSigners = [...unionKeys.slice(0, 16), ...unionKeys.slice(16, 31)];
      const overlapEntries = overlapSigners.map(key => signEntry(overlapBytes, key));
      assert.equal(unionSupply.inspectTransition(unionSupply.verifyRootTransition(oldBasis, overlapBytes, envelope(overlapEntries), now)).successorRevision, 2);
      const raw = Buffer.from(unionKeys[0].pair.publicKey.export({ format: "der", type: "spki" })).subarray(-32);
      overlapObject.rootKeys[0].publicKey = Buffer.from(`untrusted comment: fixture\n${Buffer.concat([Buffer.from("Ed"), Buffer.alloc(8, 201), raw]).toString("base64")}\n`).toString("base64");
      const incompatibleBytes = Buffer.from(JSON.stringify(overlapObject));
      assert.throws(() => unionSupply.verifyRootTransition(oldBasis, incompatibleBytes, envelope(overlapSigners.map(key => signEntry(incompatibleBytes, key))), now), /packet identifiers/);
    }
  }
  const digest = (bytes) => ({ sha256: createHash("sha256").update(bytes).digest("hex"), size: bytes.length });
  const metadataEnvelope = (bytes) => Buffer.from(JSON.stringify({ schema: "ocx.update.signatures/1", signatures: [signEntry(bytes, keys[2])] }));
  const artifact = Buffer.from("fixture artifact");
  const target = "linux-x64-npm";
  const prefix = `ocx-update-1.2.3-latest-${target}`;
  const tree = Buffer.from(JSON.stringify({ schema: "ocx.update.tree/1", version: "1.2.3", target, entries: [{ path: "file", type: "file", mode: 420, size: 0, sha256: "a".repeat(64) }] }));
  const treeEnvelope = metadataEnvelope(tree);
  const capability = Buffer.from(JSON.stringify({ schema: "ocx.link-capabilities/1", version: "1.2.3", channel: "latest", target, artifactSha256: digest(artifact).sha256, homeProvides: [], childRequires: [], updateActions: [], installerAdapters: [], recoveryProtocols: [], fleetJournalReaders: [], compatibilityEpoch: 1, compatibilityVectorSha256: "b".repeat(64) }));
  const assets = [[`${prefix}.tar.gz`, artifact], [`${prefix}.tree.json`, tree], [`${prefix}.tree.json.signatures.json`, treeEnvelope], [`${prefix}.capabilities.json`, capability]].map(([name, bytes]) => ({ name, ...digest(bytes) })).sort((a, b) => a.name < b.name ? -1 : 1);
  const receipt = Buffer.from(JSON.stringify({ schema: "ocx.update.verification/1", sourceCommit: "c".repeat(40), version: "1.2.3", channel: "latest", workflowRunId: 1, workflowAttempt: 1, versionSources: ["package.json", "desktop/src-tauri/tauri.conf.json", "desktop/src-tauri/Cargo.toml", "desktop/src-tauri/Cargo.lock"].map(path => ({ path, sha256: "d".repeat(64) })), assets, universalProofs: [], architectureProofs: [] }));
  const release = Buffer.from(JSON.stringify({ schema: "ocx.update.release/1", version: "1.2.3", channel: "latest", sequence: 1, sourceCommit: "c".repeat(40), rolloutNotBefore: "2026-01-01T00:00:00Z", receipt: digest(receipt), releaseNotes: [], targets: [{ id: target, platform: "linux", arch: "x64", owner: "npm", artifactKind: "tree", bundleKind: "tar-gz", assetName: `${prefix}.tar.gz`, artifact: { ...digest(artifact), signatureBox: signEntry(artifact, keys[2]).signatureBox, signerFingerprint: keys[2].key.keyId }, tree: digest(tree), capabilities: digest(capability) }] }));
  const releaseEvidence = supply.verifyReleaseEvidence(release, metadataEnvelope(release), successor, "latest", now);
  const candidate = supply.selectTargetEvidence(releaseEvidence, { platform: "linux", arch: "x64", owner: "npm", artifactKind: "tree", bundleKind: "tar-gz" });
  assert.ok(Object.isFrozen(supply.verifyArtifactEvidence(candidate, artifact, successor, now)));
  const receiptEvidence = supply.verifyExternalMetadataEvidence(candidate, { kind: "receipt", bytes: receipt }, successor, now);
  assert.ok(Object.isFrozen(supply.verifyExternalMetadataEvidence(candidate, { kind: "tree", bytes: tree, signatureEnvelopeBytes: treeEnvelope, receiptEvidence }, successor, now)));
  assert.ok(Object.isFrozen(supply.verifyExternalMetadataEvidence(candidate, { kind: "capability", bytes: capability, receiptEvidence }, successor, now)));
  assert.throws(() => supply.verifyArtifactEvidence(candidate, Buffer.from("wrong"), successor, now));
  assert.throws(() => supply.verifyExternalMetadataEvidence(candidate, { kind: "tree", bytes: tree, signatureEnvelopeBytes: metadataEnvelope(Buffer.from("wrong")), receiptEvidence }, successor, now));
  assert.throws(() => supply.verifyReleaseEvidence(release, metadataEnvelope(release), successor, "preview", now));
  const commentCases = [
    { version: "1.2.3", comment: "version:v1.2.3", allowed: true, newline: "\n" },
    { version: "1.2.3+one", comment: "version:1.2.3+one", allowed: true, newline: "\r\n" },
    { version: "1.2.3+one", comment: "version:1.2.3+two", allowed: false, newline: "\n" },
    { version: "1.2.3", comment: "timestamp:1", allowed: false, newline: "\n" },
    { version: "1.2.3", comment: "version:1.2.3\tversion:1.2.3", allowed: false, newline: "\n" },
    { version: "1.2.3", comment: "  timestamp:1\tversion:1.2.3\t", allowed: true, newline: "\r\n" },
    { version: "1.2.3", comment: "  timestamp:1\tversion:1.2.3\t", signedComment: "timestamp:1\tversion:1.2.3", allowed: false, newline: "\n" },
  ];
  for (const item of commentCases) {
    const value = JSON.parse(release.toString());
    value.version = item.version;
    value.targets[0].assetName = `ocx-update-${item.version}-latest-${target}.tar.gz`;
    value.targets[0].artifact.signatureBox = signEntry(artifact, keys[2], item.comment, item.signedComment ?? item.comment, item.newline).signatureBox;
    const bytes = Buffer.from(JSON.stringify(value));
    const selected = supply.selectTargetEvidence(supply.verifyReleaseEvidence(bytes, metadataEnvelope(bytes), successor, "latest", now), { platform: "linux", arch: "x64", owner: "npm", artifactKind: "tree", bundleKind: "tar-gz" });
    const verify = () => supply.verifyArtifactEvidence(selected, artifact, successor, now);
    if (item.allowed) assert.ok(Object.isFrozen(verify())); else assert.throws(verify);
  }

  const token = Buffer.alloc(32, 9).toString("base64url");
  const operationId = "12345678-1234-1234-1234-123456789abc";
  const policy = Buffer.from(JSON.stringify({ schema: "ocx.update.policy/1", revision: 0, channel: "latest", check: "manual", download: "manual", install: "manual" }));
  const prepared = Buffer.from(JSON.stringify({ schema: "ocx.update.prepared/1", operationId, candidateDigest: "a".repeat(64), stageIdentity: token, stageDigest: "b".repeat(64), installationId: "install-1", ownerKind: "desktop", policyRevision: 0 }));
  const activation = Buffer.from(JSON.stringify({ schema: "ocx.update.activation/1", action: "reserve", operationId, generation: 1, runtimeInstance: "runtime-1", pid: 1, port: 1, installationId: "install-1", ownerKind: "service", candidateDigest: "a".repeat(64), stageDigest: "b".repeat(64), policyRevision: 0, deadlineMs: 0 }));
  const cappedDocuments = [
    ["ocx.update.root/1", before, 65536], ["ocx.update.signatures/1", metadataEnvelope(release), 65536],
    [transitionSchema, envelope(signed), 262144], ["ocx.update.release/1", release, 1048576],
    ["ocx.update.verification/1", receipt, 1048576], ["ocx.update.tree/1", tree, 16777216],
    ["ocx.link-capabilities/1", capability, 1048576], ["ocx.update.policy/1", policy, 4096],
    ["ocx.update.prepared/1", prepared, 8192], ["ocx.update.activation/1", activation, 8192],
  ];
  for (const [schema, bytes, cap] of cappedDocuments) {
    const exact = Buffer.concat([bytes, Buffer.alloc(cap - bytes.length, 32)]);
    assert.equal(parseUpdateDocument(exact, schema).schema, schema);
    assert.throws(() => parseUpdateDocument(Buffer.concat([exact, Buffer.from(" ")]), schema));
  }
  const unicodeRelease = Buffer.from(JSON.stringify({ ...JSON.parse(release.toString()), releaseNotes: [{ title: "é", body: "é" }] }));
  const unicodeExact = Buffer.concat([unicodeRelease, Buffer.alloc(1048576 - unicodeRelease.length, 32)]);
  assert.equal(parseUpdateDocument(unicodeExact, "ocx.update.release/1").releaseNotes[0].title, "é");
  assert.throws(() => parseUpdateDocument(Buffer.concat([unicodeExact, Buffer.from(" ")]), "ocx.update.release/1"));

  // These are decoded field bounds, independent of the document caps above.
  // Only release notes and inventory paths permit Unicode in these fixtures;
  // all other selected identifier, hash, token and envelope fields are ASCII.
  const checkField = (schema, value) => parseUpdateDocument(Buffer.from(JSON.stringify(value)), schema);
  const rootValue = JSON.parse(before.toString());
  const rootKeyBox = Buffer.from(rootValue.rootKeys[0].publicKey, "base64").toString("utf8").replace(/\n$/, "");
  const padFirstLine = (text, size) => {
    const split = text.indexOf("\n");
    return text.slice(0, split) + "x".repeat(size - Buffer.byteLength(text)) + text.slice(split);
  };
  const rootWithBox = (size) => ({ ...rootValue, rootKeys: [{ ...rootValue.rootKeys[0], publicKey: Buffer.from(padFirstLine(rootKeyBox, size)).toString("base64") }, rootValue.rootKeys[1]] });
  assert.ok(checkField("ocx.update.root/1", rootWithBox(4096)));
  assert.throws(() => checkField("ocx.update.root/1", rootWithBox(4097)));
  assert.throws(() => checkField("ocx.update.root/1", { ...rootValue, rootKeys: [{ ...rootValue.rootKeys[0], keyId: "é" }, rootValue.rootKeys[1]] }));
  for (const schema of ["ocx.update.signatures/1", transitionSchema]) {
    const withBox = (size) => ({ schema, signatures: [{ keyFingerprint: "a".repeat(64), signatureBox: Buffer.from(padFirstLine(fixture.signatureBox, size)).toString("base64") }] });
    assert.ok(checkField(schema, withBox(4096)));
    assert.throws(() => checkField(schema, withBox(4097)));
    assert.throws(() => checkField(schema, { schema, signatures: [{ keyFingerprint: "é", signatureBox: signature }] }));
  }
  const releaseValue = JSON.parse(release.toString());
  const withTitle = (title) => ({ ...releaseValue, releaseNotes: [{ title, body: "" }] });
  assert.ok(checkField("ocx.update.release/1", withTitle("é".repeat(8192))));
  assert.throws(() => checkField("ocx.update.release/1", withTitle(`${"é".repeat(8192)}a`)));
  const receiptValue = JSON.parse(receipt.toString());
  const withAssetName = (name) => ({ ...receiptValue, assets: [{ name, ...digest(artifact) }] });
  assert.ok(checkField("ocx.update.verification/1", withAssetName("a".repeat(255))));
  assert.throws(() => checkField("ocx.update.verification/1", withAssetName("a".repeat(256))));
  assert.throws(() => checkField("ocx.update.verification/1", withAssetName("é")));
  const treeValue = JSON.parse(tree.toString());
  const withPath = (path) => ({ ...treeValue, entries: [{ path, type: "directory", mode: 0 }] });
  assert.ok(checkField("ocx.update.tree/1", withPath("é".repeat(512))));
  assert.throws(() => checkField("ocx.update.tree/1", withPath(`${"é".repeat(512)}a`)));
  const capabilityValue = JSON.parse(capability.toString());
  const withCapabilityId = (id) => ({ ...capabilityValue, homeProvides: [{ id, version: 1 }] });
  assert.ok(checkField("ocx.link-capabilities/1", withCapabilityId("a".repeat(128))));
  assert.throws(() => checkField("ocx.link-capabilities/1", withCapabilityId("a".repeat(129))));
  assert.throws(() => checkField("ocx.link-capabilities/1", withCapabilityId("é")));
  // Release-note text permits Unicode, so accepting replacement characters or
  // lone surrogates here cannot be masked by an ASCII-only field validator.
  const validText = Buffer.from(JSON.stringify(withTitle("marker")));
  assert.ok(parseUpdateDocument(validText, "ocx.update.release/1"));
  const markerOffset = validText.indexOf(Buffer.from("marker"));
  assert.ok(markerOffset >= 0);
  const malformedUtf8 = Buffer.concat([validText.subarray(0, markerOffset), Buffer.from([0xff]), validText.subarray(markerOffset + 6)]);
  assert.throws(() => parseUpdateDocument(malformedUtf8, "ocx.update.release/1"));
  const loneSurrogate = Buffer.from(validText.toString().replace('"marker"', '"\\ud800"'));
  assert.throws(() => parseUpdateDocument(loneSurrogate, "ocx.update.release/1"));
  const policyValue = JSON.parse(policy.toString());
  assert.ok(checkField("ocx.update.policy/1", { ...policyValue, revision: Number.MAX_SAFE_INTEGER }));
  assert.throws(() => checkField("ocx.update.policy/1", { ...policyValue, revision: Number.MAX_SAFE_INTEGER + 1 }));
  assert.throws(() => checkField("ocx.update.policy/1", { ...policyValue, channel: "é" }));
  for (const [schema, bytes, field] of [["ocx.update.prepared/1", prepared, "installationId"], ["ocx.update.activation/1", activation, "runtimeInstance"]]) {
    const value = JSON.parse(bytes.toString());
    assert.ok(checkField(schema, { ...value, [field]: "a".repeat(128) }));
    assert.throws(() => checkField(schema, { ...value, [field]: "a".repeat(129) }));
    assert.throws(() => checkField(schema, { ...value, [field]: "é" }));
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}

const root = readFileSync(fileURLToPath(new URL("../../src/update/trust-root.json", import.meta.url)));
const expiry = Date.parse("2028-11-07T00:00:00Z");
assert.ok(Object.isFrozen(bootstrapEmbeddedRoot(root, expiry - 1)));
assert.throws(() => bootstrapEmbeddedRoot(root, expiry));
assert.throws(() => bootstrapEmbeddedRoot(Buffer.from("invalid"), expiry - 1));
console.log(`Offline update primitive harness passed on ${globalThis.Bun ? `Bun ${globalThis.Bun.version}` : `Node ${process.versions.node}`}`);
