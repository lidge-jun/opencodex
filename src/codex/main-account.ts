import { publishCredentialSync } from "../local-credentials/generation";
import { captureMainAccountIdentityGeneration, getMainQuotaCredentialGeneration, isMainAccountIdentityGenerationLive, isMainQuotaWriterLive, matchesMainQuotaCredential, observeMainDecisionCredentialUsable, type MainQuotaWriter } from "./main-account-cache";
import { classifyChatgptRefreshFailure, noteChatgptRefreshFailure } from "./chatgpt-refresh-failure";
import { readBoundedResponseBody } from "../lib/bounded-body";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { readCodexTokens } from "./auth-collision";
import {
  CHATGPT_CLIENT_ID,
  CHATGPT_TOKEN_URL,
  credsFromToken,
  decodeJwtPayload,
  extractAccountId,
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
import {
  clearAccountNeedsReauth,
  isMainRefreshGrantRejected,
  markMainRefreshGrantRejected,
  clearMainRefreshGrantRejection,
} from "./account-runtime-state";
import { advanceCodexCredentialMutationEpoch } from "./credential-mutation-epoch";
import { withNativeMainExclusiveClaim } from "./native-main-claim";
import { resolveNativeProfileContext } from "./native-profile-store";
import { NativeProfileError } from "./native-profile-types";
import { isNativeMainTrafficBlocked } from "./native-profile-startup";
import { loadConfig } from "../config";
import {
  requestCodexAuthStatus,
  resolveNativeMainRefreshMode,
  type CodexAuthStatus,
} from "./native-main-refresh-mode";

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
let codexOwnedMainCredential: { home: string; expiresAt: number } | null = null;
export type MainAccountToken = Readonly<{ accessToken: string; chatgptAccountId: string }>;
const codexOwnedQuotaWriters = new WeakMap<MainAccountToken, { writer: MainQuotaWriter; home: string; credentialGeneration: number }>();

/** Exact RPC result provenance; copied/request-created tokens cannot recapture native quota ownership. */
export function mainAccountTokenQuotaWriter(token: MainAccountToken): MainQuotaWriter | undefined {
  return codexOwnedQuotaWriters.get(token)?.writer;
}

/** A metadata probe may use only the exact owned observation while its home and credential remain current. */
export function mainAccountTokenIsCurrent(token: MainAccountToken): boolean {
  const proof = codexOwnedQuotaWriters.get(token);
  return proof !== undefined && proof.home === resolveCodexHomeDir()
    && codexOwnedMainCredential?.home === proof.home
    && codexOwnedMainCredential.expiresAt > Date.now()
    && proof.credentialGeneration === getMainQuotaCredentialGeneration()
    && isMainQuotaWriterLive(proof.writer)
    && matchesMainQuotaCredential(token.accessToken, token.chatgptAccountId);
}

function forgetCodexOwnedMainUsability(home: string): void {
  if (codexOwnedMainCredential?.home === home) codexOwnedMainCredential = null;
}

type MainAuthJsonCredential = {
  path: string;
  rawSha256: string;
  /**
   * Filesystem identity of the file the hash was taken from. It catches a writer that
   * replaces auth.json by rename with identical bytes. It does not see Codex's own writes:
   * Codex rewrites auth.json in place (truncate + write), which keeps dev and ino, so only
   * the content hash notices those, and only once the new bytes are visible (#2999).
   * `null` when the target could not be stat'ed, which fails closed.
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
  /** Codex-mode seam: one app-server `getAuthStatus` call. Used only when Codex owns the refresh. */
  codexAuthStatus?: (options: { refresh: boolean; signal: AbortSignal }) => Promise<CodexAuthStatus>;
  signal?: AbortSignal;
  /** Metadata-only refresh must not retract a concurrent traffic reauth quarantine. */
  preserveReauth?: boolean;
}

export class MainAuthJsonChangedDuringRefreshError extends Error {
  constructor() {
    super("Codex auth.json changed while its token was refreshing");
    this.name = "MainAuthJsonChangedDuringRefreshError";
  }
}

export class MainAccountTokenRefreshError extends Error {
  readonly credentialObservedAbsent: boolean;
  constructor(readonly reason: "reauth" | "transient", options?: ErrorOptions & { credentialObservedAbsent?: boolean }) {
    super(reason === "reauth"
      ? "Codex main account needs reauthentication"
      : "Codex main token refresh did not complete", options);
    this.name = "MainAccountTokenRefreshError";
    this.credentialObservedAbsent = options?.credentialObservedAbsent === true;
  }
}

/**
 * The native-main refresh, posted here rather than through `refreshChatGPTToken` so the token
 * endpoint's structured `error` code survives to {@link classifyChatgptRefreshFailure}.
 *
 * `refreshChatGPTToken` collapses the refusal into one display string, and classifying a grant
 * from that string is what let `refresh_token_reused` pass as transient -- the grant never
 * retired, every request re-earning its own 401 -- while a 5xx whose description merely read
 * "session expired" passed as proof and would have retired a live grant.
 *
 * Same endpoint, client id and grant type as every other ChatGPT refresh, and the success path
 * is `credsFromToken` itself, so only the failure branch differs: it classifies by code, exactly
 * as the stored-pool refresh does.
 */
async function refreshNativeMainGrant(
  refreshToken: string,
  options: { signal: AbortSignal },
): Promise<OAuthCredentials> {
  const resp = await fetch(CHATGPT_TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({
      client_id: CHATGPT_CLIENT_ID,
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    }),
    signal: options.signal,
  });
  if (!resp.ok) {
    const body = await readBoundedResponseBody(resp, { signal: options.signal, maxBytes: 16_384, fatalUtf8: true })
      .catch(() => undefined);
    const failure = classifyChatgptRefreshFailure(resp.status, body?.displaySafe ? body.text : "");
    noteChatgptRefreshFailure("native main", resp.status, failure);
    throw new MainAccountTokenRefreshError(failure.reason === "unknown" ? "transient" : "reauth");
  }
  let credentials: OAuthCredentials;
  try {
    credentials = credsFromToken((await resp.json()) as Record<string, unknown>);
  } catch {
    if (options.signal.aborted) throw options.signal.reason;
    noteNativeMainRefresh("transient", resp.status);
    // Parsing errors may include provider body text; retain only the fixed verdict.
    throw new MainAccountTokenRefreshError("transient");
  }
  noteNativeMainRefresh("ok", resp.status);
  return credentials;
}

