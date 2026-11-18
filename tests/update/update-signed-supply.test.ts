import { describe, expect, test } from "bun:test";
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { repoPath } from "../helpers/repo-root";
import { bootstrapEmbeddedRoot, selectTargetEvidence, snapshotEvidence, verifyArtifactEvidence, verifyReleaseEvidence, verifyRootTransition } from "../../src/update/signed-supply.mjs";
import { deriveCandidateId } from "../../src/update/update-candidate-id.mjs";

describe("embedded update trust root", () => {
  const root = readFileSync(repoPath("src/update/trust-root.json"));
  const expiry = Date.parse("2028-11-07T00:00:00Z");

  test("accepts only the compiled root before expiry and returns an opaque handle", () => {
    const trusted = bootstrapEmbeddedRoot(root, expiry - 1);
    expect(Object.isFrozen(trusted)).toBe(true);
    expect(Object.keys(trusted)).toEqual([]);
    const diagnostic = snapshotEvidence(trusted);
    expect(diagnostic.kind).toBe("root");
    if (false) {
      // @ts-expect-error A diagnostic snapshot is not an opaque evidence handle.
      snapshotEvidence(diagnostic);
    }
    expect(() => bootstrapEmbeddedRoot(root, expiry)).toThrow();
    expect(() => bootstrapEmbeddedRoot(root, expiry + 1)).toThrow();
  });

  test("rejects changed root bytes, invalid clocks and oversized input", () => {
    const altered = Buffer.from(root);
    altered[altered.length - 2] ^= 1;
    expect(() => bootstrapEmbeddedRoot(altered, expiry - 1)).toThrow();
    expect(() => bootstrapEmbeddedRoot(Buffer.alloc(65537), expiry - 1)).toThrow();
    for (const time of [-1, NaN, Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => bootstrapEmbeddedRoot(root, time)).toThrow();
    }
  });
});

