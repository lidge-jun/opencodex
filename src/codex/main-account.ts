import { createHash } from "node:crypto";
import { existsSync, linkSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { readCodexTokens } from "./auth-collision";
import { clearAccountNeedsReauth, markAccountNeedsReauth } from "./account-runtime-state";
import {
  CODEX_REFRESH_SKEW_MS,
  TokenRefreshError,
  findFreshCredentialForGrant,
  findUniqueFreshCredentialForChatgptAccount,
  publishFreshCredentialForGrant,
  refreshGrantFingerprintForToken,
  withCodexRefreshFileLock,
} from "./account-store";
import {
  ChatGPTTokenRefreshError,
  decodeJwtPayload,
  extractAccountId,
  refreshChatGPTToken,
} from "../oauth/chatgpt";
import type { OAuthCredentials } from "../oauth/types";
import { extractChatgptPlanType } from "./plan";
import { MAIN_CODEX_ACCOUNT_ID } from "./account-id";
import { atomicWriteFile } from "../config";
import { assertNotRealCodexHomeUnderTest } from "../lib/test-home-guard";
import { resolveCodexHomeDir } from "./home";
import type { CodexAccountCredentials } from "../types";

export { MAIN_CODEX_ACCOUNT_ID } from "./account-id";

/**
 * Main account plan (e.g. "plus", "go", "free", "team"), populated from the WHAM usage
 * fetch. Used by the rotation usage-score so go/free main accounts score on monthly
 * percent, matching pool-account behavior.
 */
let mainAccountPlan: string | null = null;
let jwtPlanAttempted = false;
let beforeMainAuthJsonPublishForTests: (() => void) | null = null;
let beforeMainAuthJsonRenameForTests: (() => void) | null = null;
let beforeMainAuthJsonReplaceForTests: (() => void) | null = null;
let mainAuthJsonBackupSequence = 0;
const nativeMainRefreshFlights = new Map<string, Promise<{ accessToken: string; chatgptAccountId: string } | null>>();

interface AuthJsonSnapshot {
  dev: number;
  ino: number;
  mtimeMs: number;
  size: number;
  hash: string;
}

interface MainAuthJsonCredential {
  path: string;
  root: Record<string, unknown>;
  tokens: Record<string, unknown>;
  snapshot: AuthJsonSnapshot;
  accessToken?: string;
  refreshToken?: string;
  idToken?: string;
  chatgptAccountId: string;
}

type MainAuthJsonReadResult =
  | { status: "ok"; auth: MainAuthJsonCredential }
  | { status: "missing" | "invalid" | "unreadable" };

type MainAuthPersistGuardResult =
  | { status: "current"; auth: MainAuthJsonCredential }
  | { status: "adopted"; token: { accessToken: string; chatgptAccountId: string } };

export interface NativeMainRefreshDependencies {
  refreshToken?: (refreshToken: string, options: { signal?: AbortSignal }) => Promise<OAuthCredentials>;
}

export class MainAuthJsonChangedDuringRefreshError extends Error {
  readonly code = "CODEX_MAIN_AUTH_CHANGED";
  readonly retryable = true;

  constructor() {
    super("Codex main auth.json changed during refresh");
    this.name = "MainAuthJsonChangedDuringRefreshError";
  }
}

function mainAuthJsonPath(): string {
  return join(resolveCodexHomeDir(), "auth.json");
}

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function snapshotFor(path: string, raw: string): AuthJsonSnapshot {
  const stat = statSync(path);
  return {
    dev: stat.dev,
    ino: stat.ino,
    mtimeMs: stat.mtimeMs,
    size: stat.size,
    hash: createHash("sha256").update(raw).digest("hex"),
  };
}

function sameSnapshot(a: AuthJsonSnapshot, b: AuthJsonSnapshot): boolean {
  return a.dev === b.dev
    && a.ino === b.ino
    && a.mtimeMs === b.mtimeMs
    && a.size === b.size
    && a.hash === b.hash;
}

function pathErrorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code;
}

