import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { OcxConfig } from "./types";

const OCX_DIR = join(homedir(), ".opencodex");
const CONFIG_PATH = join(OCX_DIR, "config.json");
const PID_PATH = join(OCX_DIR, "ocx.pid");

export function getConfigDir(): string {
  return OCX_DIR;
}

export function getConfigPath(): string {
  return CONFIG_PATH;
}

export function getPidPath(): string {
  return PID_PATH;
}

export function loadConfig(): OcxConfig {
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
    mkdirSync(OCX_DIR, { recursive: true });
  }
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + "\n", "utf-8");
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
  if (!existsSync(OCX_DIR)) mkdirSync(OCX_DIR, { recursive: true });
  writeFileSync(PID_PATH, String(pid), "utf-8");
}

export function readPid(): number | null {
  if (!existsSync(PID_PATH)) return null;
  try {
    const raw = readFileSync(PID_PATH, "utf-8").trim();
    const pid = parseInt(raw, 10);
    if (isNaN(pid)) return null;
    try { process.kill(pid, 0); return pid; } catch { return null; }
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
