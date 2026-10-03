import { accessSync, closeSync, constants, existsSync, fstatSync, lstatSync, openSync, readSync, realpathSync, statSync } from "node:fs";
import { posix, win32 } from "node:path";
import { isWslRuntime, wslAutomountRoot } from "./home";
import { SHIM_MARKER } from "./shim-templates";

/**
 * A PATH entry that reaches Windows through WSL drive interop
 * (`<automount-root>/<drive>/...`; root defaults to /mnt, configurable via
 * /etc/wsl.conf [automount] root).
 */
export function isWindowsInteropDir(dir: string, automountRoot = "/mnt"): boolean {
  const root = automountRoot.replace(/\/+$/, "");
  const escaped = root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^${escaped}/[a-z](/|$)`, "i").test(dir);
}

export type CodexPathScanDeps = {
  pathValue?: string;
  wsl?: boolean;
  /** Treat PATH entries as POSIX paths (WSL context). Defaults to wsl || non-win32. */
  posixPaths?: boolean;
  automountRoot?: string;
  exists?: (path: string) => boolean;
  isShimFile?: (path: string) => boolean;
  isDirectory?: (path: string) => boolean;
  realpath?: (path: string) => string;
};

export type CodexPathCandidate = {
  path: string;
  isShim: boolean;
};

export function realIsDirectory(path: string): boolean {
  try {
    return lstatSync(path).isDirectory();
  } catch {
    return true; // unreadable -> treat as unusable
  }
}

const SHIM_HEADER_MAX_BYTES = 16 * 1024;

function inspectShimFile(path: string): boolean | null {
  if (process.platform !== "win32") {
    try {
      // POSIX shells skip non-executable files, including symlink targets.
      accessSync(path, constants.X_OK);
    } catch {
      return null;
    }
  }
  let fd: number | undefined;
  try {
    // Follow npm launcher symlinks, but never read a known special file.
    if (!statSync(path).isFile()) return null;
    const flags = constants.O_RDONLY | (process.platform === "win32" ? 0 : constants.O_NONBLOCK);
    fd = openSync(path, flags);
    // The entry can change after stat; a replacement FIFO must not block open or read.
    if (!fstatSync(fd).isFile()) return null;
    const header = Buffer.allocUnsafe(SHIM_HEADER_MAX_BYTES);
    let total = 0;
    while (total < header.length) {
      const count = readSync(fd, header, total, header.length - total, total);
      if (count === 0) break;
      total += count;
    }
    return header.subarray(0, total).toString("utf8").includes(SHIM_MARKER);
  } catch {
    // An unreadable command still shadows later PATH entries; do not claim they are active.
    return false;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function commandNames(name: string): string[] {
  if (process.platform !== "win32") return [name];
  const exts = (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD;.PS1").split(";").filter(Boolean);
  return [name, ...exts.flatMap(ext => [`${name}${ext.toLowerCase()}`, `${name}${ext.toUpperCase()}`])];
}

/** The shell-local bin directory that fnm creates for one interactive shell. */
export function isFnmMultishellPath(path: string, posixPaths: boolean): boolean {
  const normalized = (posixPaths
    ? posix.normalize(path)
    : win32.normalize(path).replace(/\\/g, "/")).toLowerCase();
  return /(?:^|\/)fnm_multishells?(?:\/|$)/.test(normalized);
}

/** Find the command the shell would actually use, including an OpenCodex shim. */
export function findFirstCodexOnPath(deps: CodexPathScanDeps = {}): CodexPathCandidate | null {
  const exists = deps.exists ?? existsSync;
  const shimFile = deps.isShimFile ?? inspectShimFile;
  const isDir = deps.isDirectory ?? realIsDirectory;
  const wsl = deps.wsl ?? (process.platform === "linux" && isWslRuntime());
  const usePosix = deps.posixPaths ?? (wsl || process.platform !== "win32");
  const joinPath = usePosix ? posix.join : win32.join;
  const pathSep = usePosix ? ":" : win32.delimiter;
  const automountRoot = deps.automountRoot ?? (wsl ? wslAutomountRoot() : "/mnt");
  const interopNames = ["codex", "codex.exe", "codex.cmd", "codex.ps1"];

  for (const dir of (deps.pathValue ?? process.env.PATH ?? "").split(pathSep).filter(Boolean)) {
    if (wsl && isWindowsInteropDir(dir, automountRoot)) continue;
    const names = isWindowsInteropDir(dir, automountRoot) ? interopNames : commandNames("codex");
    for (const name of names) {
      const path = joinPath(dir, name);
      if (!exists(path) || isDir(path)) continue;
      const isShim = shimFile(path);
      if (isShim !== null) return { path, isShim };
    }
  }
  return null;
}

/**
 * Resolve a Codex command discovered through fnm's temporary PATH entry.
 *
 * A temporary path is safe to use only when its physical target is outside the
 * temporary tree. Returning null is deliberate: callers must not wrap the
 * shell-local path or silently choose a lower-priority Codex installation.
 */
export function resolveStableFnmCodexPath(
  path: string,
  posixPaths: boolean,
  realpath: ((path: string) => string) | undefined = realpathSync.native,
): string | null {
  if (!isFnmMultishellPath(path, posixPaths)) return path;
  try {
    // fnm normally links the temporary directory to the durable installation,
    // while npm may link the command file again into its package internals.
    // Resolve only the directory so the command basename remains the stable
    // installation entry that the installer is allowed to replace.
    const pathTools = posixPaths ? posix : win32;
    const resolvedParent = realpath(pathTools.dirname(path));
    if (!resolvedParent || isFnmMultishellPath(resolvedParent, posixPaths) || !pathTools.isAbsolute(resolvedParent)) return null;
    return pathTools.join(resolvedParent, pathTools.basename(path));
  } catch {
    return null;
  }
}
