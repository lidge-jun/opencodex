import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
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

type RootTomlStringState =
  | { kind: "absent" }
  | { kind: "value"; value: string }
  | { kind: "invalid" };

/**
 * Parse the authoritative SQLite setting without changing the tolerant helper
 * used by injection/catalog readers. History ownership must distinguish a
 * missing key from a present value that Codex cannot interpret as a path.
 */
function readAuthoritativeRootTomlString(content: string, key: string): RootTomlStringState {
  let parsed: unknown;
  try {
    parsed = Bun.TOML.parse(content);
  } catch {
    return { kind: "invalid" };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { kind: "invalid" };
  const root = parsed as Record<string, unknown>;
  if (!Object.prototype.hasOwnProperty.call(root, key)) return { kind: "absent" };
  const value = root[key];
  if (typeof value !== "string" || value.trim() === "") return { kind: "invalid" };
  return { kind: "value", value: value.trim() };
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
  let configured: RootTomlStringState = { kind: "absent" };
  try {
    configured = readAuthoritativeRootTomlString(readConfig(configPath), "sqlite_home");
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
  if (configured.kind === "invalid") {
    throw new Error(`Codex config has an invalid sqlite_home setting: ${configPath}`);
  }
  const raw = configured.kind === "value"
    ? configured.value
    : (deps.env ?? process.env).CODEX_SQLITE_HOME?.trim() || "";
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

/** Active Codex diagnostic-log database, derived from the call-time SQLite root. */
export function resolveCodexLogsDbPath(deps: CodexSqliteHomeDeps = {}): string {
  return join(resolveCodexSqliteHome(deps), "logs_2.sqlite");
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

// ---------------------------------------------------------------------------
// Active Codex home resolution.
//
// These resolve `CODEX_HOME` at call time rather than at import time, which is
// what lets a test or a sibling-home probe point fixture state somewhere else
// after this module has already loaded. They live here, next to the constants
// they fall back to, so a caller that only needs a path never has to reach the
// catalog parser.
// ---------------------------------------------------------------------------

export function samePath(a: string, b: string): boolean {
  const left = resolve(a);
  const right = resolve(b);
  return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
}

export function activeCodexHome(): string | null {
  const raw = process.env.CODEX_HOME?.trim();
  if (!raw) return null;
  const path = resolve(expandUserPath(raw));
  try {
    return realpathSync.native(path);
  } catch {
    return path;
  }
}

export function activeCodexConfigPath(): string {
  const home = activeCodexHome();
  return home ? join(home, "config.toml") : CODEX_CONFIG_PATH;
}

export function activeDefaultCatalogPath(): string {
  const home = activeCodexHome();
  return home ? join(home, "opencodex-catalog.json") : DEFAULT_CATALOG_PATH;
}

export function activeCodexModelsCachePath(): string {
  const home = activeCodexHome();
  return home ? join(home, "models_cache.json") : CODEX_MODELS_CACHE_PATH;
}

export function resolveActiveCodexConfigPath(path: string): string {
  const home = activeCodexHome();
  return home ? resolve(home, path) : resolveCodexConfigPath(path);
}

export function isDefaultCatalogPath(path: string): boolean {
  return samePath(path, activeDefaultCatalogPath());
}

export function readCodexCatalogPath(): string {
  const home = activeCodexHome();
  if (home) return readCodexCatalogPathForHome(home);
  try {
    const configPath = activeCodexConfigPath();
    if (existsSync(configPath)) {
      const toml = readFileSync(configPath, "utf-8");
      const path = readRootTomlString(toml, "model_catalog_json");
      if (path) return resolveActiveCodexConfigPath(path);
    }
  } catch { /* ignore */ }
  return activeDefaultCatalogPath();
}

/**
 * Resolve the configured catalog without consulting ambient CODEX_HOME again.
 *
 * `configText` is for a caller that has already read that same `config.toml` under
 * its own constraints - the prompt-text probe reads it bounded, on the request
 * thread - so resolving the catalog does not cost a second, unbounded read of the
 * file the caller is holding. Omitting it keeps the original behaviour.
 */
export function readCodexCatalogPathForHome(codexHome: string, configText?: string): string {
  try {
    const configPath = join(codexHome, "config.toml");
    if (configText !== undefined || existsSync(configPath)) {
      const toml = configText ?? readFileSync(configPath, "utf-8");
      const path = readRootTomlString(toml, "model_catalog_json");
      if (path) return resolve(codexHome, path);
    }
  } catch { /* ignore */ }
  return join(codexHome, "opencodex-catalog.json");
}
