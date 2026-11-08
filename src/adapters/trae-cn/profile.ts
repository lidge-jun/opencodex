import { existsSync } from "node:fs";
import { join } from "node:path";
import { whichFromPath, type PathLookupDeps } from "../coding-agent/profile";
import { baseScopedEnv } from "../coding-agent/turn";

export const TRAE_CN_BASE_URL = "https://www.trae.cn";

export function traeCnDestinationMatches(baseUrl: string | undefined): boolean {
  return baseUrl?.replace(/\/+$/, "").toLowerCase() === TRAE_CN_BASE_URL;
}

export function traeCnChildEnv(): Record<string, string> {
  return { ...baseScopedEnv(), NO_COLOR: "1" };
}

export function resolveTraeCli(deps: PathLookupDeps = {}): string | undefined {
  const onPath = whichFromPath("traecli", deps);
  if (onPath) return onPath;
  const platform = deps.platform ?? process.platform;
  const home = (deps.env ?? process.env)[platform === "win32" ? "USERPROFILE" : "HOME"];
  if (!home) return undefined;
  const local = join(home, ".local", "bin", platform === "win32" ? "traecli.exe" : "traecli");
  return (deps.exists ?? existsSync)(local) ? local : undefined;
}
