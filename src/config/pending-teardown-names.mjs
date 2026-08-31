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
const NONCE_RE = /^[0-9a-f]{32}$/;

/**
 * Is this directory entry an outstanding receipt?
 *
 * Quarantined files are deliberately excluded: they end in `.bak`, so the nonce test
 * rejects them and a set-aside obligation cannot wedge an update forever.
 */
export function isPendingTeardownFileName(name) {
  if (typeof name !== "string") return false;
  if (!name.startsWith(PENDING_TEARDOWN_PREFIX) || !name.endsWith(PENDING_TEARDOWN_SUFFIX)) return false;
  return NONCE_RE.test(name.slice(PENDING_TEARDOWN_PREFIX.length, name.length - PENDING_TEARDOWN_SUFFIX.length));
}

export function pendingTeardownNonceFromFileName(name) {
  if (!isPendingTeardownFileName(name)) return null;
  return name.slice(PENDING_TEARDOWN_PREFIX.length, name.length - PENDING_TEARDOWN_SUFFIX.length);
}

/** Does the given config directory hold any outstanding receipt? */
export function hasPendingTeardownIn(readdir, dir) {
  try {
    return readdir(dir).some(isPendingTeardownFileName);
  } catch {
    return false;
  }
}
