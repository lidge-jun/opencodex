import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteFile } from "../config";
import { readCodexTokens } from "./auth-collision";
import { decodeJwtPayload, extractAccountId, refreshChatGPTTokenRaw } from "../oauth/chatgpt";
import {
  CODEX_REFRESH_SKEW_MS,
  CodexCredentialRefreshBusyError,
  CodexCredentialRefreshLockTimeoutError,
  CodexCredentialRefreshStaleError,
  TokenRefreshError,
  findFreshCredentialForGrant,
  publishFreshCredentialForGrant,
  refreshGrantFingerprintForToken,
  withCodexRefreshFileLock,
} from "./account-store";
import { clearAccountNeedsReauth, markAccountNeedsReauth } from "./account-runtime-state";
import { resolveCodexHomeDir } from "./home";
import { extractChatgptPlanType } from "./plan";
import { MAIN_CODEX_ACCOUNT_ID } from "./account-id";

export { MAIN_CODEX_ACCOUNT_ID } from "./account-id";

/**
 * Main account plan (e.g. "plus", "go", "free", "team"), populated from the WHAM usage
 * fetch. Used by the rotation usage-score so go/free main accounts score on monthly
 * percent, matching pool-account behavior.
 */
let mainAccountPlan: string | null = null;
let jwtPlanAttempted = false;

