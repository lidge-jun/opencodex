import { createHash } from "node:crypto";
import type { Library, Symbols } from "bun:ffi";

const KERNEL_SYMBOLS = {
  GetDriveTypeW: { args: ["ptr"], returns: "u32" },
  GetVolumeNameForVolumeMountPointW: { args: ["ptr", "ptr", "u32"], returns: "i32" },
  CreateFileW: { args: ["ptr", "u32", "u32", "ptr", "u32", "u32", "u64"], returns: "u64" },
  GetFileInformationByHandleEx: { args: ["u64", "i32", "ptr", "u32"], returns: "i32" },
  GetFileType: { args: ["u64"], returns: "u32" },
  ReadFile: { args: ["u64", "ptr", "u32", "ptr", "ptr"], returns: "i32" },
  CloseHandle: { args: ["u64"], returns: "i32" },
} as const satisfies Symbols;
const NT_SYMBOLS = {
  NtCreateFile: { args: ["ptr", "u32", "ptr", "ptr", "ptr", "u32", "u32", "u32", "u32", "ptr", "u32"], returns: "i32" },
} as const satisfies Symbols;

export interface WindowsInstallationFileRequest {
  readonly path: string;
  readonly maxBytes: number;
  readonly hashOnly?: boolean;
  /** Validate and hold the path without reading its contents. */
  readonly metadataOnly?: boolean;
  /** Read at most maxBytes from the start instead of refusing an oversized file. */
  readonly prefixOnly?: boolean;
}
export interface WindowsInstallationFileIdentity {
  readonly volumeSerial: string;
  readonly fileId: string;
  readonly size: number;
  readonly lastWriteTime: string;
  readonly changeTime: string;
}
export type WindowsInstallationFilesResult =
  | { kind: "observed"; files: {
    path: string; identity: WindowsInstallationFileIdentity; bytes: Uint8Array; digest: string;
  }[] }
  | { kind: "refused"; reason: "unsupported-platform" | "invalid-request" | "native-api-unavailable"
    | "volume-unavailable" | "not-found" | "open-refused" | "reparse-point" | "not-regular-file"
    | "size-limit" | "read-failed" | "identity-changed" | "inspection-failed" };

type Refusal = Extract<WindowsInstallationFilesResult, { kind: "refused" }>["reason"];
/** Only these two NTSTATUS values prove that a candidate or its ancestor is absent. */
export function ntCreateFileRefusal(status: number): Refusal {
  switch (status >>> 0) {
    case 0xc0000034: // STATUS_OBJECT_NAME_NOT_FOUND
    case 0xc000003a: // STATUS_OBJECT_PATH_NOT_FOUND
      return "not-found";
    default:
      return "open-refused";
  }
}
class InspectionRefusal extends Error {
  constructor(readonly reason: Refusal) { super(reason); }
}
const MIB = 1024 * 1024;
const REPARSE = 0x400;
const DIRECTORY = 0x10;
const INVALID_HANDLE = 0xffffffffffffffffn;
let openedForTests: (() => void) | undefined;
/** Runs after handles are held, for real Windows sharing/rename regression fixtures. */
export function setWindowsInstallationFilesOpenedForTests(callback?: () => void): void {
  openedForTests = callback;
}

