import { dlopen, ptr, read, type Pointer } from "bun:ffi";
import { win32 } from "node:path";
import { readWindowsCurrentSid, type WindowsTokenSidApi } from "../codex/windows-current-sid";
import { resolveTrustedWindowsSystemDirectory } from "./windows-elevation";
import { spawnWorker } from "./worker-embed";

export interface NativeWindowsPrincipal { readonly sid: string; readonly name: string }
export interface WindowsNativePrincipalApi extends WindowsTokenSidApi {
  lookupAccountSid(sid: number, name: Uint16Array | null, nameLength: Uint32Array,
    domain: Uint16Array | null, domainLength: Uint32Array, use: Uint32Array): number;
  lastError(): number;
}

const MAX_ACCOUNT_CODE_UNITS = 32_768;
function lookupError(): Error { return new Error("Windows native account translation failed."); }

function wideString(buffer: Uint16Array, reported: number): string {
  if (reported > buffer.length) throw lookupError();
  const end = buffer.indexOf(0);
  if (end < 0) throw lookupError();
  const value = String.fromCharCode(...buffer.subarray(0, end));
  if (/[\r\n]/.test(value)) throw lookupError();
  return value;
}

function accountName(api: WindowsNativePrincipalApi, sid: number): string {
  const nameLength = new Uint32Array(1), domainLength = new Uint32Array(1), use = new Uint32Array(1);
  const sized = api.lookupAccountSid(sid, null, nameLength, null, domainLength, use);
  const error = sized === 0 ? api.lastError() : 0;
  if (sized !== 0 || error !== 122 || nameLength[0]! < 2
    || nameLength[0]! > MAX_ACCOUNT_CODE_UNITS || domainLength[0]! > MAX_ACCOUNT_CODE_UNITS) {
    throw lookupError();
  }
  const name = new Uint16Array(nameLength[0]!);
  // An empty domain is valid; its storage still needs a non-null, addressable NUL.
  const domain = new Uint16Array(Math.max(1, domainLength[0]!));
  domainLength[0] = domain.length;
  if (api.lookupAccountSid(sid, name, nameLength, domain, domainLength, use) === 0) {
    // No resize/retry downgrade: an unmapped SID or changing requirement refuses.
    throw lookupError();
  }
  const account = wideString(name, nameLength[0]!);
  const authority = wideString(domain, domainLength[0]!);
  if (!account) throw lookupError();
  return authority ? `${authority}\\${account}` : account;
}

/** Reuse the token reader's lifetime; translate its live binary SID before allocating the string. */
export function readWindowsNativePrincipal(api: WindowsNativePrincipalApi): NativeWindowsPrincipal {
  let name = "";
  const sid = readWindowsCurrentSid({
    ...api,
    convertSidToStringSid(address, output) {
      // The reader synchronously invokes this while retaining TOKEN_USER's backing buffer.
      name = accountName(api, address);
      return api.convertSidToStringSid(address, output);
    },
  });
  return Object.freeze({ sid, name });
}

interface NativeResolution {
  platform: NodeJS.Platform;
  arch: string;
  systemDirectory(): string;
  load: typeof dlopen;
}

/** Null means unsupported native execution. DLL/path/API failures propagate, never downgrade. */
export function resolveWindowsNativePrincipal(resolution: NativeResolution = {
  platform: process.platform, arch: process.arch,
  systemDirectory: resolveTrustedWindowsSystemDirectory, load: dlopen,
}): NativeWindowsPrincipal | null {
  if (resolution.platform !== "win32" || resolution.arch !== "x64") return null;
  const directory = resolution.systemDirectory();
  const advapi = resolution.load(win32.join(directory, "advapi32.dll"), {
    OpenProcessToken: { args: ["u64", "u32", "ptr"], returns: "i32" },
    GetTokenInformation: { args: ["u64", "u32", "ptr", "u32", "ptr"], returns: "i32" },
    ConvertSidToStringSidW: { args: ["ptr", "ptr"], returns: "i32" },
    LookupAccountSidW: { args: ["ptr", "ptr", "ptr", "ptr", "ptr", "ptr", "ptr"], returns: "i32" },
  });
  try {
    const kernel = resolution.load(win32.join(directory, "kernel32.dll"), {
      GetCurrentProcess: { args: [], returns: "u64" },
      CloseHandle: { args: ["u64"], returns: "i32" },
      LocalFree: { args: ["ptr"], returns: "ptr" },
      GetLastError: { args: [], returns: "u32" },
    });
    try {
      return readWindowsNativePrincipal({
        openProcessToken: (access, output) => advapi.symbols.OpenProcessToken(
          kernel.symbols.GetCurrentProcess(), access, ptr(output)),
        getTokenInformation: (token, kind, buffer, length) => advapi.symbols.GetTokenInformation(
          token, kind, ptr(buffer), buffer.byteLength, ptr(length)),
        convertSidToStringSid: (address, output) => advapi.symbols.ConvertSidToStringSidW(
          address as Pointer, ptr(output)),
        lookupAccountSid: (address, name, nameLength, domain, domainLength, use) =>
          advapi.symbols.LookupAccountSidW(null, address as Pointer, name ? ptr(name) : null,
            ptr(nameLength), domain ? ptr(domain) : null, ptr(domainLength), ptr(use)),
        lastError: () => kernel.symbols.GetLastError(),
        readCodeUnit: (address, offset) => read.u16(address as Pointer, offset),
        localFree: address => { kernel.symbols.LocalFree(address as Pointer); },
        closeHandle: token => { kernel.symbols.CloseHandle(token); },
      });
    } finally { kernel.close(); }
  } finally { advapi.close(); }
}

