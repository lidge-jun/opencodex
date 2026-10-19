import { randomUUID } from "node:crypto";
import { closeSync, constants, existsSync, fstatSync, linkSync, lstatSync, openSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, extname, join } from "node:path";
import { sameFingerprintAfterRename, sameStableShimPathProbe, shimPathFingerprint, stableShimPathProbe, type StableShimPathProbe } from "./shim-fingerprint";

interface FileIdentity { dev: bigint; ino: bigint }

/** Identity of the directory entry itself (a link is its own entry); null when absent. */
function entryIdentity(path: string): (FileIdentity & { link: boolean }) | null {
  try {
    const entry = lstatSync(path, { bigint: true });
    return { dev: entry.dev, ino: entry.ino, link: entry.isSymbolicLink() };
  } catch {
    return null;
  }
}

/** Identity of what a path resolves to; null when absent or dangling. */
function targetIdentity(path: string): FileIdentity | null {
  try {
    const target = statSync(path, { bigint: true });
    return { dev: target.dev, ino: target.ino };
  } catch {
    return null;
  }
}

const same = (left: FileIdentity | null, right: FileIdentity | null): boolean =>
  !!left && !!right && left.dev === right.dev && left.ino === right.ino;

/** A regular, non-link entry at `path` that is exactly `identity`. */
function entryIs(path: string, identity: FileIdentity): boolean {
  const entry = entryIdentity(path);
  return !!entry && !entry.link && same(entry, identity);
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
 * Hard-link `source` onto the empty `destination` and keep the result only if the published entry
 * is exactly `expected`. If `source` was swapped (for another file or a link) between the caller's
 * check and the link, the entry this call created is withdrawn; an entry that matches neither the
 * source nor its target belongs to an independent later publisher and stays.
 */
function linkExpected(source: string, destination: string, expected: FileIdentity): "published" | "occupied" | "refused" {
  try {
    linkSync(source, destination);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EEXIST" ? "occupied" : "refused";
  }
  const published = entryIdentity(destination);
  if (published && same(published, expected)) return "published";
  if (published && (same(published, entryIdentity(source)) || same(published, targetIdentity(source)))) {
    try { unlinkSync(destination); } catch { /* nothing to withdraw */ }
  }
  return "refused";
}

/** Whether `directory` supports hard links, proven with a throwaway pair before anything is displaced. */
function hardLinksWork(directory: string): boolean {
  const probe = join(directory, `.ocx-link-probe-${randomUUID()}`);
  const linked = `${probe}-linked`;
  let identity: FileIdentity;
  try { identity = createExclusive(probe, ""); } catch { return false; }
  try {
    linkSync(probe, linked);
    return entryIs(linked, identity);
  } catch {
    return false;
  } finally {
    for (const path of [linked, probe]) if (entryIs(path, identity)) { try { unlinkSync(path); } catch { /* best effort */ } }
  }
}

/**
 * Replace an owned, obsolete Windows wrapper without ever truncating, replacing or writing through
 * a file someone else published (an npm or version-manager install racing this refresh, or an entry
 * planted beside the wrapper).
 *
 * 1. Move the observed wrapper aside and prove the moved file is the one that was probed; a
 *    different file means a concurrent replacement, which is put back untouched.
 * 2. Create the stage exclusively under an unpredictable name and record its identity.
 * 3. Publish by hard link onto the empty path, keeping the result only if it is that stage file.
 *
 * Every restore, withdrawal and cleanup is bound to identity: only the stage this refresh created
 * and only the moved copy of the observed wrapper are ever published or unlinked. Returns true only
 * when the current wrapper was published; a filesystem that refuses hard links leaves the obsolete
 * wrapper restored and the refresh deferred.
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
  let moved: FileIdentity | null = null;
  const discard = (path: string, identity: FileIdentity | null): void => {
    if (identity && entryIs(path, identity)) { try { unlinkSync(path); } catch { /* already gone */ } }
  };
  /**
   * Put the moved wrapper back only onto an empty path, and only while the aside is still it. If the
   * link fails (hard links became unavailable mid-refresh), an identity-checked rename keeps the
   * launcher from staying missing.
   */
  const restoreAside = (): void => {
    if (!moved || existsSync(wrapperPath) || !entryIs(aside, moved)) return;
    if (linkExpected(aside, wrapperPath, moved) === "published") { discard(aside, moved); return; }
    if (!existsSync(wrapperPath) && entryIs(aside, moved)) { try { renameSync(aside, wrapperPath); } catch { /* the aside copy stays recoverable */ } }
  };

  // Never displace a working wrapper on a filesystem that cannot publish its replacement.
  if (!hardLinksWork(dirname(wrapperPath))) return false;
  try { renameSync(wrapperPath, aside); } catch { return false; }
  const movedFingerprint = shimPathFingerprint(aside);
  const movedEntry = entryIdentity(aside);
  if (!movedFingerprint || !movedEntry || movedEntry.link || !sameFingerprintAfterRename(observed.fingerprint, movedFingerprint)) {
    // Not the observed wrapper: hand the path back to whatever was moved, untouched.
    if (movedEntry && !existsSync(wrapperPath)) {
      if (linkExpected(aside, wrapperPath, movedEntry) === "published") discard(aside, movedEntry);
    }
    return false;
  }
  moved = movedEntry;
  let created: FileIdentity;
  try {
    created = createExclusive(staged, render());
  } catch (error) {
    restoreAside();
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EEXIST" || code === "ELOOP") return false;
    throw error;
  }
  if (!entryIs(staged, created)) {
    restoreAside();
    return false;
  }
  const outcome = linkExpected(staged, wrapperPath, created);
  discard(staged, created);
  if (outcome === "published") {
    discard(aside, moved);
    return true;
  }
  // Occupied: a concurrent publisher owns the path now; only our obsolete copy is discarded.
  if (outcome === "occupied") discard(aside, moved);
  else restoreAside();
  return false;
}

/**
 * Automatic Windows revision recovery: refresh exactly the admitted obsolete wrappers, and only
 * while every current sibling is still the file observed before the stability wait. It never
 * adopts a replacement launcher or rewrites a backup; anything unexpected defers.
 */
export function refreshAdmittedWindowsShims(
  obsolete: ReadonlyMap<string, StableShimPathProbe>,
  current: ReadonlyMap<string, StableShimPathProbe>,
  render: (wrapperPath: string) => string,
): boolean {
  for (const [path, first] of current) {
    const second = stableShimPathProbe(path);
    if (!second || !sameStableShimPathProbe(first, second)) return false;
  }
  let all = true;
  for (const [path, observed] of obsolete) all = refreshObsoleteWindowsShim(path, observed, () => render(path)) && all;
  return all;
}