function isExistingPathError(error: unknown): boolean {
  return pathErrorCode(error) === "EEXIST";
}

function isMissingPathError(error: unknown): boolean {
  return pathErrorCode(error) === "ENOENT";
}

function assertMainAuthJsonSnapshotUnchanged(current: MainAuthJsonCredential): void {
  const latest = readMainAuthJsonCredential();
  if (latest.status !== "ok" || !sameSnapshot(latest.auth.snapshot, current.snapshot)) {
    throw new MainAuthJsonChangedDuringRefreshError();
  }
}

function readAuthJsonRaw(path: string): { raw: string; snapshot: AuthJsonSnapshot } | MainAuthJsonReadResult {
  try {
    const firstStat = statSync(path);
    const firstRaw = readFileSync(path, "utf-8");
    const secondStat = statSync(path);
    if (
      firstStat.dev === secondStat.dev
      && firstStat.ino === secondStat.ino
      && firstStat.mtimeMs === secondStat.mtimeMs
      && firstStat.size === secondStat.size
    ) {
      return { raw: firstRaw, snapshot: snapshotFor(path, firstRaw) };
    }
    const raw = readFileSync(path, "utf-8");
    return { raw, snapshot: snapshotFor(path, raw) };
  } catch (error) {
    const code = typeof error === "object" && error !== null && "code" in error
      ? (error as { code?: unknown }).code
      : undefined;
    return { status: code === "ENOENT" ? "missing" : "unreadable" };
  }
}

function authJsonSnapshotMatches(path: string, snapshot: AuthJsonSnapshot): boolean {
  const current = readAuthJsonRaw(path);
  return !("status" in current) && sameSnapshot(current.snapshot, snapshot);
}

function readMainAuthJsonCredential(): MainAuthJsonReadResult {
  const path = mainAuthJsonPath();
  const raw = readAuthJsonRaw(path);
  if ("status" in raw) return raw;
  try {
    const parsed = JSON.parse(raw.raw) as unknown;
    if (!isObject(parsed) || !isObject(parsed.tokens)) return { status: "invalid" };
    const accessToken = nonEmptyString(parsed.tokens.access_token);
    const refreshToken = nonEmptyString(parsed.tokens.refresh_token);
    if (!accessToken && !refreshToken) return { status: "invalid" };
    const idToken = nonEmptyString(parsed.tokens.id_token);
    const accountId = nonEmptyString(parsed.tokens.account_id);
    return {
      status: "ok",
      auth: {
        path,
        root: parsed,
        tokens: parsed.tokens,
        snapshot: raw.snapshot,
        ...(accessToken ? { accessToken } : {}),
        ...(refreshToken ? { refreshToken } : {}),
        ...(idToken ? { idToken } : {}),
        chatgptAccountId: extractAccountId(idToken, accessToken) ?? accountId ?? "",
      },
    };
  } catch {
    return { status: "invalid" };
  }
}

export function mainAccessTokenFresh(
  accessToken: string | undefined,
  now = Date.now(),
  skewMs = 0,
): boolean {
  if (!accessToken) return false;
  const payload = decodeJwtPayload(accessToken);
  const exp = typeof payload?.exp === "number" ? payload.exp * 1000 : undefined;
  return exp === undefined || exp > now + skewMs;
}

function tokenResultFromAuth(
  auth: MainAuthJsonCredential,
  options: { rejectedAccessToken?: string; now?: number; skewMs?: number } = {},
): { accessToken: string; chatgptAccountId: string } | null {
  if (!auth.accessToken) return null;
  if (auth.accessToken === options.rejectedAccessToken) return null;
  if (!mainAccessTokenFresh(auth.accessToken, options.now ?? Date.now(), options.skewMs ?? 0)) return null;
  return { accessToken: auth.accessToken, chatgptAccountId: auth.chatgptAccountId };
}

