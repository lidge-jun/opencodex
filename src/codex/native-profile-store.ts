import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import {
  closeSync,
  constants as fsConstants,
  existsSync,
  fstatSync,
  lstatSync,
  openSync,
  readdirSync,
  readSync,
  realpathSync,
  statSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { getConfigDir } from "../config";
import { extractAccountId } from "../oauth/chatgpt";
import { getCodexHome, readRootTomlString } from "./paths";
import {
  NativeProfileError,
  NATIVE_PROFILE_JOURNAL_PHASES,
  type EncryptedNativeEnvelopeV1,
  type NativeMainProfileRecordV1,
  type NativeMainProfileVaultV1,
  type NativeProfileKey,
  type NativeProfileKeyProvider,
  type NativeProfilePublic,
  type NativeProfileSwitchJournalV1,
} from "./native-profile-types";

const DOMAIN_HOME = "opencodex-native-profile-home-v1\0";
const DOMAIN_INSTANCE = "opencodex-native-profile-instance-v1\0";
const DOMAIN_IDENTITY = "opencodex-native-profile-identity-v1\0";
const KEYRING_SERVICE = "opencodex.native-main-profile.v1";
const SHARED_METADATA_DIR = ".opencodex-native-main-profiles";
const INSTANCE_STAGING_DIR = "native-main-profile-staging";
const LEGACY_METADATA_DIR = "native-main-profiles";
const MAX_AUTH_BYTES = 4 * 1024 * 1024;
export const MAX_NATIVE_PROFILE_METADATA_BYTES = 4 * 1024 * 1024;
export const MAX_NATIVE_PROFILE_JOURNAL_BYTES = 17 * 1024 * 1024;
export const MAX_NATIVE_PROFILES = 32;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HASH_RE = /^[0-9a-f]{64}$/;
const BOUNDED_READ_TEST_SEAM = Symbol.for("opencodex.native-profile-store.bounded-read-test-seam");

export interface NativeProfileContext {
  codexHome: string;
  configDir: string;
  instanceId: string;
  legacyHomeId: string | null;
  rootDir: string;
  stagingRoot: string;
  legacyRootDir: string;
  homeId: string;
  authPath: string;
  vaultPath: string;
  journalPath: string;
  recoveryBlockPath: string;
  stageRegistryPath: string;
  lockPath: string;
}

interface BoundedReadTestSeam {
  beforeOpen?: (path: string) => void;
  afterValidatedOpen?: (path: string, fd: number) => void;
  onBufferAllocated?: (byteLength: number) => void;
  onRead?: (requestedBytes: number, bytesRead: number, totalBytesRead: number) => void;
}

function boundedReadTestSeam(context: NativeProfileContext): BoundedReadTestSeam | undefined {
  return (context as NativeProfileContext & { [BOUNDED_READ_TEST_SEAM]?: BoundedReadTestSeam })[BOUNDED_READ_TEST_SEAM];
}

export interface NativeEnvelopeSnapshot {
  raw: Buffer;
  text: string;
  digest: string;
  accountId: string;
}

export type NativeEnvelopeReadResult =
  | { status: "ok"; envelope: NativeEnvelopeSnapshot }
  | { status: "missing" | "invalid" | "unreadable" };

type NativeKeyringSecret = string | Uint8Array | null;
type NativeKeyringEntry = {
  getSecret(signal: AbortSignal): Promise<NativeKeyringSecret>;
  setSecret(secret: Uint8Array, signal: AbortSignal): Promise<void>;
};

function wipeKeyringSecret(value: NativeKeyringSecret | undefined): void {
  if (!value || typeof value === "string") return;
  try { value.fill(0); } catch { /* cleanup must not replace the primary keyring error */ }
}

export class OsNativeProfileKeyProvider implements NativeProfileKeyProvider {
  private readonly entryFactory: (homeId: string) => Promise<NativeKeyringEntry>;
  private readonly onSecretBufferCreated?: (buffer: Buffer) => void;

  constructor(options: {
    /** Test-only seam for deterministic keyring cleanup coverage. */
    entryFactory?: (homeId: string) => Promise<NativeKeyringEntry>;
    /** Test-only seam for observing internal secret-buffer ownership. */
    onSecretBufferCreated?: (buffer: Buffer) => void;
  } = {}) {
    this.entryFactory = options.entryFactory ?? (homeId => this.entry(homeId));
    this.onSecretBufferCreated = options.onSecretBufferCreated;
  }

  private trackSecretBuffer(buffer: Buffer): Buffer {
    this.onSecretBufferCreated?.(buffer);
    return buffer;
  }

  private async entry(homeId: string): Promise<NativeKeyringEntry> {
    try {
      const { AsyncEntry } = await import("@napi-rs/keyring");
      return new AsyncEntry(KEYRING_SERVICE, homeId) as unknown as NativeKeyringEntry;
    } catch {
      throw new NativeProfileError(
        "KEYRING_UNAVAILABLE",
        "The native OS credential store is unavailable; no plaintext fallback is permitted.",
        503,
        true,
      );
    }
  }

  async get(homeId: string): Promise<NativeProfileKey | null> {
    let secret: NativeKeyringSecret | undefined;
    let key: Buffer | null = null;
    try {
      secret = await (await this.entryFactory(homeId)).getSecret(AbortSignal.timeout(8_000));
      if (!secret) return null;
      key = this.trackSecretBuffer(Buffer.from(secret));
      if (key.byteLength !== 32) {
        throw new NativeProfileError("KEYRING_UNAVAILABLE", "The OS credential-store key is invalid.", 503);
      }
      return { keyRef: `${KEYRING_SERVICE}:${homeId}`, key };
    } catch (error) {
      if (key) wipeKeyringSecret(key);
      if (error instanceof NativeProfileError) throw error;
      throw new NativeProfileError(
        "KEYRING_UNAVAILABLE",
        "The native OS credential store could not be read.",
        503,
        true,
      );
    } finally {
      wipeKeyringSecret(secret);
    }
  }

  async create(homeId: string): Promise<NativeProfileKey> {
    const existing = await this.get(homeId);
    if (existing) return existing;
    const key = this.trackSecretBuffer(randomBytes(32));
    let stored: NativeKeyringSecret | undefined;
    let verified: Buffer | null = null;
    try {
      const entry = await this.entryFactory(homeId);
      await entry.setSecret(key, AbortSignal.timeout(8_000));
      stored = await entry.getSecret(AbortSignal.timeout(8_000));
      verified = stored ? this.trackSecretBuffer(Buffer.from(stored)) : null;
      if (!verified || verified.byteLength !== key.byteLength || !timingSafeEqual(verified, key)) {
        throw new NativeProfileError("KEYRING_UNAVAILABLE", "The OS credential-store key could not be verified.", 503);
      }
      return { keyRef: `${KEYRING_SERVICE}:${homeId}`, key: this.trackSecretBuffer(Buffer.from(key)) };
    } catch (error) {
      wipeKeyringSecret(verified);
      if (error instanceof NativeProfileError) throw error;
      throw new NativeProfileError(
        "KEYRING_UNAVAILABLE",
        "The native OS credential store could not save the profile key.",
        503,
        true,
      );
    } finally {
      wipeKeyringSecret(stored);
      wipeKeyringSecret(verified ?? undefined);
      wipeKeyringSecret(key);
    }
  }
}

function canonicalExistingDirectory(path: string, label: string): string {
  const absolute = resolve(path);
  try {
    if (!statSync(absolute).isDirectory()) throw new Error("not a directory");
    return realpathSync.native(absolute);
  } catch {
    throw new NativeProfileError("CODEX_HOME_UNAVAILABLE", `${label} is not an accessible directory.`, 409);
  }
}

function normalizedPath(path: string): string {
  return resolve(path);
}

function canonicalizeDirectoryPath(path: string): string {
  const unresolved: string[] = [];
  let cursor = resolve(path);
  for (;;) {
    try {
      if (!statSync(cursor).isDirectory()) throw new Error("not a directory");
      return join(realpathSync.native(cursor), ...unresolved.reverse());
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw new NativeProfileError("PROFILE_STORAGE_UNSAFE", "The OpenCodex configuration root is not safely accessible.", 409);
      }
      const parent = dirname(cursor);
      if (parent === cursor) {
        throw new NativeProfileError("PROFILE_STORAGE_UNSAFE", "The OpenCodex configuration root is not safely accessible.", 409);
      }
      unresolved.push(basename(cursor));
      cursor = parent;
    }
  }
}