export interface NativePrincipalTiming {
  now(): number;
  schedule(callback: () => void, milliseconds: number): () => void;
}
const timing: NativePrincipalTiming = {
  now: () => performance.now(),
  schedule: (callback, milliseconds) => {
    const timer = setTimeout(callback, milliseconds);
    return () => clearTimeout(timer);
  },
};

/** A worker may remain in FFI after a caller expires; its slot belongs to closure, not the caller. */
export function createWindowsNativePrincipalLookup(
  createWorker: () => Worker = () => spawnWorker(
    new URL("./windows-native-principal-worker.ts", import.meta.url).href, "windows-native-principal-worker"),
): (timeoutMs: number, clock?: NativePrincipalTiming) => Promise<NativeWindowsPrincipal | null> {
  let active: { result: Promise<NativeWindowsPrincipal | null> } | null = null;
  const start = () => {
    const worker = createWorker();
    let resolve!: (identity: NativeWindowsPrincipal | null) => void, reject!: (error: Error) => void;
    const job = { result: new Promise<NativeWindowsPrincipal | null>((yes, no) => { resolve = yes; reject = no; }) };
    void job.result.catch(() => {});
    active = job;
    let response: NativeWindowsPrincipal | null | undefined;
    let received = false;
    const fail = () => reject(lookupError());
    worker.addEventListener("message", event => {
      if (received) { fail(); return; }
      received = true;
      const message: unknown = event.data;
      if (!message || typeof message !== "object") { fail(); return; }
      const data = message as Record<string, unknown>;
      if (data.kind === "unavailable") response = null;
      else if (data.kind === "identity" && typeof data.sid === "string" && typeof data.name === "string") {
        response = { sid: data.sid, name: data.name };
      } else fail();
    });
    worker.addEventListener("error", fail);
    worker.addEventListener("messageerror", fail);
    worker.addEventListener("close", () => {
      if (active === job) active = null;
      if (received && response !== undefined) resolve(response);
      else fail();
    }, { once: true });
    (worker as Worker & { unref(): void }).unref();
    try { worker.postMessage({ kind: "lookup" }); }
    catch { fail(); }
    return job;
  };
  return (timeoutMs, clock = timing) => {
    const deadline = clock.now() + timeoutMs;
    return new Promise((resolve, reject) => {
      let settled = false, cancel = () => {};
      const finish = (error?: unknown, identity?: NativeWindowsPrincipal | null) => {
        if (settled) return;
        settled = true; cancel();
        if (error) reject(error); else resolve(identity!);
      };
      const expired = () => finish(new Error("Windows native principal lookup timed out."));
      if (timeoutMs <= 0) { expired(); return; }
      cancel = clock.schedule(expired, timeoutMs);
      if (settled) { cancel(); return; }
      try {
        const job = active ?? start();
        // Timer callbacks can lag synchronous worker construction or promise delivery.
        if (clock.now() >= deadline) expired();
        void job.result.then(identity => {
          if (clock.now() >= deadline) expired(); else finish(undefined, identity);
        }, error => finish(error));
      } catch (error) { finish(error); }
    });
  };
}

const nativeLookup = createWindowsNativePrincipalLookup();
export function resolveWindowsNativePrincipalAsync(timeoutMs: number): Promise<NativeWindowsPrincipal | null> {
  if (process.platform !== "win32" || process.arch !== "x64") return Promise.resolve(null);
  return nativeLookup(timeoutMs);
}
