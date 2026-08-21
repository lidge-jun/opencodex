import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { chmodSync, constants as fsConstants, copyFileSync, existsSync, linkSync, lstatSync, mkdirSync, readFileSync, realpathSync, truncateSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { Database } from "bun:sqlite";
import * as z from "zod/v4";
import { isValidProviderName, hasOwnProvider } from "./config/provider-name";
import {
  bumpConfigGenerationAtPath,
  bumpCurrentConfigGeneration,
  initializeConfigGeneration,
  observeConfigGenerationAtPath,
  readConfigGenerationAtPath,
  readConfigGenerationInTransaction,
  type ConfigGenerationObservation,
} from "./codex/generation";
import type {
  BumpConfigGeneration,
  ConfigGeneration,
  ReadConfigGeneration,
  WithExpectedConfigGenerationSync,
} from "./codex/convergence-types";
import {
  CODEX_ACCOUNT_NAMESPACE_COMBO_ALIAS_COLLISION_ERROR,
  codexAccountNamespaceForModel,
  codexProviderNamespaceKey,
  isValidCodexAccountNamespaceTarget,
  MAIN_CODEX_ACCOUNT_NAMESPACE_TARGET,
} from "./codex/account-namespace-match";
import { isCodexAccountPriorityKey } from "./codex/account-priority";
import { UPSTREAM_HOST_CIRCUIT_MAX_THRESHOLD } from "./codex/upstream-host-health";
import {
  adoptCustomModelCatalogMigration,
  projectCustomModelCatalogMigration,
} from "./codex/custom-model-catalog-migration";
import { parseAccountPriority } from "./codex/pool-rotation";
import { COMBO_NAMESPACE, comboConfigIssues } from "./combos/types";
import { routingProfileIssues } from "./routing/profile";
import { POLICY_NAMESPACE } from "./routing/profile-namespace";
import {
  forgetEphemeralSecretPath,
  hardenSecretDir,
  hardenSecretPath,
  hardenSecretPathAsync,
  windowsSecretAclApplies,
} from "./lib/windows-secret-acl";
import { recordOwnedConfigPath } from "./lib/config-ownership";
import { assertNotRealHomeUnderTest } from "./lib/test-home-guard";
import { isLocalAttestationSecret } from "./lib/local-management-attestation";
import { providerDestinationConfigError } from "./lib/destination-policy";
import { redactSecretString } from "./lib/redact";
import {
  resolveTrustedWindowsPowerShellExe,
  resolveTrustedWindowsSystemDirectory,
} from "./lib/windows-elevation";
import { openRouterRoutingConfigError } from "./providers/openrouter-routing";
import {
  isWirePinnedModel,
  MODEL_ADAPTER_OVERRIDE_ALLOWED,
  OPENAI_PROVIDER_TIER_VERSION,
  pinnedWireAdapter,
  REASONING_SUMMARY_DELIVERY_VALUES,
  UPSTREAM_HTTP_VERSION_VALUES,
  type OcxClaudeCodeConfig,
  type OcxConfig,
  type OcxApiKeyEntry,
  type OcxProviderConfig,
  type FastWire,
  type ProviderCostOverlay,
} from "./types";
import { isCanonicalOpenAiForwardProvider, OPENAI_CODEX_PROVIDER_ID } from "./providers/openai-tiers";
import { fastWireDeclarationError, hasFastWireCapabilityConflict } from "./providers/fastwire";
import {
  getProviderRegistryEntry,
  providerMatchesRegistryTransport,
  providerModelWireDefault,
  registryModelServiceTierCapabilityApplies,
} from "./providers/registry";
import { resolveOpenAiVirtualModel } from "./providers/openai-virtual-models";
import { parseDesktopProfile } from "./claude/desktop-profile";
import { isCodexReasoningEffort, modelRecordValue } from "./reasoning-effort";
import {
  COST4_RATE_KEYS,
  isValidCost4Rate,
  refreshPreservedProviderOwner,
  refreshUserCostOverlays,
  withPreservedDiskOnlyProviders,
} from "./usage/user-cost-overlays";
import { MAX_COST4_RATE } from "./usage/expected-prices";
import {
  DEFAULT_APP_OWNED_MEMORY_BUDGET_BYTES,
  MAX_APP_OWNED_MEMORY_BUDGET_MB,
  MIN_APP_OWNED_MEMORY_BUDGET_MB,
} from "./lib/app-owned-memory";
import { isHostedToolUnsupportedForModel } from "./responses/hosted-tool-policy";

let _atomicSeq = 0;

// The Windows-tolerant replace lives in lib/windows-atomic-replace: config-ownership
// is one of its callers and this module already imports config-ownership, so
// exporting it from here would close an import cycle. Re-exported because these
// names are part of this module's public surface and its callers.
export type { AtomicRenameIO } from "./lib/windows-atomic-replace";
export { renameAtomicFile } from "./lib/windows-atomic-replace";
import { renameAtomicFile, renameAtomicFileAsync } from "./lib/windows-atomic-replace";

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

/**
 * Resolve a write target through any symlink before the temp+rename dance.
 *
 * rename(2) replaces a directory ENTRY. When the entry is itself a symlink
 * (a dotfiles-managed `~/.codex/config.toml` -> `~/dotfiles/.codex/config.toml`,
 * say), renaming a sibling temp file over it destroys the link and leaves a plain
 * file behind — the repo silently stops receiving writes. Resolving first puts both
 * the temp file and the rename target inside the link's real directory, so the entry
 * being replaced is the real file and the symlink survives.
 *
 * Same-filesystem atomicity is preserved because the temp file stays beside its
 * resolved target. A genuinely absent destination (not yet created) falls back to
 * the literal path, which is the correct target for a first write.
 *
 * An EXISTING symlink that cannot be resolved — dangling because its target volume
 * is unmounted, an ELOOP chain, an EACCES parent — is refused instead. Falling back
 * to the literal path there would let the rename replace the link, recreating the
 * exact dotfiles-divergence failure this helper exists to prevent (audit: wt4 wp2).
 */
export function resolveWriteTarget(path: string): string {
  try {
    return realpathSync(path);
  } catch (cause) {
    let entry;
    try {
      entry = lstatSync(path);
    } catch (error) {
      if (isMissingPathError(error)) return path; // no entry at all — first write
      throw error;
    }
    if (entry.isSymbolicLink()) {
      throw new Error(`refusing to replace unresolvable symlinked write target: ${path}`, { cause });
    }
    return path;
  }
}

/**
 * Re-apply the real-home guard to a RESOLVED write target.
 *
 * Callers such as saveConfig check only their logical config dir, which passes when
 * OPENCODEX_HOME points at a temp fixture. Following a symlink out of that fixture
 * would land on the protected home the caller's own check just cleared, so the guard
 * has to run again on wherever the write actually terminates. Inert in production,
 * where the guard is disarmed.
 */
function assertResolvedTargetAllowed(path: string, target: string): void {
  // The file itself may resolve literally while its PARENT is a symlink out
  // of the fixture (a first write beneath a symlinked config dir). Guard the
  // directory the write actually lands in either way.
  if (target === path) {
    let realParent: string;
    try {
      realParent = realpathSync(dirname(target));
    } catch {
      return; // unresolvable parent: resolveWriteTarget already owns that refusal
    }
    if (realParent !== dirname(target)) assertNotRealHomeUnderTest(realParent);
    return;
  }
  assertNotRealHomeUnderTest(dirname(target));
}

export function atomicWriteFile(path: string, content: string, io: AtomicWriteIO = {
  write: (target, value) => writeFileSync(target, value, { encoding: "utf-8", mode: 0o600 }),
  harden: target => {
    try { chmodSync(target, 0o600); } catch { /* platform may ignore chmod */ }
    // Timeout memo keyed by the stable destination (matches the async writer):
    // a failed temp harden must not mint a new unique-temp key on every write.
    if (process.platform === "win32") hardenSecretPath(target, { required: true, timeoutMemoKey: path });
  },
  rename: renameAtomicFile,
  truncate: target => truncateSync(target, 0),
  unlink: unlinkSync,
}): void {
  recordOwnedConfigPath(resolveConfigDir(), path);
  const target = resolveWriteTarget(path);
  assertResolvedTargetAllowed(path, target);
  const tmp = `${target}.ocx.${process.pid}.${++_atomicSeq}.tmp`;
  let hardened = false;
  try {
    io.write(tmp, content);
    io.harden(tmp);
    hardened = true;
    io.rename(tmp, target);
    forgetEphemeralSecretPath(tmp);
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
    if (removed) forgetEphemeralSecretPath(tmp);
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

/** Test-only crash seam. Production callers leave this undefined. */
export interface AtomicWriteAsyncTestSeam {
  afterTempWrite?: (tempPath: string) => void | Promise<void>;
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
  testSeam?: AtomicWriteAsyncTestSeam,
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
  const target = resolveWriteTarget(path);
  assertResolvedTargetAllowed(path, target);
  const tmp = `${target}.ocx.${process.pid}.${++_atomicSeq}.tmp`;
  let hardened = false;
  try {
    await effective.write(tmp, content);
    await testSeam?.afterTempWrite?.(tmp);
    await effective.harden(tmp);
    hardened = true;
    await effective.rename(tmp, target);
    forgetEphemeralSecretPath(tmp);
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
    if (removed) forgetEphemeralSecretPath(tmp);
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
  readonly configPath?: string;
  constructor(configPath?: string) {
    super("Existing OpenAI tier backup differs from the current config");
    this.name = "OpenAiTierBackupCollisionError";
    this.configPath = configPath;
  }
}

export class OpenAiTierRollbackPreserveError extends Error {
  readonly code?: "missing" | "not-rollback" | "mismatch" | "exhausted";
  constructor(message: string, options?: ErrorOptions & { code?: OpenAiTierRollbackPreserveError["code"] }) {
    super(message, options);
    this.name = "OpenAiTierRollbackPreserveError";
    this.code = options?.code;
  }
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
        throw new OpenAiTierBackupCollisionError(source);
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
    if (removed) forgetEphemeralSecretPath(temp);
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
      if (!sameBytes(original, winner)) throw new OpenAiTierBackupCollisionError(source);
      scrubUnpublishedTemp();
      return "reused";
    }
    published = true;
    try {
      io.unlink(temp);
      forgetEphemeralSecretPath(temp);
    } catch (firstError) {
      if (isMissingPathError(firstError)) {
        forgetEphemeralSecretPath(temp);
      } else try {
        io.unlink(temp);
        forgetEphemeralSecretPath(temp);
      } catch (secondError) {
        if (isMissingPathError(secondError)) {
          forgetEphemeralSecretPath(temp);
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

export interface OpenAiTierRollbackPreserveIO {
  exists(path: string): boolean;
  read(path: string): Uint8Array;
  copyExclusive(source: string, destination: string): void;
  unlink(path: string): void;
}

const DEFAULT_ROLLBACK_PRESERVE_IO: OpenAiTierRollbackPreserveIO = {
  exists: existsSync,
  read: target => readFileSync(target),
  copyExclusive: (source, destination) => {
    copyFileSync(source, destination, fsConstants.COPYFILE_EXCL);
  },
  unlink: unlinkSync,
};

const OPENAI_TIER_ROLLBACK_PRESERVE_ATTEMPTS = 16;

/**
 * Copy a rollback-classified `.pre-openai-tiers-v2.bak` to a unique
 * `.pre-openai-tiers-v1-rollback.<timestamp>[suffix].bak` path, then unlink the
 * blocking v2 name. The original bytes are copied with no-replace publication;
 * the v2 path is removed only after the copy is verified. Shared by startup
 * migration recovery and `ocx init` cleanup so the two paths cannot drift.
 */
export function preserveOpenAiTierRollbackSnapshot(
  configPath = getConfigPath(),
  io: OpenAiTierRollbackPreserveIO = DEFAULT_ROLLBACK_PRESERVE_IO,
): string {
  const backup = `${configPath}.pre-openai-tiers-v2.bak`;
  if (!io.exists(backup)) {
    throw new OpenAiTierRollbackPreserveError("OpenAI tier rollback backup is missing", { code: "missing" });
  }
  const original = io.read(backup);
  if (classifyOpenAiTierBackup(original) !== "rollback") {
    throw new OpenAiTierRollbackPreserveError("OpenAI tier backup is not a rollback snapshot", { code: "not-rollback" });
  }
  for (let attempt = 0; attempt < OPENAI_TIER_ROLLBACK_PRESERVE_ATTEMPTS; attempt++) {
    const preserved = `${configPath}.pre-openai-tiers-v1-rollback.${Date.now()}${attempt ? `-${attempt}` : ""}.bak`;
    try {
      io.copyExclusive(backup, preserved);
    } catch (error) {
      if (isAlreadyExistsError(error)) continue;
      throw error;
    }
    let copied: Uint8Array;
    try {
      copied = io.read(preserved);
    } catch (error) {
      throw new OpenAiTierRollbackPreserveError("Failed to read preserved rollback snapshot", { cause: error, code: "mismatch" });
    }
    if (!sameBytes(original, copied)) {
      try { io.unlink(preserved); } catch { /* keep the original backup; incomplete copy is best-effort */ }
      throw new OpenAiTierRollbackPreserveError("Preserved rollback snapshot does not match source bytes", { code: "mismatch" });
    }
    io.unlink(backup);
    return preserved;
  }
  throw new OpenAiTierRollbackPreserveError("Unable to find a unique rollback snapshot path", { code: "exhausted" });
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
const warnedInheritedFastWireConflicts = new Set<string>();
let lastWarningReconciledGeneration = 0;

export function reconcileConfigWarningMemos(generation: number): number {
  if (generation <= lastWarningReconciledGeneration) return 0;
  const removed = warnedConfigFallbacks.size + warnedInheritedFastWireConflicts.size;
  warnedConfigFallbacks.clear();
  warnedInheritedFastWireConflicts.clear();
  lastWarningReconciledGeneration = generation;
  return removed;
}

/**
 * Bounds for the opt-in same-target 429 wait-and-retry policy. Single source of truth
 * shared by the config schema, the load-time sanitizer, and the management write
 * boundary. Strict, so an unknown key is rejected at every validation boundary instead
 * of being silently ignored (the load-time sanitizer still degrades unknown keys with a
 * warning before schema validation, so hand-edited configs keep loading).
 */
const retryOn429PolicySchema = z.object({
  enabled: z.boolean().optional(),
  attempts: z.number().int().min(1).max(20).optional(),
  intervalMs: z.number().int().min(100).max(600_000).optional(),
  // The effective cap for a single wait is MAX_COOLDOWN_MS (10 min) in key-failover.ts;
  // larger configured values would be dead config.
  maxIntervalMs: z.number().int().min(100).max(600_000).optional(),
  respectRetryAfter: z.boolean().optional(),
}).strict();

const requestPacingRuleSchema = z.object({
  // Keep the RPM-derived timer within the same one-hour bound as minIntervalMs.
  requestsPerMinute: z.number().min(1 / 60).max(60_000).optional(),
  minIntervalMs: z.number().int().min(1).max(3_600_000).optional(),
}).strict().refine(value => value.requestsPerMinute !== undefined || value.minIntervalMs !== undefined, {
  message: "request pacing rules need requestsPerMinute or minIntervalMs",
});

const requestPacingSchema = z.object({
  enabled: z.boolean(),
  requestsPerMinute: z.number().min(1 / 60).max(60_000).optional(),
  minIntervalMs: z.number().int().min(1).max(3_600_000).optional(),
  models: z.record(z.string().trim().min(1), requestPacingRuleSchema).optional(),
}).strict().refine(value => value.enabled === false
  || value.requestsPerMinute !== undefined
  || value.minIntervalMs !== undefined
  || (value.models !== undefined && Object.keys(value.models).length > 0), {
  message: "enabled request pacing needs a provider rule or model override",
});

export function requestPacingConfigError(value: unknown): string | null {
  if (value === undefined) return null;
  const parsed = requestPacingSchema.safeParse(value);
  if (parsed.success) return null;
  return "requestPacing must contain enabled and a valid requestsPerMinute/minIntervalMs provider rule or model overrides";
}

const fastWireSchema = z.object({
  kind: z.string(),
  canonicalToWire: z.record(z.string().trim(), z.string().trim()),
  foreignCallerTiers: z.string(),
  betas: z.array(z.string().trim()).optional(),
}).strict().superRefine((fastWire, ctx) => {
  const error = fastWireDeclarationError({ fastWire });
  if (error) ctx.addIssue({ code: "custom", message: error });
}).transform(fastWire => fastWire as FastWire);

/**
 * Zod schema for one provider entry: known fields are validated strictly while unknown
 * fields pass through (preserved for runtime extensions).
 */
const providerConfigSchema = z.object({
  adapter: z.string().min(1),
  baseUrl: z.string().min(1),
  requestPacing: requestPacingSchema.optional().catch(undefined),
  mcpMaxTools: z.number().int().positive().optional(),
  mcpMaxSchemaBytes: z.number().int().positive().optional(),
  mcpMaxResultBytes: z.number().int().positive().optional(),
  apiKeyTransport: z.enum(["x-api-key", "bearer"]).optional(),
  responsesPath: z.string().min(1).optional(),
  statelessResponses: z.boolean().optional(),
  requiresAdjacentResponsesToolResults: z.boolean().optional(),
  fastWire: fastWireSchema.nullable().optional(),
  supportsServiceTier: z.boolean().optional(),
  modelSupportsServiceTier: z.record(z.string().min(1), z.boolean()).optional(),
  preserveResponsesReasoningContent: z.boolean().optional(),
  decodesNativeCompactionBlobs: z.boolean().optional(),
  allowPrivateNetwork: z.boolean().optional(),
  // The management API accepts `null` as "clear this", so a config written before the POST
  // canonicalization below can hold one on disk. Rejecting it here would send the operator
  // through invalid-config recovery for a value the API told them was fine.
  upstreamHttpVersion: z.enum(UPSTREAM_HTTP_VERSION_VALUES)
    .nullish()
    .transform(value => value ?? undefined),
  directGeminiWireRenames: z.boolean().optional(),
  noStructuredOutputModels: z.array(z.string().min(1))
    .transform(normalizeNonBlankStringArray)
    .optional(),
  retryOn429: retryOn429PolicySchema.optional(),
  codexAccountMode: z.enum(["pool", "direct"]).optional(),
  // Validated rather than passed through: this schema ends in `.passthrough()`, so an
  // undeclared key survives verbatim. A misspelled `codexToolMode` therefore used to be
  // accepted, persisted, and then silently resolved to the `code_mode_only` default — the
  // operator asked for shell mode, got code mode, and was told nothing (#2106).
  codexToolMode: z.enum(["code_mode_only", "shell"]).optional(),
  responsesItemIdRepair: z.object({
    message: z.array(z.string().min(1)).optional(),
    reasoning: z.array(z.string().min(1)).optional(),
    repairMissingTerminalIds: z.boolean().optional(),
    repairInvalidIds: z.boolean().optional(),
  }).strict().optional(),
  responsesSnapshotRepair: z.boolean().optional(),
}).passthrough();

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

export { isValidProviderName, hasOwnProvider } from "./config/provider-name";

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

/**
 * Validate `providers.<name>.modelCosts`: a plain object keyed by exact model
 * id, each value a 4-tuple of non-negative finite USD-per-1M-token rates.
 * Returns null when valid/absent, else a human-readable error.
 */
export function providerModelCostsConfigError(value: unknown, field = "modelCosts"): string | null {
  if (value === undefined) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return `${field} must be a plain object keyed by model id`;
  }
  for (const [modelId, entry] of Object.entries(value)) {
    if (!modelId.trim()) return `${field} keys must be nonblank model ids`;
    // Redact secret-shaped model ids and JSON-escape control characters so a
    // malformed write cannot echo a pasted key/secret back through the
    // management API response.
    const safeModelId = JSON.stringify(redactSecretString(modelId));
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      return `${field}.${safeModelId} must be an object with input, output, cacheRead, and cacheWrite (USD per 1M tokens)`;
    }
    const rates = entry as Record<string, unknown>;
    for (const key of COST4_RATE_KEYS) {
      const rate = rates[key];
      if (!isValidCost4Rate(rate)) {
        return `${field}.${safeModelId}.${key} must be a non-negative finite number at most ${MAX_COST4_RATE} (USD per 1M tokens)`;
      }
    }
    // Reject unknown fields: a misplaced apiKey/apiKeyPool under a cost row
    // would otherwise be persisted and echoed verbatim by display paths that
    // mask only top-level provider secrets.
    const extraKeys = Object.keys(rates)
      .filter((key) => !(COST4_RATE_KEYS as readonly string[]).includes(key));
    if (extraKeys.length > 0) {
      return `${field}.${safeModelId} has unexpected fields ${JSON.stringify(extraKeys.map(redactSecretString).join(", "))} — only input, output, cacheRead, and cacheWrite are allowed (USD per 1M tokens)`;
    }
  }
  return null;
}

/**
 * Serialize `providers.<name>.modelCosts` for display: copy ONLY the four
 * numeric rate fields per model and DROP secret-shaped model ids, so a pasted
 * API key in a key position cannot be echoed back by CLI/DTO display paths.
 * The result uses a null prototype so "__proto__" remains an own row.
 */
export function sanitizeModelCostsForDisplay(costs: unknown): Record<string, ProviderCostOverlay> | undefined {
  if (!costs || typeof costs !== "object" || Array.isArray(costs)) return undefined;
  const out = Object.create(null) as Record<string, ProviderCostOverlay>;
  for (const [modelId, entry] of Object.entries(costs)) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const rates = entry as Record<string, unknown>;
    const input = rates.input;
    const output = rates.output;
    const cacheRead = rates.cacheRead;
    const cacheWrite = rates.cacheWrite;
    if (
      isValidCost4Rate(input)
      && isValidCost4Rate(output)
      && isValidCost4Rate(cacheRead)
      && isValidCost4Rate(cacheWrite)
    ) {
      // Secret-shaped ids are DROPPED rather than mapped to "[REDACTED]" so
      // distinct rows cannot collapse into one placeholder key.
      if (redactSecretString(modelId) !== modelId) continue;
      out[modelId] = { input, output, cacheRead, cacheWrite };
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
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

/**
 * Shared runtime boundary for the per-provider upstream HTTP-version pin (#1668). Used by
 * the management write path (providerManagementConfigError / PATCH) so it can never disagree
 * with the strict zod load schema: a value that survives POST/PATCH is always loadable, and
 * a value the loader rejects is rejected at write time too.
 */
export function upstreamHttpVersionConfigError(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || !(UPSTREAM_HTTP_VERSION_VALUES as readonly string[]).includes(value)) {
    return 'upstreamHttpVersion must be one of "auto", "http1.1", "h1", "http2", "h2", or null to clear';
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

export function nonBlankStringArrayConfigError(value: unknown, field: string): string | null {
  if (value === undefined) return null;
  if (!Array.isArray(value)) return `${field} must be an array`;
  for (const [index, entry] of value.entries()) {
    if (typeof entry !== "string" || !entry.trim()) {
      return `${field}.${index} must be a nonblank model id`;
    }
  }
  return null;
}

/**
 * Keep hand-edited config and management writes on one canonical model-id list.
 * Validation happens separately so an all-whitespace value is rejected rather than
 * normalized into a model id that can never match at runtime.
 */
export function normalizeNonBlankStringArray(value: readonly string[]): string[] {
  return [...new Set(value.map(entry => entry.trim()))];
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

const SUPPORTED_PREFERRED_HOSTED_TOOLS = new Set(["image_generation"]);

export function modelPreferHostedToolsConfigError(
  value: unknown,
  field: string,
  providerName: string,
  provider: { adapter?: unknown; authMode?: unknown; modelAdapters?: unknown; baseUrl?: unknown },
): string | null {
  if (value === undefined) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) return `${field} must be a plain object`;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return `${field} must be a plain object with own properties`;
  const entries = Object.entries(value);
  const registry = getProviderRegistryEntry(providerName);
  // Effective transport: a `preserveCustomDestination` registry row reused under a
  // different endpoint keeps its own adapter AND its own auth at runtime, because
  // `routedProviderConfig()` honors `providerMatchesRegistryTransport()`. Both the
  // wire check below and the forward-auth check here have to start from the same
  // decision, or validation accepts a preference the adapter never applies —
  // `preferConfiguredHostedTools()` runs only on the non-forward branch.
  const registryTransportMatches = typeof provider.baseUrl === "string"
    && providerMatchesRegistryTransport(providerName, {
      baseUrl: provider.baseUrl,
      adapter: provider.adapter as OcxProviderConfig["adapter"],
      ...(typeof provider.authMode === "string" ? { authMode: provider.authMode as OcxProviderConfig["authMode"] } : {}),
    });
  const effectiveForwardAuth = registryTransportMatches
    ? registry?.authKind === "forward"
    : provider.authMode === "forward";
  if (entries.length > 0 && effectiveForwardAuth) {
    return `${field} is not supported on forward-auth Responses providers`;
  }
  const requestedWireFor = (modelId: string): unknown => provider.modelAdapters
    && typeof provider.modelAdapters === "object"
    && !Array.isArray(provider.modelAdapters)
    ? (provider.modelAdapters as Record<string, unknown>)[modelId]
    : undefined;
  const resolveEffectiveWire = (modelId: string, currentWire: unknown): unknown => {
    const pinned = pinnedWireAdapter(providerName, modelId);
    if (pinned) return pinned;
    const requestedWire = requestedWireFor(modelId);
    if (typeof requestedWire === "string" && MODEL_ADAPTER_OVERRIDE_ALLOWED.has(requestedWire)) {
      return requestedWire;
    }
    // No explicit override: fall back to the registry's per-model wire default before
    // the provider-wide adapter, because that is the order `resolveModelAdapter()`
    // uses at request time (src/server/adapter-resolve.ts:38-48). Skipping it rejected
    // preferences the runtime would have honored — DeepSeek routes `deepseek-v4-flash`
    // over native Responses for a Responses inbound while the provider-wide wire stays
    // openai-chat. Hosted-tool preferences only apply to Responses traffic, so the
    // inbound to ask about is "responses".
    const registryDefault = typeof currentWire === "string" && typeof provider.baseUrl === "string"
      ? providerModelWireDefault(
        providerName,
        {
          baseUrl: provider.baseUrl,
          adapter: currentWire,
          ...(typeof provider.authMode === "string" ? { authMode: provider.authMode as OcxProviderConfig["authMode"] } : {}),
        },
        modelId,
        MODEL_ADAPTER_OVERRIDE_ALLOWED,
        "responses",
      )
      : undefined;
    return registryDefault ?? currentWire;
  };
  for (const [key, entry] of entries) {
    if (!key.trim()) return `${field} keys must be nonblank model ids`;
    if (!Array.isArray(entry)) return `${field}.${key} must be an array`;
    if (entry.length === 0) return `${field}.${key} must include image_generation`;
    for (const tool of entry) {
      if (typeof tool !== "string" || !SUPPORTED_PREFERRED_HOSTED_TOOLS.has(tool)) {
        return `${field}.${key} supports only image_generation`;
      }
      if (isHostedToolUnsupportedForModel(key, tool)) {
        return `${field}.${key} cannot prefer ${tool}: the model does not support it`;
      }
    }
    // Same `registryTransportMatches` decision the forward-auth check above uses:
    // start from the registry adapter only when this config still points at the
    // registry's documented transport.
    const baseWire = registryTransportMatches ? registry?.adapter ?? provider.adapter : provider.adapter;
    let effectiveWire = resolveEffectiveWire(key, baseWire);
    const virtualWireModel = resolveOpenAiVirtualModel(providerName, key)?.wireModelId;
    if (virtualWireModel && virtualWireModel !== key) {
      effectiveWire = resolveEffectiveWire(virtualWireModel, effectiveWire);
    }
    if (effectiveWire !== "openai-responses") {
      return `${field}.${key} requires the openai-responses wire`;
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

const CODEX_ACCOUNT_PRIORITIES_RECORD_ERROR =
  "codexAccountPriorities must be a plain object mapping Codex account ids to selection-order integers";
const CODEX_ACCOUNT_PRIORITY_KEY_ERROR =
  "selection-order keys must be a Codex pool-account id or the main Codex account and cannot be reserved JavaScript object keys";
const CODEX_ACCOUNT_PRIORITY_VALUE_ERROR =
  "selection order must be an integer between -100 and 100";

const CODEX_ACCOUNT_PIN_PATTERN = /^[a-zA-Z0-9._-]{1,64}$/;

const codexAccountPrioritiesSchema = z.custom<Record<string, unknown>>(
  (value): value is Record<string, unknown> => !!value
    && typeof value === "object"
    && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null),
  { error: CODEX_ACCOUNT_PRIORITIES_RECORD_ERROR },
).superRefine((priorities, ctx) => {
  // Inspect raw own entries before z.record parses them; Zod omits __proto__ record keys.
  for (const [accountId, priority] of Object.entries(priorities)) {
    if (!isCodexAccountPriorityKey(accountId)) {
      ctx.addIssue({ code: "custom", path: [accountId], message: CODEX_ACCOUNT_PRIORITY_KEY_ERROR });
    }
    if (parseAccountPriority(priority) === null) {
      ctx.addIssue({ code: "custom", path: [accountId], message: CODEX_ACCOUNT_PRIORITY_VALUE_ERROR });
    }
  }
}).pipe(z.record(z.string(), z.number().int()));

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

/**
 * Durable per-client intent.
 *
 * `.passthrough()` is load-bearing: a binary that only knows `codex` must not
 * erase a key a later version wrote during a field-scoped mutation. And each key
 * degrades on its own — a hand edit of `{"codex": "false", "future": false}`
 * drops `codex` to absent (which reads as ON) and keeps `future`, rather than
 * invalidating the object or, worse, the whole config.
 */
const clientIntegrationsSchema = z.object({
  codex: z.boolean().optional().catch(undefined),
  grok: z.boolean().optional().catch(undefined),
  "claude-desktop": z.boolean().optional().catch(undefined),
}).passthrough();

const agentTaskRecoverySchema = z.object({
  enabled: z.boolean().optional(),
  model: z.string().trim().min(1).optional(),
  timeoutMs: z.number().int().min(1_000).max(120_000).optional(),
  cacheEntries: z.number().int().min(1).max(512).optional(),
}).strict();

const configSchema = z.object({
  port: z.number().int().min(0).max(65535).default(10100),
  managementUsageMaxReadBytes: z.number().int().positive().default(64 * 1024 * 1024),
  // Invalid hand edits disable only this opt-in circuit. Live writes remain strict.
  upstreamHostCircuitThreshold: z.number().int()
    .min(0)
    .max(UPSTREAM_HOST_CIRCUIT_MAX_THRESHOLD)
    .optional()
    .catch(undefined),
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
  // Discriminated on `enabled` so a disabled entry cannot be forced to carry a port, and an
  // enabled one cannot omit it (#1102). A malformed value degrades to undefined rather than
  // failing the whole parse: this is an opt-in convenience surface, and a hand-edit typo here
  // must never reset providers/apiKeys through the backup-and-defaults repair path.
  unauthenticatedLoopbackListener: z.union([
    z.object({ enabled: z.literal(false) }),
    z.object({ enabled: z.literal(true), port: z.number().int().min(1).max(65535) }),
  ]).optional().catch(undefined),
  providers: z.record(z.string(), providerConfigSchema),
  defaultProvider: z.string().min(1).default("openai"),
  // A retry can be billable, so absence and malformed hand edits both stay off.
  emptyCompletionRetry: z.boolean().optional().catch(false),
  openaiProviderTierVersion: z.union([z.literal(1), z.literal(2)]).optional(),
  // Invalid hand edits must not discard an otherwise usable config.
  googleAntigravityStaticCatalogVersion: z.union([z.literal(1), z.literal(2)]).optional().catch(undefined),
  clientIntegrations: clientIntegrationsSchema.optional().catch(undefined),
  providerContextCaps: z.record(z.string(), z.number().int().positive()).optional(),
  contextCapValue: z.number().int().positive().optional(),
  multiAgentGuidanceEnabled: z.boolean().optional(),
  // Invalid optional recovery config must not discard unrelated provider/account state.
  agentTaskRecovery: agentTaskRecoverySchema.optional().catch(undefined),
  // These selections pre-date schema validation and used to pass through as
  // unknown fields. Invalid hand edits must disable only the optional
  // delegation/native-default feature, not reject the whole config and hide
  // otherwise valid providers, accounts, or the configured listen port.
  injectionModel: z.string().optional().catch(undefined),
  injectionEffort: z.string().optional().catch(undefined),
  syncCodexSubagentDefaults: z.boolean().optional().catch(undefined),
  // Per-primary-model fallback chains. Values must be non-empty string arrays;
  // malformed entries degrade to undefined rather than rejecting the whole config.
  subagentModelFallbackByModel: z.record(
    z.string(),
    z.array(z.string().trim().min(1)).min(1),
  ).optional().catch(undefined),
  codexShimAutoRestore: z.boolean().optional(),
  pausedCodexAccountIds: z.array(z.string().regex(/^[a-zA-Z0-9._-]{1,64}$/)).optional(),
  codexAccountNamespaces: codexAccountNamespacesSchema.optional(),
  // Selection order is a preference, not a safety control like pause: a malformed
  // map degrades to "no ordering" rather than failing the parse, so a hand-edited
  // typo cannot trip the backup-and-defaults repair path and wipe providers or
  // pool accounts. Warning emitted in loadConfig.
  codexAccountPriorities: codexAccountPrioritiesSchema.optional().catch(undefined),
  activeCodexAccountPinned: z.string().regex(CODEX_ACCOUNT_PIN_PATTERN).optional().catch(undefined),
  // A malformed hand edit must degrade to false without discarding providers, accounts,
  // or the exact selector map. Live writes remain strict.
  codexAccountPickerEnabled: z.boolean().optional().catch(false),
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
      POLICY_NAMESPACE,
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
          message: "account selectors must not collide with configured provider, combo, or routing policy namespaces",
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
        path: ["providers", redactSecretString(name)],
        message: "provider names must use letters, numbers, dot, underscore, or hyphen and cannot be reserved JavaScript object keys or routing namespaces (policy)",
      });
    }
    const provider = config.providers[name];
    if (hasFastWireCapabilityConflict(provider)) {
      ctx.addIssue({
        code: "custom",
        path: ["providers", redactSecretString(name), "fastWire"],
        message: "fastWire=null conflicts with supportsServiceTier=true",
      });
    }
    const openRouterRoutingError = openRouterRoutingConfigError(provider);
    if (openRouterRoutingError) {
      ctx.addIssue({
        code: "custom",
        path: [
          "providers",
          redactSecretString(name),
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
        path: ["providers", redactSecretString(name), "virtualModels"],
        message: "virtualModels is registry-only and must not be persisted",
      });
    }
    const baseUrlError = providerBaseUrlConfigError(provider.baseUrl);
    if (baseUrlError) {
      ctx.addIssue({
        code: "custom",
        path: ["providers", redactSecretString(name), "baseUrl"],
        message: baseUrlError,
      });
    } else {
      const destinationError = providerDestinationConfigError(name, provider);
      if (destinationError) {
        ctx.addIssue({
          code: "custom",
          path: ["providers", redactSecretString(name), "baseUrl"],
          message: destinationError,
        });
      }
    }
    const responsesPathError = providerResponsesPathConfigError(provider.responsesPath);
    if (responsesPathError) {
      ctx.addIssue({
        code: "custom",
        path: ["providers", redactSecretString(name), "responsesPath"],
        message: responsesPathError,
      });
    }
    const headersError = providerHeadersConfigError((provider as { headers?: unknown }).headers);
    if (headersError) {
      ctx.addIssue({
        code: "custom",
        path: ["providers", redactSecretString(name), "headers"],
        message: headersError,
      });
    }
    const modelCostsError = providerModelCostsConfigError((provider as { modelCosts?: unknown }).modelCosts);
    if (modelCostsError) {
      ctx.addIssue({
        code: "custom",
        // The provider key is caller-controlled and can be token-shaped; redact it
        // before schemaDiagnosticsError serializes the path (ocx config validate/import).
        path: ["providers", redactSecretString(name), "modelCosts"],
        message: modelCostsError,
      });
    }
    const apiKeyTransportError = apiKeyTransportConfigError(provider as OcxProviderConfig);
    if (apiKeyTransportError) {
      ctx.addIssue({
        code: "custom",
        path: ["providers", redactSecretString(name), "apiKeyTransport"],
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
        path: ["providers", redactSecretString(name), "modelAdapters"],
        message: modelAdaptersError,
      });
    }
    const preferHostedToolsError = modelPreferHostedToolsConfigError(
      (provider as { modelPreferHostedTools?: unknown }).modelPreferHostedTools,
      "modelPreferHostedTools",
      name,
      provider,
    );
    if (preferHostedToolsError) {
      ctx.addIssue({
        code: "custom",
        path: ["providers", redactSecretString(name), "modelPreferHostedTools"],
        message: preferHostedToolsError,
      });
    }
    const maxInputError = positiveIntegerRecordConfigError(
      (provider as { modelMaxInputTokens?: unknown }).modelMaxInputTokens,
      "modelMaxInputTokens",
    );
    if (maxInputError) {
      ctx.addIssue({
        code: "custom",
        path: ["providers", redactSecretString(name), "modelMaxInputTokens"],
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
        path: ["providers", redactSecretString(name), "modelSupportsReasoningSummaries"],
        message: reasoningSummariesError,
      });
    }
    const serviceTierModelsError = booleanRecordConfigError(
      (provider as { modelSupportsServiceTier?: unknown }).modelSupportsServiceTier,
      "modelSupportsServiceTier",
    );
    if (serviceTierModelsError) {
      ctx.addIssue({
        code: "custom",
        path: ["providers", redactSecretString(name), "modelSupportsServiceTier"],
        message: serviceTierModelsError,
      });
    }
    const reasoningSummaryDeliveryError = reasoningSummaryDeliveryRecordConfigError(
      (provider as { modelReasoningSummaryDelivery?: unknown }).modelReasoningSummaryDelivery,
      (provider as { modelSupportsReasoningSummaries?: unknown }).modelSupportsReasoningSummaries,
    );
    if (reasoningSummaryDeliveryError) {
      ctx.addIssue({
        code: "custom",
        path: ["providers", redactSecretString(name), "modelReasoningSummaryDelivery"],
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
        path: ["providers", redactSecretString(name), "defaultMaxOutputTokens"],
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
        path: ["providers", redactSecretString(name), "modelMaxOutputTokens"],
        message: maxOutputError,
      });
    }
    const structuredOutputOptOutError = nonBlankStringArrayConfigError(
      (provider as { noStructuredOutputModels?: unknown }).noStructuredOutputModels,
      "noStructuredOutputModels",
    );
    if (structuredOutputOptOutError) {
      ctx.addIssue({
        code: "custom",
        path: ["providers", redactSecretString(name), "noStructuredOutputModels"],
        message: structuredOutputOptOutError,
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
          path: ["providers", redactSecretString(name), "codexAccountMode"],
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
  const routingProfiles = (config as { routingProfiles?: unknown }).routingProfiles;
  if (routingProfiles !== undefined) {
    if (!routingProfiles || typeof routingProfiles !== "object" || Array.isArray(routingProfiles)) {
      ctx.addIssue({ code: "custom", path: ["routingProfiles"], message: "routingProfiles must be an object" });
    } else {
      for (const [id, raw] of Object.entries(routingProfiles as Record<string, unknown>)) {
        for (const issue of routingProfileIssues(id, raw, {
          providers: config.providers,
          combos: combos as Record<string, import("./types").OcxComboConfig> | undefined,
          routingProfiles: routingProfiles as Record<string, import("./types").OcxRoutingProfileConfig>,
          codexAccountNamespaces: accountNamespaces,
        }, { excludeProfileId: id })) {
          ctx.addIssue({
            code: "custom",
            path: ["routingProfiles", id, ...issue.path],
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
  // The guard runs BEFORE any mutation: refusing the write after chmod/ACL
  // would already have changed the protected directory (review round 2).
  assertNotRealHomeUnderTest(dir);
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
 * Load-time degradation for `retryOn429` (loadConfig only): one hand-edited invalid optional
 * field (e.g. `attempts: 0` or a string) must not trip the whole provider schema and hide every
 * provider/key behind a default config. Invalid fields are dropped with a warning; the management
 * write boundary still rejects invalid policies explicitly.
 */
function sanitizeRetryOn429ForLoad(parsed: unknown): void {
  if (!parsed || typeof parsed !== "object") return;
  const root = parsed as Record<string, unknown>;
  const providers = root.providers;
  if (!providers || typeof providers !== "object" || Array.isArray(providers)) return;
  for (const [name, provider] of Object.entries(providers as Record<string, unknown>)) {
    // This sanitizer runs BEFORE schema validation, so the provider name is untrusted: redact
    // secret-shaped names and JSON-escape control characters before it reaches any warning.
    const safeProviderName = JSON.stringify(redactSecretString(name));
    if (!provider || typeof provider !== "object" || Array.isArray(provider)) continue;
    const p = provider as Record<string, unknown>;
    const policy = p.retryOn429;
    if (policy === undefined) continue;
    if (!policy || typeof policy !== "object" || Array.isArray(policy)) {
      delete p.retryOn429;
      // Never serialize the value: an accidental `retryOn429: "sk-..."` would leak the secret.
      console.warn(`⚠️  config.json providers.${safeProviderName}.retryOn429 (${typeof policy}) is invalid — ignoring the policy`);
      continue;
    }
    const policyRecord = policy as Record<string, unknown>;
    // An explicitly present but invalid master switch must not silently default to ENABLED:
    // drop the whole policy so a hand-edit that tried to disable retries stays disabled.
    if ("enabled" in policyRecord && typeof policyRecord.enabled !== "boolean") {
      delete p.retryOn429;
      console.warn(`⚠️  config.json providers.${safeProviderName}.retryOn429.enabled (${typeof policyRecord.enabled}) is invalid — ignoring the whole policy`);
      continue;
    }
    // Field checks derive from the shared policy schema so the bounds cannot drift
    // between the load-time sanitizer, the config schema, and the write boundary.
    const policyShape = retryOn429PolicySchema.shape;
    const hadPolicyEntries = Object.keys(policyRecord).length > 0;
    const cleaned: Record<string, unknown> = {};
    for (const [key, fieldSchema] of Object.entries(policyShape)) {
      const value = policyRecord[key];
      if (value === undefined) continue;
      if (fieldSchema.safeParse(value).success) cleaned[key] = value;
      // Log only the received type, never the value (provider config can hold secrets).
      else console.warn(`⚠️  config.json providers.${safeProviderName}.retryOn429.${key} (${typeof value}) is invalid — ignoring the field`);
    }
    const knownKeys = new Set(Object.keys(policyShape));
    for (const key of Object.keys(policyRecord)) {
      if (!knownKeys.has(key)) {
        // Redact the field NAME before logging: a malformed hand-edit can place a secret in a
        // property name (`retryOn429: { "sk-...": true }`). Ordinary typos (e.g. `attempt`)
        // stay readable, secret-shaped names become [REDACTED]. JSON-escape afterwards so a
        // control-character property name (newline/ANSI) can never forge a log line.
        console.warn(`⚠️  config.json providers.${safeProviderName}.retryOn429.${JSON.stringify(redactSecretString(key))} is not a recognized field — ignoring it`);
      }
    }
    if (hadPolicyEntries && Object.keys(cleaned).length === 0) {
      // Every supplied field was invalid: drop the whole policy. Persisting `{}` here would
      // opt IN to retries with defaults, which is the opposite of what a malformed
      // disable-oriented edit (`retryOn429: { enabled: "false" }`, `attempts: 0`) asked for.
      delete p.retryOn429;
      console.warn(`⚠️  config.json providers.${safeProviderName}.retryOn429 has no valid fields left — removing the policy (an empty policy would enable retries with defaults)`);
    } else {
      // Preserve an intentionally empty `retryOn429: {}` (presence = opt-in with defaults).
      p.retryOn429 = cleaned;
    }
  }
}

/**
 * Management write-boundary validation for `retryOn429` (fail closed). Unlike the
 * lenient load-time sanitizer, invalid values and unknown keys are rejected outright so
 * a POST/PATCH cannot persist a policy the proxy would then silently degrade. Reuses the
 * shared policy schema. Never echoes values, and secret-shaped unknown field names are
 * redacted (a malformed write can place a secret in a property name).
 */
export function retryOn429PolicyConfigError(policy: unknown): string | null {
  if (policy === undefined) return null;
  const result = retryOn429PolicySchema.safeParse(policy);
  if (result.success) return null;
  const first = result.error.issues[0];
  if (!first) return "retryOn429 is invalid";
  if (first.code === "unrecognized_keys") {
    const names = first.keys.map(key => JSON.stringify(redactSecretString(key))).join(", ");
    return `retryOn429 has unrecognized field${first.keys.length > 1 ? "s" : ""}: ${names}`;
  }
  if (first.path.length === 0) return `retryOn429 is invalid (${first.message})`;
  const field = String(first.path[first.path.length - 1]);
  return `retryOn429.${field} is invalid (${first.message})`;
}

/**
 * Load-time degradation for `providers.<name>.modelCosts`, mirroring
 * {@link sanitizeRetryOn429ForLoad}. A hand-edited malformed display-price row
 * must not fail the whole config parse — that would back up config.json and
 * fall back to defaults, dropping otherwise valid providers and the default
 * route for a typo in a non-runtime display field. Invalid rows are dropped
 * with a warning; strict rejection stays at the management/write boundary
 * (providerManagementConfigError).
 */
function sanitizeModelCostsForLoad(parsed: unknown): void {
  if (!parsed || typeof parsed !== "object") return;
  const root = parsed as Record<string, unknown>;
  const providers = root.providers;
  if (!providers || typeof providers !== "object" || Array.isArray(providers)) return;
  for (const [name, provider] of Object.entries(providers as Record<string, unknown>)) {
    // Runs before schema validation, so the provider name is untrusted: redact
    // secret-shaped names and JSON-escape control characters for the warning.
    const safeProviderName = JSON.stringify(redactSecretString(name));
    if (!provider || typeof provider !== "object" || Array.isArray(provider)) continue;
    const p = provider as Record<string, unknown>;
    const costs = p.modelCosts;
    if (costs === undefined) continue;
    if (!costs || typeof costs !== "object" || Array.isArray(costs)) {
      delete p.modelCosts;
      console.warn(`⚠️  config.json providers.${safeProviderName}.modelCosts (${typeof costs}) is invalid — ignoring the overlay`);
      continue;
    }
    const costsRecord = costs as Record<string, unknown>;
    const hadEntries = Object.keys(costsRecord).length > 0;
    let kept = 0;
    for (const [modelId, entry] of Object.entries(costsRecord)) {
      // Reuse the shared per-row shape contract so the load-time sanitizer
      // cannot drift from the schema and the write boundary.
      if (providerModelCostsConfigError({ [modelId]: entry }) === null) {
        kept++;
        continue;
      }
      delete costsRecord[modelId];
      // Redact the model id: a hand-edit can place a secret in a key name.
      console.warn(`⚠️  config.json providers.${safeProviderName}.modelCosts.${JSON.stringify(redactSecretString(modelId))} is invalid — ignoring the row`);
    }
    if (hadEntries && kept === 0) {
      delete p.modelCosts;
      console.warn(`⚠️  config.json providers.${safeProviderName}.modelCosts has no valid rows left — removing the overlay`);
    }
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
 * Companion to {@link warnDegradedStreamMode} for a malformed selection-order map.
 * Priority is a preference, so the schema drops the whole map rather than failing
 * the parse — say so once, otherwise the pool silently reverts to flat ordering.
 */
function degradedCodexAccountPriorityWarnings(rawParsed: unknown, validated: OcxConfig): string[] {
  const record = rawConfigRecord(rawParsed);
  const warnings: string[] = [];
  // The pin degrades silently otherwise, which reads as the manual selection simply
  // not having survived the restart.
  if (record?.activeCodexAccountPinned !== undefined && validated.activeCodexAccountPinned === undefined) {
    warnings.push("activeCodexAccountPinned is not a valid account id — the manually selected account is no longer pinned");
  }
  const raw = record?.codexAccountPriorities;
  if (raw !== undefined && validated.codexAccountPriorities === undefined) {
    warnings.push("codexAccountPriorities is invalid (expected account ids mapped to integers between -100 and 100) — account selection order is disabled");
  }
  return warnings;
}

function warnDegradedCodexAccountPriorities(rawParsed: unknown, validated: OcxConfig): void {
  for (const warning of degradedCodexAccountPriorityWarnings(rawParsed, validated)) {
    console.warn(`⚠️  config.json ${warning}`);
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
  // A hand-authored config never passes through the management validator, so coerce here too.
  // A malformed classifierFallbacks (a bare string, or an array with non-string entries) would
  // otherwise reach the resolver unchecked.
  if (Object.hasOwn(normalized, "classifierModel")) {
    const value = typeof normalized.classifierModel === "string" ? normalized.classifierModel.trim() : "";
    if (value.length > 0) normalized.classifierModel = value;
    else delete normalized.classifierModel;
  }
  if (Object.hasOwn(normalized, "classifierFallbacks")) {
    const raw = normalized.classifierFallbacks;
    const kept = Array.isArray(raw)
      ? raw.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0).map(entry => entry.trim())
      : [];
    if (kept.length > 0) normalized.classifierFallbacks = kept;
    else delete normalized.classifierFallbacks;
  }
  return normalized as OcxConfig["claudeCode"];
}

function normalizeClaudeSubagentEffort(config: OcxConfig, _rawParsed: unknown): OcxConfig {
  // Unconditional. This used to short-circuit when `subagentEffort` was absent or already valid,
  // which meant a config whose ONLY defect was elsewhere in `claudeCode` was never normalized.
  // The specialized subagentEffort WARNING is a separate concern and stays exactly as it is.
  if (!config.claudeCode) return config;
  return { ...config, claudeCode: normalizePersistedClaudeCode(config.claudeCode) };
}

function warnDegradedClaudeSubagentEffort(rawParsed: unknown): void {
  const rawEffort = rawClaudeSubagentEffort(rawParsed);
  if (rawEffort !== undefined && !isClaudeSubagentEffort(rawEffort)) {
    console.warn(`⚠️  config.json claudeCode.subagentEffort is invalid (expected ${CLAUDE_SUBAGENT_EFFORTS.join(", ")}) — ignoring it. Other settings were preserved.`);
  }
}

function malformedUpstreamHostCircuitThresholdWarning(rawParsed: unknown): string | null {
  const raw = rawConfigRecord(rawParsed);
  if (!raw || !Object.hasOwn(raw, "upstreamHostCircuitThreshold")) return null;
  const threshold = raw.upstreamHostCircuitThreshold;
  if (threshold === undefined) return null;
  if (typeof threshold === "number"
    && Number.isInteger(threshold)
    && threshold >= 0
    && threshold <= UPSTREAM_HOST_CIRCUIT_MAX_THRESHOLD) return null;
  return `upstreamHostCircuitThreshold ignored: expected an integer from 0 to ${UPSTREAM_HOST_CIRCUIT_MAX_THRESHOLD}`;
}

function warnDegradedUpstreamHostCircuitThreshold(rawParsed: unknown): void {
  const warning = malformedUpstreamHostCircuitThresholdWarning(rawParsed);
  if (warning) console.warn(`⚠️  config.json ${warning}. Other settings were preserved.`);
}

function malformedAgentTaskRecoveryWarning(rawParsed: unknown): string | null {
  const raw = rawConfigRecord(rawParsed);
  if (!raw || !Object.hasOwn(raw, "agentTaskRecovery")) return null;
  const result = agentTaskRecoverySchema.safeParse(raw.agentTaskRecovery);
  if (result.success) return null;
  const field = result.error.issues[0]?.path.join(".");
  return `agentTaskRecovery${field ? `.${field}` : ""} ignored: invalid experimental recovery configuration`;
}

function warnDegradedAgentTaskRecovery(rawParsed: unknown): void {
  const warning = malformedAgentTaskRecoveryWarning(rawParsed);
  if (warning) console.warn(`⚠️  config.json ${warning}. Other settings were preserved.`);
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

function malformedCodexAccountPickerWarning(rawParsed: unknown): string | null {
  const raw = rawConfigRecord(rawParsed);
  if (!raw || !Object.hasOwn(raw, "codexAccountPickerEnabled")) return null;
  if (typeof raw.codexAccountPickerEnabled === "boolean") return null;
  return "codexAccountPickerEnabled ignored: expected a boolean";
}

function warnDegradedCodexAccountPicker(rawParsed: unknown): void {
  const warning = malformedCodexAccountPickerWarning(rawParsed);
  if (warning) console.warn(`⚠️  config.json ${warning}. Other settings were preserved.`);
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

/**
 * Registry metadata can gain service-tier capability after a config was written. An explicit
 * `fastWire: null` remains authoritative on load and on whole-document writes; rejecting either
 * would discard or lock access to unrelated providers and API keys. Direct contradictions within
 * one provider row remain schema errors through the outer config refinement, where the dynamic
 * provider name can be redacted before it reaches diagnostics.
 */
function inheritedFastWireConflictProviderNames(
  config: Pick<OcxConfig, "providers">,
): string[] {
  const conflicts: string[] = [];
  for (const [name, provider] of Object.entries(config.providers)) {
    if (provider.fastWire !== null || provider.supportsServiceTier === false) continue;
    const registry = providerMatchesRegistryTransport(name, provider)
      ? getProviderRegistryEntry(name)
      : undefined;
    if (!registry) continue;
    const effectiveProviderCapability = provider.supportsServiceTier ?? registry.supportsServiceTier;
    const effectiveModelCapabilities = {
      ...(registryModelServiceTierCapabilityApplies(registry, provider)
        ? registry.modelSupportsServiceTier ?? {}
        : {}),
      ...(provider.modelSupportsServiceTier ?? {}),
    };
    if (
      effectiveProviderCapability === true
      || Object.values(effectiveModelCapabilities).some(value => value === true)
    ) {
      conflicts.push(name);
    }
  }
  return conflicts;
}

function inheritedFastWireConflictWarning(name: string): string {
  return `providers.${redactSecretString(name)}.fastWire=null overrides service-tier capability inherited from the matching registry entry`;
}

function warnInheritedFastWireConflicts(configPath: string, config: OcxConfig): void {
  const names = inheritedFastWireConflictProviderNames(config);
  if (names.length === 0 || warnedInheritedFastWireConflicts.has(configPath)) return;
  warnedInheritedFastWireConflicts.add(configPath);
  console.warn(
    `⚠️  config.json ${names.map(inheritedFastWireConflictWarning).join("; ")}. `
    + "The persisted providers and API keys were preserved.",
  );
}

/**
 * Load and validate config.json into an OcxConfig. Missing files reset to
 * defaults and clear stale overlays. Broken existing files also fall back to
 * default routing (after backup), but keep the last-good cost-overlay registry
 * until a valid config or a genuinely missing file is observed. A partially-
 * invalid config is merged with defaults so providers and pool accounts survive.
 */
export function loadConfig(): OcxConfig {
  const dir = getConfigDir();
  const configPath = getConfigPath();
  hardenConfigDir();
  hardenExistingSecret(configPath);
  hardenExistingSecret(join(dir, "auth.json"));
  if (!existsSync(configPath)) {
    return withRefreshedCostOverlays(getDefaultConfig());
  }
  try {
    const raw = readFileSync(configPath, "utf-8").replace(/^\uFEFF/, "");
    const parsed = JSON.parse(raw);
    sanitizeRetryOn429ForLoad(parsed);
    sanitizeModelCostsForLoad(parsed);
    const result = configSchema.safeParse(parsed);
    if (result.success) {
      const config = normalizeApiKeyIds(result.data as OcxConfig);
      warnInheritedFastWireConflicts(configPath, config);
      warnDegradedStreamMode(parsed, config);
      warnDegradedHostname(parsed, config);
      warnDegradedApiKeys(parsed, config);
      warnDegradedCodexAccountPriorities(parsed, config);
      warnDegradedClaudeSubagentEffort(parsed);
      warnDegradedNativeSubagentConfig(parsed, config);
      warnDegradedCodexAccountPicker(parsed);
      warnDegradedUpstreamHostCircuitThreshold(parsed);
      warnDegradedAgentTaskRecovery(parsed);
      return withRefreshedCostOverlays(normalizeClaudeSubagentEffort(normalizeNativeSubagentSync(config, parsed), parsed));
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
      warnInheritedFastWireConflicts(configPath, config);
      warnDegradedHostname(parsed, config);
      warnDegradedApiKeys(parsed, config);
      warnDegradedCodexAccountPriorities(parsed, config);
      warnDegradedClaudeSubagentEffort(parsed);
      warnDegradedNativeSubagentConfig(parsed, config);
      warnDegradedCodexAccountPicker(parsed);
      warnDegradedUpstreamHostCircuitThreshold(parsed);
      warnDegradedAgentTaskRecovery(parsed);
      return withRefreshedCostOverlays(normalizeClaudeSubagentEffort(normalizeNativeSubagentSync(config, parsed), parsed));
    }
    // Still failing, but if every complaint is about one or more named entries
    // in an independent section, drop exactly those and keep the rest. Falling
    // back to defaults here would silently retire the operator's providers,
    // keys and prices over a mistake in one routing profile.
    const salvaged = salvageConfigCandidate(merged, retryResult.error);
    if (salvaged) {
      {
        warnDroppedConfigSections(configPath, salvaged.dropped, salvaged.issues);
        const config = normalizeApiKeyIds(salvaged.parsed);
        warnInheritedFastWireConflicts(configPath, config);
        warnDegradedHostname(parsed, config);
        warnDegradedApiKeys(parsed, config);
        warnDegradedCodexAccountPriorities(parsed, config);
        warnDegradedClaudeSubagentEffort(parsed);
        warnDegradedNativeSubagentConfig(parsed, config);
        warnDegradedCodexAccountPicker(parsed);
        warnDegradedUpstreamHostCircuitThreshold(parsed);
        warnDegradedAgentTaskRecovery(parsed);
        return withRefreshedCostOverlays(normalizeClaudeSubagentEffort(normalizeNativeSubagentSync(config, parsed), parsed));
      }
    }
    // Merge couldn't fix it — truly broken config
    warnAndBackupInvalidConfig(configPath, result.error);
    return getDefaultConfig();
  } catch (error) {
    warnAndBackupInvalidConfig(configPath, error);
    return getDefaultConfig();
  }
}

/** Refresh the user cost-overlay registry from `config` and return it unchanged. */
function withRefreshedCostOverlays(config: OcxConfig): OcxConfig {
  refreshUserCostOverlays(config);
  return config;
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
  warnings.push(...inheritedFastWireConflictProviderNames(normalized).map(inheritedFastWireConflictWarning));
  warnings.push(...degradedCodexAccountPriorityWarnings(rawParsed, normalized));
  if (rawEffort !== undefined && !isClaudeSubagentEffort(rawEffort)) {
    warnings.push(`claudeCode.subagentEffort ignored: expected one of ${CLAUDE_SUBAGENT_EFFORTS.join(", ")}`);
  }
  warnings.push(...malformedNativeSubagentFields(rawParsed).map(malformedNativeSubagentFieldWarning));
  const pickerWarning = malformedCodexAccountPickerWarning(rawParsed);
  if (pickerWarning) warnings.push(pickerWarning);
  const hostCircuitWarning = malformedUpstreamHostCircuitThresholdWarning(rawParsed);
  if (hostCircuitWarning) warnings.push(hostCircuitWarning);
  const recoveryWarning = malformedAgentTaskRecoveryWarning(rawParsed);
  if (recoveryWarning) warnings.push(recoveryWarning);
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

function upstreamHostCircuitThresholdError(value: unknown): string | null {
  const raw = rawConfigRecord(value);
  if (!raw || !Object.hasOwn(raw, "upstreamHostCircuitThreshold")) return null;
  const threshold = raw.upstreamHostCircuitThreshold;
  if (threshold === undefined) return null;
  if (typeof threshold === "number"
    && Number.isInteger(threshold)
    && threshold >= 0
    && threshold <= UPSTREAM_HOST_CIRCUIT_MAX_THRESHOLD) return null;
  return `schema_invalid: upstreamHostCircuitThreshold: must be an integer from 0 to ${UPSTREAM_HOST_CIRCUIT_MAX_THRESHOLD}`;
}

function agentTaskRecoveryError(value: unknown): string | null {
  const raw = rawConfigRecord(value);
  if (!raw || !Object.hasOwn(raw, "agentTaskRecovery") || raw.agentTaskRecovery === undefined) return null;
  const result = agentTaskRecoverySchema.safeParse(raw.agentTaskRecovery);
  if (result.success) return null;
  const issue = result.error.issues[0];
  const field = issue?.path.join(".");
  return `schema_invalid: agentTaskRecovery${field ? `.${field}` : ""}: ${issue?.message ?? "invalid configuration"}`;
}

/**
 * Same reasoning as {@link blankHostnameError}, and more urgent: the read path degrades a
 * malformed selection-order map to undefined, which on a write would drop every entry the
 * user had accumulated and still report success. A load-time degrade leaves the raw map in
 * the file to be repaired by hand; a degraded write erases it. One bad `ocx config set`
 * must not cost the whole map, so a live caller is told instead.
 */
function codexAccountPrioritiesError(value: unknown): string | null {
  const raw = rawConfigRecord(value);
  if (!raw) return null;
  if (raw.codexAccountPriorities !== undefined) {
    const parsed = codexAccountPrioritiesSchema.safeParse(raw.codexAccountPriorities);
    if (!parsed.success) {
      return schemaDiagnosticsError(parsed.error).replace("schema_invalid: ", "schema_invalid: codexAccountPriorities.");
    }
  }
  // Tested as a string rather than coerced: `String(123)` matches the id pattern, so a
  // coercing guard waves a non-string pin through to the schema, where `.catch(undefined)`
  // drops it and reports the write as a success — the exact silent-degrade this guards.
  const pin = raw.activeCodexAccountPinned;
  if (pin !== undefined && (typeof pin !== "string" || !CODEX_ACCOUNT_PIN_PATTERN.test(pin))) {
    return "schema_invalid: activeCodexAccountPinned: must be an account id";
  }
  return null;
}

function googleAntigravityStaticCatalogVersionError(value: unknown): string | null {
  const raw = rawConfigRecord(value);
  if (!raw || !Object.hasOwn(raw, "googleAntigravityStaticCatalogVersion")) return null;
  const version = raw.googleAntigravityStaticCatalogVersion;
  if (version === undefined || version === 1 || version === 2) return null;
  return "schema_invalid: googleAntigravityStaticCatalogVersion: must be 1, 2, or omitted";
}

function codexAccountPickerEnabledError(value: unknown): string | null {
  const raw = rawConfigRecord(value);
  if (!raw) return null;
  const descriptor = Object.getOwnPropertyDescriptor(raw, "codexAccountPickerEnabled");
  if (!descriptor) {
    return "codexAccountPickerEnabled" in raw
      ? "schema_invalid: codexAccountPickerEnabled: must be an own boolean data property or omitted"
      : null;
  }
  if (!("value" in descriptor)) {
    return "schema_invalid: codexAccountPickerEnabled: must be an own boolean data property or omitted";
  }
  const enabled = descriptor.value;
  if (enabled === undefined || typeof enabled === "boolean") return null;
  return "schema_invalid: codexAccountPickerEnabled: must be a boolean or omitted";
}

function emptyCompletionRetryError(value: unknown): string | null {
  const raw = rawConfigRecord(value);
  if (!raw || !Object.hasOwn(raw, "emptyCompletionRetry")) return null;
  const enabled = raw.emptyCompletionRetry;
  if (enabled === undefined || typeof enabled === "boolean") return null;
  return "schema_invalid: emptyCompletionRetry: must be a boolean or omitted";
}

/** Validate an in-memory config candidate without touching disk. Used by headless CLI import/set. */
/**
 * Reject a loopback-listener port that collides with the proxy port (#1102).
 *
 * The schema can only check the shape of each field on its own; the two ports being distinct
 * is a relationship between them. Letting the pair through would surface as a startup failure
 * after the public listener already bound, which reads like an unrelated port conflict.
 *
 * This is write-time only, matching `blankHostnameError`: a live caller can be told the value
 * is wrong, whereas a hand-edited config on the read path degrades to undefined rather than
 * resetting the whole file.
 */
function loopbackListenerPortError(value: unknown): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const listener = (value as Record<string, unknown>).unauthenticatedLoopbackListener;
  if (listener === undefined) return null;
  if (!listener || typeof listener !== "object" || Array.isArray(listener)) {
    return "schema_invalid: unauthenticatedLoopbackListener: must be an object or omitted";
  }
  const entry = listener as Record<string, unknown>;
  // `enabled` must be a real boolean. The schema's `.catch(undefined)` would otherwise DELETE
  // a `"true"` string entry and report success, leaving an operator convinced they enabled an
  // unauthenticated listener that is in fact off. Load-time still degrades quietly — a hand
  // edit must not reset the file — but a live caller gets told.
  if (typeof entry.enabled !== "boolean") {
    return "schema_invalid: unauthenticatedLoopbackListener.enabled: must be a boolean";
  }
  if (entry.enabled !== true) return null;
  const listenerPort = entry.port;
  if (typeof listenerPort !== "number" || !Number.isInteger(listenerPort) || listenerPort < 1 || listenerPort > 65535) {
    return "schema_invalid: unauthenticatedLoopbackListener.port: must be an integer port when enabled";
  }
  const proxyPort = (value as Record<string, unknown>).port;
  if (typeof proxyPort === "number" && proxyPort === listenerPort) {
    return "schema_invalid: unauthenticatedLoopbackListener.port: must differ from the proxy port";
  }
  return null;
}

export function validateConfigCandidate(value: unknown): { ok: true; config: OcxConfig } | { ok: false; error: string } {
  const boundaryError = blankHostnameError(value)
    ?? claudeSubagentEffortError(value)
    ?? appOwnedMemoryBudgetError(value)
    ?? upstreamHostCircuitThresholdError(value)
    ?? agentTaskRecoveryError(value)
    ?? googleAntigravityStaticCatalogVersionError(value)
    ?? codexAccountPrioritiesError(value)
    ?? codexAccountPickerEnabledError(value)
    ?? emptyCompletionRetryError(value)
    ?? loopbackListenerPortError(value);
  if (boundaryError) return { ok: false, error: boundaryError };
  const result = configSchema.safeParse(value);
  if (result.success) {
    const config = normalizeApiKeyIds(result.data as OcxConfig);
    return { ok: true, config };
  }
  return { ok: false, error: schemaDiagnosticsError(result.error) };
}

function configDiagnosticsFromRaw(raw: string): ConfigDiagnostics {
  try {
    const parsed = JSON.parse(raw.replace(/^\uFEFF/, ""));
    // Same degradation as loadConfig: a hand-edited invalid retryOn429 must not trip the
    // schema and send the caller a default-config fallback (the config command could then
    // persist that fallback over the user's providers/keys).
    sanitizeRetryOn429ForLoad(parsed);
    sanitizeModelCostsForLoad(parsed);
    const result = configSchema.safeParse(parsed);
    if (result.success) {
      return validFileConfigDiagnostics(normalizeApiKeyIds(result.data as OcxConfig), parsed);
    }

    const merged = mergeConfigDefaults(parsed);
    const retryResult = configSchema.safeParse(merged);
    if (retryResult.success) {
      return validFileConfigDiagnostics(normalizeApiKeyIds(retryResult.data as OcxConfig), parsed);
    }

    // #1785: one invalid routing profile must not make diagnostics report the built-in
    // defaults AS the config, because a later config write persists those defaults over the
    // operator's providers, keys and prices.
    //
    // The failure is still reported. `source` stays "fallback" and `error` keeps the real
    // schema message -- diagnostics is the surface that tells callers the file is invalid,
    // and every consumer that must refuse an invalid config (provider reload, catalog sync,
    // cost reconcile, codex admission) gates on exactly those two fields. Only `config`
    // changes: it carries the salvaged document instead of factory defaults, so a caller
    // that ignores the error and writes it back preserves what the operator configured.
    const salvaged = salvageConfigCandidate(merged, retryResult.error);
    if (salvaged) {
      return {
        config: normalizeApiKeyIds(salvaged.parsed),
        source: "fallback",
        error: schemaDiagnosticsError(result.error),
      };
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

/**
 * The persisted config, plus a digest of the EXACT bytes it was parsed from.
 *
 * A union rather than a nullable digest, because `{ kind: "read" }` with no
 * digest is a state that cannot occur — and a state that cannot occur should
 * not be a state that can be written down. Refusing it at runtime is a check
 * somebody eventually forgets; making it unrepresentable is not.
 *
 * Why a byte digest at all: the Codex write lock compares an authority snapshot
 * taken before the lock against one taken while holding it, and its config
 * component used to hash the PARSED object. Two files that differ only in
 * whitespace or key order parse identically, so a non-cooperating writer could
 * rewrite the file between admission and commit and the comparison would see
 * nothing. Hashing what was actually read closes that.
 *
 * `readConfigFileSnapshot` stays private on purpose. Its `raw` carries provider
 * API keys and admission tokens, and `privacy:scan` reads tracked source text,
 * not runtime values — so it would not catch a caller that logged or serialized
 * that string. The digest travels; the bytes do not.
 */
export type ConfigAdmissionSnapshot =
  | Readonly<{ kind: "read"; diagnostics: ConfigDiagnostics; contentSha256: string }>
  | Readonly<{ kind: "unreadable"; diagnostics: ConfigDiagnostics; contentSha256: null }>;

export function readConfigAdmissionSnapshot(): ConfigAdmissionSnapshot {
  let bytes: Buffer;
  try {
    // ONE read. Hashing the file and then reading it again to parse would leave
    // a window for the two to disagree, which is the exact hazard this exists
    // to detect — the check would become a second chance to be wrong.
    bytes = readFileSync(getConfigPath());
  } catch (error) {
    return {
      kind: "unreadable",
      diagnostics: isMissingPathError(error)
        ? { config: getDefaultConfig(), source: "default", error: null }
        : { config: getDefaultConfig(), source: "fallback", error: "invalid_json" },
      contentSha256: null,
    };
  }
  return {
    kind: "read",
    // Decoded from the same buffer that was hashed, not re-read from disk.
    diagnostics: configDiagnosticsFromRaw(bytes.toString("utf-8")),
    contentSha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

const CONFIG_MUTATION_DB_FILENAME = "config-mutation.sqlite";
const CONFIG_MUTATION_DB_SIDECARS = ["-journal", "-wal", "-shm"] as const;
let warnedConfigMutationDirectoryAcl = false;

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
  if (windowsSecretAclApplies()) {
    try {
      // Distinct timeout memo from management-token directory harden: a required
      // management-dir timeout must not poison config mutation on the same home
      // (windows-latest server-management-auth cases).
      hardenSecretDir(dir, { required: true, timeoutMemoKey: `${dir}::config-mutation` });
    } catch (error) {
      if (!warnedConfigMutationDirectoryAcl) {
        warnedConfigMutationDirectoryAcl = true;
        const diagnostics = error instanceof Error ? error.message : "ACL hardening failed";
        console.warn(
          `[opencodex] Config mutation coordination directory ACL hardening did not complete; continuing without it. ${diagnostics}`,
        );
      }
    }
  }
  const path = join(dir, CONFIG_MUTATION_DB_FILENAME);
  recordOwnedConfigPath(dir, path);
  for (const suffix of CONFIG_MUTATION_DB_SIDECARS) {
    recordOwnedConfigPath(dir, `${path}${suffix}`);
  }
  return path;
}

let configMutationLockDepth = 0;
let configMutationDatabase: Database | null = null;

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
    initializeConfigGeneration(database);
  } catch (cause) {
    if (transactionOpen) {
      try { database?.exec("ROLLBACK"); } catch { /* close below still releases the OS lock */ }
    }
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
  configMutationDatabase = database;
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
    configMutationDatabase = null;
    try { database.close(); } catch { /* the OS lock is released with the handle */ }
  }
}

function bumpGenerationForCooperatingConfigWrite(): void {
  if (!configMutationDatabase) {
    throw new Error("A cooperating config write requires the config mutation transaction.");
  }
  bumpCurrentConfigGeneration(configMutationDatabase);
}

export const readConfigGeneration: ReadConfigGeneration = () => {
  try {
    return readConfigGenerationAtPath(configMutationDatabasePath());
  } catch {
    return { kind: "unavailable", reason: "database" };
  }
};

export function observeConfigGeneration(): ConfigGenerationObservation {
  return observeConfigGenerationAtPath(join(getConfigDir(), CONFIG_MUTATION_DB_FILENAME));
}

/**
 * Read the generation from the transaction that is open RIGHT NOW.
 *
 * The observer cannot do this job. On the very first acquisition the
 * `BEGIN IMMEDIATE` that creates the table has not committed yet, so a separate
 * read-only connection cannot read a generation from it — measured, not
 * assumed. A caller that compared a pre-lock observation against an observer
 * re-read would therefore refuse every first write as stale.
 *
 * Throwing when no transaction is open is deliberate. Being called outside the
 * lock is broken plumbing, and returning a typed "unavailable" would let that
 * bug arrive disguised as an environmental failure — retried forever, on a
 * machine where nothing is wrong.
 */
export function readConfigGenerationInCurrentMutationTransaction(): ConfigGeneration {
  if (configMutationLockDepth < 1 || !configMutationDatabase) {
    throw new Error(
      "readConfigGenerationInCurrentMutationTransaction requires an open config mutation transaction.",
    );
  }
  return readConfigGenerationInTransaction(configMutationDatabase);
}

export const bumpConfigGeneration: BumpConfigGeneration = expected => {
  try {
    return bumpConfigGenerationAtPath(configMutationDatabasePath(), expected);
  } catch {
    return { kind: "unavailable", reason: "database" };
  }
};

function configGenerationFailureReason(error: unknown): "busy" | "database" {
  const cause = error instanceof ConfigMutationLockError ? error.cause : error;
  const code = cause && typeof cause === "object" && "code" in cause
    ? String((cause as { code?: unknown }).code)
    : "";
  const message = cause instanceof Error ? cause.message : "";
  return code === "SQLITE_BUSY"
    || code === "SQLITE_LOCKED"
    || /database (?:is|table is) locked/i.test(message)
    ? "busy"
    : "database";
}

export const withExpectedConfigGenerationSync: WithExpectedConfigGenerationSync = (
  expected,
  commit,
) => {
  let callbackThrew = false;
  let callbackError: unknown;
  try {
    return withConfigMutationLockSync(() => {
      const database = configMutationDatabase;
      if (!database) throw new Error("Config mutation transaction database is unavailable.");
      const current = readConfigGenerationInTransaction(database);
      if (current.value !== expected.value) return { kind: "conflict", current };
      try {
        return { kind: "matched", generation: current, value: commit() };
      } catch (error) {
        callbackThrew = true;
        callbackError = error;
        throw error;
      }
    });
  } catch (error) {
    if (callbackThrew && error === callbackError) throw error;
    return { kind: "unavailable", reason: configGenerationFailureReason(error) };
  }
};

/**
 * Atomic config.json write WITHOUT the mutation lock; callers must hold
 * `withConfigMutationLockSync`. Returns true when bytes changed. Refreshes the
 * cost-overlay registry from the persisted config so runtime estimates follow
 * every save path.
 */
function persistConfigUnlocked(config: OcxConfig): boolean {
  const configPath = getConfigPath();
  // External editors can add provider rows the live config deliberately does
  // not route with yet; merge them at the serialization boundary so an
  // unrelated in-process save cannot erase the provider or its overlay.
  const persisted = withPreservedDiskOnlyProviders(config);
  const bytes = JSON.stringify(persisted, null, 2) + "\n";
  let unchanged = false;
  try {
    unchanged = readFileSync(configPath, "utf8") === bytes;
  } catch (error) {
    if (!isMissingPathError(error)) throw error;
  }
  // Keep the runtime overlay registry in sync with EVERY persist path,
  // including byte-identical saves: a cooperating CLI process may have written
  // the same bytes (e.g. before a proxy notification), and Logs/Usage must
  // adopt the overlay without waiting for a changed save or restart.
  if (unchanged) {
    refreshUserCostOverlays(persisted);
    return false;
  }
  atomicWriteFile(configPath, bytes);
  // For changed saves, refresh only AFTER the write succeeded so a failed
  // write cannot leave estimates reflecting configuration never persisted.
  refreshUserCostOverlays(persisted);
  return true;
}

/** Persist `config` to config.json under the config-mutation lock. */
export function saveConfig(config: OcxConfig): void {
  // Keep the real-home assertion ahead of even lock-directory preparation.
  assertNotRealHomeUnderTest(getConfigDir());
  withConfigMutationLockSync(() => {
    const projected = projectCustomModelCatalogMigration(readRawConfigJson(), config);
    if (persistConfigUnlocked(projected)) bumpGenerationForCooperatingConfigWrite();
    adoptCustomModelCatalogMigration(config, projected);
  });
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

      const projected = projectCustomModelCatalogMigration(
        commitBase.diagnostics.config,
        confirmedConfig,
      );
      if (persistConfigUnlocked(projected)) bumpGenerationForCooperatingConfigWrite();
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
 * Full live-config baseline used to rebase unrelated cooperating writes. The
 * Claude subtree and the bound listener fields remain on their dedicated
 * reconciliation paths below.
 */
const liveConfigBaseline = new WeakMap<OcxConfig, OcxConfig>();

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
  liveConfigBaseline.set(config, structuredClone(config));
  claudeCodeBaseline.set(config, structuredClone(config.claudeCode));
}

/**
 * Adopt one schema-validated provider that was read from the authoritative disk
 * config into a long-lived server config without rebasing any unrelated field.
 * Updating the matching baseline row keeps a later guarded save from treating the
 * adopted provider as an unsaved live edit that should defeat a newer disk change.
 */
export function adoptPersistedProviderIntoLiveConfig(
  config: OcxConfig,
  name: string,
  provider: OcxProviderConfig,
  persistedConfig?: OcxConfig,
): void {
  config.providers[name] = structuredClone(provider);
  const baseline = liveConfigBaseline.get(config);
  if (baseline) baseline.providers[name] = structuredClone(provider);
  if (persistedConfig) refreshPreservedProviderOwner(config, persistedConfig);
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

type IndexedCustomModels = {
  order: string[];
  byId: Map<string, Record<string, unknown>>;
};

function indexCustomModels(value: ConfigMergeValue): IndexedCustomModels | null {
  if (!Array.isArray(value)) return null;
  const order: string[] = [];
  const byId = new Map<string, Record<string, unknown>>();
  for (const item of value) {
    if (!isPlainConfigRecord(item) || typeof item.id !== "string" || item.id.length === 0 || byId.has(item.id)) {
      return null;
    }
    order.push(item.id);
    byId.set(item.id, item);
  }
  return { order, byId };
}

/**
 * Merge custom-model rows by their stable id instead of treating the array as
 * one opaque value. A row changed only on disk is adopted, a row changed only
 * in the live config is retained, and disjoint edits to the same row recurse
 * through the normal three-way object merge. A newer persisted row deletion
 * wins over a stale live edit to that row.
 */
function reconcileCustomModels(
  baseline: ConfigMergeValue,
  live: ConfigMergeValue,
  persisted: ConfigMergeValue,
): ConfigMergeValue | null {
  const baselineRows = indexCustomModels(baseline);
  const liveRows = indexCustomModels(live);
  const persistedRows = indexCustomModels(persisted);
  if (!baselineRows || !liveRows || !persistedRows) return null;

  const order = [...liveRows.order, ...persistedRows.order.filter(id => !liveRows.byId.has(id))];
  const merged: Array<Record<string, unknown>> = [];
  for (const id of order) {
    const baselineRow = baselineRows.byId.get(id) ?? MISSING_CONFIG_VALUE;
    const persistedRow = persistedRows.byId.get(id) ?? MISSING_CONFIG_VALUE;
    const row = baselineRow !== MISSING_CONFIG_VALUE && persistedRow === MISSING_CONFIG_VALUE
      ? MISSING_CONFIG_VALUE
      : reconcileConfigValue(
          baselineRow,
          liveRows.byId.get(id) ?? MISSING_CONFIG_VALUE,
          persistedRow,
        );
    if (row !== MISSING_CONFIG_VALUE) merged.push(row as Record<string, unknown>);
  }
  return merged;
}

function reconcileConfigRecord(
  live: Record<string, unknown>,
  baseline: Record<string, unknown>,
  persisted: Record<string, unknown>,
  skippedKeys?: ReadonlySet<string>,
  persistedDeletionsWin = false,
): void {
  const keys = new Set([...Object.keys(baseline), ...Object.keys(live), ...Object.keys(persisted)]);
  for (const key of keys) {
    if (skippedKeys?.has(key)) continue;
    const baselineValue = ownConfigValue(baseline, key);
    const liveValue = ownConfigValue(live, key);
    const persistedValue = ownConfigValue(persisted, key);
    const merged = persistedDeletionsWin
        && baselineValue !== MISSING_CONFIG_VALUE
        && persistedValue === MISSING_CONFIG_VALUE
      ? MISSING_CONFIG_VALUE
      : key === "customModels"
        ? reconcileCustomModels(baselineValue, liveValue, persistedValue)
          ?? reconcileConfigValue(baselineValue, liveValue, persistedValue)
        : reconcileConfigValue(baselineValue, liveValue, persistedValue, key === "providers");
    if (merged === MISSING_CONFIG_VALUE) delete live[key];
    else live[key] = merged;
  }
}

function reconcileConfigValue(
  baseline: ConfigMergeValue,
  live: ConfigMergeValue,
  persisted: ConfigMergeValue,
  persistedChildDeletionsWin = false,
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
      undefined,
      persistedChildDeletionsWin,
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
  // The reconciliation may have adopted a providers.<name>.modelCosts edit made
  // by a cooperating process while the OAuth login was pending; keep the overlay
  // registry (and the usage-cache overlay version) in sync with the live config.
  refreshUserCostOverlays(config);
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
 * - disk changed AND we changed → disjoint fields are merged, while a same-leaf
 *   conflict keeps the live value;
 * - a provider or custom-model row deleted on disk stays deleted even if stale
 *   live state edited that same row;
 * - file missing/unreadable → save what we have, no throw.
 *
 * Custom-model rows are merged by their stable `id`, preserving independent
 * edits and deletions across stale whole-config saves.
 */
export function saveConfigPreservingClaudeCode(config: OcxConfig): void {
  withConfigMutationLockSync(() => {
    const bindingBaseline = persistedLiveServerBinding.get(config);
    // One authoritative pre-write read feeds both the live-config reconciliation and
    // custom-model deletion migration. A second read could observe different bytes.
    const onDisk = readRawConfigJson();
    const baseline = liveConfigBaseline.get(config);
    if (baseline && onDisk !== undefined) {
      const persistedDiagnostics = configDiagnosticsFromRaw(JSON.stringify(onDisk));
      if (persistedDiagnostics.source === "file") {
        // Only keys this live config is actually known to have diverged on may be
        // rebased. The baseline is captured once when the server arms it, so any key
        // that appeared on disk afterwards — through saveConfig(), a hand edit, or
        // another process — is absent from the baseline as well as from the live
        // config. Reconciling those keys reads "live never changed this" and adopts
        // the disk value, which resurrects a field the live writer had deliberately
        // deleted (#1462 regression: PUT /api/grok/selection with an empty list).
        // Restrict the merge to keys the baseline knew about, plus keys the live
        // config still carries; a key that exists only on disk is left to the
        // ordinary whole-config write below.
        const rebaseableKeys = new Set([
          ...Object.keys(baseline as unknown as Record<string, unknown>),
          ...Object.keys(config as unknown as Record<string, unknown>),
        ]);
        const skipped = new Set(["hostname", "port", "claudeCode"]);
        for (const key of Object.keys(persistedDiagnostics.config as unknown as Record<string, unknown>)) {
          if (!rebaseableKeys.has(key)) skipped.add(key);
        }
        reconcileConfigRecord(
          config as unknown as Record<string, unknown>,
          baseline as unknown as Record<string, unknown>,
          persistedDiagnostics.config as unknown as Record<string, unknown>,
          skipped,
        );
      }
    }
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
    const projectedConfig = projectCustomModelCatalogMigration(
      onDisk,
      config,
    );
    const persistedBinding = bindingBaseline && onDisk
      ? readPersistedServerBinding(onDisk, bindingBaseline)
      : bindingBaseline;
    if (persistedBinding) {
      const persistedConfig: OcxConfig = { ...projectedConfig, port: persistedBinding.port };
      if (persistedBinding.hostname === undefined) delete persistedConfig.hostname;
      else persistedConfig.hostname = persistedBinding.hostname;
      if (persistConfigUnlocked(persistedConfig)) bumpGenerationForCooperatingConfigWrite();
      persistedLiveServerBinding.set(config, persistedBinding);
    } else {
      if (persistConfigUnlocked(projectedConfig)) bumpGenerationForCooperatingConfigWrite();
    }
    adoptCustomModelCatalogMigration(config, projectedConfig);
    if (claudeCodeBaseline.has(config)) {
      claudeCodeBaseline.set(config, structuredClone(config.claudeCode));
    }
    if (liveConfigBaseline.has(config)) {
      liveConfigBaseline.set(config, structuredClone(config));
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
    emptyCompletionRetry: false,
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
  // Guard before ANY directory mutation (mkdir or chmod), not just the write.
  assertNotRealHomeUnderTest(dir);
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
  /** Per-process proof key; protected by the config directory and never served. */
  attestationSecret?: string;
};

function isValidRuntimePortState(value: unknown): value is RuntimePortState {
  if (!value || typeof value !== "object") return false;
  const state = value as Record<string, unknown>;
  const hostnameOk = state.hostname === undefined || typeof state.hostname === "string";
  const attestationOk = state.attestationSecret === undefined || isLocalAttestationSecret(state.attestationSecret);
  return Number.isSafeInteger(state.pid)
    && Number(state.pid) > 0
    && Number.isInteger(state.port)
    && Number(state.port) > 0
    && Number(state.port) <= 65535
    && hostnameOk
    && attestationOk;
}

export function writeRuntimePort(state: RuntimePortState): void {
  const dir = getConfigDir();
  // Guard before ANY directory mutation (mkdir or chmod), not just the write.
  assertNotRealHomeUnderTest(dir);
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

/**
 * Sections whose entries are independent of one another, so one bad entry is
 * safe to drop without changing what the rest mean.
 *
 * Both are validated entry-by-entry in the `superRefine` above, which raises
 * every finding as a *document*-level issue. That is what made a single routing
 * candidate naming a disabled provider discard the operator's whole config —
 * all eleven providers, every API key, and the entire `modelCosts` table —
 * while the proxy carried on serving from built-in defaults and reporting
 * healthy.
 */
const SALVAGEABLE_CONFIG_SECTIONS = ["routingProfiles", "combos"] as const;

/**
 * Drop just the named entries a parse failure blamed, so the rest of the
 * document survives.
 *
 * Returns `null` when the failure was not confined to those sections — the
 * caller then keeps its existing behaviour rather than guessing.
 *
 * The whole entry goes, not the individual offending candidate. A routing
 * profile that quietly loses one candidate still routes, just not where the
 * operator said it should, and a policy that silently changed shape is a worse
 * outcome than one that is plainly absent. Absent is also the loud option: a
 * dry-run against it answers `unknown_profile`, which — paired with the warning
 * this emits — points at the real mistake.
 */
function dropInvalidConfigSections(
  parsed: unknown,
  error: z.ZodError,
): { candidate: Record<string, unknown>; dropped: string[] } | null {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;

  const doomed = new Map<string, Set<string>>();
  for (const issue of error.issues) {
    if (isUnsalvageableIssue(issue)) return null;
    const [section, id] = issue.path;
    if (typeof section !== "string" || typeof id !== "string") return null;
    if (!(SALVAGEABLE_CONFIG_SECTIONS as readonly string[]).includes(section)) return null;
    // A complaint about the container itself ("combos must be an object") is
    // not about one entry, so there is nothing selective to drop.
    if (issue.path.length < 2) return null;
    let ids = doomed.get(section);
    if (!ids) doomed.set(section, ids = new Set());
    ids.add(id);
  }
  if (doomed.size === 0) return null;

  const candidate: Record<string, unknown> = { ...(parsed as Record<string, unknown>) };
  const dropped: string[] = [];
  for (const [section, ids] of doomed) {
    const current = candidate[section];
    if (!current || typeof current !== "object" || Array.isArray(current)) return null;
    const kept: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(current as Record<string, unknown>)) {
      if (ids.has(key)) dropped.push(`${section}.${key}`);
      else kept[key] = value;
    }
    candidate[section] = kept;
  }
  return dropped.length > 0 ? { candidate, dropped } : null;
}

/**
 * Salvage until the document parses, not just once.
 *
 * One pass is not enough because the sections depend on each other: routing
 * profiles are validated against the combo map, so dropping an invalid combo can
 * expose a profile that referenced it. A single-pass salvage sees that second
 * failure and gives up, discarding the whole config -- the exact outcome this
 * code exists to prevent.
 *
 * `rawDocument` is the operator's document before defaults were merged in. When
 * supplied, the same entries are deleted from it too, so a diagnostics caller can
 * still tell an absent optional setting from one we injected.
 */

/**
 * Findings that must never be salvaged away.
 *
 * Salvage removes the entry a finding blamed, which is right for an ordinary
 * validation mistake and wrong for a namespace collision: the collision is a
 * *relationship* between a combo/profile and a Codex account selector, and it is
 * reported on the combo. Dropping that combo makes the document parse and quietly
 * admits the account selector the schema just refused, turning a hard admission
 * boundary into a config that loads. Refuse the whole document instead.
 */
const UNSALVAGEABLE_ISSUE_MESSAGES: readonly string[] = [
  CODEX_ACCOUNT_NAMESPACE_COMBO_ALIAS_COLLISION_ERROR,
];

function isUnsalvageableIssue(issue: z.ZodIssue): boolean {
  return UNSALVAGEABLE_ISSUE_MESSAGES.some(message => issue.message.includes(message));
}
function salvageConfigCandidate(
  merged: unknown,
  initialError: z.ZodError,
  rawDocument?: unknown,
): {
  candidate: Record<string, unknown>;
  rawCandidate: unknown;
  parsed: OcxConfig;
  dropped: string[];
  issues: z.ZodIssue[];
} | null {
  let candidate: unknown = merged;
  let rawCandidate: unknown = rawDocument;
  let error = initialError;
  const dropped: string[] = [];
  const issues: z.ZodIssue[] = [];
  // Bounded by construction: every pass must remove at least one entry, and there
  // are only so many entries to remove.
  const budget = countSalvageableEntries(merged) + 1;
  for (let pass = 0; pass < budget; pass++) {
    const step = dropInvalidConfigSections(candidate, error);
    if (!step || step.dropped.length === 0) return null;
    dropped.push(...step.dropped);
    issues.push(...error.issues);
    candidate = step.candidate;
    rawCandidate = deleteEntryPaths(rawCandidate, step.dropped);
    const result = configSchema.safeParse(candidate);
    if (result.success) {
      return { candidate: step.candidate, rawCandidate, parsed: result.data as OcxConfig, dropped, issues };
    }
    error = result.error;
  }
  return null;
}

function countSalvageableEntries(document: unknown): number {
  if (!document || typeof document !== "object" || Array.isArray(document)) return 0;
  let total = 0;
  for (const section of SALVAGEABLE_CONFIG_SECTIONS) {
    const value = (document as Record<string, unknown>)[section];
    if (value && typeof value === "object" && !Array.isArray(value)) {
      total += Object.keys(value as Record<string, unknown>).length;
    }
  }
  return total;
}

/** Delete `section.id` entries from a copy of the raw document. */
function deleteEntryPaths(document: unknown, entryPaths: readonly string[]): unknown {
  if (!document || typeof document !== "object" || Array.isArray(document)) return document;
  const next: Record<string, unknown> = { ...(document as Record<string, unknown>) };
  for (const entryPath of entryPaths) {
    const separator = entryPath.indexOf(".");
    if (separator <= 0) continue;
    const section = entryPath.slice(0, separator);
    const id = entryPath.slice(separator + 1);
    const container = next[section];
    if (!container || typeof container !== "object" || Array.isArray(container)) continue;
    const kept: Record<string, unknown> = { ...(container as Record<string, unknown>) };
    delete kept[id];
    next[section] = kept;
  }
  return next;
}

/**
 * Entry ids are operator-chosen and can be token-shaped, so nothing dynamic reaches
 * the log unredacted. Static section names stay readable -- they are the part that
 * tells the operator where to look.
 */
function redactEntryPath(entryPath: string): string {
  const separator = entryPath.indexOf(".");
  if (separator <= 0) return redactSecretString(entryPath);
  return entryPath.slice(0, separator) + "." + redactSecretString(entryPath.slice(separator + 1));
}

function redactIssuePath(path: readonly PropertyKey[]): string {
  return path
    .map((segment, index) => (index === 0 && typeof segment === "string" ? segment : redactSecretString(String(segment))))
    .join(".");
}

function warnDroppedConfigSections(configPath: string, dropped: string[], issues: readonly z.ZodIssue[]): void {
  if (warnedConfigFallbacks.has(configPath)) return;
  warnedConfigFallbacks.add(configPath);
  const reasons = issues
    .map(issue => `${redactIssuePath(issue.path)}: ${redactSecretString(issue.message)}`)
    .join("; ");
  console.error(
    `opencodex config at ${configPath}: dropped [${dropped.map(redactEntryPath).join(", ")}] and loaded the rest — ${reasons}. `
    + "Everything else in your config, including providers and modelCosts, is preserved.",
  );
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
  // `@bitkyc08/.opencodex-*` is npm's in-place rename of the global package during
  // `npm install -g` — a Windows service wrapper can respawn from that temp tree
  // mid-update, and must still count as ocx for port reclaim.
  const hasOcxEntrypoint = normalized.includes("src/cli.ts")
    || normalized.includes("src/cli/index.ts")
    || normalized.includes("@bitkyc08/opencodex")
    || /@bitkyc08\/\.opencodex-/.test(normalized)
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

type ProcessCommandLineExec = (
  executable: string,
  args: string[],
  options: {
    encoding: BufferEncoding;
    stdio: ["ignore", "pipe", "ignore"];
    timeout: number;
    windowsHide: boolean;
  },
) => string;

const defaultProcessCommandLineExec: ProcessCommandLineExec = (executable, args, options) =>
  execFileSync(executable, args, options);
let processCommandLineExec = defaultProcessCommandLineExec;
let processCommandLinePlatformForTests: NodeJS.Platform | null = null;

/** Test-only seam for verifying the exact system executable selected by pid identity probes. */
export function setProcessCommandLineExecForTests(next: ProcessCommandLineExec | null): void {
  processCommandLineExec = next ?? defaultProcessCommandLineExec;
}

/** Test-only seam so cross-platform tests do not mutate process.platform. */
export function setProcessCommandLinePlatformForTests(next: NodeJS.Platform | null): void {
  processCommandLinePlatformForTests = next;
}

function readProcessCommandLine(pid: number): string | undefined {
  if (!Number.isSafeInteger(pid) || pid <= 0) return undefined;
  const platform = processCommandLinePlatformForTests ?? process.platform;
  try {
    if (platform === "linux") {
      try {
        const output = readFileSync(`/proc/${pid}/cmdline`, "utf-8");
        const value = output.replace(/\0/g, " ").trim();
        if (value) return value;
      } catch {
        /* procfs unavailable — use the fixed ps fallback below */
      }
    }
    if (platform === "win32") {
      // Prefer WMIC over PowerShell: much faster cold start, and windowsHide avoids console flash.
      // Fall back to PowerShell when WMIC is absent (newer Windows images).
      const wmic = join(resolveTrustedWindowsSystemDirectory(), "wbem", "WMIC.exe");
      try {
        const output = processCommandLineExec(wmic, [
          "process", "where", `ProcessId=${pid}`, "get", "CommandLine", "/VALUE",
        ], { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"], timeout: 3000, windowsHide: true });
        const match = /^CommandLine=(.*)$/m.exec(output.replace(/\r/g, ""));
        const value = match?.[1]?.trim();
        if (value) return value;
      } catch {
        /* WMIC missing or failed — fall through */
      }
      const output = processCommandLineExec(resolveTrustedWindowsPowerShellExe(), [
        "-NoProfile",
        "-NoLogo",
        "-NonInteractive",
        "-Command",
        `(Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}").CommandLine`,
      ], { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"], timeout: 3000, windowsHide: true });
      return output.trim() || undefined;
    }
    for (const ps of ["/bin/ps", "/usr/bin/ps"]) {
      try {
        const output = processCommandLineExec(ps, ["-p", String(pid), "-o", "command="], {
          encoding: "utf-8",
          stdio: ["ignore", "pipe", "ignore"],
          timeout: 1000,
          windowsHide: true,
        });
        const value = output.trim();
        if (value) return value;
      } catch {
        /* try the other fixed system path */
      }
    }
    return undefined;
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