function components(path: string): { drive: string; names: string[] } | null {
  if (typeof path !== "string" || path.length > 8192 || !/^[A-Za-z]:[\\/]/.test(path)) return null;
  const names = path.slice(3).split(/[\\/]/);
  if (!names.length || names.length > 64 || names.some(name => !name || name === "." || name === ".."
    || /[\x00-\x1f<>:"|?*]/.test(name) || /[. ]$/.test(name)
    || /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(name))) return null;
  return { drive: `${path[0]!.toUpperCase()}:\\`, names };
}

/**
 * An explicit, read-only snapshot; never installation authority or a runtime-selection proof.
 * All component opens are relative to held directory handles, not checked-then-reopened paths.
 * Windows x64 only: the UNICODE_STRING/OBJECT_ATTRIBUTES layouts below are the x64 ABI.
 * No candidate runs and no shell/compiler is started. Disk/driver latency is not a hard deadline.
 * API contracts: learn.microsoft.com/windows/win32/api/winternl/nf-winternl-ntcreatefile
 * and /windows/win32/api/fileapi/nf-fileapi-getvolumenameforvolumemountpointw.
 */
export async function inspectWindowsInstallationFiles(
  requests: readonly WindowsInstallationFileRequest[],
): Promise<WindowsInstallationFilesResult> {
  if (!Array.isArray(requests) || requests.length === 0 || requests.length > 12) {
    return { kind: "refused", reason: "invalid-request" };
  }
  let ceiling = 0;
  const parsed = requests.map(request => {
    const parsedPath = request && components(request.path);
    if (!parsedPath || !Number.isSafeInteger(request.maxBytes) || request.maxBytes < 0
      || (request.hashOnly !== undefined && typeof request.hashOnly !== "boolean")
      || (request.metadataOnly !== undefined && typeof request.metadataOnly !== "boolean")
      || (request.prefixOnly !== undefined && typeof request.prefixOnly !== "boolean")
      || request.maxBytes > (request.hashOnly ? 256 * MIB : MIB)) return null;
    ceiling += request.maxBytes;
    return parsedPath;
  });
  if (parsed.some(path => path === null) || ceiling > 300 * MIB) {
    return { kind: "refused", reason: "invalid-request" };
  }
  if (process.platform !== "win32" || process.arch !== "x64") {
    return { kind: "refused", reason: "unsupported-platform" };
  }
  // Loading FFI is itself opt-in; importing this module performs no Windows inspection.
  let ffi: typeof import("bun:ffi");
  try { ffi = await import("bun:ffi"); } catch { return { kind: "refused", reason: "native-api-unavailable" }; }
  let kernel: Library<typeof KERNEL_SYMBOLS> | undefined;
  let nt: Library<typeof NT_SYMBOLS> | undefined;
  const handles: bigint[] = [];
  try {
    try {
      kernel = ffi.dlopen("kernel32.dll", KERNEL_SYMBOLS);
      nt = ffi.dlopen("ntdll.dll", NT_SYMBOLS);
    } catch { throw new InspectionRefusal("native-api-unavailable"); }
    const k = kernel.symbols;
    const wide = (text: string): Buffer => Buffer.from(`${text}\0`, "utf16le");
    const keep = (handle: bigint): bigint => {
      if (handle === 0n || handle === INVALID_HANDLE) throw new InspectionRefusal("open-refused");
      handles.push(handle);
      return handle;
    };
    const info = (handle: bigint, infoClass: number, length: number): Buffer => {
      const buffer = Buffer.alloc(length);
      if (!k.GetFileInformationByHandleEx!(handle, infoClass, ffi.ptr(buffer), length)) {
        throw new InspectionRefusal("inspection-failed");
      }
      return buffer;
    };
    const inspect = (handle: bigint, directory: boolean): WindowsInstallationFileIdentity => {
      if (k.GetFileType!(handle) !== 1) throw new InspectionRefusal("not-regular-file"); // FILE_TYPE_DISK
      const basic = info(handle, 0, 40); // FILE_BASIC_INFO: 4 LARGE_INTEGERs, attributes.
      const attributes = basic.readUInt32LE(32);
      if (attributes & REPARSE) throw new InspectionRefusal("reparse-point");
      if (Boolean(attributes & DIRECTORY) !== directory) throw new InspectionRefusal("not-regular-file");
      const id = info(handle, 18, 24); // FILE_ID_INFO: volume serial and 128-bit file ID.
      const standard = info(handle, 1, 24); // FILE_STANDARD_INFO.EndOfFile
      const size = standard.readBigInt64LE(8);
      if (size < 0n || size > BigInt(Number.MAX_SAFE_INTEGER)) throw new InspectionRefusal("size-limit");
      return { volumeSerial: id.readBigUInt64LE(0).toString(16), fileId: id.subarray(8, 24).toString("hex"),
        size: Number(size), lastWriteTime: basic.readBigInt64LE(16).toString(), changeTime: basic.readBigInt64LE(24).toString() };
    };
    const roots = new Map<string, bigint>();
    const root = (drive: string): bigint => {
      const held = roots.get(drive);
      if (held !== undefined) return held;
      const mount = wide(drive);
      const name = Buffer.alloc(100 * 2);
      if (![2, 3, 5, 6].includes(Number(k.GetDriveTypeW!(ffi.ptr(mount))))) {
        throw new InspectionRefusal("volume-unavailable");
      }
      // Root-only volume management query, never a candidate-controlled ancestor traversal.
      // This API does not support SMB; only a strict local volume GUID reaches CreateFileW.
      if (!k.GetVolumeNameForVolumeMountPointW!(ffi.ptr(mount), ffi.ptr(name), 100)) {
        throw new InspectionRefusal("volume-unavailable");
      }
      const guid = name.toString("utf16le").split("\0", 1)[0]!;
      if (!/^\\\\\?\\Volume\{[0-9a-f-]{36}\}\\$/i.test(guid)) throw new InspectionRefusal("volume-unavailable");
      const path = wide(guid);
      const handle = keep(BigInt(k.CreateFileW!(ffi.ptr(path), 0x100081, 1, null, 3, 0x02200000, 0n)));
      inspect(handle, true);
      roots.set(drive, handle);
      return handle;
    };
    const relativeOpen = (parent: bigint, component: string, directory: boolean): bigint => {
      const name = wide(component);
      const unicode = Buffer.alloc(16);
      unicode.writeUInt16LE(name.length - 2, 0);
      unicode.writeUInt16LE(name.length, 2);
      unicode.writeBigUInt64LE(BigInt(ffi.ptr(name)), 8);
      const attributes = Buffer.alloc(48);
      attributes.writeUInt32LE(48, 0);
      attributes.writeBigUInt64LE(parent, 8);
      attributes.writeBigUInt64LE(BigInt(ffi.ptr(unicode)), 16);
      attributes.writeUInt32LE(0x40, 24); // OBJ_CASE_INSENSITIVE; one component only.
      const output = Buffer.alloc(8);
      const status = Buffer.alloc(16);
      // FILE_OPEN; FILE_SYNCHRONOUS_IO_NONALERT; FILE_OPEN_REPARSE_POINT.
      // Share READ only: while held, writes/reparse edits and delete/rename opens are refused.
      const result = nt!.symbols.NtCreateFile!(ffi.ptr(output), 0x100081, ffi.ptr(attributes),
        ffi.ptr(status), null, 0, 1, 1, 0x200020 | (directory ? 1 : 0), null, 0);
      if (result < 0) throw new InspectionRefusal(ntCreateFileRefusal(result));
      const handle = keep(output.readBigUInt64LE(0));
      inspect(handle, directory);
      return handle;
    };
    const directories = new Map<string, bigint>();
    const files = requests.map((request, index) => {
      const { drive, names } = parsed[index]!;
      let parent = root(drive);
      let key = drive;
      for (const component of names.slice(0, -1)) {
        key += `${component}\\`;
        let handle = directories.get(key);
        if (handle === undefined) {
          handle = relativeOpen(parent, component, true);
          directories.set(key, handle);
        }
        parent = handle;
      }
      const handle = relativeOpen(parent, names[names.length - 1]!, false);
      const identity = inspect(handle, false);
      if (!request.metadataOnly && !(request.prefixOnly && !request.hashOnly)
        && identity.size > request.maxBytes) throw new InspectionRefusal("size-limit");
      return { request, handle, identity };
    });
    openedForTests?.();
    const observed = files.map(({ request, handle, identity }) => {
      const hash = createHash("sha256");
      if (request.metadataOnly) return { path: request.path, identity, bytes: new Uint8Array(), digest: "" };
      const truncated = Boolean(request.prefixOnly) && !request.hashOnly && identity.size > request.maxBytes;
      const readLimit = truncated ? request.maxBytes : identity.size;
      const bytes = request.hashOnly ? new Uint8Array() : new Uint8Array(readLimit);
      const chunk = Buffer.alloc(Math.min(MIB, Math.max(1, readLimit)));
      const read = Buffer.alloc(4);
      let offset = 0;
      while (offset < readLimit) {
        const length = Math.min(chunk.length, readLimit - offset);
        if (!k.ReadFile!(handle, ffi.ptr(chunk), length, ffi.ptr(read), null)) throw new InspectionRefusal("read-failed");
        const count = read.readUInt32LE(0);
        if (!count || count > length) throw new InspectionRefusal("read-failed");
        if (!request.hashOnly) bytes.set(chunk.subarray(0, count), offset);
        if (!truncated) hash.update(chunk.subarray(0, count));
        offset += count;
      }
      if (!truncated) {
        if (!k.ReadFile!(handle, ffi.ptr(chunk), 1, ffi.ptr(read), null) || read.readUInt32LE(0) !== 0) {
          throw new InspectionRefusal("identity-changed");
        }
      }
      return { path: request.path, identity, bytes, digest: truncated ? "" : hash.digest("hex") };
    });
    for (const file of files) {
      if (JSON.stringify(inspect(file.handle, false)) !== JSON.stringify(file.identity)) {
        throw new InspectionRefusal("identity-changed");
      }
    }
    return { kind: "observed", files: observed };
  } catch (error) {
    return { kind: "refused", reason: error instanceof InspectionRefusal ? error.reason : "inspection-failed" };
  } finally {
    for (const handle of handles.reverse()) kernel?.symbols.CloseHandle?.(handle);
    nt?.close();
    kernel?.close();
  }
}
