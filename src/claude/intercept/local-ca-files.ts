import { randomBytes } from "node:crypto";
import { closeSync, constants, fchmodSync, fstatSync, lstatSync, mkdirSync, openSync, readSync, renameSync, unlinkSync, writeFileSync, type BigIntStats } from "node:fs";
import { basename, dirname, join } from "node:path";
import { withClientLifecycleSync } from "../../client/lifecycle-lock";
import { forgetEphemeralSecretPath, hardenSecretDir, hardenSecretPath, windowsSecretAclApplies } from "../../lib/windows-secret-acl";
import { assertLocalCaWindowsAcl } from "./local-ca-windows";

const NOFOLLOW = constants.O_NOFOLLOW ?? 0;
const NONBLOCK = constants.O_NONBLOCK ?? 0;
const MAX_PEM_BYTES = 64 * 1024;
const KEY = "ca.key";
const CERT = "ca.pem";
type FileMode = 0o600 | 0o644;
type FileHooks = { beforeRead?: (path: string) => void; beforeWrite?: (path: string) => void; beforePublish?: (path: string) => void };
let hooks: FileHooks = {};
/** Boundary fault injection for substitution and zero-secret-write assertions. */
export function setLocalCaFileHooksForTests(next: FileHooks | null): void { hooks = next ?? {}; }

function unsafe(): Error {
  return Object.assign(new Error("Local CA requires safe owner-controlled files and directory"), { code: "local_ca_path_unsafe" });
}
function missing(error: unknown): boolean { return (error as NodeJS.ErrnoException)?.code === "ENOENT"; }
function owned(stat: BigIntStats, directory = false, mode: FileMode = 0o600): void {
  if (stat.isSymbolicLink() || !(directory ? stat.isDirectory() : stat.isFile() && stat.nlink === 1n)) throw unsafe();
  if (!windowsSecretAclApplies()) {
    if (typeof process.geteuid !== "function" || stat.uid !== BigInt(process.geteuid())) throw unsafe();
    const forbidden = directory || mode === 0o600 ? 0o077 : 0o022;
    if ((Number(stat.mode) & forbidden) !== 0) throw unsafe();
  }
}
function same(path: string, expected: BigIntStats, directory = false, mode: FileMode = 0o600): void {
  const stat = lstatSync(path, { bigint: true });
  owned(stat, directory, mode);
  if (stat.dev !== expected.dev || stat.ino !== expected.ino || stat.ino === 0n) throw unsafe();
}
function inspect(path: string, mode: FileMode, sqliteSidecar = false): BigIntStats | null {
  let stat: BigIntStats;
  try { stat = lstatSync(path, { bigint: true }); } catch (error) { if (missing(error)) return null; throw error; }
  owned(stat, false, mode);
  if (windowsSecretAclApplies()) assertLocalCaWindowsAcl(path, sqliteSidecar ? "inherited" : "private");
  same(path, stat, false, mode);
  return stat;
}

function protectNew(path: string, fd: number, mode: FileMode): void {
  const created = fstatSync(fd, { bigint: true });
  owned(created, false, mode);
  if (windowsSecretAclApplies()) {
    // Owner inspection precedes ACL mutation; inherited grants on a new EMPTY file
    // are removed by the existing hardener before the strict inspection and write.
    assertLocalCaWindowsAcl(path, "owner");
    hardenSecretPath(path, { required: true });
    assertLocalCaWindowsAcl(path);
  } else fchmodSync(fd, mode);
  same(path, created, false, mode);
}

function readPinned(path: string, expected: BigIntStats, mode: FileMode, assertDirectory: () => void): string {
  hooks.beforeRead?.(path);
  assertDirectory();
  same(path, expected, false, mode);
  const fd = openSync(path, constants.O_RDONLY | NOFOLLOW | NONBLOCK);
  try {
    const opened = fstatSync(fd, { bigint: true });
    owned(opened, false, mode);
    if (opened.dev !== expected.dev || opened.ino !== expected.ino || opened.size > BigInt(MAX_PEM_BYTES)) throw unsafe();
    if (windowsSecretAclApplies()) assertLocalCaWindowsAcl(path);
    same(path, opened, false, mode);
    const bytes = Buffer.alloc(MAX_PEM_BYTES + 1);
    let length = 0;
    while (length < bytes.length) {
      const count = readSync(fd, bytes, length, bytes.length - length, length);
      if (!count) break;
      length += count;
    }
    const after = fstatSync(fd, { bigint: true });
    owned(after, false, mode);
    if (length > MAX_PEM_BYTES || BigInt(length) !== after.size || after.mtimeNs !== opened.mtimeNs || after.ctimeNs !== opened.ctimeNs) throw unsafe();
    same(path, opened, false, mode);
    assertDirectory();
    return bytes.subarray(0, length).toString("utf8");
  } finally { closeSync(fd); }
}

export interface LocalCaFiles {
  readPair(): { certPem: string; keyPem: string } | null;
  writePair(pair: { certPem: string; keyPem: string }): void;
}

