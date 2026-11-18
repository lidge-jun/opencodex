import { dlopen, ptr } from "bun:ffi";

const MAX_ARGV_BYTES = 64 * 1024;

/** Read argc, skip the executable path and padding, and keep the environment separate. */
function parseProcessArgs(bytes: Buffer): { argv: string[]; environment: Buffer } | undefined {
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
  return { argv, environment: bytes.subarray(start) };
}

function readDarwinStopProcessArgs(pid: number): ReturnType<typeof parseProcessArgs> {
  const lib = dlopen("/usr/lib/libSystem.B.dylib", {
    sysctl: { args: ["ptr", "u32", "ptr", "ptr", "ptr", "u64"], returns: "i32" },
  });
  try {
    const mib = new Int32Array([1, 49, pid]); // CTL_KERN, KERN_PROCARGS2, PID
    // The kernel returns argv with its environment. Bound the native read.
    const bytes = Buffer.alloc(1024 * 1024);
    const size = new BigUint64Array([BigInt(bytes.length)]);
    if (lib.symbols.sysctl(ptr(mib), mib.length, ptr(bytes), ptr(size), null, 0n) !== 0
      || size[0]! > BigInt(bytes.length)) return;
    return parseProcessArgs(bytes.subarray(0, Number(size[0])));
  } finally { lib.close(); }
}

export function readDarwinStopArgv(pid: number): string[] | undefined {
  return readDarwinStopProcessArgs(pid)?.argv;
}

export function readDarwinStopEnvironment(pid: number): Buffer | undefined {
  return readDarwinStopProcessArgs(pid)?.environment;
}

function readDarwinProcessInfo(pid: number, flavor: number, size: number): Buffer | undefined {
  const lib = dlopen("/usr/lib/libproc.dylib", {
    proc_pidinfo: { args: ["i32", "i32", "u64", "ptr", "i32"], returns: "i32" },
  });
  try {
    const info = Buffer.alloc(size);
    if (lib.symbols.proc_pidinfo(pid, flavor, 0n, ptr(info), size) === size) return info;
  } finally { lib.close(); }
}

/** PROC_PIDTBSDINFO supplies both the effective UID and microsecond process creation time. */
export function readDarwinStopStart(pid: number): string | undefined {
  // struct proc_bsdinfo from sys/proc_info.h, shared by arm64 and x86_64.
  const info = readDarwinProcessInfo(pid, 3, 136);
  if (!info || info.readUInt32LE(12) !== pid || info.readUInt32LE(20) !== process.geteuid?.()) return;
  const seconds = info.readBigUInt64LE(120);
  const micros = info.readBigUInt64LE(128);
  if (seconds > 0n && micros < 1_000_000n) return `darwin:${seconds}:${micros}`;
}

export function readDarwinStopCwd(pid: number): string | undefined {
  // PROC_PIDVNODEPATHINFO, struct proc_vnodepathinfo.pvi_cdir.vip_path[MAXPATHLEN].
  const info = readDarwinProcessInfo(pid, 9, 2352);
  const path = info?.subarray(152, 152 + 1024);
  const end = path?.indexOf(0) ?? -1;
  if (path && end > 0) return new TextDecoder("utf-8", { fatal: true }).decode(path.subarray(0, end));
}
