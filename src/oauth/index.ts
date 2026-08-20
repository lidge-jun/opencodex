import type { KiroOAuthMetadata, OAuthController, OAuthCredentials } from "./types";
import { parseCallbackInput } from "./callback-server";
import type { OcxConfig, OcxProviderConfig, RefreshPolicy } from "../types";
import { loadConfig, resolveEnvValue, saveConfig } from "../config";
import { maskEmail } from "../lib/privacy";
import { KiroTokenRefreshError, environmentKiroRoutingMetadata, loginKiro, refreshKiroToken, settleKiroLoginTransaction } from "./kiro";
import { getAccountCredential, getAccountSet, removeAccount, saveAccountCredential, saveCredential, setActiveAccount, getCredential, credentialGeneration, createOAuthRefreshIntentLock, mergeAccountCredential, markAccountNeedsReauthIfGeneration, readOAuthRefreshIntent, writeOAuthRefreshIntent, markOAuthRefreshIntentStaleOwner, clearOAuthRefreshIntent, normalizeAuthStoreBuffer, OAuthMutationBusyError } from "./store";
import { loginXai, refreshXaiToken, XAI_LOCAL_CLI_DETACH_WARNING, XaiTokenRequestError } from "./xai";
import { ANTHROPIC_OAUTH_BETA, AnthropicTokenError, loginAnthropic, refreshAnthropicToken } from "./anthropic";
import { loginKimi, refreshKimiToken } from "./kimi";
import { loginNous, NousTokenError, refreshNousToken, clearNousRefreshIntent, RefreshIntentIOError } from "./nous";
import { loginChatGPT, refreshChatGPTToken } from "./chatgpt";
import { loginAntigravity, refreshAntigravityToken } from "./google-antigravity";
import { loginCursor, refreshCursorToken } from "./cursor";
import { loginGithubCopilot, refreshGithubCopilotToken, validateCopilotApiBaseUrl } from "./github-copilot";
import { loginCommandCode, refreshCommandCodeToken } from "./command-code";
import { ANTIGRAVITY_REQUEST_UA } from "../adapters/google-antigravity-wire";
import { deriveOAuthDefaultModel, deriveOAuthProviderConfig } from "../providers/derive";
import { apiKeyPoolEntryId, sanitizeApiKeyValue } from "../providers/api-keys";
import { effectiveGoogleMode, getProviderRegistryEntry, mergeRegistryStaticHeaders, providerMatchesRegistryTransport } from "../providers/registry";
import { resolveProviderModelDiscoveryUrl } from "../providers/model-discovery";
import { resolveProviderTransport } from "../providers/xai-transport";
import { detectClaudeCodeToken, detectGrokCliToken, hasComparableGrokIdentity, isSameGrokIdentity, shouldAdoptGrokGeneration } from "./local-token-detect";
import { logOAuthEvent } from "./log";
import { captureConfigGeneration, sweepExpiredOnWrite, type GenerationContext } from "../lib/state-store-sweeper";
import { retainedUtf8Bytes } from "../lib/admission";
import { randomUUID } from "node:crypto";
export {
  CODEX_HEALTH_AUTH_FAILED_NOTE,
  CODEX_HEALTH_MANAGEMENT_API_UNAVAILABLE_NOTE,
  CODEX_HEALTH_UNAVAILABLE_NOTE,
  MASKED_ACCOUNT_FALLBACK,
  collectOAuthHealthEntries,
  collectOAuthHealthEntriesForCli,
  detectOAuthWarning,
  oauthAccountHealthFields,
  oauthHealthLabel,
  oauthHealthSummary,
  projectCodexAccountHealth,
  projectOAuthAccountHealth,
  projectStoredOAuthAccountHealth,
  type CodexHealthSource,
  type OAuthAccountHealth,
  type OAuthAccountHealthFields,
  type OAuthCliHealthReport,
  type OAuthHealthEntry,
  type OAuthHealthLabel,
} from "./health";
export { OAUTH_REFRESH_LOCK_WAIT_MS, peekAuthStore, peekOAuthRefreshIntent } from "./store";
import { codexAccountNamespaceProviderCollisionError } from "../codex/account-namespace-match";

const REFRESH_SKEW_MS = 60_000;
export interface OAuthAccessSnapshot {
  provider: string;
  accountId: string;
  generation: string;
  accessToken: string;
  /** Cloud Code Assist project selected during Antigravity login. */
  projectId?: string;
  /** Safe request-routing subset; refresh-only Kiro client secrets never leave the credential store. */
  kiro?: Pick<KiroOAuthMetadata, "profileArn" | "apiRegion" | "ssoRegion">;
}

export interface ObservedOAuthAccessSnapshot extends OAuthAccessSnapshot {
  /** Allowlisted provider API origin consumed by GitHub Copilot model discovery. */
  apiBaseUrl?: string;
}

export type OAuthActiveTokenObservation =
  | { readonly kind: "available"; readonly snapshot: ObservedOAuthAccessSnapshot }
  | { readonly kind: "missing" }
  | { readonly kind: "malformed" }
  | { readonly kind: "needs-reauth" }
  | { readonly kind: "expired" }
  | { readonly kind: "near-expiry" }
  | { readonly kind: "unsupported" };

const MAX_OAUTH_TOKEN_REFRESH_FLIGHTS = 32;
const OAUTH_TOKEN_REFRESH_FLIGHT_STALE_MS = 120_000;
interface OAuthRefreshFlightEvidence { flightId: string; dispatched: boolean }
interface OAuthTokenRefreshFlight extends OAuthRefreshFlightEvidence { promise: Promise<OAuthAccessSnapshot>; startedAt: number; abort: AbortController }
const tokenRefreshes = new Map<string, OAuthTokenRefreshFlight>();
export class OAuthTokenRefreshBusyError extends Error {
  readonly code = "OAUTH_TOKEN_REFRESH_BUSY";
  readonly retryable = true;
  constructor() { super("OAuth token refresh capacity reached"); this.name = "OAuthTokenRefreshBusyError"; }
}
export class OAuthTokenRefreshStaleError extends Error {
  readonly code = "OAUTH_TOKEN_REFRESH_STALE";
  readonly retryable = true;
  constructor() { super("OAuth token refresh owner became stale"); this.name = "OAuthTokenRefreshStaleError"; }
}

/** Focused owner-identity tests only. Synthetic owners retain no account data. */
export function seedOAuthTokenRefreshFlightsForTests(rows: Array<{ key: string; startedAt?: number; flightId?: string; dispatched?: boolean }>): {
  promises: Promise<OAuthAccessSnapshot>[];
  cleanup: () => void;
} {
  const inserted: OAuthTokenRefreshFlight[] = [];
  const promises = rows.map(({ key, startedAt, flightId, dispatched }) => {
    const abort = new AbortController();
    const promise = new Promise<OAuthAccessSnapshot>((_resolve, reject) => {
      abort.signal.addEventListener("abort", () => reject(abort.signal.reason), { once: true });
    });
    const flight = { promise, startedAt: startedAt ?? Date.now(), abort, flightId: flightId ?? randomUUID(), dispatched: dispatched ?? false };
    tokenRefreshes.set(key, flight);
    inserted.push(flight);
    return promise;
  });
  return {
    promises,
    cleanup() {
      for (const [key, flight] of tokenRefreshes) {
        if (!inserted.includes(flight)) continue;
        tokenRefreshes.delete(key);
        flight.abort.abort(new Error("test cleanup"));
      }
    },
  };
}
const XAI_PERMANENT_FAILURE_TTL_MS=30_000;
const permanentRefreshFailures=new Map<string,number>();
interface XaiRefreshDeps { intentLock?:ReturnType<typeof createOAuthRefreshIntentLock>; now?:()=>number; afterPrePersistRead?:()=>void|Promise<void>; signal?: AbortSignal }
interface AnthropicRefreshDeps { intentLock?:ReturnType<typeof createOAuthRefreshIntentLock>; now?:()=>number; afterPrePersistRead?:()=>void|Promise<void>; signal?: AbortSignal; flight?: OAuthRefreshFlightEvidence; replacedStaleFlight?: OAuthRefreshFlightEvidence }
interface GenericRefreshDeps { intentLock?:ReturnType<typeof createOAuthRefreshIntentLock>; afterPrePersistRead?:()=>void|Promise<void>; signal?: AbortSignal }
function verdictKey(p:string,a:string,c:OAuthCredentials){return `${p}\0${a}\0${credentialGeneration(c)}`;}
function cached(p:string,a:string,c:OAuthCredentials,now:()=>number){const k=verdictKey(p,a,c),u=permanentRefreshFailures.get(k);if(u===undefined)return false;if(u<=now()){permanentRefreshFailures.delete(k);return false;}return true;}
export function sweepExpiredXaiPermanentFailureVerdicts(now=Date.now()):number{let removed=0;for(const[key,until]of permanentRefreshFailures){if(until>now)continue;permanentRefreshFailures.delete(key);removed+=1;}return removed;}

export interface LoginOpts { forceLogin?: boolean; /** When set, persist into this account slot and require matching identity. */ reauthAccountId?: string }

export interface LoginFlowLifecycle {
  /** Runs after background credential/config persistence settles, before status becomes done. */
  onSettled?: () => void | Promise<void>;
}

