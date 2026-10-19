import { randomUUID } from "node:crypto";
import { closeSync, constants, existsSync, fstatSync, linkSync, lstatSync, openSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, extname, join } from "node:path";
import { sameFingerprintAfterRename, sameStableShimPathProbe, shimPathFingerprint, stableShimPathProbe, type StableShimPathProbe } from "./shim-fingerprint";

/**
 * Identity of a directory entry: device, inode and whether the entry is itself a symbolic link.
 *
 * dev/ino alone is not an identity on Linux: ext4 and tmpfs hand a freed inode number straight to the
 * next file or link created, so a stage unlinked and replaced by a link (or a new file) can carry the
 * very numbers this refresh recorded. Every identity this module compares therefore belongs to a file
 * it still holds open (an open inode cannot be freed, so its number cannot be reused), and the link
 * flag is compared too, so a symlink never matches a regular file whatever the platform's link(2)
 * does with a symlink source.
 */
interface EntryIdentity { dev: bigint; ino: bigint; link: boolean }

/** Identity of the directory entry itself (a link is its own entry); null when absent. */
function entryIdentity(path: string): EntryIdentity | null {
  try {
    const entry = lstatSync(path, { bigint: true });
    return { dev: entry.dev, ino: entry.ino, link: entry.isSymbolicLink() };
  } catch {
    return null;
  }
}

/** Identity of what a path resolves to; null when absent or dangling. */
function targetIdentity(path: string): EntryIdentity | null {
  try {
    const target = statSync(path, { bigint: true });
    return { dev: target.dev, ino: target.ino, link: false };
  } catch {
    return null;
  }
}

const same = (left: EntryIdentity | null, right: EntryIdentity | null): boolean =>
  !!left && !!right && left.dev === right.dev && left.ino === right.ino && left.link === right.link;

/** The entry at `path` is exactly `identity` (same inode, same link-ness). */
function entryIs(path: string, identity: EntryIdentity): boolean {
  return same(entryIdentity(path), identity);
}

/** An open regular file and its identity; the descriptor pins the inode for as long as it is open. */
interface HeldFile { fd: number; identity: EntryIdentity }

function release(held: HeldFile | null): void {
  if (held) { try { closeSync(held.fd); } catch { /* already closed */ } }
}

/** Create `path` exclusively (never through an existing entry or link), write it, and keep it open. */
function createExclusive(path: string, content: string): HeldFile {
  const flags = constants.O_RDWR | constants.O_CREAT | constants.O_EXCL
    | (process.platform === "win32" ? 0 : constants.O_NOFOLLOW);
  const fd = openSync(path, flags, 0o644);
  try {
    writeFileSync(fd, content, "utf8");
    const stat = fstatSync(fd, { bigint: true });
    return { fd, identity: { dev: stat.dev, ino: stat.ino, link: false } };
  } catch (error) {
    try { closeSync(fd); } catch { /* already closed */ }
    throw error;
  }
}

/** Open the regular file at `path` without following a link and confirm the entry is the opened file. */
function holdExisting(path: string): HeldFile | null {
  const entry = entryIdentity(path);
  if (!entry || entry.link) return null;
  const flags = process.platform === "win32"
    ? constants.O_RDONLY
    : constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
  let fd: number;
  try { fd = openSync(path, flags); } catch { return null; }
  try {
    const stat = fstatSync(fd, { bigint: true });
    const identity: EntryIdentity = { dev: stat.dev, ino: stat.ino, link: false };
    if (stat.isFile() && same(identity, entry) && entryIs(path, identity)) return { fd, identity };
  } catch { /* unreadable descriptor: treated like a mismatch */ }
  // Every unsuccessful path releases the descriptor; the caller then hands the moved file back.
  try { closeSync(fd); } catch { /* already closed */ }
  return null;
}

/**
 * Hard-link `source` onto the empty `destination` and keep the result only if the published entry
 * is exactly `expected`. If `source` was swapped (for another file or a link) between the caller's
 * check and the link, the entry this call created is withdrawn; an entry that matches neither the
 * source nor its target belongs to an independent later publisher and stays.
 */
