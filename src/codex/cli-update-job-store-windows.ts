/**
 * Windows backend for the Codex CLI update job ledger.
 *
 * Parallel contract to the POSIX primitives in cli-update-job.ts, mapped onto NTFS
 * handle semantics instead of uid/mode/O_NOFOLLOW:
 *
 * - Ancestry: the volume root is opened through its GUID mount path and pinned
 *   as the trust anchor; its own ACL is not part of the batch — the held handle,
 *   not a policy verdict, is what anchors the chain. Every directory below it
 *   down to the config parent is opened handle-relative from the already-held
 *   parent (never a re-parsed path), held with FILE_SHARE_READ|FILE_SHARE_WRITE
 *   so nothing can rename or delete it while held, and refused on any reparse
 *   attribute. Each of those directories has its ACL read once per phase through
 *   the shared PowerShell protocol under the "trusted-ancestry" policy: the
 *   owner must be the serving token or a kernel-equivalent owner
 *   (SYSTEM, Administrators, TrustedInstaller — each can already take ownership
 *   of any object, so an ACL entry grants them nothing they lack), and no other
 *   grantee may hold write, create-inside, delete or DACL/owner control. Broad
 *   create-only grants are accepted only on admin-owned ancestors, which is the
 *   NTFS analog of a root-owned sticky directory: the stock C:\ ACL grants
 *   Authenticated Users add-subdirectory and nothing else.
 * - The config root's parent must be owned by the serving token and grant no
 *   untrusted write access ("write-private", the POSIX mode&022==0 analog). A
 *   pre-existing config root is verified only — never rehardened — under the
 *   same policy. A config root or store directory created by this call is
 *   icacls-hardened and then held to the strict "private" rule.
 * - The store directory and every ledger file must satisfy strict "private":
 *   a protected DACL owned by the serving token with grantees limited to the
 *   user plus SYSTEM/Administrators — the same shape the POSIX 0700/0600 modes
 *   express.
 * - File identity is the NTFS volume serial + 128-bit file ID (the dev:ino
 *   analog), with NumberOfLinks == 1 and DeletePending clear, mirroring the
 *   POSIX nlink and lstat-vs-fstat checks.
 * - Writes go through a private temp file: exclusive create, harden, fsync,
 *   identity+ACL+byte verify, handle-bound rename, then identity/ACL/byte
 *   readback on the renamed object and a directory flush. The temp handle
 *   denies foreign write/delete opens, so the object renamed is provably the
 *   one written — and the destination is never opened deny-delete, which would
 *   otherwise block the rename itself.
 * - The admission lock is a mkdir mutex like POSIX: EEXIST maps to
 *   job_store_busy with no reclamation. owner.json is written under the held
 *   lock pin; release deletes the owner file and lock directory only through
 *   the pins whose identity and content still match what this call created,
 *   so a replacement is never removed by this process and a leftover lock
 *   blocks later admission, exactly like POSIX.
 *
 * Honesty notes: pins bind each object to its verified state for the length of
 * the operation and the private DACL restricts writers to the trusted set; that
 * is the strongest binding Windows affords, but it is not a proof against
 * concurrent mutation by the serving account or an elevated process, which sit
 * inside the trust boundary exactly as on POSIX. Each mutation step is bracketed
 * by a fresh identity observation or ACL read rather than claimed TOCTOU-free.
 * x64 only: the FFI layouts below are the x64 ABI. Cross-account (other-SID)
 * behavior is unverified: the DACL policy is the enforcement claim, not an
 * empirical cross-user proof.
 */
import { createHash, randomUUID } from "node:crypto";
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, join, resolve, toNamespacedPath } from "node:path";
import type { Library, Symbols } from "bun:ffi";
import * as recoveryFfi from "bun:ffi";
import { getConfigDir } from "../config/paths";
import { assertNotRealHomeUnderTest } from "../lib/test-home-guard";
import { forgetEphemeralSecretPath, hardenSecretDir, hardenSecretPath, hardenSecretDirAsync, hardenSecretPathAsync } from "../lib/windows-secret-acl";
import { verifyWindowsEntriesAcl, verifyWindowsEntriesAclAsync, type WindowsAclEntry } from "../lib/windows-owner-acl";
import { retryWindowsFileOperation } from "../lib/windows-atomic-replace";
import {
  CODEX_CLI_JOB_STORE_DIR, CODEX_CLI_JOB_STORE_FILE, CODEX_CLI_JOB_STORE_LOCK,
  CODEX_CLI_JOB_STORE_MAX_BYTES, CodexCliJobStoreBusyError,
} from "./cli-update-job-execution";
import { windowsCanonicalPathMatches } from "./windows-installation-files";

const KERNEL_SYMBOLS = {
  GetDriveTypeW: { args: ["ptr"], returns: "u32" },
  GetVolumeNameForVolumeMountPointW: { args: ["ptr", "ptr", "u32"], returns: "i32" },
  CreateFileW: { args: ["ptr", "u32", "u32", "ptr", "u32", "u32", "u64"], returns: "u64" },
  GetFileInformationByHandleEx: { args: ["u64", "i32", "ptr", "u32"], returns: "i32" },
  SetFileInformationByHandle: { args: ["u64", "i32", "ptr", "u32"], returns: "i32" },
  GetFileType: { args: ["u64"], returns: "u32" },
  GetFinalPathNameByHandleW: { args: ["u64", "ptr", "u32", "u32"], returns: "u32" },
  ReadFile: { args: ["u64", "ptr", "u32", "ptr", "ptr"], returns: "i32" },
  SetFilePointerEx: { args: ["u64", "i64", "ptr", "u32"], returns: "i32" },
  FlushFileBuffers: { args: ["u64"], returns: "i32" },
  CloseHandle: { args: ["u64"], returns: "i32" },
} as const satisfies Symbols;
const NT_SYMBOLS = {
  NtCreateFile: { args: ["ptr", "u32", "ptr", "ptr", "ptr", "u32", "u32", "u32", "u32", "ptr", "u32"], returns: "i32" },
} as const satisfies Symbols;

