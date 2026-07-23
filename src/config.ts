import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, linkSync, mkdirSync, readFileSync, renameSync, truncateSync, unlinkSync, writeFileSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import * as z from "zod/v4";
import { comboConfigIssues } from "./combos/types";
import { hardenSecretDir, hardenSecretPath } from "./lib/windows-secret-acl";
import { providerDestinationConfigError } from "./lib/destination-policy";
import { openRouterRoutingConfigError } from "./providers/openrouter-routing";
import { OPENAI_PROVIDER_TIER_VERSION, type OcxConfig } from "./types";

let _atomicSeq = 0;

interface AtomicRenameIO {
  platform: NodeJS.Platform;
  rename: (source: string, destination: string) => void;
  sleep: (milliseconds: number) => void;
}

export function renameAtomicFile(
  source: string,
  destination: string,
  io: AtomicRenameIO = {
    platform: process.platform,
    rename: renameSync,
    sleep: Bun.sleepSync,
  },
): void {
  for (let attempt = 0; ; attempt += 1) {
    try {
      io.rename(source, destination);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      const transientWindowsError = io.platform === "win32"
        && (code === "EBUSY" || code === "EPERM" || code === "EACCES");
      if (!transientWindowsError || attempt >= 2) throw error;
      io.sleep(25 * (attempt + 1));
    }
  }
}

/**
 * Write a file atomically (temp + rename) so concurrent writers — e.g. `ocx stop` and the
 * proxy's own shutdown handler both restoring Codex — can never leave a half-written file.
 */
export interface AtomicWriteIO {
  write: (path: string, content: string) => void;
  harden: (path: string) => void;
  rename: (source: string, destination: string) => void;
  truncate: (path: string) => void;
  unlink: (path: string) => void;
}

export class AtomicWriteResidualTempError extends Error {
  constructor(readonly tempPath: string, readonly hardened = true, options?: ErrorOptions) {
    super(`Atomic config write left a ${hardened ? "hardened " : ""}zero-byte temporary file`, options);
    this.name = "AtomicWriteResidualTempError";
  }
}

export class AtomicWriteSecretResidualError extends Error {
  constructor(readonly tempPath: string, options?: ErrorOptions) {
    super("Atomic config write could not scrub or remove a secret-bearing temporary file", options);
    this.name = "AtomicWriteSecretResidualError";
  }
}

function isMissingPathError(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
}

export function atomicWriteFile(path: string, content: string, io: AtomicWriteIO = {
  write: (target, value) => writeFileSync(target, value, { encoding: "utf-8", mode: 0o600 }),
  harden: target => {
    try { chmodSync(target, 0o600); } catch { /* platform may ignore chmod */ }
    if (process.platform === "win32") hardenSecretPath(target, { required: true });
  },
  rename: renameAtomicFile,
  truncate: target => truncateSync(target, 0),
  unlink: unlinkSync,
}): void {
  const tmp = `${path}.ocx.${process.pid}.${++_atomicSeq}.tmp`;
  let hardened = false;
  try {
    io.write(tmp, content);
    io.harden(tmp);
    hardened = true;
    io.rename(tmp, path);
  } catch (cause) {
    let scrubbed = false;
    try {
      io.truncate(tmp);
      scrubbed = true;
    } catch (error) {
      if (isMissingPathError(error)) scrubbed = true;
      else {
        try { io.write(tmp, ""); scrubbed = true; } catch { /* removal may still succeed */ }
      }
    }
    let removed = false;
    try {
      io.unlink(tmp);
      removed = true;
    } catch (error) {
      if (isMissingPathError(error)) removed = true;
      else {
        try { io.unlink(tmp); removed = true; }
        catch (retryError) { if (isMissingPathError(retryError)) removed = true; }
      }
    }
    if (!removed && !scrubbed) throw new AtomicWriteSecretResidualError(tmp, { cause });
    if (!removed && !hardened) {
      try { io.harden(tmp); hardened = true; } catch { /* zero-byte residual is reported honestly */ }
    }
    if (!removed) throw new AtomicWriteResidualTempError(tmp, hardened, { cause });
    throw cause;
  }
}

