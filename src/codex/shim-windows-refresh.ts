import { randomUUID } from "node:crypto";
import { closeSync, constants, existsSync, fstatSync, linkSync, lstatSync, openSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { extname } from "node:path";
import { sameFingerprint, sameFingerprintAfterRename, shimPathFingerprint, type ShimPathFingerprint, type StableShimPathProbe } from "./shim-fingerprint";

interface FileIdentity { dev: bigint; ino: bigint }

function entryIs(path: string, identity: FileIdentity): boolean {
  try {
    const entry = lstatSync(path, { bigint: true });
    return !entry.isSymbolicLink() && entry.isFile() && entry.dev === identity.dev && entry.ino === identity.ino;
  } catch {
    return false;
  }
}

/** Create `path` exclusively (never through an existing entry or link) and return the written file's identity. */
function createExclusive(path: string, content: string): FileIdentity {
  const flags = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL
    | (process.platform === "win32" ? 0 : constants.O_NOFOLLOW);
  const fd = openSync(path, flags, 0o644);
  try {
    writeFileSync(fd, content, "utf8");
    const stat = fstatSync(fd, { bigint: true });
    return { dev: stat.dev, ino: stat.ino };
  } finally {
    closeSync(fd);
  }
}

/**
 * Replace an owned, obsolete Windows wrapper without ever truncating, replacing or writing through
 * a file someone else published (an npm or version-manager install racing this refresh, or a link
 * planted beside the wrapper).
 *
 * 1. Move the observed wrapper aside and prove the moved file is the one that was probed; a
 *    different file means a concurrent replacement, which is put back untouched.
 * 2. Create the stage exclusively under an unpredictable name and record its identity. An existing
 *    entry, including a planted link, makes creation fail instead of being written through.
 * 3. Publish with a hard link, which fails instead of replacing when the path is occupied again,
 *    and only while the stage is still the file this refresh created.
 *
 * Every cleanup is bound to identity: only the stage this refresh created and only the moved copy
 * of the observed wrapper are ever unlinked. Returns true only when the current wrapper was
 * published; a filesystem that refuses hard links leaves the obsolete wrapper restored and the
 * refresh deferred.
 */
export function refreshObsoleteWindowsShim(
  wrapperPath: string,
  observed: StableShimPathProbe,
  render: () => string,
  /** Test seam only: a fixed stage path, so a planted entry can be placed where the stage goes. */
  stagedPathForTests?: string,
): boolean {
  const extension = extname(wrapperPath);
  const aside = `${wrapperPath}.ocx-obsolete-${randomUUID()}${extension}`;
  const staged = stagedPathForTests ?? `${wrapperPath}.ocx-refresh-${randomUUID()}${extension}`;
  let moved: ShimPathFingerprint | null = null;
  const discardAside = (): void => {
    const current = shimPathFingerprint(aside);
    if (moved && current && sameFingerprint(current, moved)) { try { unlinkSync(aside); } catch { /* already gone */ } }
  };
  /** Put the moved file back only onto an empty path; an occupied path keeps its new owner. */
  const restoreAside = (): void => {
    if (existsSync(wrapperPath)) return;
    try { linkSync(aside, wrapperPath); } catch { return; /* the aside copy stays recoverable */ }
    try { unlinkSync(aside); } catch { /* the restored link keeps the content */ }
  };

  try { renameSync(wrapperPath, aside); } catch { return false; }
  moved = shimPathFingerprint(aside);
  if (!moved || !sameFingerprintAfterRename(observed.fingerprint, moved)) {
    restoreAside();
    return false;
  }
  let created: FileIdentity;
  try {
    created = createExclusive(staged, render());
  } catch (error) {
    restoreAside();
    if ((error as NodeJS.ErrnoException).code === "EEXIST" || (error as NodeJS.ErrnoException).code === "ELOOP") return false;
    throw error;
  }
  const discardStaged = (): void => {
    if (entryIs(staged, created)) { try { unlinkSync(staged); } catch { /* already gone */ } }
  };
  if (!entryIs(staged, created)) {
    restoreAside();
    return false;
  }
  try {
    linkSync(staged, wrapperPath);
  } catch (error) {
    discardStaged();
    if ((error as NodeJS.ErrnoException).code === "EEXIST") discardAside();
    else restoreAside();
    return false;
  }
  if (!entryIs(wrapperPath, created)) {
    // The stage was swapped between the check and the link. Withdraw only the link this call made
    // to that swapped file (it still shares the stage's identity); a later replacement of the
    // wrapper path is someone else's and stays.
    try {
      const published = lstatSync(wrapperPath, { bigint: true });
      if (entryIs(staged, { dev: published.dev, ino: published.ino })) {
        unlinkSync(wrapperPath);
        restoreAside();
      }
    } catch { /* nothing to withdraw */ }
    return false;
  }
  discardStaged();
  discardAside();
  return true;
}
