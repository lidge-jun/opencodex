import { randomUUID } from "node:crypto";
import { chmodSync, closeSync, existsSync, fsyncSync, linkSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, posix, win32 } from "node:path";
import { Database } from "bun:sqlite";

const DEFAULT_EXPIRES_MS = 3600_000;
const KIRO_CLI_RECOVERY_SUFFIX = ".opencodex-recovery";
const KIRO_CLI_RECOVERY_HEADER_V1 = Buffer.from("opencodex-kiro-session-v1\n", "utf8");
const KIRO_CLI_RECOVERY_HEADER = Buffer.from("opencodex-kiro-session-v2\n", "utf8");
const KIRO_CLI_RECOVERY_PROCESS_INSTANCE = randomUUID();
const KIRO_CLI_RECOVERY_PROCESS_INSTANCE_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;
const SQLITE_DATABASE_HEADER = Buffer.from("SQLite format 3\0", "binary");
const KIRO_REGION_PATTERN = /^[a-z]{2}(?:-[a-z]+)+-\d$/;
const CLIENT_ID_HASH_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const TOKEN_KEYS = [
  "kirocli:odic:token",
  "kirocli:oidc:token",
  "kirocli:social:token",
  "codewhisperer:odic:token",
];
const REGISTRATION_KEYS = [
  "kirocli:odic:device-registration",
  "kirocli:oidc:device-registration",
  "codewhisperer:odic:device-registration",
];

export type KiroAuthType = "kiro_desktop" | "aws_sso_oidc";
export type KiroCredentialSource = "json" | "sqlite";
export type KiroDiagnosticStatus =
  | "missing"
  | "unreadable"
  | "schema_mismatch"
  | "invalid_json"
  | "token_missing"
  | "token_ambiguous"
  | "token_key_missing"
  | "token_found"
  | "registration_found";

export interface KiroImportDiagnostic {
  location:
    | "kiro-creds-file"
    | "kiro-cli-db-env"
    | "kiro-cli-data"
    | "kiro-cli-linux-data"
    | "kiro-cli-windows-data"
    | "amazon-q-data"
    | "kiro-sso-cache";
  status: KiroDiagnosticStatus;
}

export interface ImportedKiroCredential {
  access: string;
  refresh: string;
  expires: number;
  source: KiroCredentialSource;
  authType: KiroAuthType;
  profileArn?: string;
  ssoRegion?: string;
  apiRegion?: string;
  clientId?: string;
  clientSecret?: string;
}

/** Opaque backup retained on disk while a forced Kiro CLI login is pending persistence. */
export interface KiroCliSessionSnapshot {
  readonly path: string;
  readonly database: Buffer;
  readonly recoveryPath: string;
}

type JsonObject = Record<string, unknown>;

function userHome(): string {
  return process.env.HOME || homedir();
}

function expandPath(path: string): string {
  if (path.startsWith("~/")) return join(userHome(), path.slice(2));
  return isAbsolute(path) ? path : join(process.cwd(), path);
}

