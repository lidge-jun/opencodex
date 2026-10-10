import { constants, closeSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readSync,
  realpathSync, renameSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { assertNotRealHomeUnderTest } from "../lib/test-home-guard";
import { remoteError, REMOTE_LIMITS } from "./remote-contract";

/** Check the entire path ancestry before using the private messaging subtree. */
export function checkRemoteDirectory(path: string): void {
  if (!["linux", "darwin"].includes(process.platform) || !isAbsolute(path)) {
    throw remoteError("unsupported_platform", "Remote messaging requires a private Linux or macOS configuration home.");
  }
  try {
    const final = lstatSync(path);
    if (!final.isDirectory() || final.isSymbolicLink() || final.uid !== process.getuid!() || (final.mode & 0o077)) throw new Error();
    // Root-controlled OS aliases (/tmp and /var on macOS) are not user-controlled redirects.
    for (let entry = path; ; entry = dirname(entry)) {
      const stat = lstatSync(entry);
      if (stat.isSymbolicLink()) { if (stat.uid !== 0) throw new Error(); }
      else if (!stat.isDirectory() || (stat.uid !== process.getuid!() && stat.uid !== 0)
        || ((stat.mode & 0o022) !== 0 && !(stat.uid === 0 && (stat.mode & 0o1000) !== 0))
        || (entry === path && (stat.uid !== process.getuid!() || (stat.mode & 0o077) !== 0))) throw new Error();
      if (entry === "/") break;
    }
    for (let entry = realpathSync(path); ; entry = dirname(entry)) {
      const stat = lstatSync(entry);
      if (!stat.isDirectory() || (stat.uid !== process.getuid!() && stat.uid !== 0)
        || ((stat.mode & 0o022) && !(stat.uid === 0 && (stat.mode & 0o1000)))) throw new Error();
      if (entry === "/") break;
    }
  } catch { throw remoteError("unsafe_remote_storage", "Messaging storage requires private owned directories and trusted ancestors."); }
}
/** ENOENT alone means absent; permission failures and redirects are not empty state. */
export function remotePathExists(path: string): boolean {
  try { lstatSync(path); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}
/** Create only explicitly requested state, refusing an unsafe existing configuration home. */
export function createRemoteDirectory(path: string): void {
  assertNotRealHomeUnderTest(path);
  const parent = dirname(path);
  if (!remotePathExists(parent)) {
    if (!remotePathExists(dirname(parent))) throw remoteError("unsafe_remote_storage", "Messaging configuration parent must already exist.");
    mkdirSync(parent, { mode: 0o700 });
  }
  checkRemoteDirectory(parent);
  if (!remotePathExists(path)) mkdirSync(path, { mode: 0o700 });
  checkRemoteDirectory(path);
}
/** Bounded, fatal-UTF-8, no-follow regular file reads never open SQLite or create absent state. */
export function readRemoteFile(path: string): string | null {
  if (!remotePathExists(dirname(path))) return null;
  checkRemoteDirectory(dirname(path));
  let fd: number;
  try { fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw remoteError("unsafe_remote_storage", "Cannot safely read messaging state.");
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid!() || (stat.mode & 0o077)
      || stat.size > REMOTE_LIMITS.storeBytes) throw new Error();
    const bytes = Buffer.alloc(REMOTE_LIMITS.storeBytes + 1);
    let size = 0;
    while (size < bytes.length) { const count = readSync(fd, bytes, size, bytes.length - size, size); if (!count) break; size += count; }
    if (size > REMOTE_LIMITS.storeBytes) throw new Error();
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, size));
  } catch { throw remoteError("unsafe_remote_storage", "Messaging state is unsafe, oversized or malformed."); }
  finally { closeSync(fd); }
}
/** Publish a private file atomically; this primitive is called while its store lock is owned. */
export function writeRemoteFile(path: string, text: string): void {
  assertNotRealHomeUnderTest(path);
  checkRemoteDirectory(dirname(path));
  if (Buffer.byteLength(text) > REMOTE_LIMITS.storeBytes) throw remoteError("remote_capacity", "Messaging state exceeds its byte limit.");
  readRemoteFile(path);
  const temporary = join(dirname(path), `.write-${crypto.randomUUID()}`);
  const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    try { writeFileSync(fd, text, "utf8"); fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(temporary, path);
  } finally { if (remotePathExists(temporary)) unlinkSync(temporary); }
}
/** Serialize cooperating mutations. Crash residue fails closed; it is never reaped by age. */
export function withRemoteLock<T>(directory: string, action: () => T): T {
  const lock = join(directory, "mutation.lock");
  try { mkdirSync(lock, { mode: 0o700 }); }
  catch { throw remoteError("remote_state_busy", "Messaging state is locked; finish or recover its owning mutation first."); }
  const identity = lstatSync(lock);
  try { return action(); }
  finally {
    const current = lstatSync(lock);
    if (current.dev === identity.dev && current.ino === identity.ino) rmdirSync(lock);
  }
}
