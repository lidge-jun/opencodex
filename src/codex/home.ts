import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, posix, resolve, win32 } from "node:path";
import { expandUserPath } from "../config";
import { redactUserPath } from "../lib/redact";

export type CodexHomeDeps = {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform | string;
  release?: string;
  procVersion?: string | null;
  homedir?: () => string;
  usersRoot?: string;
  /** Raw /etc/wsl.conf content override (tests); null means "no file". */
  wslConf?: string | null;
  existsSync?: (path: string) => boolean;
  readdirSync?: (path: string) => string[];
  statSync?: typeof statSync;
  realpathSync?: (path: string) => string;
};

function windowsUserProfileToWslPath(value: string | undefined, automountRoot = DEFAULT_WSL_AUTOMOUNT_ROOT): string | null {
  if (!value) return null;
  const normalized = value.replaceAll("\\", "/");
  const match = normalized.match(/^([A-Za-z]):\/Users\/([^/]+)$/);
  if (!match) return null;
  const root = normalizeAutomountRoot(automountRoot);
  return `${root === "/" ? "" : root}/${match[1]!.toLowerCase()}/Users/${match[2]}`;
}

const DEFAULT_WSL_AUTOMOUNT_ROOT = "/mnt";

function normalizeAutomountRoot(value: string): string {
  const trimmed = value.replace(/\/+$/, "");
  return trimmed === "" ? "/" : trimmed;
}

function readWslConf(): string | null {
  try {
    return readFileSync("/etc/wsl.conf", "utf8");
  } catch {
    return null;
  }
}

/**
 * Windows drive mount root inside WSL: `[automount] root` from /etc/wsl.conf,
 * default `/mnt` (https://learn.microsoft.com/en-us/windows/wsl/wsl-config).
 * Returns a path without a trailing slash (or `/` itself).
 */
