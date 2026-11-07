import { createHash } from "node:crypto";
import { parseRootTransitionEnvelope, parseSignatureEnvelope, parseUpdateDocument } from "./update-contracts.mjs";
import { EMBEDDED_ROOT_SHA256 } from "./update-trust-anchor.mjs";
import { snapshotUpdateBytes } from "./update-bytes.mjs";
import { verifySignatureThreshold } from "./update-signature-threshold.mjs";
import { deriveCandidateId } from "./update-candidate-id.mjs";
import { decodePublicKey, verifyMinisignBytes } from "./minisign.mjs";
import { trustedCommentMatchesVersion } from "./update-signed-version.mjs";

// Handles are module-owned and contain no caller-mutable trust data.
const ROOTS = new WeakMap();
const TRANSITIONS = new WeakMap();
const RELEASES = new WeakMap();
const CANDIDATES = new WeakMap();
const ARTIFACTS = new WeakMap();
const RECEIPTS = new WeakMap();
const TREES = new WeakMap();
const CAPABILITIES = new WeakMap();

function currentRoot(handle, nowMs) {
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) throw new Error("Invalid trust clock");
  const state = ROOTS.get(handle) || TRANSITIONS.get(handle);
  if (!state || Date.parse(state.root.expiresAt) <= nowMs) throw new Error("Invalid or expired update root");
  return state;
}

/** Authenticate the one root whose digest is compiled into this module closure. */
export function bootstrapEmbeddedRoot(bytes, nowMs) {
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) throw new Error("Invalid embedded root input");
  const snapshot = snapshotUpdateBytes(bytes, 65536);
  const digest = createHash("sha256").update(snapshot).digest("hex");
  if (digest !== EMBEDDED_ROOT_SHA256) throw new Error("Embedded root digest mismatch");
  const root = parseUpdateDocument(snapshot, "ocx.update.root/1");
  if (Date.parse(root.expiresAt) <= nowMs) throw new Error("Embedded root expired");
  const handle = Object.freeze(Object.create(null));
  ROOTS.set(handle, { root, bytes: snapshot, digest });
  return handle;
}

/** Verify a dual-threshold root transition as evidence, without promoting trust. */
export function verifyRootTransition(predecessorBasis, bytes, envelopeBytes, nowMs) {
  const previous = currentRoot(predecessorBasis, nowMs);
  const nextBytes = snapshotUpdateBytes(bytes, 65536);
  const signatureBytes = snapshotUpdateBytes(envelopeBytes, 262144);
  const envelope = parseRootTransitionEnvelope(signatureBytes);
  const root = parseUpdateDocument(nextBytes, "ocx.update.root/1");
  if (root.revision <= previous.root.revision || Date.parse(root.expiresAt) <= nowMs) {
    throw new Error("Invalid successor root");
  }
  const oldKeys = new Map(previous.root.rootKeys.map((key) => [key.keyId, key]));
  const newKeys = new Map(root.rootKeys.map((key) => [key.keyId, key]));
  for (const [fingerprint, oldKey] of oldKeys) {
    const newKey = newKeys.get(fingerprint);
    if (newKey) {
      const decode = (key) => decodePublicKey(Buffer.from(key.publicKey, "base64").toString("utf8"));
      if (decode(oldKey).keyId !== decode(newKey).keyId) throw new Error("Incompatible root key packet identifiers");
    }
  }
  if (envelope.signatures.some((signature) => !oldKeys.has(signature.keyFingerprint) && !newKeys.has(signature.keyFingerprint))) {
    throw new Error("Unknown root transition signer");
  }
  const subset = (keys) => ({ signatures: envelope.signatures.filter((signature) => keys.has(signature.keyFingerprint)) });
  verifySignatureThreshold(nextBytes, subset(oldKeys), previous.root.rootKeys, previous.root.rootThreshold);
  verifySignatureThreshold(nextBytes, subset(newKeys), root.rootKeys, root.rootThreshold);
  const digest = createHash("sha256").update(nextBytes).digest("hex");
  const handle = Object.freeze(Object.create(null));
  TRANSITIONS.set(handle, { root, bytes: nextBytes, digest, predecessorDigest: previous.digest,
    predecessorRevision: previous.root.revision, envelopeBytes: signatureBytes });
  return handle;
}

/** Return diagnostic data only; this does not promote or persist a root. */
export function inspectTransition(transition) {
  const state = TRANSITIONS.get(transition);
  if (!state) throw new Error("Invalid root transition evidence");
  return Object.freeze({ predecessorDigest: state.predecessorDigest, predecessorRevision: state.predecessorRevision,
    successorDigest: state.digest, successorRevision: state.root.revision });
}

