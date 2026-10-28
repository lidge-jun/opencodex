import { dlopen, ptr } from "bun:ffi";

/** Read-only lifetime proof. Never signals a process, opens a foreign Job for
 * termination, or treats access/query failures as terminal evidence.
 */
export function windowsCodexCliChildGone(pid: number, creationTime: string, jobName: string): boolean {
  if (process.platform !== "win32" || process.arch !== "x64" || !Number.isSafeInteger(pid) || pid <= 0
    || !/^[1-9][0-9]{0,19}$/.test(creationTime) || !/^Global\\ocx-cli-[0-9a-f-]{36}$/.test(jobName)) return false;
  const lib = dlopen("kernel32.dll", {
    OpenJobObjectW: { args: ["u32", "i32", "ptr"], returns: "u64" },
    OpenProcess: { args: ["u32", "i32", "u32"], returns: "u64" },
    GetLastError: { args: [], returns: "u32" },
    QueryInformationJobObject: { args: ["u64", "i32", "ptr", "u32", "ptr"], returns: "i32" },
    GetProcessTimes: { args: ["u64", "ptr", "ptr", "ptr", "ptr"], returns: "i32" },
    WaitForSingleObject: { args: ["u64", "u32"], returns: "u32" },
    CloseHandle: { args: ["u64"], returns: "i32" },
  });
  let job = 0n, processHandle = 0n;
  try {
    const name = Buffer.from(jobName + "\0", "utf16le");
    job = BigInt(lib.symbols.OpenJobObjectW(4, 0, ptr(name))); // JOB_OBJECT_QUERY only
    if (!job) { if (lib.symbols.GetLastError() !== 2) return false; }
    else {
      const accounting = Buffer.alloc(48);
      if (!lib.symbols.QueryInformationJobObject(job, 1, ptr(accounting), 48, null)
        || accounting.readUInt32LE(40) !== 0) return false;
    }
    processHandle = BigInt(lib.symbols.OpenProcess(0x101000, 0, pid));
    if (!processHandle) return lib.symbols.GetLastError() === 87; // ERROR_INVALID_PARAMETER: PID absent
    const created = Buffer.alloc(8), exited = Buffer.alloc(8), kernel = Buffer.alloc(8), user = Buffer.alloc(8);
    if (!lib.symbols.GetProcessTimes(processHandle, ptr(created), ptr(exited), ptr(kernel), ptr(user))) return false;
    // A reused PID names another lifetime; it cannot keep the original Job alive.
    return created.readBigUInt64LE().toString() !== creationTime || lib.symbols.WaitForSingleObject(processHandle, 0) === 0;
  } finally {
    if (processHandle) lib.symbols.CloseHandle(processHandle);
    if (job) lib.symbols.CloseHandle(job);
    lib.close();
  }
}