interface OAuthProviderDef {
  login(ctrl: OAuthController, opts?: LoginOpts): Promise<OAuthCredentials>;
  refresh(
    refreshToken: string,
    signal?: AbortSignal,
    credential?: OAuthCredentials,
  ): Promise<OAuthCredentials>;
  /** provider entry written into config.json on first login. */
  providerConfig: OcxProviderConfig;
  defaultModel: string;
  /**
   * Built-in proactive-refresh policy, risk-tiered by the provider's ToS exposure (devlog
   * 260703_oauth-multi-account-refresh-and-tos). A user's per-provider `config.providers[x].refreshPolicy`
   * overrides this. Default when unset here: "lazy-only".
   */
  defaultRefreshPolicy?: RefreshPolicy;
}

function oauthConfig(id: string): OcxProviderConfig {
  const config = deriveOAuthProviderConfig(id);
  if (!config) throw new Error(`OAuth provider missing from registry: ${id}`);
  return config;
}

function oauthDefaultModel(id: string): string {
  const model = deriveOAuthDefaultModel(id);
  if (!model) throw new Error(`OAuth provider missing default model in registry: ${id}`);
  return model;
}

export const OAUTH_PROVIDERS: Record<string, OAuthProviderDef> = {
  "command-code": {
    // Add-account/reauth must not reimport the current local CLI credential.
    login: (ctrl, opts) => loginCommandCode(ctrl, { importLocal: opts?.forceLogin ? "off" : "fallback" }),
    refresh: refreshCommandCodeToken,
    providerConfig: oauthConfig("command-code"),
    defaultModel: oauthDefaultModel("command-code"),
    defaultRefreshPolicy: "disabled",
  },
  xai: {
    // forceLogin skips the local grok-cli import so a SECOND account can be chosen in the browser.
    login: (ctrl, opts) => loginXai(ctrl, { importLocal: opts?.forceLogin ? "off" : "fallback" }),
    refresh: refreshXaiToken,
    providerConfig: oauthConfig("xai"),
    defaultModel: oauthDefaultModel("xai"),
  },
  anthropic: {
    login: (ctrl, opts) => loginAnthropic(ctrl, { importLocal: opts?.forceLogin ? "off" : "fallback" }),
    refresh: refreshAnthropicToken,
    providerConfig: oauthConfig("anthropic"),
    defaultModel: oauthDefaultModel("anthropic"),
    // Anthropic actively server-side-blocks subscription OAuth outside its own clients (Feb 2026).
    // Never generate background refresh traffic for it — grade 20, highest ToS risk.
    defaultRefreshPolicy: "disabled",
  },
  kimi: {
    login: (ctrl) => loginKimi(ctrl),
    refresh: refreshKimiToken,
    providerConfig: oauthConfig("kimi"),
    defaultModel: oauthDefaultModel("kimi"),
  },
  nous: {
    // Nous Portal device-grant login (RFC 8628) against portal.nousresearch.com.
    // The access token is the per-request inference JWT (scope inference:invoke).
    // Refresh tokens are single-use and rotated server-side on every refresh:
    // keep background refresh lazy-only (the default) so concurrent refreshes
    // cannot trip the Portal's token-reuse revocation.
    login: (ctrl) => loginNous(ctrl),
    refresh: (rt, signal) => refreshNousToken(rt, signal),
    providerConfig: oauthConfig("nous"),
    defaultModel: oauthDefaultModel("nous"),
    // Single-use rotating refresh tokens must never be background-refreshed
    // proactively: concurrent refreshes would trip the Portal's reuse
    // revocation. Anchor the lazy-only default explicitly so it cannot be
    // silently overridden to proactive.
    defaultRefreshPolicy: "lazy-only",
  },
  kiro: {
    login: (ctrl, opts) => loginKiro(ctrl, { forceLogin: opts?.forceLogin }),
    refresh: (rt, signal, credential) => refreshKiroToken(rt, signal, credential),
    providerConfig: oauthConfig("kiro"),
    defaultModel: oauthDefaultModel("kiro"),
  },
  "google-antigravity": {
    login: (ctrl, opts) => loginAntigravity(ctrl, { forceAccountSelect: opts?.forceLogin === true }),
    refresh: refreshAntigravityToken,
    providerConfig: oauthConfig("google-antigravity"),
    defaultModel: oauthDefaultModel("google-antigravity"),
  },
  cursor: {
    login: (ctrl, opts) => loginCursor(ctrl, undefined, { forceLogin: opts?.forceLogin }),
    refresh: refreshCursorToken,
    providerConfig: oauthConfig("cursor"),
    defaultModel: oauthDefaultModel("cursor"),
  },
  "github-copilot": {
    login: (ctrl) => loginGithubCopilot(ctrl),
    refresh: (rt, signal) => refreshGithubCopilotToken(rt, signal),
    providerConfig: oauthConfig("github-copilot"),
    defaultModel: oauthDefaultModel("github-copilot"),
    // Unofficial Copilot bridge — keep proactive traffic lazy-only (no background guardian spam).
    defaultRefreshPolicy: "lazy-only",
  },
  chatgpt: {
    login: loginChatGPT,
    refresh: (rt) => refreshChatGPTToken(rt),
    providerConfig: { adapter: "openai-responses", baseUrl: "https://chatgpt.com/backend-api/codex", authMode: "forward" as const },
    defaultModel: "gpt-5.4",
  },
};

export function isOAuthProvider(name: string): boolean {
  return name in OAUTH_PROVIDERS;
}

export function isPublicOAuthProvider(name: string): boolean {
  return name !== "chatgpt" && isOAuthProvider(name);
}

function isRefreshPolicy(value: unknown): value is RefreshPolicy {
  return value === "proactive" || value === "lazy-only" || value === "disabled";
}

/**
 * The effective proactive-refresh policy for a provider: the user's per-provider
 * `config.providers[provider].refreshPolicy` if set, else the provider def's risk-tiered default,
 * else "lazy-only". The guardian acts only when this resolves to "proactive".
 */
export function resolveRefreshPolicy(provider: string, config: OcxConfig): RefreshPolicy {
  const override = config.providers[provider]?.refreshPolicy;
  if (isRefreshPolicy(override)) return override;
  const def = OAUTH_PROVIDERS[provider];
  return def?.defaultRefreshPolicy ?? "lazy-only";
}

/** The discovered project id stored on an OAuth credential (Antigravity CCA), if any. */
export function getOAuthCredentialProjectId(provider: string): string | undefined {
  return getCredential(provider)?.projectId;
}

/** Allowlisted Copilot API origin from the active credential, if still valid. */
export function getOAuthCredentialApiBaseUrl(provider: string): string | undefined {
  return validateCopilotApiBaseUrl(getCredential(provider)?.apiBaseUrl);
}

/** Provider ids that support real OAuth login (drives the GUI's "Log in with …" buttons). */
export function listOAuthProviders(): string[] {
  return Object.keys(OAUTH_PROVIDERS).filter(isPublicOAuthProvider);
}

export class UnsupportedOAuthProviderError extends Error {
  constructor(provider: string) {
    super(`Unsupported OAuth provider in config: ${provider}`);
    this.name = "UnsupportedOAuthProviderError";
  }
}

export class OAuthLoginRequiredError extends Error {
  readonly provider: string;

  constructor(provider: string) {
    super(`Not logged in to ${provider}. Run: ocx login ${provider}`);
    this.name = "OAuthLoginRequiredError";
    this.provider = provider;
  }
}

export class OAuthProviderPublicationError extends Error {
  constructor() {
    super("OAuth credential was saved, but the provider entry was not written. Resolve the account namespace collision, then retry login.");
    this.name = "OAuthProviderPublicationError";
  }
}

export class OAuthReauthIdentityMismatchError extends Error {
  constructor() {
    super("Signed-in account does not match the selected account. Sign in with the same account.");
    this.name = "OAuthReauthIdentityMismatchError";
  }
}

export class OAuthReauthIdentityUnverifiedError extends Error {
  constructor() {
    super("Could not verify signed-in account identity for reauth.");
    this.name = "OAuthReauthIdentityUnverifiedError";
  }
}

class OAuthLoginSupersededError extends Error {
  constructor() {
    super("OAuth login was superseded before credential persistence");
    this.name = "OAuthLoginSupersededError";
  }
}

/** Project arbitrary OAuth failures onto the small, stable public error vocabulary. */
export function publicOAuthAuthenticationErrorMessage(error: unknown): string {
  if (error instanceof OAuthMutationBusyError) {
    return error.message === "OAuth mutation queue wait timed out"
      ? "OAuth mutation queue wait timed out"
      : "OAuth mutation queue is busy";
  }
  if (
    (error instanceof OAuthLoginRequiredError && isOAuthProvider(error.provider))
    || error instanceof OAuthProviderPublicationError
    // Reauth identity outcomes carry fixed, account-free remediation text. Dropping them to the
    // generic message hides WHICH failure the user must fix (sign in with the selected account).
    || error instanceof OAuthReauthIdentityMismatchError
    || error instanceof OAuthReauthIdentityUnverifiedError
    || error instanceof OAuthTokenRefreshBusyError
    || error instanceof OAuthTokenRefreshStaleError
  ) return error.message;
  return "OAuth authentication failed. Check the OpenCodex account status and retry.";
}

