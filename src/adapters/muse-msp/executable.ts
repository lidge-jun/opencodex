import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { whichFromPath } from "../coding-agent/profile";

/** Resolve the native installed Muse binary without invoking a shell dispatcher. */
export function findMuseExecutable(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string | undefined {
  const usableFile = (path: string): boolean => { try { return isAbsolute(path) && statSync(path).isFile(); } catch { return false; } };
  const pathCandidate = whichFromPath("muse", { env, platform });
  if (platform !== "win32") return pathCandidate && usableFile(pathCandidate) ? pathCandidate : undefined;
  if (pathCandidate && /\.exe$/i.test(pathCandidate) && usableFile(pathCandidate)) return pathCandidate;
  const directories = [pathCandidate && /\.cmd$/i.test(pathCandidate) ? dirname(pathCandidate) : undefined,
    env.LOCALAPPDATA ? join(env.LOCALAPPDATA, "Programs", "muse") : undefined];
  for (const directory of directories) {
    if (!directory) continue;
    try {
      const versionFile = join(directory, ".muse-version");
      if (!existsSync(versionFile) || statSync(versionFile).size > 128) continue;
      const version = readFileSync(versionFile, "utf8").trim();
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/.test(version) || version.includes("..")) continue;
      const executable = join(directory, `muse-bin-${version}.exe`);
      if (usableFile(executable)) return executable;
    } catch { /* Broken or inaccessible installation: try the next candidate. */ }
  }
  return undefined;
}
