import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import * as z from "zod/v4";
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

let resolvedConfigDirCache: { raw: string | undefined; path: string } | null = null;

function resolveConfigDir(): string {
  const raw = process.env["OPENCODEX_HOME"]?.trim() || undefined;
  if (resolvedConfigDirCache && resolvedConfigDirCache.raw === raw) return resolvedConfigDirCache.path;
  const path = raw ? resolve(raw) : join(homedir(), ".opencodex");
  resolvedConfigDirCache = { raw, path };
  return path;
}

function resolveConfigPath(): string {
  return join(resolveConfigDir(), "config.json");
}

function resolvePidPath(): string {
  return join(resolveConfigDir(), "ocx.pid");
}

function resolveRuntimePortPath(): string {
  return join(resolveConfigDir(), "runtime-port.json");
}

const warnedConfigFallbacks = new Set<string>();

const providerConfigSchema = z.object({
  adapter: z.string().min(1),
  baseUrl: z.string().min(1),
}).passthrough();

const RESERVED_PROVIDER_NAMES = new Set(["__proto__", "prototype", "constructor"]);
const PROVIDER_NAME_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,62}[A-Za-z0-9])?$/;
const HEADER_NAME_PATTERN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const SENSITIVE_PROVIDER_HEADERS = new Set([
  "authorization",
  "cookie",
  "set-cookie",
  "proxy-authorization",
  "x-api-key",
  "x-goog-api-key",
  "x-amz-security-token",
]);

export function isValidProviderName(name: string): boolean {
  const trimmed = name.trim();
  return trimmed === name
    && PROVIDER_NAME_PATTERN.test(name)
    && !RESERVED_PROVIDER_NAMES.has(name.toLowerCase());
}

export function hasOwnProvider(providers: Record<string, unknown>, name: string): boolean {
  return Object.prototype.hasOwnProperty.call(providers, name);
}

export function providerBaseUrlConfigError(baseUrl: string): string | null {
  try {
    const parsed = new URL(baseUrl.trim());
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return "baseUrl must be an http(s) URL";
    if (parsed.username || parsed.password) return "baseUrl must not include embedded credentials";
    if (parsed.search || parsed.hash) return "baseUrl must not include query strings or fragments";
  } catch {
    return "baseUrl must be a valid URL";
  }
  return null;
}

export function providerHeadersConfigError(headers: unknown): string | null {
  if (headers === undefined) return null;
  if (!headers || typeof headers !== "object" || Array.isArray(headers)) return "headers must be an object";
  for (const [name, value] of Object.entries(headers)) {
    const normalized = name.trim().toLowerCase();
    if (!normalized || !HEADER_NAME_PATTERN.test(name)) return "headers must use valid HTTP header names";
    if (SENSITIVE_PROVIDER_HEADERS.has(normalized)) return `headers must not include sensitive header "${name}"; use apiKey/authMode instead`;
    if (typeof value !== "string") return `header "${name}" value must be a string`;
    if (/[\r\n]/.test(value)) return `header "${name}" value must not include line breaks`;
  }
  return null;
}

const configSchema = z.object({
  port: z.number().int().min(0).max(65535).default(10100),
  providers: z.record(z.string(), providerConfigSchema),
  defaultProvider: z.string().min(1).default("openai"),
  providerContextCaps: z.record(z.string(), z.number().int().positive()).optional(),
  contextCapValue: z.number().int().positive().optional(),
}).passthrough().superRefine((config, ctx) => {
  for (const name of Object.keys(config.providers)) {
    if (!isValidProviderName(name)) {
      ctx.addIssue({
        code: "custom",
        path: ["providers", name],
        message: "provider names must use letters, numbers, dot, underscore, or hyphen and cannot be reserved JavaScript object keys",
      });
    }
    const provider = config.providers[name];
    const baseUrlError = providerBaseUrlConfigError(provider.baseUrl);
    if (baseUrlError) {
      ctx.addIssue({
        code: "custom",
        path: ["providers", name, "baseUrl"],
        message: baseUrlError,
      });
    }
    const headersError = providerHeadersConfigError((provider as { headers?: unknown }).headers);
    if (headersError) {
      ctx.addIssue({
        code: "custom",
        path: ["providers", name, "headers"],
        message: headersError,
      });
    }
  }
  if (!hasOwnProvider(config.providers, config.defaultProvider)) {
    ctx.addIssue({
      code: "custom",
      path: ["defaultProvider"],
      message: "defaultProvider must exist in providers",
    });
  }
});