const REPARSE = 0x400;
const DIRECTORY_ATTR = 0x10;
const INVALID_HANDLE = 0xffffffffffffffffn;
/** Directory pins deny delete (and therefore rename) but allow read/write opens. */
const SHARE_DIR = 0x3; // FILE_SHARE_READ | FILE_SHARE_WRITE
/** Ledger-file pins deny write and delete opens; only reads are shared. */
const SHARE_LEAF = 0x1; // FILE_SHARE_READ
/** Read-verify opens must also permit a held delete-capable sibling pin to coexist. */
const SHARE_LEAF_VERIFY = 0x5; // FILE_SHARE_READ | FILE_SHARE_DELETE
// SYNCHRONIZE | FILE_READ_ATTRIBUTES | FILE_READ_DATA — ancestors and read-only anchors.
const ACCESS_READ = 0x100081;
// SYNCHRONIZE | READ_CONTROL | DELETE | FILE_WRITE_ATTRIBUTES | FILE_READ_ATTRIBUTES
//   | FILE_DELETE_CHILD | FILE_ADD_SUBDIRECTORY | FILE_ADD_FILE | FILE_LIST_DIRECTORY
// Owned directories we may flush or remove; the DACL we verified grants them anyway.
const ACCESS_DIR_WRITE = 0x100000 | 0x20000 | 0x10000 | 0x100 | 0x80 | 0x40 | 0x4 | 0x2 | 0x1;
// The store directory pin needs the same write side minus DELETE: it is flushed and
// used as a rename root but is never itself deleted. Holding DELETE would force every
// coexisting opener (e.g., a concurrent status reader) to offer share-delete.
const ACCESS_DIR_PIN = ACCESS_DIR_WRITE & ~0x10000;
// SYNCHRONIZE | READ_CONTROL | DELETE | FILE_READ_ATTRIBUTES | FILE_READ_DATA — ledger
// files held for read/verify/disposition-delete.
const ACCESS_LEAF = 0x130081;
const ACL_VERIFY_TIMEOUT_MS = 5_000;
const FILE_OPEN = 1;
// FILE_OPEN_REPARSE_POINT | FILE_SYNCHRONOUS_IO_NONALERT, plus the object-kind bit.
const DIR_OPTIONS = 0x200020 | 0x1;
const FILE_OPTIONS = 0x200020 | 0x40;

interface StoreIdentity { readonly volumeSerial: string; readonly fileId: string }
interface StoreInspection extends StoreIdentity {
  readonly size: number;
  readonly links: number;
  readonly deletePending: boolean;
}

interface Native {
  ffi: typeof import("bun:ffi");
  kernel: Library<typeof KERNEL_SYMBOLS>;
  nt: Library<typeof NT_SYMBOLS>;
}

let nativePromise: Promise<Native> | undefined;
function loadNative(): Promise<Native> {
  if (process.platform !== "win32" || process.arch !== "x64") {
    return Promise.reject(new Error("unsupported_store"));
  }
  nativePromise ??= (async () => {
    const ffi = await import("bun:ffi");
    return { ffi, kernel: ffi.dlopen("kernel32.dll", KERNEL_SYMBOLS), nt: ffi.dlopen("ntdll.dll", NT_SYMBOLS) };
  })().catch(() => { nativePromise = undefined; throw new Error("unsupported_store"); });
  return nativePromise;
}

const unsafe = (): Error => new Error("unsafe_store");
const enoent = (): NodeJS.ErrnoException => Object.assign(new Error("ENOENT"), { code: "ENOENT" });

// General ledger callers retain their existing best-effort close contract.
class PinSet {
  private readonly handles: bigint[] = [];
  keep(handle: bigint): bigint { this.handles.push(handle); return handle; }
  release(handle: bigint, kernel: Library<typeof KERNEL_SYMBOLS>): void {
    const index = this.handles.lastIndexOf(handle);
    if (index >= 0) this.handles.splice(index, 1);
    kernel.symbols.CloseHandle(handle);
  }
  closeAll(kernel: Library<typeof KERNEL_SYMBOLS>): void {
    for (const handle of this.handles.splice(0).reverse()) kernel.symbols.CloseHandle(handle);
  }
}

/** Strict disposal is scoped to apply authority, not ordinary ledger/status I/O. */
export class WindowsApplyAuthorityPins extends PinSet {
  private readonly authorityHandles: bigint[] = [];
  private readonly failedCloses = new Set<bigint>();
  get remaining(): number { return this.authorityHandles.length; }
  override keep(handle: bigint): bigint { this.authorityHandles.push(handle); return handle; }
  override release(handle: bigint, kernel: Library<typeof KERNEL_SYMBOLS>): boolean {
    const index = this.authorityHandles.lastIndexOf(handle);
    if (index < 0) return true; // Already released; never close a reused native handle.
    try {
      if (!kernel.symbols.CloseHandle(handle)) { this.failedCloses.add(handle); return false; }
    } catch { this.failedCloses.add(handle); return false; }
    this.authorityHandles.splice(index, 1);
    this.failedCloses.delete(handle);
    return true;
  }
  override closeAll(kernel: Library<typeof KERNEL_SYMBOLS>): void {
    // One attempt per disposal. A failed explicit release must not be retried
    // invisibly by a later finally/closeAll in the same ownership lifecycle.
    for (const handle of [...this.authorityHandles].reverse()) {
      if (!this.failedCloses.has(handle)) this.release(handle, kernel);
    }
  }
}

/** Internal acquisition root; never serialized into job/HTTP DTOs. */
export class WindowsApplyAcquisition {
  constructor(readonly resources: object, private readonly pins: WindowsApplyAuthorityPins) {}
  releaseIfClean(token?: { release(): void }): boolean {
    if (this.pins.remaining !== 0) return false;
    token?.release();
    return true;
  }
}

export class WindowsCliToolchainCleanupError extends Error {
  constructor(readonly acquisition: WindowsApplyAcquisition) { super("toolchain_cleanup_unverified"); }
}
// Failed native closes remain strongly owned even when acquisition rejects.
const retainedToolchains = new Set<WindowsApplyAcquisition>();

interface Prepared {
  readonly config: string;
  readonly dir: string;
  readonly file: string;
  readonly lock: string;
  /** Write-access handle on the store directory; anchors leaf opens and the rename flush. */
  readonly jobdir: bigint;
}