function stringField(data: JsonObject, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = data[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}

function parseExpires(value: unknown, present: boolean, hasRefreshToken: boolean): number {
  if (typeof value === "number" && Number.isFinite(value)) return value < 10_000_000_000 ? value * 1000 : value;
  if (typeof value === "string" && value.length > 0) {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  if (present) {
    console.warn(
      `[ocx:kiro:credentials] credential expiry is present but unparseable; ${
        hasRefreshToken ? "treating credential as expired" : "using the default TTL because no refresh token is available"
      }`,
    );
    if (hasRefreshToken) return 0;
  }
  return Date.now() + DEFAULT_EXPIRES_MS;
}

export function inferRegionFromProfileArn(arn: string | undefined): string | undefined {
  if (!arn) return undefined;
  const region = arn.split(":")[3];
  return normalizeKiroRegion(region);
}

export function normalizeKiroRegion(region: string | undefined): string | undefined {
  const trimmed = region?.trim();
  return trimmed && KIRO_REGION_PATTERN.test(trimmed) ? trimmed : undefined;
}

export function requireKiroRegion(region: string | undefined): string {
  const normalized = normalizeKiroRegion(region);
  if (!normalized) throw new Error("Kiro: invalid region value.");
  return normalized;
}

function jsonCredentialPaths(): string[] {
  return [process.env.KIRO_CREDS_FILE, process.env.KIRO_CREDENTIALS_FILE]
    .filter((value): value is string => !!value)
    .map(expandPath);
}

export type KiroCliNativeLocation = "kiro-cli-data" | "kiro-cli-linux-data" | "kiro-cli-windows-data";

export interface KiroCliNativeInputs {
  env: Record<string, string | undefined>;
  platform: NodeJS.Platform;
  home: string;
}

/**
 * Native kiro-cli session stores, as a pure function of (env, platform, home).
 *
 * Pure + parameterized following `src/claude/desktop-3p-paths.ts`: `process.platform` is stubbable
 * in this repo, but `os.platform()` does NOT follow it under Bun, so a pure resolver is the reliable
 * way to exercise the win32 branch (and its env fallbacks) on a macOS/Linux host.
 *
 * Windows (issue #710): the official installer stores the auth DB at
 * `%LOCALAPPDATA%\Kiro-Cli\data.sqlite3`. When LOCALAPPDATA is unset or blank, fall back to
 * `%USERPROFILE%\AppData\Local`, then to the injected platform-native home. Deliberately NOT
 * `userHome()`: that is `HOME || homedir()` and Windows shells (Git Bash / MSYS / CI) routinely
 * export a POSIX-style `HOME`, which would point this at a non-native path.
 *
 * One entry per platform on purpose: this list also drives forced-login snapshot/rollback, so it
 * must name the database the LOCAL kiro-cli actually mutates, never a foreign platform's path.
 */
export function resolveKiroCliNativeSessionEntries(
  inputs: KiroCliNativeInputs,
): Array<{ location: KiroCliNativeLocation; path: string }> {
  const { env, platform, home } = inputs;
  if (platform === "win32") {
    const base = env.LOCALAPPDATA?.trim()
      || (env.USERPROFILE?.trim() ? win32.join(env.USERPROFILE.trim(), "AppData", "Local") : "")
      || win32.join(home, "AppData", "Local");
    return [{ location: "kiro-cli-windows-data", path: win32.join(base, "Kiro-Cli", "data.sqlite3") }];
  }
  if (platform === "darwin") {
    return [{ location: "kiro-cli-data", path: posix.join(home, "Library", "Application Support", "kiro-cli", "data.sqlite3") }];
  }
  return [{ location: "kiro-cli-linux-data", path: posix.join(home, ".local", "share", "kiro-cli", "data.sqlite3") }];
}

/**
 * Resolve the absolute kiro-cli executable for spawn/login helpers.
 *
 * Pure + parameterized like `resolveKiroCliNativeSessionEntries` so Windows install layouts can be
 * covered from any host. PATH remains the first choice; only when bare `kiro-cli` is missing do we
 * fall back to the platform-native install directories next to the session database.
 *
 * Windows: official MSI installs to `C:\Program Files\Kiro-Cli\kiro-cli.exe`, while some local
 * installs keep the binary next to `%LOCALAPPDATA%\Kiro-Cli\data.sqlite3`.
 * macOS/Linux: prefer PATH, then the usual user-local bin directories.
 */
export function resolveKiroCliExecutable(
  inputs: KiroCliNativeInputs & {
    pathEntries?: string[];
    exists?: (path: string) => boolean;
    isFile?: (path: string) => boolean;
  },
): string {
  const exists = inputs.exists ?? existsSync;
  // A directory named `kiro-cli` on PATH satisfies existsSync and would then be handed to
  // spawn(), which fails with EACCES at login instead of falling through to the next candidate.
  // When a caller injects `exists` it owns the whole filesystem view, so the real stat would
  // reject every synthetic path; such callers inject `isFile` too when they care about it.
  const isFile = inputs.isFile ?? (inputs.exists ? () => true : ((path: string) => {
    try {
      return statSync(path).isFile();
    } catch {
      return false;
    }
  }));
  const pathEntries = inputs.pathEntries
    ?? (inputs.env.PATH ?? inputs.env.Path ?? "").split(inputs.platform === "win32" ? ";" : ":")
      .map(entry => entry.trim())
      .filter(Boolean);

  const pathCandidates = inputs.platform === "win32"
    ? pathEntries.flatMap(entry => [
        win32.join(entry, "kiro-cli.exe"),
        win32.join(entry, "kiro-cli"),
      ])
    : pathEntries.map(entry => posix.join(entry, "kiro-cli"));

  const installCandidates: string[] = [];
  if (inputs.platform === "win32") {
    const localBase = inputs.env.LOCALAPPDATA?.trim()
      || (inputs.env.USERPROFILE?.trim() ? win32.join(inputs.env.USERPROFILE.trim(), "AppData", "Local") : "")
      || win32.join(inputs.home, "AppData", "Local");
    const programFiles = inputs.env["ProgramFiles"]?.trim() || "C:\\Program Files";
    installCandidates.push(
      win32.join(localBase, "Kiro-Cli", "kiro-cli.exe"),
      win32.join(programFiles, "Kiro-Cli", "kiro-cli.exe"),
    );
  } else if (inputs.platform === "darwin") {
    installCandidates.push(
      posix.join(inputs.home, ".local", "bin", "kiro-cli"),
      "/usr/local/bin/kiro-cli",
      "/opt/homebrew/bin/kiro-cli",
    );
  } else {
    installCandidates.push(
      posix.join(inputs.home, ".local", "bin", "kiro-cli"),
      "/usr/local/bin/kiro-cli",
    );
  }

  for (const candidate of [...pathCandidates, ...installCandidates]) {
    if (exists(candidate) && isFile(candidate)) return candidate;
  }
  return inputs.platform === "win32" ? "kiro-cli.exe" : "kiro-cli";
}

function nativeKiroCliSessionEntries(): Array<{ location: KiroCliNativeLocation; path: string }> {
  // Only the stores that `kiro-cli logout` / `kiro-cli login` themselves mutate. Import fallbacks
  // (Amazon Q / SSO cache) and KIROCLI_DB_PATH selectors must not be snapshotted for rollback.
  return resolveKiroCliNativeSessionEntries({
    env: process.env,
    platform: process.platform,
    // POSIX keeps HOME-first userHome() so existing HOME-based fixtures still resolve; win32 prefers
    // LOCALAPPDATA/USERPROFILE and only falls back to this platform-native home.
    home: process.platform === "win32" ? homedir() : userHome(),
  });
}

function sqliteEntries(): Array<{ location: KiroImportDiagnostic["location"]; path: string }> {
  const configured = process.env.KIROCLI_DB_PATH?.trim() || process.env.KIRO_CLI_DB_FILE?.trim();
  if (configured) return [{ location: "kiro-cli-db-env", path: expandPath(configured) }];
  return [
    ...nativeKiroCliSessionEntries(),
    { location: "amazon-q-data", path: join(userHome(), ".local", "share", "amazon-q", "data.sqlite3") },
    { location: "kiro-sso-cache", path: join(userHome(), ".kiro", "sso", "cache.db") },
  ];
}

function kiroCliImportSelectorConfigured(): boolean {
  return Boolean(process.env.KIROCLI_DB_PATH?.trim() || process.env.KIRO_CLI_DB_FILE?.trim());
}

function selectTokenRow(db: Database): { value: string } | null | "ambiguous" | "selected_missing" {
  const rows = db.query("SELECT key, value FROM auth_kv WHERE key LIKE ? ORDER BY key ASC").all("%:token") as Array<{ key: string; value: string }>;
  const selectedKey = process.env.KIROCLI_TOKEN_KEY?.trim();
  if (selectedKey) return rows.find(row => row.key === selectedKey) ?? "selected_missing";
  for (const preferred of TOKEN_KEYS) {
    const row = rows.find(candidate => candidate.key === preferred);
    if (row) return row;
  }
  if (rows.length === 0) return null;
  if (rows.length === 1) return rows[0];
  return "ambiguous";
}

function credentialFromJson(data: JsonObject, source: KiroCredentialSource): ImportedKiroCredential | undefined {
  const access = stringField(data, "accessToken", "access_token");
  if (!access) return undefined;
  const profileArn = stringField(data, "profileArn", "profile_arn");
  const ssoRegion = stringField(data, "region");
  const apiRegion = stringField(data, "apiRegion", "api_region") || inferRegionFromProfileArn(profileArn) || ssoRegion;
  const clientId = stringField(data, "clientId", "client_id");
  const clientSecret = stringField(data, "clientSecret", "client_secret");
  const refresh = stringField(data, "refreshToken", "refresh_token") || "";
  const expiryPresent = Object.hasOwn(data, "expiresAt") || Object.hasOwn(data, "expires_at");
  return {
    access,
    refresh,
    expires: parseExpires(data.expiresAt ?? data.expires_at, expiryPresent, refresh.length > 0),
    source,
    authType: clientId && clientSecret ? "aws_sso_oidc" : "kiro_desktop",
    ...(profileArn ? { profileArn } : {}),
    ...(ssoRegion ? { ssoRegion } : {}),
    ...(apiRegion ? { apiRegion } : {}),
    ...(clientId ? { clientId } : {}),
    ...(clientSecret ? { clientSecret } : {}),
  };
}

function loadEnterpriseRegistration(data: JsonObject): JsonObject | undefined {
  const hash = stringField(data, "clientIdHash");
  if (!hash) return undefined;
  if (!CLIENT_ID_HASH_PATTERN.test(hash)) return undefined;
  const path = join(userHome(), ".aws", "sso", "cache", `${hash}.json`);
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as JsonObject;
  } catch {
    return undefined;
  }
}

function readJsonCredentials(diagnostics: KiroImportDiagnostic[]): ImportedKiroCredential | undefined {
  for (const path of jsonCredentialPaths()) {
    if (!existsSync(path)) {
      diagnostics.push({ location: "kiro-creds-file", status: "missing" });
      continue;
    }
    let data: JsonObject;
    try {
      const raw = readFileSync(path, "utf8");
      try {
        data = JSON.parse(raw) as JsonObject;
      } catch {
        diagnostics.push({ location: "kiro-creds-file", status: "invalid_json" });
        continue;
      }
    } catch {
      diagnostics.push({ location: "kiro-creds-file", status: "unreadable" });
      continue;
    }
    const registration = loadEnterpriseRegistration(data);
    const merged = registration ? { ...data, ...registration } : data;
    const credential = credentialFromJson(merged, "json");
    diagnostics.push({ location: "kiro-creds-file", status: credential ? "token_found" : "token_missing" });
    if (credential) return credential;
  }
  return undefined;
}

function readStateProfile(db: Database): { profileArn?: string; apiRegion?: string } {
  try {
    const row = db.query("SELECT value FROM state WHERE key = ?").get("api.codewhisperer.profile") as { value: string } | null;
    if (!row) return {};
    const data = JSON.parse(row.value) as JsonObject;
    const profileArn = stringField(data, "arn", "profileArn", "profile_arn");
    return { ...(profileArn ? { profileArn } : {}), ...(profileArn ? { apiRegion: inferRegionFromProfileArn(profileArn) } : {}) };
  } catch {
    return {};
  }
}

interface LocatedKiroCliCredential {
  credential: ImportedKiroCredential;
  path: string;
  database?: Buffer;
}

function readSqliteCredentials(
  diagnostics: KiroImportDiagnostic[],
  includeSnapshot = false,
): LocatedKiroCliCredential | undefined {
  for (const { location, path } of sqliteEntries()) {
    if (!existsSync(path)) {
      diagnostics.push({ location, status: "missing" });
      continue;
    }
    let db: Database | undefined;
    try {
      db = new Database(path, { readonly: true });
      try { db.exec("PRAGMA busy_timeout = 5000"); } catch { /* read-only best effort */ }
    } catch {
      diagnostics.push({ location, status: "unreadable" });
      continue;
    }
    try {
      const row = selectTokenRow(db);
      if (row === "ambiguous") {
        diagnostics.push({ location, status: "token_ambiguous" });
        throw new Error("Kiro CLI credential database contains multiple tokens; set KIROCLI_TOKEN_KEY to select one");
      }
      if (row === "selected_missing") {
        diagnostics.push({ location, status: "token_key_missing" });
        throw new Error("The KIROCLI_TOKEN_KEY selection was not found in the Kiro CLI credential database");
      }
      if (!row) {
        diagnostics.push({ location, status: "token_missing" });
        continue;
      }
      let tokenData: JsonObject;
      try {
        tokenData = JSON.parse(row.value) as JsonObject;
      } catch {
        diagnostics.push({ location, status: "invalid_json" });
        continue;
      }
      let registrationData: JsonObject = {};
      for (const key of REGISTRATION_KEYS) {
        const row = db.query("SELECT value FROM auth_kv WHERE key = ?").get(key) as { value: string } | null;
        if (!row) continue;
        try {
          registrationData = JSON.parse(row.value) as JsonObject;
          diagnostics.push({ location, status: "registration_found" });
        } catch {
          diagnostics.push({ location, status: "invalid_json" });
        }
        break;
      }
      const profile = readStateProfile(db);
      const merged = { ...registrationData, ...tokenData, ...profile };
      const credential = credentialFromJson(merged, "sqlite");
      diagnostics.push({ location, status: credential ? "token_found" : "token_missing" });
      if (credential) {
        return {
          credential,
          path,
          ...(includeSnapshot ? { database: db.serialize() } : {}),
        };
      }
    } catch (error) {
      if (error instanceof Error && error.message.includes("KIROCLI_TOKEN_KEY")) throw error;
      diagnostics.push({ location, status: "schema_mismatch" });
    } finally {
      db.close();
    }
  }
  return undefined;
}

export function inspectKiroCredentialSources(): { credential: ImportedKiroCredential | null; diagnostics: KiroImportDiagnostic[] } {
  const diagnostics: KiroImportDiagnostic[] = [];
  const json = readJsonCredentials(diagnostics);
  if (json) return { credential: json, diagnostics };
  const sqlite = readSqliteCredentials(diagnostics);
  return { credential: sqlite?.credential ?? null, diagnostics };
}

export function inspectKiroCliSqliteSources(): { credential: ImportedKiroCredential | null; diagnostics: KiroImportDiagnostic[] } {
  const diagnostics: KiroImportDiagnostic[] = [];
  return { credential: readSqliteCredentials(diagnostics)?.credential ?? null, diagnostics };
}

export function readImportedKiroCredential(): ImportedKiroCredential | null {
  return inspectKiroCredentialSources().credential;
}

export function readKiroCliSqliteCredential(): ImportedKiroCredential | null {
  return inspectKiroCliSqliteSources().credential;
}

/** Capture the complete active CLI database so a failed account switch can restore it exactly. */
export function snapshotKiroCliSession(): KiroCliSessionSnapshot | null {
  return inspectKiroCliSessionSnapshot().snapshot;
}

/**
 * A store that exists but cannot be captured must never be logged out of: the recovery contract
 * promises an exact restore, and without a snapshot a later failure would destroy the session for
 * good. `missing`/`token_missing` are the only statuses that mean "there is nothing to lose".
 */
const KIRO_UNSNAPSHOTTABLE_SESSION_STATUSES: ReadonlySet<KiroDiagnosticStatus> = new Set([
  "unreadable",
  "schema_mismatch",
  "invalid_json",
  "token_ambiguous",
  "token_key_missing",
  "token_found",
]);

/**
 * Capture the active CLI session and report why capture failed. `blocked` is true when a session
 * store is present but could not be snapshotted (unreadable / schema-mismatched / ambiguous), so
 * callers can abort before mutating it.
 *
 * Forced-login rollback must target the exact database `kiro-cli` mutates. Custom import selectors
 * and lower-priority Amazon Q / SSO caches are never used here: snapshotting the wrong file would
 * leave the real CLI session switched or lost after failure.
 */
export function inspectKiroCliSessionSnapshot(): {
  snapshot: KiroCliSessionSnapshot | null;
  diagnostics: KiroImportDiagnostic[];
  blocked: boolean;
} {
  const diagnostics: KiroImportDiagnostic[] = [];
  if (kiroCliImportSelectorConfigured()) {
    diagnostics.push({ location: "kiro-cli-db-env", status: "token_ambiguous" });
    return { snapshot: null, diagnostics, blocked: true };
  }

  for (const { location, path } of nativeKiroCliSessionEntries()) {
    if (!existsSync(path)) {
      diagnostics.push({ location, status: "missing" });
      continue;
    }

    let db: Database | undefined;
    try {
      db = new Database(path, { readonly: true });
      try { db.exec("PRAGMA busy_timeout = 5000"); } catch { /* read-only best effort */ }
    } catch {
      diagnostics.push({ location, status: "unreadable" });
      return { snapshot: null, diagnostics, blocked: true };
    }

    try {
      const row = selectTokenRow(db);
      if (row === "ambiguous") {
        diagnostics.push({ location, status: "token_ambiguous" });
        return { snapshot: null, diagnostics, blocked: true };
      }
      if (row === "selected_missing") {
        diagnostics.push({ location, status: "token_key_missing" });
        return { snapshot: null, diagnostics, blocked: true };
      }
      if (!row) {
        // An existing CLI database with no recognized token is still what logout mutates. Falling
        // through to Amazon Q / another platform path would snapshot the wrong store.
        diagnostics.push({ location, status: "token_missing" });
        return { snapshot: null, diagnostics, blocked: true };
      }
      try {
        JSON.parse(row.value);
      } catch {
        diagnostics.push({ location, status: "invalid_json" });
        return { snapshot: null, diagnostics, blocked: true };
      }
      const database = db.serialize();
      diagnostics.push({ location, status: "token_found" });
      return {
        snapshot: {
          path,
          database,
          recoveryPath: `${path}${KIRO_CLI_RECOVERY_SUFFIX}`,
        },
        diagnostics,
        blocked: false,
      };
    } catch (error) {
      if (error instanceof Error && error.message.includes("KIROCLI_TOKEN_KEY")) {
        diagnostics.push({ location, status: "token_key_missing" });
        return { snapshot: null, diagnostics, blocked: true };
      }
      diagnostics.push({ location, status: "schema_mismatch" });
      return { snapshot: null, diagnostics, blocked: true };
    } finally {
      db.close();
    }
  }

  return {
    snapshot: null,
    diagnostics,
    blocked: diagnostics.some(entry => KIRO_UNSNAPSHOTTABLE_SESSION_STATUSES.has(entry.status)),
  };
}

/** Persist a complete, private recovery image before kiro-cli is allowed to mutate its store. */
export function persistKiroCliSessionRecovery(snapshot: KiroCliSessionSnapshot): void {
  if (existsSync(snapshot.recoveryPath)) {
    throw new Error("Kiro CLI session recovery is already pending.");
  }
  const nonce = `${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}`;
  const staged = `${snapshot.recoveryPath}.${nonce}.tmp`;
  try {
    writeFileSync(staged, Buffer.concat([
      KIRO_CLI_RECOVERY_HEADER,
      Buffer.from(`${process.pid}\n`, "utf8"),
      Buffer.from(`${KIRO_CLI_RECOVERY_PROCESS_INSTANCE}\n`, "utf8"),
      snapshot.database,
    ]), { flag: "wx", mode: 0o600 });
    try { chmodSync(staged, 0o600); } catch { /* platform may ignore chmod */ }
    const fd = openSync(staged, "r+");
    try { fsyncSync(fd); } finally { closeSync(fd); }
    // A hard link publishes the fsynced inode atomically and, unlike rename, can never replace
    // another process's live recovery transaction if both raced past the initial existence check.
    linkSync(staged, snapshot.recoveryPath);
  } finally {
    rmSync(staged, { force: true });
  }
}

/** Remove recovery data only after the corresponding login transaction has settled. */
export function discardKiroCliSessionRecovery(snapshot: KiroCliSessionSnapshot): void {
  rmSync(snapshot.recoveryPath, { force: true });
}

interface ParsedKiroCliSessionRecovery {
  ownerPid: number;
  ownerProcessInstance?: string;
  database: Buffer;
}

function parseKiroCliSessionRecovery(payload: Buffer): ParsedKiroCliSessionRecovery | null {
  const isV2 = payload.subarray(0, KIRO_CLI_RECOVERY_HEADER.length).equals(KIRO_CLI_RECOVERY_HEADER);
  const isV1 = payload.subarray(0, KIRO_CLI_RECOVERY_HEADER_V1.length).equals(KIRO_CLI_RECOVERY_HEADER_V1);
  if (!isV2 && !isV1) return null;
  const headerLength = isV2 ? KIRO_CLI_RECOVERY_HEADER.length : KIRO_CLI_RECOVERY_HEADER_V1.length;
  const ownerEnd = payload.indexOf(0x0a, headerLength);
  if (ownerEnd <= headerLength) return null;
  const ownerPid = Number(payload.subarray(headerLength, ownerEnd).toString("utf8"));
  let databaseStart = ownerEnd + 1;
  let ownerProcessInstance: string | undefined;
  if (isV2) {
    const instanceEnd = payload.indexOf(0x0a, databaseStart);
    if (instanceEnd <= databaseStart) return null;
    ownerProcessInstance = payload.subarray(databaseStart, instanceEnd).toString("utf8");
    if (!KIRO_CLI_RECOVERY_PROCESS_INSTANCE_PATTERN.test(ownerProcessInstance)) return null;
    databaseStart = instanceEnd + 1;
  }
  const database = payload.subarray(databaseStart);
  if (
    !Number.isSafeInteger(ownerPid) || ownerPid <= 0 ||
    !database.subarray(0, SQLITE_DATABASE_HEADER.length).equals(SQLITE_DATABASE_HEADER)
  ) {
    return null;
  }
  return { ownerPid, ...(ownerProcessInstance ? { ownerProcessInstance } : {}), database };
}

function isKiroRecoveryOwnerAlive(ownerPid: number, ownerProcessInstance?: string): boolean {
  // A restarted supervisor may reuse the exact same PID (commonly PID 1). Only this process
  // instance's nonce proves that a same-PID recovery transaction is still live.
  if (ownerPid === process.pid) return ownerProcessInstance === KIRO_CLI_RECOVERY_PROCESS_INSTANCE;
  try {
    process.kill(ownerPid, 0);
    return true;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error) return error.code !== "ESRCH";
    return true;
  }
}