describe("verified release and candidate handles", () => {
  test("root transitions support disjoint threshold sets and reject invalid union members", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ocx-root-union-"));
    try {
      const makeKey = (n: number) => {
        const pair = generateKeyPairSync("ed25519");
        const raw = Buffer.from(pair.publicKey.export({ format: "der", type: "spki" })).subarray(-32);
        const packetId = Buffer.alloc(8, n);
        const fingerprint = createHash("sha256").update(raw).digest("hex");
        const publicKey = Buffer.from(`untrusted comment: fixture\n${Buffer.concat([Buffer.from("Ed"), packetId, raw]).toString("base64")}\n`).toString("base64");
        return { pair, raw, packetId, key: { keyId: fingerprint, algorithm: "minisign-ed25519-blake2b512/1", publicKey } };
      };
      const keys = Array.from({ length: 33 }, (_, i) => makeKey(i + 1));
      const signEntry = (bytes: Buffer, key: typeof keys[number]) => {
        const signature = sign(null, createHash("blake2b512").update(bytes).digest(), key.pair.privateKey);
        const global = sign(null, Buffer.concat([signature, Buffer.from("version:1.2.3")]), key.pair.privateKey);
        const packet = Buffer.concat([Buffer.from("ED"), key.packetId, signature]).toString("base64");
        return { keyFingerprint: key.key.keyId, signatureBox: Buffer.from(`untrusted comment: fixture\n${packet}\ntrusted comment: version:1.2.3\n${global.toString("base64")}\n`).toString("base64") };
      };
      const makeRoot = (members: typeof keys, revision: number) => ({ schema: "ocx.update.root/1", revision, expiresAt: "2030-01-01T00:00:00Z", rootKeys: members.map(x => x.key), rootThreshold: members.length, releaseKeys: [{ ...members[0].key, channels: ["latest"], roles: ["release"] }], releaseThreshold: 1, channels: ["latest"] });
      const wrap = (entries: unknown[], schema = "ocx.update.root-transition-signatures/1") => Buffer.from(JSON.stringify({ schema, signatures: entries }));
      const now = Date.parse("2027-01-01T00:00:00Z");
      for (const count of [9, 16]) {
        const fixtureDir = join(dir, `fixture-${count}`);
        const { mkdirSync } = await import("node:fs");
        mkdirSync(fixtureDir);
        for (const name of ["signed-supply.mjs", "update-bytes.mjs", "update-contracts.mjs", "update-bounded-json.mjs", "update-candidate-id.mjs", "update-signed-version.mjs", "update-signature-threshold.mjs", "minisign.mjs"]) copyFileSync(repoPath("src/update", name), join(fixtureDir, name));
        const oldRoot = Buffer.from(JSON.stringify(makeRoot(keys.slice(0, count), 1)));
        const nextRoot = Buffer.from(JSON.stringify(makeRoot(keys.slice(16, 16 + count), 2)));
        writeFileSync(join(fixtureDir, "update-trust-anchor.mjs"), `export const EMBEDDED_ROOT_SHA256 = "${createHash("sha256").update(oldRoot).digest("hex")}";\n`);
        const fixture = await import(pathToFileURL(join(fixtureDir, "signed-supply.mjs")).href);
        const basis = fixture.bootstrapEmbeddedRoot(oldRoot, now);
        const entries = [...keys.slice(0, count), ...keys.slice(16, 16 + count)].map(key => signEntry(nextRoot, key));
        expect(() => fixture.verifyRootTransition(basis, nextRoot, wrap(entries), now)).not.toThrow();
        expect(() => fixture.verifyRootTransition(basis, nextRoot, wrap(entries.slice(1)), now)).toThrow();
        expect(() => fixture.verifyRootTransition(basis, nextRoot, wrap([...entries, entries[0]]), now)).toThrow();
        expect(() => fixture.verifyRootTransition(basis, nextRoot, wrap([...entries, signEntry(nextRoot, keys[32])]), now)).toThrow();
        expect(() => fixture.verifyRootTransition(basis, nextRoot, wrap(entries, "ocx.update.signatures/1"), now)).toThrow();
        const invalid = [...entries]; invalid[0] = signEntry(Buffer.from("other"), keys[0]);
        expect(() => fixture.verifyRootTransition(basis, nextRoot, wrap(invalid), now)).toThrow();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  test("uses an isolated compiled fixture anchor and rejects forged or cross-module handles", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ocx-update-fixture-"));
    try {
      const modules = ["signed-supply.mjs", "update-bytes.mjs", "update-contracts.mjs", "update-bounded-json.mjs", "update-candidate-id.mjs", "update-signed-version.mjs", "update-signature-threshold.mjs", "minisign.mjs"];
      for (const name of modules) {
        const source = repoPath("src/update", name);
        copyFileSync(source, join(dir, name));
        expect(readFileSync(join(dir, name))).toEqual(readFileSync(source));
      }
      const { publicKey, privateKey } = generateKeyPairSync("ed25519");
      const raw = Buffer.from(publicKey.export({ format: "der", type: "spki" })).subarray(-32);
      const id = Buffer.alloc(8, 7);
      const fingerprint = createHash("sha256").update(raw).digest("hex");
      const publicBox = Buffer.from(`untrusted comment: fixture\n${Buffer.concat([Buffer.from("Ed"), id, raw]).toString("base64")}\n`).toString("base64");
      const key = { keyId: fingerprint, algorithm: "minisign-ed25519-blake2b512/1", publicKey: publicBox };
      const extraSigner = (byte: number) => {
        const pair = generateKeyPairSync("ed25519");
        const publicBytes = Buffer.from(pair.publicKey.export({ format: "der", type: "spki" })).subarray(-32);
        const keyId = createHash("sha256").update(publicBytes).digest("hex");
        const packetId = Buffer.alloc(8, byte);
        const publicKeyBox = Buffer.from(`untrusted comment: fixture\n${Buffer.concat([Buffer.from("Ed"), packetId, publicBytes]).toString("base64")}\n`).toString("base64");
        return { pair, packetId, key: { keyId, algorithm: "minisign-ed25519-blake2b512/1", publicKey: publicKeyBox } };
      };
      const wrongRole = extraSigner(9), wrongChannel = extraSigner(10);
      const root = Buffer.from(JSON.stringify({ schema: "ocx.update.root/1", revision: 1, expiresAt: "2030-01-01T00:00:00Z", rootKeys: [key], rootThreshold: 1, releaseKeys: [{ ...key, channels: ["latest"], roles: ["release", "desktop-artifact"] }, { ...wrongRole.key, channels: ["latest"], roles: ["release"] }, { ...wrongChannel.key, channels: ["preview"], roles: ["release", "desktop-artifact"] }], releaseThreshold: 1, channels: ["latest", "preview"] }));
      const anchor = createHash("sha256").update(root).digest("hex");
      writeFileSync(join(dir, "update-trust-anchor.mjs"), `export const EMBEDDED_ROOT_SHA256 = "${anchor}";\n`);
      const fixture = await import(pathToFileURL(join(dir, "signed-supply.mjs")).href);
      const signBox = (bytes: Buffer, signingKey = privateKey, signingId = id, comment = "timestamp:1\tversion:1.2.3") => {
        const signature = sign(null, createHash("blake2b512").update(bytes).digest(), signingKey);
        const global = sign(null, Buffer.concat([signature, Buffer.from(comment)]), signingKey);
        const packet = Buffer.concat([Buffer.from("ED"), signingId, signature]).toString("base64");
        return Buffer.from(`untrusted comment: fixture\n${packet}\ntrusted comment: ${comment}\n${global.toString("base64")}\n`).toString("base64");
      };
      const artifact = Buffer.from("fixture artifact");
      const digest = createHash("sha256").update(artifact).digest("hex");
      const release = Buffer.from(JSON.stringify({ schema: "ocx.update.release/1", version: "1.2.3", channel: "latest", sequence: 1, sourceCommit: "a".repeat(40), rolloutNotBefore: "2026-01-01T00:00:00Z", receipt: { sha256: "b".repeat(64), size: 1 }, releaseNotes: [], targets: [{ id: "macos-x64-desktop-tauri", platform: "macos", arch: "x64", owner: "desktop", artifactKind: "tauri", bundleKind: "app-tar-gz", assetName: "OpenCodex-1.2.3-macos.app.tar.gz", artifact: { sha256: digest, size: artifact.length, signatureBox: signBox(artifact), signerFingerprint: fingerprint }, tree: null, capabilities: { sha256: "c".repeat(64), size: 1 } }] }));
      const envelope = Buffer.from(JSON.stringify({ schema: "ocx.update.signatures/1", signatures: [{ keyFingerprint: fingerprint, signatureBox: signBox(release) }] }));
      const now = Date.parse("2027-01-01T00:00:00Z");
      const rootHandle = fixture.bootstrapEmbeddedRoot(root, now);
      const verified = fixture.verifyReleaseEvidence(release, envelope, rootHandle, "latest", now);
      class TrappedBytes extends Uint8Array {
        get byteLength(): number { throw new Error("caller getter"); }
        get byteOffset(): number { throw new Error("caller getter"); }
        get buffer(): ArrayBuffer { throw new Error("caller getter"); }
        get length(): number { throw new Error("caller getter"); }
        [Symbol.iterator](): IterableIterator<number> { throw new Error("caller iterator"); }
      }
      expect(() => fixture.verifyReleaseEvidence(new TrappedBytes(release), new TrappedBytes(envelope), rootHandle, "latest", now)).not.toThrow();
      const selection = { platform: "macos", arch: "x64", owner: "desktop", artifactKind: "tauri", bundleKind: "app-tar-gz" };
      const candidate = fixture.selectTargetEvidence(verified, selection);
      expect(candidate.candidateId).toBe(deriveCandidateId(createHash("sha256").update(release).digest("hex"), "macos-x64-desktop-tauri"));
      expect(Object.isFrozen(candidate)).toBe(true);
      const artifactEvidence = fixture.verifyArtifactEvidence(candidate, artifact, rootHandle, now);
      expect(Object.isFrozen(artifactEvidence)).toBe(true);
      expect(Object.keys(artifactEvidence)).toEqual([]);
      expect(() => fixture.verifyArtifactEvidence(candidate, Buffer.from("changed"), rootHandle, now)).toThrow();
      const sameLengthChange = Buffer.from(artifact); sameLengthChange[0] ^= 1;
      expect(() => fixture.verifyArtifactEvidence(candidate, sameLengthChange, rootHandle, now)).toThrow();
      expect(() => fixture.verifyArtifactEvidence({}, artifact, rootHandle, now)).toThrow();
      expect(() => verifyArtifactEvidence(candidate, artifact, rootHandle, now)).toThrow();
      expect(() => fixture.verifyArtifactEvidence(candidate, artifact, rootHandle, Date.parse("2030-01-01T00:00:00Z"))).toThrow();
      expect(() => fixture.verifyReleaseEvidence(release, envelope, {}, "latest", now)).toThrow();
      expect(() => fixture.verifyReleaseEvidence(Buffer.from("changed"), envelope, rootHandle, "latest", now)).toThrow();
      expect(() => fixture.verifyReleaseEvidence(release, envelope, rootHandle, "preview", now)).toThrow();
      expect(() => fixture.verifyReleaseEvidence(release, envelope, rootHandle, "latest", Date.parse("2030-01-01T00:00:00Z"))).toThrow();
      expect(() => fixture.selectTargetEvidence(verified, { ...selection, arch: "arm64" })).toThrow();
      expect(() => fixture.selectTargetEvidence(verified, { ...selection, url: "https://example.invalid" })).toThrow();
      expect("verifyReleaseRecord" in fixture).toBe(false);
      expect("selectVerifiedTarget" in fixture).toBe(false);

      const successorPair = generateKeyPairSync("ed25519");
      const successorRaw = Buffer.from(successorPair.publicKey.export({ format: "der", type: "spki" })).subarray(-32);
      const successorId = Buffer.alloc(8, 8);
      const successorFingerprint = createHash("sha256").update(successorRaw).digest("hex");
      const successorBox = Buffer.from(`untrusted comment: fixture\n${Buffer.concat([Buffer.from("Ed"), successorId, successorRaw]).toString("base64")}\n`).toString("base64");
      const successorKey = { keyId: successorFingerprint, algorithm: "minisign-ed25519-blake2b512/1", publicKey: successorBox };
      const successor = Buffer.from(JSON.stringify({ schema: "ocx.update.root/1", revision: 2, expiresAt: "2031-01-01T00:00:00Z", rootKeys: [successorKey], rootThreshold: 1, releaseKeys: [{ ...successorKey, channels: ["latest"], roles: ["release", "desktop-artifact"] }], releaseThreshold: 1, channels: ["latest"] }));
      const oldSignature = { keyFingerprint: fingerprint, signatureBox: signBox(successor) };
      const newSignature = { keyFingerprint: successorFingerprint, signatureBox: signBox(successor, successorPair.privateKey, successorId) };
      const transitionEnvelope = (signatures: unknown[]) => Buffer.from(JSON.stringify({ schema: "ocx.update.root-transition-signatures/1", signatures }));
      const releaseEnvelope = (signatures: unknown[]) => Buffer.from(JSON.stringify({ schema: "ocx.update.signatures/1", signatures }));
      const transition = fixture.verifyRootTransition(rootHandle, successor, transitionEnvelope([oldSignature, newSignature]), now);
      const sharedRootObject = JSON.parse(successor.toString());
      sharedRootObject.rootKeys = [key];
      const sharedRoot = Buffer.from(JSON.stringify(sharedRootObject));
      expect(() => fixture.verifyRootTransition(rootHandle, sharedRoot, transitionEnvelope([{ keyFingerprint: fingerprint, signatureBox: signBox(sharedRoot) }]), now)).not.toThrow();
      const incompatible = JSON.parse(sharedRoot.toString());
      incompatible.rootKeys[0].publicKey = Buffer.from(`untrusted comment: fixture\n${Buffer.concat([Buffer.from("Ed"), Buffer.alloc(8, 99), raw]).toString("base64")}\n`).toString("base64");
      const incompatibleBytes = Buffer.from(JSON.stringify(incompatible));
      expect(() => fixture.verifyRootTransition(rootHandle, incompatibleBytes, transitionEnvelope([{ keyFingerprint: fingerprint, signatureBox: signBox(incompatibleBytes) }]), now)).toThrow(/packet identifiers/);
      expect(() => fixture.verifyArtifactEvidence(candidate, artifact, transition, now)).toThrow();
      expect(fixture.inspectTransition(transition)).toEqual({ predecessorDigest: anchor, predecessorRevision: 1, successorDigest: createHash("sha256").update(successor).digest("hex"), successorRevision: 2 });
      expect(() => fixture.verifyRootTransition(rootHandle, successor, transitionEnvelope([oldSignature]), now)).toThrow();
      expect(() => fixture.verifyRootTransition(rootHandle, successor, transitionEnvelope([newSignature]), now)).toThrow();
      expect(() => fixture.verifyRootTransition({}, successor, transitionEnvelope([oldSignature, newSignature]), now)).toThrow();
      expect(() => fixture.verifyRootTransition(rootHandle, root, transitionEnvelope([{ keyFingerprint: fingerprint, signatureBox: signBox(root) }]), now)).toThrow();
      expect(() => fixture.verifyRootTransition(rootHandle, successor, transitionEnvelope([oldSignature, newSignature]), Date.parse("2030-01-01T00:00:00Z"))).toThrow();
      expect(() => verifyRootTransition(rootHandle, successor, transitionEnvelope([oldSignature, newSignature]), now)).toThrow();
      expect(() => fixture.inspectTransition({})).toThrow();
      const nextRelease = JSON.parse(release.toString());
      nextRelease.targets[0].artifact.signerFingerprint = successorFingerprint;
      nextRelease.targets[0].artifact.signatureBox = signBox(artifact, successorPair.privateKey, successorId);
      const nextBytes = Buffer.from(JSON.stringify(nextRelease));
      const nextEnvelope = releaseEnvelope([{ keyFingerprint: successorFingerprint, signatureBox: signBox(nextBytes, successorPair.privateKey, successorId) }]);
      const nextEvidence = fixture.verifyReleaseEvidence(nextBytes, nextEnvelope, transition, "latest", now);
      const nextCandidate = fixture.selectTargetEvidence(nextEvidence, selection);
      expect(nextCandidate.candidateId).toMatch(/^[a-f0-9]{64}$/);
      expect(() => fixture.verifyArtifactEvidence(nextCandidate, artifact, transition, now)).not.toThrow();
      expect(() => fixture.verifyReleaseEvidence(nextBytes, nextEnvelope, rootHandle, "latest", now)).toThrow();
      for (const comment of ["timestamp:1", "version:1.2.4", "version:1.2.3\tversion:1.2.3"]) {
        const altered = JSON.parse(release.toString());
        altered.targets[0].artifact.signatureBox = signBox(artifact, privateKey, id, comment);
        const alteredBytes = Buffer.from(JSON.stringify(altered));
        const alteredEnvelope = releaseEnvelope([{ keyFingerprint: fingerprint, signatureBox: signBox(alteredBytes) }]);
        const alteredRelease = fixture.verifyReleaseEvidence(alteredBytes, alteredEnvelope, rootHandle, "latest", now);
        const alteredTarget = fixture.selectTargetEvidence(alteredRelease, selection);
        expect(() => fixture.verifyArtifactEvidence(alteredTarget, artifact, rootHandle, now)).toThrow();
      }
      const wrongSigner = JSON.parse(release.toString());
      wrongSigner.targets[0].artifact.signerFingerprint = successorFingerprint;
      const wrongSignerBytes = Buffer.from(JSON.stringify(wrongSigner));
      const wrongSignerEnvelope = releaseEnvelope([{ keyFingerprint: fingerprint, signatureBox: signBox(wrongSignerBytes) }]);
      const wrongSignerRelease = fixture.verifyReleaseEvidence(wrongSignerBytes, wrongSignerEnvelope, rootHandle, "latest", now);
      expect(() => fixture.verifyArtifactEvidence(fixture.selectTargetEvidence(wrongSignerRelease, selection), artifact, rootHandle, now)).toThrow();
      for (const other of [wrongRole, wrongChannel]) {
        const altered = JSON.parse(release.toString());
        altered.targets[0].artifact.signerFingerprint = other.key.keyId;
        altered.targets[0].artifact.signatureBox = signBox(artifact, other.pair.privateKey, other.packetId);
        const alteredBytes = Buffer.from(JSON.stringify(altered));
        const alteredEnvelope = releaseEnvelope([{ keyFingerprint: fingerprint, signatureBox: signBox(alteredBytes) }]);
        const alteredRelease = fixture.verifyReleaseEvidence(alteredBytes, alteredEnvelope, rootHandle, "latest", now);
        expect(() => fixture.verifyArtifactEvidence(fixture.selectTargetEvidence(alteredRelease, selection), artifact, rootHandle, now)).toThrow();
      }
      for (const alteredArtifact of [{ sha256: "f".repeat(64) }, { size: artifact.length + 1 }]) {
        const altered = JSON.parse(release.toString());
        Object.assign(altered.targets[0].artifact, alteredArtifact);
        const alteredBytes = Buffer.from(JSON.stringify(altered));
        const alteredEnvelope = releaseEnvelope([{ keyFingerprint: fingerprint, signatureBox: signBox(alteredBytes) }]);
        const alteredRelease = fixture.verifyReleaseEvidence(alteredBytes, alteredEnvelope, rootHandle, "latest", now);
        expect(() => fixture.verifyArtifactEvidence(fixture.selectTargetEvidence(alteredRelease, selection), artifact, rootHandle, now)).toThrow();
      }

      const multiRoot = JSON.parse(successor.toString());
      multiRoot.releaseKeys = [key, successorKey].map((entry) => ({ ...entry, channels: ["latest"], roles: ["release", "desktop-artifact"] }));
      multiRoot.releaseThreshold = 2;
      const multiRootBytes = Buffer.from(JSON.stringify(multiRoot));
      const multiTransition = fixture.verifyRootTransition(rootHandle, multiRootBytes, transitionEnvelope([
        { keyFingerprint: fingerprint, signatureBox: signBox(multiRootBytes) },
        { keyFingerprint: successorFingerprint, signatureBox: signBox(multiRootBytes, successorPair.privateKey, successorId) },
      ]), now);
      const multiReleaseEnvelope = releaseEnvelope([
        { keyFingerprint: fingerprint, signatureBox: signBox(nextBytes) },
        { keyFingerprint: successorFingerprint, signatureBox: signBox(nextBytes, successorPair.privateKey, successorId) },
      ]);
      const multiRelease = fixture.verifyReleaseEvidence(nextBytes, multiReleaseEnvelope, multiTransition, "latest", now);
      expect(() => fixture.verifyArtifactEvidence(fixture.selectTargetEvidence(multiRelease, selection), artifact, multiTransition, now)).toThrow();
      expect(() => bootstrapEmbeddedRoot(root, now)).toThrow();
      expect(() => verifyReleaseEvidence(release, envelope, rootHandle, "latest", now)).toThrow();
      expect(() => selectTargetEvidence(verified, selection)).toThrow();
      root.fill(0);
      expect(() => fixture.verifyReleaseEvidence(release, envelope, rootHandle, "latest", now)).not.toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