/** Bind keyring and encrypted AAD identity to the case-preserving canonical path. */
export function nativeProfileHomeId(canonicalCodexHome: string): string {
  return createHash("sha256").update(DOMAIN_HOME).update(canonicalCodexHome).digest("hex");
}

export function legacyWindowsNativeProfileHomeId(canonicalCodexHome: string): string {
  return createHash("sha256").update(DOMAIN_HOME).update(canonicalCodexHome.toLowerCase()).digest("hex");
}

function samePath(left: string, right: string): boolean {
  return normalizedPath(left) === normalizedPath(right);
}

function storageUnsafe(message: string): never {
  throw new NativeProfileError("PROFILE_STORAGE_UNSAFE", message, 409);
}

function assertCanonicalDirectory(path: string, label: string): string {
  try {
    const entry = lstatSync(path);
    if (!entry.isDirectory() || entry.isSymbolicLink()) storageUnsafe(`${label} is not a private directory.`);
    const canonical = realpathSync.native(path);
    if (!samePath(canonical, path)) storageUnsafe(`${label} contains a link or reparse-point substitution.`);
    return canonical;
  } catch (error) {
    if (error instanceof NativeProfileError) throw error;
    storageUnsafe(`${label} is not safely accessible.`);
  }
}

function assertCanonicalFile(path: string, parent: string, label: string): void {
  try {
    const entry = lstatSync(path);
    if (!entry.isFile() || entry.isSymbolicLink()) storageUnsafe(`${label} is not a private regular file.`);
    const canonical = realpathSync.native(path);
    if (!samePath(canonical, path) || !samePath(dirname(canonical), parent)) {
      storageUnsafe(`${label} escaped its private metadata root.`);
    }
  } catch (error) {
    if (error instanceof NativeProfileError) throw error;
    storageUnsafe(`${label} is not safely accessible.`);
  }
}

function pathExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    storageUnsafe("Native-profile storage could not be inspected safely.");
  }
}

function rootHasNativeProfileState(root: string, homeIds: readonly string[], includeStaging: boolean): boolean {
  if (!pathExists(root)) return false;
  let names: string[];
  try {
    const entry = lstatSync(root);
    if (!entry.isDirectory() || entry.isSymbolicLink()) return true;
    const canonical = realpathSync.native(root);
    if (!samePath(canonical, root)) return true;
    names = readdirSync(root);
  } catch {
    return true;
  }
  for (const homeId of homeIds) {
    const exact = new Set([
      `${homeId}.vault.json`,
      `${homeId}.journal.json`,
      `${homeId}.recovery-block.json`,
    ]);
    if (names.some(name => exact.has(name) || name.startsWith(`${homeId}.journal.quarantine-`))) return true;
    if (includeStaging && pathExists(join(root, "staging", homeId))) return true;
  }
  return false;
}

function hasLegacyNativeProfileState(context: NativeProfileContext): boolean {
  const oldIds = context.legacyHomeId && context.legacyHomeId !== context.homeId
    ? [context.homeId, context.legacyHomeId]
    : [context.homeId];
  if (rootHasNativeProfileState(context.legacyRootDir, oldIds, true)) return true;
  return context.legacyHomeId !== null
    && context.legacyHomeId !== context.homeId
    && rootHasNativeProfileState(context.rootDir, [context.legacyHomeId], false);
}

export function assertNoLegacyNativeProfileState(context: NativeProfileContext): void {
  if (!hasLegacyNativeProfileState(context)) return;
  throw new NativeProfileError(
    "LEGACY_PROFILE_STATE",
    "Legacy native-profile state exists under OPENCODEX_HOME. Stop every OpenCodex proxy sharing this CODEX_HOME, then migrate or reset the preview state as documented.",
    409,
  );
}

/**
 * Validate the one authoritative metadata root without following links. On Windows,
 * Node reports symlinks and junctions through lstat; the realpath equality check also
 * rejects other path-resolving reparse-point substitutions.
 */
export function assertNativeProfileMetadataLayout(context: NativeProfileContext): void {
  assertNoLegacyNativeProfileState(context);
  const canonicalHome = assertCanonicalDirectory(context.codexHome, "The effective CODEX_HOME");
  const expectedRoot = join(canonicalHome, SHARED_METADATA_DIR);
  if (!samePath(context.rootDir, expectedRoot)) storageUnsafe("The native-profile metadata root is not owned by CODEX_HOME.");
  if (!pathExists(context.rootDir)) return;
  const canonicalRoot = assertCanonicalDirectory(context.rootDir, "The native-profile metadata root");
  let names: string[];
  try {
    names = readdirSync(canonicalRoot);
  } catch {
    storageUnsafe("The native-profile metadata root is not safely readable.");
  }
  for (const name of names) {
    assertCanonicalFile(join(canonicalRoot, name), canonicalRoot, "A native-profile metadata entry");
  }
}

