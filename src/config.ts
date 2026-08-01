import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, linkSync, mkdirSync, readFileSync, renameSync, truncateSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { Database } from "bun:sqlite";
import * as z from "zod/v4";
import {
  CODEX_ACCOUNT_NAMESPACE_COMBO_ALIAS_COLLISION_ERROR,
  codexAccountNamespaceForModel,
  codexProviderNamespaceKey,
  isValidCodexAccountNamespaceTarget,
  MAIN_CODEX_ACCOUNT_NAMESPACE_TARGET,
} from "./codex/account-namespace-match";
import { COMBO_NAMESPACE, comboConfigIssues } from "./combos/types";
import {
  forgetHardenedSecretPath,
  hardenSecretDir,
  hardenSecretPath,
  hardenSecretPathAsync,
} from "./lib/windows-secret-acl";
import { recordOwnedConfigPath } from "./lib/config-ownership";
import { assertNotRealHomeUnderTest } from "./lib/test-home-guard";
import { providerDestinationConfigError } from "./lib/destination-policy";
import { openRouterRoutingConfigError } from "./providers/openrouter-routing";
import {
  isWirePinnedModel,
  MODEL_ADAPTER_OVERRIDE_ALLOWED,
  OPENAI_PROVIDER_TIER_VERSION,
  REASONING_SUMMARY_DELIVERY_VALUES,
  type OcxClaudeCodeConfig,
  type OcxConfig,
  type OcxApiKeyEntry,
  type OcxProviderConfig,
} from "./types";
import { isCanonicalOpenAiForwardProvider, OPENAI_CODEX_PROVIDER_ID } from "./providers/openai-tiers";
import { parseDesktopProfile } from "./claude/desktop-profile";
import { isCodexReasoningEffort, modelRecordValue } from "./reasoning-effort";
import {
  DEFAULT_APP_OWNED_MEMORY_BUDGET_BYTES,
  MAX_APP_OWNED_MEMORY_BUDGET_MB,
  MIN_APP_OWNED_MEMORY_BUDGET_MB,
} from "./lib/app-owned-memory";

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
  recordOwnedConfigPath(resolveConfigDir(), path);
  const tmp = `${path}.ocx.${process.pid}.${++_atomicSeq}.tmp`;
  let hardened = false;
  try {
    io.write(tmp, content);
    io.harden(tmp);
    hardened = true;
    io.rename(tmp, path);
    forgetHardenedSecretPath(tmp);
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
    if (removed) forgetHardenedSecretPath(tmp);
    if (!removed) throw new AtomicWriteResidualTempError(tmp, hardened, { cause });
    throw cause;
  }
}

/** Async atomic-write I/O: harden may await icacls without blocking the event loop (#612). */
export interface AtomicWriteAsyncIO {
  write: (path: string, content: string) => void | Promise<void>;
  harden: (path: string) => void | Promise<void>;
  rename: (source: string, destination: string) => void | Promise<void>;
  truncate: (path: string) => void | Promise<void>;
  unlink: (path: string) => void | Promise<void>;
}

async function renameAtomicFileAsync(source: string, destination: string): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      renameSync(source, destination);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      const transientWindowsError = process.platform === "win32"
        && (code === "EBUSY" || code === "EPERM" || code === "EACCES");
      if (!transientWindowsError || attempt >= 2) throw error;
      await Bun.sleep(25 * (attempt + 1));
    }
  }
}

/**
 * Async atomic write (#612): same temp+harden+rename and residual-temp policy as
 * atomicWriteFile, but Windows ACL harden yields the event loop. Timeout memo is keyed
 * by the final destination path (not the unique temp, not the parent directory).
 */