function stage(path: string, contents: string, mode: FileMode, assertDirectory: () => void): { publish(): void; dispose(): void } {
  assertDirectory();
  const previous = inspect(path, mode);
  const temp = join(dirname(path), `.${basename(path)}.${process.pid}.${randomBytes(16).toString("hex")}.tmp`);
  const fd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW | NONBLOCK, mode);
  let created: BigIntStats;
  try { created = fstatSync(fd, { bigint: true }); }
  catch (error) { closeSync(fd); throw error; }
  let closed = false;
  let removed = false;
  const dispose = (): void => {
    if (!closed) { closed = true; closeSync(fd); }
    if (removed) return;
    try { same(temp, created, false, mode); unlinkSync(temp); removed = true; }
    catch (error) { if (missing(error)) removed = true; else throw error; }
    if (removed) forgetEphemeralSecretPath(temp);
  };
  try {
    protectNew(temp, fd, mode);
    assertDirectory();
    hooks.beforeWrite?.(temp);
    same(temp, created, false, mode);
    assertDirectory();
    if (windowsSecretAclApplies()) assertLocalCaWindowsAcl(temp);
    writeFileSync(fd, contents, { encoding: "utf8" });
    same(temp, created, false, mode);
    return {
      publish() {
        hooks.beforePublish?.(path);
        assertDirectory();
        same(temp, created, false, mode);
        if (windowsSecretAclApplies()) assertLocalCaWindowsAcl(temp);
        const current = inspect(path, mode);
        if (previous ? !current || previous.dev !== current.dev || previous.ino !== current.ino : current !== null) throw unsafe();
        renameSync(temp, path);
        removed = true;
        forgetEphemeralSecretPath(temp);
        same(path, created, false, mode);
        assertDirectory();
      },
      dispose,
    };
  } catch (error) {
    try { dispose(); } catch { /* preserve safety failure; never remove a substituted path */ }
    throw error;
  }
}

/** Guard every CA entry before SQLite or PEM access. The directory and lock stay pinned. */
export function withLocalCaPublication<T>(dir: string, lockName: string, work: (files: LocalCaFiles) => T): T {
  if (basename(lockName) !== lockName || [KEY, CERT, ".", ".."].includes(lockName)) throw unsafe();
  mkdirSync(dirname(dir), { recursive: true, mode: 0o700 });
  let created = false;
  try { mkdirSync(dir, { mode: 0o700 }); created = true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  const directory = lstatSync(dir, { bigint: true });
  owned(directory, true);
  const dirFd = windowsSecretAclApplies() ? null : openSync(dir, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | NOFOLLOW);
  let lockFd: number | undefined;
  try {
    if (dirFd !== null) {
      const opened = fstatSync(dirFd, { bigint: true });
      if (opened.dev !== directory.dev || opened.ino !== directory.ino) throw unsafe();
      owned(opened, true);
    } else {
      assertLocalCaWindowsAcl(dir, created ? "owner" : "private");
      hardenSecretDir(dir, { required: true });
      assertLocalCaWindowsAcl(dir);
    }
    const assertDirectory = (): void => { same(dir, directory, true); };
    assertDirectory();
    const lockPath = join(dir, lockName);
    const assertEntries = (): void => {
      assertDirectory();
      inspect(join(dir, KEY), 0o600);
      inspect(join(dir, CERT), 0o644);
      inspect(lockPath, 0o600);
      // SQLite creates sidecars itself, inheriting only the protected directory's
      // current-user ACE. Inspect every grant and owner; an inherited DACL is valid here.
      for (const suffix of ["-journal", "-wal", "-shm"]) inspect(`${lockPath}${suffix}`, 0o600, true);
      assertDirectory();
    };
    assertEntries();
    try {
      lockFd = openSync(lockPath, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | NOFOLLOW | NONBLOCK, 0o600);
      protectNew(lockPath, lockFd, 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const existing = inspect(lockPath, 0o600);
      if (!existing) throw unsafe();
      lockFd = openSync(lockPath, constants.O_RDONLY | NOFOLLOW | NONBLOCK);
      const opened = fstatSync(lockFd, { bigint: true });
      owned(opened);
      if (opened.dev !== existing.dev || opened.ino !== existing.ino) throw unsafe();
    }
    const lock = fstatSync(lockFd, { bigint: true });
    assertEntries();
    same(lockPath, lock);
    return withClientLifecycleSync(() => {
      same(lockPath, lock);
      assertEntries();
      const files: LocalCaFiles = {
        readPair() {
          assertEntries();
          const cert = inspect(join(dir, CERT), 0o644);
          const key = inspect(join(dir, KEY), 0o600);
          if (!cert || !key) return null;
          return { certPem: readPinned(join(dir, CERT), cert, 0o644, assertDirectory), keyPem: readPinned(join(dir, KEY), key, 0o600, assertDirectory) };
        },
        writePair(pair) {
          assertEntries();
          const key = stage(join(dir, KEY), pair.keyPem, 0o600, assertDirectory);
          let cert: ReturnType<typeof stage> | undefined;
          try {
            cert = stage(join(dir, CERT), pair.certPem, 0o644, assertDirectory);
            assertEntries();
            key.publish();
            cert.publish();
          } finally { try { key.dispose(); } finally { cert?.dispose(); } }
        },
      };
      const value = work(files);
      same(lockPath, lock);
      assertEntries();
      return value;
    }, { lockPath });
  } finally { try { if (lockFd !== undefined) closeSync(lockFd); } finally { if (dirFd !== null) closeSync(dirFd); } }
}
