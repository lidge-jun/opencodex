import { createHash } from "node:crypto";
import { parseUpdateDocument } from "./update-contracts.mjs";
import { EMBEDDED_ROOT_SHA256 } from "./update-trust-anchor.mjs";
import { snapshotUpdateBytes } from "./update-bytes.mjs";

// Handles are module-owned and contain no caller-mutable trust data.
const ROOTS = new WeakMap();

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
