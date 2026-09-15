import {
  closeSync,
  existsSync,
  lstatSync,
  linkSync,
  openSync,
  readSync,
  readlinkSync,
  statSync,
  symlinkSync,
  unlinkSync,
} from "node:fs";
import { posix, win32 } from "node:path";
import { SHIM_MARKER, UNIX_SHIM_REVISION_MARKER } from "./shim-templates";
import type { ShimFileState } from "./shim-state-file";

const CODEX_SHIM_PROBE_BYTES = 16 * 1024;

interface ShimPathFingerprint {
  dev: number;
  ino: number;
  kind: "file" | "symlink";
  mode: number;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
  target?: Omit<ShimPathFingerprint, "target">;
}

interface StableShimPathProbe {
  fingerprint: ShimPathFingerprint;
  prefix: string;
}

function readShimProbePrefix(path: string): string {
  const fd = openSync(path, "r");
  try {
    const buffer = Buffer.allocUnsafe(CODEX_SHIM_PROBE_BYTES);
    const bytesRead = readSync(fd, buffer, 0, buffer.length, 0);
    return buffer.toString("utf8", 0, bytesRead);
  } finally {
    closeSync(fd);
  }
}

function statFingerprint(path: string, follow: boolean): Omit<ShimPathFingerprint, "target"> | null {
  try {
    const stat = follow ? statSync(path) : lstatSync(path);
    if (follow ? !stat.isFile() : (!stat.isFile() && !stat.isSymbolicLink())) return null;
    return {
      dev: stat.dev,
      ino: stat.ino,
      kind: stat.isSymbolicLink() ? "symlink" : "file",
      mode: stat.mode,
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      ctimeMs: stat.ctimeMs,
    };
  } catch {
    return null;
  }
}

function sameFingerprint(
  left: ShimPathFingerprint | Omit<ShimPathFingerprint, "target">,
  right: ShimPathFingerprint | Omit<ShimPathFingerprint, "target">,
): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.kind === right.kind
    && left.mode === right.mode
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs
    && (!("target" in left) || !("target" in right)
      ? true
      : left.target === undefined && right.target === undefined
        ? true
        : left.target !== undefined && right.target !== undefined
          ? sameFingerprint(left.target, right.target)
          : false);
}

function sameFingerprintAfterRename(left: ShimPathFingerprint, right: ShimPathFingerprint): boolean {
  // rename changes the outer directory entry ctime on macOS; every other field,
  // including a symlink target fingerprint, must remain identical.
  return sameFingerprint({ ...left, ctimeMs: 0 }, { ...right, ctimeMs: 0 });
}

function stableShimPathProbe(path: string): StableShimPathProbe | null {
  const before = statFingerprint(path, false);
  if (!before) return null;
  const targetBefore = before.kind === "symlink" ? statFingerprint(path, true) : undefined;
  if (before.kind === "symlink" && !targetBefore) return null;
  let prefix: string;
  try {
    prefix = readShimProbePrefix(path);
  } catch {
    return null;
  }
  const targetAfter = before.kind === "symlink" ? statFingerprint(path, true) : undefined;
  const after = statFingerprint(path, false);
  if (!after || !sameFingerprint(before, after)) return null;
  if (before.kind === "symlink") {
    if (!targetBefore || !targetAfter || !sameFingerprint(targetBefore, targetAfter)) return null;
  }
  const fingerprint: ShimPathFingerprint = {
    ...before,
    ...(targetBefore ? { target: targetBefore } : {}),
  };
  const contentSize = fingerprint.target?.size ?? fingerprint.size;
  return contentSize > 0 ? { fingerprint, prefix } : null;
}

function sameStableShimPathProbe(left: StableShimPathProbe, right: StableShimPathProbe): boolean {
  return left.prefix === right.prefix && sameFingerprint(left.fingerprint, right.fingerprint);
}

/**
 * Identity of whatever sits at `path`, read from metadata alone.
 *
 * `stableShimPathProbe` answers a different question: it reads content to decide
 * whether a launcher looks like a healthy shim, and it deliberately returns null
 * for a zero-byte file. That makes it the wrong instrument for rollback
 * bookkeeping. A user can legitimately own an empty `codex` launcher, and a fresh
 * install moves it aside before writing our wrapper; if the move is recorded
 * without a fingerprint, rollback cannot prove the backup is still the file it
 * set aside and refuses to restore it — the launcher stays lost (#1625).
 *
 * Content is irrelevant to that proof, so this reads dev/ino/mode/size/times and
 * re-reads them to reject a path that changed under us, following a symlink to
 * fingerprint its target as well.
 */
