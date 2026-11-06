import { dlopen, ptr, read, type Library, type Symbols } from "bun:ffi";

// Windows x64 ABI only. No native binary, compiler, worker URL, or shell dependency.
export const WIN64_CHILD_ABI = Object.freeze({ securityAttributes: 24, securityDescriptor: 8, inheritHandle: 16,
  startupInfo: 104, startupInfoEx: 112, startupFlags: 60, stdin: 80, stdout: 88, stderr: 96, attributes: 104,
  processInformation: 24, process: 0, thread: 8, pid: 16, tid: 20,
  overlapped: 32, event: 24, jobAccounting: 48, activeProcesses: 40 });
const KERNEL = {
  GetLastError: { args: [], returns: "u32" },
  SetLastError: { args: ["u32"], returns: "void" },
  SetHandleInformation: { args: ["u64", "u32", "u32"], returns: "i32" },
  DuplicateHandle: { args: ["u64", "u64", "u64", "ptr", "u32", "i32", "u32"], returns: "i32" },
  GetCurrentProcess: { args: [], returns: "u64" },
  CompareStringOrdinal: { args: ["ptr", "i32", "ptr", "i32", "i32"], returns: "i32" },
  CreateJobObjectW: { args: ["ptr", "ptr"], returns: "u64" },
  AssignProcessToJobObject: { args: ["u64", "u64"], returns: "i32" },
  QueryInformationJobObject: { args: ["u64", "i32", "ptr", "u32", "ptr"], returns: "i32" },
  TerminateJobObject: { args: ["u64", "u32"], returns: "i32" },
  TerminateProcess: { args: ["u64", "u32"], returns: "i32" },
  CreateProcessW: { args: ["ptr", "ptr", "ptr", "ptr", "i32", "u32", "ptr", "ptr", "ptr", "ptr"], returns: "i32" },
  ResumeThread: { args: ["u64"], returns: "u32" },
  WaitForSingleObject: { args: ["u64", "u32"], returns: "u32" },
  GetExitCodeProcess: { args: ["u64", "ptr"], returns: "i32" },
  GetProcessTimes: { args: ["u64", "ptr", "ptr", "ptr", "ptr"], returns: "i32" },
  InitializeProcThreadAttributeList: { args: ["ptr", "u32", "u32", "ptr"], returns: "i32" },
  UpdateProcThreadAttribute: { args: ["ptr", "u32", "u64", "ptr", "u64", "ptr", "ptr"], returns: "i32" },
  DeleteProcThreadAttributeList: { args: ["ptr"], returns: "void" },
  CreateNamedPipeW: { args: ["ptr", "u32", "u32", "u32", "u32", "u32", "u32", "ptr"], returns: "u64" },
  ConnectNamedPipe: { args: ["u64", "ptr"], returns: "i32" },
  CreateFileW: { args: ["ptr", "u32", "u32", "ptr", "u32", "u32", "u64"], returns: "u64" },
  CreateEventW: { args: ["ptr", "i32", "i32", "ptr"], returns: "u64" },
  ResetEvent: { args: ["u64"], returns: "i32" },
  ReadFile: { args: ["u64", "ptr", "u32", "ptr", "ptr"], returns: "i32" },
  GetOverlappedResult: { args: ["u64", "ptr", "ptr", "i32"], returns: "i32" },
  CancelIoEx: { args: ["u64", "ptr"], returns: "i32" },
  CloseHandle: { args: ["u64"], returns: "i32" },
  LocalFree: { args: ["ptr"], returns: "ptr" },
} as const satisfies Symbols;
const ADVAPI = {
  OpenProcessToken: { args: ["u64", "u32", "ptr"], returns: "i32" },
  GetTokenInformation: { args: ["u64", "i32", "ptr", "u32", "ptr"], returns: "i32" },
  ConvertSidToStringSidW: { args: ["ptr", "ptr"], returns: "i32" },
  ConvertStringSecurityDescriptorToSecurityDescriptorW: { args: ["ptr", "u32", "ptr", "ptr"], returns: "i32" },
} as const satisfies Symbols;

