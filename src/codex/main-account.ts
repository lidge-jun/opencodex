import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { readCodexTokens } from "./auth-collision";
import {
  decodeJwtPayload,
  extractAccountId,
  refreshChatGPTToken,
  ChatGPTTokenRefreshError,
} from "../oauth/chatgpt";
import type { OAuthCredentials } from "../oauth/types";
import { extractChatgptPlanType } from "./plan";
import { MAIN_CODEX_ACCOUNT_ID } from "./account-id";
import { resolveCodexHomeDir } from "./home";
import { assertNotRealCodexHomeUnderTest } from "../lib/test-home-guard";
import { clearAccountNeedsReauth } from "./account-runtime-state";
import { withNativeMainExclusiveClaim } from "./native-main-claim";
import { withNativeMainOwnerOperation } from "./native-main-owner";
import { resolveNativeProfileContext, type NativeProfileContext } from "./native-profile-store";
import {
  NativeMainRefreshPublicationError,
  publishNativeMainRefresh,
  recoverNativeMainRefreshPublication,
} from "./native-main-refresh-publication";

export { MAIN_CODEX_ACCOUNT_ID } from "./account-id";

/**
 * Main account plan (e.g. "plus", "go", "free", "team"), populated from the WHAM usage
 * fetch. Used by the rotation usage-score so go/free main accounts score on monthly
 * percent, matching pool-account behavior.
 */
let mainAccountPlan: string | null = null;
let jwtPlanAttempted = false;
const MAIN_TOKEN_REFRESH_SKEW_MS = 60_000;
const NATIVE_MAIN_REFRESH_WAIT_MS = 30_000;
const MAX_NATIVE_MAIN_REFRESH_FLIGHTS = 32;
let beforeMainAuthJsonRenameForTests: (() => void) | null = null;

