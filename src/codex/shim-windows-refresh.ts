import { randomUUID } from "node:crypto";
import { existsSync, linkSync, renameSync, unlinkSync } from "node:fs";
import { extname } from "node:path";
import { sameFingerprintAfterRename, shimPathFingerprint, type StableShimPathProbe } from "./shim-fingerprint";

/**
 * Replace an owned, obsolete Windows wrapper without ever truncating or replacing a file someone
 * else published at the same path (an npm or version-manager install racing this refresh).
 *
 * 1. Move the observed wrapper aside and prove the moved file is the one that was probed; a
 *    different file means a concurrent replacement, which is put back untouched.
 * 2. Render the current wrapper into a staged sibling with the same extension.
 * 3. Publish with a hard link, which fails instead of replacing when the path is occupied again.
 *    A concurrent publisher then keeps the path, and only our own obsolete copy is discarded.
 *
 * Returns true only when the current wrapper was published. Any filesystem that refuses hard links
 * leaves the obsolete wrapper restored and the refresh deferred.
 */
export function refreshObsoleteWindowsShim(
  wrapperPath: string,
  observed: StableShimPathProbe,
  writeStaged: (stagedPath: string) => void,
): boolean {
  const tag = randomUUID().slice(0, 8);
  const extension = extname(wrapperPath);
  const aside = `${wrapperPath}.ocx-obsolete-${tag}${extension}`;
  const staged = `${wrapperPath}.ocx-refresh-${tag}${extension}`;
  const discard = (path: string): void => { try { unlinkSync(path); } catch { /* already gone */ } };
  /** Put the moved file back only onto an empty path; an occupied path keeps its new owner. */
  const restoreAside = (): void => {
    if (existsSync(wrapperPath)) return;
    try { linkSync(aside, wrapperPath); discard(aside); } catch { /* the aside copy stays recoverable */ }
  };

  try { renameSync(wrapperPath, aside); } catch { return false; }
  const moved = shimPathFingerprint(aside);
  if (!moved || !sameFingerprintAfterRename(observed.fingerprint, moved)) {
    restoreAside();
    return false;
  }
  try {
    writeStaged(staged);
  } catch (error) {
    discard(staged);
    restoreAside();
    throw error;
  }
  try {
    linkSync(staged, wrapperPath);
  } catch (error) {
    discard(staged);
    if ((error as NodeJS.ErrnoException).code === "EEXIST") discard(aside);
    else restoreAside();
    return false;
  }
  discard(staged);
  discard(aside);
  return true;
}
