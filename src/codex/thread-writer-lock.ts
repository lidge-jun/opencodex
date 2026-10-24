import { dlopen, ptr } from "bun:ffi";

let kernel: ReturnType<typeof openKernel> | undefined;
function openKernel() {
  return dlopen("kernel32.dll", {
    CreateFileW: { args: ["ptr", "u32", "u32", "ptr", "u32", "u32", "ptr"], returns: "i64" },
    ReadFile: { args: ["i64", "ptr", "u32", "ptr", "ptr"], returns: "i32" },
    GetLastError: { args: [], returns: "u32" },
    CloseHandle: { args: ["i64"], returns: "i32" },
  });
}

/** 只读观察原生写入锁；不创建文件，也不获取或释放原生进程的锁。 */
export function nativeThreadWriterHeld(path: string): boolean {
  if (process.platform !== "win32") return false;
  try {
    const api = (kernel ??= openKernel()).symbols;
    const name = Buffer.from(path + "\0", "utf16le");
    const handle = api.CreateFileW(ptr(name), 0x80000000, 7, null, 3, 0, null);
    if (Number(handle) === -1) return false;
    try {
      const byte = Buffer.alloc(1), read = Buffer.alloc(4);
      const ok = api.ReadFile(handle, ptr(byte), 1, ptr(read), null);
      return !ok && api.GetLastError() === 33;
    } finally { api.CloseHandle(handle); }
  } catch { return false; }
}