/**
 * Default featured subagent models (native GPT) seeded on a fresh install and when `subagentModels`
 * is unset. Codex's spawn_agent advertises the first 5 featured catalog entries; these are the GPT
 * natives the installed Codex actually ships. The user can remove any in the GUI — once they set the
 * list (even to []), it is respected, so removals persist (start-up only seeds the UNSET case).
 * Kept to ids ChatGPT accepts; the start-up seed prefers the live catalog's native slugs.
 */
export const DEFAULT_SUBAGENT_MODELS = ["gpt-5.5", "gpt-5.4", "gpt-5.4-mini", "gpt-5.3-codex-spark"];

export function getConfigDir(): string {
  return resolveConfigDir();
}

export function getConfigPath(): string {
  return resolveConfigPath();
}

export function getPidPath(): string {
  return resolvePidPath();
}

export function getRuntimePortPath(): string {
  return resolveRuntimePortPath();
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
  const dir = getConfigDir();
  const configPath = getConfigPath();
  hardenConfigDir();
  hardenExistingSecret(configPath);
  hardenExistingSecret(join(dir, "auth.json"));
  if (!existsSync(configPath)) {
    return getDefaultConfig();
  }
  try {
    const raw = readFileSync(configPath, "utf-8").replace(/^\uFEFF/, "");
    const parsed = JSON.parse(raw);
    const result = configSchema.safeParse(parsed);
    if (result.success) return result.data as OcxConfig;
    // Schema validation failed — merge defaults into the raw object instead of
    // discarding it entirely, so pool accounts and providers survive a missing
    // field like defaultProvider.
    const defaults = getDefaultConfig();
    const merged = { ...defaults, ...parsed };
    // Ensure providers from both sides survive
    if (parsed.providers && defaults.providers) {
      merged.providers = { ...defaults.providers, ...parsed.providers };
    }
    const retryResult = configSchema.safeParse(merged);
    if (retryResult.success) {
      warnConfigRepaired(configPath, result.error);
      return retryResult.data as OcxConfig;
    }
    // Merge couldn't fix it — truly broken config
    warnAndBackupInvalidConfig(configPath, result.error);
    return getDefaultConfig();
  } catch (error) {
    warnAndBackupInvalidConfig(configPath, error);
    return getDefaultConfig();
  }
}

export type ConfigDiagnostics = {
  config: OcxConfig;
  source: "default" | "file" | "fallback";
  error: string | null;
};

function mergeConfigDefaults(parsed: unknown): unknown {
  if (!parsed || typeof parsed !== "object") return parsed;
  const defaults = getDefaultConfig();
  const raw = parsed as Record<string, unknown>;
  const merged: Record<string, unknown> = { ...defaults, ...raw };
  if (raw.providers && typeof raw.providers === "object" && defaults.providers) {
    merged.providers = { ...defaults.providers, ...(raw.providers as Record<string, unknown>) };
  }
  return merged;
}

function configIssuePaths(error: z.ZodError): string[] {
  const paths = error.issues.map(issue => issue.path.join(".") || "config");
  return [...new Set(paths)].sort();
}

function schemaDiagnosticsError(error: z.ZodError): string {
  const paths = configIssuePaths(error);
  return paths.length > 0 ? `schema_invalid: ${paths.join(", ")}` : "schema_invalid";
}

export function readConfigDiagnostics(): ConfigDiagnostics {
  const configPath = getConfigPath();
  if (!existsSync(configPath)) {
    return { config: getDefaultConfig(), source: "default", error: null };
  }
  try {
    const raw = readFileSync(configPath, "utf-8").replace(/^\uFEFF/, "");
    const parsed = JSON.parse(raw);
    const result = configSchema.safeParse(parsed);
    if (result.success) {
      return { config: result.data as OcxConfig, source: "file", error: null };
    }

    const retryResult = configSchema.safeParse(mergeConfigDefaults(parsed));
    if (retryResult.success) {
      return { config: retryResult.data as OcxConfig, source: "file", error: null };
    }

    return { config: getDefaultConfig(), source: "fallback", error: schemaDiagnosticsError(result.error) };
  } catch {
    return { config: getDefaultConfig(), source: "fallback", error: "invalid_json" };
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
  atomicWriteFile(getPidPath(), String(pid));
}

export type RuntimePortState = {
  pid: number;
  port: number;
  hostname?: string;
};

function isValidRuntimePortState(value: unknown): value is RuntimePortState {
  if (!value || typeof value !== "object") return false;
  const state = value as Record<string, unknown>;
  const hostnameOk = state.hostname === undefined || typeof state.hostname === "string";
  return Number.isSafeInteger(state.pid)
    && Number(state.pid) > 0
    && Number.isInteger(state.port)
    && Number(state.port) > 0
    && Number(state.port) <= 65535
    && hostnameOk;
}

export function writeRuntimePort(state: RuntimePortState): void {
  const dir = getConfigDir();
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  } else {
    hardenConfigDir();
  }
  atomicWriteFile(getRuntimePortPath(), JSON.stringify(state, null, 2) + "\n");
}