function components(path: string): { drive: string; names: string[] } | null {
  if (typeof path !== "string" || path.length > 8192 || !/^[A-Za-z]:[\\/]/.test(path)) return null;
  const names = path.slice(3).split(/[\\/]/);
  if (!names.length || names.length > 64 || names.some(name => !name || name === "." || name === ".."
    || /[\x00-\x1f<>:"|?*]/.test(name) || /[. ]$/.test(name)
    || /^(?:con|prn|aux|nul|com[1-9\xb9\xb2\xb3]|lpt[1-9\xb9\xb2\xb3])(?:\.|$)/i.test(name))) return null;
  return { drive: path.slice(0, 2).toUpperCase() + "\\", names };
}

interface Ctx {
  readonly ffi: typeof import("bun:ffi");
  readonly kernel: Library<typeof KERNEL_SYMBOLS>;
  readonly nt: Library<typeof NT_SYMBOLS>;
  readonly pins: PinSet;
}

const wide = (text: string): Buffer => Buffer.from(text + "\0", "utf16le");
// OBJECT_ATTRIBUTES contains unmanaged pointers to UNICODE_STRING and its text.
// Root every backing buffer through NtCreateFile, including across GC/JIT pressure.
const activeRelativeOpenBuffers = new Set<Buffer>();

function keep(ctx: Ctx, handle: bigint): bigint {
  if (handle === 0n || handle === INVALID_HANDLE) throw unsafe();
  return ctx.pins.keep(handle);
}

function info(ctx: Ctx, handle: bigint, infoClass: number, length: number): Buffer {
  const buffer = Buffer.alloc(length);
  if (!ctx.kernel.symbols.GetFileInformationByHandleEx!(handle, infoClass, ctx.ffi.ptr(buffer), length)) {
    throw unsafe();
  }
  return buffer;
}

/** Full identity/type observation for one held handle; kind is asserted by the caller. */
function inspect(ctx: Ctx, handle: bigint, directory: boolean): StoreInspection {
  if (ctx.kernel.symbols.GetFileType!(handle) !== 1) throw unsafe(); // FILE_TYPE_DISK
  const basic = info(ctx, handle, 0, 40); // FILE_BASIC_INFO: 4 LARGE_INTEGERs, attributes.
  const attributes = basic.readUInt32LE(32);
  if (attributes & REPARSE) throw unsafe();
  if (Boolean(attributes & DIRECTORY_ATTR) !== directory) throw unsafe();
  const id = info(ctx, handle, 18, 24); // FILE_ID_INFO: volume serial and 128-bit file ID.
  const standard = info(ctx, handle, 1, 24); // FILE_STANDARD_INFO.
  const size = standard.readBigInt64LE(8);
  if (size < 0n || size > BigInt(Number.MAX_SAFE_INTEGER)) throw unsafe();
  if (standard.readUInt8(20) !== 0) throw unsafe(); // DeletePending is one byte; offset 21 is Directory.
  return { volumeSerial: id.readBigUInt64LE(0).toString(16), fileId: id.subarray(8, 24).toString("hex"),
    size: Number(size), links: standard.readUInt32LE(16), deletePending: false };
}

function sameIdentity(a: StoreIdentity, b: StoreIdentity): boolean {
  return a.volumeSerial === b.volumeSerial && a.fileId === b.fileId;
}

function assertCanonicalPath(ctx: Ctx, handle: bigint, path: string): void {
  const output = Buffer.alloc(32768 * 2);
  const length = ctx.kernel.symbols.GetFinalPathNameByHandleW!(handle, ctx.ffi.ptr(output), 32768, 0);
  if (!length || length >= 32768
    || !windowsCanonicalPathMatches(path, output.toString("utf16le", 0, length * 2))) throw unsafe();
}

/** Handle-relative open of one component below an already-pinned parent. */
function relOpen(
  ctx: Ctx,
  parent: bigint,
  component: string,
  directory: boolean,
  access: number,
  share: number,
): bigint {
  const name = wide(component);
  const unicode = Buffer.alloc(16);
  const attributes = Buffer.alloc(48);
  const output = Buffer.alloc(8);
  const status = Buffer.alloc(16);
  const borrowed = [name, unicode, attributes, output, status];
  for (const buffer of borrowed) activeRelativeOpenBuffers.add(buffer);
  try {
  unicode.writeUInt16LE(name.length - 2, 0);
  unicode.writeUInt16LE(name.length, 2);
  unicode.writeBigUInt64LE(BigInt(ctx.ffi.ptr(name)), 8);
  attributes.writeUInt32LE(48, 0);
  attributes.writeBigUInt64LE(parent, 8);
  attributes.writeBigUInt64LE(BigInt(ctx.ffi.ptr(unicode)), 16);
  attributes.writeUInt32LE(0x40, 24); // OBJ_CASE_INSENSITIVE; one component only.
  const result = ctx.nt.symbols.NtCreateFile!(ctx.ffi.ptr(output), access, ctx.ffi.ptr(attributes),
    ctx.ffi.ptr(status), null, 0, share, FILE_OPEN, directory ? DIR_OPTIONS : FILE_OPTIONS, null, 0);
  if (result < 0) {
    const status32 = result >>> 0;
    if (status32 === 0xc0000034 || status32 === 0xc000003a) throw enoent(); // object/path not found
    throw new Error("unsafe_store", { cause: { nativeStatus: status32 } });
  }
  const handle = keep(ctx, output.readBigUInt64LE(0));
  return handle;
  } finally { for (const buffer of borrowed) activeRelativeOpenBuffers.delete(buffer); }
}

/** Volume root via the strict GUID mount path; remote or absent volumes refuse. */
function openVolumeRoot(ctx: Ctx, drive: string): bigint {
  const mount = wide(drive);
  const name = Buffer.alloc(100 * 2);
  if (![2, 3, 5, 6].includes(Number(ctx.kernel.symbols.GetDriveTypeW!(ctx.ffi.ptr(mount))))) {
    throw unsafe();
  }
  if (!ctx.kernel.symbols.GetVolumeNameForVolumeMountPointW!(ctx.ffi.ptr(mount), ctx.ffi.ptr(name), 100)) {
    throw unsafe();
  }
  const guid = name.toString("utf16le").split("\0", 1)[0]!;
  if (!/^\\\\\?\\Volume\{[0-9a-f-]{36}\}\\$/i.test(guid)) throw unsafe();
  const path = wide(guid);
  const handle = keep(ctx, BigInt(ctx.kernel.symbols.CreateFileW!(ctx.ffi.ptr(path), ACCESS_READ,
    SHARE_DIR, null, 3, 0x02200000, 0n)));
  inspect(ctx, handle, true);
  return handle;
}

/** Read up to limit bytes from a held file handle, then require exact end-of-file. */
function readAll(ctx: Ctx, handle: bigint, limit: number): Buffer {
  // Held pins are re-read across phases — owner.json is re-read at release after
  // the acquire-time read left the position at EOF — so rewind first, or a second
  // readAll on the same handle sees an empty file and fails closed.
  if (!ctx.kernel.symbols.SetFilePointerEx!(handle, 0n, null, 0)) throw unsafe(); // FILE_BEGIN
  const bytes = Buffer.alloc(limit);
  const chunk = Buffer.alloc(Math.min(1024 * 1024, Math.max(1, limit)));
  const read = Buffer.alloc(4);
  let offset = 0;
  while (offset < limit) {
    const length = Math.min(chunk.length, limit - offset);
    if (!ctx.kernel.symbols.ReadFile!(handle, ctx.ffi.ptr(chunk), length, ctx.ffi.ptr(read), null)) {
      throw unsafe();
    }
    const count = read.readUInt32LE(0);
    if (!count || count > length) throw unsafe();
    chunk.copy(bytes, offset, 0, count);
    offset += count;
  }
  // Any byte past the bound means the file changed while held open.
  if (!ctx.kernel.symbols.ReadFile!(handle, ctx.ffi.ptr(chunk), 1, ctx.ffi.ptr(read), null)
    || read.readUInt32LE(0) !== 0) throw unsafe();
  return bytes;
}

function flushDir(ctx: Ctx, handle: bigint): void {
  if (!ctx.kernel.symbols.FlushFileBuffers!(handle)) throw unsafe();
}

/** Mark a held object delete-pending; removal completes when the handle closes. */
function markDelete(ctx: Ctx, handle: bigint): void {
  const d = Buffer.alloc(1);
  d.writeUInt8(1, 0);
  if (!ctx.kernel.symbols.SetFileInformationByHandle!(handle, 4, ctx.ffi.ptr(d), 1)) throw unsafe();
}

/**
 * Rename the held file to an absolute destination. Handle-bound, so the object
 * moved is provably the one verified; the verbatim \?\ path is the fully
 * qualified form the API parses unambiguously. FileNameLength counts the string
 * INCLUDING its terminator — this API reads the NUL inside the counted span,
 * and a shorter count makes it read past the buffer into adjacent memory.
 * ReplaceIfExists matches POSIX rename. A sharing-violation blink (scanner/AV
 * indexing) retries through the shared bounded helper; a foreign deny-delete
 * pin on the destination fails closed.
 */
function renamePinned(ctx: Ctx, handle: bigint, destination: string): void {
  const run = () => {
    const name = wide("\\\\?\\" + destination);
    const buffer = Buffer.alloc(20 + name.length);
    buffer.writeUInt32LE(1, 0); // ReplaceIfExists
    buffer.writeBigUInt64LE(0n, 8); // RootDirectory: NULL means absolute FileName.
    buffer.writeUInt32LE(name.length, 16); // Terminator-inclusive length.
    name.copy(buffer, 20);
    if (!ctx.kernel.symbols.SetFileInformationByHandle!(handle, 3, ctx.ffi.ptr(buffer), buffer.length)) {
      const error = unsafe() as NodeJS.ErrnoException;
      error.code = "EBUSY";
      throw error;
    }
  };
  retryWindowsFileOperation({ run });
}

async function verifyAcl(entries: readonly WindowsAclEntry[]): Promise<void> {
  if (!await verifyWindowsEntriesAclAsync(aclTargets(entries), ACL_VERIFY_TIMEOUT_MS)) throw unsafe();
}

// External ACL tools need extended-length names even though native pins and
// canonical/alias checks continue to use the original normalized long DOS paths.
function aclTargets(entries: readonly WindowsAclEntry[]): WindowsAclEntry[] {
  return entries.map(entry => ({ ...entry, path: toNamespacedPath(entry.path) }));
}

interface ChainEntry {
  readonly path: string;
  readonly handle: bigint;
  readonly inspection: StoreInspection;
}

/**
 * Pin every component of an absolute path, volume root down, each opened relative
 * to the held parent so no checked-then-reopened gap exists. leafAccess applies
 * to the final component; all ancestors are read-pinned deny-delete.
 */
function pinChain(ctx: Ctx, absolutePath: string, leafAccess: number): ChainEntry[] {
  const parsed = components(absolutePath);
  if (!parsed) throw unsafe();
  const chain: ChainEntry[] = [];
  let parent = openVolumeRoot(ctx, parsed.drive);
  let current = parsed.drive;
  for (let index = 0; index < parsed.names.length; index++) {
    const access = index === parsed.names.length - 1 ? leafAccess : ACCESS_READ;
    const handle = relOpen(ctx, parent, parsed.names[index]!, true, access, SHARE_DIR);
    const inspection = inspect(ctx, handle, true);
    current = join(current, parsed.names[index]!);
    assertCanonicalPath(ctx, handle, current);
    chain.push({ path: current, handle, inspection });
    parent = handle;
  }
  return chain;
}

/**
 * Open and trust the ledger tree: trusted ancestry to the config parent, the
 * write-private parent and config root, then the strict-private store directory.
 * Ancestors are verified before anything is created; EEXIST never rehardens —
 * only objects this call creates get hardened, everything else is verify-only.
 * Returns null only for a read flow whose store does not exist yet.
 */
async function prepareStore(
  ctx: Ctx,
  absoluteConfig: string,
  opts: { createJobDir: boolean; createConfigRoot: boolean },
): Promise<Prepared | null> {
  const config = absoluteConfig;
  const dir = join(config, CODEX_CLI_JOB_STORE_DIR);
  const file = join(dir, CODEX_CLI_JOB_STORE_FILE);
  const lock = join(dir, CODEX_CLI_JOB_STORE_LOCK);
  const parentPath = join(config, "..");
  const chain = pinChain(ctx, resolve(parentPath), ACCESS_READ);
  const ancestry: WindowsAclEntry[] = chain.map((entry, index) => ({
    path: entry.path,
    directory: true,
    policy: index === chain.length - 1 ? "write-private" : "trusted-ancestry",
  }));
  // Trust the ancestry before any write, matching the POSIX order.
  await verifyAcl(ancestry);
  const parentPin = chain.at(-1);
  if (!parentPin) throw unsafe();
  const configName = config.slice(parentPath.length + 1);
  let configPin: bigint;
  let configPrivate = false;
  try {
    configPin = relOpen(ctx, parentPin.handle, configName, true, ACCESS_READ, SHARE_DIR);
    inspect(ctx, configPin, true);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT" || !opts.createConfigRoot) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT" && !opts.createJobDir) return null;
      throw error;
    }
    // Only a confirmed apply admission may create one absent config-root level.
    mkdirSync(config);
    configPin = relOpen(ctx, parentPin.handle, configName, true, ACCESS_READ, SHARE_DIR);
    inspect(ctx, configPin, true);
    await hardenSecretDirAsync(toNamespacedPath(config), { required: true });
    configPrivate = true;
  }
  assertCanonicalPath(ctx, configPin, config);
  await verifyAcl([{ path: config, directory: true, policy: configPrivate ? "private" : "write-private" }]);
  const jobdirAccess = opts.createJobDir ? ACCESS_DIR_PIN : ACCESS_READ;
  let jobdir: bigint;
  try {
    jobdir = relOpen(ctx, configPin, CODEX_CLI_JOB_STORE_DIR, true, jobdirAccess, SHARE_DIR);
    inspect(ctx, jobdir, true);
    await verifyAcl([{ path: dir, directory: true, policy: "private" }]);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT" || !opts.createJobDir) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT" && !opts.createJobDir) return null;
      throw error;
    }
    mkdirSync(dir);
    jobdir = relOpen(ctx, configPin, CODEX_CLI_JOB_STORE_DIR, true, jobdirAccess, SHARE_DIR);
    inspect(ctx, jobdir, true);
    await hardenSecretDirAsync(toNamespacedPath(dir), { required: true });
    await verifyAcl([{ path: dir, directory: true, policy: "private" }]);
  }
  return { config, dir, file, lock, jobdir };
}

