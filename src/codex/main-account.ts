import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { readCodexTokens } from "./auth-collision";
import {
  decodeJwtPayload,
  extractAccountId,
  refreshChatGPTToken,
} from "../oauth/chatgpt";
import type { OAuthCredentials } from "../oauth/types";
import { extractChatgptPlanType } from "./plan";
import { MAIN_CODEX_ACCOUNT_ID } from "./account-id";
import {
  refreshGrantFingerprintForToken,
  withCodexRefreshFileLock,
} from "./account-store";
import { atomicWriteFile, resolveWriteTarget } from "../config/atomic-write";
import { resolveCodexHomeDir } from "./home";
import { assertNotRealCodexHomeUnderTest } from "../lib/test-home-guard";
import { clearAccountNeedsReauth } from "./account-runtime-state";
import { advanceCodexCredentialMutationEpoch } from "./credential-mutation-epoch";
import { withNativeMainExclusiveClaim } from "./native-main-claim";
import { resolveNativeProfileContext } from "./native-profile-store";

export { MAIN_CODEX_ACCOUNT_ID } from "./account-id";

/**
 * Main account plan (e.g. "plus", "go", "free", "team"), populated from the WHAM usage
 * fetch. Used by the rotation usage-score so go/free main accounts score on monthly
 * percent, matching pool-account behavior.
 */
let mainAccountPlan: string | null = null;
let jwtPlanAttempted = false;
const MAIN_TOKEN_REFRESH_SKEW_MS = 60_000;
let beforeMainAuthJsonRenameForTests: (() => void) | null = null;

type MainAuthJsonCredential = {
  path: string;
  rawSha256: string;
  /**
   * Filesystem identity of the file the hash was taken from (#2999).
   *
   * A content hash cannot tell "unchanged" from "replaced with a file that happens to
   * hash the same", and more importantly it is read at a different instant than the
   * rename. Carrying dev+ino lets the pre-rename guard ask the sharper question: is this
   * still the same file, not merely one with the same bytes. `null` when the target could
   * not be stat'ed, which is treated as "cannot prove identity" rather than "matches".
   */
  identity: { dev: number; ino: number } | null;
  root: Record<string, unknown>;
  tokens: Record<string, unknown>;
  accessToken?: string;
  refreshToken?: string;
  chatgptAccountId: string;
};

export interface NativeMainRefreshDependencies {
  refreshToken?: (refreshToken: string, options: { signal: AbortSignal }) => Promise<OAuthCredentials>;
  signal?: AbortSignal;
}

export class MainAuthJsonChangedDuringRefreshError extends Error {
  constructor() {
    super("Codex auth.json changed while its token was refreshing");
    this.name = "MainAuthJsonChangedDuringRefreshError";
  }
}

export class MainAccountTokenRefreshError extends Error {
  constructor(readonly reason: "reauth" | "transient", options?: ErrorOptions) {
    super(reason === "reauth"
      ? "Codex main account needs reauthentication"
      : "Codex main token refresh did not complete", options);
    this.name = "MainAccountTokenRefreshError";
  }
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/**
 * Filesystem identity of a path, or null when it cannot be read.
 *
 * Null is deliberately NOT "matches anything": a caller that cannot prove identity must
 * fail closed, because the whole point here is refusing to overwrite a file we can no
 * longer vouch for.
 */
function statIdentity(path: string): { dev: number; ino: number } | null {
  try {
    const stat = statSync(path);
    return { dev: Number(stat.dev), ino: Number(stat.ino) };
  } catch {
    return null;
  }
}

function readMainAuthJsonCredential(): MainAuthJsonCredential | null {
  const path = resolveWriteTarget(join(resolveCodexHomeDir(), "auth.json"));
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const root = parsed as Record<string, unknown>;
    const tokenValue = root.tokens;
    if (!tokenValue || typeof tokenValue !== "object" || Array.isArray(tokenValue)) return null;
    const tokens = tokenValue as Record<string, unknown>;
    const accessToken = nonEmptyString(tokens.access_token);
    const refreshToken = nonEmptyString(tokens.refresh_token);
    if (!accessToken && !refreshToken) return null;
    const idToken = nonEmptyString(tokens.id_token);
    const chatgptAccountId = extractAccountId(idToken, accessToken)
      ?? nonEmptyString(tokens.account_id)
      ?? "";
    return {
      path,
      rawSha256: sha256(raw),
      identity: statIdentity(path),
      root,
      tokens,
      ...(accessToken ? { accessToken } : {}),
      ...(refreshToken ? { refreshToken } : {}),
      chatgptAccountId,
    };
  } catch {
    return null;
  }
}