function accessSnapshot(provider: string, accountId: string, cred: OAuthCredentials): OAuthAccessSnapshot {
  const storedKiroRouting = {
    ...(cred.kiro?.profileArn ? { profileArn: cred.kiro.profileArn } : {}),
    ...(cred.kiro?.apiRegion ? { apiRegion: cred.kiro.apiRegion } : {}),
    ...(cred.kiro?.ssoRegion ? { ssoRegion: cred.kiro.ssoRegion } : {}),
  };
  return {
    provider,
    accountId,
    generation: credentialGeneration(cred),
    accessToken: cred.access,
    ...(cred.projectId ? { projectId: cred.projectId } : {}),
    // Stored account metadata remains authoritative. Metadata-less legacy/environment credentials
    // may use explicit environment routing, but never borrow the currently signed-in local CLI account.
    ...(provider === "kiro"
      ? {
          kiro: Object.keys(storedKiroRouting).length > 0
            ? storedKiroRouting
            : environmentKiroRoutingMetadata() ?? {},
        }
      : {}),
  };
}

/**
 * Observe the active OAuth token from an auth-store buffer supplied by its filesystem owner.
 * Missing, malformed, reauth-required, and expiring credentials are typed no-token outcomes;
 * this path never refreshes, locks, hardens, backs up, or persists credentials.
 */
export function observeActiveOAuthAccessToken(
  provider: string,
  authStoreBuffer: Uint8Array | null,
  now = Date.now(),
): OAuthActiveTokenObservation {
  const authStore = normalizeAuthStoreBuffer(authStoreBuffer);
  if (authStore.kind === "absent") return { kind: "missing" };
  if (authStore.kind === "malformed") return { kind: "malformed" };
  if (!isOAuthProvider(provider)) return { kind: "unsupported" };

  const accountSet = authStore.store[provider];
  const account = accountSet?.accounts.find(candidate => candidate.id === accountSet.activeAccountId);
  if (!account) return { kind: "missing" };
  if (account.needsReauth) return { kind: "needs-reauth" };
  if (account.credential.expires <= now) return { kind: "expired" };
  if (account.credential.expires <= now + REFRESH_SKEW_MS) return { kind: "near-expiry" };

  const apiBaseUrl = validateCopilotApiBaseUrl(account.credential.apiBaseUrl);
  return {
    kind: "available",
    snapshot: {
      ...accessSnapshot(provider, account.id, account.credential),
      ...(apiBaseUrl ? { apiBaseUrl } : {}),
    },
  };
}

async function resolveAccessSnapshotForAccount(
  provider: string,
  accountId: string,
  rejectedGeneration?: string,
): Promise<OAuthAccessSnapshot> {
  const def = OAUTH_PROVIDERS[provider];
  if (!def) throw new UnsupportedOAuthProviderError(provider);
  const cred = getAccountCredential(provider, accountId);
  if (!cred) throw new OAuthLoginRequiredError(provider);
  const current = accessSnapshot(provider, accountId, cred);
  if (rejectedGeneration !== undefined && current.generation !== rejectedGeneration) return current;
  if (rejectedGeneration === undefined && cred.expires > Date.now() + REFRESH_SKEW_MS) return current;

  const key = `${provider}\u0000${accountId}`;
  let existing = tokenRefreshes.get(key);
  let replacedStaleFlight: OAuthRefreshFlightEvidence | undefined;
  if (existing && Date.now() - existing.startedAt <= OAUTH_TOKEN_REFRESH_FLIGHT_STALE_MS) {
    logOAuthEvent("OAuth refresh joined existing operation", { provider, accountId });
    return existing.promise;
  }
  if (existing) {
    replacedStaleFlight = { flightId: existing.flightId, dispatched: existing.dispatched };
    existing.abort.abort(new OAuthTokenRefreshStaleError());
    if (tokenRefreshes.get(key) === existing) tokenRefreshes.delete(key);
    existing = undefined;
  }
  if (tokenRefreshes.size >= MAX_OAUTH_TOKEN_REFRESH_FLIGHTS) throw new OAuthTokenRefreshBusyError();

  const abort = new AbortController();
  const flight: OAuthTokenRefreshFlight = {
    promise: undefined as unknown as Promise<OAuthAccessSnapshot>,
    startedAt: Date.now(),
    abort,
    flightId: randomUUID(),
    dispatched: false,
  };
  const refresh = (async (): Promise<OAuthAccessSnapshot> => {
    const accessToken = await refreshAndPersistAccessToken(provider, accountId, def, cred, abort.signal, flight, replacedStaleFlight);
    const persisted = getAccountCredential(provider, accountId);
    if (!persisted) throw new OAuthLoginRequiredError(provider);
    if (persisted.access !== accessToken) {
      throw new Error(`OAuth refresh persisted an unexpected access token for ${provider}`);
    }
    return accessSnapshot(provider, accountId, persisted);
  })().catch(error => {
    if (abort.signal.reason instanceof OAuthTokenRefreshStaleError) throw abort.signal.reason;
    throw error;
  }).finally(() => {
    if (tokenRefreshes.get(key) === flight) tokenRefreshes.delete(key);
  });
  flight.promise = refresh;
  tokenRefreshes.set(key, flight);
  return refresh;
}

export async function getValidAccessTokenSnapshot(provider: string): Promise<OAuthAccessSnapshot> {
  const set = getAccountSet(provider);
  if (!set) throw new OAuthLoginRequiredError(provider);
  return resolveAccessSnapshotForAccount(provider, set.activeAccountId);
}

/** Providers whose upstream-401 replay path may force a snapshot refresh. */
const FORCE_REFRESH_PROVIDERS = new Set(["xai", "github-copilot", "kiro"]);

export async function forceRefreshOAuthAccessSnapshot(
  rejected: OAuthAccessSnapshot,
): Promise<OAuthAccessSnapshot> {
  if (!FORCE_REFRESH_PROVIDERS.has(rejected.provider)) throw new UnsupportedOAuthProviderError(rejected.provider);
  return resolveAccessSnapshotForAccount(rejected.provider, rejected.accountId, rejected.generation);
}

/** Return a valid access token for the ACTIVE account, refreshing + persisting if expired. */
export async function getValidAccessToken(provider: string): Promise<string> {
  return (await getValidAccessTokenSnapshot(provider)).accessToken;
}

/**
 * Account-scoped token resolver (multiauth): refresh is single-flighted per
 * (provider, account), and the rotated credential is persisted for THAT account only —
 * a guardian refresh of a background account never switches the active account.
 */
export async function getValidAccessTokenForAccount(provider: string, accountId: string): Promise<string> {
  return (await resolveAccessSnapshotForAccount(provider, accountId)).accessToken;
}

/** Terminal refresh failures (revoked/rotated-away grants) — retrying cannot succeed. */
function isTerminalRefreshError(err: unknown): boolean {
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  return msg.includes("invalid_grant")
    || msg.includes("refresh_token_reused")
    || msg.includes("revoked")
    // GitHub Copilot refresh surfaces allowlisted OAuth codes (github-copilot.ts):
    || msg.includes("access_denied")
    || msg.includes("expired_token");
}
function terminal(error:unknown):boolean{
  if(error instanceof XaiTokenRequestError)return ["invalid_grant","refresh_token_reused","revoked_token"].includes(error.oauthError??"");
  if(error instanceof AnthropicTokenError)return (error.httpStatus===400||error.httpStatus===401)&&["invalid_grant","refresh_token_reused","revoked","revoked_token","refresh_token_revoked"].includes(error.oauthError??"");
  if(error instanceof KiroTokenRefreshError)return (error.httpStatus===400||error.httpStatus===401)&&error.oauthError!==undefined;
  if(error instanceof NousTokenError)return error.terminal===true||["invalid_grant","refresh_token_reused","revoked","revoked_token","expired_token"].includes(error.oauthError??"");
  // Local durable-write/read/cleanup failures are operational, not credential
  // death: the provider credential was never rejected or consumed. Never mark
  // the account needsReauth for broken local persistence infrastructure.
  if (error instanceof RefreshIntentIOError) return false;
  return isTerminalRefreshError(error);
}
function authoritative(stored:OAuthCredentials,active:boolean,now:()=>number):OAuthCredentials{if(stored.source!=="local-cli")return stored;const disk=detectGrokCliToken();if(!disk)return stored;const allowed=isSameGrokIdentity(stored,disk)||(active&&!hasComparableGrokIdentity(stored,disk));return allowed&&shouldAdoptGrokGeneration(stored,disk,now(),REFRESH_SKEW_MS)?disk:stored;}
function merged(fresh: OAuthCredentials, previous: OAuthCredentials): OAuthCredentials {
  return {
    ...fresh,
    source: previous.source === "local-cli" ? "oauth" : fresh.source ?? previous.source ?? "oauth",
    ...(fresh.projectId === undefined && previous.projectId ? { projectId: previous.projectId } : {}),
    ...(fresh.apiBaseUrl === undefined && previous.apiBaseUrl ? { apiBaseUrl: previous.apiBaseUrl } : {}),
    ...(fresh.email === undefined && previous.email ? { email: previous.email } : {}),
    ...(fresh.accountId === undefined && previous.accountId ? { accountId: previous.accountId } : {}),
    ...(fresh.kiro === undefined && previous.kiro ? { kiro: previous.kiro } : {}),
  };
}
export async function refreshXaiAccountWithLock(provider:string,accountId:string,def:OAuthProviderDef,callerCredential:OAuthCredentials,deps:XaiRefreshDeps={}):Promise<string>{const writerGeneration=captureConfigGeneration();const now=deps.now??Date.now;const guard=await(deps.intentLock??createOAuthRefreshIntentLock(provider,accountId)).acquire();try{const stored=getAccountCredential(provider,accountId);if(!stored)throw new OAuthLoginRequiredError(provider);const active=getAccountSet(provider)?.activeAccountId===accountId,candidate=authoritative(stored,active,now);if(credentialGeneration(candidate)!==credentialGeneration(callerCredential)&&candidate.expires>now()+REFRESH_SKEW_MS){if(credentialGeneration(candidate)!==credentialGeneration(stored)){const o=await mergeAccountCredential(provider,accountId,candidate,{expectedGeneration:credentialGeneration(stored),afterPrePersistRead:deps.afterPrePersistRead});if(o.superseded){if(o.stored.expires>now()+REFRESH_SKEW_MS)return o.stored.access;throw new OAuthLoginRequiredError(provider);}}return candidate.access;}if(cached(provider,accountId,candidate,now))throw new OAuthLoginRequiredError(provider);const generation=credentialGeneration(candidate);try{const fresh=merged(await def.refresh(candidate.refresh,deps.signal),candidate);const o=await mergeAccountCredential(provider,accountId,fresh,{expectedGeneration:generation,afterPrePersistRead:deps.afterPrePersistRead});if(o.superseded){if(o.stored.expires>now()+REFRESH_SKEW_MS)return o.stored.access;throw new OAuthLoginRequiredError(provider);}permanentRefreshFailures.delete(verdictKey(provider,accountId,candidate));if(candidate.source==="local-cli")console.warn(XAI_LOCAL_CLI_DETACH_WARNING);return fresh.access;}catch(error){if(error instanceof OAuthMutationBusyError){permanentRefreshFailures.delete(verdictKey(provider,accountId,candidate));throw error;}if(!terminal(error))throw error;const failedAt=now();permanentRefreshFailures.set(verdictKey(provider,accountId,candidate),failedAt+XAI_PERMANENT_FAILURE_TTL_MS);sweepExpiredOnWrite(failedAt);await markAccountNeedsReauthIfGeneration(provider,accountId,generation,writerGeneration);throw new OAuthLoginRequiredError(provider);}}finally{guard.release();}}

