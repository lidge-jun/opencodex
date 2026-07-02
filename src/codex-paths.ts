import { realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { expandUserPath } from "./config";

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

  return join(homedir(), ".codex");
}

export const CODEX_HOME = resolveCodexHome();
export const CODEX_CONFIG_PATH = join(CODEX_HOME, "config.toml");
export const CODEX_PROFILE_PATH = join(CODEX_HOME, "opencodex.config.toml");
export const DEFAULT_CATALOG_PATH = join(CODEX_HOME, "opencodex-catalog.json");
export const CODEX_MODELS_CACHE_PATH = join(CODEX_HOME, "models_cache.json");

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