function mainAccessTokenFresh(accessToken: string | undefined, now: number, skewMs: number): boolean {
  if (!accessToken) return false;
  const payload = decodeJwtPayload(accessToken);
  const exp = typeof payload?.exp === "number" ? payload.exp * 1000 : undefined;
  return exp === undefined || exp > now + skewMs;
}

/** A refresh grant makes native main routeable even when the current access token is expired. */
export function isMainAccountCredentialUsable(now = Date.now()): boolean {
  const current = readMainAuthJsonCredential();
  return !!current?.refreshToken || mainAccessTokenFresh(current?.accessToken, now, 0);
}

export function hasMainAccountRefreshGrant(): boolean {
  return !!readMainAuthJsonCredential()?.refreshToken;
}

function assertMainAuthJsonSnapshotUnchanged(expected: MainAuthJsonCredential): void {
  const current = readMainAuthJsonCredential();
  if (!current || current.path !== expected.path || current.rawSha256 !== expected.rawSha256) {
    throw new MainAuthJsonChangedDuringRefreshError();
  }
  // Identity, not just content (#2999). A writer can land between this check and the
  // rename, and rename(2) replaces unconditionally - so the narrower the question asked
  // here, the smaller the window where a Codex login gets silently overwritten. An
  // unreadable identity on either side fails closed: unprovable is not the same as equal.
  assertMainAuthJsonIdentityUnchanged(expected);
}

function assertMainAuthJsonIdentityUnchanged(expected: MainAuthJsonCredential): void {
  const identity = statIdentity(expected.path);
  if (!identity
    || !expected.identity
    || identity.dev !== expected.identity.dev
    || identity.ino !== expected.identity.ino) {
    throw new MainAuthJsonChangedDuringRefreshError();
  }
}

function persistRefreshedMainAuthJson(
  expected: MainAuthJsonCredential,
  refreshed: OAuthCredentials,
): { accessToken: string; chatgptAccountId: string } {
  assertNotRealCodexHomeUnderTest(resolveCodexHomeDir());
  const accessToken = refreshed.access;
  const refreshToken = refreshed.refresh || expected.refreshToken!;
  const chatgptAccountId = refreshed.accountId
    ?? extractAccountId(undefined, accessToken)
    ?? expected.chatgptAccountId;
  const tokens = {
    ...expected.tokens,
    access_token: accessToken,
    refresh_token: refreshToken,
    account_id: chatgptAccountId,
  };
  atomicWriteFile(
    expected.path,
    JSON.stringify({ ...expected.root, tokens }, null, 2) + "\n",
    undefined,
    {
      beforeRename: () => {
        assertMainAuthJsonSnapshotUnchanged(expected);
        const hook = beforeMainAuthJsonRenameForTests;
        beforeMainAuthJsonRenameForTests = null;
        hook?.();
      },
      // Runs immediately before rename(2), after the test hook has had its chance to
      // simulate an external writer. Full snapshot check (content AND identity): this is
      // the last look we get, so it asks everything it can rather than the cheap question.
      validateBeforeRename: () => assertMainAuthJsonSnapshotUnchanged(expected),
    },
  );
  advanceCodexCredentialMutationEpoch();
  return { accessToken, chatgptAccountId };
}

export function setMainAuthJsonBeforeRenameHookForTests(hook: (() => void) | null): void {
  beforeMainAuthJsonRenameForTests = hook;
}