function newerClaudeCredential(stored: OAuthCredentials, now: number): OAuthCredentials | undefined {
  if (stored.source !== "local-cli") return undefined;
  const disk = detectClaudeCodeToken();
  if (!disk || disk.expires <= now + REFRESH_SKEW_MS) return undefined;
  return credentialGeneration(disk) !== credentialGeneration(stored) ? disk : undefined;
}

/**
 * Preserve an already-rotated Nous refresh token (RT-B) after a terminal refresh
 * error (e.g. the returned access JWT lacked `inference:invoke`). The unusable
 * access token is NOT persisted as valid: the recovery credential carries an
 * empty access placeholder with a past expiry so it can never be routed, and the
 * account is marked needsReauth by the caller. Generation-safe: a concurrent
 * newer write wins and is never overwritten.
 */
async function preserveNousRotatedRefresh(
  provider: string,
  accountId: string,
  rotatedRefresh: string,
  expectedGeneration: string,
  previous: OAuthCredentials,
): Promise<{ kind: "persisted"; generation: string } | { kind: "superseded" } | { kind: "failed" }> {
  try {
    const recovery: OAuthCredentials = {
      refresh: rotatedRefresh,
      // Never persist the unusable access token: an empty placeholder with a
      // past expiry can never be observed as a valid credential.
      access: "",
      expires: 0,
      ...(previous.accountId ? { accountId: previous.accountId } : {}),
      ...(previous.email ? { email: previous.email } : {}),
      ...(previous.source ? { source: previous.source } : {}),
    };
    const outcome = await mergeAccountCredential(provider, accountId, recovery, { expectedGeneration });
    if (outcome.superseded) return { kind: "superseded" };
    // Return the exact generation this write produced, so the caller never
    // re-reads the store (a concurrent writer could otherwise supply a different
    // credential generation and be marked needsReauth by mistake).
    return { kind: "persisted", generation: credentialGeneration(recovery) };
  } catch (error) {
    // A store-mutation busy outcome is transient and retryable; surface it
    // unchanged so the caller can retry rather than treating it as a permanent
    // RT-B persistence failure.
    if (error instanceof OAuthMutationBusyError) throw error;
    return { kind: "failed" };
  }
}

export async function refreshAnthropicAccountWithLock(
  provider: string,
  accountId: string,
  def: OAuthProviderDef,
  callerCredential: OAuthCredentials,
  deps: AnthropicRefreshDeps = {},
): Promise<string> {
  const writerGeneration = captureConfigGeneration();
  const now = deps.now ?? Date.now;
  const guard = await (deps.intentLock ?? createOAuthRefreshIntentLock(provider, accountId)).acquire();
  try {
    const stored = getAccountCredential(provider, accountId);
    if (!stored) throw new OAuthLoginRequiredError(provider);
    const account = getAccountSet(provider)?.accounts.find(candidate => candidate.id === accountId);
    const generation = credentialGeneration(stored);
    let pendingIntent = readOAuthRefreshIntent(provider, accountId);
    const disk = newerClaudeCredential(stored, now());
    if (disk) {
      const outcome = await mergeAccountCredential(provider, accountId, disk, {
        expectedGeneration: credentialGeneration(stored),
        afterPrePersistRead: deps.afterPrePersistRead,
      });
      if (outcome.superseded) {
        if (pendingIntent) clearOAuthRefreshIntent(provider, accountId, pendingIntent.generation);
        if (outcome.stored.expires > now() + REFRESH_SKEW_MS) return outcome.stored.access;
        throw new OAuthLoginRequiredError(provider);
      }
      if (pendingIntent) clearOAuthRefreshIntent(provider, accountId, pendingIntent.generation);
      return disk.access;
    }
    if (!pendingIntent?.uncertain && pendingIntent?.generation === generation) {
      if (pendingIntent.staleOwner) throw new OAuthTokenRefreshStaleError();
      if (deps.replacedStaleFlight && pendingIntent.flightId === deps.replacedStaleFlight.flightId) {
        if (deps.replacedStaleFlight.dispatched) {
          markOAuthRefreshIntentStaleOwner(provider, accountId, generation, deps.replacedStaleFlight.flightId);
          throw new OAuthTokenRefreshStaleError();
        }
        clearOAuthRefreshIntent(provider, accountId, generation);
        pendingIntent = undefined;
      }
    }
    if (pendingIntent?.uncertain || pendingIntent?.generation === generation) {
      await markAccountNeedsReauthIfGeneration(provider, accountId, generation, writerGeneration);
      throw new OAuthLoginRequiredError(provider);
    }
    if (pendingIntent) clearOAuthRefreshIntent(provider, accountId, pendingIntent.generation);
    if (account?.needsReauth) {
      throw new OAuthLoginRequiredError(provider);
    }
    if (credentialGeneration(stored) !== credentialGeneration(callerCredential) && stored.expires > now() + REFRESH_SKEW_MS) {
      return stored.access;
    }

    try {
      writeOAuthRefreshIntent(provider, accountId, generation, now(), deps.flight?.flightId);
      if (deps.signal?.aborted) throw deps.signal.reason;
      if (deps.flight) deps.flight.dispatched = true;
      const fresh = merged(await def.refresh(stored.refresh, deps.signal), stored);
      const outcome = await mergeAccountCredential(provider, accountId, fresh, {
        expectedGeneration: generation,
        afterPrePersistRead: deps.afterPrePersistRead,
      });
      if (outcome.superseded) {
        clearOAuthRefreshIntent(provider, accountId, generation);
        if (outcome.stored.expires > now() + REFRESH_SKEW_MS) return outcome.stored.access;
        throw new OAuthLoginRequiredError(provider);
      }
      clearOAuthRefreshIntent(provider, accountId, generation);
      return fresh.access;
    } catch (error) {
      if (error instanceof OAuthMutationBusyError) throw error;
      if (!terminal(error)) throw error;
      await markAccountNeedsReauthIfGeneration(provider, accountId, generation, writerGeneration);
      clearOAuthRefreshIntent(provider, accountId, generation);
      throw new OAuthLoginRequiredError(provider);
    }
  } finally {
    guard.release();
  }
}