export function assertNativeProfileLockPath(context: NativeProfileContext): void {
  const canonicalHome = assertCanonicalDirectory(context.codexHome, "The effective CODEX_HOME");
  const expected = join(canonicalHome, ".opencodex-native-profile.lock.sqlite");
  if (!samePath(context.lockPath, expected)) storageUnsafe("The native-profile transaction lock is outside CODEX_HOME.");
  if (pathExists(context.lockPath)) assertCanonicalFile(context.lockPath, canonicalHome, "The native-profile transaction lock");
}

export function resolveNativeProfileContext(options: { codexHome?: string; configDir?: string } = {}): NativeProfileContext {
  const codexHome = canonicalExistingDirectory(options.codexHome ?? getCodexHome(), "The effective CODEX_HOME");
  const configDir = canonicalizeDirectoryPath(options.configDir ?? getConfigDir());
  const homeId = nativeProfileHomeId(codexHome);
  const foldedHomeId = process.platform === "win32" ? legacyWindowsNativeProfileHomeId(codexHome) : homeId;
  const instanceId = createHash("sha256").update(DOMAIN_INSTANCE).update(configDir).digest("hex");
  const rootDir = join(codexHome, SHARED_METADATA_DIR);
  return {
    codexHome,
    configDir,
    instanceId,
    legacyHomeId: foldedHomeId === homeId ? null : foldedHomeId,
    rootDir,
    stagingRoot: join(configDir, INSTANCE_STAGING_DIR, homeId),
    legacyRootDir: join(configDir, LEGACY_METADATA_DIR),
    homeId,
    authPath: join(codexHome, "auth.json"),
    vaultPath: join(rootDir, `${homeId}.vault.json`),
    journalPath: join(rootDir, `${homeId}.journal.json`),
    recoveryBlockPath: join(rootDir, `${homeId}.recovery-block.json`),
    stageRegistryPath: join(rootDir, `${homeId}.stages.json`),
    lockPath: join(codexHome, ".opencodex-native-profile.lock.sqlite"),
  };
}

function readBounded(path: string, limit: number, testSeam?: BoundedReadTestSeam): Buffer {
  let fd: number | undefined;
  let failed = false;
  try {
    testSeam?.beforeOpen?.(path);
    const flags = process.platform === "win32"
      ? fsConstants.O_RDONLY
      : fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK;
    fd = openSync(path, flags);
    const opened = fstatSync(fd, { bigint: true });
    if (!opened.isFile() || opened.size > BigInt(limit)) throw new Error("invalid bounded file");

    if (process.platform === "win32") {
      const pathEntry = lstatSync(path, { bigint: true });
      if (
        !pathEntry.isFile()
        || pathEntry.isSymbolicLink()
        || pathEntry.dev !== opened.dev
        || pathEntry.ino !== opened.ino
      ) throw new Error("invalid bounded file");
    }

    testSeam?.afterValidatedOpen?.(path, fd);
    const buffer = Buffer.allocUnsafe(limit + 1);
    testSeam?.onBufferAllocated?.(buffer.byteLength);
    let totalBytesRead = 0;
    while (totalBytesRead < buffer.byteLength) {
      const requestedBytes = buffer.byteLength - totalBytesRead;
      const bytesRead = readSync(fd, buffer, totalBytesRead, requestedBytes, totalBytesRead);
      totalBytesRead += bytesRead;
      testSeam?.onRead?.(requestedBytes, bytesRead, totalBytesRead);
      if (bytesRead === 0) break;
    }
    if (totalBytesRead > limit) throw new Error("invalid bounded file");
    return buffer.subarray(0, totalBytesRead);
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch (error) {
        if (!failed) throw error;
      }
    }
  }
}

