import { dlopen, ptr, read } from "bun:ffi";

/** Object identity, not merely a valid/reused numeric HANDLE in a different process. */
export function queryWindowsFixtureObjectName(handle: bigint): string | null {
  const nt = dlopen("ntdll.dll", {
    NtQueryObject: { args: ["u64", "i32", "ptr", "u32", "ptr"], returns: "i32" },
  });
  try {
    const bytes = Buffer.alloc(65536), size = Buffer.alloc(4);
    if (Number(nt.symbols.NtQueryObject!(handle, 1, ptr(bytes), bytes.length, ptr(size))) !== 0) return null;
    const length = bytes.readUInt16LE(), address = bytes.readBigUInt64LE(8);
    if (!length || length > 32768 || !address) return null;
    let result = "";
    for (let offset = 0; offset < length; offset += 2) result += String.fromCharCode(read.u16(address, offset));
    return result;
  } finally { nt.close(); }
}
