import {
  chmodSync,
  closeSync,
  constants,
  copyFileSync,
  existsSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  opendirSync,
  readFileSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { join } from "node:path";
import { getConfigDir } from "../config";
import { forgetEphemeralSecretPath, forgetHardenedSecretPath, hardenSecretDir, hardenSecretPath } from "../lib/windows-secret-acl";
import { isValidProviderContinuationOwner } from "./provider-continuation";
import type { OcxProviderContinuationState } from "../types";

export const RESPONSE_SPILL_VERSION = 1;
export const RESPONSE_SPILL_DIR_NAME = "responses-state-spill";
export const RESPONSE_SPILL_ORPHAN_GRACE_MS = 15 * 60_000;
export const RESPONSE_SPILL_SCAN_MAX = 4_096;
export const RESPONSE_SPILL_CLEANUP_MAX = 512;

const RESPONSE_SPILL_PUBLISH_RETRIES = 64;
const OWNED_SPILL_NAME = /^([A-Za-z0-9._-]{1,80})\.([0-9a-f]{12})\.([0-9a-f]{24})\.(\d+)\.(\d+)\.spill\.json$/;
const OWNED_SPILL_TEMP_NAME = /^\.response-spill\.[0-9]+\.[0-9a-f]{16}\.tmp$/;

export interface ResponseSpillPayload {
  version: 1;
  responseId: string;
  createdAt: number;
  clientThreadId?: string;
  items: unknown[];
  /**
   * Index in `items` where the provider output begins, used by replay-overlap detection
   * in state.ts. Optional so a payload written before this field still loads (it simply
   * never authorizes a skip).
   *
   * Compatibility is FORWARD-ONLY: `validPayload` is a strict key allowlist, so a build
   * predating this field rejects a payload carrying it as corrupt rather than ignoring
   * it. Rolling back across this change invalidates spilled entries, which degrades to a
   * replay miss — an already-handled path — not to corrupted live state.
   */
  providerOutputStart?: number;
  providers?: OcxProviderContinuationState;
}

export interface ResponseSpillRef {
  version: 1;
  fileName: string;
  digest: string;
  payloadBytes: number;
}

/**
 * Hard ceiling for one spill payload, enforced BOTH at direct-spill admission
 * (state.ts refuses to durably retain a larger candidate) and at replay read
 * (below). 256 MiB keeps the replay transient under the process-wide
 * APP_OWNED_WORST_CASE_PINNED_BYTES ceiling (512 MiB); without an admission
 * ceiling the read ceiling would strand write-only spills on disk.
 */
export const MAX_RESPONSE_SPILL_PAYLOAD_BYTES = 256 * 1024 * 1024;

let spillPayloadCapOverride: number | null = null;

/** Test-only: lower/restore the single-spill payload ceiling (null restores). */
export function setResponseSpillPayloadCapForTests(bytes: number | null): void {
  spillPayloadCapOverride = bytes;
}

export function responseSpillPayloadCap(): number {
  return spillPayloadCapOverride ?? MAX_RESPONSE_SPILL_PAYLOAD_BYTES;
}

export type ResponseSpillReadResult =
  | { ok: true; payload: ResponseSpillPayload }
  | { ok: false; reason: "missing" | "corrupt" | "too_large" };

export interface ResponseSpillCleanupResult {
  scanned: number;
  removed: number;
  failed: number;
  bytesRemoved: number;
}

export interface ResponseSpillIoForTest {
  write?: (fd: number, bytes: Uint8Array) => void;
  fsync?: (fd: number) => void;
  /** Directory-handle fsync seam for `fsyncDirectoryBestEffort` only. */
  fsyncDir?: (fd: number) => void;
  /** Directory-handle open seam for `fsyncDirectoryBestEffort` only. */
  openDir?: (dir: string) => number;
  /** Directory-handle close seam for `fsyncDirectoryBestEffort` only. */
  closeDir?: (fd: number) => void;
  link?: (tempPath: string, destinationPath: string) => void;
  copyFileExcl?: (tempPath: string, destinationPath: string) => void;
  unlink?: (path: string) => void;
  /** Orphan-GC enumeration seam: returns the next directory entry NAME or
   *  null for end-of-directory. Lets tests prove the scan cap binds without
   *  materializing thousands of real files. */
  readdirEntry?: () => string | null;
  record?: (event: "write" | "fsync" | "close" | "harden" | "publish" | "dir-fsync" | "stub-swap") => void;
}

let spillIoForTest: ResponseSpillIoForTest | null = null;
let spillGeneration = 0;

export function setSpillIoForTest(io: ResponseSpillIoForTest | null): void {
  spillIoForTest = io;
}

function record(event: "write" | "fsync" | "close" | "harden" | "publish" | "dir-fsync" | "stub-swap"): void {
  spillIoForTest?.record?.(event);
}

function fsyncDirectoryBestEffort(dir: string): void {
  let fd: number | null = null;
  // Record the durability attempt before opening the directory: Windows cannot
  // open/fsync directory handles this way, but callers still cross this seam.
  record("dir-fsync");
  try {
    fd = spillIoForTest?.openDir ? spillIoForTest.openDir(dir) : openSync(dir, "r");
    try {
      if (spillIoForTest?.fsyncDir) spillIoForTest.fsyncDir(fd);
      else if (spillIoForTest?.fsync) spillIoForTest.fsync(fd);
      else fsyncSync(fd);
    } catch {
      // Windows and some filesystems do not support fsync on directory handles.
    }
  } catch {
    // Directory missing or unreadable — nothing further to sync.
  } finally {
    if (fd !== null) {
      try {
        if (spillIoForTest?.closeDir) spillIoForTest.closeDir(fd);
        else closeSync(fd);
      } catch { /* best effort */ }
    }
  }
}

export function noteStubSwapForTest(): void {
  record("stub-swap");
}

export function responseSpillDirectory(dir = getConfigDir()): string {
  return join(dir, RESPONSE_SPILL_DIR_NAME);
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function sanitizeResponseId(responseId: string): string {
  const visible = responseId
    .normalize("NFC")
    .replace(/[^A-Za-z0-9._-]/g, "_")
    .replace(/_+/g, "_")
    .slice(0, 80);
  return visible || "response";
}

function isErrno(error: unknown, code: string): boolean {
  return !!error && typeof error === "object" && (error as NodeJS.ErrnoException).code === code;
}

function canUseExclusiveCopyFallback(error: unknown): boolean {
  return process.platform === "win32" || ["EPERM", "EACCES", "ENOSYS", "ENOTSUP", "EOPNOTSUPP", "EXDEV"]
    .some(code => isErrno(error, code));
}

function harden(path: string, mode: number): void {
  try {
    chmodSync(path, mode);
  } catch {
    if (process.platform !== "win32") throw new Error("Response spill permission hardening failed");
  }
  if (process.platform === "win32") {
    const result = mode === 0o700
      ? hardenSecretDir(path, { required: true })
      : hardenSecretPath(path, { required: true });
    if (!result.ok) throw new Error("Response spill permission hardening failed");
  }
}

function writeAll(fd: number, bytes: Uint8Array): void {
  if (spillIoForTest?.write) spillIoForTest.write(fd, bytes);
  else {
    let offset = 0;
    while (offset < bytes.byteLength) offset += writeSync(fd, bytes, offset, bytes.byteLength - offset);
  }
  record("write");
}

function fsyncFile(fd: number): void {
  if (spillIoForTest?.fsync) spillIoForTest.fsync(fd);
  else fsyncSync(fd);
  record("fsync");
}

function closeFile(fd: number): void {
  closeSync(fd);
  record("close");
}

function unlink(path: string, ephemeral = false): void {
  try {
    if (spillIoForTest?.unlink) spillIoForTest.unlink(path);
    else unlinkSync(path);
    // Ephemeral release only for publish temps; stable spill files keep their
    // destination-keyed timeout memos (anti-restall) and drop just the
    // success memo for the now-deleted file.
    if (ephemeral) forgetEphemeralSecretPath(path);
    else forgetHardenedSecretPath(path);
  } catch (error) {
    if (isErrno(error, "ENOENT")) {
      if (ephemeral) forgetEphemeralSecretPath(path);
      else forgetHardenedSecretPath(path);
    }
    throw error;
  }
}

function unlinkEphemeral(path: string): void {
  unlink(path, true);
}

function publishNoReplace(tempPath: string, destinationPath: string): void {
  try {
    if (spillIoForTest?.link) spillIoForTest.link(tempPath, destinationPath);
    else linkSync(tempPath, destinationPath);
  } catch (error) {
    if (isErrno(error, "EEXIST")) throw error;
    if (!canUseExclusiveCopyFallback(error)) throw error;
    let copied = false;
    try {
      if (spillIoForTest?.copyFileExcl) spillIoForTest.copyFileExcl(tempPath, destinationPath);
      else copyFileSync(tempPath, destinationPath, constants.COPYFILE_EXCL);
      copied = true;
      harden(destinationPath, 0o600);
      const copyFd = openSync(destinationPath, "r");
      try {
        if (spillIoForTest?.fsync) spillIoForTest.fsync(copyFd);
        else fsyncSync(copyFd);
      } finally {
        closeSync(copyFd);
      }
    } catch (copyError) {
      if (copied) {
        try { unlink(destinationPath); } catch { /* startup GC reclaims an incomplete publication */ }
      }
      throw copyError;
    }
  }
  record("publish");
}

function validSpillRef(ref: ResponseSpillRef): boolean {
  return ref.version === 1
    && OWNED_SPILL_NAME.test(ref.fileName)
    && /^[0-9a-f]{64}$/.test(ref.digest)
    && Number.isSafeInteger(ref.payloadBytes)
    && ref.payloadBytes >= 0;
}

function validPayload(value: unknown, responseId: string): value is ResponseSpillPayload {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const payload = value as Record<string, unknown>;
  const keys = Object.keys(payload);
  if (keys.some(key => !["version", "responseId", "createdAt", "clientThreadId", "items", "providerOutputStart", "providers"].includes(key))) return false;
  if (payload.version !== 1 || payload.responseId !== responseId) return false;
  if (typeof payload.createdAt !== "number" || !Number.isFinite(payload.createdAt)) return false;
  if (payload.clientThreadId !== undefined
    && (typeof payload.clientThreadId !== "string" || payload.clientThreadId.trim().length === 0)) return false;
  if (!Array.isArray(payload.items)) return false;
  // A malformed boundary must degrade to "never skip", never to a bad index: reject the
  // payload outright so materialization treats it as corrupt rather than trusting it.
  if (payload.providerOutputStart !== undefined) {
    const anchor = payload.providerOutputStart;
    if (typeof anchor !== "number" || !Number.isSafeInteger(anchor)
      || anchor < 0 || anchor > payload.items.length) return false;
  }
  if (payload.providers !== undefined) {
    if (!payload.providers || typeof payload.providers !== "object" || Array.isArray(payload.providers)) return false;
    const providers = payload.providers as Record<string, unknown>;
    if (providers.__ocxOwner !== undefined
      && !isValidProviderContinuationOwner(providers.__ocxOwner)) return false;
    for (const [provider, providerState] of Object.entries(providers)) {
      if (provider === "__ocxOwner") continue;
      if (!providerState || typeof providerState !== "object" || Array.isArray(providerState)) return false;
    }
  }
  return true;
}

export function writeResponseSpillDurably(
  responseId: string,
  state: Omit<ResponseSpillPayload, "version" | "responseId">,
): ResponseSpillRef {
  let tempPath: string | null = null;
  let fd: number | null = null;
  try {
    const payload: ResponseSpillPayload = {
      version: 1,
      responseId,
      createdAt: state.createdAt,
      ...(state.clientThreadId ? { clientThreadId: state.clientThreadId } : {}),
      items: state.items,
      ...(state.providerOutputStart !== undefined ? { providerOutputStart: state.providerOutputStart } : {}),
      ...(state.providers ? { providers: state.providers } : {}),
    };
    const serialized = JSON.stringify(payload);
    if (serialized === undefined) throw new Error("Response spill serialization failed");
    const bytes = Buffer.from(serialized, "utf8");
    const digest = sha256(bytes);
    const idDigest = sha256(responseId).slice(0, 12);
    const contentDigest = digest.slice(0, 24);
    const dir = responseSpillDirectory();
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    harden(dir, 0o700);

    tempPath = join(dir, `.response-spill.${process.pid}.${randomBytes(8).toString("hex")}.tmp`);
    fd = openSync(tempPath, "wx", 0o600);
    writeAll(fd, bytes);
    fsyncFile(fd);
    closeFile(fd);
    fd = null;
    harden(tempPath, 0o600);
    record("harden");
    const publishTempPath = tempPath;

    for (let attempt = 0; attempt < RESPONSE_SPILL_PUBLISH_RETRIES; attempt++) {
      spillGeneration += 1;
      const fileName = `${sanitizeResponseId(responseId)}.${idDigest}.${contentDigest}.${spillGeneration}.${bytes.byteLength}.spill.json`;
      if (!OWNED_SPILL_NAME.test(fileName)) throw new Error("Response spill name allocation failed");
      const destinationPath = join(dir, fileName);
      try {
        publishNoReplace(publishTempPath, destinationPath);
        fsyncDirectoryBestEffort(dir);
        unlinkEphemeral(publishTempPath);
        tempPath = null;
        return { version: 1, fileName, digest, payloadBytes: bytes.byteLength };
      } catch (error) {
        if (isErrno(error, "EEXIST")) continue;
        throw error;
      }
    }
    throw new Error("Response spill publication retries exhausted");
  } catch {
    if (fd !== null) {
      try { closeSync(fd); } catch { /* best effort */ }
    }
    if (tempPath) {
      try { unlinkEphemeral(tempPath); } catch { /* best effort */ }
    }
    throw new Error("Response spill write failed");
  }
}

export function readResponseSpill(responseId: string, ref: ResponseSpillRef): ResponseSpillReadResult {
  if (!validSpillRef(ref)) return { ok: false, reason: "corrupt" };
  // Refuse before any read/parse: an oversized declared payload would otherwise
  // materialize an unbounded transient (readFileSync + utf8 + JSON.parse).
  if (ref.payloadBytes > responseSpillPayloadCap()) return { ok: false, reason: "too_large" };
  const match = OWNED_SPILL_NAME.exec(ref.fileName);
  if (!match
    || match[2] !== sha256(responseId).slice(0, 12)
    || match[3] !== ref.digest.slice(0, 24)
    || !Number.isSafeInteger(Number(match[4]))
    || Number(match[4]) <= 0
    || Number(match[5]) !== ref.payloadBytes) return { ok: false, reason: "corrupt" };
  const path = join(responseSpillDirectory(), ref.fileName);
  let bytes: Buffer;
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink()) return { ok: false, reason: "corrupt" };
    if (stat.size !== ref.payloadBytes) return { ok: false, reason: "corrupt" };
    bytes = readFileSync(path);
  } catch (error) {
    return { ok: false, reason: isErrno(error, "ENOENT") ? "missing" : "corrupt" };
  }
  if (bytes.byteLength !== ref.payloadBytes || sha256(bytes) !== ref.digest) return { ok: false, reason: "corrupt" };
  try {
    const payload = JSON.parse(bytes.toString("utf8")) as unknown;
    return validPayload(payload, responseId) ? { ok: true, payload } : { ok: false, reason: "corrupt" };
  } catch {
    return { ok: false, reason: "corrupt" };
  }
}

