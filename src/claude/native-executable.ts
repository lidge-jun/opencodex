import { accessSync, closeSync, constants, fstatSync, openSync, readSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, isAbsolute, join, resolve } from "node:path";

export const CLAUDE_SHIM_MARKER = "# OpenCodex Claude command shim v1";

/** Follow vendor symlinks, but reject our own wrappers even through aliases or other OCX homes. */
export function isNativePosixClaude(path: string): boolean {
  if (!isAbsolute(path)) return false;
  try {
    if (!statSync(path).isFile()) return false;
    accessSync(path, constants.X_OK);
    const fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
    try {
      if (!fstatSync(fd).isFile()) return false;
      const prefix = Buffer.alloc(160);
      const count = readSync(fd, prefix, 0, prefix.length, 0);
      return !prefix.subarray(0, count).toString().includes(CLAUDE_SHIM_MARKER);
    } finally {
      closeSync(fd);
    }
  } catch {
    return false;
  }
}

export function findNativePosixClaude(path = process.env.PATH ?? "", home = homedir()): string | undefined {
  return [...path.split(delimiter).filter(Boolean).map(dir => resolve(dir, "claude")), join(home, ".local", "bin", "claude")]
    .find(isNativePosixClaude);
}

export function supportsClaudeShim(platform = process.platform): boolean {
  return platform === "darwin" || platform === "linux";
}