export class OpenAiTierBackupCleanupError extends Error {
  constructor() { super("OpenAI tier backup temporary cleanup failed"); this.name = "OpenAiTierBackupCleanupError"; }
}

export class OpenAiTierBackupRollbackError extends Error {
  constructor() { super("OpenAI tier backup rollback failed"); this.name = "OpenAiTierBackupRollbackError"; }
}

export class OpenAiTierBackupCollisionError extends Error {
  constructor() { super("Existing OpenAI tier backup differs from the current config"); this.name = "OpenAiTierBackupCollisionError"; }
}

export class OpenAiTierBackupSecretResidualError extends Error {
  constructor(readonly tempPath: string, options?: ErrorOptions) {
    super("OpenAI tier backup could not scrub or remove a secret-bearing temporary file", options);
    this.name = "OpenAiTierBackupSecretResidualError";
  }
}

export interface OpenAiTierBackupIO {
  exists(path: string): boolean;
  read(path: string): Uint8Array;
  createExclusive(path: string): void;
  write(path: string, bytes: Uint8Array): void;
  harden(path: string): void;
  publishNoReplace(temp: string, backup: string): void;
  truncate(path: string): void;
  unlink(path: string): void;
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && left.every((value, index) => value === right[index]);
}

function isAlreadyExistsError(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === "EEXIST";
}

/**
 * Classify an existing `.pre-openai-tiers-v2.bak` snapshot.
 *
 * - `"stale"`: unparseable JSON (not written by us / truncated) or already a
 *   post-migration (tier v2) snapshot — safe to delete or replace.
 * - `"rollback"`: parses as a valid pre-migration (v1) config — a
 *   user-intentional rollback point that must never be silently destroyed.
 *
 * Shared by the startup migration backup path and `ocx init` cleanup so both
 * apply the same preservation policy (issue #257 / sol review 260722).
 */
export function classifyOpenAiTierBackup(backupBytes: Uint8Array): "stale" | "rollback" {
  try {
    // Use Buffer.from to ensure proper UTF-8 decoding from Uint8Array/Buffer.
    const parsed = JSON.parse(Buffer.from(backupBytes).toString("utf8")) as Record<string, unknown>;
    return parsed.openaiProviderTierVersion === 2 ? "stale" : "rollback";
  } catch {
    // Unparseable: not a config file we created, treat as stale.
    return "stale";
  }
}

