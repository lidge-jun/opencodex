import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
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
const CONFIG_PATH = join(OCX_DIR, "config.json");
const PID_PATH = join(OCX_DIR, "ocx.pid");

/**
 * Default featured subagent models (native GPT) seeded on a fresh install and when `subagentModels`
 * is unset. Codex's spawn_agent advertises the first 5 featured catalog entries; these are the GPT
 * natives the installed Codex actually ships. The user can remove any in the GUI — once they set the
 * list (even to []), it is respected, so removals persist (start-up only seeds the UNSET case).
 * Kept to ids ChatGPT accepts; the start-up seed prefers the live catalog's native slugs.
 */
export const DEFAULT_SUBAGENT_MODELS = ["gpt-5.5", "gpt-5.4", "gpt-5.4-mini", "gpt-5.3-codex-spark"];

export function getConfigDir(): string {
  return OCX_DIR;
}

export function getConfigPath(): string {
  return CONFIG_PATH;
}

export function getPidPath(): string {
  return PID_PATH;
}

export function hardenConfigDir(): void {
  if (existsSync(OCX_DIR)) {
    try { chmodSync(OCX_DIR, 0o700); } catch { /* best-effort */ }
  }
}

export function hardenExistingSecret(path: string): void {
  if (existsSync(path)) {
    try { chmodSync(path, 0o600); } catch { /* best-effort */ }
  }
}

export function loadConfig(): OcxConfig {
  hardenConfigDir();
  hardenExistingSecret(CONFIG_PATH);
  if (!existsSync(CONFIG_PATH)) {
    return getDefaultConfig();
  }
  try {
    const raw = readFileSync(CONFIG_PATH, "utf-8");
    return JSON.parse(raw) as OcxConfig;
  } catch {
    return getDefaultConfig();
  }
}

export function saveConfig(config: OcxConfig): void {
  if (!existsSync(OCX_DIR)) {
    mkdirSync(OCX_DIR, { recursive: true, mode: 0o700 });
  } else {
    try { chmodSync(OCX_DIR, 0o700); } catch { /* best-effort on existing dir */ }
  }
  atomicWriteFile(CONFIG_PATH, JSON.stringify(config, null, 2) + "\n");
}

export function websocketsEnabled(config: Pick<OcxConfig, "websockets">): boolean {
  return config.websockets === true;
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
  if (!existsSync(OCX_DIR)) {
    mkdirSync(OCX_DIR, { recursive: true, mode: 0o700 });
  } else {
    hardenConfigDir();
  }
  writeFileSync(PID_PATH, String(pid), "utf-8");
}

export function readPid(): number | null {
  if (!existsSync(PID_PATH)) return null;
  try {
    const raw = readFileSync(PID_PATH, "utf-8").trim();
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
    unlinkSync(PID_PATH);
  } catch { /* ignore */ }
}