export function wslAutomountRoot(deps: CodexHomeDeps = {}): string {
  const content = deps.wslConf !== undefined ? deps.wslConf : readWslConf();
  if (!content) return DEFAULT_WSL_AUTOMOUNT_ROOT;
  let section = "";
  for (const rawLine of content.split("\n")) {
    const line = rawLine.replace(/[#;].*$/, "").trim();
    if (!line) continue;
    const sect = line.match(/^\[(.+)\]$/);
    if (sect) {
      section = sect[1]!.trim().toLowerCase();
      continue;
    }
    if (section !== "automount") continue;
    const kv = line.match(/^root\s*=\s*(.+)$/i);
    if (kv) {
      const value = kv[1]!.trim().replace(/^["']|["']$/g, "");
      if (!value.startsWith("/")) return DEFAULT_WSL_AUTOMOUNT_ROOT;
      return normalizeAutomountRoot(value);
    }
  }
  return DEFAULT_WSL_AUTOMOUNT_ROOT;
}

function readProcVersion(): string | null {
  try {
    return readFileSync("/proc/version", "utf8");
  } catch {
    return null;
  }
}

export function isWslRuntime(deps: CodexHomeDeps = {}): boolean {
  if ((deps.platform ?? process.platform) !== "linux") return false;
  const env = deps.env ?? process.env;
  if (env.WSL_DISTRO_NAME || env.WSL_INTEROP) return true;
  const version = `${deps.release ?? ""}\n${deps.procVersion ?? readProcVersion() ?? ""}`;
  return /microsoft|wsl/i.test(version);
}

/** All Windows-profile `.codex` homes (with config.toml) visible from WSL, resolved real paths. */
export function listWslWindowsCodexHomes(deps: CodexHomeDeps = {}): string[] {
  if (!isWslRuntime(deps)) return [];
  const exists = deps.existsSync ?? existsSync;
  const stat = deps.statSync ?? statSync;
  const readdir = deps.readdirSync ?? readdirSync;
  const realpath = deps.realpathSync ?? realpathSync.native;
  const automountRoot = wslAutomountRoot(deps);
  // WSL mount paths are POSIX by definition; keep separators stable on any host.
  const usersRoot = deps.usersRoot ?? posix.join(automountRoot, "c", "Users");
  if (!exists(usersRoot)) return [];

  const candidates = [];
  try {
    for (const user of readdir(usersRoot)) {
      if (user === "Default" || user === "Default User" || user === "Public" || user === "All Users") continue;
      const home = posix.join(usersRoot, user, ".codex");
      const config = posix.join(home, "config.toml");
      if (!exists(config)) continue;
      try {
        if (stat(home).isDirectory()) candidates.push(realpath(home));
      } catch {
        // Ignore unreadable Windows profiles.
      }
    }
  } catch {
    return [];
  }
  return candidates;
}

export function findWslWindowsCodexHome(deps: CodexHomeDeps = {}): string | null {
  const env = deps.env ?? process.env;
  const candidates = listWslWindowsCodexHomes(deps);
  if (candidates.length === 0) return null;

  const explicitProfile = windowsUserProfileToWslPath(env.USERPROFILE, wslAutomountRoot(deps));
  if (explicitProfile) {
    const explicitHome = posix.join(explicitProfile, ".codex");
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

export type OrcaCodexHomeDiagnostic = {
  applicable: boolean;
  mismatch: boolean;
  effectiveCodexHome: string;
  appCodexHome: string;
  orcaCodexHome: string | null;
  warning: string | null;
  action: string | null;
};

type OrcaCodexHomeDeps = CodexHomeDeps & {
  effectiveCodexHome?: string;
  appCodexHome?: string;
};

function normalizedWindowsPath(path: string): string {
  return path.trim().replaceAll("/", "\\").replace(/\\+$/, "").toLowerCase();
}

/**
 * High-confidence Orca/ChatGPT dual-home diagnosis. Explicit CODEX_HOME remains
 * authoritative; this only explains when an Orca-owned shell targets a home the
 * Windows ChatGPT/Codex app does not read.
 */
export function collectOrcaCodexHomeDiagnostic(deps: OrcaCodexHomeDeps = {}): OrcaCodexHomeDiagnostic {
  const platform = deps.platform ?? process.platform;
  const env = deps.env ?? process.env;
  const effectiveCodexHome = deps.effectiveCodexHome ?? resolveCodexHomeDir(deps);
  const appCodexHome = deps.appCodexHome
    ?? (platform === "win32" ? win32.join((deps.homedir ?? homedir)(), ".codex") : join((deps.homedir ?? homedir)(), ".codex"));
  const explicitHome = env.CODEX_HOME?.trim() ?? "";
  const orcaCodexHome = env.ORCA_CODEX_HOME?.trim() || null;
  const normalizedEffective = normalizedWindowsPath(effectiveCodexHome);
  const normalizedOrca = orcaCodexHome ? normalizedWindowsPath(orcaCodexHome) : "";
  const normalizedApp = normalizedWindowsPath(appCodexHome);
  const applicable = platform === "win32"
    && !!explicitHome
    && !!orcaCodexHome
    && normalizedEffective === normalizedOrca
    && /(?:^|\\)orca\\codex-runtime-home\\home$/i.test(normalizedOrca);
  const mismatch = applicable && normalizedEffective !== normalizedApp;
  const displayEffective = redactUserPath(effectiveCodexHome);
  const displayApp = redactUserPath(appCodexHome);
  const displayOrca = orcaCodexHome ? redactUserPath(orcaCodexHome) : null;
  return {
    applicable,
    mismatch,
    effectiveCodexHome: displayEffective,
    appCodexHome: displayApp,
    orcaCodexHome: displayOrca,
    warning: mismatch
      ? `CODEX_HOME targets Orca's runtime home (${displayEffective}), while the Windows ChatGPT/Codex app uses ${displayApp}; OpenCodex injection will not reach that app.`
      : null,
    action: mismatch
      ? "If a service was installed from Orca, run 'ocx service uninstall' in that original Orca shell first. Then in Command Prompt run set \"ORCA_CODEX_HOME=\" and set \"CODEX_HOME=%USERPROFILE%\\.codex\"; or in PowerShell run Remove-Item Env:ORCA_CODEX_HOME -ErrorAction SilentlyContinue; $env:CODEX_HOME = Join-Path $env:USERPROFILE '.codex'. Rerun the command, then reinstall with 'ocx service install'."
      : null,
  };
}