export async function refreshGenericAccountWithLock(
  provider: string,
  accountId: string,
  def: OAuthProviderDef,
  callerCredential: OAuthCredentials,
  deps: GenericRefreshDeps = {},
): Promise<string> {
  const writerGeneration = captureConfigGeneration();
  logOAuthEvent("OAuth refresh started", { provider, accountId });
  const guard = await (deps.intentLock ?? createOAuthRefreshIntentLock(provider, accountId)).acquire();
  try {
    const stored = getAccountCredential(provider, accountId);
    if (!stored) throw new OAuthLoginRequiredError(provider);
    if (
      credentialGeneration(stored) !== credentialGeneration(callerCredential)
      && stored.expires > Date.now() + REFRESH_SKEW_MS
    ) {
      logOAuthEvent("OAuth refresh joined existing operation", { provider, accountId });
      return stored.access;
    }
    const generation = credentialGeneration(stored);
    try {
      const fresh = merged(await def.refresh(stored.refresh, deps.signal, stored), stored);
      const outcome = await mergeAccountCredential(provider, accountId, fresh, {
        expectedGeneration: generation,
        afterPrePersistRead: deps.afterPrePersistRead,
      });
      if (outcome.superseded) {
        if (outcome.stored.expires > Date.now() + REFRESH_SKEW_MS) return outcome.stored.access;
        throw new OAuthLoginRequiredError(provider);
      }
      logOAuthEvent("OAuth credentials rotated and persisted", { provider, accountId });
      // Best-effort bookkeeping cleanup: the rotated credential is already
      // durably persisted. A failure to unlink the old-token intent file
      // (EACCES/EPERM/EBUSY/EROFS) must not turn a committed rotation into a
      // failed refresh. The stale intent keys the OLD token, which is no longer
      // stored, so leaving it behind blocks nothing and is safe. It must also
      // never route through the generic refresh error path (no needsReauth).
      if (provider === "nous") {
        try {
          clearNousRefreshIntent(stored.refresh);
        } catch (cleanupErr) {
          logOAuthEvent("OAuth refresh intent cleanup failed (non-fatal)", {
            provider,
            accountId,
            cause: cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr),
          });
        }
      }
      return fresh.access;
    } catch (error) {
      if (error instanceof OAuthMutationBusyError) throw error;
      if (!terminal(error)) throw error;
      // Nous-specific failure-atomicity: a terminal refresh error that carries
      // an already-issued rotated refresh token (e.g. the access JWT lacked the
      // required `inference:invoke` scope) means the server consumed RT-A and
      // issued RT-B. RT-B must be preserved generation-safely BEFORE forcing
      // reauthentication; discarding it would lose the only usable refresh
      // material and force a full re-auth for no reason.
      if (provider === "nous" && error instanceof NousTokenError) {
        const rotated = error.getRotatedRefresh();
        if (rotated !== undefined && rotated !== stored.refresh) {
          const outcome = await preserveNousRotatedRefresh(
            provider,
            accountId,
            rotated,
            generation,
            stored,
          );
          if (outcome.kind === "persisted") {
            // RT-A's intent is cleared only after RT-B is durably persisted;
            // cleanup itself stays best-effort (a stale RT-A intent keys a token
            // that is no longer stored).
            try {
              clearNousRefreshIntent(stored.refresh);
            } catch (cleanupErr) {
              logOAuthEvent("OAuth refresh intent cleanup failed (non-fatal)", {
                provider,
                accountId,
                cause: cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr),
              });
            }
            // Mark exactly the generation this write produced — never a
            // credential written by a concurrent login between the merge and
            // this step.
            await markAccountNeedsReauthIfGeneration(provider, accountId, outcome.generation, writerGeneration);
          } else {
            // RT-B persistence failed or a newer generation superseded it:
            // never clear RT-A's intent (RT-A was consumed), and mark the old
            // generation needsReauth (a no-op if a newer generation won).
            await markAccountNeedsReauthIfGeneration(provider, accountId, generation, writerGeneration);
          }
          throw new OAuthLoginRequiredError(provider);
        }
      }
      await markAccountNeedsReauthIfGeneration(provider, accountId, generation, writerGeneration);
      throw new OAuthLoginRequiredError(provider);
    }
  } finally {
    guard.release();
  }
}

async function refreshAndPersistAccessToken(
  provider: string,
  accountId: string,
  def: OAuthProviderDef,
  cred: OAuthCredentials,
  signal?: AbortSignal,
  flight?: OAuthRefreshFlightEvidence,
  replacedStaleFlight?: OAuthRefreshFlightEvidence,
): Promise<string> {
  if (provider === "xai") return refreshXaiAccountWithLock(provider, accountId, def, cred, { signal });
  if (provider === "anthropic") return refreshAnthropicAccountWithLock(provider, accountId, def, cred, { signal, flight, replacedStaleFlight });
  return refreshGenericAccountWithLock(provider, accountId, def, cred, { signal });
}

/**
 * Shared bearer-token resolver for /models listing — used by BOTH server.ts:fetchAllModels and
 * codex-catalog.ts:fetchProviderModels so OAuth providers' models are listed once logged in.
 * Returns undefined for forward-mode or oauth-not-logged-in (caller skips).
 */
export async function resolveModelsAuthToken(name: string, prov: OcxProviderConfig): Promise<string | undefined> {
  if (prov.authMode === "forward") return undefined;
  if (prov.authMode === "oauth") {
    try {
      return await getValidAccessToken(name);
    } catch {
      return undefined;
    }
  }
  return resolveEnvValue(prov.apiKey);
}

function modelDiscoveryTransportSeed(providerName: string, prov: OcxProviderConfig): OcxProviderConfig {
  const entry = getProviderRegistryEntry(providerName);
  if (
    prov.authMode !== "oauth"
    || entry?.authKind !== "oauth"
    || entry.allowBaseUrlOverride === true
    || /\{[^}]*\}/.test(entry.baseUrl)
    || !providerMatchesRegistryTransport(providerName, prov)
  ) {
    return prov;
  }
  // Normal routing pins fixed OAuth presets before adapter-specific transport resolution.
  // Discovery must do the same so a stale or modified config baseUrl never receives a token.
  return { ...prov, adapter: entry.adapter, baseUrl: entry.baseUrl };
}

/**
 * Provider-correct model-discovery request (URL + headers), so both model-listing paths fetch the
 * LIVE catalog correctly per adapter. Anthropic is the special case: its endpoint is `/v1/models`
 * (not `/models`), it needs `anthropic-version`, and it authenticates with `x-api-key` by default
 * (or `Authorization: Bearer` when `apiKeyTransport = "bearer"`), plus the OAuth beta for oauth
 * mode — not a bare Bearer. Google (ai-studio mode)
 * is the other special case: `x-goog-api-key` + `/v1beta/models`, returning `{ models: [...] }`.
 * The catalog authority gate intentionally degrades that non-OpenAI shape to stale/static data.
 * Antigravity uses its CCA `:fetchAvailableModels` RPC; everyone else uses the OpenAI-style
 * `/models` + Bearer with a `{ data: [{ id, owned_by? }] }` response.
 */
export interface ModelsRequestObservedAuth {
  readonly oauthApiBaseUrl?: string;
}

export function buildModelsRequest(
  prov: OcxProviderConfig,
  apiKey: string | undefined,
  providerName = "",
  observedAuth?: ModelsRequestObservedAuth,
): { method?: "POST"; url: string; headers: Record<string, string> } {
  const transportSeed = modelDiscoveryTransportSeed(providerName, prov);
  const copilotApiBaseUrl = observedAuth === undefined
    ? (providerName === "github-copilot" ? getOAuthCredentialApiBaseUrl(providerName) : undefined)
    : observedAuth.oauthApiBaseUrl;
  const effectiveProvider = resolveProviderTransport(
    providerName,
    transportSeed,
    undefined,
    copilotApiBaseUrl,
  );
  // Model discovery is an upstream request like any other, so it carries the same registry
  // static headers the inference path does. Without this a provider is identified correctly
  // when it answers a completion but anonymously when it lists its own models, which is the
  // kind of split fingerprint an upstream rate limiter reads as two different clients.
  const registryStaticHeaders = providerMatchesRegistryTransport(providerName, effectiveProvider)
    ? getProviderRegistryEntry(providerName)?.staticHeaders
    : undefined;
  const headers: Record<string, string> = {
    ...(mergeRegistryStaticHeaders(registryStaticHeaders, effectiveProvider.headers) ?? {}),
  };
  const discoveryUrl = (defaultUrl: string): string => resolveProviderModelDiscoveryUrl(
    providerName,
    prov,
    effectiveProvider.baseUrl,
    defaultUrl,
  );
  if (effectiveGoogleMode(providerName, effectiveProvider) === "cloud-code-assist") {
    headers.Accept = "application/json";
    headers["Content-Type"] = "application/json";
    headers["User-Agent"] = ANTIGRAVITY_REQUEST_UA;
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
    return {
      method: "POST",
      url: discoveryUrl(`${effectiveProvider.baseUrl.replace(/\/+$/, "")}/v1internal:fetchAvailableModels`),
      headers,
    };
  }
  if (effectiveGoogleMode(providerName, effectiveProvider) === "ai-studio") {
    // Generative Language API: API key goes in x-goog-api-key (never Authorization: Bearer),
    // models live under /v1beta (v1 misses preview models), and pageSize maxes at 1000 —
    // enough to list everything without a pageToken loop. Vertex/antigravity keep the
    // generic branch (they fall back to their static model lists).
    if (apiKey) headers["x-goog-api-key"] = apiKey;
    return { url: discoveryUrl(`${effectiveProvider.baseUrl}/v1beta/models?pageSize=1000`), headers };
  }
  if (effectiveProvider.adapter === "anthropic") {
    const base = effectiveProvider.baseUrl.replace(/\/v1\/?$/, "");
    headers["anthropic-version"] = "2023-06-01";
    if (effectiveProvider.authMode === "oauth") {
      headers["anthropic-beta"] = ANTHROPIC_OAUTH_BETA;
      if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;
    } else if (apiKey) {
      if (effectiveProvider.apiKeyTransport === "bearer") headers["Authorization"] = `Bearer ${apiKey}`;
      else headers["x-api-key"] = apiKey;
    }
    return { url: discoveryUrl(`${base}/v1/models?limit=1000`), headers };
  }
  if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;
  return { url: discoveryUrl(`${effectiveProvider.baseUrl}/models`), headers };
}