function linkExpected(source: string, destination: string, expected: EntryIdentity): "published" | "occupied" | "refused" {
  try {
    linkSync(source, destination);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EEXIST" ? "occupied" : "refused";
  }
  const published = entryIdentity(destination);
  if (same(published, expected)) return "published";
  if (published && (same(published, entryIdentity(source)) || same(published, targetIdentity(source)))) {
    try { unlinkSync(destination); } catch { /* nothing to withdraw */ }
  }
  return "refused";
}

/** Whether `directory` supports hard links, proven with a throwaway pair before anything is displaced. */
function hardLinksWork(directory: string): boolean {
  const probe = join(directory, `.ocx-link-probe-${randomUUID()}`);
  const linked = `${probe}-linked`;
  let held: HeldFile;
  try { held = createExclusive(probe, ""); } catch { return false; }
  try {
    linkSync(probe, linked);
    return entryIs(linked, held.identity);
  } catch {
    return false;
  } finally {
    for (const path of [linked, probe]) if (entryIs(path, held.identity)) { try { unlinkSync(path); } catch { /* best effort */ } }
    release(held);
  }
}

/**
 * Replace an owned, obsolete Windows wrapper without ever truncating, replacing or writing through
 * a file someone else published (an npm or version-manager install racing this refresh, or an entry
 * planted beside the wrapper).
 *
 * 1. Move the observed wrapper aside, open it, and prove the moved file is the one that was probed;
 *    a different file means a concurrent replacement, which is put back untouched.
 * 2. Create the stage exclusively under an unpredictable name and keep it open.
 * 3. Publish by hard link onto the empty path, keeping the result only if it is that stage file.
 *
 * Every restore, withdrawal and cleanup is bound to the identity of a file this refresh holds open:
 * only the stage it created and only the moved copy of the observed wrapper are ever published or
 * unlinked. Returns true only when the current wrapper was published; a filesystem that refuses hard
 * links leaves the obsolete wrapper restored and the refresh deferred.
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
  let moved: HeldFile | null = null;
  let stage: HeldFile | null = null;
  const discard = (path: string, held: HeldFile | null): void => {
    if (held && entryIs(path, held.identity)) { try { unlinkSync(path); } catch { /* already gone */ } }
  };
  /**
   * Put the moved wrapper back only onto an empty path, and only while the aside is still it. If the
   * link fails (hard links became unavailable mid-refresh), an identity-checked rename keeps the
   * launcher from staying missing.
   */
  const restoreAside = (): void => {
    if (!moved || existsSync(wrapperPath) || !entryIs(aside, moved.identity)) return;
    if (linkExpected(aside, wrapperPath, moved.identity) === "published") { discard(aside, moved); return; }
    if (!existsSync(wrapperPath) && entryIs(aside, moved.identity)) { try { renameSync(aside, wrapperPath); } catch { /* the aside copy stays recoverable */ } }
  };

  // Never displace a working wrapper on a filesystem that cannot publish its replacement.
  if (!hardLinksWork(dirname(wrapperPath))) return false;
  try { renameSync(wrapperPath, aside); } catch { return false; }
  try {
    const movedFingerprint = shimPathFingerprint(aside);
    moved = holdExisting(aside);
    if (!moved || !movedFingerprint || !sameFingerprintAfterRename(observed.fingerprint, movedFingerprint)) {
      // Not the observed wrapper: hand the path back to whatever was moved, untouched.
      const foreign = entryIdentity(aside);
      if (foreign && !existsSync(wrapperPath) && linkExpected(aside, wrapperPath, foreign) === "published" && entryIs(aside, foreign)) {
        try { unlinkSync(aside); } catch { /* the restored link keeps the content */ }
      }
      return false;
    }
    try {
      stage = createExclusive(staged, render());
    } catch (error) {
      restoreAside();
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EEXIST" || code === "ELOOP") return false;
      throw error;
    }
    if (!entryIs(staged, stage.identity)) {
      restoreAside();
      return false;
    }
    const outcome = linkExpected(staged, wrapperPath, stage.identity);
    discard(staged, stage);
    if (outcome === "published") {
      discard(aside, moved);
      return true;
    }
    // Occupied: a concurrent publisher owns the path now; only our obsolete copy is discarded.
    if (outcome === "occupied") discard(aside, moved);
    else restoreAside();
    return false;
  } finally {
    release(stage);
    release(moved);
  }
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
