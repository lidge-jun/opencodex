import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { expandUserPath } from "../config";

export type CodexHomeDeps = {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform | string;
  release?: string;
  procVersion?: string | null;
  homedir?: () => string;
  usersRoot?: string;
  existsSync?: (path: string) => boolean;
  readdirSync?: (path: string) => string[];
  statSync?: typeof statSync;
  realpathSync?: (path: string) => string;
};

function windowsUserProfileToWslPath(value: string | undefined): string | null {
  if (!value) return null;
  const normalized = value.replaceAll("\\", "/");
  const match = normalized.match(/^([A-Za-z]):\/Users\/([^/]+)$/);
  if (!match) return null;
  return `/mnt/${match[1]!.toLowerCase()}/Users/${match[2]}`;
}

function readProcVersion(): string | null {
  try {
    return readFileSync("/proc/version", "utf8");
  } catch {
    return null;
  }
}

export function isWslRuntime(deps: CodexHomeDeps = {}): boolean {
  const env = deps.env ?? process.env;
  if (env.WSL_DISTRO_NAME || env.WSL_INTEROP) return true;
  if ((deps.platform ?? process.platform) !== "linux") return false;
  const version = `${deps.release ?? ""}\n${deps.procVersion ?? readProcVersion() ?? ""}`;
  return /microsoft|wsl/i.test(version);
}

export function findWslWindowsCodexHome(deps: CodexHomeDeps = {}): string | null {
  if (!isWslRuntime(deps)) return null;
  const exists = deps.existsSync ?? existsSync;
  const stat = deps.statSync ?? statSync;
  const readdir = deps.readdirSync ?? readdirSync;
  const realpath = deps.realpathSync ?? realpathSync.native;
  const env = deps.env ?? process.env;
  const usersRoot = deps.usersRoot ?? "/mnt/c/Users";
  if (!exists(usersRoot)) return null;

  const explicitProfile = windowsUserProfileToWslPath(env.USERPROFILE);
  const candidates = [];
  try {
    for (const user of readdir(usersRoot)) {
      if (user === "Default" || user === "Default User" || user === "Public" || user === "All Users") continue;
      const home = join(usersRoot, user, ".codex");
      const config = join(home, "config.toml");
      if (!exists(config)) continue;
      try {
        if (stat(home).isDirectory()) candidates.push(realpath(home));
      } catch {
        // Ignore unreadable Windows profiles.
      }
    }
  } catch {
    return null;
  }

  if (explicitProfile) {
    const explicitHome = join(explicitProfile, ".codex");
    const match = candidates.find(candidate => candidate === explicitHome || candidate.endsWith(`/${explicitProfile.split("/").pop()}/.codex`));
    if (match) return match;
  }
  return candidates.length === 1 ? candidates[0]! : null;
}

export function defaultCodexHome(deps: CodexHomeDeps = {}): string {
  const home = (deps.homedir ?? homedir)();
  const defaultHome = join(home, ".codex");
  const exists = deps.existsSync ?? existsSync;
  const detected = !exists(join(defaultHome, "config.toml")) ? findWslWindowsCodexHome(deps) : null;
  return detected ?? defaultHome;
}

export function resolveCodexHomeDir(deps: CodexHomeDeps = {}): string {
  const raw = (deps.env ?? process.env).CODEX_HOME?.trim();
  if (raw) return resolve(expandUserPath(raw));
  return defaultCodexHome(deps);
}