export function resolveNativeCredentialStoreMode(context: NativeProfileContext): string {
  const path = join(context.codexHome, "config.toml");
  let content: string;
  try {
    content = readBounded(path, 1024 * 1024).toString("utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "file";
    throw new NativeProfileError("UNSUPPORTED_AUTH_STORE", "The Codex credential-store configuration is unreadable.", 409);
  }
  const mode = readRootTomlString(content, "cli_auth_credentials_store");
  if (mode === null && /^\s*cli_auth_credentials_store\s*=/m.test(content)) {
    throw new NativeProfileError("UNSUPPORTED_AUTH_STORE", "The Codex credential-store mode is invalid.", 409);
  }
  return mode ?? "file";
}

export function requireFileCredentialStore(context: NativeProfileContext): void {
  const mode = resolveNativeCredentialStoreMode(context);
  if (mode !== "file") {
    throw new NativeProfileError(
      "UNSUPPORTED_AUTH_STORE",
      `Native profile switching supports Codex credential-store mode "file" only; current mode is "${mode}".`,
      409,
    );
  }
}

export function parseNativeEnvelopeBytes(raw: Buffer): NativeEnvelopeSnapshot {
  if (raw.byteLength === 0 || raw.byteLength > MAX_AUTH_BYTES) {
    throw new NativeProfileError("AUTH_INVALID", "The native Codex credential envelope is invalid.", 409);
  }
  const text = raw.toString("utf8");
  if (!Buffer.from(text, "utf8").equals(raw)) {
    throw new NativeProfileError("AUTH_INVALID", "The native Codex credential envelope is not valid UTF-8.", 409);
  }
  try {
    const parsed = JSON.parse(text.replace(/^\uFEFF/, "")) as {
      auth_mode?: unknown;
      tokens?: {
        id_token?: unknown;
        access_token?: unknown;
        refresh_token?: unknown;
        account_id?: unknown;
      };
    };
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("root");
    if (parsed.auth_mode !== undefined && parsed.auth_mode !== "chatgpt") throw new Error("mode");
    const tokens = parsed.tokens;
    if (
      !tokens
      || typeof tokens.id_token !== "string" || tokens.id_token.length === 0
      || typeof tokens.access_token !== "string" || tokens.access_token.length === 0
      || typeof tokens.refresh_token !== "string" || tokens.refresh_token.length === 0
    ) throw new Error("tokens");
    const derived = extractAccountId(tokens.id_token, tokens.access_token);
    const explicit = typeof tokens.account_id === "string" && tokens.account_id.trim() ? tokens.account_id.trim() : null;
    if (derived && explicit && derived !== explicit) throw new Error("identity mismatch");
    const accountId = derived ?? explicit;
    if (!accountId) throw new Error("identity");
    return {
      raw,
      text,
      accountId,
      digest: createHash("sha256").update(raw).digest("hex"),
    };
  } catch (error) {
    if (error instanceof NativeProfileError) throw error;
    throw new NativeProfileError("AUTH_INVALID", "The native Codex credential envelope is invalid.", 409);
  }
}

export function readNativeEnvelopeResult(path: string): NativeEnvelopeReadResult {
  let raw: Buffer;
  try {
    raw = readBounded(path, MAX_AUTH_BYTES);
  } catch (error) {
    return { status: (error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "unreadable" };
  }
  try {
    return { status: "ok", envelope: parseNativeEnvelopeBytes(raw) };
  } catch {
    raw.fill(0);
    return { status: "invalid" };
  }
}

export function readNativeEnvelope(path: string): NativeEnvelopeSnapshot {
  const result = readNativeEnvelopeResult(path);
  if (result.status === "ok") return result.envelope;
  const code = result.status === "missing" ? "AUTH_MISSING" : result.status === "invalid" ? "AUTH_INVALID" : "AUTH_UNREADABLE";
  throw new NativeProfileError(code, `The native Codex credential envelope is ${result.status}.`, 409);
}

export function nativeIdentityHash(key: Uint8Array, accountId: string): string {
  return createHmac("sha256", key).update(DOMAIN_IDENTITY).update(accountId).digest("hex");
}

export function nativeIdentityHint(identityHash: string): string {
  return `account-${identityHash.slice(0, 8)}`;
}

function aad(context: NativeProfileContext, profileId: string, identityHash: string, digest: string): Buffer {
  return Buffer.from(JSON.stringify([1, context.homeId, profileId, identityHash, digest]), "utf8");
}

export function encryptNativeEnvelope(
  context: NativeProfileContext,
  profileId: string,
  identityHash: string,
  envelope: NativeEnvelopeSnapshot,
  key: NativeProfileKey,
): EncryptedNativeEnvelopeV1 {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key.key, nonce);
  cipher.setAAD(aad(context, profileId, identityHash, envelope.digest));
  const ciphertext = Buffer.concat([cipher.update(envelope.raw), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    cipher: "aes-256-gcm",
    keyRef: key.keyRef,
    nonce: nonce.toString("base64"),
    ciphertext: ciphertext.toString("base64"),
    tag: tag.toString("base64"),
    envelopeSha256: envelope.digest,
  };
}

export function decryptNativeEnvelope(
  context: NativeProfileContext,
  profileId: string,
  identityHash: string,
  payload: EncryptedNativeEnvelopeV1,
  key: NativeProfileKey,
): NativeEnvelopeSnapshot {
  let raw: Buffer | null = null;
  try {
    if (payload.keyRef !== key.keyRef || payload.cipher !== "aes-256-gcm") throw new Error("key");
    const decipher = createDecipheriv("aes-256-gcm", key.key, Buffer.from(payload.nonce, "base64"));
    decipher.setAAD(aad(context, profileId, identityHash, payload.envelopeSha256));
    decipher.setAuthTag(Buffer.from(payload.tag, "base64"));
    raw = Buffer.concat([decipher.update(Buffer.from(payload.ciphertext, "base64")), decipher.final()]);
    const parsed = parseNativeEnvelopeBytes(raw);
    if (parsed.digest !== payload.envelopeSha256) throw new Error("digest");
    return parsed;
  } catch {
    raw?.fill(0);
    throw new NativeProfileError("PROFILE_DECRYPT_FAILED", "The selected native profile could not be decrypted or verified.", 409);
  }
}

function isEncryptedPayload(value: unknown): value is EncryptedNativeEnvelopeV1 {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return v.cipher === "aes-256-gcm"
    && typeof v.keyRef === "string" && v.keyRef.length > 0
    && typeof v.nonce === "string" && v.nonce.length > 0
    && typeof v.ciphertext === "string" && v.ciphertext.length > 0
    && typeof v.tag === "string" && v.tag.length > 0
    && typeof v.envelopeSha256 === "string" && HASH_RE.test(v.envelopeSha256);
}

function parseVaultObject(value: unknown, homeId: string): NativeMainProfileVaultV1 {
  if (!value || typeof value !== "object") throw new Error("root");
  const vault = value as NativeMainProfileVaultV1;
  if (vault.version !== 1 || vault.homeId !== homeId || !Number.isSafeInteger(vault.revision) || vault.revision < 0) throw new Error("header");
  if (!Array.isArray(vault.profiles) || vault.profiles.length > MAX_NATIVE_PROFILES) throw new Error("profiles");
  if (vault.activeProfileId !== null && (typeof vault.activeProfileId !== "string" || !UUID_RE.test(vault.activeProfileId))) throw new Error("active");
  const ids = new Set<string>();
  const labels = new Set<string>();
  const identities = new Set<string>();
  let activeCount = 0;
  for (const profile of vault.profiles) {
    if (!profile || typeof profile !== "object" || !UUID_RE.test(profile.id)) throw new Error("id");
    const normalizedId = nativeProfileSelectorKey(profile.id);
    if (ids.has(normalizedId) || labels.has(normalizedId)) throw new Error("id selector");
    const label = normalizedNativeProfileLabel(profile.label);
    if (!label) throw new Error("label");
    profile.label = label;
    const normalizedLabel = nativeProfileSelectorKey(label);
    if (labels.has(normalizedLabel) || ids.has(normalizedLabel)) throw new Error("label selector");
    if (!HASH_RE.test(profile.identityHash) || identities.has(profile.identityHash)) throw new Error("identity");
    if (profile.identityHint !== nativeIdentityHint(profile.identityHash)) throw new Error("hint");
    if (profile.state === "active") {
      activeCount += 1;
      if (profile.payload !== null || profile.id !== vault.activeProfileId) throw new Error("active payload");
    } else if (profile.state === "inactive") {
      if (!isEncryptedPayload(profile.payload)) throw new Error("inactive payload");
    } else throw new Error("state");
    ids.add(normalizedId);
    labels.add(normalizedLabel);
    identities.add(profile.identityHash);
  }
  if ((vault.profiles.length === 0 && vault.activeProfileId !== null) || (vault.profiles.length > 0 && activeCount !== 1)) throw new Error("active count");
  return vault;
}

function encryptedPayloadsMatch(
  left: EncryptedNativeEnvelopeV1 | null,
  right: EncryptedNativeEnvelopeV1 | null,
): boolean {
  if (left === null || right === null) return left === right;
  return left.cipher === right.cipher
    && left.keyRef === right.keyRef
    && left.nonce === right.nonce
    && left.ciphertext === right.ciphertext
    && left.tag === right.tag
    && left.envelopeSha256 === right.envelopeSha256;
}

function profileMetadataMatches(
  before: NativeMainProfileRecordV1,
  after: NativeMainProfileRecordV1,
): boolean {
  return before.id === after.id
    && before.label === after.label
    && before.identityHash === after.identityHash
    && before.identityHint === after.identityHint
    && before.createdAt === after.createdAt;
}

function profileRecordsMatch(
  before: NativeMainProfileRecordV1,
  after: NativeMainProfileRecordV1,
): boolean {
  return profileMetadataMatches(before, after)
    && before.state === after.state
    && before.updatedAt === after.updatedAt
    && encryptedPayloadsMatch(before.payload, after.payload);
}

function hasValidJournalSwitchInvariant(journal: NativeProfileSwitchJournalV1): boolean {
  if (
    journal.sourceProfileId === journal.targetProfileId
    || journal.sourceIdentityHash === journal.targetIdentityHash
    || journal.beforeVault.activeProfileId !== journal.sourceProfileId
    || journal.afterVault.activeProfileId !== journal.targetProfileId
    || journal.beforeVault.profiles.length !== journal.afterVault.profiles.length
    || (
      journal.afterVault.revision !== journal.beforeVault.revision + 1
      && journal.afterVault.revision !== journal.beforeVault.revision
    )
  ) return false;

  const beforeProfiles = new Map(journal.beforeVault.profiles.map(profile => [profile.id, profile]));
  const afterProfiles = new Map(journal.afterVault.profiles.map(profile => [profile.id, profile]));
  const beforeSource = beforeProfiles.get(journal.sourceProfileId);
  const beforeTarget = beforeProfiles.get(journal.targetProfileId);
  const afterSource = afterProfiles.get(journal.sourceProfileId);
  const afterTarget = afterProfiles.get(journal.targetProfileId);

  if (
    !beforeSource || !beforeTarget || !afterSource || !afterTarget
    || beforeSource.identityHash !== journal.sourceIdentityHash
    || afterSource.identityHash !== journal.sourceIdentityHash
    || beforeTarget.identityHash !== journal.targetIdentityHash
    || afterTarget.identityHash !== journal.targetIdentityHash
    || beforeSource.state !== "active" || beforeSource.payload !== null
    || beforeTarget.state !== "inactive" || !encryptedPayloadsMatch(beforeTarget.payload, journal.targetPayload)
    || afterSource.state !== "inactive" || !encryptedPayloadsMatch(afterSource.payload, journal.sourcePayload)
    || afterTarget.state !== "active" || afterTarget.payload !== null
    || !profileMetadataMatches(beforeSource, afterSource)
    || !profileMetadataMatches(beforeTarget, afterTarget)
    || afterSource.updatedAt !== afterTarget.updatedAt
  ) return false;

  for (const beforeProfile of journal.beforeVault.profiles) {
    const afterProfile = afterProfiles.get(beforeProfile.id);
    if (!afterProfile) return false;
    if (beforeProfile.id !== journal.sourceProfileId
      && beforeProfile.id !== journal.targetProfileId
      && !profileRecordsMatch(beforeProfile, afterProfile)) return false;
  }
  return true;
}

export function readNativeProfileVault(context: NativeProfileContext): NativeMainProfileVaultV1 | null {
  assertNativeProfileMetadataLayout(context);
  let raw: Buffer;
  try {
    raw = readBounded(context.vaultPath, MAX_NATIVE_PROFILE_METADATA_BYTES, boundedReadTestSeam(context));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new NativeProfileError("VAULT_INVALID", "The encrypted native-profile vault is unreadable.", 409);
  }
  try {
    return parseVaultObject(JSON.parse(raw.toString("utf8")), context.homeId);
  } catch {
    throw new NativeProfileError("VAULT_INVALID", "The encrypted native-profile vault is invalid.", 409);
  }
}

type PrivateFileState = "missing" | "present" | "unreadable";

function privateFileState(path: string): PrivateFileState {
  try {
    const stat = lstatSync(path);
    return stat.isFile() && !stat.isSymbolicLink() ? "present" : "unreadable";
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "unreadable";
  }
}

export type NativeProfileRecoveryState = "none" | "journal" | "manual" | "unreadable";

export function probeNativeProfileRecoveryState(context: NativeProfileContext): NativeProfileRecoveryState {
  try { assertNativeProfileMetadataLayout(context); } catch { return "unreadable"; }
  const block = privateFileState(context.recoveryBlockPath);
  if (block === "unreadable") return "unreadable";
  if (block === "present") return "manual";
  const journal = privateFileState(context.journalPath);
  if (journal === "unreadable") return "unreadable";
  return journal === "present" ? "journal" : "none";
}

export type NativeProfileJournalInspection =
  | { status: "missing" }
  | { status: "valid"; journal: NativeProfileSwitchJournalV1 }
  | { status: "invalid" };

export function inspectNativeProfileJournal(context: NativeProfileContext): NativeProfileJournalInspection {
  try { assertNativeProfileMetadataLayout(context); } catch { return { status: "invalid" }; }
  const state = privateFileState(context.journalPath);
  if (state === "missing") return { status: "missing" };
  if (state === "unreadable") return { status: "invalid" };
  try {
    const journal = JSON.parse(
      readBounded(
        context.journalPath,
        MAX_NATIVE_PROFILE_JOURNAL_BYTES,
        boundedReadTestSeam(context),
      ).toString("utf8"),
    ) as NativeProfileSwitchJournalV1;
    if (
      journal.version !== 1 || journal.homeId !== context.homeId || !UUID_RE.test(journal.transactionId)
      || !NATIVE_PROFILE_JOURNAL_PHASES.includes(journal.phase)
      || !UUID_RE.test(journal.sourceProfileId) || !UUID_RE.test(journal.targetProfileId)
      || !HASH_RE.test(journal.sourceIdentityHash) || !HASH_RE.test(journal.targetIdentityHash)
      || !isEncryptedPayload(journal.sourcePayload) || !isEncryptedPayload(journal.targetPayload)
    ) throw new Error("journal");
    journal.beforeVault = parseVaultObject(journal.beforeVault, context.homeId);
    journal.afterVault = parseVaultObject(journal.afterVault, context.homeId);
    if (!hasValidJournalSwitchInvariant(journal)) throw new Error("journal invariant");
    return { status: "valid", journal };
  } catch {
    return { status: "invalid" };
  }
}

export function readNativeProfileJournal(context: NativeProfileContext): NativeProfileSwitchJournalV1 | null {
  const inspection = inspectNativeProfileJournal(context);
  if (inspection.status === "missing") return null;
  if (inspection.status === "valid") return inspection.journal;
  throw new NativeProfileError(
    "RECOVERY_REQUIRED",
    "The native-profile recovery journal is invalid. Run account main recover --rollback --yes to quarantine it.",
    409,
  );
}

export function serializeNativeProfileMetadata(value: unknown): string {
  const serialized = JSON.stringify(value, null, 2) + "\n";
  if (Buffer.byteLength(serialized, "utf8") > MAX_NATIVE_PROFILE_METADATA_BYTES) {
    throw new NativeProfileError(
      "PROFILE_METADATA_TOO_LARGE",
      "Native-profile metadata exceeds the 4 MiB recovery limit; no credential write was made.",
      409,
    );
  }
  return serialized;
}

export function serializeNativeProfileJournal(journal: NativeProfileSwitchJournalV1): string {
  const serialized = JSON.stringify(journal) + "\n";
  if (Buffer.byteLength(serialized, "utf8") > MAX_NATIVE_PROFILE_JOURNAL_BYTES) {
    throw new NativeProfileError(
      "PROFILE_METADATA_TOO_LARGE",
      "The native-profile recovery journal exceeds the 17 MiB limit; no credential write was made.",
      409,
    );
  }
  return serialized;
}

const FORBIDDEN_PROFILE_LABEL_RE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;

/** Canonical key shared by persisted ID/label collision checks and switch selectors. */
export function nativeProfileSelectorKey(value: string): string {
  return value.normalize("NFC").trim().toLowerCase();
}

function normalizedNativeProfileLabel(value: unknown): string | null {
  if (typeof value !== "string" || FORBIDDEN_PROFILE_LABEL_RE.test(value)) return null;
  const normalized = value.normalize("NFC").trim();
  if (!normalized || normalized.length > 64 || FORBIDDEN_PROFILE_LABEL_RE.test(normalized)) return null;
  return normalized;
}

export function validateNativeProfileLabel(label: string): string {
  const trimmed = normalizedNativeProfileLabel(label);
  if (!trimmed) {
    throw new NativeProfileError("INVALID_REQUEST", "Profile labels must contain 1-64 printable characters.", 400);
  }
  return trimmed;
}

export function assertUniqueNativeProfileLabel(
  vault: Pick<NativeMainProfileVaultV1, "profiles">,
  label: string,
  excludeId?: string,
  additionalIds: readonly string[] = [],
): void {
  const selector = nativeProfileSelectorKey(label);
  if (vault.profiles.some(
    profile => profile.id !== excludeId && nativeProfileSelectorKey(profile.label) === selector,
  )) {
    throw new NativeProfileError("PROFILE_ALREADY_EXISTS", "A native profile already uses that label.", 409);
  }
  if (
    vault.profiles.some(profile => nativeProfileSelectorKey(profile.id) === selector)
    || additionalIds.some(id => nativeProfileSelectorKey(id) === selector)
  ) {
    throw new NativeProfileError("PROFILE_ALREADY_EXISTS", "A native profile ID already uses that selector.", 409);
  }
}

export function publicNativeProfile(profile: NativeMainProfileRecordV1): NativeProfilePublic {
  return { id: profile.id, label: profile.label, identityHint: profile.identityHint, state: profile.state };
}