/**
 * Refresh OAuth-managed provider presets (`models`, `noReasoningModels`, and a stale `defaultModel`)
 * from the registry so a proxy update that revises a provider's models — e.g. dropping deprecated
 * Claude snapshots or adding a new grok endpoint not in the live `/models` — reaches EXISTING
 * configs on the next `ocx start`, instead of only fresh installs. The live `/models` fetch stays
 * the primary source; this keeps the static fallback (and models-not-in-/models) current.
 *
 * Only touches providers that are registry-managed AND still `authMode: "oauth"`. Preset fields
 * are refreshed, while the registry's `liveModels` default is normally filled only when no value
 * is stored. Persists + returns true when anything changed.
 */
function cloneProviderField(value: unknown): unknown {
  if (Array.isArray(value)) return [...value];
  if (value && typeof value === "object") return JSON.parse(JSON.stringify(value));
  return value;
}

const OAUTH_RECONCILE_FIELDS: (keyof OcxProviderConfig)[] = [
  "models",
  "contextWindow",
  "modelContextWindows",
  "defaultMaxOutputTokens",
  "modelMaxOutputTokens",
  "modelInputModalities",
  "noReasoningModels",
  "noVisionModels",
  "reasoningEfforts",
  "modelReasoningEfforts",
  "reasoningEffortMap",
  "modelReasoningEffortMap",
  "noTemperatureModels",
  "noTopPModels",
  "noPenaltyModels",
  "autoToolChoiceOnlyModels",
  "preserveReasoningContentModels",
];
// `requiresReasoningPlaceholderModels` is deliberately NOT reconciled here: no
// OAuth preset seeds it, so the delete-when-preset-undefined branch would wipe
// an explicit user opt-out (`[]`) on every startup. Registry seeds still reach
// existing rows through enrichProviderFromRegistry, which is fill-only and
// preserves explicit saved values.

const GOOGLE_ANTIGRAVITY_PROVIDER = "google-antigravity";
const GOOGLE_ANTIGRAVITY_LIVE_DISCOVERY_VERSION = 2 as const;

/** Only migrate the three-model experimental seed; an operator's later `liveModels: false` wins. */
function isLegacyCommandCodeStaticCatalog(provider: OcxProviderConfig): boolean {
  return provider.liveModels === false
    && provider.defaultModel === "deepseek-v4-flash"
    && JSON.stringify(provider.models) === JSON.stringify(["deepseek-v4-flash", "kimi-k3", "glm-5.2"]);
}

function isLegacyAntigravityStaticCatalog(provider: OcxProviderConfig): boolean {
  // A fingerprint of the shape version 1 actually shipped, NOT of the current registry.
  // These literals must stay frozen as the model list moves on: matching them is how we
  // know the row is the untouched v1 seed rather than a user's own selection.
  return provider.liveModels === false
    && provider.adapter === "google"
    && provider.baseUrl === "https://daily-cloudcode-pa.googleapis.com"
    && provider.authMode === "oauth"
    && provider.googleMode === "cloud-code-assist"
    && provider.defaultModel === "gemini-3.6-flash"
    && JSON.stringify(provider.models) === JSON.stringify([
      "gemini-3.6-flash",
      "gemini-3.1-pro",
      "gemini-3.1-flash-image",
      "claude-sonnet-4-6",
      "claude-opus-4-6-thinking",
      "gpt-oss-120b-medium",
    ]);
}

/** Promote only the versioned canonical static seed; unmarked `liveModels: false` remains user intent. */
function migrateLegacyAntigravityStaticCatalog(config: OcxConfig): boolean {
  if (config.googleAntigravityStaticCatalogVersion !== 1) return false;
  const provider = config.providers[GOOGLE_ANTIGRAVITY_PROVIDER];
  if (provider && isLegacyAntigravityStaticCatalog(provider)) provider.liveModels = true;
  config.googleAntigravityStaticCatalogVersion = GOOGLE_ANTIGRAVITY_LIVE_DISCOVERY_VERSION;
  return true;
}

export function reconcileOAuthProviders(config: OcxConfig): boolean {
  let changed = migrateLegacyAntigravityStaticCatalog(config);
  for (const [name, prov] of Object.entries(config.providers)) {
    const def = OAUTH_PROVIDERS[name];
    if (name === "command-code" && isLegacyCommandCodeStaticCatalog(prov)) {
      // The former experimental preset was the exact three-model seed above. It was not a user
      // choice to disable discovery, so promote only that shape to the account live catalog.
      prov.liveModels = true;
      changed = true;
    }
    if (!def || prov.authMode !== "oauth") continue;
    const preset = def.providerConfig;
    for (const field of OAUTH_RECONCILE_FIELDS) {
      if (JSON.stringify(prov[field]) === JSON.stringify(preset[field])) continue;
      if (preset[field] !== undefined) {
        prov[field] = cloneProviderField(preset[field]) as never;
      } else {
        delete prov[field];
      }
      changed = true;
    }
    if (prov.liveModels === undefined && preset.liveModels !== undefined) {
      prov.liveModels = preset.liveModels;
      changed = true;
    }
    // Heal a defaultModel that no longer exists in the refreshed list (e.g. a deprecated snapshot).
    // Skip providers without a static preset `models` list: for live-discovery providers
    // (e.g. command-code OAuth) the account-scoped catalog is not enumerable here, so any
    // persisted defaultModel is a user selection and must not be overwritten by the seed.
    if (prov.defaultModel && preset.defaultModel && preset.models && preset.models.length > 0 && !(prov.models ?? []).includes(prov.defaultModel)) {
      prov.defaultModel = preset.defaultModel;
      changed = true;
    }
  }
  if (changed) saveConfig(config);
  return changed;
}

/** Runtime guards: provider config is intentionally passthrough, so persisted fields may be malformed. */
function preservableApiKeyPool(value: unknown): NonNullable<OcxProviderConfig["apiKeyPool"]> | undefined {
  if (!Array.isArray(value)) return undefined;
  const pool: NonNullable<OcxProviderConfig["apiKeyPool"]> = [];
  const ids = new Set<string>();
  const keys = new Set<string>();
  for (const entry of value as unknown[]) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const candidate = entry as Record<string, unknown>;
    const id = typeof candidate.id === "string" ? candidate.id.trim() : "";
    const key = sanitizeApiKeyValue(candidate.key);
    if (!id || !key || ids.has(id) || keys.has(key)) continue;
    const label = typeof candidate.label === "string" ? candidate.label : undefined;
    const addedAt = typeof candidate.addedAt === "number" && Number.isFinite(candidate.addedAt)
      ? candidate.addedAt
      : undefined;
    ids.add(id);
    keys.add(key);
    pool.push({
      id,
      key,
      ...(label !== undefined ? { label } : {}),
      ...(addedAt !== undefined ? { addedAt } : {}),
    });
  }
  // `apiKey` remains the routing source of truth. Keep valid alternate slots even when a
  // hand-edited config left the pool out of sync, rather than deleting usable credentials.
  return pool.length > 0 ? pool : undefined;
}

/**
 * Add/refresh an OAuth provider's config entry on a config object (does not persist).
 *
 * Providers whose registry entry sets `allowKeyAuthOverride` (xai, github-copilot) can be
 * billed through a stored API key instead of the OAuth login (router.ts honors
 * `authMode: "key"` for them). A blind preset overwrite here deletes `apiKey`/`apiKeyPool`
 * on every OAuth login, silently destroying the stored key and forcing a re-paste — and it
 * flips billing back to the subscription without the user asking. Carry the key fields over
 * and keep key billing while usable key material remains and the user was not explicitly on
 * oauth. If the final key was removed and only the old key mode remains, let the OAuth
 * preset restore `authMode: "oauth"` so the newly saved OAuth credential can be used.
 *
 * After preservation, `apiKey` always has exactly one matching pool entry (inserting via the
 * same content-derived id as the API-key manager when the active key was missing from the
 * pool). Key mode reflects stored user intent (explicit `"key"` or omitted mode with safe
 * key material) — never whether the login CLI process can resolve an env reference. Env-backed
 * availability is decided at proxy routing time in `router.ts`.
 */
export function upsertOAuthProvider(config: OcxConfig, provider: string): void {
  if (provider === "chatgpt") return;
  const def = OAUTH_PROVIDERS[provider];
  if (!def) return;
  if (provider === GOOGLE_ANTIGRAVITY_PROVIDER) migrateLegacyAntigravityStaticCatalog(config);
  const namespaceCollision = codexAccountNamespaceProviderCollisionError(config.codexAccountNamespaces, provider);
  if (namespaceCollision) throw new Error(namespaceCollision);
  const existing = config.providers[provider];
  const next: OcxProviderConfig = { ...def.providerConfig };
  // `liveModels` is a user-facing provider toggle. Preserve either explicit setting across login;
  // Antigravity's CCA discovery now uses its real RPC, so legacy `true` remains a valid choice.
  if (typeof existing?.liveModels === "boolean" && !isLegacyCommandCodeStaticCatalog(existing)) {
    next.liveModels = existing.liveModels;
  }
  // The Command Code protocol-version pin is an operator compatibility control. A re-login,
  // add-account, or reauth rebuilds the row from the preset, which has no version; carry the
  // existing pin so authentication changes do not silently revert the documented control.
  if (existing?.commandCodeVersion !== undefined) {
    next.commandCodeVersion = existing.commandCodeVersion;
  }
  // User-configured price overlays are operator data, not preset state; a
  // re-login, add-account, or reauth must not silently drop them from the
  // Logs/Usage estimates.
  if (existing?.modelCosts !== undefined) {
    next.modelCosts = existing.modelCosts;
  }
  if (existing && getProviderRegistryEntry(provider)?.allowKeyAuthOverride === true) {
    // Shared sanitizeApiKeyValue trim / no-CRLF checks from api-key pool writes.
    let storedApiKey = sanitizeApiKeyValue(existing.apiKey);
    const storedApiKeyPool = preservableApiKeyPool(existing.apiKeyPool);
    // Unsafe/blank active key with a usable pool: promote the first safe pool entry so
    // key billing keeps working instead of falling back to oauth while pool keys remain.
    if (storedApiKey === undefined && storedApiKeyPool && storedApiKeyPool.length > 0) {
      storedApiKey = storedApiKeyPool[0]!.key;
    }
    if (storedApiKey !== undefined) {
      const pool = storedApiKeyPool ? [...storedApiKeyPool] : [];
      // Keep routing and listProviderApiKeys in sync: never leave a hidden active key that
      // is absent from the pool (listing would fall back to pool[0] as "active").
      if (!pool.some(entry => entry.key === storedApiKey)) {
        pool.push({ id: apiKeyPoolEntryId(storedApiKey), key: storedApiKey });
      }
      next.apiKey = storedApiKey;
      next.apiKeyPool = pool;
      const previousModeAllowsKey = existing.authMode === "key" || existing.authMode === undefined;
      if (previousModeAllowsKey) next.authMode = "key";
    }
  }
  config.providers[provider] = next;
}