function tokenResultFromCredential(
  credential: CodexAccountCredentials,
): { accessToken: string; chatgptAccountId: string } {
  return { accessToken: credential.accessToken, chatgptAccountId: credential.chatgptAccountId };
}

function combineNativeRefreshSignal(signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(30_000);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

async function joinNativeMainRefreshFlight(
  flight: Promise<{ accessToken: string; chatgptAccountId: string } | null>,
  signal: AbortSignal,
): Promise<{ accessToken: string; chatgptAccountId: string } | null> {
  if (signal.aborted) throw signal.reason;
  let abortListener: (() => void) | undefined;
  const abort = new Promise<never>((_resolve, reject) => {
    abortListener = () => reject(signal.reason);
    signal.addEventListener("abort", abortListener, { once: true });
  });
  try {
    return await Promise.race([flight, abort]);
  } finally {
    if (abortListener) signal.removeEventListener("abort", abortListener);
  }
}

function tokenRefreshReason(error: unknown): "expired" | "revoked" | "unknown" {
  if (error instanceof TokenRefreshError) return error.reason;
  if (error instanceof ChatGPTTokenRefreshError) {
    const oauthError = error.oauthError?.toLowerCase();
    const description = error.oauthErrorDescription?.toLowerCase() ?? "";
    if (description.includes("expired")) return "expired";
    if (oauthError === "invalid_grant" || description.includes("revoked") || description.includes("invalidated")) {
      return "revoked";
    }
  }
  return "unknown";
}

function tokenRefreshError(error: unknown): TokenRefreshError {
  if (error instanceof TokenRefreshError) return error;
  const reason = tokenRefreshReason(error);
  return new TokenRefreshError(
    reason,
    `Codex main token refresh failed (${reason}); ${reason === "unknown" ? "retry the request" : "reauthenticate the main account"}.`,
    { cause: error },
  );
}

function refreshedCredentialFromOAuth(
  locked: MainAuthJsonCredential,
  refreshed: OAuthCredentials,
): CodexAccountCredentials {
  return {
    accessToken: refreshed.access,
    refreshToken: refreshed.refresh || locked.refreshToken!,
    expiresAt: refreshed.expires,
    chatgptAccountId: refreshed.accountId ?? extractAccountId(undefined, refreshed.access) ?? locked.chatgptAccountId,
  };
}

function mainAuthJsonCredentialMatches(
  auth: MainAuthJsonCredential,
  credential: CodexAccountCredentials,
): boolean {
  return auth.accessToken === credential.accessToken
    && auth.refreshToken === credential.refreshToken
    && nonEmptyString(auth.tokens.account_id) === credential.chatgptAccountId;
}

function assertMainAuthJsonCredentialPersisted(credential: CodexAccountCredentials): void {
  const current = readMainAuthJsonCredential();
  if (current.status !== "ok" || !mainAuthJsonCredentialMatches(current.auth, credential)) {
    throw new MainAuthJsonChangedDuringRefreshError();
  }
}

function restoreAuthJsonBackupWithoutReplacing(backupPath: string, targetPath: string): void {
  try {
    linkSync(backupPath, targetPath);
  } catch (error) {
    if (!isExistingPathError(error)) throw error;
  }
  try {
    unlinkSync(backupPath);
  } catch (error) {
    if (!isMissingPathError(error)) throw error;
  }
}

function removePublishedAuthJsonTempBestEffort(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    /* Preserve the published auth.json; throwing here would make atomic cleanup scrub a hard-linked target. */
  }
}

