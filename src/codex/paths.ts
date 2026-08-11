import { readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { expandUserPath } from "../config";
import { defaultCodexHome } from "./home";

function resolveCodexHome(): string {
  const raw = process.env.CODEX_HOME?.trim();
  if (raw) {
    const path = resolve(expandUserPath(raw));
    let stat;
    try {
      stat = statSync(path);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`CODEX_HOME points to ${raw}, but that path could not be read: ${message}`);
    }
    if (!stat.isDirectory()) {
      throw new Error(`CODEX_HOME points to ${raw}, but that path is not a directory`);
    }
    return realpathSync.native(path);
  }

  return defaultCodexHome();
}

export const CODEX_HOME = resolveCodexHome();
export const CODEX_CONFIG_PATH = join(CODEX_HOME, "config.toml");
export const CODEX_PROFILE_PATH = join(CODEX_HOME, "opencodex.config.toml");
export const DEFAULT_CATALOG_PATH = join(CODEX_HOME, "opencodex-catalog.json");
export const CODEX_MODELS_CACHE_PATH = join(CODEX_HOME, "models_cache.json");

/** Runtime CODEX_HOME lookup (honors CODEX_HOME env changes after import). */
export function getCodexHome(): string {
  return resolveCodexHome();
}

export interface CodexSqliteHomeDeps {
  env?: NodeJS.ProcessEnv;
  cwd?: () => string;
  codexHome?: string;
  readConfig?: (path: string) => string;
}

/**
 * Resolve Codex's SQLite state root at call time.
 *
 * Codex permits SQLite-backed state to live outside CODEX_HOME, especially for
 * Windows Desktop sessions whose app-server runs in WSL. Keep the precedence
 * identical to Codex: root config, then environment, then the effective home.
 */
export function resolveCodexSqliteHome(deps: CodexSqliteHomeDeps = {}): string {
  const codexHome = deps.codexHome ?? getCodexHome();
  const readConfig = deps.readConfig ?? (path => readFileSync(path, "utf8"));
  const configPath = join(codexHome, "config.toml");
  let configured = "";
  try {
    configured = readRootTomlString(readConfig(configPath), "sqlite_home")?.trim() ?? "";
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException | undefined)?.code !== "ENOENT") {
      throw new Error(
        `Codex config could not be read while resolving sqlite_home: ${configPath}`,
        { cause },
      );
    }
    // A genuinely absent config cannot contain the authoritative root override,
    // so only ENOENT may continue to the documented environment/home fallback.
  }
  const raw = configured || (deps.env ?? process.env).CODEX_SQLITE_HOME?.trim() || "";
  if (!raw) return codexHome;
  const expanded = expandUserPath(raw);
  return isAbsolute(expanded)
    ? resolve(expanded)
    : resolve((deps.cwd ?? process.cwd)(), expanded);
}

/** Active Codex thread-state database, derived from the call-time SQLite root. */
export function resolveCodexStateDbPath(deps: CodexSqliteHomeDeps = {}): string {
  return join(resolveCodexSqliteHome(deps), "state_5.sqlite");
}

export function tomlString(value: string): string {
  return JSON.stringify(value);
}

export function parseTomlString(raw: string): string {
  if (raw.startsWith("\"")) {
    try {
      return JSON.parse(raw) as string;
    } catch {
      return raw.slice(1, -1);
    }
  }
  return raw.slice(1, -1);
}

export function readRootTomlString(content: string, key: string): string | null {
  const lines = content.split("\n");
  const firstTable = lines.findIndex(l => /^\s*\[/.test(l));
  const rootLines = firstTable === -1 ? lines : lines.slice(0, firstTable);
  for (const line of rootLines) {
    const m = line.match(new RegExp(`^\\s*${key}\\s*=\\s*(\"(?:\\\\.|[^\"])*\"|'[^']*')`));
    if (m) return parseTomlString(m[1]);
  }
  return null;
}

export function resolveCodexConfigPath(path: string): string {
  return isAbsolute(path) ? path : join(CODEX_HOME, path);
}