interface RunLoginDeps {
  saveCredential?: typeof saveCredential;
  saveAccountCredential?: typeof saveAccountCredential;
  loadConfig?: typeof loadConfig;
  saveConfig?: typeof saveConfig;
  settleKiroLoginTransaction?: typeof settleKiroLoginTransaction;
  removeAccount?: typeof removeAccount;
  setActiveAccount?: typeof setActiveAccount;
  assertCurrentOwner?: () => void;
}

/** Roll back only accounts created by this forced login, preserving concurrent refreshes of others. */
async function rollbackForcedKiroAccountWrite(
  provider: string,
  previousActiveId: string | undefined,
  previousAccountIds: ReadonlySet<string>,
  deps: Pick<RunLoginDeps, "removeAccount" | "setActiveAccount">,
): Promise<void> {
  const set = getAccountSet(provider);
  if (!set) return;
  for (const account of [...set.accounts]) {
    if (previousAccountIds.has(account.id)) continue;
    await (deps.removeAccount ?? removeAccount)(provider, account.id);
  }
  if (previousActiveId && getAccountCredential(provider, previousActiveId)) {
    await (deps.setActiveAccount ?? setActiveAccount)(provider, previousActiveId);
  }
}

/** Run the login flow, persist the credential + upsert the provider entry to disk, return cred. */
export async function runLogin(
  provider: string,
  ctrl: OAuthController,
  opts?: LoginOpts,
  deps: RunLoginDeps = {},
): Promise<OAuthCredentials> {
  const def = OAUTH_PROVIDERS[provider];
  if (!def) throw new UnsupportedOAuthProviderError(provider);
  const loadLatestConfig = deps.loadConfig ?? loadConfig;
  const saveLatestConfig = deps.saveConfig ?? saveConfig;
  if (provider !== "chatgpt") {
    const preflightConfig = loadLatestConfig();
    const namespaceCollision = codexAccountNamespaceProviderCollisionError(
      preflightConfig.codexAccountNamespaces,
      provider,
    );
    if (namespaceCollision) throw new Error(namespaceCollision);
  }
  // loginKiro keys its pending CLI-session transaction by object identity. Keep this exact object
  // for settlement even when source normalization below creates a derived credential object.
  const shouldRollbackKiroAccounts = provider === "kiro" && opts?.forceLogin === true;
  const previousKiroAccounts = shouldRollbackKiroAccounts ? getAccountSet(provider) : undefined;
  const previousKiroActiveId = previousKiroAccounts?.activeAccountId;
  const previousKiroAccountIds = new Set(previousKiroAccounts?.accounts.map(account => account.id) ?? []);
  const rawCred = await def.login(ctrl, opts);
  const cred: OAuthCredentials = rawCred.source ? rawCred : { ...rawCred, source: "oauth" };
  const settleKiroTransaction = deps.settleKiroLoginTransaction ?? settleKiroLoginTransaction;
  try {
    deps.assertCurrentOwner?.();
    // Validate the provider row before credential persistence. A namespace claimed during the
    // credential write is handled again below before the latest row is re-upserted.
    if (provider !== "chatgpt") {
      const preCommitConfig = loadLatestConfig();
      upsertOAuthProvider(preCommitConfig, provider);
    }
    if (opts?.reauthAccountId) {
      const existing = getAccountCredential(provider, opts.reauthAccountId);
      if (!existing) throw new Error(`Unknown account for reauth: ${opts.reauthAccountId}`);
      if (!existing.accountId && !existing.email) {
        throw new OAuthReauthIdentityUnverifiedError();
      }
      const identityMatches = existing.accountId && cred.accountId
        ? existing.accountId === cred.accountId
        : existing.email && cred.email
          ? existing.email.toLowerCase() === cred.email.toLowerCase()
          : false;
      if (!identityMatches) {
        throw new OAuthReauthIdentityMismatchError();
      }
      await (deps.saveAccountCredential ?? saveAccountCredential)(provider, opts.reauthAccountId, cred, {
        assertBeforePersist: deps.assertCurrentOwner,
      });
    } else {
      await (deps.saveCredential ?? saveCredential)(provider, cred, {
        preserveIdentityless: opts?.forceLogin === true,
        assertBeforePersist: deps.assertCurrentOwner,
      });
    }
    if (provider !== "chatgpt") {
      // Re-run against post-credential state so same-provider API-key additions, removals,
      // and active-key switches survive. A late namespace claim wins over provider creation.
      const latestConfig = loadLatestConfig();
      const lateCollision = codexAccountNamespaceProviderCollisionError(
        latestConfig.codexAccountNamespaces,
        provider,
      );
      if (lateCollision) {
        throw new OAuthProviderPublicationError();
      }
      upsertOAuthProvider(latestConfig, provider);
      saveLatestConfig(latestConfig);
    }
  } catch (error) {
    const errors: unknown[] = [error];
    if (shouldRollbackKiroAccounts) {
      try {
        await rollbackForcedKiroAccountWrite(provider, previousKiroActiveId, previousKiroAccountIds, deps);
      } catch (rollbackError) {
        errors.push(rollbackError);
      }
    }
    try {
      settleKiroTransaction(rawCred, false);
    } catch (restoreError) {
      errors.push(restoreError);
    }
    if (errors.length > 1) {
      throw new AggregateError(
        errors,
        "Kiro login persistence failed and the previous Kiro CLI session could not be restored.",
      );
    }
    throw error;
  }
  settleKiroTransaction(rawCred, true);
  if (provider !== "chatgpt") {
    try {
      const { clearModelCache } = await import("../codex/model-cache");
      const { clearGatherRoutedModelsInflight } = await import("../codex/catalog");
      clearModelCache(provider);
      clearGatherRoutedModelsInflight();
      const { clearAccountQuotaCache, clearProviderQuotaCache } = await import("../providers/quota");
      clearProviderQuotaCache();
      clearAccountQuotaCache(provider);
    } catch {
      // Optional state modules may be unavailable in tightly scoped unit tests.
    }
  }
  return cred;
}

/**
 * GUI async login: start the flow, return the auth URL EARLY (the flow keeps running in the
 * background until the callback server captures the redirect), with a concurrency guard and an
 * error surfaced via getLoginStatus().
 *
 * Manual fallback: when the browser cannot reach the loopback callback (remote GUI, SSH, blocked
 * localhost), the GUI can POST the final redirect URL or authorization code via
 * submitManualLoginCode(), which feeds OAuthController.onManualCodeInput.
 */
const loginState = new Map<string, { error?: string; done: boolean }>();
const loginAbort = new Map<string, AbortController>();
const kiroLoginSettling = new Set<string>();

/** Pending paste for a login in progress: either a waiter or a stashed early submission. */
interface ManualCodeSlot {
  pendingInput?: string;
  resolve?: (value: string) => void;
  /** Registered by the callback flow so submits can validate state synchronously. */
  expectedState?: string;
}
const loginManual = new Map<string, ManualCodeSlot>();
const OAUTH_PENDING_CODE_MAX_BYTES = 4 * 1024;
let lastOAuthFlowReconciledGeneration = 0;

export function reconcileOAuthFlowState(context: GenerationContext): number {
  if (context.generation <= lastOAuthFlowReconciledGeneration) return 0;
  let removed = 0;
  for (const [provider, state] of loginState) {
    if (context.providerNames.has(provider) || !state.done || loginAbort.has(provider)) continue;
    if (loginState.delete(provider)) removed += 1;
    if (loginManual.delete(provider)) removed += 1;
    if (loginAbort.delete(provider)) removed += 1;
  }
  lastOAuthFlowReconciledGeneration = context.generation;
  return removed;
}

function clearManualCodeSlot(provider: string): void {
  loginManual.delete(provider);
}

function ensureManualCodeSlot(provider: string): ManualCodeSlot {
  let slot = loginManual.get(provider);
  if (!slot) {
    slot = {};
    loginManual.set(provider, slot);
  }
  return slot;
}