/** Verify exact release bytes under a root basis as evidence only. */
export function verifyReleaseEvidence(bytes, envelopeBytes, rootBasis, expectedChannel, nowMs) {
  const state = currentRoot(rootBasis, nowMs);
  if (!state.root.channels.includes(expectedChannel)) throw new Error("Unsupported update channel");
  const releaseBytes = snapshotUpdateBytes(bytes, 1048576);
  const signatureBytes = snapshotUpdateBytes(envelopeBytes, 65536);
  const envelope = parseSignatureEnvelope(signatureBytes);
  const keys = state.root.releaseKeys.filter((key) => key.channels.includes(expectedChannel) && key.roles.includes("release"));
  verifySignatureThreshold(releaseBytes, envelope, keys, state.root.releaseThreshold);
  const release = parseUpdateDocument(releaseBytes, "ocx.update.release/1");
  if (release.channel !== expectedChannel) throw new Error("Signed release channel mismatch");
  const digest = createHash("sha256").update(releaseBytes).digest("hex");
  const handle = Object.freeze(Object.create(null));
  RELEASES.set(handle, { release, root: rootBasis, digest, bytes: releaseBytes, envelopeBytes: signatureBytes });
  return handle;
}

/** Select a signed tuple; the resulting identity is a lookup, not install authority. */
export function selectTargetEvidence(releaseEvidence, selection) {
  const state = RELEASES.get(releaseEvidence);
  const fields = ["platform", "arch", "owner", "artifactKind", "bundleKind"];
  if (!state || !selection || typeof selection !== "object" || Array.isArray(selection)
      || Object.keys(selection).length !== fields.length || !fields.every((field) => Object.hasOwn(selection, field))) {
    throw new Error("Invalid verified update selection");
  }
  const matches = state.release.targets.filter((target) => fields.every((field) => target[field] === selection[field]));
  if (matches.length !== 1) throw new Error("Update target unavailable");
  const candidateId = deriveCandidateId(state.digest, matches[0].id);
  const handle = Object.freeze({ candidateId });
  CANDIDATES.set(handle, { release: releaseEvidence, root: state.root, target: matches[0] });
  return handle;
}

/** Verify artifact bytes as evidence; this grants no staging or install authority. */
export function verifyArtifactEvidence(targetEvidence, bytes, basis, nowMs) {
  const state = currentRoot(basis, nowMs);
  const candidate = CANDIDATES.get(targetEvidence);
  if (!candidate || candidate.root !== basis) throw new Error("Invalid target evidence basis");
  const release = RELEASES.get(candidate.release);
  if (!release || release.root !== basis) throw new Error("Invalid release evidence basis");
  const target = candidate.target;
  const roles = { tauri: "desktop-artifact", standalone: "standalone-artifact", guardian: "guardian-artifact", tree: "tree" };
  const role = roles[target.artifactKind];
  if (!role || state.root.releaseThreshold !== 1) throw new Error("Unsupported artifact signature threshold");
  const key = state.root.releaseKeys.find((entry) => entry.keyId === target.artifact.signerFingerprint
    && entry.channels.includes(release.release.channel) && entry.roles.includes(role));
  if (!key) throw new Error("Artifact signer is not delegated");
  const snapshot = snapshotUpdateBytes(bytes, target.artifact.size);
  if (snapshot.byteLength !== target.artifact.size
      || createHash("sha256").update(snapshot).digest("hex") !== target.artifact.sha256) {
    throw new Error("Artifact bytes do not match signed target");
  }
  const publicBox = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(Buffer.from(key.publicKey, "base64"));
  const result = verifyMinisignBytes(snapshot, target.artifact.signatureBox, decodePublicKey(publicBox));
  if (!trustedCommentMatchesVersion(result.trustedComment, release.release.version)) {
    throw new Error("Signed artifact version mismatch");
  }
  const handle = Object.freeze(Object.create(null));
  ARTIFACTS.set(handle, { target: targetEvidence, basis, digest: target.artifact.sha256, size: snapshot.byteLength });
  return handle;
}

function checkedBytes(bytes, expected, cap) {
  if (expected.size > cap) throw new Error("Metadata size exceeds limit");
  const snapshot = snapshotUpdateBytes(bytes, expected.size);
  if (snapshot.byteLength !== expected.size || createHash("sha256").update(snapshot).digest("hex") !== expected.sha256) {
    throw new Error("Metadata bytes do not match signed record");
  }
  return snapshot;
}