export function backupConfigBeforeOpenAiTierMigration(
  configPath = getConfigPath(),
  io: OpenAiTierBackupIO = {
    exists: existsSync,
    read: target => readFileSync(target),
    createExclusive: target => { writeFileSync(target, new Uint8Array(), { flag: "wx", mode: 0o600 }); },
    write: (target, bytes) => writeFileSync(target, bytes),
    harden: target => {
      try { chmodSync(target, 0o600); } catch { /* platform may ignore chmod */ }
      if (process.platform === "win32") hardenSecretPath(target, { required: true });
    },
    publishNoReplace: (temp, backup) => linkSync(temp, backup),
    truncate: target => truncateSync(target, 0),
    unlink: unlinkSync,
  },
): "absent" | "created" | "reused" {
  const source = configPath;
  if (!io.exists(source)) return "absent";
  const original = io.read(source);
  // v2 snapshot path. The historical `.pre-openai-tiers-v1.bak` is read only by restore
  // docs/fixtures and is never reused or overwritten as the v2 snapshot.
  const backup = `${source}.pre-openai-tiers-v2.bak`;
  if (io.exists(backup)) {
    if (!sameBytes(original, io.read(backup))) {
      // The backup differs from the current config. Only treat it as stale when it is
      // clearly not a user-intentional rollback point:
      //   - unparseable JSON: written by a different tool or truncated
      //   - already at tier version 2: the backup is from a post-migration config (e.g.
      //     ocx init wrote a fresh v2 config, making the old backup obsolete)
      // A backup that parses as a valid pre-migration (v1) config is kept as-is and
      // we throw a collision error, because silently replacing a user-created rollback
      // point would be surprising and potentially destructive.
      const backupBytes = io.read(backup);
      if (classifyOpenAiTierBackup(backupBytes) === "rollback") {
        throw new OpenAiTierBackupCollisionError();
      }
      console.warn("[openai-provider-migration] Replacing stale pre-migration backup (post-migration config was rewritten since last migration).");
      io.unlink(backup);
    } else {
      return "reused";
    }
  }
  const temp = `${backup}.ocx.${process.pid}.${++_atomicSeq}.tmp`;
  let published = false;
  let cleanupAttempted = false;

  const scrubUnpublishedTemp = (): void => {
    cleanupAttempted = true;
    if (!io.exists(temp)) return;
    let scrubbed = false;
    try {
      io.truncate(temp);
      scrubbed = true;
    } catch (error) {
      if (isMissingPathError(error)) scrubbed = true;
      else {
        try { io.write(temp, new Uint8Array()); scrubbed = true; } catch { /* removal may still succeed */ }
      }
    }
    let removed = false;
    try {
      io.unlink(temp);
      removed = true;
    } catch (error) {
      if (isMissingPathError(error) || !io.exists(temp)) removed = true;
      else {
        try { io.unlink(temp); removed = true; }
        catch (retryError) {
          if (isMissingPathError(retryError) || !io.exists(temp)) removed = true;
        }
      }
    }
    if (!removed && !scrubbed) throw new OpenAiTierBackupSecretResidualError(temp);
    if (!removed) throw new OpenAiTierBackupCleanupError();
  };

  try {
    io.createExclusive(temp);
    io.write(temp, original);
    io.harden(temp);
    try {
      io.publishNoReplace(temp, backup);
    } catch (cause) {
      if (!isAlreadyExistsError(cause)) throw cause;
      const winner = io.read(backup);
      if (!sameBytes(original, winner)) throw new OpenAiTierBackupCollisionError();
      scrubUnpublishedTemp();
      return "reused";
    }
    published = true;
    try {
      io.unlink(temp);
    } catch {
      try {
        io.unlink(temp);
      } catch {
        // temp and backup are hard links to the same inode. Roll back the backup
        // link before any truncation so the downgrade snapshot is never zeroed.
        try { io.unlink(backup); } catch { throw new OpenAiTierBackupRollbackError(); }
        published = false;
        scrubUnpublishedTemp();
        throw new OpenAiTierBackupCleanupError();
      }
    }
    return "created";
  } catch (cause) {
    if (!published && !cleanupAttempted) {
      scrubUnpublishedTemp();
    }
    throw cause;
  }
}

/**
 * Expand a leading `~` to the home directory in user-supplied paths
 * (OPENCODEX_HOME/CODEX_HOME set from GUIs/service files where no shell expanded it).
 * `~user` and `%VAR%`/`$VAR` forms pass through untouched — those belong to the shell.
 */
export function expandUserPath(raw: string): string {
  if (raw === "~") return homedir();
  if (raw.startsWith("~/") || raw.startsWith("~\\")) return join(homedir(), raw.slice(2));
  return raw;
}

let resolvedConfigDirCache: { raw: string | undefined; path: string } | null = null;