/** Wait for a GUI/CLI paste of the OAuth redirect URL or code (or return a stashed early submit). */
function waitForManualLoginCode(provider: string, signal: AbortSignal, expectedState?: string): Promise<string> {
  if (signal.aborted) {
    return Promise.reject(new Error(`OAuth callback cancelled: ${signal.reason}`));
  }
  const slot = ensureManualCodeSlot(provider);
  if (expectedState !== undefined) slot.expectedState = expectedState;
  if (slot.pendingInput !== undefined) {
    const value = slot.pendingInput;
    slot.pendingInput = undefined;
    return Promise.resolve(value);
  }
  return new Promise<string>((resolve, reject) => {
    const onAbort = () => {
      if (slot.resolve === resolve) slot.resolve = undefined;
      reject(new Error(`OAuth callback cancelled: ${signal.reason}`));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    slot.resolve = (value: string) => {
      signal.removeEventListener("abort", onAbort);
      if (slot.resolve === resolve) slot.resolve = undefined;
      resolve(value);
    };
  });
}

/**
 * Feed a pasted redirect URL or authorization code into an in-progress GUI login.
 * Returns ok:false when no login is waiting (or input is empty). Invalid pastes are accepted
 * here and re-prompted by the OAuth callback loop if they cannot be parsed / fail state checks.
 */
export function submitManualLoginCode(provider: string, input: string): { ok: true } | { ok: false; error: string } {
  const trimmed = input.trim();
  if (!trimmed) return { ok: false, error: "empty code" };
  if (retainedUtf8Bytes(trimmed) > OAUTH_PENDING_CODE_MAX_BYTES) return { ok: false, error: "code too large" };
  const st = loginState.get(provider);
  if (!st || st.done) return { ok: false, error: "no login in progress" };
  const slot = ensureManualCodeSlot(provider);
  // Synchronous validation (validated request/ack): reject un-parseable input and
  // authorization responses (url/query kind) whose state is missing or mismatched
  // once the flow has registered its expected state. Raw codes stay in-session-PKCE
  // protected. Early posts (flow not yet waiting, no expectedState) are stashed and
  // re-validated by the callback loop.
  const parsed = parseCallbackInput(trimmed);
  // Command Code's manual fallback accepts a pasted JSON callback payload
  // (`{ apiKey, state, ... }`) which has no `code` param. Let it through the
  // shared gate so the provider-specific parser can validate it.
  const isCommandCodeJson = provider === "command-code" && trimmed.startsWith("{") && !parsed.code;
  if (!parsed.code && !isCommandCodeJson) return { ok: false, error: "no authorization code found in input" };
  if (parsed.kind !== "raw" && slot.expectedState !== undefined) {
    if (parsed.state === undefined) return { ok: false, error: "redirect URL is missing the state parameter" };
    if (parsed.state !== slot.expectedState) return { ok: false, error: "state mismatch — paste the redirect URL from THIS login attempt" };
  }
  if (slot.resolve) {
    const resolve = slot.resolve;
    slot.resolve = undefined;
    resolve(trimmed);
  } else {
    // Race: GUI may POST before the flow reaches onManualCodeInput — stash for the waiter.
    slot.pendingInput = trimmed;
  }
  return { ok: true };
}

export interface OAuthAccountSummary { id: string; alias?: string; email?: string; active: boolean; needsReauth?: boolean; expiresAt?: number }

export function getLoginStatus(provider: string): { loggedIn: boolean; email?: string; source?: OAuthCredentials["source"]; error?: string; done: boolean; activeAccountId?: string; accounts?: OAuthAccountSummary[] } {
  const cred = getCredential(provider);
  const st = loginState.get(provider);
  const set = getAccountSet(provider);
  const accounts: OAuthAccountSummary[] | undefined = set?.accounts.map(a => ({
    id: a.id,
    ...(a.alias ? { alias: a.alias } : {}),
    email: maskEmail(a.credential.email) ?? undefined,
    active: a.id === set.activeAccountId,
    ...(a.needsReauth ? { needsReauth: true } : {}),
    expiresAt: a.credential.expires,
  }));

  // A stored credential counts as "logged in" when it exists and is not marked for
  // re-authentication. An expired access token with a valid refresh token is still
  // logged in: request resolution refreshes expired/near-expiry credentials lazily.
  // Invalid/unknown local-import expiries are handled at parse/adoption time
  // (local-token-detect.ts), never by over-reporting login state here.
  const activeNeedsReauth = set?.accounts
    .find(a => a.id === set.activeAccountId)?.needsReauth === true;
  return {
    loggedIn: !!cred && !activeNeedsReauth,
    email: maskEmail(cred?.email) ?? undefined,
    source: cred?.source,
    error: st?.error,
    done: st?.done ?? false,
    ...(set ? { activeAccountId: set.activeAccountId, accounts } : {}),
  };
}

/** Token-safe per-provider login state for the CLI `ocx status` logins section (no tokens, masked email). */
export function oauthLoginSummary(): Array<{ provider: string; loggedIn: boolean; email?: string }> {
  return listOAuthProviders().map(provider => {
    const status = getLoginStatus(provider);
    return { provider, loggedIn: status.loggedIn, ...(status.email ? { email: status.email } : {}) };
  });
}

export function clearLoginState(provider: string): void {
  loginAbort.get(provider)?.abort("cleared");
  loginAbort.delete(provider);
  clearManualCodeSlot(provider);
  loginState.delete(provider);
}

export function cancelLoginFlow(provider: string): boolean {
  const ctrl = loginAbort.get(provider);
  const existing = loginState.get(provider);
  if (!ctrl && (!existing || existing.done)) return false;
  ctrl?.abort("cancelled");
  loginAbort.delete(provider);
  clearManualCodeSlot(provider);
  loginState.set(provider, { done: true, error: "Login cancelled" });
  return true;
}

export async function startLoginFlow(
  provider: string,
  opts?: LoginOpts,
  lifecycle?: LoginFlowLifecycle,
): Promise<{ url: string; instructions?: string; deviceCode?: string }> {
  const def = OAUTH_PROVIDERS[provider];
  if (!def) throw new UnsupportedOAuthProviderError(provider);
  const existing = loginState.get(provider);
  if ((existing && !existing.done) || (provider === "kiro" && kiroLoginSettling.has(provider))) {
    throw new Error(`A login for ${provider} is already in progress`);
  }
  clearManualCodeSlot(provider);
  loginState.set(provider, { done: false });
  const abort = new AbortController();
  loginAbort.set(provider, abort);
  if (provider === "kiro") kiroLoginSettling.add(provider);
  return new Promise((resolve, reject) => {
    let urlResolved = false;
    const ctrl: OAuthController = {
      onAuth: ({ url, instructions, deviceCode }) => {
        urlResolved = true;
        resolve({ url, instructions, deviceCode });
      },
      onProgress: () => {},
      // GUI fallback when the browser cannot hit the loopback callback server.
      onManualCodeInput: (expectedState?: string) => waitForManualLoginCode(provider, abort.signal, expectedState),
      signal: abort.signal,
    };
    const abandonIfNotOwner = (error?: unknown): boolean => {
      if (loginAbort.get(provider) === abort) return false;
      if (!urlResolved) reject(error ?? new Error("OAuth login was superseded"));
      return true;
    };
    const settle = async (error?: unknown): Promise<void> => {
      // Cancellation deletes this controller and records its own terminal result. A late provider
      // rejection (or an older flow settling after a replacement starts) must not overwrite that
      // state or delete the replacement flow's controller/manual-code slot.
      if (abandonIfNotOwner(error)) return;
      let finalError = error;
      try {
        await lifecycle?.onSettled?.();
      } catch (settleError) {
        // A successful credential/config commit is not fully live until its owner reconciles the
        // runtime config. For an already-failed login, keep the original recovery error.
        if (finalError === undefined) finalError = settleError;
      }
      if (abandonIfNotOwner(finalError)) return;
      if (finalError === undefined) {
        loginAbort.delete(provider);
        clearManualCodeSlot(provider);
        loginState.set(provider, { done: true });
        // Local-token import (grok-cli / Claude Code keychain) completes WITHOUT firing onAuth —
        // resolve so the GUI call returns instead of hanging.
        if (!urlResolved) resolve({ url: "", instructions: "Logged in via an existing local CLI/keychain token — no browser needed." });
        return;
      }

      const e = finalError;
      loginAbort.delete(provider);
      clearManualCodeSlot(provider);
      const msg = publicOAuthAuthenticationErrorMessage(e);
      loginState.set(provider, { done: true, error: msg });
      if (!urlResolved) reject(e);
    };
    // Background: runLogin persists the credential + provider entry to disk. The lifecycle hook
    // lets a long-lived server config adopt that settled state before clients observe done=true.
    const assertCurrentOwner = (): void => {
      if (loginAbort.get(provider) !== abort) throw new OAuthLoginSupersededError();
    };
    void runLogin(provider, ctrl, opts, { assertCurrentOwner }).then(
      () => settle(),
      (e: unknown) => settle(e),
    ).catch((e: unknown) => {
      // settle catches lifecycle failures, so this is only a defensive promise-boundary guard.
      if (abandonIfNotOwner(e)) return;
      loginAbort.delete(provider);
      clearManualCodeSlot(provider);
      const msg = publicOAuthAuthenticationErrorMessage(e);
      loginState.set(provider, { done: true, error: msg });
      if (!urlResolved) reject(e);
    }).finally(() => {
      if (provider === "kiro") kiroLoginSettling.delete(provider);
    });
  });
}