/** Read the ledger body through a held leaf pin; null when the file is absent. */
async function readStoreBody(ctx: Ctx, prepared: Prepared): Promise<string | null> {
  let leaf: bigint;
  try {
    // Verify-only opens stay read-only: ACCESS_LEAF carries DELETE, which a
    // read-only-shared pin cannot admit; share-delete is offered so a held
    // delete-capable pin (this process or another trusted writer) can coexist.
    leaf = relOpen(ctx, prepared.jobdir, CODEX_CLI_JOB_STORE_FILE, false, ACCESS_READ, SHARE_LEAF_VERIFY);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  try {
    const stat = inspect(ctx, leaf, false);
    if (stat.links !== 1 || stat.size > CODEX_CLI_JOB_STORE_MAX_BYTES) throw unsafe();
    await verifyAcl([{ path: prepared.file, directory: false, policy: "private" }]);
    return readAll(ctx, leaf, stat.size).toString("utf8");
  } finally {
    ctx.pins.release(leaf, ctx.kernel);
  }
}

/**
 * Publish the ledger body through a private temp. The held temp handle binds the
 * verified object through harden, ACL read, byte readback and the rename itself;
 * after the rename a fresh name-open proves the published name resolves to the
 * identical object before the directory is flushed.
 */
async function writeStoreBody(ctx: Ctx, prepared: Prepared, body: string): Promise<void> {
  const bytes = Buffer.byteLength(body);
  if (bytes > CODEX_CLI_JOB_STORE_MAX_BYTES) throw new Error("store_full");
  const tempName = ".jobs-" + randomUUID() + ".tmp";
  const temp = join(prepared.dir, tempName);
  let leaf: bigint | undefined;
  let tempIdentity: StoreIdentity | undefined;
  let publishedName = false;
  try {
    const fd = openSync(temp, "wx", 0o600);
    try { writeFileSync(fd, body); fsyncSync(fd); } finally { closeSync(fd); }
    leaf = relOpen(ctx, prepared.jobdir, tempName, false, ACCESS_LEAF, SHARE_LEAF);
    const stat = inspect(ctx, leaf, false);
    if (stat.links !== 1 || stat.size !== bytes) throw unsafe();
    if (!readAll(ctx, leaf, stat.size).equals(Buffer.from(body))) throw unsafe();
    tempIdentity = stat;
    await hardenSecretPathAsync(toNamespacedPath(temp), { required: true, timeoutMemoKey: prepared.file });
    await verifyAcl([{ path: temp, directory: false, policy: "private" }]);
    renamePinned(ctx, leaf, prepared.file);
    publishedName = true;
    // The held handle now names jobs.json. A fresh name-open proves the published
    // path resolves to the identical object while the original handle is still held.
    let published: bigint | undefined;
    try {
      // The renamed object is still held by `leaf` with share-read: only a
      // read-access reopen can coexist, which is all the identity/byte proof needs.
      published = relOpen(ctx, prepared.jobdir, CODEX_CLI_JOB_STORE_FILE, false,
        ACCESS_READ, SHARE_LEAF_VERIFY);
      const fresh = inspect(ctx, published, false);
      if (!sameIdentity(fresh, stat) || fresh.links !== 1 || fresh.size !== bytes) throw unsafe();
      await verifyAcl([{ path: prepared.file, directory: false, policy: "private" }]);
      if (!readAll(ctx, published, bytes).equals(Buffer.from(body))) throw unsafe();
    } finally {
      if (published !== undefined) ctx.pins.release(published, ctx.kernel);
    }
    flushDir(ctx, prepared.jobdir);
  } finally {
    // A published leaf is jobs.json even if readback/flush subsequently fails.
    // Only the verified unpublished object may be marked for delete-on-close.
    if (!publishedName) {
      try {
        if (leaf !== undefined && tempIdentity !== undefined) {
          if (sameIdentity(inspect(ctx, leaf, false), tempIdentity)) markDelete(ctx, leaf);
        } else if (leaf === undefined) unlinkSync(temp);
      } catch { /* unprovable cleanup stays fail-closed */ }
    }
    forgetEphemeralSecretPath(toNamespacedPath(temp));
    if (leaf !== undefined) ctx.pins.release(leaf, ctx.kernel);
  }
}

interface HeldLock {
  readonly dir: bigint;
  readonly dirIdentity: StoreInspection;
  readonly owner: bigint;
  readonly ownerIdentity: StoreInspection;
  readonly record: string;
  readonly ownerPath: string;
  readonly lockPath: string;
}

/**
 * Prove-and-delete the objects this call created during lock initialization.
 * A held pin IS the created object — its identity cannot change underneath —
 * so a verified pin may be marked delete-pending. An object that never got a
 * proven pin stays behind, which keeps the lock directory occupied and leaves
 * later admission fail-closed, exactly like the POSIX rollback.
 */
function rollbackInitializingLock(
  ctx: Ctx,
  lockDir: bigint,
  lockIdentity: StoreInspection,
  owner: bigint | undefined,
  ownerIdentity: StoreInspection | undefined,
): void {
  try {
    if (owner !== undefined && ownerIdentity !== undefined) {
      try {
        if (sameIdentity(inspect(ctx, owner, false), ownerIdentity)) markDelete(ctx, owner);
      } catch { /* unprovable stays */ }
      ctx.pins.release(owner, ctx.kernel);
    }
    try {
      if (sameIdentity(inspect(ctx, lockDir, true), lockIdentity)) markDelete(ctx, lockDir);
    } catch { /* keep the lock fail-closed */ }
    ctx.pins.release(lockDir, ctx.kernel);
  } catch { /* rollback never masks the original error */ }
}

/**
 * Acquire the admission mutex: mkdir the lock directory, then write owner.json
 * under the held pins. EEXIST means another admission is in flight and maps to
 * job_store_busy; a crashed leftover stays busy forever, like POSIX.
 */
async function acquireLock(ctx: Ctx, prepared: Prepared): Promise<HeldLock> {
  try { mkdirSync(prepared.lock); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new CodexCliJobStoreBusyError();
    throw error;
  }
  const lockDir = relOpen(ctx, prepared.jobdir, prepared.lock.slice(prepared.dir.length + 1), true,
    ACCESS_DIR_WRITE, SHARE_DIR);
  const lockIdentity = inspect(ctx, lockDir, true);
  const ownerPath = join(prepared.lock, "owner.json");
  const record = JSON.stringify({ version: 1, token: randomUUID() });
  const recordBytes = Buffer.byteLength(record);
  let owner: bigint | undefined;
  let ownerIdentity: StoreInspection | undefined;
  try {
    const fd = openSync(ownerPath, "wx", 0o600);
    try { writeFileSync(fd, record); fsyncSync(fd); } finally { closeSync(fd); }
    owner = relOpen(ctx, lockDir, "owner.json", false, ACCESS_LEAF, SHARE_LEAF);
    ownerIdentity = inspect(ctx, owner, false);
    if (ownerIdentity.links !== 1 || ownerIdentity.size !== recordBytes) throw unsafe();
    if (!readAll(ctx, owner, recordBytes).equals(Buffer.from(record))) throw unsafe();
    await hardenSecretDirAsync(toNamespacedPath(prepared.lock), { required: true });
    await hardenSecretPathAsync(toNamespacedPath(ownerPath), { required: true });
    await verifyAcl([
      { path: prepared.lock, directory: true, policy: "private" },
      { path: ownerPath, directory: false, policy: "private" },
    ]);
  } catch (error) {
    rollbackInitializingLock(ctx, lockDir, lockIdentity, owner, ownerIdentity);
    throw error;
  }
  return { dir: lockDir, dirIdentity: lockIdentity, owner,
    ownerIdentity, record, ownerPath, lockPath: prepared.lock };
}

/**
 * Token-fenced release: the owner file is deleted only while its held pin still
 * shows this call's identity and exact content, and the lock directory only
 * while its pin shows this call's identity. A replaced owner or lock survives,
 * which keeps admission fail-closed on the leftover.
 */
function releaseLock(ctx: Ctx, held: HeldLock): void {
  try {
    const now = inspect(ctx, held.owner, false);
    if (sameIdentity(now, held.ownerIdentity) && now.links === 1
      && now.size === Buffer.byteLength(held.record)
      && now.size <= 1024
      && readAll(ctx, held.owner, now.size).equals(Buffer.from(held.record))) {
      markDelete(ctx, held.owner);
    }
  } catch { /* fail closed; a leftover owner keeps the lock alive */ }
  ctx.pins.release(held.owner, ctx.kernel);
  try {
    if (sameIdentity(inspect(ctx, held.dir, true), held.dirIdentity)) markDelete(ctx, held.dir);
  } catch { /* fail closed; a leftover lock blocks later admission */ }
  ctx.pins.release(held.dir, ctx.kernel);
}

export interface WindowsCliRecoveryIo {
  readonly dir: string;
  names(): string[];
  read(name: string): string;
  withProofHandle<T>(name: string, run: (handle: bigint) => T): T;
  write(name: string, pendingName: string, body: string): void;
}
/** The shared recovery protocol uses the ledger's native ancestry, no-reparse,
 * identity, private-DACL and rename primitives at synchronous gate boundaries.
 * Only this process's exact token may replace its bounded pending publication.
 */
export function withWindowsCliRecoveryStore<T>(config: string, create: boolean, run: (io: WindowsCliRecoveryIo) => T): T {
  if (process.platform !== "win32" || process.arch !== "x64") throw unsafe();
  assertNotRealHomeUnderTest(config);
  const kernel = recoveryFfi.dlopen("kernel32.dll", KERNEL_SYMBOLS);
  const nt = recoveryFfi.dlopen("ntdll.dll", NT_SYMBOLS);
  const ctx: Ctx = { ffi: recoveryFfi, kernel, nt, pins: new PinSet() };
  const verify = (entries: readonly WindowsAclEntry[]) => {
    if (!verifyWindowsEntriesAcl(aclTargets(entries), ACL_VERIFY_TIMEOUT_MS)) throw unsafe();
  };
  try {
    const chain = pinChain(ctx, config, ACCESS_DIR_PIN);
    verify(chain.map((entry, i) => ({ path: entry.path, directory: true,
      policy: i >= chain.length - 2 ? "write-private" : "trusted-ancestry" })));
    const configPin = chain.at(-1);
    if (!configPin) throw unsafe();
    const dir = join(config, "codex-cli-update-recovery");
    try {
      if (create) { mkdirSync(dir); hardenSecretDir(toNamespacedPath(dir), { required: true }); }
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    const directoryPin = relOpen(ctx, configPin.handle, "codex-cli-update-recovery", true,
      create ? ACCESS_DIR_PIN : ACCESS_READ, SHARE_DIR);
    inspect(ctx, directoryPin, true); assertCanonicalPath(ctx, directoryPin, dir);
    verify([{ path: dir, directory: true, policy: "private" }]);
    if (create) flushDir(ctx, configPin.handle);
    const leaf = (name: string, access = ACCESS_READ, sharing = SHARE_LEAF_VERIFY) => {
      if (!/^[0-9a-f-]{36}(?:\.(?:terminal|proof))?(?:\.pending|\.json|\.terminal|\.proof)$/.test(name)) throw unsafe();
      const handle = relOpen(ctx, directoryPin, name, false, access, sharing);
      const stat = inspect(ctx, handle, false);
      if (stat.links !== 1 || stat.size > 1024) throw unsafe();
      verify([{ path: join(dir, name), directory: false, policy: "private" }]);
      return { handle, stat };
    };
    return run({ dir,
      names: () => readdirSync(dir),
      read(name) {
        const file = leaf(name);
        try { return readAll(ctx, file.handle, file.stat.size).toString("utf8"); }
        finally { ctx.pins.release(file.handle, kernel); }
      },
      withProofHandle(name, use) {
        if (!/^[0-9a-f-]{36}\.proof$/.test(name)) throw unsafe();
        const file = leaf(name, 0x40100080, 7);
        try { return use(file.handle); } finally { ctx.pins.release(file.handle, kernel); }
      },
      write(name, pendingName, body) {
        if (!create || Buffer.byteLength(body) > 1024 || !/^[0-9a-f-]{36}(?:\.terminal|\.proof)?$/.test(name.replace(/\.json$/, ""))
          || pendingName !== name.replace(/\.json$/, "") + ".pending") throw unsafe();
        // A previous failed publication is removed only through its verified pin.
        try {
          const old = leaf(pendingName, ACCESS_LEAF, SHARE_LEAF);
          markDelete(ctx, old.handle); ctx.pins.release(old.handle, kernel);
        } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
        const temp = join(dir, pendingName), destination = join(dir, name);
        const fd = openSync(temp, "wx", 0o600);
        try { writeFileSync(fd, body); fsyncSync(fd); } finally { closeSync(fd); }
        hardenSecretPath(toNamespacedPath(temp), { required: true });
        const file = leaf(pendingName, ACCESS_LEAF, SHARE_LEAF);
        try {
          if (!readAll(ctx, file.handle, file.stat.size).equals(Buffer.from(body))) throw unsafe();
          renamePinned(ctx, file.handle, destination);
          const published = leaf(name);
          try { if (!sameIdentity(file.stat, published.stat)) throw unsafe(); }
          finally { ctx.pins.release(published.handle, kernel); }
          flushDir(ctx, directoryPin);
        } finally { ctx.pins.release(file.handle, kernel); forgetEphemeralSecretPath(toNamespacedPath(temp)); }
      },
    });
  } finally { ctx.pins.closeAll(kernel); nt.close(); kernel.close(); }
}

export interface WindowsJobStoreIo {
  /** Ledger body text; null when the file is absent. */
  readStore(): Promise<string | null>;
  /** Atomically publish a replacement ledger body. */
  writeStore(body: string): Promise<void>;
}

/** Separate installation authority. It does not use the job ledger or repair existing ACLs.
 * Directory pins allow npm's writes but deny replacement of the prefix/ancestry.
 * The serving account and kernel-equivalent principals remain inside the trust boundary.
 */
export async function openWindowsCliApplyAuthority(prefix: string, acquire: boolean,
  onAcquiring?: (owner: WindowsApplyAcquisition) => void) {
  assertNotRealHomeUnderTest(prefix);
  const { ffi, kernel, nt } = await loadNative();
  const pins = new WindowsApplyAuthorityPins();
  const ctx: Ctx = { ffi, kernel, nt, pins };
  let held: HeldLock | undefined;
  let transferred = false;
  let closed = false;
  try {
    // Publish the context before the first pin/open or async verification can fail.
    // The caller already holds its Worker token; failed cleanup remains rooted there.
    onAcquiring?.(new WindowsApplyAcquisition(ctx, pins));
    // The prefix is an ancestry pin, not a writable store directory. A write-access
    // pin would prevent the ordinary deny-write installation snapshot from opening
    // it, even though npm's child-file writes do not require that access on our pin.
    const chain = pinChain(ctx, prefix, ACCESS_READ);
    if (chain.length < 2) throw unsafe();
    const prefixDepth = chain.length, prefixPin = chain.at(-1)!;
    let parent = prefixPin.handle, path = prefix;
    for (const component of ["node_modules", "@openai"]) {
      path = join(path, component);
      const handle = relOpen(ctx, parent, component, true, ACCESS_READ, SHARE_DIR);
      chain.push({ path, handle, inspection: inspect(ctx, handle, true) });
      parent = handle;
    }
    const entries: WindowsAclEntry[] = chain.map((entry, index) => ({ path: entry.path, directory: true,
      policy: index >= prefixDepth - 2 ? "write-private" : "trusted-ancestry" }));
    let stage: { path: string; handle: bigint; identity: StoreInspection } | undefined;
    const verifyIdentitySync = () => {
      for (const entry of chain) if (!sameIdentity(entry.inspection, inspect(ctx, entry.handle, true))) throw unsafe();
      if (held && (!sameIdentity(held.dirIdentity, inspect(ctx, held.dir, true))
        || !sameIdentity(held.ownerIdentity, inspect(ctx, held.owner, false))
        || !readAll(ctx, held.owner, Buffer.byteLength(held.record)).equals(Buffer.from(held.record)))) throw unsafe();
      if (stage && !sameIdentity(stage.identity, inspect(ctx, stage.handle, true))) throw unsafe();
    };
    const verifyHeld = async () => {
      verifyIdentitySync();
      await verifyAcl(entries);
      verifyIdentitySync();
    };
    const verify = async () => { if (closed) throw unsafe(); await verifyHeld(); if (closed) throw unsafe(); };
    await verify();
    const lock = join(prefix, ".ocx-codex-cli-apply.lock");
    if (acquire) held = await acquireLock(ctx, { config: prefix, dir: prefix, file: "", lock,
      jobdir: prefixPin.handle });
    transferred = true;
    return {
      lock,
      verify,
      verifyIdentitySync() { if (closed) throw unsafe(); verifyIdentitySync(); },
      async createStaging(): Promise<string> {
        if (closed || !held || stage) throw unsafe();
        await verify();
        const path = join(lock, "stage");
        mkdirSync(path);
        const handle = relOpen(ctx, held.dir, "stage", true, ACCESS_READ, SHARE_DIR);
        stage = { path, handle, identity: inspect(ctx, handle, true) };
        await hardenSecretDirAsync(toNamespacedPath(path), { required: true });
        await verifyAcl([{ path, directory: true, policy: "private" }]);
        if (closed) throw unsafe();
        return path;
      },
      async removeStaging(): Promise<void> {
        if (closed || !stage) throw unsafe();
        await verify();
        if (!sameIdentity(stage.identity, inspect(ctx, stage.handle, true))) throw unsafe();
        await verifyAcl([{ path: stage.path, directory: true, policy: "private" }]);
        if (closed) throw unsafe();
        if (!pins.release(stage.handle, kernel)) throw unsafe();
        // Ancestors remain pinned and all writers are within the verified trust boundary.
        rmSync(stage.path, { recursive: true });
        stage = undefined;
      },
      async release(): Promise<boolean> {
        if (closed) return false;
        closed = true;
        try { await verifyHeld(); if (held) releaseLock(ctx, held); }
        finally { ctx.pins.closeAll(kernel); }
        return pins.remaining === 0 && (!acquire || !existsSync(lock));
      },
    };
  } finally { if (!transferred) ctx.pins.closeAll(kernel); }
}

export async function windowsCliApplyPrefixSupported(prefix: string): Promise<boolean> {
  try { const guard = await openWindowsCliApplyAuthority(prefix, false); return await guard.release(); }
  catch { return false; }
}

/** Read-only execution authority: use the same reparse-refusing relative opens and
 * owner/DACL policy as installation authority. No existing object is rehardened.
 * Canonical handle paths make ACL reads identical for long and 8.3 spellings.
 */
export async function openWindowsCliToolchainAuthority(node: string, npmRoot: string, content: boolean) {
  const { ffi, kernel, nt } = await loadNative();
  const pins = new WindowsApplyAuthorityPins(), ctx: Ctx = { ffi, kernel, nt, pins };
  const acquisition = new WindowsApplyAcquisition(ctx, pins);
  retainedToolchains.add(acquisition);
  let transferred = false, closed = false, total = 0;
  const entries: WindowsAclEntry[] = [], observations: unknown[] = [];
  const canonical = (handle: bigint): string => {
    const buffer = Buffer.alloc(32768 * 2);
    const length = kernel.symbols.GetFinalPathNameByHandleW(handle, ffi.ptr(buffer), 32768, 0);
    if (!length || length >= 32768) throw unsafe();
    const path = buffer.toString("utf16le", 0, length * 2);
    if (!/^\\\\\?\\[a-z]:\\/i.test(path)) throw unsafe();
    return path.slice(4);
  };
  const add = (handle: bigint, directory: boolean, policy: WindowsAclEntry["policy"]) => {
    const identity = inspect(ctx, handle, directory), path = canonical(handle);
    entries.push({ path, directory, policy });
    if (entries.length > 8192) throw unsafe();
    if (!directory) {
      total += identity.size;
      if (identity.links !== 1 || identity.size > 128 * 1024 * 1024 || total > 512 * 1024 * 1024) throw unsafe();
      observations.push([path.toLowerCase(), identity, content ? createHash("sha256").update(readAll(ctx, handle, identity.size)).digest("hex") : ""]);
    } else observations.push([path.toLowerCase(), identity.volumeSerial, identity.fileId]);
    return path;
  };
  try {
    const nodeParent = pinChain(ctx, resolve(node, ".."), ACCESS_READ);
    for (const entry of nodeParent) add(entry.handle, true, "trusted-ancestry");
    const parent = nodeParent.at(-1); if (!parent) throw unsafe();
    // Node's own directory is a module/DLL lookup directory, so broad create grants
    // are forbidden here even when an administrator owns it.
    entries[entries.length - 1] = { path: canonical(parent.handle), directory: true, policy: "write-private" };
    add(relOpen(ctx, parent.handle, basename(node), false, ACCESS_READ, SHARE_LEAF), false, "write-private");
    // Executable-local DLL search happens before the JS resolver guard starts.
    for (const entry of readdirSync(canonical(parent.handle))) if (/\.dll$/i.test(entry)) {
      add(relOpen(ctx, parent.handle, entry, false, ACCESS_READ, SHARE_LEAF), false, "write-private");
    }
    const npmChain = pinChain(ctx, npmRoot, ACCESS_READ);
    for (const entry of npmChain) add(entry.handle, true,
      canonical(entry.handle).length >= canonical(parent.handle).length ? "write-private" : "trusted-ancestry");
    const walk = (handle: bigint) => {
      const path = canonical(handle);
      for (const entry of readdirSync(path, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        // relOpen + inspect rejects reparse points and all unexpected object kinds.
        const directory = entry.isDirectory();
        const child = relOpen(ctx, handle, entry.name, directory, ACCESS_READ, SHARE_LEAF);
        add(child, directory, "write-private");
        if (directory) walk(child);
      }
    };
    walk(npmChain.at(-1)!.handle);
    // Hold each existing ancestor module lookup directory; absent names are checked
    // again under the already pinned, ACL-confined parents on every acquisition.
    for (const entry of npmChain.slice(0, -1)) {
      try { add(relOpen(ctx, entry.handle, "node_modules", true, ACCESS_READ, SHARE_DIR), true, "write-private"); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
    for (let i = 0; i < entries.length; i += 512) await verifyAcl(entries.slice(i, i + 512));
    const digest = createHash("sha256").update(JSON.stringify(observations)).digest("hex");
    transferred = true;
    return { digest, async release(): Promise<boolean> {
      if (closed) return false; closed = true;
      pins.closeAll(kernel);
      if (pins.remaining) throw new WindowsCliToolchainCleanupError(acquisition);
      retainedToolchains.delete(acquisition); return true;
    } };
  } finally { if (!transferred) {
    pins.closeAll(kernel);
    if (pins.remaining) throw new WindowsCliToolchainCleanupError(acquisition);
    retainedToolchains.delete(acquisition);
  } }
}

/**
 * Read-only store access outside the mutex, for status. Returns null when the
 * store tree or ledger file does not exist.
 */
export async function readWindowsJobStore(configDir?: string): Promise<string | null> {
  const absolute = resolve(configDir ?? getConfigDir());
  const { ffi, kernel, nt } = await loadNative();
  const ctx: Ctx = { ffi, kernel, nt, pins: new PinSet() };
  try {
    const prepared = await prepareStore(ctx, absolute, { createJobDir: false, createConfigRoot: false });
    if (prepared === null) return null;
    return await readStoreBody(ctx, prepared);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  } finally {
    ctx.pins.closeAll(kernel);
  }
}

/**
 * Run fn under the admission mutex with read/write access to the ledger.
 * createConfigRoot is the confirmed-admission privilege to create one absent
 * config-root level; status reads and completion writes never create it.
 */
export async function withWindowsJobStoreLock<T>(
  configDir: string | undefined,
  createConfigRoot: boolean,
  fn: (io: WindowsJobStoreIo) => T | Promise<T>,
): Promise<T> {
  const absolute = resolve(configDir ?? getConfigDir());
  assertNotRealHomeUnderTest(absolute);
  const { ffi, kernel, nt } = await loadNative();
  const ctx: Ctx = { ffi, kernel, nt, pins: new PinSet() };
  try {
    const prepared = await prepareStore(ctx, absolute, { createJobDir: true, createConfigRoot });
    if (prepared === null) throw unsafe(); // unreachable: write flow never returns null
    const held = await acquireLock(ctx, prepared);
    try {
      return await fn({
        readStore: () => readStoreBody(ctx, prepared),
        writeStore: body => writeStoreBody(ctx, prepared, body),
      });
    } finally {
      releaseLock(ctx, held);
    }
  } finally {
    ctx.pins.closeAll(kernel);
  }
}