function requireAsset(receipt, name, expected) {
  const matches = receipt.assets.filter((asset) => asset.name === name);
  if (matches.length !== 1 || (expected && (matches[0].sha256 !== expected.sha256 || matches[0].size !== expected.size))) {
    throw new Error("Receipt asset mismatch");
  }
  return matches[0];
}

/** Verify receipt, tree or capability evidence against one signed target and basis. */
export function verifyExternalMetadataEvidence(targetEvidence, input, basis, nowMs) {
  const state = currentRoot(basis, nowMs);
  const candidate = CANDIDATES.get(targetEvidence);
  if (!candidate || candidate.root !== basis) throw new Error("Invalid target evidence basis");
  const releaseState = RELEASES.get(candidate.release);
  if (!releaseState || releaseState.root !== basis || !input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("Invalid metadata evidence input");
  }
  const release = releaseState.release;
  const target = candidate.target;
  const prefix = `ocx-update-${release.version}-${release.channel}-${target.id}`;
  const treeName = `${prefix}.tree.json`;
  const capabilityName = `${prefix}.capabilities.json`;
  const descriptors = Object.getOwnPropertyDescriptors(input);
  const kind = descriptors.kind && Object.hasOwn(descriptors.kind, "value") ? descriptors.kind.value : undefined;
  const fields = kind === "receipt" ? ["kind", "bytes"]
    : kind === "tree" ? ["kind", "bytes", "signatureEnvelopeBytes", "receiptEvidence"]
      : kind === "capability" ? ["kind", "bytes", "receiptEvidence"] : [];
  if (!fields.length || Reflect.ownKeys(descriptors).length !== fields.length
      || !fields.every((field) => Object.hasOwn(descriptors, field) && descriptors[field].enumerable
        && Object.hasOwn(descriptors[field], "value"))) {
    throw new Error("Invalid metadata evidence input");
  }
  const data = Object.fromEntries(fields.map((field) => [field, descriptors[field].value]));
  if (kind === "receipt") {
    const bytes = checkedBytes(data.bytes, release.receipt, 1048576);
    const receipt = parseUpdateDocument(bytes, "ocx.update.verification/1");
    if (receipt.version !== release.version || receipt.channel !== release.channel || receipt.sourceCommit !== release.sourceCommit) {
      throw new Error("Receipt release mismatch");
    }
    requireAsset(receipt, target.assetName, target.artifact);
    requireAsset(receipt, capabilityName, target.capabilities);
    if (target.tree) {
      requireAsset(receipt, treeName, target.tree);
      requireAsset(receipt, `${treeName}.signatures.json`);
    }
    if (target.platform === "macos" && target.owner === "desktop" && target.artifactKind === "tauri" && target.bundleKind === "app-tar-gz") {
      const proofs = receipt.universalProofs.filter((proof) => proof.assetName === target.assetName && proof.artifactSha256 === target.artifact.sha256);
      if (proofs.length !== 1) throw new Error("Missing or ambiguous universal artifact proof");
    } else if (target.platform === "macos") {
      const proofs = receipt.architectureProofs.filter((proof) => proof.targetId === target.id && proof.assetName === target.assetName
        && proof.artifactSha256 === target.artifact.sha256 && proof.arch === target.arch);
      if (proofs.length !== 1) throw new Error("Missing or ambiguous architecture proof");
    }
    const handle = Object.freeze(Object.create(null));
    RECEIPTS.set(handle, { receipt, bytes, target: targetEvidence, basis });
    return handle;
  }
  const receiptState = RECEIPTS.get(data.receiptEvidence);
  if (!receiptState || receiptState.target !== targetEvidence || receiptState.basis !== basis) throw new Error("Receipt evidence mismatch");
  if (kind === "tree") {
    if (!target.tree) throw new Error("Target has no tree metadata");
    const treeBytes = checkedBytes(data.bytes, target.tree, 16777216);
    const signatureEntry = requireAsset(receiptState.receipt, `${treeName}.signatures.json`);
    const signatureBytes = checkedBytes(data.signatureEnvelopeBytes, signatureEntry, 65536);
    const envelope = parseSignatureEnvelope(signatureBytes);
    const keys = state.root.releaseKeys.filter((key) => key.channels.includes(release.channel) && key.roles.includes("tree"));
    verifySignatureThreshold(treeBytes, envelope, keys, state.root.releaseThreshold);
    const tree = parseUpdateDocument(treeBytes, "ocx.update.tree/1");
    if (tree.version !== release.version || tree.target !== target.id) throw new Error("Tree target mismatch");
    const handle = Object.freeze(Object.create(null));
    TREES.set(handle, { tree, bytes: treeBytes, envelopeBytes: signatureBytes, target: targetEvidence, basis, receipt: data.receiptEvidence });
    return handle;
  }
  const bytes = checkedBytes(data.bytes, target.capabilities, 1048576);
  const capability = parseUpdateDocument(bytes, "ocx.link-capabilities/1");
  if (capability.version !== release.version || capability.channel !== release.channel
      || capability.target !== target.id || capability.artifactSha256 !== target.artifact.sha256) {
    throw new Error("Capability target mismatch");
  }
  const handle = Object.freeze(Object.create(null));
  CAPABILITIES.set(handle, { capability, bytes, target: targetEvidence, basis, receipt: data.receiptEvidence });
  return handle;
}