interface AuthJsonShape {
  tokens?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface NativeMainRefreshDependencies {
  readonly refreshToken?: typeof refreshChatGPTTokenRaw;
}

export function setMainAccountPlan(plan: string | null): void {
  mainAccountPlan = plan;
  if (plan === null) jwtPlanAttempted = false;
}

export function getMainAccountPlan(): string | undefined {
  if (mainAccountPlan) return mainAccountPlan;
  if (jwtPlanAttempted) return undefined;
  jwtPlanAttempted = true;
  const tokens = readCodexTokens();
  const jwtPlan = tokens
    ? extractChatgptPlanType(tokens.id_token, tokens.access_token)
    : undefined;
  if (jwtPlan) mainAccountPlan = jwtPlan;
  return jwtPlan;
}

/** Read-only main account token from ~/.codex/auth.json, or null when not logged in. */
export function getMainAccountToken(): { accessToken: string; chatgptAccountId: string } | null {
  const tokens = readCodexTokens();
  if (!tokens?.access_token) return null;
  return { accessToken: tokens.access_token, chatgptAccountId: tokens.account_id };
}

function mainAccessTokenFresh(accessToken: string | undefined, now = Date.now()): boolean {
  if (!accessToken) return false;
  const payload = decodeJwtPayload(accessToken);
  const exp = typeof payload?.exp === "number" ? payload.exp * 1000 : undefined;
  return exp === undefined || exp > now + CODEX_REFRESH_SKEW_MS;
}

/**
 * The main token is usable when it exists and — if its JWT carries a decodable `exp` — is
 * not expired. When `exp` cannot be decoded we treat the token as live (best-effort); an
 * actually-invalid token then surfaces via the upstream 401 → cooldown path.
 */
export function isMainAccountTokenLive(now = Date.now()): boolean {
  const tokens = readCodexTokens();
  return mainAccessTokenFresh(tokens?.access_token, now - CODEX_REFRESH_SKEW_MS);
}

export function isMainAccountCredentialUsable(now = Date.now()): boolean {
  const token = mainTokenFromAuth(readMainAuthJson());
  return mainAccessTokenFresh(token?.accessToken, now) || !!token?.refreshToken;
}

/**
 * Strict liveness for auth-terminality decisions: true only when the access-token JWT
 * carries a decodable `exp` that is still in the future.
 *
 * Unlike {@link isMainAccountTokenLive}, an undecodable `exp` counts as NOT live here.
 * This gate decides whether a bare WHAM 401 is downgraded to a transient failure; if an
 * undecodable token could vouch for itself, a genuinely dead credential would keep every
 * 401 "transient" and needsReauth could never flip.
 */
export function isMainAccountTokenVerifiablyLive(now = Date.now()): boolean {
  const tokens = readCodexTokens();
  if (!tokens?.access_token) return false;
  const payload = decodeJwtPayload(tokens.access_token);
  const exp = typeof payload?.exp === "number" ? payload.exp * 1000 : undefined;
  return exp !== undefined && exp > now;
}

function authJsonPath(): string {
  return join(resolveCodexHomeDir(), "auth.json");
}

function readMainAuthJson(): AuthJsonShape | null {
  try {
    return JSON.parse(readFileSync(authJsonPath(), "utf-8")) as AuthJsonShape;
  } catch {
    return null;
  }
}

function persistMainAuthJson(auth: AuthJsonShape): void {
  const dir = resolveCodexHomeDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  atomicWriteFile(authJsonPath(), JSON.stringify(auth, null, 2) + "\n");
}

function mainTokenFromAuth(auth: AuthJsonShape | null): {
  accessToken: string;
  refreshToken?: string;
  refreshGrantFingerprint?: string;
  idToken?: string;
  chatgptAccountId: string;
} | null {
  const tokens = auth?.tokens;
  const accessToken = typeof tokens?.access_token === "string" ? tokens.access_token : undefined;
  if (!accessToken) return null;
  const refreshToken = typeof tokens?.refresh_token === "string" && tokens.refresh_token.trim()
    ? tokens.refresh_token.trim()
    : undefined;
  const refreshGrantFingerprint = typeof tokens?.refresh_grant_fingerprint === "string"
    ? tokens.refresh_grant_fingerprint
    : undefined;
  const idToken = typeof tokens?.id_token === "string" ? tokens.id_token : undefined;
  const storedAccountId = typeof tokens?.account_id === "string" ? tokens.account_id : "";
  return {
    accessToken,
    refreshToken,
    refreshGrantFingerprint,
    idToken,
    chatgptAccountId: storedAccountId || extractAccountId(idToken, accessToken) || "",
  };
}

function tokenRefreshReason(error: unknown): "expired" | "revoked" | "unknown" {
  if (error instanceof TokenRefreshError) return error.reason;
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("invalidated") || message.includes("invalid_grant") || message.includes("revoked")
    ? "revoked"
    : message.includes("expired")
      ? "expired"
      : "unknown";
}

function refreshedMainResult(auth: AuthJsonShape): { accessToken: string; chatgptAccountId: string } | null {
  const token = mainTokenFromAuth(auth);
  if (!token?.accessToken) return null;
  setMainAccountPlan(extractChatgptPlanType(token.idToken, token.accessToken) ?? null);
  return { accessToken: token.accessToken, chatgptAccountId: token.chatgptAccountId };
}

export async function forceRefreshMainAccountToken(
  rejectedAccessToken?: string,
  options: { signal?: AbortSignal; dependencies?: NativeMainRefreshDependencies } = {},
): Promise<{ accessToken: string; chatgptAccountId: string } | null> {
  const initial = mainTokenFromAuth(readMainAuthJson());
  if (!initial?.refreshToken) return null;
  const refreshGrantFingerprint = initial.refreshGrantFingerprint ?? refreshGrantFingerprintForToken(initial.refreshToken);
  const signal = options.signal
    ? AbortSignal.any([options.signal, AbortSignal.timeout(30_000)])
    : AbortSignal.timeout(30_000);
  try {
    const refreshed = await withCodexRefreshFileLock({
      lockKey: refreshGrantFingerprint,
      signal,
      run: async () => {
        const lockedAuth = readMainAuthJson();
        const locked = mainTokenFromAuth(lockedAuth);
        if (!lockedAuth || !locked?.refreshToken) return null;
        if (
          rejectedAccessToken
          && locked.accessToken !== rejectedAccessToken
          && mainAccessTokenFresh(locked.accessToken)
        ) {
          return refreshedMainResult(lockedAuth);
        }
        const lockedRefreshGrantFingerprint = locked.refreshGrantFingerprint ?? refreshGrantFingerprintForToken(locked.refreshToken);
        if (lockedRefreshGrantFingerprint !== refreshGrantFingerprint) {
          if (mainAccessTokenFresh(locked.accessToken)) return refreshedMainResult(lockedAuth);
          return null;
        }
        const sameGrantFreshCredential = findFreshCredentialForGrant(refreshGrantFingerprint, MAIN_CODEX_ACCOUNT_ID);
        if (sameGrantFreshCredential) {
          if (!rejectedAccessToken || sameGrantFreshCredential.accessToken !== rejectedAccessToken) {
            lockedAuth.tokens = {
              ...(lockedAuth.tokens ?? {}),
              access_token: sameGrantFreshCredential.accessToken,
              refresh_token: sameGrantFreshCredential.refreshToken,
              refresh_grant_fingerprint: refreshGrantFingerprint,
              account_id: sameGrantFreshCredential.chatgptAccountId,
            };
            persistMainAuthJson(lockedAuth);
            return refreshedMainResult(lockedAuth);
          }
        }
        const token = await (options.dependencies?.refreshToken ?? refreshChatGPTTokenRaw)(locked.refreshToken, { signal });
        const updatedAccessToken = token.access;
        const updatedRefreshToken = token.refresh || locked.refreshToken;
        publishFreshCredentialForGrant({
          refreshGrantFingerprint,
          credential: {
            accessToken: updatedAccessToken,
            refreshToken: updatedRefreshToken,
            expiresAt: token.expires,
            chatgptAccountId: token.accountId ?? extractAccountId(token.idToken, updatedAccessToken) ?? locked.chatgptAccountId,
          },
          excludeId: MAIN_CODEX_ACCOUNT_ID,
          replaceAccessToken: rejectedAccessToken,
        });
        lockedAuth.tokens = {
          ...(lockedAuth.tokens ?? {}),
          access_token: updatedAccessToken,
          refresh_token: updatedRefreshToken,
          refresh_grant_fingerprint: refreshGrantFingerprint,
          ...(token.idToken ? { id_token: token.idToken } : {}),
          account_id: token.accountId ?? extractAccountId(token.idToken, updatedAccessToken) ?? locked.chatgptAccountId,
        };
        persistMainAuthJson(lockedAuth);
        return refreshedMainResult(lockedAuth);
      },
    });
    if (refreshed) clearAccountNeedsReauth(MAIN_CODEX_ACCOUNT_ID);
    return refreshed;
  } catch (error) {
    if (
      error instanceof CodexCredentialRefreshLockTimeoutError
      || error instanceof CodexCredentialRefreshBusyError
      || error instanceof CodexCredentialRefreshStaleError
    ) {
      throw error;
    }
    if (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError")) throw error;
    const reason = tokenRefreshReason(error);
    if (reason === "expired" || reason === "revoked") markAccountNeedsReauth(MAIN_CODEX_ACCOUNT_ID);
    throw new TokenRefreshError(reason, "Codex main token refresh failed; reauthenticate the main account.");
  }
}

export async function getValidMainAccountToken(
  options: { dependencies?: NativeMainRefreshDependencies } = {},
): Promise<{ accessToken: string; chatgptAccountId: string } | null> {
  const auth = readMainAuthJson();
  const token = mainTokenFromAuth(auth);
  if (!token) return null;
  if (mainAccessTokenFresh(token.accessToken)) return { accessToken: token.accessToken, chatgptAccountId: token.chatgptAccountId };
  return forceRefreshMainAccountToken(token.accessToken, options);
}
