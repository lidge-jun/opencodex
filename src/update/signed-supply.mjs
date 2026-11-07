import { createHash } from "node:crypto";
import { parseUpdateDocument } from "./update-contracts.mjs";
import { EMBEDDED_ROOT_SHA256 } from "./update-trust-anchor.mjs";

// Handles are module-owned and contain no caller-mutable trust data.
const ROOTS = new WeakMap();

/** Authenticate the one root whose digest is compiled into this module closure. */
export function bootstrapEmbeddedRoot(bytes, nowMs) {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength > 65536
      || !Number.isSafeInteger(nowMs) || nowMs < 0) throw new Error("Invalid embedded root input");
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (digest !== EMBEDDED_ROOT_SHA256) throw new Error("Embedded root digest mismatch");
  const root = parseUpdateDocument(bytes, "ocx.update.root/1");
  if (Date.parse(root.expiresAt) <= nowMs) throw new Error("Embedded root expired");
  const handle = Object.freeze(Object.create(null));
  ROOTS.set(handle, { root, bytes: Uint8Array.from(bytes), digest });
  return handle;
}
