import type { OAuthController, OAuthCredentials } from "./types";
import { parseCallbackInput } from "./callback-server";
import type { OcxConfig, OcxProviderConfig, RefreshPolicy } from "../types";
import { loadConfig, resolveEnvValue, saveConfig } from "../config";
import { maskEmail } from "../lib/privacy";
import { getAccountCredential, getAccountSet, saveAccountCredential, saveCredential, markAccountNeedsReauth, getCredential, credentialGeneration, createOAuthRefreshIntentLock, mergeAccountCredential, markAccountNeedsReauthIfGeneration } from "./store";
import { loginXai, refreshXaiToken, XAI_LOCAL_CLI_DETACH_WARNING, XaiTokenRequestError } from "./xai";
import { ANTHROPIC_OAUTH_BETA, loginAnthropic, refreshAnthropicToken } from "./anthropic";
import { loginKimi, refreshKimiToken } from "./kimi";
import { loginKiro, readKiroCliSqlite, refreshKiroToken } from "./kiro";
import { loginChatGPT, refreshChatGPTToken } from "./chatgpt";
import { loginAntigravity, refreshAntigravityToken } from "./google-antigravity";
import { loginCursor, refreshCursorToken } from "./cursor";
import { deriveOAuthDefaultModel, deriveOAuthProviderConfig } from "../providers/derive";
import { effectiveGoogleMode } from "../providers/registry";
import { resolveProviderTransport } from "../providers/xai-transport";
import { detectGrokCliToken, hasComparableGrokIdentity, isSameGrokIdentity, shouldAdoptGrokGeneration } from "./local-token-detect";

const REFRESH_SKEW_MS = 60_000;
export interface OAuthAccessSnapshot {
  provider: string;
  accountId: string;
  generation: string;
  accessToken: string;
}

const tokenRefreshes = new Map<string, Promise<OAuthAccessSnapshot>>();
const XAI_PERMANENT_FAILURE_TTL_MS=30_000;
const permanentRefreshFailures=new Map<string,number>();
interface XaiRefreshDeps { intentLock?:ReturnType<typeof createOAuthRefreshIntentLock>; now?:()=>number; afterPrePersistRead?:()=>void|Promise<void> }
function verdictKey(p:string,a:string,c:OAuthCredentials){return `${p}\0${a}\0${credentialGeneration(c)}`;}
function cached(p:string,a:string,c:OAuthCredentials,now:()=>number){const k=verdictKey(p,a,c),u=permanentRefreshFailures.get(k);if(u===undefined)return false;if(u<=now()){permanentRefreshFailures.delete(k);return false;}return true;}

export interface LoginOpts { forceLogin?: boolean }

