import { createHash } from "node:crypto";
import { readConfigAdmissionSnapshot } from "./diagnostics";
import type { OcxConfig } from "../types";

/**
 * Which configuration a derived artifact was built from, or null when that cannot be established.
 *
 * Two questions have to be answered together, and answering either one alone is what made the
 * earlier versions of this wrong. The file digest says WHICH FILE the configuration came from, and
 * it is the only thing that can see a field nobody thought to list. It cannot see that the object
 * a caller is holding is the parse of that file: callers pass an in-memory configuration around,
 * routes mutate it in place, and a roster built from one in-memory state would otherwise be
 * retained under a key that only describes bytes on disk.
 *
 * So the identity carries both terms. The second is a digest of the object itself, taken
 * structurally rather than from a list of fields, for the same reason the first one exists: a list
 * is only as complete as whoever last thought about it.
 *
 * Null means unprovable and every caller must fail closed on it. Refusing to serve a preview is
 * recoverable; serving a roster that belongs to a configuration the user no longer has is not.
 */
export function admittedConfigIdentity(config: OcxConfig): string | null {
  const file = admittedConfigFileTerm();
  if (file === null) return null;
  const held = heldConfigDigest(config);
  return held === null ? null : `${file}:${held}`;
}

function admittedConfigFileTerm(): string | null {
  const snapshot = readConfigAdmissionSnapshot();
  if (snapshot.contentSha256 !== null) return snapshot.contentSha256;
  /*
   * A file that is not there is a well-defined configuration, not an unprovable one: it means
   * defaults, and it is the ordinary state of a fresh install. Collapsing it into the unreadable
   * case would refuse every preview on a machine with no config file, including CI.
   *
   * A file that exists and cannot be parsed is genuinely unprovable, and that still fails closed.
   */
  const { source, error } = snapshot.diagnostics;
  return source === "default" && error === null ? "absent" : null;
}

/**
 * A digest of the configuration object as it stands right now.
 *
 * Structural, so it moves for any change rather than for a chosen set of them, and canonical, so
 * two objects describing the same configuration cannot digest differently because their keys were
 * inserted in a different order.
 *
 * Nothing derived from this is logged or serialized: the digest travels, the configuration does
 * not. Null when the object cannot be canonicalized at all, which fails closed.
 */
function heldConfigDigest(config: OcxConfig): string | null {
  try {
    return createHash("sha256").update(JSON.stringify(canonical(config))).digest("hex");
  } catch {
    return null;
  }
}

/**
 * Key-sorted entry pairs rather than objects, because JSON.stringify preserves insertion order and
 * two configurations that differ only in that order are the same configuration.
 *
 * A value JSON cannot carry (a function a caller attached, an explicit undefined) becomes null
 * here. That is deliberate: such a value is not part of the configuration's content, and treating
 * it as absent would make an added one invisible.
 */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object") {
    return Object.keys(value as Record<string, unknown>)
      .sort()
      .map(key => [key, canonical((value as Record<string, unknown>)[key])]);
  }
  return typeof value === "function" || value === undefined ? null : value;
}
