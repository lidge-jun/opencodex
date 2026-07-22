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
import type { OAuthController, OAuthCredentials } from "./types";
import {
  inferRegionFromProfileArn,
  inspectKiroCliSqliteSources,
  normalizeKiroRegion,
  readImportedKiroCredential,
  readKiroCliSqliteCredential,
  requireKiroRegion,
  type KiroImportDiagnostic,
} from "./kiro-credentials";

const DEFAULT_REGION = "us-east-1";
const REFRESH_URL = "https://prod.{region}.auth.desktop.kiro.dev/refreshToken";
const OIDC_URL = "https://oidc.{region}.amazonaws.com/token";

interface ImportedKiroToken {
  access: string;
  refresh: string;
  expires: number;
}

export type KiroCliImportDiagnosticStatus = KiroImportDiagnostic["status"];
export type KiroCliImportDiagnostic = KiroImportDiagnostic;

export function inspectKiroCliSqlite(): { token: ImportedKiroToken | null; diagnostics: KiroCliImportDiagnostic[] } {
  const { credential, diagnostics } = inspectKiroCliSqliteSources();
  return {
    token: credential ? { access: credential.access, refresh: credential.refresh, expires: credential.expires } : null,
    diagnostics,
  };
}

/** Read the kiro-cli SQLite token store (mac/linux). Returns null if no token found. */
export function readKiroCliSqlite(): ImportedKiroToken | null {
  const imported = readKiroCliSqliteCredential();
  return imported ? { access: imported.access, refresh: imported.refresh, expires: imported.expires } : null;
}

/**
 * Import-first login: kiro-cli SQLite → KIRO_ACCESS_TOKEN env → manual paste (CLI only).
 * When no local token is available, resolves the login flow via onAuth with instructions
 * so the GUI renders the paste-input field, then blocks on onManualCodeInput for the token.
 * If neither onAuth nor onManualCodeInput is available, throws a clear error.
 */
export async function loginKiro(ctrl: OAuthController): Promise<OAuthCredentials> {
  const imported = readImportedKiroCredential();
  if (imported) {
    ctrl.onProgress?.(imported.source === "json" ? "Imported token from Kiro credentials file." : "Imported token from installed kiro-cli login.");
    return {
      access: imported.access,
      refresh: imported.refresh,
      expires: imported.expires,
      source: imported.source === "json" ? "credential-file" : "local-cli",
    };
  }

  const envToken = process.env.KIRO_ACCESS_TOKEN;
  if (envToken) {
    ctrl.onProgress?.("Using KIRO_ACCESS_TOKEN from environment.");
    return { access: envToken, refresh: process.env.KIRO_REFRESH_TOKEN ?? "", expires: Date.now() + 3600_000, source: "environment" };
  }

  if (ctrl.onManualCodeInput) {
    // Resolve the login flow immediately so the GUI receives instructions and
    // shows the paste-input field. Without this, onManualCodeInput blocks
    // forever and the HTTP response never reaches the dashboard.
    ctrl.onAuth?.({
      url: "",
      instructions:
        "No kiro-cli token found. Paste a Kiro access token below (starts with 'aoa'). " +
        "Run `kiro-cli login` first, or set KIRO_ACCESS_TOKEN.",
    });
    ctrl.onProgress?.("No kiro-cli token found. Paste a Kiro access token (starts with 'aoa').");
    const raw = (await ctrl.onManualCodeInput()).trim();
    if (raw) return { access: raw, refresh: "", expires: Date.now() + 3600_000, source: "manual" };
  }

  throw new Error(
    "Kiro: no token found. Run `kiro-cli login` first (import), or set KIRO_ACCESS_TOKEN. " +
      "Browser login is not supported for Kiro.",
  );
}

/** Auth/SSO region precedence: KIRO_REGION → imported SSO region → default us-east-1. */
export function resolveKiroRegion(): string {
  if (process.env.KIRO_REGION !== undefined) return requireKiroRegion(process.env.KIRO_REGION);
  return normalizeKiroRegion(readImportedKiroCredential()?.ssoRegion) || DEFAULT_REGION;
}

/** Runtime API region precedence: KIRO_API_REGION → imported API/profile region → auth region. */
export function resolveKiroApiRegion(): string {
  const imported = readImportedKiroCredential();
  if (process.env.KIRO_API_REGION !== undefined) return requireKiroRegion(process.env.KIRO_API_REGION);
  return (
    normalizeKiroRegion(imported?.apiRegion) ||
    inferRegionFromProfileArn(imported?.profileArn) ||
    normalizeKiroRegion(imported?.ssoRegion) ||
    (process.env.KIRO_REGION !== undefined ? requireKiroRegion(process.env.KIRO_REGION) : undefined) ||
    DEFAULT_REGION
  );
}

/**
 * Resolve the CodeWhisperer profileArn for request-time use by the adapter.
 * KIRO_PROFILE_ARN env → kiro-cli SQLite `profile_arn`. Returns undefined if absent
 * (the adapter decides whether that is fatal).
 */
export function resolveKiroProfileArn(): string | undefined {
  const env = process.env.KIRO_PROFILE_ARN;
  if (env) return env;
  return readImportedKiroCredential()?.profileArn;
}

async function readTokenResponse(res: Response, oldRefresh: string): Promise<OAuthCredentials> {
  const data = (await res.json()) as { accessToken?: string; refreshToken?: string; expiresIn?: number };
  if (!data.accessToken) throw new Error("Kiro refresh returned no accessToken");
  return {
    access: data.accessToken,
    refresh: data.refreshToken || oldRefresh,
    expires: Date.now() + (data.expiresIn ?? 3600) * 1000,
  };
}

async function refreshKiroDesktopToken(refresh: string, signal?: AbortSignal): Promise<OAuthCredentials> {
  const region = resolveKiroRegion();
  const res = await fetch(REFRESH_URL.replace("{region}", region), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ refreshToken: refresh }),
    signal: signal ?? AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`Kiro token refresh failed: ${res.status}`);
  return readTokenResponse(res, refresh);
}

async function refreshAwsSsoOidcToken(refresh: string, signal?: AbortSignal): Promise<OAuthCredentials> {
  const imported = readImportedKiroCredential();
  if (!imported?.clientId || !imported.clientSecret) return refreshKiroDesktopToken(refresh, signal);
  const region = resolveKiroRegion();
  const run = async (refreshToken: string): Promise<Response> => fetch(OIDC_URL.replace("{region}", region), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grantType: "refresh_token",
      clientId: imported.clientId,
      clientSecret: imported.clientSecret,
      refreshToken,
    }),
    signal: signal ?? AbortSignal.timeout(30_000),
  });
  let res = await run(refresh);
  if (!res.ok && res.status === 400 && imported.source === "sqlite") {
    const reloaded = readImportedKiroCredential();
    if (reloaded?.refresh && reloaded.refresh !== refresh) res = await run(reloaded.refresh);
  }
  if (!res.ok) throw new Error(`Kiro AWS SSO OIDC refresh failed: ${res.status}`);
  return readTokenResponse(res, refresh);
}

export async function refreshKiroToken(refresh: string, signal?: AbortSignal): Promise<OAuthCredentials> {
  if (!refresh) throw new Error("Kiro: no refresh token available (re-run `kiro-cli login`).");
  return refreshAwsSsoOidcToken(refresh, signal);
}
