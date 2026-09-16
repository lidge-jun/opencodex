import { accessSync, constants, statSync } from "node:fs";
import { posix, win32 } from "node:path";

function executableCandidate(path: string, platform: NodeJS.Platform): boolean {
  try {
    if (!statSync(path).isFile()) return false;
    accessSync(path, platform === "win32" ? constants.F_OK : constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Resolve only durable PATH entries; an empty/current-directory entry is never trusted. */
export function findExecutableOnPath(name: string, options: {
  path?: string;
  pathExt?: string;
  platform?: NodeJS.Platform;
  /** Pure cross-platform test seam; production checks the real filesystem. */
  probe?: (candidate: string) => boolean;
} = {}): string | null {
  const path = options.path ?? process.env.PATH;
  const platform = options.platform ?? process.platform;
  if (!path) return null;
  const paths = platform === "win32" ? win32 : posix;
  const spawnableWindowsExtensions = new Set([".com", ".exe", ".bat", ".cmd"]);
  const suffixes = platform === "win32"
    ? (options.pathExt ?? process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD")
      .split(";")
      .map(value => value.trim())
      .filter(value => spawnableWindowsExtensions.has(value.toLowerCase()))
    : [""];
  if (platform === "win32" && win32.extname(name)) suffixes.unshift("");
  const probe = options.probe ?? (candidate => executableCandidate(candidate, platform));
  for (const directory of path.split(paths.delimiter)) {
    if (!directory) continue;
    for (const suffix of suffixes) {
      const candidate = paths.join(directory, `${name}${suffix.toLowerCase()}`);
      if (probe(candidate)) return candidate;
    }
  }
  return null;
}
