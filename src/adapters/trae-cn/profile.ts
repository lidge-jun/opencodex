import { existsSync } from "node:fs";
import { join } from "node:path";
import { whichFromPath, type PathLookupDeps } from "../coding-agent/profile";
import { baseScopedEnv } from "../coding-agent/turn";

export const TRAE_CN_BASE_URL = "https://www.trae.cn";

/** Accept the canonical TRAE CN destination, including an optional trailing slash. */
export function traeCnDestinationMatches(baseUrl: string | undefined): boolean {
  return baseUrl?.replace(/\/+$/, "").toLowerCase() === TRAE_CN_BASE_URL;
}

/** Keep the child environment scoped while preserving the selected official CLI directory. */
export function traeCnChildEnv(): Record<string, string> {
  return { ...baseScopedEnv(), NO_COLOR: "1", ...(process.env.TRAE_HOME ? { TRAE_HOME: process.env.TRAE_HOME } : {}) };
}

/** Find an installed CLI on PATH or at its standard user-local installation path. */
export function resolveTraeCli(deps: PathLookupDeps = {}): string | undefined {
  const onPath = whichFromPath("traecli", deps);
  if (onPath) return onPath;
  const platform = deps.platform ?? process.platform;
  const home = (deps.env ?? process.env)[platform === "win32" ? "USERPROFILE" : "HOME"];
  if (!home) return undefined;
  const local = join(home, ".local", "bin", platform === "win32" ? "traecli.exe" : "traecli");
  return (deps.exists ?? existsSync)(local) ? local : undefined;
}
