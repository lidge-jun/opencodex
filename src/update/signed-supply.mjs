import { createHash } from "node:crypto";
import { parseSignatureEnvelope, parseUpdateDocument } from "./update-contracts.mjs";
import { EMBEDDED_ROOT_SHA256 } from "./update-trust-anchor.mjs";
import { snapshotUpdateBytes } from "./update-bytes.mjs";
import { verifySignatureThreshold } from "./update-signature-threshold.mjs";
import { deriveCandidateId } from "./update-candidate-id.mjs";

// Handles are module-owned and contain no caller-mutable trust data.
const ROOTS = new WeakMap();
const RELEASES = new WeakMap();
const CANDIDATES = new WeakMap();

function currentRoot(handle, nowMs) {
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) throw new Error("Invalid trust clock");
  const state = ROOTS.get(handle);
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

/** Verify exact release bytes under an opaque, current embedded root. */
export function verifyReleaseRecord(bytes, envelopeBytes, trustedRoot, expectedChannel, nowMs) {
  const state = currentRoot(trustedRoot, nowMs);
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
  RELEASES.set(handle, { release, root: trustedRoot, digest });
  return handle;
}

/** Select a signed tuple; the resulting identity is a lookup, not install authority. */
export function selectVerifiedTarget(verifiedRelease, selection) {
  const state = RELEASES.get(verifiedRelease);
  const fields = ["platform", "arch", "owner", "artifactKind", "bundleKind"];
  if (!state || !selection || typeof selection !== "object" || Array.isArray(selection)
      || Object.keys(selection).length !== fields.length || !fields.every((field) => Object.hasOwn(selection, field))) {
    throw new Error("Invalid verified update selection");
  }
  const matches = state.release.targets.filter((target) => fields.every((field) => target[field] === selection[field]));
  if (matches.length !== 1) throw new Error("Update target unavailable");
  const candidateId = deriveCandidateId(state.digest, matches[0].id);
  const handle = Object.freeze({ candidateId });
  CANDIDATES.set(handle, { release: verifiedRelease, root: state.root, target: matches[0] });
  return handle;
}
