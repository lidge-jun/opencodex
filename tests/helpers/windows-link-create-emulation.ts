import { dirname, resolve } from "node:path";

/**
 * Make POSIX create files the way Windows does when the name is a symbolic link.
 *
 * Windows CreateFile/NtCreateFile with CREATE_NEW reparses a symbolic link at the final component
 * and creates the link's target; POSIX O_CREAT|O_EXCL refuses the link instead. Code that creates
 * a file and only afterwards checks for a link therefore passes on macOS and Linux and writes
 * outside its directory on Windows. With this installed, an exclusive create through a link opens
 * the resolved target, so the same mistake fails on every platform.
 *
 * Bun binds `import { openSync } from "node:fs"` when the importing module loads, so this must run
 * before the code under test is imported: use it from a `--preload` script.
 */
export function installWindowsLinkCreateEmulation(): () => void {
  const fs = require("node:fs") as typeof import("node:fs");
  const original = fs.openSync;
  const { O_CREAT, O_EXCL } = fs.constants;
  const exclusive = (flags: unknown): boolean =>
    typeof flags === "string" ? flags.includes("x")
      : typeof flags === "number" && (flags & O_CREAT) !== 0 && (flags & O_EXCL) !== 0;
  fs.openSync = ((path: unknown, flags?: unknown, mode?: unknown) => {
    if (typeof path === "string" && exclusive(flags)) {
      let link: string | undefined;
      try { if (fs.lstatSync(path).isSymbolicLink()) link = fs.readlinkSync(path); } catch { /* absent */ }
      if (link !== undefined) return (original as Function)(resolve(dirname(path), link), flags, mode);
    }
    return (original as Function)(path, flags, mode);
  }) as typeof fs.openSync;
  return () => { fs.openSync = original; };
}