function resolveConfigDir(): string {
  const raw = process.env["OPENCODEX_HOME"]?.trim() || undefined;
  if (resolvedConfigDirCache && resolvedConfigDirCache.raw === raw) return resolvedConfigDirCache.path;
  const path = raw ? resolve(expandUserPath(raw)) : join(homedir(), ".opencodex");
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
  responsesPath: z.string().min(1).optional(),
  allowPrivateNetwork: z.boolean().optional(),
  codexAccountMode: z.enum(["pool", "direct"]).optional(),
  responsesItemIdRepair: z.object({
    message: z.array(z.string().min(1)).optional(),
    reasoning: z.array(z.string().min(1)).optional(),
    repairMissingTerminalIds: z.boolean().optional(),
  }).strict().optional(),
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

function providerResponsesPathConfigError(responsesPath: string | undefined): string | null {
  if (responsesPath === undefined) return null;
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(responsesPath) || responsesPath.includes("://")) {
    return "responsesPath must be a relative path without a URL scheme";
  }
  if (!responsesPath.startsWith("/")) return "responsesPath must start with /";
  if (responsesPath.includes("?") || responsesPath.includes("#")) {
    return "responsesPath must not include query strings or fragments";
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

export function positiveIntegerRecordConfigError(value: unknown, field: string): string | null {
  if (value === undefined) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) return `${field} must be a plain object`;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return `${field} must be a plain object with own properties`;
  for (const [key, entry] of Object.entries(value)) {
    if (!key.trim()) return `${field} keys must be nonblank model ids`;
    if (typeof entry !== "number" || !Number.isFinite(entry) || !Number.isInteger(entry) || entry <= 0) {
      return `${field}.${key} must be a positive finite integer`;
    }
  }
  return null;
}

export function positiveIntegerConfigError(value: unknown, field: string): string | null {
  if (value === undefined) return null;
  if (typeof value !== "number" || !Number.isFinite(value) || !Number.isInteger(value) || value <= 0) {
    return `${field} must be a positive finite integer`;
  }
  return null;
}

export function booleanRecordConfigError(value: unknown, field: string): string | null {
  if (value === undefined) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) return `${field} must be a plain object`;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return `${field} must be a plain object with own properties`;
  for (const [key, entry] of Object.entries(value)) {
    if (!key.trim()) return `${field} keys must be nonblank model ids`;
    if (typeof entry !== "boolean") return `${field}.${key} must be a boolean`;
  }
  return null;
}