export function readPid(): number | null {
  const pidPath = getPidPath();
  if (!existsSync(pidPath)) return null;
  try {
    const raw = readFileSync(pidPath, "utf-8").trim();
    const pid = parsePidFile(raw);
    if (pid === null) return null;
    try {
      process.kill(pid, 0);
      return isLikelyOcxStartProcess(pid) ? pid : null;
    } catch (e: unknown) {
      if ((e as NodeJS.ErrnoException).code === "EPERM") {
        return isLikelyOcxStartProcess(pid) ? pid : null;
      }
      return null;
    }
  } catch {
    return null;
  }
}

export function readRuntimePort(expectedPid?: number): RuntimePortState | null {
  try {
    const parsed = JSON.parse(readFileSync(getRuntimePortPath(), "utf-8"));
    if (!isValidRuntimePortState(parsed)) return null;
    if (expectedPid !== undefined && parsed.pid !== expectedPid) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function removePid(expectedPid?: number): void {
  if (expectedPid !== undefined && readPidFileValue() !== expectedPid) return;
  try {
    unlinkSync(getPidPath());
  } catch { /* ignore */ }
}

function warnConfigRepaired(configPath: string, error: z.ZodError): void {
  if (warnedConfigFallbacks.has(configPath)) return;
  warnedConfigFallbacks.add(configPath);
  const fields = error.issues.map(i => i.path.join(".") || "config").join(", ");
  console.error(`opencodex config at ${configPath}: repaired missing field(s) [${fields}] with defaults. Your providers and accounts are preserved.`);
}

function readPidFileValue(): number | null {
  try {
    return parsePidFile(readFileSync(getPidPath(), "utf-8"));
  } catch {
    return null;
  }
}

export function removeRuntimePort(expectedPid?: number): void {
  if (expectedPid !== undefined && readRuntimePort(expectedPid) === null) return;
  try {
    unlinkSync(getRuntimePortPath());
  } catch { /* ignore */ }
}

export function parsePidFile(raw: string): number | null {
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const pid = Number.parseInt(trimmed, 10);
  return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
}

export function isOcxStartCommandLine(commandLine: string): boolean {
  const normalized = commandLine.toLowerCase().replace(/\\/g, "/");
  const hasOcxEntrypoint = normalized.includes("src/cli.ts")
    || normalized.includes("@bitkyc08/opencodex")
    || /(?:^|[\s/"'])(?:ocx|opencodex)(?:\.cmd)?(?:$|[\s"'])/.test(normalized);
  return hasOcxEntrypoint && /(?:^|[\s"'])start(?:$|[\s"'])/.test(normalized);
}

function isLikelyOcxStartProcess(pid: number): boolean {
  const commandLine = readProcessCommandLine(pid);
  if (commandLine === undefined) return false;
  return isOcxStartCommandLine(commandLine);
}

function readProcessCommandLine(pid: number): string | undefined {
  try {
    if (process.platform === "win32") {
      const output = execFileSync("powershell.exe", [
        "-NoProfile",
        "-Command",
        `(Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}").CommandLine`,
      ], { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"], timeout: 3000 });
      return output.trim() || undefined;
    }
    const output = execFileSync("ps", ["-p", String(pid), "-o", "command="], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 1000,
    });
    return output.trim() || undefined;
  } catch {
    return undefined;
  }
}

function warnAndBackupInvalidConfig(configPath: string, error: unknown): void {
  if (warnedConfigFallbacks.has(configPath)) return;
  warnedConfigFallbacks.add(configPath);

  const backupPath = backupInvalidConfig(configPath);
  const reason = error instanceof z.ZodError
    ? error.issues.map(issue => `${issue.path.join(".") || "config"}: ${issue.message}`).join("; ")
    : error instanceof Error ? error.message : String(error);
  const backupNote = backupPath ? ` A backup was written to ${backupPath}.` : "";
  console.error(`Could not load opencodex config at ${configPath}: ${reason}. Using default config.${backupNote}`);
}

export function backupInvalidConfig(configPath: string): string | null {
  if (!existsSync(configPath)) return null;
  const backupPath = `${configPath}.invalid-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  try {
    copyFileSync(configPath, backupPath);
    try { chmodSync(backupPath, 0o600); } catch { /* best-effort */ }
    return backupPath;
  } catch {
    return null;
  }
}
