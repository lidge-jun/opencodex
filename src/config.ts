import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import type { OcxConfig } from "./types";

let _atomicSeq = 0;
/**
 * Write a file atomically (temp + rename) so concurrent writers — e.g. `ocx stop` and the
 * proxy's own shutdown handler both restoring Codex — can never leave a half-written file.
 */
export function atomicWriteFile(path: string, content: string): void {
  const tmp = `${path}.ocx.${process.pid}.${++_atomicSeq}.tmp`;
  writeFileSync(tmp, content, { encoding: "utf-8", mode: 0o600 });
  renameSync(tmp, path);
}

const OCX_DIR = join(homedir(), ".opencodex");
const CONFIG_FILE = "config.json";
const PID_FILE = "ocx.pid";
const warnedConfigFallbacks = new Set<string>();

const providerConfigSchema = z.object({
  adapter: z.string().min(1),
  baseUrl: z.string().min(1),
}).passthrough();

const configSchema = z.object({
  port: z.number().int().positive().default(10100),
  providers: z.record(z.string(), providerConfigSchema).refine(
    providers => Object.keys(providers).length > 0,
    "providers must contain at least one provider",
  ),
  defaultProvider: z.string().min(1),
}).passthrough();

/**
 * Default featured subagent models (native GPT) seeded on a fresh install and when `subagentModels`
 * is unset. Codex's spawn_agent advertises the first 5 featured catalog entries; these are the GPT
 * natives the installed Codex actually ships. The user can remove any in the GUI — once they set the
 * list (even to []), it is respected, so removals persist (start-up only seeds the UNSET case).
 * Kept to ids ChatGPT accepts; the start-up seed prefers the live catalog's native slugs.
 */
export const DEFAULT_SUBAGENT_MODELS = ["gpt-5.5", "gpt-5.4", "gpt-5.4-mini", "gpt-5.3-codex-spark"];

export function getConfigDir(): string {
  const override = process.env.OPENCODEX_HOME?.trim();
  return override || OCX_DIR;
}

export function getConfigPath(): string {
  return join(getConfigDir(), CONFIG_FILE);
}

export function getPidPath(): string {
  return join(getConfigDir(), PID_FILE);
}

export function hardenConfigDir(): void {
  const dir = getConfigDir();
  if (existsSync(dir)) {
    try { chmodSync(dir, 0o700); } catch { /* best-effort */ }
  }
}

export function hardenExistingSecret(path: string): void {
  if (existsSync(path)) {
    try { chmodSync(path, 0o600); } catch { /* best-effort */ }
  }
}

export function loadConfig(): OcxConfig {
  const configPath = getConfigPath();
  hardenConfigDir();
  hardenExistingSecret(configPath);
  hardenExistingSecret(join(getConfigDir(), "auth.json"));
  if (!existsSync(configPath)) {
    return getDefaultConfig();
  }
  try {
    const raw = readFileSync(configPath, "utf-8");
    return configSchema.parse(JSON.parse(raw)) as OcxConfig;
  } catch (error) {
    warnAndBackupInvalidConfig(configPath, error);
    return getDefaultConfig();
  }
}

export function saveConfig(config: OcxConfig): void {
  const dir = getConfigDir();
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  } else {
    try { chmodSync(dir, 0o700); } catch { /* best-effort on existing dir */ }
  }
  atomicWriteFile(getConfigPath(), JSON.stringify(config, null, 2) + "\n");
}

export function websocketsEnabled(config: Pick<OcxConfig, "websockets">): boolean {
  return config.websockets === true;
}

export function codexAutoStartEnabled(config: Pick<OcxConfig, "codexAutoStart">): boolean {
  return config.codexAutoStart !== false;
}

export function getDefaultConfig(): OcxConfig {
  // Fresh-install default: works out of the box with Codex's ChatGPT OAuth (no API key).
  // gpt-* requests forward the caller's incoming OAuth headers to the ChatGPT backend.
  // Adding extra providers (e.g. opencode-go) and switching defaultProvider is a user/runtime choice.
  return {
    port: 10100,
    providers: {
      openai: {
        adapter: "openai-responses",
        baseUrl: "https://chatgpt.com/backend-api/codex",
        authMode: "forward",
      },
    },
    defaultProvider: "openai",
    subagentModels: [...DEFAULT_SUBAGENT_MODELS],
    websockets: false,
    codexAutoStart: true,
  };
}

export function resolveEnvValue(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const match = value.match(/^\$\{(\w+)\}$/);
  if (match) return process.env[match[1]];
  if (value.startsWith("$")) return process.env[value.slice(1)];
  return value;
}

export function writePid(pid: number): void {
  const dir = getConfigDir();
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  } else {
    hardenConfigDir();
  }
  writeFileSync(getPidPath(), String(pid), "utf-8");
}

export function readPid(): number | null {
  const pidPath = getPidPath();
  if (!existsSync(pidPath)) return null;
  try {
    const raw = readFileSync(pidPath, "utf-8").trim();
    const pid = parseInt(raw, 10);
    if (isNaN(pid)) return null;
    try {
      process.kill(pid, 0);
      return pid;
    } catch (e: unknown) {
      if ((e as NodeJS.ErrnoException).code === "EPERM") return pid;
      return null;
    }
  } catch {
    return null;
  }
}

export function removePid(): void {
  try {
    const { unlinkSync } = require("node:fs");
    unlinkSync(getPidPath());
  } catch { /* ignore */ }
}

function warnAndBackupInvalidConfig(configPath: string, error: unknown): void {
  const key = configPath;
  if (warnedConfigFallbacks.has(key)) return;
  warnedConfigFallbacks.add(key);

  const backupPath = backupInvalidConfig(configPath);
  const reason = error instanceof z.ZodError
    ? error.issues.map(issue => `${issue.path.join(".") || "config"}: ${issue.message}`).join("; ")
    : error instanceof Error ? error.message : String(error);
  const backupNote = backupPath ? ` A backup was written to ${backupPath}.` : "";
  console.error(`⚠️  Could not load opencodex config at ${configPath}: ${reason}. Using default config.${backupNote}`);
}

function backupInvalidConfig(configPath: string): string | null {
  if (!existsSync(configPath)) return null;
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupPath = `${configPath}.invalid-${stamp}`;
  try {
    copyFileSync(configPath, backupPath);
    try { chmodSync(backupPath, 0o600); } catch { /* best-effort */ }
    return backupPath;
  } catch {
    return null;
  }
}