const evidenceRecord = (kind, fields) => Object.freeze(Object.assign(Object.create(null), { kind }, fields));
const copyEvidenceBytes = (bytes, cap) => snapshotUpdateBytes(bytes, cap);
const evidenceDigest = (bytes) => createHash("sha256").update(bytes).digest("hex");

function evidenceBasis(handle) {
  const state = ROOTS.get(handle) || TRANSITIONS.get(handle);
  return { basisDigest: state.digest, basisRevision: state.root.revision };
}

function targetSnapshotFields(handle) {
  const candidate = CANDIDATES.get(handle);
  const release = RELEASES.get(candidate.release);
  return { releaseDigest: release.digest, targetId: candidate.target.id,
    candidateId: deriveCandidateId(release.digest, candidate.target.id), ...evidenceBasis(candidate.root) };
}

/** Return detached evidence data only; snapshots confer no update authority. */
export function snapshotEvidence(handle) {
  let state = ROOTS.get(handle);
  if (state) return evidenceRecord("root", { rootBytes: copyEvidenceBytes(state.bytes, 65536),
    rootDigest: state.digest, rootRevision: state.root.revision, anchorDigest: EMBEDDED_ROOT_SHA256 });
  state = TRANSITIONS.get(handle);
  if (state) return evidenceRecord("transition", { rootBytes: copyEvidenceBytes(state.bytes, 65536),
    envelopeBytes: copyEvidenceBytes(state.envelopeBytes, 262144), rootDigest: state.digest,
    rootRevision: state.root.revision, predecessorDigest: state.predecessorDigest, predecessorRevision: state.predecessorRevision });
  state = RELEASES.get(handle);
  if (state) return evidenceRecord("release", { releaseBytes: copyEvidenceBytes(state.bytes, 1048576),
    envelopeBytes: copyEvidenceBytes(state.envelopeBytes, 65536), releaseDigest: state.digest,
    channel: state.release.channel, ...evidenceBasis(state.root) });
  state = CANDIDATES.get(handle);
  if (state) {
    const { platform, arch, owner, artifactKind, bundleKind } = state.target;
    return evidenceRecord("target", { ...targetSnapshotFields(handle),
      selection: Object.freeze({ platform, arch, owner, artifactKind, bundleKind }) });
  }
  state = ARTIFACTS.get(handle);
  if (state) {
    const target = CANDIDATES.get(state.target).target;
    return evidenceRecord("artifact", { ...targetSnapshotFields(state.target), artifactDigest: state.digest,
      artifactSize: state.size, signatureBox: target.artifact.signatureBox, signerFingerprint: target.artifact.signerFingerprint });
  }
  state = RECEIPTS.get(handle);
  if (state) return evidenceRecord("receipt", { receiptBytes: copyEvidenceBytes(state.bytes, 1048576),
    receiptDigest: evidenceDigest(state.bytes), receiptSize: state.bytes.byteLength, ...targetSnapshotFields(state.target) });
  state = TREES.get(handle);
  if (state) return evidenceRecord("tree", { treeBytes: copyEvidenceBytes(state.bytes, 16777216),
    envelopeBytes: copyEvidenceBytes(state.envelopeBytes, 65536), treeDigest: evidenceDigest(state.bytes),
    treeSize: state.bytes.byteLength, envelopeDigest: evidenceDigest(state.envelopeBytes), envelopeSize: state.envelopeBytes.byteLength,
    receiptDigest: evidenceDigest(RECEIPTS.get(state.receipt).bytes), ...targetSnapshotFields(state.target) });
  state = CAPABILITIES.get(handle);
  if (state) return evidenceRecord("capability", { capabilityBytes: copyEvidenceBytes(state.bytes, 1048576),
    capabilityDigest: evidenceDigest(state.bytes), capabilitySize: state.bytes.byteLength,
    receiptDigest: evidenceDigest(RECEIPTS.get(state.receipt).bytes), ...targetSnapshotFields(state.target) });
  throw new Error("Invalid update evidence");
}