type MainAuthJsonCredential = {
  path: string;
  raw: string;
  rawSha256: string;
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

type NativeMainRefreshFlight = {
  controller: AbortController;
  deadline: ReturnType<typeof setTimeout>;
  promise: Promise<{ accessToken: string; chatgptAccountId: string }>;
};

type NativeMainRefreshResolution = {
  dependencies: NativeMainRefreshDependencies;
  rejectedAccessToken: string | undefined;
  replacementAttempted: boolean;
};

const nativeMainRefreshFlights = new Map<string, NativeMainRefreshFlight>();

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

export class MainAccountRefreshCancelledError extends Error {
  constructor() {
    super("Native credential refresh was cancelled.");
    this.name = "MainAccountRefreshCancelledError";
  }
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function readMainAuthJsonCredential(): MainAuthJsonCredential | null {
  const path = join(resolveCodexHomeDir(), "auth.json");
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
      raw,
      rawSha256: createHash("sha256").update(raw).digest("hex"),
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
}

function persistRefreshedMainAuthJson(
  context: NativeProfileContext,
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
  assertMainAuthJsonSnapshotUnchanged(expected);
  const hook = beforeMainAuthJsonRenameForTests;
  beforeMainAuthJsonRenameForTests = null;
  hook?.();
  assertMainAuthJsonSnapshotUnchanged(expected);
  publishNativeMainRefresh(context, expected.raw, JSON.stringify({ ...expected.root, tokens }, null, 2) + "\n");
  return { accessToken, chatgptAccountId };
}

export function setMainAuthJsonBeforeRenameHookForTests(hook: (() => void) | null): void {
  beforeMainAuthJsonRenameForTests = hook;
}

async function resolveMainAccountToken(
  dependencies: NativeMainRefreshDependencies = {},
  rejectedAccessToken?: string,
  replacementAttempted = false,
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

  const context = resolveNativeProfileContext();
  const current = nativeMainRefreshFlights.get(context.homeId);
  const resolution = { dependencies, rejectedAccessToken, replacementAttempted };
  if (current) return await resolveNativeMainRefreshFlight(context, current, resolution);
  if (nativeMainRefreshFlights.size >= MAX_NATIVE_MAIN_REFRESH_FLIGHTS) {
    throw new MainAccountTokenRefreshError("transient");
  }
  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(new Error("Native credential refresh timed out")), NATIVE_MAIN_REFRESH_WAIT_MS);
  const flight: NativeMainRefreshFlight = {
    controller,
    deadline,
    promise: runNativeMainRefreshFlight(context, dependencies, rejectedAccessToken, controller.signal),
  };
  nativeMainRefreshFlights.set(context.homeId, flight);
  flight.promise.finally(() => {
    clearTimeout(flight.deadline);
    if (nativeMainRefreshFlights.get(context.homeId) === flight) nativeMainRefreshFlights.delete(context.homeId);
  }).catch(() => undefined);
  return await resolveNativeMainRefreshFlight(context, flight, resolution);
}

async function resolveNativeMainRefreshFlight(
  context: NativeProfileContext,
  flight: NativeMainRefreshFlight,
  resolution: NativeMainRefreshResolution,
): Promise<{ accessToken: string; chatgptAccountId: string }> {
  const result = await waitForNativeMainRefresh(flight, resolution.dependencies.signal);
  if (resolution.rejectedAccessToken === undefined || result.accessToken !== resolution.rejectedAccessToken) return result;
  if (resolution.replacementAttempted) throw new MainAccountTokenRefreshError("transient");
  if (nativeMainRefreshFlights.get(context.homeId) === flight) nativeMainRefreshFlights.delete(context.homeId);
  const replacement = await resolveMainAccountToken(resolution.dependencies, resolution.rejectedAccessToken, true);
  if (!replacement) throw new MainAccountTokenRefreshError("transient");
  return replacement;
}

function abortError(_signal: AbortSignal): MainAccountRefreshCancelledError {
  return new MainAccountRefreshCancelledError();
}

async function waitForNativeMainRefresh(
  flight: NativeMainRefreshFlight,
  signal: AbortSignal | undefined,
): Promise<{ accessToken: string; chatgptAccountId: string }> {
  if (!signal) return await flight.promise;
  if (signal.aborted) throw abortError(signal);
  return await Promise.race([
    flight.promise,
    new Promise<never>((_resolve, reject) => signal.addEventListener("abort", () => reject(abortError(signal)), { once: true })),
  ]);
}

async function runNativeMainRefreshFlight(
  context: NativeProfileContext,
  dependencies: NativeMainRefreshDependencies,
  rejectedAccessToken: string | undefined,
  signal: AbortSignal,
): Promise<{ accessToken: string; chatgptAccountId: string }> {
  try {
    return await withNativeMainOwnerOperation(context, async () => await withNativeMainExclusiveClaim(
      context,
      async () => {
        recoverNativeMainRefreshPublication(context);
        const locked = readMainAuthJsonCredential();
        if (!locked) throw new MainAuthJsonChangedDuringRefreshError();
        if (locked.accessToken !== rejectedAccessToken
          && mainAccessTokenFresh(locked.accessToken, Date.now(), MAIN_TOKEN_REFRESH_SKEW_MS)) {
          return { accessToken: locked.accessToken!, chatgptAccountId: locked.chatgptAccountId };
        }
        if (!locked.refreshToken) throw new MainAuthJsonChangedDuringRefreshError();
        const refresh = dependencies.refreshToken
          ?? ((token: string, options: { signal: AbortSignal }) => refreshChatGPTToken(token, options));
        let refreshed: OAuthCredentials;
        try {
          refreshed = await refresh(locked.refreshToken, { signal });
        } catch (cause) {
          const terminal = cause instanceof ChatGPTTokenRefreshError
            && cause.code === "invalid_grant"
            && (cause.status === 400 || cause.status === 401);
          throw new MainAccountTokenRefreshError(terminal ? "reauth" : "transient", { cause });
        }
        if (signal.aborted) throw new MainAccountTokenRefreshError("transient");
        const result = persistRefreshedMainAuthJson(context, locked, refreshed);
        clearAccountNeedsReauth(MAIN_CODEX_ACCOUNT_ID);
        return result;
      },
      { waitMs: NATIVE_MAIN_REFRESH_WAIT_MS },
    ));
  } catch (cause) {
    if (cause instanceof MainAccountTokenRefreshError || cause instanceof MainAuthJsonChangedDuringRefreshError) throw cause;
    if (cause instanceof NativeMainRefreshPublicationError) throw new MainAccountTokenRefreshError("transient", { cause });
    throw new MainAccountTokenRefreshError("transient", { cause });
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
