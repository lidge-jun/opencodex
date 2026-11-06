import { readFileSync } from "node:fs";
import * as path from "node:path/posix";
import { repoPath } from "./repo-root";

// Run the production walks and FFI adapter on every host. Only imported IO,
// platform identity and the FFI implementation are modeled; no policy is copied.
const source = readFileSync(repoPath("src/cli/codex-launch-ownership.ts"), "utf8")
  .replace(/^import .*;\r?\n/gm, "")
  .replace('require("bun:ffi")', "ffi")
  .replace(/export function /g, "function ");
const js = new Bun.Transpiler({ loader: "ts", target: "bun" }).transformSync(source);

export type DarwinWalk = "home" | "alias" | "namespace";
export type DarwinFault = "none" | "vanished" | "inode" | "device" | "type" | "stat" | "close" | "errno" | "wide-inode" | "link-file" | "link-directory";

export function darwinOwnershipModel(walk: DarwinWalk, fault: DarwinFault, errno = 13, preferencesForced = false) {
  const home = "/owned/home", config = home + "/config.toml", link = "/owned/alias", system = "/owned/system";
  const target = walk === "home" ? config : walk === "alias" ? link : system;
  const opened = new Map<number, string>(), closed: number[] = [], flags: number[] = [];
  const descriptors = new Map<number, ReturnType<typeof stat>>();
  let reached = false, nextFd = 10, aclReads = 0, forcedReads = 0;
  const missing = () => Object.assign(new Error("modeled missing entry"), { code: "ENOENT" });
  function stat(entry: string, options?: { bigint?: boolean }, kind = entry === link ? 0o120000 : entry === config ? 0o100000 : 0o040000) {
    if (/\/(?:config|requirements|managed_config)\.toml$/.test(entry) && entry !== config) throw missing();
    const ino = fault === "wide-inode" && entry === target ? 9007199254740992n : BigInt(entry.length);
    return { dev: options?.bigint ? 1n : 1, ino: options?.bigint ? ino : Number(ino),
      mode: options?.bigint ? BigInt(kind | 0o700) : kind | 0o700, uid: options?.bigint ? 101n : 101,
      isFile: () => kind === 0o100000, isDirectory: () => kind === 0o040000, isSymbolicLink: () => kind === 0o120000 };
  }
  const io = {
    lstatSync: stat,
    readlinkSync: () => config,
    openSync(entry: string, value: number) {
      if (entry === target) { reached = true; flags.push(value); if (fault === "vanished") throw missing(); }
      // XNU vn_authorize_open_existing: VLNK + O_NOFOLLOW is ELOOP,
      // including when O_SYMLINK is also set (bsd/vfs/vfs_subr.c).
      const kind = entry === target && fault === "link-file" ? 0o100000
        : entry === target && fault === "link-directory" ? 0o040000 : undefined;
      let actual = stat(entry, { bigint: true }, kind);
      if (actual.isSymbolicLink()) {
        if (value & 0x100) throw Object.assign(new Error("modeled final symlink"), { code: "ELOOP" });
        if (!(value & 0x200000)) actual = stat(config, { bigint: true });
      }
      // O_SYMLINK also opens non-links. Retain that object for fstat even
      // when a replacement has the old dev/ino; its type must still differ.
      const fd = nextFd++; opened.set(fd, entry); descriptors.set(fd, actual); return fd;
    },
    fstatSync(fd: number, options?: { bigint?: boolean }) {
      const entry = opened.get(fd)!, value = descriptors.get(fd)!;
      if (entry !== target) return value;
      if (fault === "stat") throw new Error("modeled fstat failure");
      const ino = BigInt(value.ino) + (fault === "inode" || fault === "wide-inode" ? 1n : 0n);
      return { ...value, ino: options?.bigint ? ino : Number(ino),
        dev: fault === "device" ? (options?.bigint ? 2n : 2) : value.dev,
        mode: fault === "type" ? (options?.bigint ? BigInt(Number(value.mode) ^ 0o140000) : Number(value.mode) ^ 0o140000) : value.mode };
    },
    closeSync(fd: number) { closed.push(fd); if (fault === "close" && opened.get(fd) === target) throw new Error("modeled close failure"); },
  };
  const symbols = {
    // These pathname APIs intentionally model the old ambiguous NULL/ENOENT.
    acl_get_file: pathnameAcl, acl_get_link_np: pathnameAcl,
    acl_get_fd_np(fd: number) { aclReads++; return null; },
    __error: () => 1,
    CFStringCreateWithCString: () => 1,
    CFPreferencesAppValueIsForced: () => { forcedReads++; return preferencesForced; },
    CFRelease() {},
  };
  function pathnameAcl(value: Buffer) {
    const entry = value.toString().replace(/\0$/, "");
    if (entry === target) reached = true;
    aclReads++; return null;
  }
  const ffi = { FFIType: { ptr: 1, i32: 2, u32: 3, bool: 4, void: 5 }, ptr: (value: Buffer) => value,
    read: { i32: () => fault === "errno" ? errno : 2 }, dlopen: () => ({ symbols, close() {} }) };
  const { dirname, isAbsolute, join, resolve, sep } = path;
  const inputs = { ...io, dirname, isAbsolute, join, resolve, sep, process: { platform: "darwin", getuid: () => 101 }, ffi };
  const api = new Function(...Object.keys(inputs), js +
    "\nreturn { codexLaunchHomeIsOwned, codexLaunchProjectAliasIsOwned, codexLaunchSystemNamespaceIsSafe };")(...Object.values(inputs));
  const admitted = walk === "home" ? api.codexLaunchHomeIsOwned(home)
    : walk === "alias" ? api.codexLaunchProjectAliasIsOwned(link) : api.codexLaunchSystemNamespaceIsSafe(system);
  return { admitted, reached, flags, opened: [...opened.keys()], closed, aclReads, forcedReads };
}