async function resolveMainAccountToken(
  dependencies: NativeMainRefreshDependencies = {},
  rejectedAccessToken?: string,
): Promise<{ accessToken: string; chatgptAccountId: string } | null> {
  const initial = readMainAuthJsonCredential();
  if (!initial) return null;
  const now = Date.now();
  if (initial.accessToken !== rejectedAccessToken
    && mainAccessTokenFresh(initial.accessToken, now, MAIN_TOKEN_REFRESH_SKEW_MS)) {
    return { accessToken: initial.accessToken!, chatgptAccountId: initial.chatgptAccountId };
  }
  if (!initial.refreshToken) {
    return initial.accessToken !== rejectedAccessToken
      && mainAccessTokenFresh(initial.accessToken, now, 0)
      ? { accessToken: initial.accessToken!, chatgptAccountId: initial.chatgptAccountId }
      : null;
  }

  const refreshTimeout = AbortSignal.timeout(30_000);
  const signal = dependencies.signal
    ? AbortSignal.any([dependencies.signal, refreshTimeout])
    : refreshTimeout;
  const lockKey = refreshGrantFingerprintForToken(initial.refreshToken);
  // Two locks, because they guard two different things that live in two different
  // homes. `withCodexRefreshFileLock` is keyed on the grant fingerprint and lives
  // under OPENCODEX_HOME; it serializes refreshes of the SAME grant within one
  // install. The file being rewritten is `auth.json` under CODEX_HOME, which every
  // OpenCodex install on the machine shares no matter what its own home is -- so two
  // proxies with distinct OPENCODEX_HOMEs took two unrelated fingerprint locks and
  // refreshed the one credential concurrently (#2999).
  //
  // The outer claim is the CODEX_HOME coordination the other native-main paths
  // already use (`.opencodex-native-main.claim.sqlite`), so this needs no new
  // primitive and no FFI. Order is claim (machine-wide) then fingerprint lock
  // (per-grant), never the reverse: two processes holding different fingerprint
  // locks and then reaching for the same claim would deadlock.
  try {
    return await withNativeMainExclusiveClaim(
      resolveNativeProfileContext(),
      () => withCodexRefreshFileLock(lockKey, signal, async () => {
        const locked = readMainAuthJsonCredential();
        if (!locked) throw new MainAuthJsonChangedDuringRefreshError();
        if (!locked.refreshToken
          || refreshGrantFingerprintForToken(locked.refreshToken) !== lockKey) {
          if (locked.accessToken !== rejectedAccessToken
            && mainAccessTokenFresh(locked.accessToken, Date.now(), 0)) {
            return { accessToken: locked.accessToken!, chatgptAccountId: locked.chatgptAccountId };
          }
          throw new MainAuthJsonChangedDuringRefreshError();
        }
        if (locked.accessToken !== rejectedAccessToken
          && mainAccessTokenFresh(locked.accessToken, Date.now(), MAIN_TOKEN_REFRESH_SKEW_MS)) {
          return { accessToken: locked.accessToken!, chatgptAccountId: locked.chatgptAccountId };
        }
        const refresh = dependencies.refreshToken
          ?? ((refreshToken: string, options: { signal: AbortSignal }) => refreshChatGPTToken(refreshToken, options));
        let refreshed: OAuthCredentials;
        try {
          refreshed = await refresh(locked.refreshToken, { signal });
        } catch (cause) {
          const message = cause instanceof Error ? cause.message.toLowerCase() : "";
          const reason = /invalid_grant|invalidated|revoked|expired/.test(message)
            ? "reauth" as const
            : "transient" as const;
          throw new MainAccountTokenRefreshError(reason, { cause });
        }
        const result = persistRefreshedMainAuthJson(locked, refreshed);
        clearAccountNeedsReauth(MAIN_CODEX_ACCOUNT_ID);
        return result;
      }),
      { waitMs: 30_000, signal },
    );
  } catch (cause) {
    if (refreshTimeout.aborted && !dependencies.signal?.aborted) {
      throw new MainAccountTokenRefreshError("transient", { cause });
    }
    throw cause;
  }
}

/** Refresh the CLI-owned native credential before upstream I/O and publish it atomically. */
export function getValidMainAccountToken(
  dependencies: NativeMainRefreshDependencies = {},
): Promise<{ accessToken: string; chatgptAccountId: string } | null> {
  return resolveMainAccountToken(dependencies);
}

/** Force refresh after upstream rejected this exact bearer once. */
export function forceRefreshMainAccountToken(
  rejectedAccessToken: string,
  dependencies: NativeMainRefreshDependencies = {},
): Promise<{ accessToken: string; chatgptAccountId: string } | null> {
  return resolveMainAccountToken(dependencies, rejectedAccessToken);
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

/**
 * The main token is usable when it exists and — if its JWT carries a decodable `exp` — is
 * not expired. When `exp` cannot be decoded we treat the token as live (best-effort); an
 * actually-invalid token then surfaces via the upstream 401 → cooldown path.
 */
export function isMainAccountTokenLive(now = Date.now()): boolean {
  const tokens = readCodexTokens();
  if (!tokens?.access_token) return false;
  const payload = decodeJwtPayload(tokens.access_token);
  const exp = typeof payload?.exp === "number" ? payload.exp * 1000 : undefined;
  return exp === undefined || exp > now;
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