const configSchema = z.object({
  port: z.number().int().min(0).max(65535).default(10100),
  providers: z.record(z.string(), providerConfigSchema),
  defaultProvider: z.string().min(1).default("openai"),
  openaiProviderTierVersion: z.union([z.literal(1), z.literal(2)]).optional(),
  providerContextCaps: z.record(z.string(), z.number().int().positive()).optional(),
  contextCapValue: z.number().int().positive().optional(),
  multiAgentGuidanceEnabled: z.boolean().optional(),
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
    const openRouterRoutingError = openRouterRoutingConfigError(provider);
    if (openRouterRoutingError) {
      ctx.addIssue({
        code: "custom",
        path: [
          "providers",
          name,
          openRouterRoutingError.startsWith("modelOpenRouterRouting")
            ? "modelOpenRouterRouting"
            : "openRouterRouting",
        ],
        message: openRouterRoutingError,
      });
    }
    if (Object.hasOwn(provider, "virtualModels")) {
      ctx.addIssue({
        code: "custom",
        path: ["providers", name, "virtualModels"],
        message: "virtualModels is registry-only and must not be persisted",
      });
    }
    const baseUrlError = providerBaseUrlConfigError(provider.baseUrl);
    if (baseUrlError) {
      ctx.addIssue({
        code: "custom",
        path: ["providers", name, "baseUrl"],
        message: baseUrlError,
      });
    } else {
      const destinationError = providerDestinationConfigError(name, provider);
      if (destinationError) {
        ctx.addIssue({
          code: "custom",
          path: ["providers", name, "baseUrl"],
          message: destinationError,
        });
      }
    }
    const responsesPathError = providerResponsesPathConfigError(provider.responsesPath);
    if (responsesPathError) {
      ctx.addIssue({
        code: "custom",
        path: ["providers", name, "responsesPath"],
        message: responsesPathError,
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
    const maxInputError = positiveIntegerRecordConfigError(
      (provider as { modelMaxInputTokens?: unknown }).modelMaxInputTokens,
      "modelMaxInputTokens",
    );
    if (maxInputError) {
      ctx.addIssue({
        code: "custom",
        path: ["providers", name, "modelMaxInputTokens"],
        message: maxInputError,
      });
    }
    const reasoningSummariesError = booleanRecordConfigError(
      (provider as { modelSupportsReasoningSummaries?: unknown }).modelSupportsReasoningSummaries,
      "modelSupportsReasoningSummaries",
    );
    if (reasoningSummariesError) {
      ctx.addIssue({
        code: "custom",
        path: ["providers", name, "modelSupportsReasoningSummaries"],
        message: reasoningSummariesError,
      });
    }
    const defaultMaxOutputError = positiveIntegerConfigError(
      (provider as { defaultMaxOutputTokens?: unknown }).defaultMaxOutputTokens,
      "defaultMaxOutputTokens",
    );
    if (defaultMaxOutputError) {
      ctx.addIssue({
        code: "custom",
        path: ["providers", name, "defaultMaxOutputTokens"],
        message: defaultMaxOutputError,
      });
    }
    const maxOutputError = positiveIntegerRecordConfigError(
      (provider as { modelMaxOutputTokens?: unknown }).modelMaxOutputTokens,
      "modelMaxOutputTokens",
    );
    if (maxOutputError) {
      ctx.addIssue({
        code: "custom",
        path: ["providers", name, "modelMaxOutputTokens"],
        message: maxOutputError,
      });
    }
    if (Object.hasOwn(provider, "codexAccountMode") && provider.codexAccountMode !== undefined) {
      // Persisted account mode is valid ONLY on the canonical built-in `openai` forward provider.
      // Old openai-multi rows stay parseable (they never carry a mode) so startup can migrate them.
      const canonicalOpenAiShape = name === "openai"
        && provider.adapter === "openai-responses"
        && (provider as { authMode?: unknown }).authMode === "forward"
        && typeof provider.baseUrl === "string"
        && provider.baseUrl.replace(/\/+$/, "") === "https://chatgpt.com/backend-api/codex";
      if (!canonicalOpenAiShape) {
        ctx.addIssue({
          code: "custom",
          path: ["providers", name, "codexAccountMode"],
          message: "codexAccountMode is valid only on the canonical built-in openai provider",
        });
      }
    }
  }
  if (!hasOwnProvider(config.providers, config.defaultProvider)) {
    ctx.addIssue({
      code: "custom",
      path: ["defaultProvider"],
      message: "defaultProvider must exist in providers",
    });
  }
  const combos = (config as { combos?: unknown }).combos;
  if (combos !== undefined) {
    if (!combos || typeof combos !== "object" || Array.isArray(combos)) {
      ctx.addIssue({ code: "custom", path: ["combos"], message: "combos must be an object" });
    } else {
      for (const [id, raw] of Object.entries(combos as Record<string, unknown>)) {
        // Pass the full map so cross-combo rules (alias uniqueness) apply at load time
        // too, not just via the management API; each combo is excluded from its own check.
        for (const issue of comboConfigIssues(id, raw, config.providers, {
          combos: combos as Record<string, import("./types").OcxComboConfig>,
          excludeComboId: id,
        })) {
          ctx.addIssue({
            code: "custom",
            path: ["combos", id, ...issue.path],
            message: issue.message,
          });
        }
      }
    }
  }
});

/**
 * Default featured subagent models (native GPT) seeded on a fresh install and when `subagentModels`
 * is unset. Codex's spawn_agent advertises the first 5 featured catalog entries, so this seed is a
 * deliberate 5-list: frontier gpt-5.5 first, the gpt-5.6 preview trio, and gpt-5.4-mini as the cheap
 * tier. gpt-5.4 / gpt-5.3-codex-spark stay selectable in the GUI's available list. The user can
 * remove any in the GUI — once they set the list (even to []), it is respected, so removals persist
 * (start-up only seeds the UNSET case). Kept to ids ChatGPT accepts; the start-up seed prefers the
 * live catalog's native slugs.
 */
export const DEFAULT_SUBAGENT_MODELS = ["gpt-5.5", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.4-mini"];

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
    if (process.platform === "win32") {
      hardenSecretDir(dir, { required: false });
    }
  }
}

export function hardenExistingSecret(path: string): void {
  if (existsSync(path)) {
    try { chmodSync(path, 0o600); } catch { /* best-effort */ }
    if (process.platform === "win32") {
      hardenSecretPath(path, { required: false });
    }
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
  /** Non-fatal config concerns; absent when there are no warnings. */
  warnings?: string[];
};

function configPlaceholderWarnings(config: OcxConfig): string[] {
  const warnings: string[] = [];
  for (const [name, provider] of Object.entries(config.providers)) {
    const placeholder = provider.baseUrl.match(/\{[^}]*\}/)?.[0];
    if (placeholder) {
      warnings.push(`providers.${name}.baseUrl contains unresolved ${placeholder}; set the real provider URL`);
    }
  }
  return warnings;
}

function validFileConfigDiagnostics(config: OcxConfig): ConfigDiagnostics {
  const warnings = configPlaceholderWarnings(config);
  return {
    config,
    source: "file",
    error: null,
    ...(warnings.length > 0 ? { warnings } : {}),
  };
}

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

function schemaDiagnosticsError(error: z.ZodError): string {
  const details = error.issues.map(issue => {
    const path = issue.path.join(".") || "config";
    return `${path}: ${issue.message}`;
  });
  return details.length > 0 ? `schema_invalid: ${details.join("; ")}` : "schema_invalid";
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
      return validFileConfigDiagnostics(result.data as OcxConfig);
    }

    const retryResult = configSchema.safeParse(mergeConfigDefaults(parsed));
    if (retryResult.success) {
      return validFileConfigDiagnostics(retryResult.data as OcxConfig);
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
  if (process.platform === "win32") {
    hardenSecretDir(dir, { required: true });
  }
  const configPath = getConfigPath();
  atomicWriteFile(configPath, JSON.stringify(config, null, 2) + "\n");
}

export function websocketsEnabled(config: Pick<OcxConfig, "websockets">): boolean {
  return config.websockets === true;
}

export function codexAutoStartEnabled(config: Pick<OcxConfig, "codexAutoStart">): boolean {
  return config.codexAutoStart !== false;
}

export function multiAgentGuidanceEnabled(
  config: Pick<OcxConfig, "multiAgentGuidanceEnabled">,
): boolean {
  return config.multiAgentGuidanceEnabled !== false;
}

export function getDefaultConfig(): OcxConfig {
  // Fresh-install default: works out of the box with Codex's ChatGPT OAuth (no API key).
  // gpt-* requests forward the caller's incoming OAuth headers to the ChatGPT backend.
  // Adding extra providers (e.g. opencode-go) and switching defaultProvider is a user/runtime choice.
  return {
    port: 10100,
    // Fresh/re-initialized configs are already written in the current three-tier
    // OpenAI shape. Mark them as such so startup does not mistake them for a
    // legacy config and collide with an immutable backup from an earlier setup.
    openaiProviderTierVersion: OPENAI_PROVIDER_TIER_VERSION,
    providers: {
      openai: {
        adapter: "openai-responses",
        baseUrl: "https://chatgpt.com/backend-api/codex",
        authMode: "forward",
        codexAccountMode: "pool",
      },
    },
    defaultProvider: "openai",
    subagentModels: [...DEFAULT_SUBAGENT_MODELS],
    multiAgentGuidanceEnabled: true,
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

/**
 * Mirror `config.proxy` into HTTP(S)_PROXY env vars so Bun's native fetch routes every outbound
 * provider call through the proxy — no per-callsite changes (verified: Bun honors these plus
 * NO_PROXY). User-set env vars always win; localhost/127.0.0.1 are appended to NO_PROXY so the
 * CLI's own health checks and running-proxy API calls stay direct. Call once per process entry
 * that makes outbound provider requests (server start, catalog sync).
 */
export function applyProxyEnv(config: OcxConfig): void {
  const proxy = resolveEnvValue(config.proxy);
  if (!proxy) return;
  if (!process.env.HTTP_PROXY?.trim() && !process.env.http_proxy?.trim()) process.env.HTTP_PROXY = proxy;
  if (!process.env.HTTPS_PROXY?.trim() && !process.env.https_proxy?.trim()) process.env.HTTPS_PROXY = proxy;
  const existing = process.env.NO_PROXY ?? process.env.no_proxy ?? "";
  const entries = existing.split(",").map(s => s.trim()).filter(Boolean);
  const seen = new Set(entries.map(e => e.toLowerCase()));
  for (const host of ["localhost", "127.0.0.1", "::1", "[::1]"]) {
    if (!seen.has(host)) {
      entries.push(host);
      seen.add(host);
    }
  }
  process.env.NO_PROXY = entries.join(",");
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

export function readPidFileValue(): number | null {
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

/**
 * Snapshot-guarded stale-state purge: remove the pid/runtime files only when their content
 * still matches what the caller saw BEFORE its liveness probe. A concurrent `ocx start` can
 * write fresh records mid-probe; an unconditional purge would erase the new proxy's state.
 */
export function removePidIfValueIs(snapshot: number | null): void {
  if (!existsSync(getPidPath())) return;
  if (readPidFileValue() !== snapshot) return;
  try {
    unlinkSync(getPidPath());
  } catch { /* ignore */ }
}

export function removeRuntimePortIfPidIs(snapshotPid: number | null): void {
  const current = readRuntimePort();
  if ((current?.pid ?? null) !== snapshotPid) return;
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
  // "src/cli.ts" matches pre-restructure installs still running; "src/cli/index.ts" is current.
  const hasOcxEntrypoint = normalized.includes("src/cli.ts")
    || normalized.includes("src/cli/index.ts")
    || normalized.includes("@bitkyc08/opencodex")
    || /(?:^|[\s/"'])(?:ocx|opencodex)(?:\.cmd)?(?:$|[\s"'])/.test(normalized);
  return hasOcxEntrypoint && /(?:^|[\s"'])start(?:$|[\s"'])/.test(normalized);
}

/** Per-process memo: waitForProxy/findLiveProxy used to spawn powershell on every 150ms poll. */
const ocxStartProcessCache = new Map<number, boolean>();

function isLikelyOcxStartProcess(pid: number): boolean {
  const cached = ocxStartProcessCache.get(pid);
  if (cached !== undefined) return cached;
  const commandLine = readProcessCommandLine(pid);
  if (commandLine === undefined) return false;
  const ok = isOcxStartCommandLine(commandLine);
  ocxStartProcessCache.set(pid, ok);
  return ok;
}

/**
 * Alive pid from the pid file without the expensive Windows command-line probe.
 * Safe for liveness polls: callers still identity-check /healthz before trusting the proxy.
 * Destructive stop/kill paths should keep using {@link readPid}, which verifies the cmdline.
 */
export function readAlivePid(): number | null {
  const pid = readPidFileValue();
  if (pid === null) return null;
  try {
    process.kill(pid, 0);
    return pid;
  } catch (e: unknown) {
    if ((e as NodeJS.ErrnoException).code === "EPERM") return pid;
    return null;
  }
}

/**
 * Full identity check of a KNOWN candidate pid (alive + ocx-start command line).
 * Companion to {@link readAlivePid}: liveness discovery may be cheap, but any pid
 * handed to a destructive caller must pass this check — and must equal the candidate
 * it was asked about, so a pidfile rewrite between discovery and verification can
 * never swap in a different process (TOCTOU guard).
 */
export function verifyPidIdentity(candidatePid: number): number | null {
  try {
    process.kill(candidatePid, 0);
  } catch (e: unknown) {
    if ((e as NodeJS.ErrnoException).code !== "EPERM") return null;
  }
  return isLikelyOcxStartProcess(candidatePid) ? candidatePid : null;
}

function readProcessCommandLine(pid: number): string | undefined {
  try {
    if (process.platform === "win32") {
      // Prefer WMIC over PowerShell: much faster cold start, and windowsHide avoids console flash.
      // Fall back to PowerShell when WMIC is absent (newer Windows images).
      const wmic = `${process.env.SystemRoot ?? "C:\\Windows"}\\System32\\wbem\\WMIC.exe`;
      try {
        const output = execFileSync(wmic, [
          "process", "where", `ProcessId=${pid}`, "get", "CommandLine", "/VALUE",
        ], { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"], timeout: 3000, windowsHide: true });
        const match = /^CommandLine=(.*)$/m.exec(output.replace(/\r/g, ""));
        const value = match?.[1]?.trim();
        if (value) return value;
      } catch {
        /* WMIC missing or failed — fall through */
      }
      const output = execFileSync("powershell.exe", [
        "-NoProfile",
        "-NoLogo",
        "-NonInteractive",
        "-WindowStyle",
        "Hidden",
        "-Command",
        `(Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}").CommandLine`,
      ], { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"], timeout: 3000, windowsHide: true });
      return output.trim() || undefined;
    }
    const output = execFileSync("ps", ["-p", String(pid), "-o", "command="], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 1000,
      windowsHide: true,
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
