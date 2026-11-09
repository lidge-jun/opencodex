import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { MuseMspError } from "./connection";

const KEY = randomBytes(32);
const digest = (bytes: Uint8Array) => createHmac("sha256", KEY).update("muse-local-credential-v1\0").update(bytes).digest();
const valid = (bytes: Uint8Array) => bytes instanceof Uint8Array && bytes.byteLength > 0 && bytes.byteLength <= 1024 * 1024;

/** Experimental local snapshot; does not establish what an already-running host actually uses. */
export function createMuseCredentialSnapshot(bytes: Uint8Array): { id: string; matches: (candidate: Uint8Array) => boolean; close: () => void } {
  if (!valid(bytes)) throw new MuseMspError("invalid_credential_snapshot");
  const original = digest(bytes);
  let closed = false;
  return {
    id: original.toString("hex"),
    matches(candidate) {
      if (closed || !valid(candidate)) return false;
      const current = digest(candidate);
      try { return timingSafeEqual(original, current); } finally { current.fill(0); }
    },
    close() { if (!closed) { closed = true; original.fill(0); } },
  };
}
