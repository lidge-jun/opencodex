import { dlopen, ptr } from "bun:ffi";

const MAX_ARGV_BYTES = 64 * 1024;

/** Read argc, skip the executable path and padding, then decode argv only. */
function parseProcessArgs(bytes: Buffer): string[] | undefined {
  if (bytes.length < 5) return;
  const argc = bytes.readInt32LE(0);
  if (argc < 1 || argc > 4096) return;
  let start = bytes.indexOf(0, 4);
  if (start < 5) return;
  while (bytes[start] === 0) start++;
  const argv: string[] = [];
  const decode = new TextDecoder("utf-8", { fatal: true });
  for (let index = 0; index < argc; index++) {
    const end = bytes.indexOf(0, start);
    if (end < start || end >= MAX_ARGV_BYTES) return;
    argv.push(decode.decode(bytes.subarray(start, end)));
    start = end + 1;
  }
  return argv;
}

export function readDarwinStopArgv(pid: number): string[] | undefined {
  const lib = dlopen("/usr/lib/libSystem.B.dylib", {
    sysctl: { args: ["ptr", "u32", "ptr", "ptr", "ptr", "u64"], returns: "i32" },
  });
  try {
    const mib = new Int32Array([1, 49, pid]); // CTL_KERN, KERN_PROCARGS2, PID
    // The kernel returns argv with its environment. Bound the native read and never decode the environment.
    const bytes = Buffer.alloc(1024 * 1024);
    const size = new BigUint64Array([BigInt(bytes.length)]);
    if (lib.symbols.sysctl(ptr(mib), mib.length, ptr(bytes), ptr(size), null, 0n) !== 0
      || size[0]! > BigInt(bytes.length)) return;
    return parseProcessArgs(bytes.subarray(0, Number(size[0])));
  } finally { lib.close(); }
}

/** PROC_PIDTBSDINFO supplies both the effective UID and microsecond process creation time. */
export function readDarwinStopStart(pid: number): string | undefined {
  const lib = dlopen("/usr/lib/libproc.dylib", {
    proc_pidinfo: { args: ["i32", "i32", "u64", "ptr", "i32"], returns: "i32" },
  });
  try {
    // struct proc_bsdinfo from sys/proc_info.h, shared by arm64 and x86_64.
    const info = Buffer.alloc(136);
    if (lib.symbols.proc_pidinfo(pid, 3, 0n, ptr(info), info.length) !== info.length
      || info.readUInt32LE(12) !== pid || info.readUInt32LE(20) !== process.geteuid?.()) return;
    const seconds = info.readBigUInt64LE(120);
    const micros = info.readBigUInt64LE(128);
    if (seconds > 0n && micros < 1_000_000n) return `darwin:${seconds}:${micros}`;
  } finally { lib.close(); }
}
