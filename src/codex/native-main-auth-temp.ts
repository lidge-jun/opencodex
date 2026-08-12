import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  fsyncSync,
  ftruncateSync,
  lstatSync,
  openSync,
  readdirSync,
  realpathSync,
  unlinkSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";

import type { NativeProfileContext } from "./native-profile-store";
import { NativeProfileError } from "./native-profile-types";

const AUTH_TEMP_NAME = /^auth\.json\.ocx\.[1-9]\d*\.[1-9]\d*\.tmp$/;
const MAX_AUTH_TEMP_RESIDUES = 128;

interface PathIdentity {
  readonly dev: bigint;
  readonly ino: bigint;
}

export interface NativeMainAuthTempScrubTestSeam {
  /** Test-only race seam. Production never supplies this callback. */
  beforeOpen?: (path: string) => void;
  /** Test-only removal-failure seam. Production never supplies this callback. */
  beforeUnlink?: (path: string) => void;
}

export interface NativeMainAuthTempScrubResult {
  scrubbed: number;
}

function cleanupRequired(): NativeProfileError {
  return new NativeProfileError(
    "AUTH_TEMP_CLEANUP_REQUIRED",
    "A native-main credential write residue could not be safely removed; manual cleanup is required.",
    500,
    false,
    true,
  );
}

function errorCode(error: unknown): string | undefined {
  return error && typeof error === "object" && "code" in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}

function sameIdentity(stats: { dev: bigint; ino: bigint }, expected: PathIdentity): boolean {
  return stats.dev === expected.dev && stats.ino === expected.ino;
}

function samePath(left: string, right: string): boolean {
  return resolve(left) === resolve(right);
}

function inspectCanonicalParent(path: string, expected?: PathIdentity): PathIdentity {
  const absolute = resolve(path);
  const entry = lstatSync(absolute, { bigint: true });
  if (!entry.isDirectory() || entry.isSymbolicLink()) throw cleanupRequired();
  const canonical = realpathSync.native(absolute);
  if (!samePath(canonical, absolute)) throw cleanupRequired();
  if (expected && !sameIdentity(entry, expected)) throw cleanupRequired();
  return { dev: entry.dev, ino: entry.ino };
}

function inspectExactPath(path: string, parent: string, expected?: PathIdentity): PathIdentity {
  const absolute = resolve(path);
  if (!samePath(dirname(absolute), parent)) throw cleanupRequired();
  const entry = lstatSync(absolute, { bigint: true });
  if (!entry.isFile() || entry.isSymbolicLink() || entry.nlink !== 1n) throw cleanupRequired();
  const canonical = realpathSync.native(absolute);
  if (!samePath(canonical, absolute) || !samePath(dirname(canonical), parent)) throw cleanupRequired();
  if (expected && !sameIdentity(entry, expected)) throw cleanupRequired();
  return { dev: entry.dev, ino: entry.ino };
}

function exactResidues(parent: string, parentIdentity: PathIdentity): string[] {
  inspectCanonicalParent(parent, parentIdentity);
  const names = readdirSync(parent).filter(name => AUTH_TEMP_NAME.test(name)).sort();
  inspectCanonicalParent(parent, parentIdentity);
  if (names.length > MAX_AUTH_TEMP_RESIDUES) throw cleanupRequired();
  return names;
}

function assertOpenIdentity(
  fd: number,
  path: string,
  parent: string,
  parentIdentity: PathIdentity,
  expected: PathIdentity,
  expectedLinks: bigint,
): void {
  inspectCanonicalParent(parent, parentIdentity);
  const opened = fstatSync(fd, { bigint: true });
  if (
    !opened.isFile()
    || !sameIdentity(opened, expected)
    || opened.nlink !== expectedLinks
  ) throw cleanupRequired();
  inspectExactPath(path, parent, expected);
  inspectCanonicalParent(parent, parentIdentity);
}

function scrubOne(
  path: string,
  parent: string,
  parentIdentity: PathIdentity,
  seam: NativeMainAuthTempScrubTestSeam,
): void {
  const observed = inspectExactPath(path, parent);
  inspectCanonicalParent(parent, parentIdentity);
  seam.beforeOpen?.(path);

  const flags = process.platform === "win32"
    ? fsConstants.O_RDWR
    : fsConstants.O_RDWR | fsConstants.O_NOFOLLOW;
  let fd: number | undefined;
  let failed = false;
  try {
    fd = openSync(path, flags);
    assertOpenIdentity(fd, path, parent, parentIdentity, observed, 1n);

    ftruncateSync(fd, 0);
    fsyncSync(fd);
    const truncated = fstatSync(fd, { bigint: true });
    if (!sameIdentity(truncated, observed) || truncated.nlink !== 1n || truncated.size !== 0n) {
      throw cleanupRequired();
    }
    assertOpenIdentity(fd, path, parent, parentIdentity, observed, 1n);
    seam.beforeUnlink?.(path);

    // The lifetime owner and exclusive claim exclude cooperative OpenCodex writers.
    // A malicious process running as the same OS user can still race Node's final
    // identity-check/unlink gap and is intentionally outside this trusted-owner boundary.
    unlinkSync(path);
    const unlinked = fstatSync(fd, { bigint: true });
    if (!sameIdentity(unlinked, observed) || unlinked.nlink !== 0n || unlinked.size !== 0n) {
      throw cleanupRequired();
    }
    try {
      lstatSync(path);
      throw cleanupRequired();
    } catch (error) {
      if (error instanceof NativeProfileError) throw error;
      if (errorCode(error) !== "ENOENT") throw error;
    }
    inspectCanonicalParent(parent, parentIdentity);
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); }
      catch (error) { if (!failed) throw error; }
    }
  }
}

/**
 * Remove only crash residues created by atomicWriteFileAsync for canonical auth.json.
 * The caller must hold the lifetime native-main owner and exclusive credential claim.
 */
export function scrubNativeMainAuthTempResidues(
  context: NativeProfileContext,
  seam: NativeMainAuthTempScrubTestSeam = {},
): NativeMainAuthTempScrubResult {
  try {
    const parent = resolve(context.codexHome);
    const parentIdentity = inspectCanonicalParent(parent);
    const names = exactResidues(parent, parentIdentity);
    for (const name of names) {
      scrubOne(join(parent, name), parent, parentIdentity, seam);
    }
    // A cooperative writer cannot create a new residue while the owner and
    // exclusive claim are held. Seeing one now is ambiguous, so admission stays closed.
    if (exactResidues(parent, parentIdentity).length !== 0) throw cleanupRequired();
    return { scrubbed: names.length };
  } catch (error) {
    if (error instanceof NativeProfileError) throw error;
    throw cleanupRequired();
  }
}
