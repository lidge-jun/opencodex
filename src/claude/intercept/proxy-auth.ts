import { randomBytes } from "node:crypto";
import {
  closeSync, constants, fchmodSync, fstatSync, linkSync, lstatSync, mkdirSync,
  openSync, readSync, unlinkSync, writeFileSync, type Stats,
} from "node:fs";
import { join } from "node:path";
import { forgetEphemeralSecretPath, hardenSecretDir, hardenSecretPath } from "../../lib/windows-secret-acl";

const TOKEN_FILE = "proxy-token";
const TOKEN_LENGTH = 43; // 32 random bytes encoded as unpadded base64url.
const TOKEN_MAX_BYTES = TOKEN_LENGTH + 2; // Optional LF or CRLF, never arbitrary whitespace.
const NOFOLLOW = constants.O_NOFOLLOW ?? 0;
const NONBLOCK = constants.O_NONBLOCK ?? 0;

export function claudeInterceptProxyTokenPath(configDir: string): string {
  return join(configDir, "claude-intercept", TOKEN_FILE);
}

function invalidCredential(): Error {
  return new Error("Claude intercept credential is not a safe, valid owner-controlled file");
}

function assertOwnedNode(stat: Stats, directory = false): void {
  if (stat.isSymbolicLink() || !(directory ? stat.isDirectory() : stat.isFile())) throw invalidCredential();
  if (process.platform !== "win32" && typeof process.geteuid === "function" && stat.uid !== process.geteuid()) {
    throw invalidCredential();
  }
}

function assertSameNode(path: string, expected: Stats, directory = false): void {
  const current = lstatSync(path);
  assertOwnedNode(current, directory);
  if (current.dev !== expected.dev || current.ino !== expected.ino) throw invalidCredential();
}

/** Read only through the validated descriptor, with a fixed maximum allocation and no links. */
function readPinnedToken(configDir: string, harden: boolean): string {
  const dir = join(configDir, "claude-intercept");
  const directory = lstatSync(dir);
  assertOwnedNode(directory, true);
  if (process.platform !== "win32" && (directory.mode & 0o077) !== 0) throw invalidCredential();
  const path = claudeInterceptProxyTokenPath(configDir);
  const entry = lstatSync(path);
  assertOwnedNode(entry);
  if (entry.size < TOKEN_LENGTH || entry.size > TOKEN_MAX_BYTES) throw invalidCredential();
  // NONBLOCK prevents a raced-in FIFO from blocking before fstat can reject it.
  const fd = openSync(path, constants.O_RDONLY | NOFOLLOW | NONBLOCK);
  try {
    const opened = fstatSync(fd);
    assertOwnedNode(opened);
    if (opened.dev !== entry.dev || opened.ino !== entry.ino
      || opened.size < TOKEN_LENGTH || opened.size > TOKEN_MAX_BYTES) throw invalidCredential();
    const bytes = Buffer.alloc(TOKEN_MAX_BYTES + 1);
    let length = 0;
    while (length < bytes.length) {
      const count = readSync(fd, bytes, length, bytes.length - length, length);
      if (count === 0) break;
      length += count;
    }
    const contents = bytes.subarray(0, length).toString("utf8");
    const token = contents.slice(0, TOKEN_LENGTH);
    const ending = contents.slice(TOKEN_LENGTH);
    if (token.length !== TOKEN_LENGTH || !/^[A-Za-z0-9_-]+$/.test(token)
      || !["", "\n", "\r\n"].includes(ending)) throw invalidCredential();
    const afterRead = fstatSync(fd);
    if (length !== afterRead.size || afterRead.mtimeMs !== opened.mtimeMs) throw invalidCredential();
    assertSameNode(path, opened);
    assertSameNode(dir, directory, true);
    if (harden) {
      if (process.platform === "win32") hardenSecretPath(path, { required: true });
      else fchmodSync(fd, 0o600); // Never chmod a followed/replaced pathname.
      assertSameNode(path, opened);
      assertSameNode(dir, directory, true);
    } else if (process.platform !== "win32" && (afterRead.mode & 0o077) !== 0) {
      throw invalidCredential();
    }
    return token;
  } finally {
    closeSync(fd);
  }
}

/** The current usable credential, or null. Inspection and CONNECT admission never create one. */
export function readClaudeInterceptProxyToken(configDir: string): string | null {
  try {
    return readPinnedToken(configDir, false);
  } catch { // no-excuse-ok: catch -- unusable credentials fail closed without exposing filesystem or token details.
    return null;
  }
}

function ensurePrivateDirectory(configDir: string): Stats {
  const dir = join(configDir, "claude-intercept");
  mkdirSync(configDir, { recursive: true, mode: 0o700 });
  try {
    mkdirSync(dir, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const entry = lstatSync(dir);
  assertOwnedNode(entry, true);
  if (process.platform === "win32") {
    hardenSecretDir(dir, { required: true });
  } else {
    const fd = openSync(dir, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | NOFOLLOW);
    try {
      const opened = fstatSync(fd);
      assertOwnedNode(opened, true);
      if (entry.dev !== opened.dev || entry.ino !== opened.ino) throw invalidCredential();
      fchmodSync(fd, 0o700);
    } finally {
      closeSync(fd);
    }
  }
  assertSameNode(dir, entry, true);
  return entry;
}

/** Create once without replacing a winner, invalid file, symlink, or other existing entry. */
export function ensureClaudeInterceptProxyToken(configDir: string): string {
  const dir = join(configDir, "claude-intercept");
  const directory = ensurePrivateDirectory(configDir);
  try {
    return readPinnedToken(configDir, true);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  assertSameNode(dir, directory, true);
  const path = claudeInterceptProxyTokenPath(configDir);
  const token = randomBytes(32).toString("base64url");
  const temp = join(dir, `.${TOKEN_FILE}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`);
  const fd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW, 0o600);
  const created = fstatSync(fd);
  try {
    writeFileSync(fd, `${token}\n`, { encoding: "utf8" });
    if (process.platform !== "win32") fchmodSync(fd, 0o600);
    else hardenSecretPath(temp, { required: true, timeoutMemoKey: path });
    assertSameNode(temp, created);
    assertSameNode(dir, directory, true);
    try {
      linkSync(temp, path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      // A concurrent winner is validated below. No rename/overwrite fallback is safe here.
    }
    return readPinnedToken(configDir, true);
  } finally {
    // Cleanup cannot turn a committed credential into a failed apply or hide the
    // original publication error. Do not retry close: its fd may already be reused.
    let cleanupFailed = false;
    try { closeSync(fd); } catch { cleanupFailed = true; }
    let removed = false;
    try {
      assertSameNode(temp, created);
      unlinkSync(temp);
      removed = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") removed = true;
      else cleanupFailed = true;
    }
    if (removed) forgetEphemeralSecretPath(temp);
    if (cleanupFailed) {
      console.warn("[claude] Credential temporary cleanup incomplete; review retained temporary state.");
    }
  }
}
