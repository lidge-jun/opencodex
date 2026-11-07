import { describe, expect, test } from "bun:test";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { repoPath } from "../helpers/repo-root";
import { verifyExternalMetadataEvidence } from "../../src/update/signed-supply.mjs";

describe("external signed update metadata", () => {
  test("binds receipt, tree signatures and capability bytes to one target and basis", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ocx-update-metadata-"));
    try {
      for (const name of ["signed-supply.mjs", "update-bytes.mjs", "update-contracts.mjs", "update-bounded-json.mjs", "update-candidate-id.mjs", "update-signed-version.mjs", "update-signature-threshold.mjs", "minisign.mjs"]) copyFileSync(repoPath("src/update", name), join(dir, name));
      const pair = generateKeyPairSync("ed25519");
      const raw = Buffer.from(pair.publicKey.export({ format: "der", type: "spki" })).subarray(-32);
      const id = Buffer.alloc(8, 7);
      const fingerprint = createHash("sha256").update(raw).digest("hex");
      const publicKey = Buffer.from(`untrusted comment: fixture\n${Buffer.concat([Buffer.from("Ed"), id, raw]).toString("base64")}\n`).toString("base64");
      const key = { keyId: fingerprint, algorithm: "minisign-ed25519-blake2b512/1", publicKey };
      const otherPair = generateKeyPairSync("ed25519");
      const otherRaw = Buffer.from(otherPair.publicKey.export({ format: "der", type: "spki" })).subarray(-32);
      const otherId = Buffer.alloc(8, 8);
      const otherFingerprint = createHash("sha256").update(otherRaw).digest("hex");
      const otherPublicKey = Buffer.from(`untrusted comment: fixture\n${Buffer.concat([Buffer.from("Ed"), otherId, otherRaw]).toString("base64")}\n`).toString("base64");
      const otherKey = { keyId: otherFingerprint, algorithm: "minisign-ed25519-blake2b512/1", publicKey: otherPublicKey };
      const root = Buffer.from(JSON.stringify({ schema: "ocx.update.root/1", revision: 1, expiresAt: "2030-01-01T00:00:00Z", rootKeys: [key], rootThreshold: 1, releaseKeys: [{ ...key, channels: ["latest", "preview", "nightly"], roles: ["release", "tree", "guardian-artifact", "standalone-artifact", "desktop-artifact"] }, { ...otherKey, channels: ["latest"], roles: ["release"] }], releaseThreshold: 1, channels: ["latest", "preview", "nightly"] }));
      writeFileSync(join(dir, "update-trust-anchor.mjs"), `export const EMBEDDED_ROOT_SHA256 = "${createHash("sha256").update(root).digest("hex")}";\n`);
      const fixture = await import(pathToFileURL(join(dir, "signed-supply.mjs")).href);
      const signBox = (bytes: Buffer, privateKey = pair.privateKey, packetId = id, version = "1.2.3") => {
        const signature = sign(null, createHash("blake2b512").update(bytes).digest(), privateKey);
        const global = sign(null, Buffer.concat([signature, Buffer.from(`version:${version}`)]), privateKey);
        const packet = Buffer.concat([Buffer.from("ED"), packetId, signature]).toString("base64");
        return Buffer.from(`untrusted comment: fixture\n${packet}\ntrusted comment: version:${version}\n${global.toString("base64")}\n`).toString("base64");
      };
      const envelope = (bytes: Buffer, pretty = false) => Buffer.from(JSON.stringify({ schema: "ocx.update.signatures/1", signatures: [{ keyFingerprint: fingerprint, signatureBox: signBox(bytes) }] }, null, pretty ? 2 : undefined));
      const digest = (bytes: Buffer) => ({ sha256: createHash("sha256").update(bytes).digest("hex"), size: bytes.length });
      const artifact = Buffer.from("fixture archive");
      const target = "linux-x64-npm";
      const assetName = `ocx-update-1.2.3-latest-${target}.tar.gz`;
      const treeName = `ocx-update-1.2.3-latest-${target}.tree.json`;
      const capName = `ocx-update-1.2.3-latest-${target}.capabilities.json`;
      const tree = Buffer.from(JSON.stringify({ schema: "ocx.update.tree/1", version: "1.2.3", target, entries: [{ path: "file", type: "file", mode: 420, size: 0, sha256: "a".repeat(64) }] }));
      const treeEnvelope = envelope(tree);
      const capability = Buffer.from(JSON.stringify({ schema: "ocx.link-capabilities/1", version: "1.2.3", channel: "latest", target, artifactSha256: digest(artifact).sha256, homeProvides: [], childRequires: [], updateActions: [], installerAdapters: [], recoveryProtocols: [], fleetJournalReaders: [], compatibilityEpoch: 1, compatibilityVectorSha256: "b".repeat(64) }));
      const assets = [[assetName, artifact], [treeName, tree], [`${treeName}.signatures.json`, treeEnvelope], [capName, capability]].map(([name, bytes]) => ({ name, ...digest(bytes as Buffer) })).sort((a, b) => String(a.name) < String(b.name) ? -1 : 1);
      const receipt = Buffer.from(JSON.stringify({ schema: "ocx.update.verification/1", sourceCommit: "c".repeat(40), version: "1.2.3", channel: "latest", workflowRunId: 1, workflowAttempt: 1, versionSources: ["package.json", "desktop/src-tauri/tauri.conf.json", "desktop/src-tauri/Cargo.toml", "desktop/src-tauri/Cargo.lock"].map(path => ({ path, sha256: "d".repeat(64) })), assets, universalProofs: [], architectureProofs: [] }));
      const release = Buffer.from(JSON.stringify({ schema: "ocx.update.release/1", version: "1.2.3", channel: "latest", sequence: 1, sourceCommit: "c".repeat(40), rolloutNotBefore: "2026-01-01T00:00:00Z", receipt: digest(receipt), releaseNotes: [], targets: [{ id: target, platform: "linux", arch: "x64", owner: "npm", artifactKind: "tree", bundleKind: "tar-gz", assetName, artifact: { ...digest(artifact), signatureBox: signBox(artifact), signerFingerprint: fingerprint }, tree: digest(tree), capabilities: digest(capability) }] }));
      const now = Date.parse("2027-01-01T00:00:00Z");
      const basis = fixture.bootstrapEmbeddedRoot(root, now);
      const releaseEvidence = fixture.verifyReleaseEvidence(release, envelope(release), basis, "latest", now);
      const selection = { platform: "linux", arch: "x64", owner: "npm", artifactKind: "tree", bundleKind: "tar-gz" };
      const candidate = fixture.selectTargetEvidence(releaseEvidence, selection);
      const receiptEvidence = fixture.verifyExternalMetadataEvidence(candidate, { kind: "receipt", bytes: receipt }, basis, now);
      const treeEvidence = fixture.verifyExternalMetadataEvidence(candidate, { kind: "tree", bytes: tree, signatureEnvelopeBytes: treeEnvelope, receiptEvidence }, basis, now);
      const capabilityEvidence = fixture.verifyExternalMetadataEvidence(candidate, { kind: "capability", bytes: capability, receiptEvidence }, basis, now);
      expect(Object.isFrozen(receiptEvidence)).toBe(true);
      expect(Object.isFrozen(treeEvidence)).toBe(true);
      expect(Object.isFrozen(capabilityEvidence)).toBe(true);
      const artifactEvidence = fixture.verifyArtifactEvidence(candidate, artifact, basis, now);
      expect(fixture.snapshotEvidence(artifactEvidence).kind).toBe("artifact");
      expect(fixture.snapshotEvidence(candidate).candidateId).toBe(candidate.candidateId);
      const receiptSnapshot = fixture.snapshotEvidence(receiptEvidence);
      expect(Buffer.from(receiptSnapshot.receiptBytes)).toEqual(receipt);
      receiptSnapshot.receiptBytes.fill(0);
      expect(Buffer.from(fixture.snapshotEvidence(receiptEvidence).receiptBytes)).toEqual(receipt);
      const alternateReceipt = fixture.verifyExternalMetadataEvidence(candidate, { kind: "receipt", bytes: receipt }, basis, now);
      expect(() => fixture.verifyExternalMetadataEvidence(candidate, { kind: "tree", bytes: tree, signatureEnvelopeBytes: treeEnvelope, receiptEvidence: alternateReceipt }, basis, now)).not.toThrow();
      const equalTarget = fixture.selectTargetEvidence(releaseEvidence, selection);
      expect(equalTarget.candidateId).toBe(candidate.candidateId);
      expect(() => fixture.verifyExternalMetadataEvidence(equalTarget, { kind: "tree", bytes: tree, signatureEnvelopeBytes: treeEnvelope, receiptEvidence }, basis, now)).toThrow(/Receipt evidence mismatch/);
      expect(() => fixture.snapshotEvidence(receiptSnapshot)).toThrow(/Invalid update evidence/);
      const longVersion = `1.2.3+${"a".repeat(58)}`;
      const longTarget = "linux-x64-standalone-guardian";
      const longAsset = `ocx-update-${longVersion}-latest-${longTarget}`;
      const longCapabilityName = `${longAsset}.capabilities.json`;
      expect(longCapabilityName.length).toBeGreaterThan(128);
      const longCapability = Buffer.from(JSON.stringify({ ...JSON.parse(capability.toString()), version: longVersion, target: longTarget }));
      const longReceipt = Buffer.from(JSON.stringify({ ...JSON.parse(receipt.toString()), version: longVersion, assets: [{name: longAsset, ...digest(artifact)}, {name: longCapabilityName, ...digest(longCapability)}] }));
      const longRelease = Buffer.from(JSON.stringify({ ...JSON.parse(release.toString()), version: longVersion, receipt: digest(longReceipt), targets: [{id: longTarget, platform: "linux", arch: "x64", owner: "standalone", artifactKind: "guardian", bundleKind: "binary", assetName: longAsset, artifact: {...digest(artifact), signatureBox: signBox(artifact, pair.privateKey, id, longVersion), signerFingerprint: fingerprint}, tree: null, capabilities: digest(longCapability)}] }));
      const longReleaseEvidence = fixture.verifyReleaseEvidence(longRelease, envelope(longRelease), basis, "latest", now);
      const longCandidate = fixture.selectTargetEvidence(longReleaseEvidence, {platform: "linux", arch: "x64", owner: "standalone", artifactKind: "guardian", bundleKind: "binary"});
      expect(() => fixture.verifyArtifactEvidence(longCandidate, artifact, basis, now)).not.toThrow();
      const longReceiptEvidence = fixture.verifyExternalMetadataEvidence(longCandidate, {kind: "receipt", bytes: longReceipt}, basis, now);
      expect(() => fixture.verifyExternalMetadataEvidence(longCandidate, {kind: "capability", bytes: longCapability, receiptEvidence: longReceiptEvidence}, basis, now)).not.toThrow();
      const longTreeTarget = "linux-arm64-standalone";
      const longTreeAsset = `ocx-${longVersion}-bun-linux-arm64.tar.gz`;
      const longTreeName = `ocx-update-${longVersion}-latest-${longTreeTarget}.tree.json`;
      const longTreeCapName = `ocx-update-${longVersion}-latest-${longTreeTarget}.capabilities.json`;
      const longTree = Buffer.from(JSON.stringify({ ...JSON.parse(tree.toString()), version: longVersion, target: longTreeTarget }));
      const longTreeEnvelope = envelope(longTree);
      const longTreeCapability = Buffer.from(JSON.stringify({ ...JSON.parse(capability.toString()), version: longVersion, target: longTreeTarget }));
      const longTreeAssets = [[longTreeAsset, artifact], [longTreeName, longTree], [`${longTreeName}.signatures.json`, longTreeEnvelope], [longTreeCapName, longTreeCapability]].map(([name, bytes]) => ({ name, ...digest(bytes as Buffer) })).sort((a, b) => String(a.name) < String(b.name) ? -1 : 1);
      const longTreeReceipt = Buffer.from(JSON.stringify({ ...JSON.parse(receipt.toString()), version: longVersion, assets: longTreeAssets }));
      const longTreeRelease = Buffer.from(JSON.stringify({ ...JSON.parse(release.toString()), version: longVersion, receipt: digest(longTreeReceipt), targets: [{id: longTreeTarget, platform: "linux", arch: "arm64", owner: "standalone", artifactKind: "standalone", bundleKind: "tar-gz", assetName: longTreeAsset, artifact: {...digest(artifact), signatureBox: signBox(artifact, pair.privateKey, id, longVersion), signerFingerprint: fingerprint}, tree: digest(longTree), capabilities: digest(longTreeCapability)}] }));
      const longTreeCandidate = fixture.selectTargetEvidence(fixture.verifyReleaseEvidence(longTreeRelease, envelope(longTreeRelease), basis, "latest", now), {platform: "linux", arch: "arm64", owner: "standalone", artifactKind: "standalone", bundleKind: "tar-gz"});
      expect(() => fixture.verifyArtifactEvidence(longTreeCandidate, artifact, basis, now)).not.toThrow();
      const longTreeReceiptEvidence = fixture.verifyExternalMetadataEvidence(longTreeCandidate, {kind: "receipt", bytes: longTreeReceipt}, basis, now);
      expect(() => fixture.verifyExternalMetadataEvidence(longTreeCandidate, {kind: "tree", bytes: longTree, signatureEnvelopeBytes: longTreeEnvelope, receiptEvidence: longTreeReceiptEvidence}, basis, now)).not.toThrow();
      expect(() => fixture.verifyExternalMetadataEvidence(longTreeCandidate, {kind: "capability", bytes: longTreeCapability, receiptEvidence: longTreeReceiptEvidence}, basis, now)).not.toThrow();
      expect(() => fixture.verifyExternalMetadataEvidence(candidate, { kind: "tree", bytes: tree, signatureEnvelopeBytes: envelope(tree, true), receiptEvidence }, basis, now)).toThrow();
      expect(() => fixture.verifyExternalMetadataEvidence(candidate, { kind: "tree", bytes: Buffer.from("changed"), signatureEnvelopeBytes: treeEnvelope, receiptEvidence }, basis, now)).toThrow();
      expect(() => fixture.verifyExternalMetadataEvidence(candidate, { kind: "capability", bytes: Buffer.from("changed"), receiptEvidence }, basis, now)).toThrow();
      expect(() => fixture.verifyExternalMetadataEvidence(candidate, { kind: "capability", bytes: capability, receiptEvidence, signatureEnvelopeBytes: treeEnvelope }, basis, now)).toThrow();
      expect(() => fixture.verifyExternalMetadataEvidence(candidate, { kind: "tree", bytes: tree, receiptEvidence }, basis, now)).toThrow();
      expect(() => fixture.verifyExternalMetadataEvidence(candidate, { kind: "receipt", bytes: receipt }, fixture.bootstrapEmbeddedRoot(root, now), now)).toThrow();
      const accessorInput = { kind: "capability", get bytes() { throw new Error("getter invoked"); }, receiptEvidence };
      expect(() => fixture.verifyExternalMetadataEvidence(candidate, accessorInput, basis, now)).toThrow(/Invalid metadata evidence input/);
      expect(() => fixture.verifyExternalMetadataEvidence(fixture.selectTargetEvidence(releaseEvidence, selection), { kind: "tree", bytes: tree, signatureEnvelopeBytes: treeEnvelope, receiptEvidence }, basis, now)).toThrow();
      expect(() => verifyExternalMetadataEvidence(candidate, { kind: "receipt", bytes: receipt }, basis, now)).toThrow();
      const wrongSignatureEnvelope = envelope(Buffer.from("different tree bytes"));
      const wrongSignatureReceipt = JSON.parse(receipt.toString());
      Object.assign(wrongSignatureReceipt.assets.find((entry: {name: string}) => entry.name === `${treeName}.signatures.json`), digest(wrongSignatureEnvelope));
      const wrongSignatureReceiptBytes = Buffer.from(JSON.stringify(wrongSignatureReceipt));
      const wrongSignatureRelease = Buffer.from(JSON.stringify({ ...JSON.parse(release.toString()), receipt: digest(wrongSignatureReceiptBytes) }));
      const wrongSignatureReleaseEvidence = fixture.verifyReleaseEvidence(wrongSignatureRelease, envelope(wrongSignatureRelease), basis, "latest", now);
      const wrongSignatureCandidate = fixture.selectTargetEvidence(wrongSignatureReleaseEvidence, selection);
      const wrongSignatureReceiptEvidence = fixture.verifyExternalMetadataEvidence(wrongSignatureCandidate, { kind: "receipt", bytes: wrongSignatureReceiptBytes }, basis, now);
      expect(() => fixture.verifyExternalMetadataEvidence(wrongSignatureCandidate, { kind: "tree", bytes: tree, signatureEnvelopeBytes: wrongSignatureEnvelope, receiptEvidence: wrongSignatureReceiptEvidence }, basis, now)).toThrow();
      const wrongRoleEnvelope = Buffer.from(JSON.stringify({ schema: "ocx.update.signatures/1", signatures: [{ keyFingerprint: otherFingerprint, signatureBox: signBox(tree, otherPair.privateKey, otherId) }] }));
      const wrongRoleReceipt = JSON.parse(receipt.toString());
      Object.assign(wrongRoleReceipt.assets.find((entry: {name: string}) => entry.name === `${treeName}.signatures.json`), digest(wrongRoleEnvelope));
      const wrongRoleReceiptBytes = Buffer.from(JSON.stringify(wrongRoleReceipt));
      const wrongRoleRelease = Buffer.from(JSON.stringify({ ...JSON.parse(release.toString()), receipt: digest(wrongRoleReceiptBytes) }));
      const wrongRoleReleaseEvidence = fixture.verifyReleaseEvidence(wrongRoleRelease, envelope(wrongRoleRelease), basis, "latest", now);
      const wrongRoleCandidate = fixture.selectTargetEvidence(wrongRoleReleaseEvidence, selection);
      const wrongRoleReceiptEvidence = fixture.verifyExternalMetadataEvidence(wrongRoleCandidate, { kind: "receipt", bytes: wrongRoleReceiptBytes }, basis, now);
      expect(() => fixture.verifyExternalMetadataEvidence(wrongRoleCandidate, { kind: "tree", bytes: tree, signatureEnvelopeBytes: wrongRoleEnvelope, receiptEvidence: wrongRoleReceiptEvidence }, basis, now)).toThrow();
      const wrongTargetCapability = Buffer.from(JSON.stringify({ ...JSON.parse(capability.toString()), target: "linux-arm64-npm" }));
      const wrongTargetReceipt = JSON.parse(receipt.toString());
      Object.assign(wrongTargetReceipt.assets.find((entry: {name: string}) => entry.name === capName), digest(wrongTargetCapability));
      const wrongTargetReceiptBytes = Buffer.from(JSON.stringify(wrongTargetReceipt));
      const wrongTargetReleaseObject = JSON.parse(release.toString());
      wrongTargetReleaseObject.receipt = digest(wrongTargetReceiptBytes);
      wrongTargetReleaseObject.targets[0].capabilities = digest(wrongTargetCapability);
      const wrongTargetRelease = Buffer.from(JSON.stringify(wrongTargetReleaseObject));
      const wrongTargetReleaseEvidence = fixture.verifyReleaseEvidence(wrongTargetRelease, envelope(wrongTargetRelease), basis, "latest", now);
      const wrongTargetCandidate = fixture.selectTargetEvidence(wrongTargetReleaseEvidence, selection);
      const wrongTargetReceiptEvidence = fixture.verifyExternalMetadataEvidence(wrongTargetCandidate, { kind: "receipt", bytes: wrongTargetReceiptBytes }, basis, now);
      expect(() => fixture.verifyExternalMetadataEvidence(wrongTargetCandidate, { kind: "capability", bytes: wrongTargetCapability, receiptEvidence: wrongTargetReceiptEvidence }, basis, now)).toThrow();

      // Re-sign the enclosing release so each refusal reaches the receipt binding.
      for (const [name, change] of [
        [assetName, "missing"], [assetName, "digest"], [capName, "missing"],
        [capName, "size"], [treeName, "missing"], [`${treeName}.signatures.json`, "missing"],
      ]) {
        const altered = JSON.parse(receipt.toString());
        if (change === "missing") altered.assets = altered.assets.filter((entry: {name: string}) => entry.name !== name);
        else {
          const entry = altered.assets.find((item: {name: string}) => item.name === name);
          if (change === "digest") entry.sha256 = "f".repeat(64); else entry.size++;
        }
        const bytes = Buffer.from(JSON.stringify(altered));
        const signedRelease = Buffer.from(JSON.stringify({ ...JSON.parse(release.toString()), receipt: digest(bytes) }));
        const evidence = fixture.verifyReleaseEvidence(signedRelease, envelope(signedRelease), basis, "latest", now);
        const selected = fixture.selectTargetEvidence(evidence, selection);
        expect(() => fixture.verifyExternalMetadataEvidence(selected, { kind: "receipt", bytes }, basis, now)).toThrow(/Receipt asset mismatch/);
      }

      // Descriptors and receipt entries match the bytes, so these cases exercise
      // semantic bindings rather than failing the earlier digest checks.
      for (const [field, value] of [["version", "1.2.4"], ["channel", "preview"], ["artifactSha256", "f".repeat(64)]]) {
        const bytes = Buffer.from(JSON.stringify({ ...JSON.parse(capability.toString()), [field]: value }));
        const altered = JSON.parse(receipt.toString());
        Object.assign(altered.assets.find((entry: {name: string}) => entry.name === capName), digest(bytes));
        const receiptBytes = Buffer.from(JSON.stringify(altered));
        const signed = JSON.parse(release.toString());
        signed.receipt = digest(receiptBytes);
        signed.targets[0].capabilities = digest(bytes);
        const signedBytes = Buffer.from(JSON.stringify(signed));
        const selected = fixture.selectTargetEvidence(fixture.verifyReleaseEvidence(signedBytes, envelope(signedBytes), basis, "latest", now), selection);
        const acceptedReceipt = fixture.verifyExternalMetadataEvidence(selected, { kind: "receipt", bytes: receiptBytes }, basis, now);
        expect(() => fixture.verifyExternalMetadataEvidence(selected, { kind: "capability", bytes, receiptEvidence: acceptedReceipt }, basis, now)).toThrow(/Capability target mismatch/);
      }
      const wrongTree = Buffer.from(JSON.stringify({ ...JSON.parse(tree.toString()), version: "1.2.4" }));
      const wrongTreeEnvelope = envelope(wrongTree);
      const wrongTreeReceipt = JSON.parse(receipt.toString());
      Object.assign(wrongTreeReceipt.assets.find((entry: {name: string}) => entry.name === treeName), digest(wrongTree));
      Object.assign(wrongTreeReceipt.assets.find((entry: {name: string}) => entry.name === `${treeName}.signatures.json`), digest(wrongTreeEnvelope));
      const wrongTreeReceiptBytes = Buffer.from(JSON.stringify(wrongTreeReceipt));
      const wrongTreeRelease = JSON.parse(release.toString());
      wrongTreeRelease.receipt = digest(wrongTreeReceiptBytes);
      wrongTreeRelease.targets[0].tree = digest(wrongTree);
      const wrongTreeReleaseBytes = Buffer.from(JSON.stringify(wrongTreeRelease));
      const wrongTreeCandidate = fixture.selectTargetEvidence(fixture.verifyReleaseEvidence(wrongTreeReleaseBytes, envelope(wrongTreeReleaseBytes), basis, "latest", now), selection);
      const wrongTreeReceiptEvidence = fixture.verifyExternalMetadataEvidence(wrongTreeCandidate, { kind: "receipt", bytes: wrongTreeReceiptBytes }, basis, now);
      expect(() => fixture.verifyExternalMetadataEvidence(wrongTreeCandidate, { kind: "tree", bytes: wrongTree, signatureEnvelopeBytes: wrongTreeEnvelope, receiptEvidence: wrongTreeReceiptEvidence }, basis, now)).toThrow(/Tree target mismatch/);

      // Every supported tuple gets its own signed artifact and exact receipt /
      // metadata chain. These synthetic bytes do not prove payload layout.
      const tuples: { platform: string; arch: string; owner: string; artifactKind: string; bundleKind: string; id: string }[] = [];
      for (const [platform, arch] of [["macos", "x64"], ["macos", "arm64"], ["windows", "x64"], ["linux", "x64"], ["linux", "arm64"]]) {
        const prefix = `${platform}-${arch}`;
        const add = (owner: string, artifactKind: string, bundleKind: string, id: string) => tuples.push({ platform, arch, owner, artifactKind, bundleKind, id });
        if (platform === "macos") add("desktop", "tauri", "app-tar-gz", `${prefix}-desktop-tauri`);
        if (platform === "windows") add("desktop", "tauri", "msi", `${prefix}-desktop-tauri`);
        if (platform === "linux" && arch === "x64") for (const bundle of ["appimage", "deb"]) add("desktop", "tauri", bundle, `${prefix}-desktop-${bundle}`);
        add("standalone", "standalone", platform === "windows" ? "zip" : "tar-gz", `${prefix}-standalone`);
        for (const owner of ["npm", "pnpm", "bun"]) add(owner, "tree", "tar-gz", `${prefix}-${owner}`);
        if (!(platform === "linux" && arch === "arm64")) add("desktop", "guardian", "binary", `${prefix}-desktop-guardian`);
        add("standalone", "guardian", "binary", `${prefix}-standalone-guardian`);
      }
      expect(tuples).toHaveLength(34);
      for (const channel of ["latest", "preview", "nightly"]) for (const tuple of tuples) {
        const version = channel === "latest" ? "1.2.3" : "1.2.3-preview.7";
        const metadataPrefix = `ocx-update-${version}-${channel}-${tuple.id}`;
        const targetAsset = tuple.artifactKind === "tree" || tuple.artifactKind === "guardian"
          ? `${metadataPrefix}${tuple.artifactKind === "tree" ? ".tar.gz" : ""}`
          : tuple.artifactKind === "standalone" ? `ocx-${version}-bun-${tuple.platform === "macos" ? "darwin" : tuple.platform}-${tuple.arch}.${tuple.platform === "windows" ? "zip" : "tar.gz"}`
            : `OpenCodex-${version}-${tuple.platform === "macos" ? "macos.app.tar.gz" : tuple.platform === "windows" ? "windows-x64.msi" : tuple.bundleKind === "deb" ? "linux-amd64.deb" : "linux-x86_64.AppImage"}`;
        const targetCapability = Buffer.from(JSON.stringify({ ...JSON.parse(capability.toString()), version, channel, target: tuple.id }));
        const hasTree = tuple.artifactKind === "tree" || tuple.artifactKind === "standalone";
        const targetTree = Buffer.from(JSON.stringify({ ...JSON.parse(tree.toString()), version, target: tuple.id }));
        const targetTreeEnvelope = envelope(targetTree);
        const targetAssets: [string, Buffer][] = [[targetAsset, artifact], [`${metadataPrefix}.capabilities.json`, targetCapability]];
        if (hasTree) targetAssets.push([`${metadataPrefix}.tree.json`, targetTree], [`${metadataPrefix}.tree.json.signatures.json`, targetTreeEnvelope]);
        const targetProof = { assetName: targetAsset, artifactSha256: digest(artifact).sha256, inspectionSha256: "e".repeat(64) };
        const targetReceipt = Buffer.from(JSON.stringify({ ...JSON.parse(receipt.toString()), version, channel, assets: targetAssets.map(([name, bytes]) => ({ name, ...digest(bytes) })).sort((a, b) => a.name < b.name ? -1 : 1), universalProofs: tuple.platform === "macos" && tuple.artifactKind === "tauri" ? [{ ...targetProof, architectures: ["arm64", "x64"] }] : [], architectureProofs: tuple.platform === "macos" && tuple.artifactKind !== "tauri" ? [{ ...targetProof, targetId: tuple.id, arch: tuple.arch }] : [] }));
        const targetRelease = Buffer.from(JSON.stringify({ ...JSON.parse(release.toString()), version, channel, receipt: digest(targetReceipt), targets: [{ ...tuple, assetName: targetAsset, artifact: { ...digest(artifact), signatureBox: signBox(artifact, pair.privateKey, id, version), signerFingerprint: fingerprint }, tree: hasTree ? digest(targetTree) : null, capabilities: digest(targetCapability) }] }));
        const targetReleaseEvidence = fixture.verifyReleaseEvidence(targetRelease, envelope(targetRelease), basis, channel, now);
        expect(() => fixture.verifyReleaseEvidence(targetRelease, envelope(targetRelease), basis, channel === "preview" ? "nightly" : "preview", now)).toThrow(/Signed release channel mismatch/);
        const targetCandidate = fixture.selectTargetEvidence(targetReleaseEvidence, { platform: tuple.platform, arch: tuple.arch, owner: tuple.owner, artifactKind: tuple.artifactKind, bundleKind: tuple.bundleKind });
        expect(() => fixture.verifyArtifactEvidence(targetCandidate, artifact, basis, now)).not.toThrow();
        const targetReceiptEvidence = fixture.verifyExternalMetadataEvidence(targetCandidate, { kind: "receipt", bytes: targetReceipt }, basis, now);
        expect(() => fixture.verifyExternalMetadataEvidence(targetCandidate, { kind: "capability", bytes: targetCapability, receiptEvidence: targetReceiptEvidence }, basis, now)).not.toThrow();
        if (hasTree) expect(() => fixture.verifyExternalMetadataEvidence(targetCandidate, { kind: "tree", bytes: targetTree, signatureEnvelopeBytes: targetTreeEnvelope, receiptEvidence: targetReceiptEvidence }, basis, now)).not.toThrow();
      }

      // Desktop's shared macOS archive requires universal proof for either target.
      for (const arch of ["x64", "arm64"]) {
        const macTarget = `macos-${arch}-desktop-tauri`;
        const macAsset = "OpenCodex-1.2.3-macos.app.tar.gz";
        const macCapName = `ocx-update-1.2.3-latest-${macTarget}.capabilities.json`;
        const macCapability = Buffer.from(JSON.stringify({ ...JSON.parse(capability.toString()), target: macTarget }));
        const makeMacCandidate = (proofs: unknown[]) => {
          const macReceipt = Buffer.from(JSON.stringify({ ...JSON.parse(receipt.toString()), assets: [{ name: macAsset, ...digest(artifact) }, { name: macCapName, ...digest(macCapability) }].sort((a, b) => a.name < b.name ? -1 : 1), universalProofs: proofs }));
          const macRelease = Buffer.from(JSON.stringify({ ...JSON.parse(release.toString()), receipt: digest(macReceipt), targets: [{ id: macTarget, platform: "macos", arch, owner: "desktop", artifactKind: "tauri", bundleKind: "app-tar-gz", assetName: macAsset, artifact: { ...digest(artifact), signatureBox: signBox(artifact), signerFingerprint: fingerprint }, tree: null, capabilities: digest(macCapability) }] }));
          const macReleaseEvidence = fixture.verifyReleaseEvidence(macRelease, envelope(macRelease), basis, "latest", now);
          return { macReceipt, macCandidate: fixture.selectTargetEvidence(macReleaseEvidence, { platform: "macos", arch, owner: "desktop", artifactKind: "tauri", bundleKind: "app-tar-gz" }) };
        };
        const proof = { assetName: macAsset, artifactSha256: digest(artifact).sha256, architectures: ["arm64", "x64"], inspectionSha256: "e".repeat(64) };
        const valid = makeMacCandidate([proof]);
        expect(() => fixture.verifyExternalMetadataEvidence(valid.macCandidate, { kind: "receipt", bytes: valid.macReceipt }, basis, now)).not.toThrow();
        const missing = makeMacCandidate([]);
        expect(() => fixture.verifyExternalMetadataEvidence(missing.macCandidate, { kind: "receipt", bytes: missing.macReceipt }, basis, now)).toThrow();
        const wrong = makeMacCandidate([{ ...proof, artifactSha256: "f".repeat(64) }]);
        expect(() => fixture.verifyExternalMetadataEvidence(wrong.macCandidate, { kind: "receipt", bytes: wrong.macReceipt }, basis, now)).toThrow();
      }
      const standaloneTarget = "macos-x64-standalone";
      const standaloneAsset = "ocx-1.2.3-bun-darwin-x64.tar.gz";
      const standaloneTreeName = `ocx-update-1.2.3-latest-${standaloneTarget}.tree.json`;
      const standaloneCapName = `ocx-update-1.2.3-latest-${standaloneTarget}.capabilities.json`;
      const standaloneTree = Buffer.from(JSON.stringify({ ...JSON.parse(tree.toString()), target: standaloneTarget }));
      const standaloneEnvelope = envelope(standaloneTree);
      const standaloneCapability = Buffer.from(JSON.stringify({ ...JSON.parse(capability.toString()), target: standaloneTarget }));
      const standaloneAssets = [[standaloneAsset, artifact], [standaloneTreeName, standaloneTree], [`${standaloneTreeName}.signatures.json`, standaloneEnvelope], [standaloneCapName, standaloneCapability]].map(([name, bytes]) => ({ name, ...digest(bytes as Buffer) })).sort((a, b) => String(a.name) < String(b.name) ? -1 : 1);
      const standaloneReceipt = Buffer.from(JSON.stringify({ ...JSON.parse(receipt.toString()), assets: standaloneAssets, universalProofs: [], architectureProofs: [{ targetId: standaloneTarget, assetName: standaloneAsset, artifactSha256: digest(artifact).sha256, arch: "x64", inspectionSha256: "f".repeat(64) }] }));
      const standaloneRelease = Buffer.from(JSON.stringify({ ...JSON.parse(release.toString()), receipt: digest(standaloneReceipt), targets: [{ id: standaloneTarget, platform: "macos", arch: "x64", owner: "standalone", artifactKind: "standalone", bundleKind: "tar-gz", assetName: standaloneAsset, artifact: { ...digest(artifact), signatureBox: signBox(artifact), signerFingerprint: fingerprint }, tree: digest(standaloneTree), capabilities: digest(standaloneCapability) }] }));
      const standaloneReleaseEvidence = fixture.verifyReleaseEvidence(standaloneRelease, envelope(standaloneRelease), basis, "latest", now);
      const standaloneCandidate = fixture.selectTargetEvidence(standaloneReleaseEvidence, { platform: "macos", arch: "x64", owner: "standalone", artifactKind: "standalone", bundleKind: "tar-gz" });
      expect(() => fixture.verifyExternalMetadataEvidence(standaloneCandidate, { kind: "receipt", bytes: standaloneReceipt }, basis, now)).not.toThrow();
      for (const proofs of [[], [{ ...JSON.parse(standaloneReceipt.toString()).architectureProofs[0], arch: "arm64" }]]) {
        const bytes = Buffer.from(JSON.stringify({ ...JSON.parse(standaloneReceipt.toString()), architectureProofs: proofs }));
        const signedBytes = Buffer.from(JSON.stringify({ ...JSON.parse(standaloneRelease.toString()), receipt: digest(bytes) }));
        const selected = fixture.selectTargetEvidence(fixture.verifyReleaseEvidence(signedBytes, envelope(signedBytes), basis, "latest", now), { platform: "macos", arch: "x64", owner: "standalone", artifactKind: "standalone", bundleKind: "tar-gz" });
        expect(() => fixture.verifyExternalMetadataEvidence(selected, { kind: "receipt", bytes }, basis, now)).toThrow(/architecture proof/);
      }

      // A two-key root requires both tree signatures, independently of the
      // enclosing receipt's authenticated envelope digest.
      const thresholdDir = join(dir, "threshold");
      mkdirSync(thresholdDir);
      for (const name of ["signed-supply.mjs", "update-bytes.mjs", "update-contracts.mjs", "update-bounded-json.mjs", "update-candidate-id.mjs", "update-signed-version.mjs", "update-signature-threshold.mjs", "minisign.mjs"]) copyFileSync(repoPath("src/update", name), join(thresholdDir, name));
      const thresholdRoot = Buffer.from(JSON.stringify({ ...JSON.parse(root.toString()), channels: ["latest"], releaseKeys: [{ ...key, channels: ["latest"], roles: ["release", "tree"] }, { ...otherKey, channels: ["latest"], roles: ["release", "tree"] }], releaseThreshold: 2 }));
      writeFileSync(join(thresholdDir, "update-trust-anchor.mjs"), `export const EMBEDDED_ROOT_SHA256 = "${createHash("sha256").update(thresholdRoot).digest("hex")}";\n`);
      const thresholdFixture = await import(pathToFileURL(join(thresholdDir, "signed-supply.mjs")).href);
      const thresholdBasis = thresholdFixture.bootstrapEmbeddedRoot(thresholdRoot, now);
      const thresholdEnvelope = (bytes: Buffer, two: boolean) => Buffer.from(JSON.stringify({ schema: "ocx.update.signatures/1", signatures: [{ keyFingerprint: fingerprint, signatureBox: signBox(bytes) }, ...(two ? [{ keyFingerprint: otherFingerprint, signatureBox: signBox(bytes, otherPair.privateKey, otherId) }] : [])] }));
      for (const two of [false, true]) {
        const signatureBytes = thresholdEnvelope(tree, two);
        const altered = JSON.parse(receipt.toString());
        Object.assign(altered.assets.find((entry: {name: string}) => entry.name === `${treeName}.signatures.json`), digest(signatureBytes));
        const receiptBytes = Buffer.from(JSON.stringify(altered));
        const signedBytes = Buffer.from(JSON.stringify({ ...JSON.parse(release.toString()), receipt: digest(receiptBytes) }));
        const selected = thresholdFixture.selectTargetEvidence(thresholdFixture.verifyReleaseEvidence(signedBytes, thresholdEnvelope(signedBytes, true), thresholdBasis, "latest", now), selection);
        const acceptedReceipt = thresholdFixture.verifyExternalMetadataEvidence(selected, { kind: "receipt", bytes: receiptBytes }, thresholdBasis, now);
        const verify = () => thresholdFixture.verifyExternalMetadataEvidence(selected, { kind: "tree", bytes: tree, signatureEnvelopeBytes: signatureBytes, receiptEvidence: acceptedReceipt }, thresholdBasis, now);
        if (two) expect(verify).not.toThrow(); else expect(verify).toThrow();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