function replaceMainAuthJsonWithoutClobbering(
  current: MainAuthJsonCredential,
  tempPath: string,
  targetPath: string,
): void {
  const backupPath = `${targetPath}.ocx-main-auth.${process.pid}.${++mainAuthJsonBackupSequence}.bak`;
  try {
    renameSync(targetPath, backupPath);
  } catch (error) {
    if (isMissingPathError(error)) throw new MainAuthJsonChangedDuringRefreshError();
    throw error;
  }

  if (!authJsonSnapshotMatches(backupPath, current.snapshot)) {
    restoreAuthJsonBackupWithoutReplacing(backupPath, targetPath);
    throw new MainAuthJsonChangedDuringRefreshError();
  }

  const replacement = readAuthJsonRaw(tempPath);
  if ("status" in replacement) throw new Error("Codex main auth.json replacement temp was unreadable");

  try {
    linkSync(tempPath, targetPath);
  } catch (error) {
    restoreAuthJsonBackupWithoutReplacing(backupPath, targetPath);
    if (isExistingPathError(error)) throw new MainAuthJsonChangedDuringRefreshError();
    throw error;
  }
  removePublishedAuthJsonTempBestEffort(tempPath);
  removePublishedAuthJsonTempBestEffort(backupPath);
  if (!authJsonSnapshotMatches(targetPath, replacement.snapshot)) {
    throw new MainAuthJsonChangedDuringRefreshError();
  }
}

function persistMainAuthJson(
  current: MainAuthJsonCredential,
  credential: CodexAccountCredentials,
): void {
  const home = resolveCodexHomeDir();
  assertNotRealCodexHomeUnderTest(home);
  if (!existsSync(home)) mkdirSync(home, { recursive: true, mode: 0o700 });
  const tokens = {
    ...current.tokens,
    access_token: credential.accessToken,
    refresh_token: credential.refreshToken,
    account_id: credential.chatgptAccountId,
  };
  atomicWriteFile(
    current.path,
    JSON.stringify({ ...current.root, tokens }, null, 2) + "\n",
    undefined,
    {
      replace: (_tempPath, _targetPath) => {
        const hook = beforeMainAuthJsonPublishForTests;
        beforeMainAuthJsonPublishForTests = null;
        hook?.();
        assertMainAuthJsonSnapshotUnchanged(current);
        const renameHook = beforeMainAuthJsonRenameForTests;
        beforeMainAuthJsonRenameForTests = null;
        renameHook?.();
        assertMainAuthJsonSnapshotUnchanged(current);
        const replaceHook = beforeMainAuthJsonReplaceForTests;
        beforeMainAuthJsonReplaceForTests = null;
        replaceHook?.();
        replaceMainAuthJsonWithoutClobbering(current, _tempPath, _targetPath);
      },
    },
  );
}

function guardMainAuthJsonBeforePersist(
  locked: MainAuthJsonCredential,
  options: { rejectedAccessToken?: string },
): MainAuthPersistGuardResult {
  const current = readMainAuthJsonCredential();
  if (current.status === "ok" && sameSnapshot(current.auth.snapshot, locked.snapshot)) {
    return { status: "current", auth: current.auth };
  }
  if (current.status === "ok") {
    const adopted = tokenResultFromAuth(current.auth, {
      rejectedAccessToken: options.rejectedAccessToken,
      skewMs: options.rejectedAccessToken ? 0 : CODEX_REFRESH_SKEW_MS,
    });
    if (adopted) return { status: "adopted", token: adopted };
  }
  throw new MainAuthJsonChangedDuringRefreshError();
}

function freshStoredCredentialForMain(
  locked: MainAuthJsonCredential,
  refreshGrantFingerprint: string,
  rejectedAccessToken?: string,
): CodexAccountCredentials | null {
  const sameGrantCredential = findFreshCredentialForGrant({
    refreshGrantFingerprint,
    excludeId: MAIN_CODEX_ACCOUNT_ID,
  });
  if (sameGrantCredential && sameGrantCredential.accessToken !== rejectedAccessToken) return sameGrantCredential;
  const sameAccountCredential = findUniqueFreshCredentialForChatgptAccount({
    chatgptAccountId: locked.chatgptAccountId,
    excludeId: MAIN_CODEX_ACCOUNT_ID,
  });
  if (sameAccountCredential && sameAccountCredential.accessToken !== rejectedAccessToken) return sameAccountCredential;
  return null;
}