export function deleteResponseSpill(ref: ResponseSpillRef): void {
  if (!validSpillRef(ref)) return;
  const dir = responseSpillDirectory();
  try {
    unlink(join(dir, ref.fileName));
    fsyncDirectoryBestEffort(dir);
  } catch { /* best effort */ }
}

export function recoverOrphanedResponseSpills(
  referencedFileNames: ReadonlySet<string>,
  dir = responseSpillDirectory(),
  opts?: { graceMs?: number },
): ResponseSpillCleanupResult {
  const result: ResponseSpillCleanupResult = { scanned: 0, removed: 0, failed: 0, bytesRemoved: 0 };
  const graceMs = opts?.graceMs ?? RESPONSE_SPILL_ORPHAN_GRACE_MS;
  // ONE loop serves both the real directory handle and the injected test seam
  // (review C2-2: two duplicated loops let the test prove only its own copy).
  // The reader is called strictly AFTER the scan-cap check, so entry
  // SCAN_MAX+1 is never requested from either source.
  let handle: ReturnType<typeof opendirSync> | null = null;
  const injected = spillIoForTest?.readdirEntry;
  if (!injected) {
    try { handle = opendirSync(dir); } catch { return result; }
  }
  const nextName = (): string | null => {
    if (injected) return injected();
    const entry = handle!.readSync();
    return entry ? entry.name : null;
  };
  try {
    while (result.scanned < RESPONSE_SPILL_SCAN_MAX) {
      const name = nextName();
      if (name === null) break;
      result.scanned += 1;
      if (result.removed + result.failed >= RESPONSE_SPILL_CLEANUP_MAX) break;
      const spillMatch = OWNED_SPILL_NAME.exec(name);
      const isOwnedTemp = OWNED_SPILL_TEMP_NAME.test(name);
      if ((!spillMatch && !isOwnedTemp) || referencedFileNames.has(name)) continue;
      const path = join(dir, name);
      let stat: ReturnType<typeof lstatSync>;
      try { stat = lstatSync(path); } catch { continue; }
      if (!stat.isFile() || stat.isSymbolicLink() || Date.now() - stat.mtimeMs < graceMs) continue;
      try {
        // Orphaned publish temps get the full ephemeral release; stable
        // orphaned spills keep destination-keyed timeout memos.
        if (isOwnedTemp) unlinkEphemeral(path);
        else unlink(path);
        result.removed += 1;
        result.bytesRemoved += stat.size;
      } catch {
        result.failed += 1;
      }
    }
  } finally {
    try { handle?.closeSync(); } catch { /* best effort */ }
  }
  return result;
}

export function responseSpillExistsForTests(ref: ResponseSpillRef): boolean {
  return validSpillRef(ref) && existsSync(join(responseSpillDirectory(), ref.fileName));
}