/**
 * One line per native-main refresh verdict, so a dead grant is diagnosable from service.log.
 *
 * A revoked session is invisible from the outside: the grant is refused, nothing is written, and
 * the request fails with a status that looks like every other 401. Carries the token endpoint's
 * HTTP status and its structured `error` code and nothing else -- never a token, never a body.
 */
function noteNativeMainRefresh(outcome: string, status?: number, code?: string): void {
  console.warn(
    `[codex] native main refresh: ${outcome}`
      + (status === undefined ? "" : ` status=${status}`)
      + ` code=${code && /^[A-Za-z0-9._-]{1,64}$/.test(code) ? code : "none"}`,
  );
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
function mainRefreshGrantKey(current: MainAuthJsonCredential): string | undefined {
  return current.refreshToken
    ? `${current.path}:${refreshGrantFingerprintForToken(current.refreshToken)}` : undefined;
}

function credentialRefreshGrantRejected(current: MainAuthJsonCredential | null): boolean {
  const key = current && mainRefreshGrantKey(current);
  return !!key && isMainRefreshGrantRejected(key);
}

export interface MainAccountCredentialStatus {
  refreshGrantRejected: boolean;
  hasRefreshGrant: boolean;
  usable: boolean;
}

/** One owned physical observation; no credential material escapes this view. */
export function getMainAccountCredentialStatus(now = Date.now()): MainAccountCredentialStatus {
  const current = readMainAuthJsonCredential();
  const owned = !current && codexOwnedMainCredential?.home === resolveCodexHomeDir() ? codexOwnedMainCredential : null;
  const refreshGrantRejected = credentialRefreshGrantRejected(current);
  const hasRefreshGrant = !!current?.refreshToken && !refreshGrantRejected;
  const ownedUsable = !!owned && owned.expiresAt > now;
  const usable = !refreshGrantRejected
    && (hasRefreshGrant || mainAccessTokenFresh(current?.accessToken, now, 0) || ownedUsable);
  observeMainDecisionCredentialUsable(usable);
  return {
    refreshGrantRejected,
    hasRefreshGrant,
    usable,
  };
}

/** Current owned profile only; callers must hold the native read/selection permission. */
export function isMainAccountRefreshGrantRejected(): boolean {
  return getMainAccountCredentialStatus().refreshGrantRejected;
}

export function isMainAccountCredentialUsable(now = Date.now()): boolean {
  return getMainAccountCredentialStatus(now).usable;
}

export function hasMainAccountRefreshGrant(): boolean {
  return getMainAccountCredentialStatus().hasRefreshGrant;
}

function assertMainAuthJsonSnapshotUnchanged(expected: MainAuthJsonCredential): void {
  const current = readMainAuthJsonCredential();
  if (!current || current.path !== expected.path || current.rawSha256 !== expected.rawSha256) {
    throw new MainAuthJsonChangedDuringRefreshError();
  }
  // Also refuse a rename-based replacement with identical bytes. An unreadable identity on
  // either side fails closed. This narrows the window; rename(2) still replaces
  // unconditionally after this check returns.
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
  const { chatgptAccountId } = inFlightMainAccountToken(expected, refreshed);
  const tokens = {
    ...expected.tokens,
    access_token: accessToken,
    refresh_token: refreshToken,
    account_id: chatgptAccountId,
  };
  publishCredentialSync(() => atomicWriteFile(
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
  ));
  advanceCodexCredentialMutationEpoch();
  return { accessToken, chatgptAccountId };
}

export function setMainAuthJsonBeforeRenameHookForTests(hook: (() => void) | null): void {
  beforeMainAuthJsonRenameForTests = hook;
}

/** Complete token set a native device reauth commits into the main slot (#3898). */
export interface NativeMainReauthTokens {
  accessToken: string;
  refreshToken: string;
  idToken: string;
  chatgptAccountId: string;
}

export class NativeMainReauthUnavailableError extends Error {
  constructor(message = "Native main credential cannot be reauthenticated in this state") {
    super(message);
    this.name = "NativeMainReauthUnavailableError";
  }
}

export class NativeMainReauthIdentityMismatchError extends Error {
  constructor() {
    super("Device login completed for a different ChatGPT account than the native main identity");
    this.name = "NativeMainReauthIdentityMismatchError";
  }
}

/**
 * The reauth twin of persistRefreshedMainAuthJson (#3898). That function
 * spreads expected.tokens and never writes id_token, which would keep the
 * OLD identity token beside the new grant; this sibling sets all four
 * credential fields together and overwrites any prior id_token. Everything
 * else — allowed root metadata, the pre-rename snapshot guards, the
 * mutation epoch — follows the refresh path exactly.
 */
function persistNativeMainReauthTokens(
  expected: MainAuthJsonCredential,
  tokens: NativeMainReauthTokens,
): void {
  assertNotRealCodexHomeUnderTest(resolveCodexHomeDir());
  const nextTokens = {
    ...expected.tokens,
    access_token: tokens.accessToken,
    refresh_token: tokens.refreshToken,
    id_token: tokens.idToken,
    account_id: tokens.chatgptAccountId,
  };
  atomicWriteFile(
    expected.path,
    JSON.stringify({ ...expected.root, tokens: nextTokens }, null, 2) + "\n",
    undefined,
    {
      beforeRename: () => {
        assertMainAuthJsonSnapshotUnchanged(expected);
        const hook = beforeMainAuthJsonRenameForTests;
        beforeMainAuthJsonRenameForTests = null;
        hook?.();
      },
      validateBeforeRename: () => assertMainAuthJsonSnapshotUnchanged(expected),
    },
  );
  advanceCodexCredentialMutationEpoch();
}

/**
 * Prepare a same-identity reauth of the native __main__ slot (#3898).
 *
 * The existing credential snapshot is captured NOW and held only inside the
 * closure — callers (the device-reauth service) never see the expected
 * account id, so a flow cannot be steered toward a different identity. No
 * claim is held while the human completes the device page. The returned
 * commit, called once the device grant exists:
 *
 *  1. requires the SAME chatgpt account identity as the snapshot;
 *  2. acquires the owner-independent exclusive claim (native-main-claim) —
 *     deliberately NOT assertNativeMainOwner, which a headless hub cannot
 *     satisfy;
 *  3. re-verifies the snapshot (path + hash + dev/ino) inside the claim;
 *  4. writes access/refresh/id token + account_id atomically and clears the
 *     main account's reauth quarantine for the new credential generation.
 */
export function beginNativeMainReauth(): {
  commit: (
    tokens: NativeMainReauthTokens,
    options?: { signal?: AbortSignal },
  ) => Promise<{ chatgptAccountId: string }>;
} {
  const expected = readMainAuthJsonCredential();
  if (!expected || !expected.chatgptAccountId) {
    throw new NativeMainReauthUnavailableError(
      "No native main credential exists to reauthenticate; enrollment is the native profile workflow",
    );
  }
  return {
    async commit(
      tokens: NativeMainReauthTokens,
      options: { signal?: AbortSignal } = {},
    ): Promise<{ chatgptAccountId: string }> {
      if (!tokens.accessToken || !tokens.refreshToken || !tokens.idToken) {
        throw new NativeMainReauthUnavailableError("Device grant did not produce a complete token set");
      }
      if (tokens.chatgptAccountId !== expected.chatgptAccountId) {
        throw new NativeMainReauthIdentityMismatchError();
      }
      return withNativeMainExclusiveClaim(resolveNativeProfileContext(), async () => {
        // Recovery/admission recheck (080): a recovery-blocked or not-ready
        // home fails native_main_unavailable rather than rewriting auth.json
        // underneath the gate. The claim waits bounded like the refresh path
        // (30s) so a busy claim is not an instant refusal.
        if (isNativeMainTrafficBlocked()) {
          throw new NativeMainReauthUnavailableError(
            "Native main traffic is blocked by startup or recovery state",
          );
        }
        if (options.signal?.aborted) throw options.signal.reason;
        assertMainAuthJsonSnapshotUnchanged(expected);
        persistNativeMainReauthTokens(expected, tokens);
        clearAccountNeedsReauth(MAIN_CODEX_ACCOUNT_ID);
        return { chatgptAccountId: tokens.chatgptAccountId };
      }, { waitMs: 30_000, signal: options.signal });
    },
  };
}

/**
 * True only when CODEX_HOME provably does not exist: the resolved path itself
 * has no directory entry and the nearest existing ancestor resolves to a real
 * directory. resolve() normalizes the string without dereferencing links, so
 * lstat sees each component itself -- an existing entry still counts as
 * existing, and a link in the chain must stat to a directory before the absence
 * below it counts as genuine. EACCES, a file where a directory belongs, and a
 * dangling link all stay unproven, which keeps the caller fail closed.
 */
function codexHomeProvenMissing(codexHome: string): boolean {
  const target = resolve(codexHome);
  let cursor = target;
  for (;;) {
    try {
      lstatSync(cursor);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") return false;
      const parent = dirname(cursor);
      if (parent === cursor) return false;
      cursor = parent;
    }
  }
  if (cursor === target) return false;
  try {
    return statSync(cursor).isDirectory();
  } catch {
    return false;
  }
}

/** Resolve the main account access token from the owned auth.json read, refreshing through the token endpoint when needed, or return null when no usable credential exists. */
async function resolveMainAccountToken(
  dependencies: NativeMainRefreshDependencies = {},
  rejectedAccessToken?: string,
): Promise<{ accessToken: string; chatgptAccountId: string } | null> {
  if (dependencies.signal?.aborted) throw dependencies.signal.reason;
  const codexHome = resolveCodexHomeDir();
  const initial = readMainAuthJsonCredential();
  // Every skip below ends a forced refresh WITHOUT asking the token endpoint anything, which from
  // the outside is indistinguishable from a refusal: same failed request, no write, no verdict.
  // A forced refresh is the only caller that passes `rejectedAccessToken`, so only it reports.
  if (!initial) {
    const refreshMode = await resolveNativeMainRefreshMode(loadConfig());
    if (refreshMode.mode === "codex") {
      const refreshTimeout = AbortSignal.timeout(30_000);
      const signal = dependencies.signal
        ? AbortSignal.any([dependencies.signal, refreshTimeout])
        : refreshTimeout;
      try {
        return await withNativeMainExclusiveClaim(resolveNativeProfileContext({ codexHome }), () => refreshThroughCodex(
          null, rejectedAccessToken, dependencies, refreshTimeout,
          dependencies.codexAuthStatus ?? (options => requestCodexAuthStatus(refreshMode.command!, { ...options, codexHome })),
          codexHome, rejectedAccessToken !== undefined,
        ), { waitMs: 30_000, signal });
      } catch (cause) {
        forgetCodexOwnedMainUsability(codexHome);
        // A proven-absent home is the same observed absence as a missing
        // auth.json: no credential exists to claim or to refresh. Every other
        // CODEX_HOME_UNAVAILABLE cause -- an entry that exists but cannot be
        // verified, a dangling link, an untraversable parent -- stays fail
        // closed; a blanket existsSync check would misclassify them as absence.
        if (cause instanceof NativeProfileError && cause.code === "CODEX_HOME_UNAVAILABLE"
          && codexHomeProvenMissing(codexHome)) {
          // Mode discovery awaited: absence must still belong to this caller and home.
          dependencies.signal?.throwIfAborted();
          if (resolveCodexHomeDir() !== codexHome) throw new MainAuthJsonChangedDuringRefreshError();
          if (rejectedAccessToken !== undefined) noteNativeMainRefresh("skipped-no-credential");
          return null;
        }
        if (refreshTimeout.aborted && !dependencies.signal?.aborted) {
          throw new MainAccountTokenRefreshError("transient", { cause });
        }
        throw cause;
      }
    }
    forgetCodexOwnedMainUsability(codexHome);
    if (rejectedAccessToken !== undefined) noteNativeMainRefresh("skipped-no-credential");
    return null;
  }
  if (credentialRefreshGrantRejected(initial)) throw new MainAccountTokenRefreshError("reauth");
  const now = Date.now();
  if (initial.accessToken !== rejectedAccessToken
    && mainAccessTokenFresh(initial.accessToken, now, MAIN_TOKEN_REFRESH_SKEW_MS)) {
    // The stored credential is no longer the one upstream rejected: somebody else replaced it
    // while this request was in flight, so there is nothing here to refresh or to retire.
    if (rejectedAccessToken !== undefined) noteNativeMainRefresh("skipped-credential-replaced");
    return { accessToken: initial.accessToken!, chatgptAccountId: initial.chatgptAccountId };
  }
  if (!initial.refreshToken) {
    if (rejectedAccessToken !== undefined) noteNativeMainRefresh("skipped-no-refresh-grant");
    return initial.accessToken !== rejectedAccessToken
      && mainAccessTokenFresh(initial.accessToken, now, 0)
      ? { accessToken: initial.accessToken!, chatgptAccountId: initial.chatgptAccountId }
      : null;
  }

  const refreshTimeout = AbortSignal.timeout(30_000);
  const signal = dependencies.signal
    ? AbortSignal.any([dependencies.signal, refreshTimeout])
    : refreshTimeout;
  // An injected exchange is the guarded writer by definition. Otherwise Codex refreshes its own
  // login whenever a supported binary exists, unless the operator chose "opencodex" (#2999).
  const refreshMode = dependencies.refreshToken
    ? null
    : await resolveNativeMainRefreshMode(loadConfig());
  if (signal.aborted) throw signal.reason;
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
      resolveNativeProfileContext({ codexHome }),
      () => withCodexRefreshFileLock(lockKey, signal, async () => {
        if (resolveCodexHomeDir() !== codexHome) throw new MainAuthJsonChangedDuringRefreshError();
        const locked = readMainAuthJsonCredential();
        if (!locked) throw new MainAuthJsonChangedDuringRefreshError();
        if (credentialRefreshGrantRejected(locked)) throw new MainAccountTokenRefreshError("reauth");
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
        if (refreshMode?.mode === "codex") {
          const command = refreshMode.command!;
          return refreshThroughCodex(locked, rejectedAccessToken, dependencies, refreshTimeout,
            dependencies.codexAuthStatus ?? (options => requestCodexAuthStatus(command, { ...options, codexHome })), codexHome);
        }
        const refresh = dependencies.refreshToken ?? refreshNativeMainGrant;
        let refreshed: OAuthCredentials;
        if (signal.aborted) throw signal.reason;
        try {
          refreshed = await refresh(locked.refreshToken, { signal: refreshTimeout });
        } catch (cause) {
          // A refusal already classified at the endpoint keeps that verdict. An injected refresh
          // threw an ordinary Error and has only its message, so prose still decides there --
          // and only there, where there is no structured code to read.
          const message = cause instanceof Error ? cause.message.toLowerCase() : "";
          const reason = cause instanceof MainAccountTokenRefreshError
            ? cause.reason
            : dependencies.refreshToken && /invalid_grant|invalidated|revoked|expired/.test(message)
              ? "reauth" as const
              : "transient" as const;
          // The shared point every request path reaches a terminal native-main verdict through:
          // the forced refresh after an upstream 401, the pre-send refresh of an expired bearer,
          // and the compact twin all land here. Recording the quarantine at the callers instead
          // left the native main slot alone unrecorded -- `refreshNativeMainForwardAuth` has no
          // `quarantine` flag for its caller to act on the way the stored-pool twin does -- so a
          // revoked session stayed `needsReauth: false` and every request re-earned its own 401.
          if (signal.aborted) throw signal.reason;
          if (reason === "reauth") {
            assertMainAuthJsonSnapshotUnchanged(locked);
            markMainRefreshGrantRejected(mainRefreshGrantKey(locked)!); observeMainDecisionCredentialUsable(false);
          }
          throw new MainAccountTokenRefreshError(reason, { cause });
        }
        // Once the exchange starts, only its own timeout may abort it: a successful
        // rotating grant retires the old refresh token. Save the only live grant before
        // honoring caller cancellation, while retaining the external-writer guards.
        let result: { accessToken: string; chatgptAccountId: string };
        try {
          result = persistRefreshedMainAuthJson(locked, refreshed);
        } catch (cause) {
          if (!(cause instanceof MainAuthJsonChangedDuringRefreshError)) throw cause;
          // Another writer owns auth.json now (#2999). The exchange already succeeded, so
          // failing the request would waste it. Serve the new access token to this request
          // only: leave the file as the other writer left it, keep nothing as the main
          // credential, and do not retire the grant.
          noteNativeMainRefresh("publish-refused-served-in-flight");
          if (dependencies.signal?.aborted) throw dependencies.signal.reason;
          return inFlightMainAccountToken(locked, refreshed);
        }
        // A permitted in-flight success speaks only for its own profile and grant.
        clearMainRefreshGrantRejection(mainRefreshGrantKey(locked)!);
        if (dependencies.preserveReauth !== true) clearAccountNeedsReauth(MAIN_CODEX_ACCOUNT_ID);
        if (dependencies.signal?.aborted) throw dependencies.signal.reason;
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

/** The refreshed bearer for one request whose save was refused; never stored anywhere. */
function inFlightMainAccountToken(
  expected: MainAuthJsonCredential,
  refreshed: OAuthCredentials,
): { accessToken: string; chatgptAccountId: string } {
  return {
    accessToken: refreshed.access,
    chatgptAccountId: refreshed.accountId
      ?? extractAccountId(undefined, refreshed.access)
      ?? expected.chatgptAccountId,
  };
}

/**
 * Codex mode (#2999): Codex refreshes and stores its own login; OpenCodex only uses the bearer.
 *
 * auth.json is not read again after the call. In keyring mode Codex deletes the file once the
 * keyring save succeeds, so the RPC answer is the only place the new token exists for us.
 * The call runs on the refresh timeout alone: killing app-server mid-exchange could retire
 * the grant before Codex saves its successor.
 *
 * Returns null when an ordinary read (no locked file credential, nothing upstream rejected)
 * observes that Codex has no ChatGPT login at all -- an observed absence, not a refresh failure.
 */
async function refreshThroughCodex(
  locked: MainAuthJsonCredential | null,
  rejectedAccessToken: string | undefined,
  dependencies: NativeMainRefreshDependencies,
  refreshTimeout: AbortSignal,
  authStatus: NonNullable<NativeMainRefreshDependencies["codexAuthStatus"]>,
  codexHome: string,
  refresh = true,
): Promise<{ accessToken: string; chatgptAccountId: string } | null> {
  // Deferred to keep lifecycle's cache/plan cleanup off this module's load-time import cycle.
  const { observeCodexOwnedMainAccountCredential } = await import("./account-lifecycle");
  if (resolveCodexHomeDir() !== codexHome) throw new MainAuthJsonChangedDuringRefreshError();
  const identityGeneration = captureMainAccountIdentityGeneration();
  // This observation is only selection evidence. A later request must ask Codex again:
  // JWT expiry cannot detect logout or an external keyring account switch.
  forgetCodexOwnedMainUsability(codexHome);
  let status: CodexAuthStatus;
  let didRefresh = refresh;
  try {
    const readSignal = dependencies.signal ? AbortSignal.any([dependencies.signal, refreshTimeout]) : refreshTimeout;
    status = await authStatus({ refresh, signal: refresh ? refreshTimeout : readSignal });
    if (!refresh && status.authMethod === "chatgpt" && status.authToken
      && !mainAccessTokenFresh(status.authToken, Date.now(), MAIN_TOKEN_REFRESH_SKEW_MS)) {
      dependencies.signal?.throwIfAborted();
      didRefresh = true;
      status = await authStatus({ refresh: true, signal: refreshTimeout });
    }
  } catch (cause) {
    if (!refresh && dependencies.signal?.aborted) throw dependencies.signal.reason;
    noteNativeMainRefresh("codex-unavailable");
    throw new MainAccountTokenRefreshError("transient", { cause });
  }
  if (resolveCodexHomeDir() !== codexHome || !isMainAccountIdentityGenerationLive(identityGeneration)) {
    throw new MainAuthJsonChangedDuringRefreshError();
  }
  if (status.authMethod === "chatgpt" && !status.authToken) {
    // A keyring answer is authoritative for this lookup only. Keep the existing file-backed
    // grant rejection, but retain no keyring refusal that could override a later RPC answer.
    noteNativeMainRefresh("codex-reauth");
    const grantKey = locked && mainRefreshGrantKey(locked);
    if (grantKey) markMainRefreshGrantRejected(grantKey);
    throw new MainAccountTokenRefreshError("reauth", { credentialObservedAbsent: true });
  }
  const token = status.authToken;
  if (status.authMethod !== "chatgpt" || !token) {
    noteNativeMainRefresh("codex-no-chatgpt-login");
    // An ordinary read with no locked credential and nothing rejected observed a real
    // absence, not a refresh failure: report no credential instead of a retryable error.
    // Once the expiring-bearer answer above promoted this lookup into a real refresh, the
    // same no-login outcome is a refresh failure again.
    if (locked === null && rejectedAccessToken === undefined && !didRefresh) return null;
    throw new MainAccountTokenRefreshError("transient", { credentialObservedAbsent: true });
  }
  // A transient Codex refresh failure still answers with its cached bearer.
  if (token === rejectedAccessToken || !mainAccessTokenFresh(token, Date.now(), 0)) {
    noteNativeMainRefresh("codex-transient");
    throw new MainAccountTokenRefreshError("transient");
  }
  noteNativeMainRefresh("codex-ok");
  if (dependencies.signal?.aborted) throw dependencies.signal.reason;
  const result = Object.freeze({
    accessToken: token,
    chatgptAccountId: extractAccountId(undefined, token) ?? locked?.chatgptAccountId ?? "",
  });
  const writer = observeCodexOwnedMainAccountCredential(token);
  if (writer) codexOwnedQuotaWriters.set(result, { writer, home: codexHome, credentialGeneration: getMainQuotaCredentialGeneration() });
  if (writer && dependencies.preserveReauth !== true) clearAccountNeedsReauth(MAIN_CODEX_ACCOUNT_ID);
  const exp = decodeJwtPayload(token)?.exp;
  codexOwnedMainCredential = { home: codexHome, expiresAt: typeof exp === "number" ? exp * 1000 : Infinity };
  return result;
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
