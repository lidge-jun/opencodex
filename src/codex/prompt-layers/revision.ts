import { existsSync, readFileSync } from "node:fs";
import { createHash, type Hash } from "node:crypto";

/**
 * Feed one named field into a fingerprint, framed so that no two distinct states
 * can produce the same digest.
 *
 * Framing is the whole point. Concatenating `name + ":" + contents` is ambiguous:
 * an adversarial review of the first version of this function showed that
 * `{override: "left", agents: "right\nAGENTS.md:tail"}` and
 * `{override: "left\nAGENTS.md:right", agents: "tail"}` hashed identically, because
 * a file's own bytes can imitate the separator that follows it. That is exactly a
 * missed invalidation: the fingerprint is the probe's admission key, so two
 * different prompt states sharing a digest means one caller is served the other's
 * stale text.
 *
 * A byte length cannot be forged by content, so each field carries one. Absence is
 * a length of -1 rather than a sentinel string, because a sentinel is just more
 * content: the same review found that `null` collided with a file whose bytes were
 * literally NUL + "absent".
 */
export function updateFingerprintField(hash: Hash, name: string, contents: string | null): void {
  const bytes = contents === null ? -1 : Buffer.byteLength(contents, "utf8");
  hash.update(`\n${name}:${bytes}:`);
  if (contents !== null) hash.update(contents);
}


// ---------------------------------------------------------------------------
// Byte-level hashing. The revision covers COMPLETE file bytes plus existence,
// so removing the marker while leaving the value intact still changes it.
// ---------------------------------------------------------------------------

export function readFileOrNull(path: string): string | null {
  try {
    if (!existsSync(path)) return null;
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

export function computeRevision(configBytes: string | null, storeBytes: string | null): string {
  const hash = createHash("sha256");
  // Length-framed for the reason given on updateFingerprintField: with a bare
  // separator, config bytes ending in "\nstore:" shift the boundary and two
  // different pairs hash alike. That matters twice over — this value is both the
  // probe's admission input and the optimistic-concurrency token compared in
  // commit(), where a collision would let a write built on stale bytes through.
  updateFingerprintField(hash, "cfg", configBytes);
  updateFingerprintField(hash, "store", storeBytes);
  return `sha256:${hash.digest("hex")}`;
}

export { readFileOrNull as readFileBytes };