export const wide = (value: string): Buffer => Buffer.from(`${value}\0`, "utf16le");
export function securityAttributes(inherit: boolean, descriptor = 0n): Buffer {
  const bytes = Buffer.alloc(WIN64_CHILD_ABI.securityAttributes);
  bytes.writeUInt32LE(bytes.length, 0); bytes.writeBigUInt64LE(descriptor, 8); bytes.writeUInt32LE(+inherit, 16);
  return bytes;
}

type OwnedDispatch<SymbolsTable> = { -readonly [Key in keyof SymbolsTable]:
  SymbolsTable[Key] extends (...args: infer Args) => infer Result ? (...args: Args) => Result : SymbolsTable[Key] };

/** Owns only handles returned by this invocation, never PID-reopened handles. */
export class WindowsChildNative {
  readonly k: OwnedDispatch<Library<typeof KERNEL>["symbols"]>;
  readonly a: OwnedDispatch<Library<typeof ADVAPI>["symbols"]>;
  readonly handles = new Set<bigint>();
  /** Explicit GC roots for pointers stored inside native attribute lists. */
  readonly borrowedMemory = new Set<Buffer>();
  readonly closeErrors: bigint[] = [];
  private readonly kernel: Library<typeof KERNEL>;
  private readonly advapi: Library<typeof ADVAPI>;
  private closed = false;
  constructor() {
    if (process.platform !== "win32" || process.arch !== "x64") throw new Error("windows_child_unsupported_platform");
    this.kernel = dlopen("kernel32.dll", KERNEL);
    try { this.advapi = dlopen("advapi32.dll", ADVAPI); }
    catch (error) { this.kernel.close(); throw error; }
    // Own mutable dispatch tables permit per-instance fault injection in native fixtures.
    this.k = { ...this.kernel.symbols }; this.a = { ...this.advapi.symbols };
  }
  keep(value: number | bigint): bigint {
    const handle = BigInt(value);
    if (!handle || handle === 0xffffffffffffffffn) throw new Error(`windows_child_handle_${this.k.GetLastError!()}`);
    this.handles.add(handle); return handle;
  }
  close(handle: bigint): void {
    if (!this.handles.has(handle)) return;
    if (!this.k.CloseHandle!(handle)) { this.closeErrors.push(handle); return; }
    this.handles.delete(handle);
  }
  dispose(): boolean {
    if (this.handles.size || this.borrowedMemory.size) return false;
    if (!this.closed) { this.closed = true; this.advapi.close(); this.kernel.close(); }
    return true;
  }
  /** Protected DACL grants only the current token user. No default/world pipe ACL. */
  privateDescriptor(): bigint {
    const output = Buffer.alloc(8), size = Buffer.alloc(4);
    if (!this.a.OpenProcessToken!(this.k.GetCurrentProcess!(), 8, ptr(output))) throw new Error("windows_child_token");
    const token = this.keep(output.readBigUInt64LE());
    let sidText = 0n;
    try {
      this.a.GetTokenInformation!(token, 1, null, 0, ptr(size));
      const length = size.readUInt32LE();
      if (length < 8 || length > 65536) throw new Error("windows_child_token_size");
      const user = Buffer.alloc(length);
      if (!this.a.GetTokenInformation!(token, 1, ptr(user), length, ptr(size))) throw new Error("windows_child_token_user");
      const sid = user.readBigUInt64LE();
      if (!this.a.ConvertSidToStringSidW!(sid, ptr(output))) throw new Error("windows_child_token_sid");
      sidText = output.readBigUInt64LE();
      let sidString = "";
      for (let index = 0; index < 184; index++) {
        const code = read.u16(sidText, index * 2);
        if (!code) break;
        sidString += String.fromCharCode(code);
      }
      if (!/^S-1-(?:\d+-)+\d+$/.test(sidString)) throw new Error("windows_child_sid_shape");
      const sddl = wide(`D:P(A;;GA;;;${sidString})`);
      if (!this.a.ConvertStringSecurityDescriptorToSecurityDescriptorW!(ptr(sddl), 1, ptr(output), null)) {
        throw new Error("windows_child_pipe_acl");
      }
      return output.readBigUInt64LE();
    } finally { if (sidText) this.k.LocalFree!(sidText); this.close(token); }
  }
}