function persistMainStoredCredential(
  locked: MainAuthJsonCredential,
  credential: CodexAccountCredentials,
  rejectedAccessToken?: string,
): { accessToken: string; chatgptAccountId: string } {
  const guard = guardMainAuthJsonBeforePersist(locked, { rejectedAccessToken });
  if (guard.status === "adopted") return guard.token;
  try {
    persistMainAuthJson(guard.auth, credential);
    assertMainAuthJsonCredentialPersisted(credential);
  } catch (error) {
    return adoptFreshMainAuthJsonAfterPersistRace(error, rejectedAccessToken);
  }
  clearAccountNeedsReauth(MAIN_CODEX_ACCOUNT_ID);
  return tokenResultFromCredential(credential);
}

function adoptFreshMainAuthJsonAfterPersistRace(
  error: unknown,
  rejectedAccessToken?: string,
): { accessToken: string; chatgptAccountId: string } {
  if (!(error instanceof MainAuthJsonChangedDuringRefreshError)) throw error;
  const current = readMainAuthJsonCredential();
  if (current.status === "ok") {
    const adopted = tokenResultFromAuth(current.auth, {
      rejectedAccessToken,
      skewMs: rejectedAccessToken ? 0 : CODEX_REFRESH_SKEW_MS,
    });
    if (adopted) return adopted;
  }
  throw error;
}

export function setMainAuthJsonPublishHookForTests(hook: (() => void) | null): void {
  beforeMainAuthJsonPublishForTests = hook;
}

export function setMainAuthJsonRenameHookForTests(hook: (() => void) | null): void {
  beforeMainAuthJsonRenameForTests = hook;
}

export function setMainAuthJsonReplaceHookForTests(hook: (() => void) | null): void {
  beforeMainAuthJsonReplaceForTests = hook;
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
  const result = readMainAuthJsonCredential();
  if (result.status !== "ok" || !result.auth.accessToken) return null;
  return { accessToken: result.auth.accessToken, chatgptAccountId: result.auth.chatgptAccountId };
}

/**
 * The main token is usable when it exists and — if its JWT carries a decodable `exp` — is
 * not expired. When `exp` cannot be decoded we treat the token as live (best-effort); an
 * actually-invalid token then surfaces via the upstream 401 → cooldown path.
 */
export function isMainAccountTokenLive(now = Date.now()): boolean {
  const result = readMainAuthJsonCredential();
  if (result.status !== "ok") return false;
  return mainAccessTokenFresh(result.auth.accessToken, now);
}

/** A main account is routeable when it has a live access token or a refresh grant. */
export function isMainAccountCredentialUsable(now = Date.now()): boolean {
  const result = readMainAuthJsonCredential();
  if (result.status !== "ok") return false;
  if (result.auth.refreshToken) return true;
  return mainAccessTokenFresh(result.auth.accessToken, now);
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
  const result = readMainAuthJsonCredential();
  if (result.status !== "ok" || !result.auth.accessToken) return false;
  const payload = decodeJwtPayload(result.auth.accessToken);
  const exp = typeof payload?.exp === "number" ? payload.exp * 1000 : undefined;
  return exp !== undefined && exp > now;
}