function shimPathFingerprint(path: string): ShimPathFingerprint | null {
  const before = statFingerprint(path, false);
  if (!before) return null;
  if (before.kind !== "symlink") {
    const after = statFingerprint(path, false);
    return after && sameFingerprint(before, after) ? before : null;
  }
  const targetBefore = statFingerprint(path, true);
  if (!targetBefore) return null;
  const targetAfter = statFingerprint(path, true);
  const after = statFingerprint(path, false);
  if (!targetAfter || !after
    || !sameFingerprint(targetBefore, targetAfter)
    || !sameFingerprint(before, after)) return null;
  return { ...before, target: targetBefore };
}

/**
 * Move `from` onto `to` without ever replacing an existing entry.
 *
 * `renameSync` silently clobbers the destination on POSIX, which is wrong for a
 * rollback restore: `sourceOccupied` is sampled before the fingerprint check, so
 * a concurrent installer can publish its own launcher at the original path in
 * between, and the restore would delete it. `link` fails EEXIST instead, which
 * is the no-replace primitive we need and needs no native helper.
 *
 * `link` follows a symlink to its target rather than preserving the link, so a
 * symlink launcher is republished with `symlink`, which is also no-replace: it
 * fails EEXIST on an occupied destination. Checking existence and then renaming
 * would reintroduce exactly the race this function exists to close.
 */
function restoreWithoutReplacing(from: string, to: string): void {
  const source = lstatSync(from);
  if (source.isSymbolicLink()) {
    symlinkSync(readlinkSync(from), to);
    unlinkSync(from);
    return;
  }
  linkSync(from, to);
  unlinkSync(from);
}

function isHealthyShimProbe(probe: StableShimPathProbe, platform: NodeJS.Platform): boolean {
  if (probe.prefix.length < 180 || !probe.prefix.includes(SHIM_MARKER) || !probe.prefix.includes("ensure")) return false;
  const mode = probe.fingerprint.target?.mode ?? probe.fingerprint.mode;
  return platform === "win32" || (mode & 0o111) !== 0;
}

function isCurrentUnixShimProbe(probe: StableShimPathProbe): boolean {
  return probe.prefix.includes(UNIX_SHIM_REVISION_MARKER);
}

function hasUsableBackingPath(file: ShimFileState): boolean {
  return [existsSync(file.backupPath) ? file.backupPath : undefined, file.realPath]
    .some(path => {
      if (!path) return false;
      const fingerprint = statFingerprint(path, true);
      return fingerprint !== null && fingerprint.size > 0;
    });
}

/**
 * True when a Codex binary lives inside a version manager's install tree.
 *
 * These trees are rewritten in place on upgrade, which destroys both the shim
 * and the sibling .opencodex-real backup it restores from (#2412). The tempting
 * repair — adopt the newly installed binary as a fresh original — is wrong
 * twice: it records a provenance that never happened, and the next upgrade wipes
 * it again, so the repair silently un-repairs on the version manager's schedule.
 *
 * Scope is the three managers named in the report. nvm/fnm/npm-prefix are
 * deliberately excluded: a false positive here refuses a restore that would
 * otherwise be correct.
 */
export function isVersionManagerOwnedCodexPath(
  path: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  const normalized = (platform === "win32"
    ? win32.normalize(path).replace(/\\/g, "/")
    : posix.normalize(path)).toLowerCase();
  return normalized.includes("/mise/installs/")
    || normalized.includes("/mise/shims/")
    || normalized.includes("/.asdf/installs/")
    || normalized.includes("/.asdf/shims/")
    || normalized.includes("/.volta/");
}

export type { ShimPathFingerprint, StableShimPathProbe };
export { statFingerprint, sameFingerprint, sameFingerprintAfterRename, stableShimPathProbe, sameStableShimPathProbe, shimPathFingerprint, restoreWithoutReplacing, isHealthyShimProbe, isCurrentUnixShimProbe, hasUsableBackingPath };