/** Restore a previously captured CLI database after every kiro-cli child process has exited. */
export function restoreKiroCliSession(snapshot: KiroCliSessionSnapshot): void {
  const nonce = `${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}`;
  const staged = `${snapshot.path}.ocx-restore.${nonce}.tmp`;
  const displacedBase = `${snapshot.path}.ocx-restore.${nonce}.new`;
  const displaced: Array<{ current: string; backup: string }> = [];
  let published = false;
  try {
    writeFileSync(staged, snapshot.database, { mode: 0o600 });
    try { chmodSync(staged, 0o600); } catch { /* platform may ignore chmod */ }
    for (const suffix of ["", "-wal", "-shm", "-journal"]) {
      const current = `${snapshot.path}${suffix}`;
      if (!existsSync(current)) continue;
      const backup = `${displacedBase}${suffix || ".db"}`;
      renameSync(current, backup);
      displaced.push({ current, backup });
    }
    renameSync(staged, snapshot.path);
    published = true;
  } catch (error) {
    const recoveryErrors: unknown[] = [];
    for (const { current, backup } of [...displaced].reverse()) {
      if (!existsSync(backup) || existsSync(current)) continue;
      try { renameSync(backup, current); } catch (recoveryError) { recoveryErrors.push(recoveryError); }
    }
    if (recoveryErrors.length > 0) throw new AggregateError([error, ...recoveryErrors], "Kiro CLI session restore failed during rollback.");
    throw error;
  } finally {
    rmSync(staged, { force: true });
    if (published) {
      for (const { backup } of displaced) {
        try { rmSync(backup, { force: true }); } catch { /* restored database is already published */ }
      }
    }
  }
}

