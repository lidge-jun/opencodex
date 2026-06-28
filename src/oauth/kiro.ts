/**
 * Kiro (AWS CodeWhisperer) OAuth — import-first.
 *
 * Unlike browser/PKCE providers, kiro reuses the locally installed kiro-cli login:
 * it reads the kiro-cli SQLite token store, falls back to KIRO_ACCESS_TOKEN env, then to a
 * manual access-token paste (CLI only). Refresh hits the Kiro desktop refresh endpoint.
 *
 * Ported from jawcode packages/ai/src/providers/kiro.ts (readKiroCliSqlite, refreshKiroDesktopToken).
 * profileArn/region are NOT stored in the credential — the kiro ADAPTER resolves them at request
 * time (SQLite profile_arn / KIRO_PROFILE_ARN, KIRO_REGION) since getValidAccessToken surfaces
 * only the access token.
 */
import { existsSync } from "node:fs";
import { Database } from "bun:sqlite";
import type { OAuthController, OAuthCredentials } from "./types";

const DEFAULT_REGION = "us-east-1";
const REFRESH_URL = "https://prod.{region}.auth.desktop.kiro.dev/refreshToken";
const TOKEN_KEYS = ["kirocli:social:token", "kirocli:odic:token", "codewhisperer:odic:token"];

function dbPaths(): string[] {
  const home = process.env.HOME || "";
  return [`${home}/Library/Application Support/kiro-cli/data.sqlite3`, `${home}/.kiro/sso/cache.db`];
}

interface ImportedKiroToken {
  access: string;
  refresh: string;
  expires: number;
}

/** Read the kiro-cli SQLite token store (mac/linux). Returns null if no token found. */
export function readKiroCliSqlite(): ImportedKiroToken | null {
  for (const dbPath of dbPaths()) {
    if (!existsSync(dbPath)) continue;
    let db: Database | undefined;
    try {
      db = new Database(dbPath, { readonly: true });
      for (const key of TOKEN_KEYS) {
        const row = db.query("SELECT value FROM auth_kv WHERE key = ?").get(key) as { value: string } | null;
        if (!row) continue;
        const data = JSON.parse(row.value) as { access_token?: string; refresh_token?: string; expires_at?: string };
        if (data.access_token) {
          return {
            access: data.access_token,
            refresh: data.refresh_token || "",
            expires: data.expires_at ? new Date(data.expires_at).getTime() : Date.now() + 3600_000,
          };
        }
      }
    } catch {
      // unreadable / wrong schema — try the next path
    } finally {
      db?.close();
    }
  }
  return null;
}

/**
 * Import-first login: kiro-cli SQLite → KIRO_ACCESS_TOKEN env → manual paste (CLI only).
 * In GUI (no onManualCodeInput) with no SQLite token and no env, throws a clear error — never hangs.
 */
export async function loginKiro(ctrl: OAuthController): Promise<OAuthCredentials> {
  const imported = readKiroCliSqlite();
  if (imported) {
    ctrl.onProgress?.("Imported token from installed kiro-cli login.");
    return { access: imported.access, refresh: imported.refresh, expires: imported.expires };
  }

  const envToken = process.env.KIRO_ACCESS_TOKEN;
  if (envToken) {
    ctrl.onProgress?.("Using KIRO_ACCESS_TOKEN from environment.");
    return { access: envToken, refresh: process.env.KIRO_REFRESH_TOKEN ?? "", expires: Date.now() + 3600_000 };
  }

  if (ctrl.onManualCodeInput) {
    ctrl.onProgress?.("No kiro-cli token found. Paste a Kiro access token (starts with 'aoa').");
    const raw = (await ctrl.onManualCodeInput()).trim();
    if (raw) return { access: raw, refresh: "", expires: Date.now() + 3600_000 };
  }

  throw new Error(
    "Kiro: no token found. Run `kiro-cli login` first (import), or set KIRO_ACCESS_TOKEN. " +
      "Browser login is not supported for Kiro.",
  );
}

/** Region precedence: KIRO_REGION → default us-east-1. */
export function resolveKiroRegion(): string {
  return process.env.KIRO_REGION || DEFAULT_REGION;
}

/**
 * Resolve the CodeWhisperer profileArn for request-time use by the adapter.
 * KIRO_PROFILE_ARN env → kiro-cli SQLite `profile_arn`. Returns undefined if absent
 * (the adapter decides whether that is fatal).
 */
export function resolveKiroProfileArn(): string | undefined {
  const env = process.env.KIRO_PROFILE_ARN;
  if (env) return env;
  for (const dbPath of dbPaths()) {
    if (!existsSync(dbPath)) continue;
    let db: Database | undefined;
    try {
      db = new Database(dbPath, { readonly: true });
      for (const key of TOKEN_KEYS) {
        const row = db.query("SELECT value FROM auth_kv WHERE key = ?").get(key) as { value: string } | null;
        if (!row) continue;
        const data = JSON.parse(row.value) as { profile_arn?: string };
        if (data.profile_arn) return data.profile_arn;
      }
    } catch {
      // try next path
    } finally {
      db?.close();
    }
  }
  return undefined;
}
export async function refreshKiroToken(refresh: string, signal?: AbortSignal): Promise<OAuthCredentials> {
  if (!refresh) throw new Error("Kiro: no refresh token available (re-run `kiro-cli login`).");
  const region = process.env.KIRO_REGION || DEFAULT_REGION;
  const res = await fetch(REFRESH_URL.replace("{region}", region), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ refreshToken: refresh }),
    signal: signal ?? AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`Kiro token refresh failed: ${res.status}`);
  const data = (await res.json()) as { accessToken?: string; refreshToken?: string; expiresIn?: number };
  if (!data.accessToken) throw new Error("Kiro refresh returned no accessToken");
  return {
    access: data.accessToken,
    refresh: data.refreshToken || refresh,
    expires: Date.now() + (data.expiresIn ?? 3600) * 1000,
  };
}
