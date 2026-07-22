import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { Database } from "bun:sqlite";

const DEFAULT_EXPIRES_MS = 3600_000;
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
  location: "kiro-creds-file" | "kiro-cli-db-env" | "kiro-cli-data" | "kiro-cli-linux-data" | "amazon-q-data" | "kiro-sso-cache";
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

function sqliteEntries(): Array<{ location: KiroImportDiagnostic["location"]; path: string }> {
  const home = userHome();
  const configured = process.env.KIROCLI_DB_PATH?.trim() || process.env.KIRO_CLI_DB_FILE?.trim();
  if (configured) return [{ location: "kiro-cli-db-env", path: expandPath(configured) }];
  return [
    { location: "kiro-cli-data", path: join(home, "Library", "Application Support", "kiro-cli", "data.sqlite3") },
    { location: "kiro-cli-linux-data", path: join(home, ".local", "share", "kiro-cli", "data.sqlite3") },
    { location: "amazon-q-data", path: join(home, ".local", "share", "amazon-q", "data.sqlite3") },
    { location: "kiro-sso-cache", path: join(home, ".kiro", "sso", "cache.db") },
  ];
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

function readSqliteCredentials(diagnostics: KiroImportDiagnostic[]): ImportedKiroCredential | undefined {
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
      if (credential) return credential;
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
  return { credential: sqlite ?? null, diagnostics };
}

export function inspectKiroCliSqliteSources(): { credential: ImportedKiroCredential | null; diagnostics: KiroImportDiagnostic[] } {
  const diagnostics: KiroImportDiagnostic[] = [];
  return { credential: readSqliteCredentials(diagnostics) ?? null, diagnostics };
}

export function readImportedKiroCredential(): ImportedKiroCredential | null {
  return inspectKiroCredentialSources().credential;
}

export function readKiroCliSqliteCredential(): ImportedKiroCredential | null {
  return inspectKiroCliSqliteSources().credential;
}