/** Restore a transaction abandoned by a crashed process before starting another forced login. */
export function restoreStaleKiroCliSessionRecovery(): boolean {
  for (const { path } of nativeKiroCliSessionEntries()) {
    const recoveryPath = `${path}${KIRO_CLI_RECOVERY_SUFFIX}`;
    if (!existsSync(recoveryPath)) continue;
    const payload = readFileSync(recoveryPath);
    const recovery = parseKiroCliSessionRecovery(payload);
    if (!recovery) {
      throw new Error(
        `Kiro CLI session recovery data is invalid: ${recoveryPath}. Remove this file to continue.`,
      );
    }
    if (isKiroRecoveryOwnerAlive(recovery.ownerPid, recovery.ownerProcessInstance)) {
      throw new Error(
        `Another Kiro CLI login transaction is still in progress (pid ${recovery.ownerPid}, ${recoveryPath}).`,
      );
    }
    // Atomically claim the marker before restoring so a concurrent process cannot restore the
    // same stale image (and later delete a newer recovery file published by the winner).
    const claimedPath = `${recoveryPath}.claimed.${process.pid}.${Date.now()}`;
    try {
      renameSync(recoveryPath, claimedPath);
    } catch {
      continue;
    }
    try {
      const claimed = readFileSync(claimedPath);
      if (!claimed.equals(payload)) {
        // Put the unexpected claim back so an operator / later process can inspect it.
        try { renameSync(claimedPath, recoveryPath); } catch { /* keep claimed path for manual recovery */ }
        throw new Error(
          `Kiro CLI session recovery data changed while claiming ${recoveryPath}. Remove leftover claim files under the kiro-cli data directory and retry.`,
        );
      }
      restoreKiroCliSession({
        path,
        database: recovery.database,
        recoveryPath: claimedPath,
      });
      rmSync(claimedPath, { force: true });
      return true;
    } catch (error) {
      // Preserve the only copy of the prior database when restore fails (disk full, permissions).
      if (existsSync(claimedPath) && !existsSync(recoveryPath)) {
        try { renameSync(claimedPath, recoveryPath); } catch { /* claimed file remains for manual recovery */ }
      }
      throw error;
    }
  }
  return false;
}