export async function atomicWriteFileAsync(
  path: string,
  content: string,
  io?: AtomicWriteAsyncIO,
): Promise<void> {
  const effective: AtomicWriteAsyncIO = io ?? {
    write: (target, value) => writeFileSync(target, value, { encoding: "utf-8", mode: 0o600 }),
    harden: async target => {
      try { chmodSync(target, 0o600); } catch { /* platform may ignore chmod */ }
      if (process.platform === "win32") {
        await hardenSecretPathAsync(target, { required: true, timeoutMemoKey: path });
      }
    },
    rename: renameAtomicFileAsync,
    truncate: target => truncateSync(target, 0),
    unlink: unlinkSync,
  };
  const tmp = `${path}.ocx.${process.pid}.${++_atomicSeq}.tmp`;
  let hardened = false;
  try {
    await effective.write(tmp, content);
    await effective.harden(tmp);
    hardened = true;
    await effective.rename(tmp, path);
    forgetHardenedSecretPath(tmp);
  } catch (cause) {
    let scrubbed = false;
    try {
      await effective.truncate(tmp);
      scrubbed = true;
    } catch (error) {
      if (isMissingPathError(error)) scrubbed = true;
      else {
        try { await effective.write(tmp, ""); scrubbed = true; } catch { /* removal may still succeed */ }
      }
    }
    let removed = false;
    try {
      await effective.unlink(tmp);
      removed = true;
    } catch (error) {
      if (isMissingPathError(error)) removed = true;
      else {
        try { await effective.unlink(tmp); removed = true; }
        catch (retryError) { if (isMissingPathError(retryError)) removed = true; }
      }
    }
    if (!removed && !scrubbed) throw new AtomicWriteSecretResidualError(tmp, { cause });
    if (!removed && !hardened) {
      try { await effective.harden(tmp); hardened = true; } catch { /* zero-byte residual is reported honestly */ }
    }
    if (removed) forgetHardenedSecretPath(tmp);
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
      // Soft-fail: a wedged/failed icacls on CI temp volumes must not abort
      // startServer mid-suite (timeout + EBUSY cascade on shared TEST_DIR).
      // chmod above still applies; live credential writes keep required:true.
      if (process.platform === "win32") hardenSecretPath(target, { required: false });
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
      if (isMissingPathError(error)) {
        removed = true;
      }
      else {
        try { io.unlink(temp); removed = true; }
        catch (retryError) {
          if (isMissingPathError(retryError)) {
            removed = true;
          }
        }
      }
    }
    if (removed) forgetHardenedSecretPath(temp);
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
      forgetHardenedSecretPath(temp);
    } catch (firstError) {
      if (isMissingPathError(firstError)) {
        forgetHardenedSecretPath(temp);
      } else try {
        io.unlink(temp);
        forgetHardenedSecretPath(temp);
      } catch (secondError) {
        if (isMissingPathError(secondError)) {
          forgetHardenedSecretPath(temp);
          return "created";
        }
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
let lastWarningReconciledGeneration = 0;

export function reconcileConfigWarningMemos(generation: number): number {
  if (generation <= lastWarningReconciledGeneration) return 0;
  const removed = warnedConfigFallbacks.size;
  warnedConfigFallbacks.clear();
  lastWarningReconciledGeneration = generation;
  return removed;
}

const providerConfigSchema = z.object({
  adapter: z.string().min(1),
  baseUrl: z.string().min(1),
  mcpMaxTools: z.number().int().positive().optional(),
  mcpMaxSchemaBytes: z.number().int().positive().optional(),
  mcpMaxResultBytes: z.number().int().positive().optional(),
  apiKeyTransport: z.enum(["x-api-key", "bearer"]).optional(),
  responsesPath: z.string().min(1).optional(),
  statelessResponses: z.boolean().optional(),
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

/** Keep the configured API-key header style scoped to Anthropic-compatible key auth. */
export function apiKeyTransportConfigError(
  provider: Pick<OcxProviderConfig, "adapter" | "authMode" | "apiKeyTransport">,
): string | null {
  if (provider.apiKeyTransport === undefined) return null;
  if (provider.apiKeyTransport !== "x-api-key" && provider.apiKeyTransport !== "bearer") {
    return 'apiKeyTransport must be "x-api-key" or "bearer"';
  }
  if (provider.adapter !== "anthropic") {
    return "apiKeyTransport is supported only by the anthropic adapter";
  }
  if (provider.authMode === "oauth" || provider.authMode === "forward" || provider.authMode === "local") {
    return "apiKeyTransport requires Anthropic API-key authentication";
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

const REASONING_SUMMARY_DELIVERY_SET = new Set<string>(REASONING_SUMMARY_DELIVERY_VALUES);

export function reasoningSummaryDeliveryRecordConfigError(
  value: unknown,
  supportsReasoningSummaries: unknown,
  field = "modelReasoningSummaryDelivery",
): string | null {
  if (value === undefined) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) return `${field} must be a plain object`;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return `${field} must be a plain object with own properties`;

  const supports = booleanRecordConfigError(supportsReasoningSummaries, "modelSupportsReasoningSummaries") === null
    && supportsReasoningSummaries && typeof supportsReasoningSummaries === "object"
    ? supportsReasoningSummaries as Record<string, boolean>
    : undefined;
  for (const [key, entry] of Object.entries(value)) {
    if (!key.trim()) return `${field} keys must be nonblank model ids`;
    if (typeof entry !== "string" || !REASONING_SUMMARY_DELIVERY_SET.has(entry)) {
      return `${field}.${key} must be one of: ${REASONING_SUMMARY_DELIVERY_VALUES.join(", ")}`;
    }
    if (modelRecordValue(supports, key) === false) {
      return `${field}.${key} conflicts with modelSupportsReasoningSummaries=false`;
    }
  }
  return null;
}

/**
 * Validate a provider's per-model wire override map (#404).
 *
 * Rejects, rather than silently ignoring, configurations the resolver would refuse:
 * a value outside the allowed wires, a model the upstream pins to one wire, and any
 * override on a canonical forward provider (where switching wires would drop the
 * caller's forwarded credential). Silently dropping them would leave the user
 * believing an override is in effect.
 */
export function modelAdapterRecordConfigError(
  value: unknown,
  field: string,
  providerName: string,
  provider: { adapter?: unknown; authMode?: unknown; baseUrl?: unknown },
): string | null {
  if (value === undefined) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) return `${field} must be a plain object`;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return `${field} must be a plain object with own properties`;
  const entries = Object.entries(value);
  if (entries.length > 0 && isCanonicalOpenAiForwardProvider(provider as OcxProviderConfig)) {
    return `${field} is not supported on the canonical ChatGPT forward provider`;
  }
  for (const [key, entry] of entries) {
    if (!key.trim()) return `${field} keys must be nonblank model ids`;
    if (typeof entry !== "string" || !MODEL_ADAPTER_OVERRIDE_ALLOWED.has(entry)) {
      return `${field}.${key} must be one of: ${[...MODEL_ADAPTER_OVERRIDE_ALLOWED].join(", ")}`;
    }
    if (isWirePinnedModel(providerName, key.trim())) {
      return `${field}.${key} cannot be overridden: the upstream only speaks one wire for this model`;
    }
  }
  return null;
}

const CODEX_ACCOUNT_NAMESPACES_RECORD_ERROR =
  "codexAccountNamespaces must be a plain object mapping account selectors to Codex account ids";
const CODEX_ACCOUNT_NAMESPACE_KEY_ERROR =
  "account selectors must use 1-64 letters, numbers, dots, underscores, or hyphens and cannot be reserved JavaScript object keys";
const CODEX_ACCOUNT_NAMESPACE_TARGET_ERROR =
  "account selector targets must be @main or valid Codex pool-account ids";
const CODEX_ACCOUNT_NAMESPACE_ACCOUNT_ID_COLLISION_ERROR =
  "account selectors must not collide with configured Codex pool-account ids or account selector targets";

function configuredCodexPoolAccountIds(value: unknown): Set<string> {
  const accountIds = new Set<string>();
  if (!Array.isArray(value)) return accountIds;
  for (const account of value) {
    if (!account || typeof account !== "object" || Array.isArray(account)) continue;
    const { id, isMain } = account as { id?: unknown; isMain?: unknown };
    if (typeof id === "string" && isMain !== true) accountIds.add(id);
  }
  return accountIds;
}

const codexAccountNamespacesSchema = z.custom<Record<string, unknown>>(
  (value): value is Record<string, unknown> => !!value
    && typeof value === "object"
    && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null),
  { error: CODEX_ACCOUNT_NAMESPACES_RECORD_ERROR },
).superRefine((accountNamespaces, ctx) => {
  // Inspect raw own entries before z.record parses them; Zod omits __proto__ record keys.
  for (const [namespace, accountId] of Object.entries(accountNamespaces)) {
    if (!isValidProviderName(namespace)) {
      ctx.addIssue({
        code: "custom",
        path: [namespace],
        message: CODEX_ACCOUNT_NAMESPACE_KEY_ERROR,
      });
    }
    if (!isValidCodexAccountNamespaceTarget(accountId)) {
      ctx.addIssue({
        code: "custom",
        path: [namespace],
        message: CODEX_ACCOUNT_NAMESPACE_TARGET_ERROR,
      });
    }
  }
}).pipe(z.record(z.string(), z.string()));

/**
 * Deliberately permissive. A user's config is not ours to invalidate: a strict
 * entry fails the whole parse, and loadConfig's fallback then backs the file up
 * and returns defaults — losing providers and pool accounts because one key name
 * was too long. Length and charset rules live at the POST/PATCH boundary, where
 * rejecting produces a 400 instead. `.passthrough()` keeps unknown per-key
 * properties across a load -> mutate -> save round trip.
 *
 * Only `key` is load-bearing: admission compares that string and nothing else
 * (src/server/auth-cors.ts isDataPlaneAdmissionSecret). So the secret is the one
 * field that must be a usable string, and every piece of metadata around it
 * degrades instead of taking the credential down with it. Dropping a working key
 * because its `name` was hand-edited to a number would be a silent revocation —
 * and on a remote bind, potentially a server that refuses to start.
 *
 * "Usable" matches admission exactly. The presented token is trimmed before the
 * comparison but the stored value is not, so a key with surrounding whitespace
 * can never match either form of itself. Keeping one would be worse than dropping
 * it: `system-env.ts` and `cli/claude.ts` hand `apiKeys[0].key` to launched
 * clients, so a junk first entry would mask a valid later one.
 */
const apiKeyEntrySchema = z.object({
  key: z.string().refine(isUsableApiKeySecret),
  // Degrades to "" here; every schema consumer then runs `normalizeApiKeyIds`,
  // which fills it deterministically so the id is stable across loads.
  id: z.string().catch(""),
  name: z.string().catch(""),
  createdAt: z.string().catch(""),
}).passthrough();

const configSchema = z.object({
  port: z.number().int().min(0).max(65535).default(10100),
  managementUsageMaxReadBytes: z.number().int().positive().default(64 * 1024 * 1024),
  appOwnedMemoryBudgetMb: z.number().int()
    .min(MIN_APP_OWNED_MEMORY_BUDGET_MB)
    .max(MAX_APP_OWNED_MEMORY_BUDGET_MB)
    .default(DEFAULT_APP_OWNED_MEMORY_BUDGET_BYTES / (1024 * 1024))
    .catch(DEFAULT_APP_OWNED_MEMORY_BUDGET_BYTES / (1024 * 1024)),
  // A blank hostname degrades to undefined rather than failing the parse. `getDefaultConfig()`
  // carries no `hostname` key, so the backup-and-defaults repair path below cannot merge one
  // away — a hand-edited `"hostname": ""` would fail twice and reset providers/apiKeys to
  // defaults, which is strictly worse than the bind bug this validation exists for. Degrading
  // is safe: startServer() already falls back to 127.0.0.1 for a missing hostname. Write-time
  // rejection lives in validateConfigCandidate() so bad values still surface to the caller.
  hostname: z.string().trim().min(1).optional().catch(undefined),
  providers: z.record(z.string(), providerConfigSchema),
  defaultProvider: z.string().min(1).default("openai"),
  openaiProviderTierVersion: z.union([z.literal(1), z.literal(2)]).optional(),
  providerContextCaps: z.record(z.string(), z.number().int().positive()).optional(),
  contextCapValue: z.number().int().positive().optional(),
  multiAgentGuidanceEnabled: z.boolean().optional(),
  // These selections pre-date schema validation and used to pass through as
  // unknown fields. Invalid hand edits must disable only the optional
  // delegation/native-default feature, not reject the whole config and hide
  // otherwise valid providers, accounts, or the configured listen port.
  injectionModel: z.string().optional().catch(undefined),
  injectionEffort: z.string().optional().catch(undefined),
  syncCodexSubagentDefaults: z.boolean().optional().catch(undefined),
  codexShimAutoRestore: z.boolean().optional(),
  pausedCodexAccountIds: z.array(z.string().regex(/^[a-zA-Z0-9._-]{1,64}$/)).optional(),
  codexAccountNamespaces: codexAccountNamespacesSchema.optional(),
  // Model ids excluded from the Grok Build managed block (dashboard switches).
  grokExcludedModels: z.array(z.string()).optional(),
  // Invalid values degrade to undefined ("auto") instead of failing the whole
  // parse: a hand-edited typo must never trip the backup-and-defaults repair
  // path below and wipe providers/pool accounts. Warning emitted in loadConfig.
  streamMode: z.enum(["auto", "legacy-tee", "eager-relay"]).optional().catch(undefined),
  // Same degrade-don't-reject rationale as the fields above: a hand-edited
  // non-string must not trip the backup-and-defaults repair path. Unset then
  // takes the canonical sideband path (src/server/live.ts normalizeSidebandRoot).
  experimentalRealtimeWsBaseUrl: z.string().optional().catch(undefined),
  // Salvage element by element, and never fail the parse. Two spellings were
  // measured on this zod version and both lose data:
  //   `z.array(entry).catch(undefined)` -> one bad entry discards EVERY key
  //   `z.array(z.unknown())`            -> a non-array value still raises
  //                                        invalid_type, reaching the
  //                                        backup-and-defaults repair path
  // Starting from `unknown` is what makes both survivable. A key the user still
  // has deployed must not be collateral damage for one bad neighbour, and on a
  // remote bind an emptied array is worse than cosmetic: assertServerAuthConfig
  // refuses to start without a data credential.
  apiKeys: z.unknown().optional().transform(value => {
    if (value === undefined) return undefined;
    if (!Array.isArray(value)) return undefined;
    return value
      .filter(row => apiKeyEntrySchema.safeParse(row).success)
      .map(row => apiKeyEntrySchema.parse(row) as OcxApiKeyEntry);
  }),
}).passthrough().superRefine((config, ctx) => {
  const claudeCode = (config as { claudeCode?: unknown }).claudeCode;
  if (claudeCode !== undefined && (!claudeCode || typeof claudeCode !== "object" || Array.isArray(claudeCode))) {
    ctx.addIssue({ code: "custom", path: ["claudeCode"], message: "claudeCode must be an object" });
  } else if (claudeCode) {
    const claude = claudeCode as { desktopProfile?: unknown };
    if (claude.desktopProfile !== undefined) {
      try {
        parseDesktopProfile(claude.desktopProfile);
      } catch (error) {
        ctx.addIssue({
          code: "custom",
          path: ["claudeCode", "desktopProfile"],
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  const accountNamespaces = config.codexAccountNamespaces;
  if (accountNamespaces) {
    const configuredAccountIds = configuredCodexPoolAccountIds(config.codexAccounts);
    const configuredProviderNamespaces = new Set([
      COMBO_NAMESPACE,
      OPENAI_CODEX_PROVIDER_ID,
      ...Object.keys(config.providers),
    ].map(codexProviderNamespaceKey));
    const namespaceTargets = new Set(
      Object.values(accountNamespaces)
        .filter(accountId => accountId !== MAIN_CODEX_ACCOUNT_NAMESPACE_TARGET),
    );
    for (const namespace of Object.keys(accountNamespaces)) {
      if (configuredProviderNamespaces.has(codexProviderNamespaceKey(namespace))) {
        ctx.addIssue({
          code: "custom",
          path: ["codexAccountNamespaces", namespace],
          message: "account selectors must not collide with configured provider or combo namespaces",
        });
      }
      if (configuredAccountIds.has(namespace) || namespaceTargets.has(namespace)) {
        ctx.addIssue({
          code: "custom",
          path: ["codexAccountNamespaces", namespace],
          message: CODEX_ACCOUNT_NAMESPACE_ACCOUNT_ID_COLLISION_ERROR,
        });
      }
    }
  }
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
    const apiKeyTransportError = apiKeyTransportConfigError(provider as OcxProviderConfig);
    if (apiKeyTransportError) {
      ctx.addIssue({
        code: "custom",
        path: ["providers", name, "apiKeyTransport"],
        message: apiKeyTransportError,
      });
    }
    const modelAdaptersError = modelAdapterRecordConfigError(
      (provider as { modelAdapters?: unknown }).modelAdapters,
      "modelAdapters",
      name,
      provider,
    );
    if (modelAdaptersError) {
      ctx.addIssue({
        code: "custom",
        path: ["providers", name, "modelAdapters"],
        message: modelAdaptersError,
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
    const reasoningSummaryDeliveryError = reasoningSummaryDeliveryRecordConfigError(
      (provider as { modelReasoningSummaryDelivery?: unknown }).modelReasoningSummaryDelivery,
      (provider as { modelSupportsReasoningSummaries?: unknown }).modelSupportsReasoningSummaries,
    );
    if (reasoningSummaryDeliveryError) {
      ctx.addIssue({
        code: "custom",
        path: ["providers", name, "modelReasoningSummaryDelivery"],
        message: reasoningSummaryDeliveryError,
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
        const alias = raw && typeof raw === "object" && !Array.isArray(raw)
          ? (raw as { alias?: unknown }).alias
          : undefined;
        if (typeof alias === "string" && codexAccountNamespaceForModel(accountNamespaces, alias.trim())) {
          ctx.addIssue({
            code: "custom",
            path: ["combos", id, "alias"],
            message: CODEX_ACCOUNT_NAMESPACE_COMBO_ALIAS_COLLISION_ERROR,
          });
        }
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
/**
 * The schema's `.catch(undefined)` silently degrades an invalid persisted
 * `streamMode` to "auto"; surface that once so a hand-edited typo (e.g.
 * "legacy_tee") is discoverable instead of silently changing stream shape.
 */
function warnDegradedStreamMode(rawParsed: unknown, validated: OcxConfig): void {
  if (!rawParsed || typeof rawParsed !== "object") return;
  const raw = (rawParsed as Record<string, unknown>).streamMode;
  if (raw !== undefined && validated.streamMode === undefined) {
    console.warn(`⚠️  config.json streamMode ${JSON.stringify(raw)} is invalid (expected "auto", "legacy-tee", or "eager-relay") — falling back to "auto"`);
  }
}

/**
 * Companion to {@link warnDegradedStreamMode} for a blank persisted `hostname`. The bind
 * falls back to loopback, which is the safe direction but not what the file asked for —
 * say so once instead of silently ignoring the field.
 */
function warnDegradedHostname(rawParsed: unknown, validated: OcxConfig): void {
  if (!rawParsed || typeof rawParsed !== "object") return;
  const raw = (rawParsed as Record<string, unknown>).hostname;
  if (raw !== undefined && validated.hostname === undefined) {
    console.warn(`⚠️  config.json hostname ${JSON.stringify(raw)} is not a usable bind address — falling back to 127.0.0.1`);
  }
}

/**
 * The apiKeys schema salvages entry by entry rather than failing the parse, so a
 * dropped key is otherwise invisible — and it will not be re-saved by the next
 * mutation. Say so out loud. Compares the raw array against the validated one,
 * the same shape as the degrade warnings above.
 */
/** One definition of "usable secret", shared by the schema and the warnings. */
function isUsableApiKeySecret(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value === value.trim();
}

/**
 * Give every salvaged key a stable, targetable id.
 *
 * Pure and deterministic on purpose. Two earlier spellings were wrong: minting a
 * UUID inside the schema transform handed out a different id on every parse, and
 * repairing-then-writing during `loadConfig` put a file write on the read path,
 * where it could clobber a concurrent legitimate save with a stale snapshot.
 *
 * So the replacement id is derived from the entry's position, which is already
 * how the file orders these rows: same file in, same ids out, no I/O and no
 * randomness. It is not derived from the secret — a public identifier should
 * never be a function of key material.
 */
function normalizeApiKeyIds(config: OcxConfig): OcxConfig {
  const keys = config.apiKeys;
  if (!keys?.length) return config;
  // Reserve every explicit id BEFORE synthesizing any, or a synthetic
  // `salvaged-1` assigned to row 1 would push a row that legitimately owns that
  // id onto `salvaged-2`. An id the user already has is the one thing this
  // repair must never take away.
  const reserved = new Set<string>();
  for (const entry of keys) {
    if (entry.id) reserved.add(entry.id);
  }
  const taken = new Set<string>(reserved);
  const kept = new Set<string>();
  keys.forEach((entry, index) => {
    // The first row holding an explicit id keeps it; later collisions are the
    // ones that move.
    if (entry.id && !kept.has(entry.id)) {
      kept.add(entry.id);
      return;
    }
    let candidate = `salvaged-${index + 1}`;
    let suffix = 1;
    while (taken.has(candidate)) candidate = `salvaged-${index + 1}-${++suffix}`;
    entry.id = candidate;
    taken.add(candidate);
    kept.add(candidate);
  });
  return config;
}

function warnDegradedApiKeys(rawParsed: unknown, validated: OcxConfig): void {
  if (!rawParsed || typeof rawParsed !== "object") return;
  const raw = (rawParsed as Record<string, unknown>).apiKeys;
  if (raw === undefined) return;
  if (!Array.isArray(raw)) {
    console.warn(`⚠️  config.json apiKeys is not an array — ignoring it; generate a new key from the API tab`);
    return;
  }
  const dropped = raw.length - (validated.apiKeys?.length ?? 0);
  if (dropped > 0) {
    console.warn(`⚠️  config.json apiKeys: skipped ${dropped} malformed entr${dropped === 1 ? "y" : "ies"} — the remaining keys still work`);
  }
  // Same-length repairs are invisible to the count above, and they are the ones
  // that show up as a blank name or an unknown date in the dashboard. Say so.
  const repaired = raw.filter(row => {
    if (!row || typeof row !== "object") return false;
    const entry = row as Record<string, unknown>;
    // Must match the schema exactly: a row whose key is unusable was DROPPED, and
    // saying "the key still works" about it would be a lie.
    if (!isUsableApiKeySecret(entry.key)) return false;
    return typeof entry.id !== "string" || !entry.id
      || typeof entry.name !== "string"
      || typeof entry.createdAt !== "string";
  }).length;
  if (repaired > 0) {
    console.warn(`⚠️  config.json apiKeys: repaired metadata on ${repaired} entr${repaired === 1 ? "y" : "ies"} — the key still works, but its name or date may read as unknown`);
  }
  // A duplicate id is repaired too, and it is not visible in either count above.
  const ids = raw.filter(row => row && typeof row === "object" && isUsableApiKeySecret((row as Record<string, unknown>).key))
    .map(row => (row as Record<string, unknown>).id)
    .filter((id): id is string => typeof id === "string" && !!id);
  const duplicates = ids.length - new Set(ids).size;
  if (duplicates > 0) {
    console.warn(`⚠️  config.json apiKeys: ${duplicates} entr${duplicates === 1 ? "y" : "ies"} shared an id — reassigned so each key can be renamed and revoked on its own`);
  }
}

const CLAUDE_SUBAGENT_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;

function isClaudeSubagentEffort(value: unknown): value is NonNullable<OcxClaudeCodeConfig["subagentEffort"]> {
  return typeof value === "string" && CLAUDE_SUBAGENT_EFFORTS.includes(value as typeof CLAUDE_SUBAGENT_EFFORTS[number]);
}

function rawClaudeSubagentEffort(rawParsed: unknown): unknown {
  const raw = rawConfigRecord(rawParsed);
  const claudeCode = raw?.claudeCode;
  if (!claudeCode || typeof claudeCode !== "object" || Array.isArray(claudeCode)) return undefined;
  return (claudeCode as Record<string, unknown>).subagentEffort;
}

function normalizePersistedClaudeCode(claudeCode: unknown): OcxConfig["claudeCode"] {
  if (!claudeCode || typeof claudeCode !== "object" || Array.isArray(claudeCode)) {
    return claudeCode as OcxConfig["claudeCode"];
  }
  const normalized = { ...claudeCode } as Record<string, unknown>;
  if (Object.hasOwn(normalized, "subagentEffort") && !isClaudeSubagentEffort(normalized.subagentEffort)) {
    delete normalized.subagentEffort;
  }
  return normalized as OcxConfig["claudeCode"];
}

function normalizeClaudeSubagentEffort(config: OcxConfig, rawParsed: unknown): OcxConfig {
  const rawEffort = rawClaudeSubagentEffort(rawParsed);
  if (rawEffort === undefined || isClaudeSubagentEffort(rawEffort)) return config;
  return { ...config, claudeCode: normalizePersistedClaudeCode(config.claudeCode) };
}

function warnDegradedClaudeSubagentEffort(rawParsed: unknown): void {
  const rawEffort = rawClaudeSubagentEffort(rawParsed);
  if (rawEffort !== undefined && !isClaudeSubagentEffort(rawEffort)) {
    console.warn(`⚠️  config.json claudeCode.subagentEffort is invalid (expected ${CLAUDE_SUBAGENT_EFFORTS.join(", ")}) — ignoring it. Other settings were preserved.`);
  }
}

type NativeSubagentPersistedField = "injectionModel" | "injectionEffort" | "syncCodexSubagentDefaults";

function rawConfigRecord(rawParsed: unknown): Record<string, unknown> | null {
  return rawParsed !== null && typeof rawParsed === "object" && !Array.isArray(rawParsed)
    ? rawParsed as Record<string, unknown>
    : null;
}

function malformedNativeSubagentFields(rawParsed: unknown): NativeSubagentPersistedField[] {
  const raw = rawConfigRecord(rawParsed);
  if (!raw) return [];
  const malformed: NativeSubagentPersistedField[] = [];
  if (Object.hasOwn(raw, "injectionModel") && typeof raw.injectionModel !== "string") {
    malformed.push("injectionModel");
  }
  if (Object.hasOwn(raw, "injectionEffort") && typeof raw.injectionEffort !== "string") {
    malformed.push("injectionEffort");
  }
  if (Object.hasOwn(raw, "syncCodexSubagentDefaults") && typeof raw.syncCodexSubagentDefaults !== "boolean") {
    malformed.push("syncCodexSubagentDefaults");
  }
  return malformed;
}

function malformedNativeSubagentFieldWarning(field: NativeSubagentPersistedField): string {
  const expected = field === "syncCodexSubagentDefaults" ? "a boolean" : "a string";
  return `${field} ignored: expected ${expected}`;
}

function nativeSubagentSyncDisabledReason(config: OcxConfig, rawParsed?: unknown): string | null {
  if (config.syncCodexSubagentDefaults !== true) return null;
  const malformed = malformedNativeSubagentFields(rawParsed);
  if (malformed.includes("injectionModel")) return "injectionModel must be a string";
  if (!config.injectionModel?.trim()) return "a nonblank injectionModel is required";
  if (malformed.includes("injectionEffort")) return "injectionEffort must be a string or omitted";
  if (config.injectionEffort !== undefined && !isCodexReasoningEffort(config.injectionEffort)) {
    return "injectionEffort must be a supported Codex reasoning effort";
  }
  return null;
}

function normalizeNativeSubagentSync(config: OcxConfig, rawParsed?: unknown): OcxConfig {
  if (!nativeSubagentSyncDisabledReason(config, rawParsed)) return config;
  const normalized = { ...config };
  delete normalized.syncCodexSubagentDefaults;
  return normalized;
}

function warnDegradedNativeSubagentConfig(rawParsed: unknown, config: OcxConfig): void {
  for (const field of malformedNativeSubagentFields(rawParsed)) {
    console.warn(`⚠️  config.json ${malformedNativeSubagentFieldWarning(field)}. Other settings were preserved.`);
  }
  const reason = nativeSubagentSyncDisabledReason(config, rawParsed);
  if (reason) {
    console.warn(`⚠️  config.json syncCodexSubagentDefaults was disabled: ${reason}. Other settings were preserved.`);
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
    if (result.success) {
      const config = normalizeApiKeyIds(result.data as OcxConfig);
      warnDegradedStreamMode(parsed, config);
      warnDegradedHostname(parsed, config);
      warnDegradedApiKeys(parsed, config);
      warnDegradedClaudeSubagentEffort(parsed);
      warnDegradedNativeSubagentConfig(parsed, config);
      return normalizeClaudeSubagentEffort(normalizeNativeSubagentSync(config, parsed), parsed);
    }
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
      const config = normalizeApiKeyIds(retryResult.data as OcxConfig);
      warnDegradedHostname(parsed, config);
      warnDegradedApiKeys(parsed, config);
      warnDegradedClaudeSubagentEffort(parsed);
      warnDegradedNativeSubagentConfig(parsed, config);
      return normalizeClaudeSubagentEffort(normalizeNativeSubagentSync(config, parsed), parsed);
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

type ConfigFileSnapshot = {
  diagnostics: ConfigDiagnostics;
  /** Exact file contents, including a possible BOM, used as the optimistic revision. */
  raw?: string;
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

function validFileConfigDiagnostics(config: OcxConfig, rawParsed: unknown): ConfigDiagnostics {
  // Unsafe hand-edited optional values are disabled in memory instead of rejecting
  // the entire config, which would hide unrelated providers/accounts. The next
  // ordinary save persists the normalized absence.
  const syncDisabledReason = nativeSubagentSyncDisabledReason(config, rawParsed);
  const rawEffort = rawClaudeSubagentEffort(rawParsed);
  const normalized = normalizeClaudeSubagentEffort(normalizeNativeSubagentSync(config, rawParsed), rawParsed);
  const warnings = configPlaceholderWarnings(normalized);
  if (rawEffort !== undefined && !isClaudeSubagentEffort(rawEffort)) {
    warnings.push(`claudeCode.subagentEffort ignored: expected one of ${CLAUDE_SUBAGENT_EFFORTS.join(", ")}`);
  }
  warnings.push(...malformedNativeSubagentFields(rawParsed).map(malformedNativeSubagentFieldWarning));
  if (syncDisabledReason) {
    warnings.push(`syncCodexSubagentDefaults ignored: ${syncDisabledReason}`);
  }
  return {
    config: normalized,
    source: "file",
    error: null,
    ...(warnings.length > 0 ? { warnings } : {}),
  };
}

export function subagentDefaultSyncEffective(
  config: Pick<OcxConfig, "syncCodexSubagentDefaults" | "injectionModel">,
): boolean {
  return config.syncCodexSubagentDefaults === true && Boolean(config.injectionModel?.trim());
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

/**
 * Reject a hostname the schema deliberately degrades on read. Load-time has to keep a
 * blank value non-fatal (see the `hostname` field comment), but an incoming write is a
 * live caller who can be told the value is wrong — silently rewriting it to loopback
 * would look like the bind succeeded on the address they asked for.
 */
function blankHostnameError(value: unknown): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const hostname = (value as Record<string, unknown>).hostname;
  if (hostname === undefined) return null;
  if (typeof hostname !== "string" || !hostname.trim()) {
    return "schema_invalid: hostname: must be a nonblank bind address";
  }
  return null;
}

function claudeSubagentEffortError(value: unknown): string | null {
  const effort = rawClaudeSubagentEffort(value);
  if (effort === undefined || isClaudeSubagentEffort(effort)) return null;
  return `schema_invalid: claudeCode.subagentEffort: must be one of ${CLAUDE_SUBAGENT_EFFORTS.join(", ")}`;
}

function appOwnedMemoryBudgetError(value: unknown): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const budget = (value as Record<string, unknown>).appOwnedMemoryBudgetMb;
  if (budget === undefined) return null;
  if (typeof budget !== "number" || !Number.isInteger(budget)
    || budget < MIN_APP_OWNED_MEMORY_BUDGET_MB || budget > MAX_APP_OWNED_MEMORY_BUDGET_MB) {
    return `schema_invalid: appOwnedMemoryBudgetMb: must be an integer from ${MIN_APP_OWNED_MEMORY_BUDGET_MB} to ${MAX_APP_OWNED_MEMORY_BUDGET_MB}`;
  }
  return null;
}

/** Validate an in-memory config candidate without touching disk. Used by headless CLI import/set. */
export function validateConfigCandidate(value: unknown): { ok: true; config: OcxConfig } | { ok: false; error: string } {
  const boundaryError = blankHostnameError(value) ?? claudeSubagentEffortError(value) ?? appOwnedMemoryBudgetError(value);
  if (boundaryError) return { ok: false, error: boundaryError };
  const result = configSchema.safeParse(value);
  if (result.success) return { ok: true, config: normalizeApiKeyIds(result.data as OcxConfig) };
  return { ok: false, error: schemaDiagnosticsError(result.error) };
}

function configDiagnosticsFromRaw(raw: string): ConfigDiagnostics {
  try {
    const parsed = JSON.parse(raw.replace(/^\uFEFF/, ""));
    const result = configSchema.safeParse(parsed);
    if (result.success) {
      return validFileConfigDiagnostics(normalizeApiKeyIds(result.data as OcxConfig), parsed);
    }

    const retryResult = configSchema.safeParse(mergeConfigDefaults(parsed));
    if (retryResult.success) {
      return validFileConfigDiagnostics(normalizeApiKeyIds(retryResult.data as OcxConfig), parsed);
    }

    return { config: getDefaultConfig(), source: "fallback", error: schemaDiagnosticsError(result.error) };
  } catch {
    return { config: getDefaultConfig(), source: "fallback", error: "invalid_json" };
  }
}

function readConfigFileSnapshot(): ConfigFileSnapshot {
  try {
    const raw = readFileSync(getConfigPath(), "utf-8");
    return { diagnostics: configDiagnosticsFromRaw(raw), raw };
  } catch (error) {
    if (isMissingPathError(error)) {
      return {
        diagnostics: { config: getDefaultConfig(), source: "default", error: null },
      };
    }
    return {
      diagnostics: { config: getDefaultConfig(), source: "fallback", error: "invalid_json" },
    };
  }
}

export function readConfigDiagnostics(): ConfigDiagnostics {
  return readConfigFileSnapshot().diagnostics;
}

const CONFIG_MUTATION_DB_FILENAME = "config-mutation.sqlite";
const CONFIG_MUTATION_DB_SIDECARS = ["-journal", "-wal", "-shm"] as const;

export class ConfigMutationLockError extends Error {
  readonly code = "CONFIG_MUTATION_LOCK_UNAVAILABLE";

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ConfigMutationLockError";
  }
}

function configMutationDatabasePath(): string {
  const dir = getConfigDir();
  // First statement on purpose: a rejected mutation must leave nothing behind, not a
  // freshly created/chmod'd directory or database. See src/lib/test-home-guard.ts.
  assertNotRealHomeUnderTest(dir);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  } else {
    try { chmodSync(dir, 0o700); } catch { /* best-effort on existing dir */ }
  }
  if (process.platform === "win32") {
    hardenSecretDir(dir, { required: true });
  }
  const path = join(dir, CONFIG_MUTATION_DB_FILENAME);
  recordOwnedConfigPath(dir, path);
  for (const suffix of CONFIG_MUTATION_DB_SIDECARS) {
    recordOwnedConfigPath(dir, `${path}${suffix}`);
  }
  return path;
}

let configMutationLockDepth = 0;

/**
 * Serialize synchronous config and Codex credential-generation commits across processes with an
 * OS-backed SQLite write transaction. `busy_timeout=0` is deliberate: runtime request paths must
 * fail immediately under contention rather than freeze the Bun event loop. Process exit releases
 * SQLite locks without stale-owner deletion or lease recovery races.
 *
 * Reentrancy is limited to the current synchronous call stack; never return a Promise from `fn`.
 */
export function withConfigMutationLockSync<T>(fn: () => T): T {
  if (configMutationLockDepth > 0) {
    configMutationLockDepth += 1;
    try {
      return fn();
    } finally {
      configMutationLockDepth -= 1;
    }
  }
  const path = configMutationDatabasePath();
  let database: Database | undefined;
  let transactionOpen = false;
  try {
    database = new Database(path, { create: true });
    try { chmodSync(path, 0o600); } catch { /* platform may ignore chmod */ }
    database.exec("PRAGMA busy_timeout = 0; BEGIN IMMEDIATE");
    transactionOpen = true;
  } catch (cause) {
    try { database?.close(); } catch { /* acquisition already failed */ }
    const code = cause && typeof cause === "object" && "code" in cause
      ? String((cause as { code?: unknown }).code)
      : "";
    throw new ConfigMutationLockError(
      code === "SQLITE_BUSY" ? "Config mutation already in progress" : "Could not acquire config mutation transaction",
      { cause },
    );
  }

  configMutationLockDepth = 1;
  try {
    const value = fn();
    database.exec("COMMIT");
    transactionOpen = false;
    return value;
  } catch (error) {
    if (transactionOpen) {
      try { database.exec("ROLLBACK"); } catch { /* close below still releases the OS lock */ }
      transactionOpen = false;
    }
    throw error;
  } finally {
    configMutationLockDepth = 0;
    try { database.close(); } catch { /* the OS lock is released with the handle */ }
  }
}

function persistConfigUnlocked(config: OcxConfig): void {
  const configPath = getConfigPath();
  atomicWriteFile(configPath, JSON.stringify(config, null, 2) + "\n");
}

export function saveConfig(config: OcxConfig): void {
  // Keep the real-home assertion ahead of even lock-directory preparation.
  assertNotRealHomeUnderTest(getConfigDir());
  withConfigMutationLockSync(() => persistConfigUnlocked(config));
}

export type PersistedConfigMutation<T> = {
  changed: boolean;
  value: T;
};

export type PersistedConfigMutationOutcome<T> =
  | { status: "committed" | "unchanged"; value: T }
  | { status: "unavailable"; reason: "missing" | "invalid" | "conflict" };

const CONFIG_MUTATION_MAX_REBASE_ATTEMPTS = 3;
let persistedConfigMutationBeforeCommitForTests: (() => void) | null = null;

/** Test-only one-shot seam: inject a competing mutation after the first decision, before freshness revalidation. */
export function setPersistedConfigMutationBeforeCommitForTests(hook: (() => void) | null): void {
  persistedConfigMutationBeforeCommitForTests = hook;
}

function unavailableConfigMutationReason(snapshot: ConfigFileSnapshot): "missing" | "invalid" {
  return snapshot.diagnostics.source === "default" ? "missing" : "invalid";
}

/**
 * Patch a schema-valid on-disk config under the shared mutation lock. Cooperating writers are
 * serialized; the callback is rerun on the newest snapshot so observed direct byte changes rebase
 * and credential predicates are re-evaluated immediately before the atomic commit. A writer that
 * ignores the coordinator can still change bytes after the final check because the filesystem has
 * no portable conditional rename. Missing or malformed config always fails closed and is never
 * recreated from a prior snapshot.
 */
export function mutatePersistedConfig<T>(
  mutate: (config: OcxConfig) => PersistedConfigMutation<T>,
): PersistedConfigMutationOutcome<T> {
  // Avoid creating/opening the coordinator database for a read-path update that already knows
  // there is no valid config. The same check runs again under the transaction for authority.
  const observed = readConfigFileSnapshot();
  if (observed.diagnostics.source !== "file" || observed.raw === undefined) {
    return { status: "unavailable", reason: unavailableConfigMutationReason(observed) };
  }
  return withConfigMutationLockSync(() => {
    let base = readConfigFileSnapshot();
    for (let attempt = 0; attempt < CONFIG_MUTATION_MAX_REBASE_ATTEMPTS; attempt += 1) {
      if (base.diagnostics.source !== "file" || base.raw === undefined) {
        return { status: "unavailable", reason: unavailableConfigMutationReason(base) };
      }

      const tentativeConfig = structuredClone(base.diagnostics.config);
      const tentative = mutate(tentativeConfig);
      if (!tentative.changed) return { status: "unchanged", value: tentative.value };

      const hook = persistedConfigMutationBeforeCommitForTests;
      persistedConfigMutationBeforeCommitForTests = null;
      hook?.();

      const latest = readConfigFileSnapshot();
      if (latest.diagnostics.source !== "file" || latest.raw === undefined) {
        return { status: "unavailable", reason: unavailableConfigMutationReason(latest) };
      }
      if (latest.raw !== base.raw) {
        base = latest;
        continue;
      }

      // Re-run against a fresh clone even when config bytes are unchanged: a Codex credential
      // generation lives in a separate file and may have changed at the injected seam.
      const confirmedConfig = structuredClone(latest.diagnostics.config);
      const confirmed = mutate(confirmedConfig);
      if (!confirmed.changed) return { status: "unchanged", value: confirmed.value };

      const commitBase = readConfigFileSnapshot();
      if (commitBase.diagnostics.source !== "file" || commitBase.raw === undefined) {
        return { status: "unavailable", reason: unavailableConfigMutationReason(commitBase) };
      }
      if (commitBase.raw !== latest.raw) {
        base = commitBase;
        continue;
      }

      persistConfigUnlocked(confirmedConfig);
      return { status: "committed", value: confirmed.value };
    }
    return { status: "unavailable", reason: "conflict" };
  });
}

export function websocketsEnabled(config: Pick<OcxConfig, "websockets">): boolean {
  return config.websockets === true;
}

// ---------------------------------------------------------------------------
// Hand-edit protection for the `claudeCode` subtree (devlog 260726_claude_auth_auto/040 H1).
//
// `saveConfig` serializes the WHOLE config object, so ANY service-time save — a model
// visibility toggle, a 429 key rotation on the request path — rewrites `claudeCode`
// from whatever the long-lived server config happens to hold. A user who hand-edits
// `config.json` while the proxy runs then watches their edit vanish for no visible
// reason (issue #488). Enumerating `claudeCode` mutators cannot fix that; the guard has
// to live in ONE save wrapper that every live-config writer goes through.
// ---------------------------------------------------------------------------

/**
 * Baseline keyed on the CONFIG INSTANCE, never a module global: a second `loadConfig()`
 * elsewhere must not refresh the baseline the long-lived server config is judged
 * against, or a later stale save would masquerade as "our own change".
 */
const claudeCodeBaseline = new WeakMap<OcxConfig, unknown>();

/**
 * The live config retains the address of the socket Bun actually opened, while
 * this map retains the operator's desired address for the next process start.
 * Keeping them separate prevents an unrelated live save from restoring a stale
 * externally exposed bind after OAuth adopted a newer loopback disk config.
 */
type PersistedServerBinding = Pick<OcxConfig, "port" | "hostname">;

const persistedLiveServerBinding = new WeakMap<OcxConfig, PersistedServerBinding>();

/**
 * Arm the baseline for a long-lived config. MANDATORY at `startServer`, not lazy on
 * first save — arming lazily would lose exactly the hand edit made before that first
 * save, which is the case the guard exists for.
 */
export function armClaudeCodeBaseline(config: OcxConfig): void {
  claudeCodeBaseline.set(config, structuredClone(config.claudeCode));
}

/** Test seam only: is this instance armed? */
export function claudeCodeBaselineArmed(config: OcxConfig): boolean {
  return claudeCodeBaseline.has(config);
}

/**
 * Structural compare of parsed subtrees. NOT `JSON.stringify`: key order must not
 * decide whether a user's hand edit survives.
 */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, index) => deepEqual(item, b[index]));
  }
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  // `undefined` values and absent keys are the same thing after a JSON round-trip.
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
  for (const key of keys) {
    if (left[key] === undefined && right[key] === undefined) continue;
    if (!deepEqual(left[key], right[key])) return false;
  }
  return true;
}

const MISSING_CONFIG_VALUE = Symbol("missing-config-value");
type ConfigMergeValue = unknown | typeof MISSING_CONFIG_VALUE;

function isPlainConfigRecord(value: ConfigMergeValue): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function ownConfigValue(record: Record<string, unknown>, key: string): ConfigMergeValue {
  return Object.hasOwn(record, key) ? record[key] : MISSING_CONFIG_VALUE;
}

function cloneConfigValue(value: ConfigMergeValue): ConfigMergeValue {
  return value === MISSING_CONFIG_VALUE ? value : structuredClone(value);
}

function reconcileConfigRecord(
  live: Record<string, unknown>,
  baseline: Record<string, unknown>,
  persisted: Record<string, unknown>,
  skippedKeys?: ReadonlySet<string>,
): void {
  const keys = new Set([...Object.keys(baseline), ...Object.keys(live), ...Object.keys(persisted)]);
  for (const key of keys) {
    if (skippedKeys?.has(key)) continue;
    const merged = reconcileConfigValue(
      ownConfigValue(baseline, key),
      ownConfigValue(live, key),
      ownConfigValue(persisted, key),
    );
    if (merged === MISSING_CONFIG_VALUE) delete live[key];
    else live[key] = merged;
  }
}

function reconcileConfigValue(
  baseline: ConfigMergeValue,
  live: ConfigMergeValue,
  persisted: ConfigMergeValue,
): ConfigMergeValue {
  const liveChanged = !deepEqual(live, baseline);
  const persistedChanged = !deepEqual(persisted, baseline);

  if (!liveChanged) {
    if (live !== MISSING_CONFIG_VALUE && Array.isArray(live) && Array.isArray(persisted)) {
      live.splice(0, live.length, ...structuredClone(persisted));
      return live;
    }
    if (isPlainConfigRecord(live) && isPlainConfigRecord(persisted)) {
      reconcileConfigRecord(
        live,
        isPlainConfigRecord(baseline) ? baseline : {},
        persisted,
      );
      return live;
    }
    return cloneConfigValue(persisted);
  }

  if (!persistedChanged) return live;

  if (isPlainConfigRecord(live)
    && isPlainConfigRecord(persisted)
    && (baseline === MISSING_CONFIG_VALUE || isPlainConfigRecord(baseline))) {
    reconcileConfigRecord(
      live,
      isPlainConfigRecord(baseline) ? baseline : {},
      persisted,
    );
  }
  // Same-leaf conflicts prefer the pending live management mutation.
  return live;
}

/**
 * Reconcile an async OAuth disk commit into the shared live config without erasing
 * management mutations that have not saved yet. The baseline is a normalized disk
 * snapshot from immediately before login; disjoint object edits merge recursively,
 * while same-leaf conflicts prefer live state.
 */
export function reconcileLiveConfigFromDisk(config: OcxConfig, persistedBaseline: OcxConfig): void {
  const diagnostics = readConfigDiagnostics();
  if (diagnostics.source === "fallback") {
    throw new Error(`OAuth config reconciliation failed: ${diagnostics.error ?? "invalid config file"}`);
  }
  const persisted = diagnostics.config;
  const claudeGuardArmed = claudeCodeBaseline.has(config);
  const pendingLiveClaudeMutation = claudeGuardArmed
    && !deepEqual(config.claudeCode, claudeCodeBaseline.get(config));

  persistedLiveServerBinding.set(config, {
    port: persisted.port,
    ...(persisted.hostname !== undefined ? { hostname: persisted.hostname } : {}),
  });

  reconcileConfigRecord(
    config as unknown as Record<string, unknown>,
    persistedBaseline as unknown as Record<string, unknown>,
    persisted as unknown as Record<string, unknown>,
    new Set(["hostname", "port", ...(claudeGuardArmed ? ["claudeCode"] : [])]),
  );

  if (claudeGuardArmed && !pendingLiveClaudeMutation) {
    if (persisted.claudeCode === undefined) delete config.claudeCode;
    else config.claudeCode = structuredClone(persisted.claudeCode);
    claudeCodeBaseline.set(config, structuredClone(config.claudeCode));
  }
}

/** The literal file, with no schema merge or default injection. */
function readRawConfigJson(): Record<string, unknown> | undefined {
  try {
    const configPath = getConfigPath();
    if (!existsSync(configPath)) return undefined;
    const raw = readFileSync(configPath, "utf-8").replace(/^\uFEFF/, "");
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    return parsed as Record<string, unknown>;
  } catch {
    // Unreadable or corrupt: behave exactly as before. Never fail a save over protection.
    return undefined;
  }
}

/**
 * Read only schema-valid binding fields from the literal file. Missing fields mean
 * their schema defaults; malformed fields keep the last known persisted value.
 */
function readPersistedServerBinding(
  raw: Record<string, unknown>,
  baseline: PersistedServerBinding,
): PersistedServerBinding {
  const port = raw.port === undefined
    ? 10100
    : (typeof raw.port === "number"
        && Number.isInteger(raw.port)
        && raw.port >= 0
        && raw.port <= 65535
      ? raw.port
      : baseline.port);
  const hostname = raw.hostname === undefined
    ? undefined
    : (typeof raw.hostname === "string" ? raw.hostname : baseline.hostname);
  return { port, ...(hostname !== undefined ? { hostname } : {}) };
}

/**
 * The save entry point for every writer holding a LIVE server config.
 *
 * Conflict policy, chosen deliberately:
 * - disk changed, we did not → their hand edit wins;
 * - disk changed AND we changed → our change wins and the baseline rebases, so the
 *   user's next edit starts from the new value (a three-way merge is out of scope);
 * - file missing/unreadable → save what we have, no throw.
 *
 * Scope residual: only `claudeCode` is reconciled. A hand edit to `providers` is still
 * clobbered — recorded and asserted in tests so it cannot drift into an assumed
 * guarantee.
 */
export function saveConfigPreservingClaudeCode(config: OcxConfig): void {
  withConfigMutationLockSync(() => {
    const bindingBaseline = persistedLiveServerBinding.get(config);
    const onDisk = claudeCodeBaseline.has(config) || bindingBaseline
      ? readRawConfigJson()
      : undefined;
    if (claudeCodeBaseline.has(config)) {
      if (onDisk !== undefined) {
        const baseline = claudeCodeBaseline.get(config);
        const persistedClaudeCode = normalizePersistedClaudeCode(onDisk.claudeCode);
        const diskChanged = !deepEqual(persistedClaudeCode, baseline);
        const weChanged = !deepEqual(config.claudeCode, baseline);
        if (diskChanged && !weChanged) {
          config.claudeCode = persistedClaudeCode;
        }
      }
    }
    const persistedBinding = bindingBaseline && onDisk
      ? readPersistedServerBinding(onDisk, bindingBaseline)
      : bindingBaseline;
    if (persistedBinding) {
      const persistedConfig: OcxConfig = { ...config, port: persistedBinding.port };
      if (persistedBinding.hostname === undefined) delete persistedConfig.hostname;
      else persistedConfig.hostname = persistedBinding.hostname;
      persistConfigUnlocked(persistedConfig);
      persistedLiveServerBinding.set(config, persistedBinding);
    } else {
      persistConfigUnlocked(config);
    }
    if (claudeCodeBaseline.has(config)) {
      claudeCodeBaseline.set(config, structuredClone(config.claudeCode));
    }
  });
}

export function codexAutoStartEnabled(config: Pick<OcxConfig, "codexAutoStart">): boolean {
  return config.codexAutoStart !== false;
}

export const CODEX_SHIM_AUTO_RESTORE_ENV = "OPENCODEX_CODEX_SHIM_AUTO_RESTORE";

export function codexShimAutoRestoreEnabled(
  config: Pick<OcxConfig, "codexShimAutoRestore">,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return config.codexShimAutoRestore !== false && env[CODEX_SHIM_AUTO_RESTORE_ENV] !== "0";
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
    managementUsageMaxReadBytes: 64 * 1024 * 1024,
    appOwnedMemoryBudgetMb: DEFAULT_APP_OWNED_MEMORY_BUDGET_BYTES / (1024 * 1024),
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
    codexShimAutoRestore: true,
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
let ocxStartProcessSweepCursor = 0;
let ocxStartProcessProbe: (pid: number) => void = pid => { process.kill(pid, 0); };

export function setOcxStartProcessProbeForTests(probe: ((pid: number) => void) | null): void {
  ocxStartProcessProbe = probe ?? (pid => { process.kill(pid, 0); });
}

export function setOcxStartProcessCacheForTests(entries: Iterable<readonly [number, boolean]>): void {
  ocxStartProcessCache.clear();
  for (const [pid, value] of entries) ocxStartProcessCache.set(pid, value);
  ocxStartProcessSweepCursor = 0;
}

export function sweepDeadOcxStartProcessCache(maxProbes = 64): number {
  const pids: number[] = [];
  let removed = 0;
  for (const pid of ocxStartProcessCache.keys()) {
    if (Number.isSafeInteger(pid) && pid > 0) pids.push(pid);
    else if (ocxStartProcessCache.delete(pid)) removed += 1;
  }
  if (pids.length === 0 || maxProbes <= 0) {
    ocxStartProcessSweepCursor = 0;
    return removed;
  }
  const probeCount = Math.min(Math.floor(maxProbes), pids.length);
  const start = ocxStartProcessSweepCursor % pids.length;
  for (let offset = 0; offset < probeCount; offset += 1) {
    const pid = pids[(start + offset) % pids.length]!;
    try {
      ocxStartProcessProbe(pid);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") continue;
      if (ocxStartProcessCache.delete(pid)) removed += 1;
    }
  }
  ocxStartProcessSweepCursor = (start + probeCount) % pids.length;
  return removed;
}

export function ocxStartProcessCacheSizeForTests(): number {
  return ocxStartProcessCache.size;
}

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
