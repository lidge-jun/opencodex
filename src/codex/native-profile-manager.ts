import { randomUUID } from "node:crypto";
import { Database } from "bun:sqlite";
import {
  chmodSync,
  closeSync,
  constants as fsConstants,
  existsSync,
  fstatSync,
  ftruncateSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { atomicWriteFileAsync } from "../config";
import { hardenSecretDirAsync, hardenSecretPathAsync } from "../lib/windows-secret-acl";
import { applyConfirmedMainCodexAccountTransition } from "./account-lifecycle";
import {
  assertStableLockFile,
  openStableLockFile,
  StableLockPathUnsafeError,
  type StableLockFile,
} from "./native-main-lock-file";
import { decideNativeProfileRecovery } from "./native-profile-recovery";
import { probeNativeCodexProcesses, type NativeCodexProcessProbe } from "./native-profile-processes";
import {
  assertUniqueNativeProfileLabel,
  assertNativeProfileLockPath,
  assertNativeProfileMetadataLayout,
  assertNoLegacyNativeProfileState,
  decryptNativeEnvelope,
  encryptNativeEnvelope,
  inspectNativeProfileJournal,
  MAX_NATIVE_PROFILES,
  nativeIdentityHash,
  nativeIdentityHint,
  nativeProfileSelectorKey,
  OsNativeProfileKeyProvider,
  publicNativeProfile,
  readNativeEnvelope,
  readNativeEnvelopeResult,
  readNativeProfileVault,
  probeNativeProfileRecoveryState,
  requireFileCredentialStore,
  resolveNativeCredentialStoreMode,
  resolveNativeProfileContext,
  serializeNativeProfileJournal,
  serializeNativeProfileMetadata,
  validateNativeProfileLabel,
  type NativeEnvelopeSnapshot,
  type NativeProfileContext,
} from "./native-profile-store";
import {
  NativeProfileError,
  type NativeMainProfileRecordV1,
  type NativeMainProfileVaultV1,
  type NativeProfileKey,
  type NativeProfileKeyProvider,
  type NativeProfilePublic,
  type NativeProfileSwitchJournalV1,
} from "./native-profile-types";
import {
  NATIVE_STAGE_HEARTBEAT_INTERVAL_MS,
  NativeProfileStageStore,
  type NativeStageProof,
  type NativeStageTerminalOutcome,
} from "./native-profile-stage-store";

const LOCK_WAIT_MS = 5_000;
const LEGACY_STAGE_MAX_AGE_MS = 30 * 60_000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

interface PathIdentity {
  dev: bigint;
  ino: bigint;
}

type AtomicWriter = (path: string, content: string) => Promise<void>;
type TransitionApplier = (fromAccountId: string, toAccountId: string) => void;
type EnvelopeReader = (path: string) => NativeEnvelopeSnapshot;
type VaultReader = () => NativeMainProfileVaultV1 | null;
type EnvelopeResultReader = (path: string) => ReturnType<typeof readNativeEnvelopeResult>;
type StableLockOpener = (path: string) => StableLockFile;
type StableLockAsserter = (path: string, file: StableLockFile) => void;
export type NativeProfileSwitchBoundary =
  | "journal-prepared"
  | "auth-replaced"
  | "vault-committed"
  | "runtime-transition-published"
  | "journal-deleted";

export interface NativeProfileManagerOptions {
  codexHome?: string;
  configDir?: string;
  keyProvider?: NativeProfileKeyProvider;
  atomicWrite?: AtomicWriter;
  hardenPath?: (path: string) => Promise<void>;
  processProbe?: () => Promise<NativeCodexProcessProbe>;
  applyTransition?: TransitionApplier;
  now?: () => number;
  randomUUID?: () => string;
  sleep?: (ms: number) => Promise<void>;
  lockWaitMs?: number;
  onLockAcquired?: () => void | Promise<void>;
  removeStageTree?: (path: string) => void;
  stageLeaseMs?: number;
  /** Test-only crash seam; production never supplies this callback. */
  onSwitchBoundary?: (boundary: NativeProfileSwitchBoundary) => void | Promise<void>;
  /** Test-only reader seams; production uses the native profile store directly. */
  readEnvelope?: EnvelopeReader;
  readVault?: VaultReader;
  readEnvelopeResult?: EnvelopeResultReader;
  /** Test-only stable-path seams; production uses the native stable-lock helpers directly. */
  stableLockOpen?: StableLockOpener;
  stableLockAssert?: StableLockAsserter;
}

export interface NativeProfileListResult {
  effectiveCodexHome: string;
  activeProfileId: string | null;
  profiles: NativeProfilePublic[];
}

export interface NativeStageCleanupResult {
  removed: boolean;
  plaintextMayRemain: boolean;
}

export interface NativeStageSweepResult {
  removed: number;
  live: number;
  cleanupFailed: number;
  plaintextMayRemain: boolean;
}

async function hardenNativeProfilePath(path: string): Promise<void> {
  const entry = lstatSync(path);
  if (entry.isSymbolicLink() || (!entry.isDirectory() && !entry.isFile())) {
    throw new NativeProfileError("PROFILE_STORAGE_UNSAFE", "A native-profile path is not a private file or directory.", 409);
  }
  const directory = entry.isDirectory();
  const mode = directory ? 0o700 : 0o600;
  try { chmodSync(path, mode); } catch { /* Windows ACL below is authoritative there. */ }
  if (process.platform === "win32") {
    if (directory) await hardenSecretDirAsync(path, { required: true, timeoutMemoKey: path });
    else await hardenSecretPathAsync(path, { required: true, timeoutMemoKey: path });
  }
}

function samePath(left: string, right: string): boolean {
  return resolve(left) === resolve(right);
}

function pathIdentity(path: string): PathIdentity {
  const entry = lstatSync(path, { bigint: true });
  return { dev: entry.dev, ino: entry.ino };
}

function sameIdentity(left: PathIdentity, right: PathIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function assertPathIdentity(path: string, expected: PathIdentity, label: string): void {
  try {
    if (!sameIdentity(pathIdentity(path), expected)) throw new Error("identity changed");
  } catch {
    throw new NativeProfileError("PROFILE_STORAGE_UNSAFE", `${label} was replaced during the native-profile operation.`, 409);
  }
}

function assertSafeDirectory(path: string, label: string): string {
  try {
    const entry = lstatSync(path);
    if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error("entry type");
    const canonical = realpathSync.native(path);
    if (!samePath(canonical, path)) throw new Error("path substitution");
    return canonical;
  } catch {
    throw new NativeProfileError("PROFILE_STORAGE_UNSAFE", `${label} is not a private canonical directory.`, 409);
  }
}

function errorCode(error: unknown): string | undefined {
  return error && typeof error === "object" && "code" in error ? String((error as { code?: unknown }).code) : undefined;
}

export class NativeProfileManager {
  readonly context: NativeProfileContext;
  private readonly keyProvider: NativeProfileKeyProvider;
  private readonly atomicWrite: AtomicWriter;
  private readonly hardenPath: (path: string) => Promise<void>;
  private readonly processProbe: () => Promise<NativeCodexProcessProbe>;
  private readonly applyTransition: TransitionApplier;
  private readonly now: () => number;
  private readonly uuid: () => string;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly lockWaitMs: number;
  private readonly onLockAcquired: () => void | Promise<void>;
  private readonly removeStageTree: (path: string) => void;
  private readonly onSwitchBoundary: (boundary: NativeProfileSwitchBoundary) => void | Promise<void>;
  private readonly readEnvelope: EnvelopeReader;
  private readonly readVault: VaultReader;
  private readonly readEnvelopeResult: EnvelopeResultReader;
  private readonly stableLockOpen: StableLockOpener;
  private readonly stableLockAssert: StableLockAsserter;
  private readonly stageStore: NativeProfileStageStore;
  private activeRootIdentity: PathIdentity | null = null;
  private activeLockFile: StableLockFile | null = null;

  constructor(options: NativeProfileManagerOptions = {}) {
    this.context = resolveNativeProfileContext(options);
    this.keyProvider = options.keyProvider ?? new OsNativeProfileKeyProvider();
    this.atomicWrite = options.atomicWrite ?? atomicWriteFileAsync;
    this.hardenPath = options.hardenPath ?? hardenNativeProfilePath;
    this.processProbe = options.processProbe ?? probeNativeCodexProcesses;
    this.applyTransition = options.applyTransition ?? ((from, to) => { applyConfirmedMainCodexAccountTransition(from, to); });
    this.now = options.now ?? Date.now;
    this.uuid = options.randomUUID ?? randomUUID;
    this.sleep = options.sleep ?? (ms => Bun.sleep(ms));
    this.lockWaitMs = options.lockWaitMs ?? LOCK_WAIT_MS;
    this.onLockAcquired = options.onLockAcquired ?? (() => {});
    this.removeStageTree = options.removeStageTree ?? (path => rmSync(path, { recursive: true, force: false }));
    this.onSwitchBoundary = options.onSwitchBoundary ?? (() => {});
    this.readEnvelope = options.readEnvelope ?? readNativeEnvelope;
    this.readVault = options.readVault ?? (() => readNativeProfileVault(this.context));
    this.readEnvelopeResult = options.readEnvelopeResult ?? readNativeEnvelopeResult;
    this.stableLockOpen = options.stableLockOpen ?? openStableLockFile;
    this.stableLockAssert = options.stableLockAssert ?? assertStableLockFile;
    this.stageStore = new NativeProfileStageStore({
      context: this.context,
      now: this.now,
      randomUUID: this.uuid,
      atomicWrite: this.atomicWrite,
      hardenPath: this.hardenPath,
      leaseMs: options.stageLeaseMs,
    });
  }

  private async ensureRoot(): Promise<PathIdentity> {
    assertNativeProfileMetadataLayout(this.context);
    if (!existsSync(this.context.rootDir)) {
      try { mkdirSync(this.context.rootDir, { mode: 0o700 }); }
      catch (error) { if (errorCode(error) !== "EEXIST") throw error; }
    }
    const identity = pathIdentity(this.context.rootDir);
    assertPathIdentity(this.context.rootDir, identity, "The native-profile metadata root");
    await this.hardenPath(this.context.rootDir);
    assertPathIdentity(this.context.rootDir, identity, "The native-profile metadata root");
    assertNativeProfileMetadataLayout(this.context);
    for (const name of readdirSync(this.context.rootDir)) {
      assertPathIdentity(this.context.rootDir, identity, "The native-profile metadata root");
      await this.hardenPath(join(this.context.rootDir, name));
      assertPathIdentity(this.context.rootDir, identity, "The native-profile metadata root");
    }
    assertNativeProfileMetadataLayout(this.context);
    assertPathIdentity(this.context.rootDir, identity, "The native-profile metadata root");
    return identity;
  }

  private isLockBusy(error: unknown): boolean {
    const code = errorCode(error);
    const message = error instanceof Error ? error.message : String(error);
    return code === "SQLITE_BUSY" || code === "SQLITE_LOCKED" || /database (?:is|table is) locked/i.test(message);
  }

  private profileLockStorageUnsafe(): NativeProfileError {
    return new NativeProfileError("PROFILE_STORAGE_UNSAFE", "The native-profile transaction lock was replaced.", 409);
  }

  private profileLockUnavailable(): NativeProfileError {
    return new NativeProfileError("PROFILE_LOCK_UNAVAILABLE", "The native-profile lock is unavailable.", 503, true);
  }

  private isExplicitProfileLockStorageUnsafe(error: unknown): boolean {
    const code = errorCode(error);
    const message = error instanceof Error ? error.message : String(error);
    return error instanceof StableLockPathUnsafeError
      || code === "ELOOP"
      || code === "EISDIR"
      || code === "ENOTDIR"
      || message.startsWith("unsafe SQLite lock path:")
      || message.startsWith("SQLite lock path identity changed:");
  }

  private openStableProfileLockFile(): StableLockFile {
    try {
      return this.stableLockOpen(this.context.lockPath);
    } catch (error) {
      if (this.isExplicitProfileLockStorageUnsafe(error)) throw this.profileLockStorageUnsafe();
      throw this.profileLockUnavailable();
    }
  }

  private assertStableProfileLockFile(file: StableLockFile): void {
    try {
      this.stableLockAssert(this.context.lockPath, file);
    } catch (error) {
      if (errorCode(error) === "ENOENT" || this.isExplicitProfileLockStorageUnsafe(error)) {
        throw this.profileLockStorageUnsafe();
      }
      throw this.profileLockUnavailable();
    }
  }

  private async withLock<T>(operation: () => Promise<T>): Promise<T> {
    assertNoLegacyNativeProfileState(this.context);
    assertNativeProfileLockPath(this.context);
    const deadline = this.now() + this.lockWaitMs;
    let database: Database | undefined;
    let lockFile: StableLockFile | undefined;
    while (!database) {
      let candidate: Database | undefined;
      let candidateFile: StableLockFile | undefined;
      try {
        candidateFile = this.openStableProfileLockFile();
        this.assertStableProfileLockFile(candidateFile);
        candidate = new Database(this.context.lockPath, { create: true });
        const claim = this.uuid();
        candidate.exec("PRAGMA busy_timeout = 0; BEGIN IMMEDIATE");
        candidate.exec("CREATE TABLE IF NOT EXISTS ocx_native_profile_lock (singleton INTEGER PRIMARY KEY CHECK (singleton = 1), claim TEXT NOT NULL)");
        candidate.query("INSERT INTO ocx_native_profile_lock (singleton, claim) VALUES (1, ?) ON CONFLICT(singleton) DO UPDATE SET claim = excluded.claim").run(claim);
        candidate.exec("COMMIT");
        candidate.exec("BEGIN IMMEDIATE");
        const candidateClaim = candidate.query("SELECT claim FROM ocx_native_profile_lock WHERE singleton = 1").get() as { claim?: unknown } | null;
        let verifier: Database | undefined;
        let pathClaim: { claim?: unknown } | null = null;
        try {
          this.assertStableProfileLockFile(candidateFile);
          verifier = new Database(this.context.lockPath, { readonly: true });
          pathClaim = verifier.query("SELECT claim FROM ocx_native_profile_lock WHERE singleton = 1").get() as { claim?: unknown } | null;
        } finally {
          try { verifier?.close(); } catch { /* mismatch below is authoritative */ }
        }
        this.assertStableProfileLockFile(candidateFile);
        if (candidateClaim?.claim !== claim || pathClaim?.claim !== claim) {
          throw new NativeProfileError("PROFILE_STORAGE_UNSAFE", "The native-profile transaction lock changed during acquisition.", 409);
        }
        try { chmodSync(this.context.lockPath, 0o600); } catch { /* Windows ACL below is authoritative there. */ }
        await this.hardenPath(this.context.lockPath);
        assertNativeProfileLockPath(this.context);
        this.assertStableProfileLockFile(candidateFile);
        database = candidate;
        candidate = undefined;
        lockFile = candidateFile;
        candidateFile = undefined;
      } catch (error) {
        let mappedError = error;
        if (!(mappedError instanceof NativeProfileError) && candidateFile) {
          try { this.assertStableProfileLockFile(candidateFile); }
          catch (storageError) { mappedError = storageError; }
        }
        try { candidate?.exec("ROLLBACK"); } catch { /* acquisition already failed */ }
        try { candidate?.close(); } catch { /* acquisition already failed */ }
        try { candidateFile?.close(); } catch { /* acquisition already failed */ }
        if (mappedError instanceof NativeProfileError) throw mappedError;
        if (!this.isLockBusy(mappedError)) {
          throw this.profileLockUnavailable();
        }
        if (this.now() >= deadline) {
          throw new NativeProfileError("NATIVE_PROFILE_BUSY", "Another native-profile operation is still running.", 503, true);
        }
        await this.sleep(50);
      }
    }
    try {
      this.activeLockFile = lockFile ?? null;
      this.activeRootIdentity = await this.ensureRoot();
      await this.onLockAcquired();
      this.assertOperationStorageStable();
      const result = await operation();
      this.assertOperationStorageStable();
      return result;
    } finally {
      try { database.exec("ROLLBACK"); } catch { /* close still releases the OS-backed lock */ }
      try { database.close(); } catch { /* transaction is already ending */ }
      try { lockFile?.close(); } catch { /* SQLite handle already released the transaction */ }
      this.activeRootIdentity = null;
      this.activeLockFile = null;
    }
  }

  private assertOperationStorageStable(): void {
    if (!this.activeRootIdentity || !this.activeLockFile) {
      throw new NativeProfileError("PROFILE_STORAGE_UNSAFE", "Native-profile storage ownership is not active.", 409);
    }
    this.assertStableProfileLockFile(this.activeLockFile);
    assertPathIdentity(this.context.rootDir, this.activeRootIdentity, "The native-profile metadata root");
    assertNativeProfileMetadataLayout(this.context);
  }

  private async assertNativeCodexStopped(confirmedStopped: boolean): Promise<void> {
    const processState = await this.processProbe();
    if (processState.status === "busy") {
      throw new NativeProfileError("CODEX_BUSY", `Close the ${processState.count} detected native Codex process(es) before switching.`, 409);
    }
    if (processState.status === "unknown" && !confirmedStopped) {
      throw new NativeProfileError("CODEX_PROCESS_CHECK_UNAVAILABLE", "Codex process state could not be confirmed; close Codex and retry with explicit confirmation.", 409);
    }
  }

  private async keyForVault(vault: NativeMainProfileVaultV1 | null): Promise<NativeProfileKey> {
    const existing = await this.keyProvider.get(this.context.homeId);
    if (existing) return existing;
    if (vault) {
      throw new NativeProfileError("KEYRING_KEY_MISSING", "The OS credential-store key for this vault is missing.", 409);
    }
    return this.keyProvider.create(this.context.homeId);
  }

  private async writeVault(vault: NativeMainProfileVaultV1): Promise<void> {
    this.assertOperationStorageStable();
    await this.atomicWrite(this.context.vaultPath, serializeNativeProfileMetadata(vault));
    this.assertOperationStorageStable();
  }

  private async writeJournal(journal: NativeProfileSwitchJournalV1): Promise<void> {
    this.assertOperationStorageStable();
    await this.atomicWrite(this.context.journalPath, serializeNativeProfileJournal(journal));
    this.assertOperationStorageStable();
  }

  private removeJournal(): void {
    this.assertOperationStorageStable();
    try { unlinkSync(this.context.journalPath); } catch (error) { if (errorCode(error) !== "ENOENT") throw error; }
  }

  private removeRecoveryBlock(): void {
    this.assertOperationStorageStable();
    try { unlinkSync(this.context.recoveryBlockPath); } catch (error) { if (errorCode(error) !== "ENOENT") throw error; }
  }

  private async currentOwnershipConfirmed(): Promise<boolean> {
    let key: NativeProfileKey | null = null;
    let current: NativeEnvelopeSnapshot | null = null;
    try {
      const vault = this.readVault();
      if (!vault) return false;
      key = await this.keyForVault(vault);
      current = this.readEnvelope(this.context.authPath);
      this.assertCurrentIdentity(vault, current, key);
      return true;
    } catch {
      return false;
    } finally {
      current?.raw.fill(0);
      key?.key.fill(0);
    }
  }

  private async clearRecoveryBlockLocked(): Promise<Record<string, unknown>> {
    if (!(await this.currentOwnershipConfirmed())) {
      throw new NativeProfileError(
        "RECOVERY_REQUIRED",
        "The quarantined recovery state remains blocked until auth.json matches the active encrypted profile.",
        409,
      );
    }
    this.removeRecoveryBlock();
    return {
      ok: true,
      recovered: true,
      action: "confirm-current-owner",
      externallyRefreshed: false,
      effectiveCodexHome: this.context.codexHome,
      restartRequired: false,
    };
  }

  private async quarantineInvalidJournalLocked(): Promise<Record<string, unknown>> {
    const quarantineFile = this.context.homeId + ".journal.quarantine-" + this.uuid() + ".json";
    const quarantinePath = join(this.context.rootDir, quarantineFile);
    this.assertOperationStorageStable();
    await this.atomicWrite(this.context.recoveryBlockPath, serializeNativeProfileMetadata({
      version: 1,
      homeId: this.context.homeId,
      reason: "malformed-journal",
      quarantineFile,
      createdAt: new Date(this.now()).toISOString(),
    }));
    this.assertOperationStorageStable();
    try {
      renameSync(this.context.journalPath, quarantinePath);
      await this.hardenPath(quarantinePath);
      this.assertOperationStorageStable();
    } catch {
      throw new NativeProfileError(
        "RECOVERY_REQUIRED",
        "The invalid recovery journal could not be quarantined; the fail-closed recovery marker remains active.",
        409,
      );
    }
    if (!(await this.currentOwnershipConfirmed())) {
      throw new NativeProfileError(
        "RECOVERY_REQUIRED",
        "The invalid recovery journal was quarantined as " + quarantineFile + ", but current credential ownership is not confirmed.",
        409,
      );
    }
    this.removeRecoveryBlock();
    return {
      ok: true,
      recovered: true,
      action: "quarantine-invalid-journal",
      quarantineFile,
      externallyRefreshed: false,
      effectiveCodexHome: this.context.codexHome,
      restartRequired: false,
    };
  }

  private assertNoPendingRecovery(): void {
    if (probeNativeProfileRecoveryState(this.context) === "none") return;
    throw new NativeProfileError(
      "RECOVERY_REQUIRED",
      "A native-profile recovery journal is pending. Run `ocx account main recover` or `ocx account main recover --rollback --yes` before registering or adding profiles.",
      409,
    );
  }

  private requireVault(): NativeMainProfileVaultV1 {
    const vault = this.readVault();
    if (!vault) throw new NativeProfileError("PROFILE_NOT_FOUND", "Register the current native login before adding or switching profiles.", 404);
    return vault;
  }

  private currentProfile(vault: NativeMainProfileVaultV1): NativeMainProfileRecordV1 {
    const profile = vault.profiles.find(item => item.id === vault.activeProfileId && item.state === "active");
    if (!profile) throw new NativeProfileError("VAULT_INVALID", "The native-profile vault has no active owner.", 409);
    return profile;
  }

  private assertCurrentIdentity(vault: NativeMainProfileVaultV1, envelope: NativeEnvelopeSnapshot, key: NativeProfileKey): NativeMainProfileRecordV1 {
    const active = this.currentProfile(vault);
    if (nativeIdentityHash(key.key, envelope.accountId) !== active.identityHash) {
      throw new NativeProfileError(
        "ACTIVE_PROFILE_MISMATCH",
        "The physical native login changed outside OpenCodex; recover or register the expected login before continuing.",
        409,
      );
    }
    return active;
  }

  async register(labelInput: string): Promise<{ effectiveCodexHome: string; profile: NativeProfilePublic }> {
    return this.withLock(async () => {
      this.assertNoPendingRecovery();
      requireFileCredentialStore(this.context);
      const label = validateNativeProfileLabel(labelInput);
      let envelope: NativeEnvelopeSnapshot | null = null;
      let key: NativeProfileKey | null = null;
      try {
        envelope = this.readEnvelope(this.context.authPath);
        let vault = this.readVault();
        key = await this.keyForVault(vault);
        const identityHash = nativeIdentityHash(key.key, envelope.accountId);
        const timestamp = new Date(this.now()).toISOString();
        if (!vault) {
          const id = this.uuid();
          assertUniqueNativeProfileLabel({ profiles: [] }, label, undefined, [id]);
          vault = {
            version: 1,
            revision: 1,
            homeId: this.context.homeId,
            activeProfileId: id,
            profiles: [{
              id,
              label,
              identityHash,
              identityHint: nativeIdentityHint(identityHash),
              state: "active",
              payload: null,
              createdAt: timestamp,
              updatedAt: timestamp,
            }],
          };
        } else {
          const active = this.assertCurrentIdentity(vault, envelope, key);
          assertUniqueNativeProfileLabel(vault, label, active.id);
          active.label = label;
          active.updatedAt = timestamp;
          vault.revision += 1;
        }
        await this.writeVault(vault);
        return { effectiveCodexHome: this.context.codexHome, profile: publicNativeProfile(this.currentProfile(vault)) };
      } finally {
        envelope?.raw.fill(0);
        key?.key.fill(0);
      }
    });
  }

  async list(): Promise<NativeProfileListResult> {
    const vault = readNativeProfileVault(this.context);
    return {
      effectiveCodexHome: this.context.codexHome,
      activeProfileId: vault?.activeProfileId ?? null,
      profiles: vault?.profiles.map(publicNativeProfile) ?? [],
    };
  }

  async doctor(): Promise<Record<string, unknown>> {
    return this.withLock(async () => {
    let stagingSweep: "ok" | "cleanup-required" | "unreadable" = "ok";
    try {
      const sweep = await this.sweepStagesLocked();
      if (sweep.cleanupFailed > 0) stagingSweep = "cleanup-required";
    } catch (error) {
      stagingSweep = error instanceof NativeProfileError && error.code === "STAGING_CLEANUP_REQUIRED"
        ? "cleanup-required"
        : "unreadable";
    }
    const mode = (() => {
      try { return resolveNativeCredentialStoreMode(this.context); } catch { return "unknown"; }
    })();
    const auth = this.readEnvelopeResult(this.context.authPath);
    try {
      let vault: NativeMainProfileVaultV1 | null = null;
      let vaultStatus: "ok" | "missing" | "invalid" = "missing";
      try {
        vault = this.readVault();
        vaultStatus = vault ? "ok" : "missing";
      } catch {
        vaultStatus = "invalid";
      }
      let keyStore: "available" | "missing-key" | "unavailable" = "available";
      try {
        const key = await this.keyProvider.get(this.context.homeId);
        if (vaultStatus !== "missing" && !key) keyStore = "missing-key";
        if (key) key.key.fill(0);
      } catch {
        keyStore = "unavailable";
      }
      let stagingCount: number | null = 0;
      try {
        stagingCount = this.stageStore.records().length;
        if (existsSync(this.context.stagingRoot)) stagingCount += Array.from(new Bun.Glob("*").scanSync({ cwd: this.context.stagingRoot, onlyFiles: false })).filter(name => !UUID_RE.test(name) || !this.stageStore.recordForStage(name)).length;
      } catch {
        stagingSweep = "unreadable";
        stagingCount = null;
      }
      return {
        effectiveCodexHome: this.context.codexHome,
        credentialStoreMode: mode,
        supported: mode === "file",
        authStatus: auth.status,
        keyStore,
        vaultStatus,
        profileCount: vaultStatus === "invalid" ? null : vault?.profiles.length ?? 0,
        activeProfileId: vault?.activeProfileId ?? null,
        recoveryPending: probeNativeProfileRecoveryState(this.context) !== "none",
        recoveryState: probeNativeProfileRecoveryState(this.context),
        stagingSweep,
        stagingCount,
      };
    } finally {
      if (auth.status === "ok") auth.envelope.raw.fill(0);
    }
    });
  }

  private stagePath(stageId: string): string {
    if (!UUID_RE.test(stageId)) throw new NativeProfileError("INVALID_REQUEST", "The staging identifier is invalid.", 400);
    return join(this.context.stagingRoot, stageId);
  }

  private assertStagingLayout(requireRoot = false): void {
    if (!existsSync(this.context.configDir)) {
      if (requireRoot) throw new NativeProfileError("STAGING_NOT_FOUND", "The native-login staging root is missing.", 404);
      return;
    }
    const configDir = assertSafeDirectory(this.context.configDir, "The OpenCodex configuration root");
    const stagingBase = dirname(this.context.stagingRoot);
    if (!samePath(stagingBase, join(configDir, "native-main-profile-staging"))) {
      throw new NativeProfileError("PROFILE_STORAGE_UNSAFE", "The native-login staging root escaped OPENCODEX_HOME.", 409);
    }
    if (!existsSync(stagingBase)) {
      if (requireRoot) throw new NativeProfileError("STAGING_NOT_FOUND", "The native-login staging root is missing.", 404);
      return;
    }
    const canonicalBase = assertSafeDirectory(stagingBase, "The native-login staging namespace");
    if (!samePath(dirname(this.context.stagingRoot), canonicalBase)) {
      throw new NativeProfileError("PROFILE_STORAGE_UNSAFE", "The native-login staging root is not contained by OPENCODEX_HOME.", 409);
    }
    if (!existsSync(this.context.stagingRoot)) {
      if (requireRoot) throw new NativeProfileError("STAGING_NOT_FOUND", "The native-login staging root is missing.", 404);
      return;
    }
    assertSafeDirectory(this.context.stagingRoot, "The native-login staging root");
  }

  private async ensureStagingRoot(): Promise<void> {
    if (!existsSync(this.context.configDir)) mkdirSync(this.context.configDir, { recursive: true, mode: 0o700 });
    this.assertStagingLayout(false);
    const stagingBase = dirname(this.context.stagingRoot);
    if (!existsSync(stagingBase)) mkdirSync(stagingBase, { mode: 0o700 });
    assertSafeDirectory(stagingBase, "The native-login staging namespace");
    await this.hardenPath(stagingBase);
    if (!existsSync(this.context.stagingRoot)) mkdirSync(this.context.stagingRoot, { mode: 0o700 });
    assertSafeDirectory(this.context.stagingRoot, "The native-login staging root");
    await this.hardenPath(this.context.stagingRoot);
    this.assertStagingLayout(true);
  }

  private deleteStage(path: string, identity?: PathIdentity): void {
    if (identity) assertPathIdentity(path, identity, "The native-login staging directory");
    const authPath = join(path, "auth.json");
    let authFd: number | undefined;
    try {
      const flags = process.platform === "win32"
        ? fsConstants.O_RDWR
        : fsConstants.O_RDWR | fsConstants.O_NOFOLLOW;
      authFd = openSync(authPath, flags);
      const opened = fstatSync(authFd, { bigint: true });
      const pathEntry = lstatSync(authPath, { bigint: true });
      if (
        !opened.isFile()
        || !pathEntry.isFile()
        || pathEntry.isSymbolicLink()
        || opened.dev !== pathEntry.dev
        || opened.ino !== pathEntry.ino
        || opened.nlink !== 1n
      ) throw new NativeProfileError(
        "STAGING_CLEANUP_REQUIRED",
        "The staged credential file is not privately owned; plaintext may remain and requires manual cleanup.",
        500,
        false,
        true,
        true,
      );
      unlinkSync(authPath);
      const unlinked = fstatSync(authFd, { bigint: true });
      if (unlinked.dev !== opened.dev || unlinked.ino !== opened.ino || unlinked.nlink !== 0n) {
        throw new NativeProfileError(
          "STAGING_CLEANUP_REQUIRED",
          "The staged credential file could not be exclusively unlinked; plaintext may remain and requires manual cleanup.",
          500,
          false,
          true,
          true,
        );
      }
      ftruncateSync(authFd, 0);
    } catch (error) {
      if (error instanceof NativeProfileError) throw error;
      if (errorCode(error) !== "ENOENT") {
        throw new NativeProfileError(
          "STAGING_CLEANUP_REQUIRED",
          "The staged credential file could not be securely scrubbed; plaintext may remain and requires manual cleanup.",
          500,
          false,
          true,
          true,
        );
      }
    } finally {
      try { if (authFd !== undefined) closeSync(authFd); } catch { /* removal below remains required */ }
    }
    if (identity) assertPathIdentity(path, identity, "The native-login staging directory");
    this.removeStageTree(path);
  }

  private deleteLegacyStageById(stageId: string, requirePresent = false): void {
    this.assertStagingLayout(true);
    const expected = resolve(this.stagePath(stageId));
    let stageStat: ReturnType<typeof lstatSync>;
    try { stageStat = lstatSync(expected); } catch (error) {
      if (errorCode(error) === "ENOENT") {
        if (requirePresent) throw new NativeProfileError("STAGING_NOT_FOUND", "The native-login staging session is missing.", 404);
        return;
      }
      throw error;
    }
    if (stageStat.isSymbolicLink() || !stageStat.isDirectory()) {
      throw new NativeProfileError(
        "PROFILE_STORAGE_UNSAFE",
        "The native-login staging path is not a private directory.",
        409,
        false,
        true,
        true,
      );
    }
    const canonicalRoot = resolve(realpathSync.native(this.context.stagingRoot));
    const canonicalExpected = resolve(realpathSync.native(expected));
    const rel = relative(canonicalRoot, canonicalExpected);
    if (!rel || rel.startsWith("..") || rel.includes(sep)) {
      throw new NativeProfileError("STAGING_CLEANUP_REQUIRED", "The staging path could not be safely removed.", 500, false, true, true);
    }
    this.deleteStage(canonicalExpected, pathIdentity(canonicalExpected));
  }

  private async cleanupRegisteredStage(
    proof: NativeStageProof,
    outcome: Exclude<NativeStageTerminalOutcome, null>,
  ): Promise<NativeStageCleanupResult> {
    let stageRemoved = false;
    let plaintextMayRemain = true;
    try {
      this.deleteStage(proof.path, proof.identity);
      stageRemoved = true;
      plaintextMayRemain = false;
    } catch (error) {
      plaintextMayRemain = error instanceof NativeProfileError
        ? error.plaintextMayRemain !== false
        : false;
    }
    if (stageRemoved) {
      try {
        await this.stageStore.remove(proof);
        return { removed: true, plaintextMayRemain: false };
      } catch {
        try { await this.stageStore.markCleanupRequired(proof, outcome); } catch { /* the cleanup result remains authoritative */ }
        return { removed: false, plaintextMayRemain: false };
      }
    }
    try { await this.stageStore.markCleanupRequired(proof, outcome); } catch { /* preserve the plaintext signal */ }
    return { removed: false, plaintextMayRemain };
  }

  private async sweepStagesLocked(): Promise<NativeStageSweepResult> {
    let removed = 0;
    let live = 0;
    let cleanupFailed = 0;
    let plaintextMayRemain = false;
    const records = this.stageStore.records();
    const registeredHere = new Set(
      records
        .filter(record => samePath(record.stagingRoot, this.context.stagingRoot))
        .map(record => record.stageId),
    );

    for (const record of records) {
      if (record.state === "open" && this.now() <= record.leaseExpiresAt) {
        live += 1;
        continue;
      }
      const outcome = record.terminalOutcome
        ?? (record.state === "creating" ? "cancelled" : "expired");
      let proof: NativeStageProof | null;
      try {
        proof = this.stageStore.proofForRecord(record, record.state === "creating");
      } catch {
        cleanupFailed += 1;
        plaintextMayRemain = true;
        try {
          await this.stageStore.markCleanupRequired({ record }, outcome);
        } catch { /* fail closed and report the unresolved plaintext boundary */ }
        continue;
      }
      if (!proof) {
        try {
          await this.stageStore.remove({ record });
          removed += 1;
        } catch {
          cleanupFailed += 1;
        }
        continue;
      }
      const cleanup = await this.cleanupRegisteredStage(proof, outcome);
      if (cleanup.removed) removed += 1;
      else cleanupFailed += 1;
      plaintextMayRemain ||= cleanup.plaintextMayRemain;
    }

    if (existsSync(this.context.stagingRoot)) {
      this.assertStagingLayout(true);
      for (const name of readdirSync(this.context.stagingRoot)) {
        if (!UUID_RE.test(name) || registeredHere.has(name)) continue;
        const path = this.stagePath(name);
        let createdAt: number;
        try {
          const entry = lstatSync(path);
          if (!entry.isDirectory() || entry.isSymbolicLink()) {
            cleanupFailed += 1;
            plaintextMayRemain = true;
            continue;
          }
          createdAt = entry.mtimeMs;
          try {
            const metadata = JSON.parse(readFileSync(join(path, "stage.json"), "utf8")) as Record<string, unknown>;
            if (typeof metadata.createdAt === "number") createdAt = metadata.createdAt;
          } catch { /* mtime bounds legacy crash residue */ }
        } catch (error) {
          if (errorCode(error) === "ENOENT") continue;
          cleanupFailed += 1;
          plaintextMayRemain = true;
          continue;
        }
        if (this.now() - createdAt <= LEGACY_STAGE_MAX_AGE_MS) {
          live += 1;
          continue;
        }
        try {
          this.deleteLegacyStageById(name);
          removed += 1;
        } catch (error) {
          cleanupFailed += 1;
          plaintextMayRemain ||= error instanceof NativeProfileError
            ? error.plaintextMayRemain !== false
            : true;
        }
      }
    }

    return { removed, live, cleanupFailed, plaintextMayRemain };
  }

  /**
   * Whether startup or the periodic cleaner has any stage state to inspect.
   *
   * Absence is the only lock-free result. Any entry or observation failure
   * keeps the existing fail-closed sweep, so an unsafe/unreadable stage path
   * can never be mistaken for an unused profile subsystem.
   */
  stageSweepRequired(): boolean {
    for (const path of [this.context.stageRegistryPath, this.context.stagingRoot]) {
      try {
        lstatSync(path);
        return true;
      } catch (error) {
        if (errorCode(error) !== "ENOENT") return true;
      }
    }
    return false;
  }

  async sweepStages(): Promise<NativeStageSweepResult> {
    return this.withLock(() => this.sweepStagesLocked());
  }

  async prepareStage(): Promise<{
    stageId: string;
    writerToken: string;
    stagingCodexHome: string;
    effectiveCodexHome: string;
    leaseExpiresAt: number;
    heartbeatIntervalMs: number;
  }> {
    return this.withLock(async () => {
      this.assertNoPendingRecovery();
      const sweep = await this.sweepStagesLocked();
      if (sweep.plaintextMayRemain) {
        throw new NativeProfileError(
          "STAGING_CLEANUP_REQUIRED",
          "An expired native-login staging session could not be securely removed.",
          500,
          true,
          true,
          true,
        );
      }
      requireFileCredentialStore(this.context);
      const vault = this.requireVault();
      let key: NativeProfileKey | null = null;
      let current: NativeEnvelopeSnapshot | null = null;
      let reservation: Awaited<ReturnType<NativeProfileStageStore["reserve"]>> | null = null;
      try {
        key = await this.keyForVault(vault);
        current = this.readEnvelope(this.context.authPath);
        this.assertCurrentIdentity(vault, current, key);
        await this.ensureStagingRoot();
        reservation = await this.stageStore.reserve(this.context.stagingRoot);
        mkdirSync(reservation.stagingCodexHome, { mode: 0o700 });
        await this.hardenPath(reservation.stagingCodexHome);
        writeFileSync(join(reservation.stagingCodexHome, "config.toml"), 'cli_auth_credentials_store = "file"\n', { mode: 0o600 });
        await this.hardenPath(join(reservation.stagingCodexHome, "config.toml"));
        writeFileSync(join(reservation.stagingCodexHome, "stage.json"), `${JSON.stringify({
          version: 2,
          stageId: reservation.stageId,
          leaseId: reservation.leaseId,
          homeId: this.context.homeId,
          createdAt: this.now(),
        }, null, 2)}\n`, { mode: 0o600 });
        await this.hardenPath(join(reservation.stagingCodexHome, "stage.json"));
        await this.stageStore.activate(reservation);
        return {
          stageId: reservation.stageId,
          writerToken: reservation.writerToken,
          stagingCodexHome: reservation.stagingCodexHome,
          effectiveCodexHome: this.context.codexHome,
          leaseExpiresAt: reservation.leaseExpiresAt,
          heartbeatIntervalMs: NATIVE_STAGE_HEARTBEAT_INTERVAL_MS,
        };
      } catch (error) {
        let plaintextMayRemain = false;
        if (reservation) {
          const record = this.stageStore.recordForStage(reservation.stageId);
          if (record) {
            try {
              const proof = this.stageStore.proofForRecord(record, true);
              if (proof) {
                const cleanup = await this.cleanupRegisteredStage(proof, "cancelled");
                plaintextMayRemain = cleanup.plaintextMayRemain;
              } else {
                await this.stageStore.remove({ record });
              }
            } catch {
              plaintextMayRemain = true;
            }
          }
        }
        if (error instanceof NativeProfileError) {
          throw new NativeProfileError(
            error.code,
            error.message,
            error.status,
            error.retryable,
            plaintextMayRemain || error.cleanupRequired === true ? true : undefined,
            plaintextMayRemain || error.plaintextMayRemain === true,
          );
        }
        if (plaintextMayRemain) {
          throw new NativeProfileError(
            "STAGING_CLEANUP_REQUIRED",
            "Native-login staging failed and plaintext may remain.",
            500,
            false,
            true,
            true,
          );
        }
        throw error;
      } finally {
        current?.raw.fill(0);
        key?.key.fill(0);
      }
    });
  }

  async heartbeatStage(stageId: string, writerToken: string): Promise<{ ok: true; leaseExpiresAt: number }> {
    return this.withLock(async () => {
      const proof = this.stageStore.verify(stageId, writerToken);
      if (proof.expired) {
        const cleanup = await this.cleanupRegisteredStage(proof, "expired");
        throw new NativeProfileError(
          "STAGING_EXPIRED",
          "The native-login staging lease expired.",
          410,
          false,
          cleanup.removed ? undefined : true,
          cleanup.plaintextMayRemain,
        );
      }
      const leaseExpiresAt = await this.stageStore.heartbeat(proof);
      return { ok: true, leaseExpiresAt };
    });
  }

  async finishStage(
    stageId: string,
    writerToken: string,
    labelInput: string,
  ): Promise<{ effectiveCodexHome: string; profile: NativeProfilePublic; plaintextMayRemain: false }> {
    return this.withLock(async () => {
      const ownedStage = this.stageStore.verify(stageId, writerToken);
      if (ownedStage.expired) {
        const cleanup = await this.cleanupRegisteredStage(ownedStage, "expired");
        throw new NativeProfileError(
          "STAGING_EXPIRED",
          "The native-login staging lease expired.",
          410,
          false,
          cleanup.removed ? undefined : true,
          cleanup.plaintextMayRemain,
        );
      }
      let target: NativeEnvelopeSnapshot | null = null;
      let current: NativeEnvelopeSnapshot | null = null;
      let key: NativeProfileKey | null = null;
      let operationFailed = false;
      let operationError: unknown;
      let importCommitted = false;
      let result: { effectiveCodexHome: string; profile: NativeProfilePublic; plaintextMayRemain: false } | undefined;
      try {
        this.assertNoPendingRecovery();
        requireFileCredentialStore(this.context);
        const label = validateNativeProfileLabel(labelInput);
        target = readNativeEnvelope(join(ownedStage.path, "auth.json"));
        assertPathIdentity(ownedStage.path, ownedStage.identity, "The native-login staging directory");
        current = readNativeEnvelope(this.context.authPath);
        const vault = this.requireVault();
        if (vault.profiles.length >= MAX_NATIVE_PROFILES) {
          throw new NativeProfileError("INVALID_REQUEST", "Native profiles are limited to 32 entries.", 400);
        }
        key = await this.keyForVault(vault);
        this.assertCurrentIdentity(vault, current, key);
        const id = this.uuid();
        assertUniqueNativeProfileLabel(vault, label, undefined, [id]);
        const identityHash = nativeIdentityHash(key.key, target.accountId);
        if (vault.profiles.some(profile => profile.identityHash === identityHash)) {
          throw new NativeProfileError("PROFILE_ALREADY_EXISTS", "That native identity is already registered.", 409);
        }
        const timestamp = new Date(this.now()).toISOString();
        const currentProfile = this.currentProfile(vault);
        const currentSourcePayload = encryptNativeEnvelope(
          this.context,
          currentProfile.id,
          currentProfile.identityHash,
          current,
          key,
        );
        const profile: NativeMainProfileRecordV1 = {
          id,
          label,
          identityHash,
          identityHint: nativeIdentityHint(identityHash),
          state: "inactive",
          payload: encryptNativeEnvelope(this.context, id, identityHash, target, key),
          createdAt: timestamp,
          updatedAt: timestamp,
        };
        const prospectiveVault = structuredClone(vault);
        prospectiveVault.profiles.push(profile);
        prospectiveVault.revision += 1;
        const currentActivePreflight = structuredClone(prospectiveVault);
        currentActivePreflight.revision = Number.MAX_SAFE_INTEGER;
        serializeNativeProfileMetadata(currentActivePreflight);
        for (const inactiveProfile of prospectiveVault.profiles.filter(item => item.state === "inactive")) {
          const activePlacement = structuredClone(prospectiveVault);
          activePlacement.revision = Number.MAX_SAFE_INTEGER;
          const nextCurrent = activePlacement.profiles.find(item => item.id === currentProfile.id)!;
          const nextActive = activePlacement.profiles.find(item => item.id === inactiveProfile.id)!;
          nextCurrent.state = "inactive";
          nextCurrent.payload = currentSourcePayload;
          nextActive.state = "active";
          nextActive.payload = null;
          activePlacement.activeProfileId = nextActive.id;
          serializeNativeProfileMetadata(activePlacement);
        }
        await this.writeVault(prospectiveVault);
        importCommitted = true;
        result = {
          effectiveCodexHome: this.context.codexHome,
          profile: publicNativeProfile(profile),
          plaintextMayRemain: false,
        };
      } catch (error) {
        operationFailed = true;
        operationError = error;
      } finally {
        target?.raw.fill(0);
        current?.raw.fill(0);
        key?.key.fill(0);
      }

      const cleanup = await this.cleanupRegisteredStage(
        ownedStage,
        importCommitted ? "imported" : "rejected",
      );
      if (operationFailed) {
        if (operationError instanceof NativeProfileError) {
          throw new NativeProfileError(
            operationError.code,
            operationError.message,
            operationError.status,
            operationError.retryable,
            cleanup.removed ? operationError.cleanupRequired : true,
            cleanup.plaintextMayRemain,
          );
        }
        throw new NativeProfileError(
          "INTERNAL_ERROR",
          cleanup.removed
            ? "The native profile import failed."
            : "The native profile import failed and its staging session could not be securely removed.",
          500,
          false,
          cleanup.removed ? undefined : true,
          cleanup.plaintextMayRemain,
        );
      }
      if (!cleanup.removed) {
        throw new NativeProfileError(
          "STAGING_CLEANUP_REQUIRED",
          importCommitted
            ? "The native profile was imported, but its staging session could not be securely removed. Do not retry the import; cancel it explicitly."
            : "The native-login staging session could not be securely removed; cancel it explicitly.",
          500,
          false,
          importCommitted ? undefined : true,
          cleanup.plaintextMayRemain,
        );
      }
      return result!;
    });
  }

  async cancelStage(stageId: string, writerToken: string): Promise<NativeStageCleanupResult> {
    return this.withLock(async () => {
      const proof = this.stageStore.verify(stageId, writerToken, true, true);
      const outcome = proof.record.terminalOutcome ?? "cancelled";
      const cleanup = await this.cleanupRegisteredStage(proof, outcome);
      if (!cleanup.removed) {
        throw new NativeProfileError(
          "STAGING_CLEANUP_REQUIRED",
          "The native-login staging session could not be securely removed.",
          500,
          true,
          true,
          cleanup.plaintextMayRemain,
        );
      }
      return cleanup;
    });
  }
  private resolveTarget(vault: NativeMainProfileVaultV1, target: string): NativeMainProfileRecordV1 {
    const selectors = new Map<string, NativeMainProfileRecordV1>();
    for (const item of vault.profiles) {
      for (const selector of [item.id, item.label]) {
        const key = nativeProfileSelectorKey(selector);
        if (selectors.has(key)) {
          throw new NativeProfileError(
            "VAULT_INVALID",
            "The native-profile vault contains an ambiguous ID or label selector.",
            409,
          );
        }
        selectors.set(key, item);
      }
    }
    const profile = selectors.get(nativeProfileSelectorKey(target));
    if (!profile) throw new NativeProfileError("PROFILE_NOT_FOUND", "The requested native profile does not exist.", 404);
    if (profile.state !== "inactive" || !profile.payload) {
      throw new NativeProfileError("INVALID_REQUEST", "The requested native profile is already active.", 400);
    }
    return profile;
  }

  private verifyWrittenEnvelope(expectedDigest: string, expectedIdentityHash: string, key: NativeProfileKey): NativeEnvelopeSnapshot {
    const observed = this.readEnvelope(this.context.authPath);
    try {
      if (observed.digest !== expectedDigest || nativeIdentityHash(key.key, observed.accountId) !== expectedIdentityHash) {
        throw new Error("auth read-back mismatch");
      }
      return observed;
    } catch (error) {
      observed.raw.fill(0);
      throw error;
    }
  }

  async switch(targetSelector: string, confirmedStopped = false): Promise<Record<string, unknown>> {
    return this.withLock(async () => {
      await this.sweepStagesLocked();
      requireFileCredentialStore(this.context);
      await this.assertNativeCodexStopped(confirmedStopped);
      if (probeNativeProfileRecoveryState(this.context) !== "none") await this.recoverLocked(false);
      const beforeVault = this.requireVault();
      let key: NativeProfileKey | null = null;
      let source: NativeEnvelopeSnapshot | null = null;
      let target: NativeEnvelopeSnapshot | null = null;
      let journalPrepared = false;
      let committed = false;
      try {
        key = await this.keyForVault(beforeVault);
        source = this.readEnvelope(this.context.authPath);
        const sourceProfile = this.assertCurrentIdentity(beforeVault, source, key);
        const targetProfile = this.resolveTarget(beforeVault, targetSelector);
        target = decryptNativeEnvelope(this.context, targetProfile.id, targetProfile.identityHash, targetProfile.payload!, key);
        if (nativeIdentityHash(key.key, target.accountId) !== targetProfile.identityHash) {
          throw new NativeProfileError("PROFILE_DECRYPT_FAILED", "The selected native profile identity does not match its encrypted record.", 409);
        }
        const timestamp = new Date(this.now()).toISOString();
        const sourcePayload = encryptNativeEnvelope(this.context, sourceProfile.id, sourceProfile.identityHash, source, key);
        const afterVault = structuredClone(beforeVault);
        const nextSource = afterVault.profiles.find(profile => profile.id === sourceProfile.id)!;
        const nextTarget = afterVault.profiles.find(profile => profile.id === targetProfile.id)!;
        nextSource.state = "inactive";
        nextSource.payload = sourcePayload;
        nextSource.updatedAt = timestamp;
        nextTarget.state = "active";
        nextTarget.payload = null;
        nextTarget.updatedAt = timestamp;
        afterVault.activeProfileId = nextTarget.id;
        afterVault.revision += 1;
        const journal: NativeProfileSwitchJournalV1 = {
          version: 1,
          transactionId: this.uuid(),
          homeId: this.context.homeId,
          phase: "prepared",
          sourceProfileId: sourceProfile.id,
          sourceIdentityHash: sourceProfile.identityHash,
          sourcePayload,
          targetProfileId: targetProfile.id,
          targetIdentityHash: targetProfile.identityHash,
          targetPayload: targetProfile.payload!,
          beforeVault: structuredClone(beforeVault),
          afterVault,
          createdAt: timestamp,
        };
        serializeNativeProfileMetadata(afterVault);
        serializeNativeProfileJournal({ ...journal, phase: "prepared" });
        serializeNativeProfileJournal({ ...journal, phase: "auth-replaced" });
        serializeNativeProfileJournal({ ...journal, phase: "vault-committed" });
        await this.writeJournal(journal);
        journalPrepared = true;
        await this.onSwitchBoundary("journal-prepared");
        this.assertOperationStorageStable();
        await this.atomicWrite(this.context.authPath, target.text);
        const observedTarget = this.verifyWrittenEnvelope(target.digest, targetProfile.identityHash, key);
        observedTarget.raw.fill(0);
        await this.onSwitchBoundary("auth-replaced");
        journal.phase = "auth-replaced";
        await this.writeJournal(journal);
        await this.writeVault(afterVault);
        committed = true;
        await this.onSwitchBoundary("vault-committed");
        journal.phase = "vault-committed";
        await this.writeJournal(journal);
        this.applyTransition(source.accountId, target.accountId);
        await this.onSwitchBoundary("runtime-transition-published");
        this.removeJournal();
        await this.onSwitchBoundary("journal-deleted");
        return {
          ok: true,
          effectiveCodexHome: this.context.codexHome,
          activeProfile: publicNativeProfile(nextTarget),
          restartRequired: true,
        };
      } catch (cause) {
        if (!journalPrepared) throw cause;
        if (committed) {
          throw new NativeProfileError("RECOVERY_REQUIRED", "The login changed, but final transaction cleanup requires recovery.", 409);
        }
        try {
          this.assertOperationStorageStable();
          await this.atomicWrite(this.context.authPath, source!.text);
          const restored = this.verifyWrittenEnvelope(source!.digest, nativeIdentityHash(key!.key, source!.accountId), key!);
          restored.raw.fill(0);
          await this.writeVault(beforeVault);
          this.removeJournal();
        } catch {
          throw new NativeProfileError(
            "AUTH_RESTORE_FAILED",
            "The original native login could not be verified after rollback; the encrypted recovery journal was retained.",
            500,
          );
        }
        throw new NativeProfileError("SWITCH_ROLLED_BACK", "The native-login switch failed and the exact original login was restored.", 409);
      } finally {
        source?.raw.fill(0);
        target?.raw.fill(0);
        key?.key.fill(0);
      }
    });
  }

  private async recoverLocked(rollback: boolean): Promise<Record<string, unknown>> {
    const inspection = inspectNativeProfileJournal(this.context);
    const recoveryState = probeNativeProfileRecoveryState(this.context);
    if (inspection.status === "invalid" || recoveryState === "unreadable") {
      throw new NativeProfileError(
        "RECOVERY_REQUIRED",
        "The native-profile recovery state is invalid and requires explicit confirmed rollback quarantine.",
        409,
      );
    }
    if (recoveryState === "manual") {
      if (inspection.status !== "missing") {
        throw new NativeProfileError("RECOVERY_REQUIRED", "Manual native-profile recovery remains pending.", 409);
      }
      return this.clearRecoveryBlockLocked();
    }
    const journal = inspection.status === "valid" ? inspection.journal : null;
    if (!journal) {
      return {
        ok: true,
        recovered: false,
        externallyRefreshed: false,
        effectiveCodexHome: this.context.codexHome,
      };
    }
    let key: NativeProfileKey | null = null;
    let current: ReturnType<typeof readNativeEnvelopeResult> | null = null;
    let sourceEnvelope: NativeEnvelopeSnapshot | null = null;
    try {
      key = await this.keyForVault(journal.beforeVault);
      current = readNativeEnvelopeResult(this.context.authPath);
      if (current.status !== "ok") {
        throw new NativeProfileError("RECOVERY_REQUIRED", "Recovery stopped because the current native login is not readable and confirmed.", 409);
      }
      const currentHash = nativeIdentityHash(key.key, current.envelope.accountId);
      if (rollback) {
        if (currentHash === journal.sourceIdentityHash) {
          await this.writeVault(journal.beforeVault);
          this.removeJournal();
          return {
            ok: true,
            recovered: true,
            action: "rollback-source",
            externallyRefreshed: current.envelope.digest !== journal.sourcePayload.envelopeSha256,
            effectiveCodexHome: this.context.codexHome,
            restartRequired: false,
          };
        }
        if (currentHash !== journal.targetIdentityHash) {
          throw new NativeProfileError("RECOVERY_REQUIRED", "Recovery found a third or unknown native identity and made no credential write.", 409);
        }
        sourceEnvelope = decryptNativeEnvelope(
          this.context,
          journal.sourceProfileId,
          journal.sourceIdentityHash,
          journal.sourcePayload,
          key,
        );
        let rollbackVault = journal.beforeVault;
        const externallyRefreshed = current.envelope.digest !== journal.targetPayload.envelopeSha256;
        let rollbackVaultPublished = false;
        if (current.envelope.digest !== journal.targetPayload.envelopeSha256) {
          rollbackVault = structuredClone(journal.beforeVault);
          const targetProfile = rollbackVault.profiles.find(profile =>
            profile.id === journal.targetProfileId
            && profile.identityHash === journal.targetIdentityHash
            && profile.state === "inactive"
          );
          if (!targetProfile) {
            throw new NativeProfileError(
              "VAULT_INVALID",
              "Recovery could not preserve the refreshed target login in its inactive profile and made no credential write.",
              409,
            );
          }
          const refreshedTargetPayload = encryptNativeEnvelope(
            this.context,
            targetProfile.id,
            targetProfile.identityHash,
            current.envelope,
            key,
          );
          targetProfile.payload = refreshedTargetPayload;
          targetProfile.updatedAt = new Date(this.now()).toISOString();
          rollbackVault.revision += 1;
          const preservedJournal = structuredClone(journal);
          preservedJournal.targetPayload = refreshedTargetPayload;
          preservedJournal.beforeVault = structuredClone(rollbackVault);
          await this.writeJournal(preservedJournal);
          await this.writeVault(rollbackVault);
          rollbackVaultPublished = true;
        }
        this.assertOperationStorageStable();
        await this.atomicWrite(this.context.authPath, sourceEnvelope.text);
        const restored = this.verifyWrittenEnvelope(sourceEnvelope.digest, journal.sourceIdentityHash, key);
        restored.raw.fill(0);
        if (!rollbackVaultPublished) await this.writeVault(rollbackVault);
        this.applyTransition(current.envelope.accountId, sourceEnvelope.accountId);
        this.removeJournal();
        return {
          ok: true,
          recovered: true,
          action: "rollback-source",
          externallyRefreshed,
          effectiveCodexHome: this.context.codexHome,
          restartRequired: true,
        };
      }
      const observation = currentHash === journal.sourceIdentityHash
        ? { identity: "source" as const, digest: current.envelope.digest === journal.sourcePayload.envelopeSha256 ? "exact" as const : "changed" as const }
        : currentHash === journal.targetIdentityHash
          ? { identity: "target" as const, digest: current.envelope.digest === journal.targetPayload.envelopeSha256 ? "exact" as const : "changed" as const }
          : { identity: "other" as const, digest: "unknown" as const };
      const decision = decideNativeProfileRecovery(journal.phase, observation);
      if (decision.action === "manual-recovery") {
        throw new NativeProfileError("RECOVERY_REQUIRED", "Recovery found a third or unknown native identity and made no credential write.", 409);
      }
      if (decision.action === "rollback-source") {
        await this.writeVault(journal.beforeVault);
        this.removeJournal();
        return {
          ok: true,
          recovered: true,
          action: decision.action,
          externallyRefreshed: decision.externallyRefreshed,
          effectiveCodexHome: this.context.codexHome,
          restartRequired: false,
        };
      }
      sourceEnvelope = decryptNativeEnvelope(
        this.context,
        journal.sourceProfileId,
        journal.sourceIdentityHash,
        journal.sourcePayload,
        key,
      );
      await this.writeVault(journal.afterVault);
      this.applyTransition(sourceEnvelope.accountId, current.envelope.accountId);
      this.removeJournal();
      return {
        ok: true,
        recovered: true,
        action: decision.action,
        externallyRefreshed: decision.externallyRefreshed,
        effectiveCodexHome: this.context.codexHome,
        restartRequired: true,
      };
    } finally {
      if (current?.status === "ok") current.envelope.raw.fill(0);
      sourceEnvelope?.raw.fill(0);
      key?.key.fill(0);
    }
  }

  async recover(rollback = false, confirmedStopped = false): Promise<Record<string, unknown>> {
    return this.withLock(async () => {
      requireFileCredentialStore(this.context);
      const inspection = inspectNativeProfileJournal(this.context);
      if (inspection.status === "invalid") {
        if (!rollback) {
          throw new NativeProfileError(
            "RECOVERY_REQUIRED",
            "The invalid native-profile recovery journal requires recover --rollback --yes.",
            409,
          );
        }
        await this.assertNativeCodexStopped(confirmedStopped);
        return this.quarantineInvalidJournalLocked();
      }
      if (rollback && inspection.status === "valid") {
        await this.assertNativeCodexStopped(confirmedStopped);
      }
      return this.recoverLocked(rollback);
    });
  }
}