interface OAuthProviderDef {
  login(ctrl: OAuthController, opts?: LoginOpts): Promise<OAuthCredentials>;
  refresh(refreshToken: string, signal?: AbortSignal): Promise<OAuthCredentials>;
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
  kiro: {
    login: (ctrl) => loginKiro(ctrl),
    refresh: (rt, signal) => refreshKiroToken(rt, signal),
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
    login: (ctrl) => loginCursor(ctrl),
    refresh: refreshCursorToken,
    providerConfig: oauthConfig("cursor"),
    defaultModel: oauthDefaultModel("cursor"),
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

/** Provider ids that support real OAuth login (drives the GUI's "Log in with …" buttons). */
export function listOAuthProviders(): string[] {
  return Object.keys(OAUTH_PROVIDERS);
}

export class UnsupportedOAuthProviderError extends Error {
  constructor(provider: string) {
    super(`Unsupported OAuth provider in config: ${provider}`);
    this.name = "UnsupportedOAuthProviderError";
  }
}

export class OAuthLoginRequiredError extends Error {
  constructor(provider: string) {
    super(`Not logged in to ${provider}. Run: ocx login ${provider}`);
    this.name = "OAuthLoginRequiredError";
  }
}

function accessSnapshot(provider: string, accountId: string, cred: OAuthCredentials): OAuthAccessSnapshot {
  return {
    provider,
    accountId,
    generation: credentialGeneration(cred),
    accessToken: cred.access,
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
  const existing = tokenRefreshes.get(key);
  if (existing) return existing;

  const refresh = (async (): Promise<OAuthAccessSnapshot> => {
    const accessToken = await refreshAndPersistAccessToken(provider, accountId, def, cred);
    const persisted = getAccountCredential(provider, accountId);
    if (!persisted) throw new OAuthLoginRequiredError(provider);
    if (persisted.access !== accessToken) {
      throw new Error(`OAuth refresh persisted an unexpected access token for ${provider}`);
    }
    return accessSnapshot(provider, accountId, persisted);
  })().finally(() => {
    if (tokenRefreshes.get(key) === refresh) tokenRefreshes.delete(key);
  });
  tokenRefreshes.set(key, refresh);
  return refresh;
}

export async function getValidAccessTokenSnapshot(provider: string): Promise<OAuthAccessSnapshot> {
  const set = getAccountSet(provider);
  if (!set) throw new OAuthLoginRequiredError(provider);
  return resolveAccessSnapshotForAccount(provider, set.activeAccountId);
}

export async function forceRefreshOAuthAccessSnapshot(
  rejected: OAuthAccessSnapshot,
): Promise<OAuthAccessSnapshot> {
  if (rejected.provider !== "xai") throw new UnsupportedOAuthProviderError(rejected.provider);
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

function readFreshKiroCliCredential(): OAuthCredentials | undefined {
  const imported = readKiroCliSqlite();
  if (!imported || imported.expires <= Date.now() + REFRESH_SKEW_MS) return undefined;
  return { access: imported.access, refresh: imported.refresh, expires: imported.expires, source: "local-cli" };
}

/** Terminal refresh failures (revoked/rotated-away grants) — retrying cannot succeed. */
function isTerminalRefreshError(err: unknown): boolean {
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  return msg.includes("invalid_grant") || msg.includes("refresh_token_reused") || msg.includes("revoked");
}
function terminal(error:unknown):boolean{return error instanceof XaiTokenRequestError?["invalid_grant","refresh_token_reused","revoked_token"].includes(error.oauthError??""):isTerminalRefreshError(error);}
function authoritative(stored:OAuthCredentials,active:boolean,now:()=>number):OAuthCredentials{if(stored.source!=="local-cli")return stored;const disk=detectGrokCliToken();if(!disk)return stored;const allowed=isSameGrokIdentity(stored,disk)||(active&&!hasComparableGrokIdentity(stored,disk));return allowed&&shouldAdoptGrokGeneration(stored,disk,now(),REFRESH_SKEW_MS)?disk:stored;}
function merged(fresh:OAuthCredentials,previous:OAuthCredentials):OAuthCredentials{return{...fresh,source:previous.source==="local-cli"?"oauth":fresh.source??previous.source??"oauth",...(fresh.projectId===undefined&&previous.projectId?{projectId:previous.projectId}:{}),...(fresh.email===undefined&&previous.email?{email:previous.email}:{}),...(fresh.accountId===undefined&&previous.accountId?{accountId:previous.accountId}:{})};}
export async function refreshXaiAccountWithLock(provider:string,accountId:string,def:OAuthProviderDef,callerCredential:OAuthCredentials,deps:XaiRefreshDeps={}):Promise<string>{const now=deps.now??Date.now;const guard=await(deps.intentLock??createOAuthRefreshIntentLock(provider,accountId)).acquire();try{const stored=getAccountCredential(provider,accountId);if(!stored)throw new OAuthLoginRequiredError(provider);const active=getAccountSet(provider)?.activeAccountId===accountId,candidate=authoritative(stored,active,now);if(credentialGeneration(candidate)!==credentialGeneration(callerCredential)&&candidate.expires>now()+REFRESH_SKEW_MS){if(credentialGeneration(candidate)!==credentialGeneration(stored)){const o=await mergeAccountCredential(provider,accountId,candidate,{expectedGeneration:credentialGeneration(stored),afterPrePersistRead:deps.afterPrePersistRead});if(o.superseded){if(o.stored.expires>now()+REFRESH_SKEW_MS)return o.stored.access;throw new OAuthLoginRequiredError(provider);}}return candidate.access;}if(cached(provider,accountId,candidate,now))throw new OAuthLoginRequiredError(provider);const generation=credentialGeneration(candidate);try{const fresh=merged(await def.refresh(candidate.refresh),candidate);const o=await mergeAccountCredential(provider,accountId,fresh,{expectedGeneration:generation,afterPrePersistRead:deps.afterPrePersistRead});if(o.superseded){if(o.stored.expires>now()+REFRESH_SKEW_MS)return o.stored.access;throw new OAuthLoginRequiredError(provider);}permanentRefreshFailures.delete(verdictKey(provider,accountId,candidate));if(candidate.source==="local-cli")console.warn(XAI_LOCAL_CLI_DETACH_WARNING);return fresh.access;}catch(error){if(!terminal(error))throw error;permanentRefreshFailures.set(verdictKey(provider,accountId,candidate),now()+XAI_PERMANENT_FAILURE_TTL_MS);await markAccountNeedsReauthIfGeneration(provider,accountId,generation);throw new OAuthLoginRequiredError(provider);}}finally{guard.release();}}

async function refreshAndPersistAccessToken(
  provider: string,
  accountId: string,
  def: OAuthProviderDef,
  cred: OAuthCredentials,
): Promise<string> {
  // Local-CLI import fallback only for the ACTIVE account: importing another identity's
  // token under a background account id would silently contaminate that account.
  const isActive = getAccountSet(provider)?.activeAccountId === accountId;
  if (provider === "kiro" && isActive) {
    const imported = readFreshKiroCliCredential();
    if (imported) {
      await saveCredential(provider, imported);
      return imported.access;
    }
  }
  if (provider === "xai") return refreshXaiAccountWithLock(provider, accountId, def, cred);
  try {
    const fresh = await def.refresh(cred.refresh);
    const detachedLocalCli = provider === "xai" && cred.source === "local-cli";
    if (detachedLocalCli) console.warn(XAI_LOCAL_CLI_DETACH_WARNING);
    // Persist to THIS account (rotation-safe: new refresh token hits disk before use) without
    // touching activeAccountId.
    await saveAccountCredential(provider, accountId, {
      ...fresh,
      source: detachedLocalCli ? "oauth" : fresh.source ?? cred.source ?? "oauth",
      // Preserve a previously-discovered project id when a refresh-time re-discovery comes back empty
      // (e.g. a transient network blip), so Antigravity does not lose its CCA project across refresh.
      ...(fresh.projectId === undefined && cred.projectId ? { projectId: cred.projectId } : {}),
      // Preserve identity fields the refresh response may omit, so identity matching stays stable.
      ...(fresh.email === undefined && cred.email ? { email: cred.email } : {}),
      ...(fresh.accountId === undefined && cred.accountId ? { accountId: cred.accountId } : {}),
    });
    return fresh.access;
  } catch (err) {
    if (provider === "kiro" && isActive) {
      const imported = readFreshKiroCliCredential();
      if (imported) {
        await saveCredential(provider, imported);
        return imported.access;
      }
    }
    if (isTerminalRefreshError(err)) {
      await markAccountNeedsReauth(provider, accountId, true);
      throw new OAuthLoginRequiredError(provider);
    }
    throw err;
  }
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

/**
 * Provider-correct `GET /models` request (URL + headers), so both model-listing paths fetch the
 * LIVE catalog correctly per adapter. Anthropic is the special case: its endpoint is `/v1/models`
 * (not `/models`), it needs `anthropic-version`, and it authenticates with `x-api-key` (key) or
 * `Authorization: Bearer` + the OAuth beta (oauth) — not a bare Bearer. Google (ai-studio mode)
 * is the other special case: `x-goog-api-key` + `/v1beta/models`, returning `{ models: [...] }`.
 * The catalog authority gate intentionally degrades that non-OpenAI shape to stale/static data.
 * Everyone else uses the OpenAI-style `/models` + Bearer with a `{ data: [{ id, owned_by? }] }`
 * response.
 */
export function buildModelsRequest(prov: OcxProviderConfig, apiKey: string | undefined, providerName = ""): { url: string; headers: Record<string, string> } {
  const effectiveProvider = resolveProviderTransport(providerName, prov);
  const headers: Record<string, string> = { ...(effectiveProvider.headers ?? {}) };
  if (effectiveGoogleMode(providerName, effectiveProvider) === "ai-studio") {
    // Generative Language API: API key goes in x-goog-api-key (never Authorization: Bearer),
    // models live under /v1beta (v1 misses preview models), and pageSize maxes at 1000 —
    // enough to list everything without a pageToken loop. Vertex/antigravity keep the
    // generic branch (they fall back to their static model lists).
    if (apiKey) headers["x-goog-api-key"] = apiKey;
    return { url: `${effectiveProvider.baseUrl}/v1beta/models?pageSize=1000`, headers };
  }
  if (effectiveProvider.adapter === "anthropic") {
    headers["anthropic-version"] = "2023-06-01";
    if (effectiveProvider.authMode === "oauth") {
      headers["anthropic-beta"] = ANTHROPIC_OAUTH_BETA;
      if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;
    } else if (apiKey) {
      headers["x-api-key"] = apiKey;
    }
    return { url: `${effectiveProvider.baseUrl}/v1/models?limit=1000`, headers };
  }
  if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;
  return { url: `${effectiveProvider.baseUrl}/models`, headers };
}

/**
 * Refresh OAuth-managed provider presets (`models`, `noReasoningModels`, and a stale `defaultModel`)
 * from the registry so a proxy update that revises a provider's models — e.g. dropping deprecated
 * Claude snapshots or adding a new grok endpoint not in the live `/models` — reaches EXISTING
 * configs on the next `ocx start`, instead of only fresh installs. The live `/models` fetch stays
 * the primary source; this keeps the static fallback (and models-not-in-/models) current.
 *
 * Only touches providers that are registry-managed AND still `authMode: "oauth"`, and only the
 * preset fields (never apiKey/baseUrl/user toggles). Persists + returns true when anything changed.
 */
function cloneProviderField(value: unknown): unknown {
  if (Array.isArray(value)) return [...value];
  if (value && typeof value === "object") return structuredClone(value);
  return value;
}

const OAUTH_RECONCILE_FIELDS: (keyof OcxProviderConfig)[] = [
  "models",
  "contextWindow",
  "modelContextWindows",
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

export function reconcileOAuthProviders(config: OcxConfig): boolean {
  let changed = false;
  for (const [name, prov] of Object.entries(config.providers)) {
    const def = OAUTH_PROVIDERS[name];
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
    // Heal a defaultModel that no longer exists in the refreshed list (e.g. a deprecated snapshot).
    if (prov.defaultModel && preset.defaultModel && !new Set(prov.models ?? []).has(prov.defaultModel)) {
      prov.defaultModel = preset.defaultModel;
      changed = true;
    }
  }
  if (changed) saveConfig(config);
  return changed;
}

/** Add/refresh an OAuth provider's config entry on a config object (does not persist). */
export function upsertOAuthProvider(config: OcxConfig, provider: string): void {
  const def = OAUTH_PROVIDERS[provider];
  if (!def) return;
  config.providers[provider] = { ...def.providerConfig };
}

/** Run the login flow, persist the credential + upsert the provider entry to disk, return cred. */
export async function runLogin(provider: string, ctrl: OAuthController, opts?: LoginOpts): Promise<OAuthCredentials> {
  const def = OAUTH_PROVIDERS[provider];
  if (!def) throw new UnsupportedOAuthProviderError(provider);
  const rawCred = await def.login(ctrl, opts);
  const cred: OAuthCredentials = rawCred.source ? rawCred : { ...rawCred, source: "oauth" };
  await saveCredential(provider, cred);
  const config = loadConfig();
  upsertOAuthProvider(config, provider);
  saveConfig(config);
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

/** Pending paste for a login in progress: either a waiter or a stashed early submission. */
interface ManualCodeSlot {
  pendingInput?: string;
  resolve?: (value: string) => void;
  /** Registered by the callback flow so submits can validate state synchronously. */
  expectedState?: string;
}
const loginManual = new Map<string, ManualCodeSlot>();

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
  const st = loginState.get(provider);
  if (!st || st.done) return { ok: false, error: "no login in progress" };
  const slot = ensureManualCodeSlot(provider);
  // Synchronous validation (validated request/ack): reject un-parseable input and
  // authorization responses (url/query kind) whose state is missing or mismatched
  // once the flow has registered its expected state. Raw codes stay in-session-PKCE
  // protected. Early posts (flow not yet waiting, no expectedState) are stashed and
  // re-validated by the callback loop.
  const parsed = parseCallbackInput(trimmed);
  if (!parsed.code) return { ok: false, error: "no authorization code found in input" };
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

export interface OAuthAccountSummary { id: string; email?: string; active: boolean; needsReauth?: boolean; expiresAt?: number }

export function getLoginStatus(provider: string): { loggedIn: boolean; email?: string; source?: OAuthCredentials["source"]; error?: string; done: boolean; activeAccountId?: string; accounts?: OAuthAccountSummary[] } {
  const cred = getCredential(provider);
  const st = loginState.get(provider);
  const set = getAccountSet(provider);
  const accounts: OAuthAccountSummary[] | undefined = set?.accounts.map(a => ({
    id: a.id,
    email: maskEmail(a.credential.email) ?? undefined,
    active: a.id === set.activeAccountId,
    ...(a.needsReauth ? { needsReauth: true } : {}),
    expiresAt: a.credential.expires,
  }));
  return {
    loggedIn: !!cred,
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

export async function startLoginFlow(provider: string, opts?: LoginOpts): Promise<{ url: string; instructions?: string }> {
  const def = OAUTH_PROVIDERS[provider];
  if (!def) throw new UnsupportedOAuthProviderError(provider);
  const existing = loginState.get(provider);
  if (existing && !existing.done) {
    throw new Error(`A login for ${provider} is already in progress`);
  }
  clearManualCodeSlot(provider);
  loginState.set(provider, { done: false });
  const abort = new AbortController();
  loginAbort.set(provider, abort);
  return new Promise((resolve, reject) => {
    let urlResolved = false;
    const ctrl: OAuthController = {
      onAuth: ({ url, instructions }) => {
        urlResolved = true;
        resolve({ url, instructions });
      },
      onProgress: () => {},
      // GUI fallback when the browser cannot hit the loopback callback server.
      onManualCodeInput: (expectedState?: string) => waitForManualLoginCode(provider, abort.signal, expectedState),
      signal: abort.signal,
    };
    // Background: runLogin persists the credential + upserts the provider entry to disk config.
    runLogin(provider, ctrl, opts)
      .then(() => {
        loginAbort.delete(provider);
        clearManualCodeSlot(provider);
        loginState.set(provider, { done: true });
        // Local-token import (grok-cli / Claude Code keychain) completes WITHOUT firing onAuth —
        // resolve so the GUI call returns instead of hanging.
        if (!urlResolved) resolve({ url: "", instructions: "Logged in via an existing local CLI/keychain token — no browser needed." });
      })
      .catch((e: unknown) => {
        loginAbort.delete(provider);
        clearManualCodeSlot(provider);
        const msg = e instanceof Error ? e.message : String(e);
        loginState.set(provider, { done: true, error: msg });
        if (!urlResolved) reject(e);
      });
  });
}