export async function forceRefreshMainAccountToken(
  rejectedAccessToken?: string,
  options: { signal?: AbortSignal; dependencies?: NativeMainRefreshDependencies } = {},
): Promise<{ accessToken: string; chatgptAccountId: string } | null> {
  const initial = readMainAuthJsonCredential();
  if (initial.status !== "ok") return null;
  const initialFresh = tokenResultFromAuth(initial.auth, {
    rejectedAccessToken,
    skewMs: rejectedAccessToken ? 0 : CODEX_REFRESH_SKEW_MS,
  });
  if (initialFresh && !initial.auth.refreshToken) return initialFresh;
  if (!initial.auth.refreshToken) return null;

  const lockKey = refreshGrantFingerprintForToken(initial.auth.refreshToken);
  const signal = combineNativeRefreshSignal(options.signal);
  try {
    const existingFlight = nativeMainRefreshFlights.get(lockKey);
    if (existingFlight) {
      const joined = await joinNativeMainRefreshFlight(existingFlight, signal);
      if (joined?.accessToken === rejectedAccessToken) {
        return forceRefreshMainAccountToken(rejectedAccessToken, options);
      }
      return joined;
    }
    const refreshFlight = withCodexRefreshFileLock(lockKey, signal, async () => {
      const locked = readMainAuthJsonCredential();
      if (locked.status !== "ok") throw new MainAuthJsonChangedDuringRefreshError();
      if (!locked.auth.refreshToken) throw new MainAuthJsonChangedDuringRefreshError();
      if (refreshGrantFingerprintForToken(locked.auth.refreshToken) !== lockKey) {
        throw new MainAuthJsonChangedDuringRefreshError();
      }
      const lockedFresh = tokenResultFromAuth(locked.auth, {
        rejectedAccessToken,
        skewMs: rejectedAccessToken ? 0 : CODEX_REFRESH_SKEW_MS,
      });
      if (lockedFresh) return lockedFresh;

      const storedCredential = freshStoredCredentialForMain(locked.auth, lockKey, rejectedAccessToken);
      if (storedCredential) return persistMainStoredCredential(locked.auth, storedCredential, rejectedAccessToken);

      const refresh = options.dependencies?.refreshToken ?? refreshChatGPTToken;
      const refreshed = await refresh(locked.auth.refreshToken, { signal });
      const guard = guardMainAuthJsonBeforePersist(locked.auth, { rejectedAccessToken });
      if (guard.status === "adopted") return guard.token;
      const credential = refreshedCredentialFromOAuth(locked.auth, refreshed);
      try {
        persistMainAuthJson(guard.auth, credential);
        assertMainAuthJsonCredentialPersisted(credential);
      } catch (error) {
        return adoptFreshMainAuthJsonAfterPersistRace(error, rejectedAccessToken);
      }
      publishFreshCredentialForGrant({
        refreshGrantFingerprint: lockKey,
        credential,
        excludeId: MAIN_CODEX_ACCOUNT_ID,
      });
      clearAccountNeedsReauth(MAIN_CODEX_ACCOUNT_ID);
      return tokenResultFromCredential(credential);
    }).finally(() => {
      if (nativeMainRefreshFlights.get(lockKey) === refreshFlight) nativeMainRefreshFlights.delete(lockKey);
    });
    nativeMainRefreshFlights.set(lockKey, refreshFlight);
    return await refreshFlight;
  } catch (error) {
    if (error instanceof MainAuthJsonChangedDuringRefreshError) throw error;
    const refreshError = tokenRefreshError(error);
    if (refreshError.reason !== "unknown") markAccountNeedsReauth(MAIN_CODEX_ACCOUNT_ID);
    throw refreshError;
  }
}

export async function getValidMainAccountToken(
  options: { signal?: AbortSignal; dependencies?: NativeMainRefreshDependencies } = {},
): Promise<{ accessToken: string; chatgptAccountId: string } | null> {
  const result = readMainAuthJsonCredential();
  if (result.status !== "ok") return null;
  const fresh = tokenResultFromAuth(result.auth, { skewMs: CODEX_REFRESH_SKEW_MS });
  if (fresh) return fresh;
  const liveWithoutRefresh = tokenResultFromAuth(result.auth);
  if (liveWithoutRefresh && !result.auth.refreshToken) return liveWithoutRefresh;
  return forceRefreshMainAccountToken(result.auth.accessToken, options);
}
