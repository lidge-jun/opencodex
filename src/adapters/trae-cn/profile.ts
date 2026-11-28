import { posix, win32 } from "node:path";
import { whichFromPath, type PathLookupDeps } from "../coding-agent/profile";
import { baseScopedEnv } from "../coding-agent/turn";

export const TRAE_CN_BASE_URL = "https://www.trae.cn";

/** Accept the canonical TRAE CN destination, including an optional trailing slash. */
export function traeCnDestinationMatches(baseUrl: string | undefined): boolean {
  return baseUrl?.replace(/\/+$/, "").toLowerCase() === TRAE_CN_BASE_URL;
}

/** Preserve the CLI's documented config directory before replacing the child's HOME. */
export function traeCnChildEnv(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): Record<string, string> {
  const pathApi = platform === "win32" ? win32 : posix;
  const home = env[platform === "win32" ? "USERPROFILE" : "HOME"];
  const traeHome = env.TRAE_HOME ? pathApi.resolve(env.TRAE_HOME) : home ? pathApi.resolve(home, ".trae") : undefined;
  return { ...baseScopedEnv(), NO_COLOR: "1", ...(traeHome ? { TRAE_HOME: traeHome } : {}) };
}

/** Find an installed CLI on PATH or at its standard user-local installation path. */
export function resolveTraeCli(deps: PathLookupDeps = {}): string | undefined {
  const platform = deps.platform ?? process.platform;
  const onPath = whichFromPath("traecli", deps);
  if (onPath) return (platform === "win32" ? win32 : posix).resolve(onPath);
  const home = (deps.env ?? process.env)[platform === "win32" ? "USERPROFILE" : "HOME"];
  if (!home) return undefined;
  const directory = (platform === "win32" ? win32 : posix).resolve(home, ".local", "bin");
  return whichFromPath("traecli", { ...deps, platform, env: { PATH: directory } });
}
