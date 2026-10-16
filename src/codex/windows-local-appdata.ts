import { dlopen, ptr, read, type Pointer } from "bun:ffi";
import { win32 } from "node:path";
import { resolveTrustedWindowsSystemDirectory } from "../lib/windows-elevation";

// FOLDERID_LocalAppData: GUID fields Data1/Data2/Data3 are little-endian.
const LOCAL_APPDATA_ID = Buffer.from("8527b3f1ba6fcf4f9d557b8e7f157091", "hex");
const KF_FLAG_DEFAULT_PATH = 0x400;
const MAX_PATH_CODE_UNITS = 32_768;

export interface WindowsKnownFolderApi {
  getPath(id: Uint8Array, flags: number, token: null, output: BigUint64Array): number;
  readCodeUnit(address: number, byteOffset: number): number;
  free(address: number): void;
}

/** Same current-token/default-path API as the PowerShell fallback, without Add-Type. */
export function readWindowsLocalAppData(api: WindowsKnownFolderApi): string {
  const output = new BigUint64Array(1);
  let address = 0;
  try {
    const hr = api.getPath(LOCAL_APPDATA_ID, KF_FLAG_DEFAULT_PATH, null, output);
    address = Number(output[0]);
    if (hr !== 0 || !Number.isSafeInteger(address) || address <= 0) {
      throw new Error("Windows LocalAppData known-folder lookup failed.");
    }
    const units: number[] = [];
    for (let index = 0; index < MAX_PATH_CODE_UNITS; index += 1) {
      const unit = api.readCodeUnit(address, index * 2);
      if (unit === 0) {
        const path = String.fromCharCode(...units);
        if (!win32.isAbsolute(path) || !/^[a-z]:\\|^\\\\/i.test(path)) {
          throw new Error("Windows LocalAppData known-folder lookup returned an invalid path.");
        }
        return path;
      }
      units.push(unit);
    }
    throw new Error("Windows LocalAppData known-folder lookup returned an unterminated path.");
  } finally {
    // SHGetKnownFolderPath requires CoTaskMemFree even on a failed HRESULT.
    if (address > 0 && Number.isSafeInteger(address)) api.free(address);
  }
}

let nativeLookup: (() => string) | null | undefined;

function loadNativeLookup(): (() => string) | null {
  if (nativeLookup !== undefined) return nativeLookup;
  if (process.platform !== "win32" || process.arch !== "x64") return null;
  try {
    const systemDirectory = resolveTrustedWindowsSystemDirectory();
    const shell = dlopen(win32.join(systemDirectory, "shell32.dll"), {
      SHGetKnownFolderPath: { args: ["ptr", "u32", "ptr", "ptr"], returns: "i32" },
    });
    let ole;
    try {
      ole = dlopen(win32.join(systemDirectory, "ole32.dll"), {
        CoTaskMemFree: { args: ["ptr"], returns: "void" },
      });
    } catch (error) {
      shell.close();
      throw error;
    }
    const api: WindowsKnownFolderApi = {
      getPath: (id, flags, token, output) => shell.symbols.SHGetKnownFolderPath(
        ptr(id), flags, token, ptr(output),
      ),
      readCodeUnit: (address, offset) => read.u16(address as Pointer, offset),
      free: address => { ole.symbols.CoTaskMemFree(address as Pointer); },
    };
    nativeLookup = () => readWindowsLocalAppData(api);
  } catch {
    nativeLookup = null;
  }
  return nativeLookup;
}

/** Unsupported FFI keeps the bounded trusted helper; an OS API failure still refuses. */
export function resolveWindowsLocalAppData(
  powershellLookup: () => string,
  lookup: (() => string) | null = loadNativeLookup(),
): string {
  return lookup ? lookup() : powershellLookup();
}
