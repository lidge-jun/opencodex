/**
 * Naming rules for pending-teardown receipts, shared by both update lanes (#3008).
 *
 * Plain ESM because `bin/ocx.mjs` runs under Node before Bun exists and cannot import the
 * TypeScript module. It lives here rather than being spelled out twice because that is
 * exactly how this broke: the launcher kept checking the retired singleton filename after
 * the receipts moved to one file per claim, so the npm lane silently stopped seeing every
 * outstanding obligation.
 */

export const PENDING_TEARDOWN_PREFIX = "pending-teardown-";
export const PENDING_TEARDOWN_SUFFIX = ".json";
/**
 * Suffix for an obligation that could not be read.
 *
 * It is still an obligation. Quarantine renames the file so the ordinary recovery loop
 * stops re-reading garbage, but it must NOT stop counting: an update that proceeds
 * because the evidence was filed away is exactly the outcome the receipt exists to
 * prevent. Both lanes treat this as outstanding until an operator removes it.
 */
export const PENDING_TEARDOWN_UNREADABLE_SUFFIX = ".unreadable.json";
const NONCE_RE = /^[0-9a-f]{32}$/;

/** A receipt the recovery loop should read and try to discharge. */
export function isPendingTeardownFileName(name) {
  if (typeof name !== "string") return false;
  if (isQuarantinedTeardownFileName(name)) return false;
  if (!name.startsWith(PENDING_TEARDOWN_PREFIX) || !name.endsWith(PENDING_TEARDOWN_SUFFIX)) return false;
  return NONCE_RE.test(name.slice(PENDING_TEARDOWN_PREFIX.length, name.length - PENDING_TEARDOWN_SUFFIX.length));
}

/** A receipt that could not be read and is waiting on a human. */
export function isQuarantinedTeardownFileName(name) {
  if (typeof name !== "string") return false;
  if (!name.startsWith(PENDING_TEARDOWN_PREFIX) || !name.endsWith(PENDING_TEARDOWN_UNREADABLE_SUFFIX)) return false;
  return NONCE_RE.test(name.slice(
    PENDING_TEARDOWN_PREFIX.length,
    name.length - PENDING_TEARDOWN_UNREADABLE_SUFFIX.length,
  ));
}

/** Any obligation at all — readable or quarantined. Both block an update. */
export function isAnyTeardownObligationFileName(name) {
  return isPendingTeardownFileName(name) || isQuarantinedTeardownFileName(name);
}

export function pendingTeardownNonceFromFileName(name) {
  if (!isPendingTeardownFileName(name)) return null;
  return name.slice(PENDING_TEARDOWN_PREFIX.length, name.length - PENDING_TEARDOWN_SUFFIX.length);
}

/**
 * Does the given config directory hold any outstanding obligation?
 *
 * Quarantined receipts count. Filing one away to unblock an update would let the very
 * next `ocx update` install over a teardown that never ran — the enforcement has to
 * survive until a human removes the file.
 */
export function hasPendingTeardownIn(readdir, dir) {
  try {
    return readdir(dir).some(isAnyTeardownObligationFileName);
  } catch (error) {
    // "There is no home yet" is the only honest empty answer. Any other failure —
    // permissions, I/O, a file where the directory should be — means an obligation may be
    // sitting there unread, and reporting "none" would let an update install over a
    // teardown that never ran. Absence of proof is not proof of absence.
    return error?.code !== "ENOENT";
  }
}
