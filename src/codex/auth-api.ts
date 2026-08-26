import {
  ConfigMutationLockError,
  loadConfig,
  mutatePersistedConfig,
  saveConfigPreservingClaudeCode,
  withConfigMutationLockSync,
} from "../config";
import { codexAccountLogLabel, withCodexAccountLogLabel } from "./account-label";
import {
  getCodexAccountCredential,
  getValidCodexToken,
  isCodexAccountGenerationLive,
  markCodexAccountValidated,
  readCodexAccountRecord,
  saveCodexAccountCredential,
  CodexCredentialGenerationConflictError,
  CodexCredentialRefreshLockTimeoutError,
  CodexCredentialRefreshBusyError,
  CodexCredentialRefreshStaleError,
  TokenRefreshError,
} from "./account-store";
import { deleteCodexAccount, reconcileMainCodexAccountRuntimeState } from "./account-lifecycle";
import {
  appendDefaultCodexAccountNamespace,
  codexAccountPickerEnabled,
} from "./account-namespaces";
import {
  catalogRefreshIsPending,
  normalizeCatalogDisposition,
} from "./catalog-refresh-status";
import { isCodexAccountPaused, setCodexAccountPaused } from "./account-pause";
import {
  clearCodexAccountPin,
  getCodexAccountPriority,
  isCodexAccountPriorityKey,
  pinnedCodexAccountId,
  setCodexAccountPin,
  setCodexAccountPriority,
} from "./account-priority";
import {
  claimDueCodexQuotaRecoveryProbes,
  clearCodexAccountCooldown,
  clearThreadAccountMapForAccount,
  getEffectiveActiveCodexAccountId,
  isEffectiveCodexAccountPinned,
  reconcileCodexActiveAfterExclusion,
  resetCodexRoutingForManualSelection,
  settleCodexQuotaRecoveryProbe,
} from "./routing";
import {
  DEFAULT_ACCOUNT_PRIORITY,
  MAX_ACCOUNT_PRIORITY,
  MIN_ACCOUNT_PRIORITY,
  normalizeAccountPoolStickyLimit,
  normalizeAccountPoolStrategy,
  parseAccountPoolStickyLimit,
  parseAccountPoolStrategy,
  parseAccountPriority,
} from "./pool-rotation";
import { checkAccountIdCollision, getMainChatgptAccountId, readCodexTokens, readCodexTokensResult } from "./auth-collision";
import { codexPlanValue, isThirtyDayOnlyCodexPlan } from "./plan";
export { checkAccountIdCollision, getMainChatgptAccountId } from "./auth-collision";
export { clearAccountNeedsReauth, isAccountNeedsReauth, markAccountNeedsReauth } from "./account-runtime-state";
import { clearAccountNeedsReauth, isAccountNeedsReauth, markAccountNeedsReauth } from "./account-runtime-state";
import {
  clearAccountQuota,
  getAccountQuota,
  isCompleteCodexQuotaRecoverySnapshot,
  isCodexQuotaExhausted,
  listAccountQuotas,
  parseUsageQuota,
  setAccountQuotaFromParsed,
  updateAccountQuota,
  type StoredAccountQuota,
  type WhamUsageResponse,
} from "./quota";
export {
  applyAccountQuotaFromUpstreamHeaders,
  clearAccountQuota,
  getAccountQuota,
  parseUsageQuota,
  setAccountQuotaFromParsed,
  updateAccountQuota,
} from "./quota";
import { extractAccountId } from "../oauth/chatgpt";
import { getMainAccountPlan, isMainAccountTokenVerifiablyLive, MAIN_CODEX_ACCOUNT_ID, setMainAccountPlan } from "./main-account";
import { captureConfigGeneration, registerStateSweepAfterTick } from "../lib/state-store-sweeper";
import { reconcileLiveStateStores } from "../lib/state-store-registrations";
import {
  captureMainAccountIdentityGeneration,
  clearMainAccountInfoCache,
  getMainAccountCredentialPresence,
  getMainAccountInfoCache,
  isMainAccountIdentityGenerationLive,
  setMainAccountCredentialPresence,
  setMainAccountInfoCache,
  type MainAccountInfo,
} from "./main-account-cache";
export { clearMainAccountInfoCache } from "./main-account-cache";
import { maskEmail } from "../lib/privacy";
import { codexWarmupFailureReason, warmCodexAccount } from "./warmup";
export { maskEmail } from "../lib/privacy";
import type { CodexAccount, CodexAccountCredentials, OcxConfig } from "../types";
import type { CatalogDisposition } from "./convergence-types";
import { isCanonicalOpenAiForwardProvider, OPENAI_CODEX_PROVIDER_ID } from "../providers/openai-tiers";
import { providerCodexAccountMode } from "../providers/registry";
import { BOUNDED_BODY_MAX_BYTES, readBoundedResponseBody } from "../lib/bounded-body";
import { cancelBodyOnAbort, signalWithTimeout } from "../lib/abort";
import {
  oauthAccountHealthFields,
  projectCodexAccountHealth,
  type OAuthAccountHealth,
  type OAuthHealthLabel,
} from "../oauth/health";
import {
  CODEX_ACCOUNT_ID_RE,
  hasLegacyMainCodexPoolAccount,
  isSelectableCodexPoolAccount,
  isValidCodexAccountId,
} from "./account-id";
import { codexAccountIdNamespaceCollisionError } from "./account-namespace-match";
import { ResourceAdmissionError, type AdmissionLease } from "../lib/admission";
import { tryAcquireNativeMainProfileClaim } from "./native-main-admission";
import { withNativeMainSharedClaim } from "./native-main-claim";
import { resolveNativeProfileContext } from "./native-profile-store";
import { NativeProfileError } from "./native-profile-types";

function isNativeMainClaimUnavailable(error: unknown): error is NativeProfileError {
  return error instanceof NativeProfileError
    && (error.code === "NATIVE_MAIN_CLAIM_BUSY" || error.code === "NATIVE_MAIN_CLAIM_UNAVAILABLE");
}

function withNativeMainCredentialClaim<T>(operation: () => Promise<T>): Promise<T> {
  return withNativeMainSharedClaim(resolveNativeProfileContext(), operation);
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function nativeMainProfileBusyResponse(): Response {
  const response = jsonResponse({ error: "server_busy", code: "server_busy" }, 503);
  response.headers.set("Retry-After", "1");
  return response;
}

const CODEX_CREDENTIAL_PERSISTENCE_ERROR = "Account was saved, but credential setup did not complete. Reauthenticate or remove the account.";
const CODEX_CREDENTIAL_PERSISTENCE_CODE = "codex_credential_persistence_failed";

const MAX_CODEX_LOGIN_STATE_ROWS = 32;
const CODEX_LOGIN_TERMINAL_TTL_MS = 300_000;
interface CodexLoginStateRow {
  status: string;
  startedAt: number;
  accountId?: string;
  email?: string;
  error?: string;
  code?: string;
  needsReauth?: boolean;
  catalogRefreshPending?: boolean;
  doneAt?: number;
}
const codexAuthLoginState = new Map<string, CodexLoginStateRow>();
export class CodexLoginStateBusyError extends ResourceAdmissionError {
  constructor() { super("codex_login_state_rows", MAX_CODEX_LOGIN_STATE_ROWS); this.name = "CodexLoginStateBusyError"; }
}

function setCodexLoginState(flowId: string, patch: Partial<CodexLoginStateRow>): void {
  const row = codexAuthLoginState.get(flowId);
  if (row) Object.assign(row, patch);
}

function pruneCodexLoginState(now = Date.now()): void {
  for (const [id, row] of codexAuthLoginState) {
    if (row.doneAt !== undefined && now - row.doneAt >= CODEX_LOGIN_TERMINAL_TTL_MS) codexAuthLoginState.delete(id);
  }
  while (codexAuthLoginState.size >= MAX_CODEX_LOGIN_STATE_ROWS) {
    const terminal = [...codexAuthLoginState].filter(([, row]) => row.doneAt !== undefined)
      .sort((a, b) => (a[1].doneAt ?? 0) - (b[1].doneAt ?? 0))[0];
    if (!terminal) break;
    codexAuthLoginState.delete(terminal[0]);
  }
}

function configuredPoolAccount(config: OcxConfig, accountId: string): CodexAccount | null {
  if (!isValidCodexAccountId(accountId)) return null;
  return (config.codexAccounts ?? [])
    .find(account => account.id === accountId && isSelectableCodexPoolAccount(account)) ?? null;
}

function codexAccountPersistenceConflict(
  config: OcxConfig,
  accountId: string,
  mode: "create" | "reauth",
): string | undefined {
  if (mode === "reauth") {
    return configuredPoolAccount(config, accountId)
      ? undefined
      : "Pool account was removed while login was in progress. Add it again as a new account.";
  }
  const namespaceCollision = codexAccountIdNamespaceCollisionError(config.codexAccountNamespaces, accountId);
  if (namespaceCollision) return namespaceCollision;
  return (config.codexAccounts ?? []).some(account => account.id === accountId)
    || Boolean(getCodexAccountCredential(accountId))
    ? `Account id already exists: ${accountId}`
    : undefined;
}

/**
 * The exact label `parseUsageQuota` emits for the Codex Spark window (quota.ts).
 * Matching on the label rather than on "is a custom window" is load-bearing: the same array
 * carries Cursor's First-party models / API usage, Anthropic's Fable / Opus / Sonnet,
 * Antigravity's Gem / Cla, Kimi's subscription credits and a dozen dynamic provider meters.
 */
const CODEX_SPARK_WINDOW_LABEL = "GPT-5.3-Codex-Spark Weekly";

/**
 * Drop the Spark window unless the operator asked for it (default hidden).
 *
 * Applied at the DTO boundary, never at parse or cache time: custom windows participate in
 * quota-presence checks, snapshot reconciliation and capacity aggregation, so removing Spark
 * upstream of this point would change routing state rather than display.
 *
 * Both GUI surfaces funnel through here — the Codex Auth rows directly, and /api/provider-quotas
 * via listCodexAuthAccountsSnapshot — so one filter covers both. Filtering only one would leave
 * the other still rendering the row the operator switched off.
 */
export function withSparkVisibility<T extends Omit<StoredAccountQuota, "updatedAt"> | StoredAccountQuota | null>(
  quota: T,
): T {
  if (!quota?.customWindows?.length) return quota;
  if (loadConfig().showCodexSparkQuota === true) return quota;
  const kept = quota.customWindows.filter(window => window.label !== CODEX_SPARK_WINDOW_LABEL);
  if (kept.length === quota.customWindows.length) return quota;
  // An empty list is dropped rather than serialized: an absent field and an empty array should
  // not be two different ways of saying "no custom windows" on the wire.
  const next = { ...quota } as Record<string, unknown>;
  if (kept.length > 0) next.customWindows = kept;
  else delete next.customWindows;
  return next as T;
}


function quotaForPlan<T extends Omit<StoredAccountQuota, "updatedAt"> | StoredAccountQuota | null>(
  quota: T,
  plan: unknown,
): T {
  const visible = withSparkVisibility(quota);
  if (!visible || !isThirtyDayOnlyCodexPlan(plan)) return visible;
  const quotaWindows = visible;
  return {
    ...(quotaWindows.monthlyPercent !== undefined ? { monthlyPercent: quotaWindows.monthlyPercent } : {}),
    ...(quotaWindows.monthlyResetAt !== undefined ? { monthlyResetAt: quotaWindows.monthlyResetAt } : {}),
    // A 30-day plan can still carry a burst window, and it blocks the account on its own.
    // Dropping it here would show a healthy card for an account upstream is refusing (#1791).
    ...(quotaWindows.shortPercent !== undefined ? { shortPercent: quotaWindows.shortPercent } : {}),
    ...(quotaWindows.shortResetAt !== undefined ? { shortResetAt: quotaWindows.shortResetAt } : {}),
    ...(quotaWindows.shortWindowSeconds !== undefined ? { shortWindowSeconds: quotaWindows.shortWindowSeconds } : {}),
    ...(quotaWindows.customWindows !== undefined ? { customWindows: quotaWindows.customWindows } : {}),
    ...(quotaWindows.resetCredits !== undefined ? { resetCredits: quotaWindows.resetCredits } : {}),
    ...("updatedAt" in quotaWindows ? { updatedAt: quotaWindows.updatedAt } : {}),
  } as T;
}

function poolAccountDto(
  account: CodexAccount,
  quotaResult: PoolQuotaResult,
  hasCredential: boolean,
  paused: boolean,
  priority: number,
): CodexAuthAccountDto {
  const plan = codexPlanValue(account.plan);
  const quota = quotaForPlan(quotaResult.quota, plan);
  const needsReauth = !hasCredential || quotaResult.needsReauth || isAccountNeedsReauth(account.id);
  const health = projectCodexAccountHealth({ accountId: account.id, needsReauth });
  return {
    id: account.id,
    email: maskEmail(account.email) ?? account.email,
    ...(account.alias !== undefined ? { alias: account.alias } : {}),
    ...(plan !== undefined ? { plan } : {}),
    logLabel: codexAccountLogLabel(account),
    isMain: false,
    paused,
    priority,
    quota: quota ? { ...quota } : null,
    needsReauth,
    hasCredential,
    ...(quotaResult.quotaProbeSkipped ? { quotaProbeSkipped: true as const } : {}),
    ...oauthAccountHealthFields("codex", account.id, health),
  };
}

interface ResetCreditAuth {
  isMain: boolean;
  accessToken: string;
  chatgptAccountId: string;
  nativeMainLease?: AdmissionLease;
  nativeMainSharedClaimHeld?: true;
}

async function withResetCreditAuth<T>(
  runtimeConfig: OcxConfig,
  accountId: string,
  operation: (auth: ResetCreditAuth) => Promise<T>,
): Promise<{ ok: true; value: T } | { ok: false; response: Response }> {
  if (accountId === MAIN_CODEX_ACCOUNT_ID) {
    if (hasLegacyMainCodexPoolAccount(runtimeConfig.codexAccounts)) {
      return { ok: false, response: jsonResponse({ error: "Remove the legacy __main__ pool row before using the Desktop account" }, 409) };
    }
    const nativeMainLease = tryAcquireNativeMainProfileClaim();
    if (!nativeMainLease) return { ok: false, response: nativeMainProfileBusyResponse() };
    try {
      try {
        return await withNativeMainCredentialClaim(async () => {
          const tokens = readCodexTokens();
          if (!tokens) {
            return { ok: false, response: jsonResponse({ error: "Main Codex account not logged in" }, 401) };
          }
          return {
            ok: true,
            value: await operation({
              isMain: true,
              accessToken: tokens.access_token,
              chatgptAccountId: tokens.account_id,
              nativeMainLease,
              nativeMainSharedClaimHeld: true,
            }),
          };
        });
      } catch (error) {
        if (isNativeMainClaimUnavailable(error)) {
          return { ok: false, response: nativeMainProfileBusyResponse() };
        }
        throw error;
      }
    } finally {
      nativeMainLease.release();
    }
  }
  if (!isValidCodexAccountId(accountId)) {
    return { ok: false, response: jsonResponse({ error: "Invalid account id format" }, 400) };
  }
  if (!configuredPoolAccount(runtimeConfig, accountId)) {
    return { ok: false, response: jsonResponse({ error: "Unknown Codex account" }, 404) };
  }
  const cred = await getValidCodexToken(accountId);
  return {
    ok: true,
    value: await operation({
      isMain: false,
      accessToken: cred.accessToken,
      chatgptAccountId: cred.chatgptAccountId,
    }),
  };
}

function safeResetCreditsDto(input: unknown): { credits: { granted_at: string; expires_at: string }[]; available_count?: number } {
  const obj = typeof input === "object" && input !== null ? input as Record<string, unknown> : {};
  const rawCredits = Array.isArray(obj.credits) ? obj.credits : [];
  const credits = rawCredits.flatMap((raw): { granted_at: string; expires_at: string }[] => {
    if (typeof raw !== "object" || raw === null) return [];
    const credit = raw as Record<string, unknown>;
    return typeof credit.granted_at === "string" && typeof credit.expires_at === "string"
      ? [{ granted_at: credit.granted_at, expires_at: credit.expires_at }]
      : [];
  });
  const rawAvailable = (obj.rate_limit_reset_credits as { available_count?: unknown } | null | undefined)?.available_count
    ?? obj.available_count;
  return {
    credits,
    ...(typeof rawAvailable === "number" && Number.isFinite(rawAvailable) ? { available_count: rawAvailable } : {}),
  };
}

function safeResetCreditConsumeDto(input: unknown): { code: string } {
  const obj = typeof input === "object" && input !== null ? input as Record<string, unknown> : {};
  return { code: typeof obj.code === "string" ? obj.code : "unknown" };
}

type ResetCreditJsonRead =
  | { ok: true; value: unknown }
  | { ok: false };

function cancelResponseBodyWithoutWaiting(body: ReadableStream<Uint8Array> | null): void {
  if (!body) return;
  try {
    void body.cancel().catch(() => undefined);
  } catch {
    // Some stream implementations throw synchronously from cancel().
  }
}

async function readResetCreditJson(
  response: Response,
  signal: AbortSignal,
): Promise<ResetCreditJsonRead> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isSafeInteger(declaredLength)
    && declaredLength >= 0
    && declaredLength > BOUNDED_BODY_MAX_BYTES) {
    cancelResponseBodyWithoutWaiting(response.body);
    return { ok: false };
  }
  try {
    const body = await readBoundedResponseBody(response, {
      signal,
      maxBytes: BOUNDED_BODY_MAX_BYTES,
      fatalUtf8: true,
    });
    if (!body.displaySafe || body.truncated || !body.text.trim()) return { ok: false };
    return { ok: true, value: JSON.parse(body.text) as unknown };
  } catch {
    return { ok: false };
  }
}

function manualImportDisabledResponse(): Response {
  return jsonResponse({
    error: "Manual Codex account import is disabled. Use OAuth login to add a pool account.",
    code: "manual_import_disabled",
  }, 403);
}

async function verifyCodexAccountWarmup(
  accountId: string,
  accessToken: string,
  chatgptAccountId: string,
): Promise<{ ok: true; validatedAt: number } | { ok: false; response: Response }> {
  try {
    await warmCodexAccount({ accessToken, chatgptAccountId });
    return { ok: true, validatedAt: Date.now() };
  } catch (err) {
    const reason = codexWarmupFailureReason(err);
    return {
      ok: false,
      response: jsonResponse({
        error: "Codex account warmup failed. Reauthenticate the account and try again.",
        code: "codex_warmup_failed",
        reason,
        accountId,
      }, 401),
    };
  }
}

function expireCodexAuthFlow(flowId: string | null, error = "Login cancelled"): void {
  const ids = flowId
    ? [flowId]
    : [...codexAuthLoginState].filter(([, state]) => state.status === "pending").map(([id]) => id);
  for (const id of ids) {
    let owner = codexAuthLoginState.get(id);
    if (!owner) {
      pruneCodexLoginState();
      if (codexAuthLoginState.size >= MAX_CODEX_LOGIN_STATE_ROWS) continue;
      owner = { status: "error", startedAt: Date.now() };
      codexAuthLoginState.set(id, owner);
    }
    Object.assign(owner, { status: "error", error, doneAt: Date.now() });
    setTimeout(() => { if (codexAuthLoginState.get(id) === owner) codexAuthLoginState.delete(id); }, 30_000);
  }
}

const MAIN_CACHE_TTL = 5 * 60_000;
const POOL_CACHE_TTL = 5 * 60_000;
const POOL_QUOTA_REFRESH_CONCURRENCY = 4;

function nonEmptyPlan(value: unknown): string | null {
  return codexPlanValue(value) ?? null;
}

function isRuntimeConfig(config: OcxConfig): boolean {
  return !!config && typeof config === "object" && !!config.providers;
}

function getRuntimeConfig(config: OcxConfig): OcxConfig {
  return isRuntimeConfig(config) ? config : loadConfig();
}

function saveRuntimeConfig(sourceConfig: OcxConfig, nextConfig: OcxConfig): void {
  saveConfigPreservingClaudeCode(nextConfig);
  if (sourceConfig === nextConfig || !isRuntimeConfig(sourceConfig)) return;
  for (const key of Object.keys(sourceConfig) as Array<keyof OcxConfig>) {
    delete sourceConfig[key];
  }
  Object.assign(sourceConfig, nextConfig);
}

interface StagedNewCodexAccountState {
  credential: CodexAccountCredentials;
  validatedAt: number;
}

type PersistNewCodexAccountOutcome =
  | { status: "committed"; pickerVisibilityChanged: boolean }
  | { status: "publication-failed"; pickerVisibilityChanged: boolean };

function codexCredentialPersistenceFailure(accountId: string, catalogRefreshPending: boolean) {
  return {
    error: CODEX_CREDENTIAL_PERSISTENCE_ERROR,
    code: CODEX_CREDENTIAL_PERSISTENCE_CODE,
    accountId,
    needsReauth: true as const,
    ...(catalogRefreshPending ? { catalogRefreshPending: true as const } : {}),
  };
}

/** Persist config before publishing secret or runtime state under the shared mutation coordinator. */
function persistNewCodexAccount(
  sourceConfig: OcxConfig,
  runtimeConfig: OcxConfig,
  addedAccount: CodexAccount,
  staged: StagedNewCodexAccountState,
): PersistNewCodexAccountOutcome {
  return withConfigMutationLockSync(() => {
    const previousConfig = { ...runtimeConfig };
    let pickerVisibilityChanged: boolean;
    try {
      const accounts = [...(runtimeConfig.codexAccounts ?? [])];
      const retainedPickerBindingRestored = codexAccountPickerEnabled(runtimeConfig)
        && Object.values(runtimeConfig.codexAccountNamespaces ?? {}).includes(addedAccount.id);
      accounts.push(addedAccount);
      runtimeConfig.codexAccounts = accounts;

      // Presence of the explicit flag distinguishes a dashboard-managed map from
      // a hand-authored legacy map. Preserve manual maps exactly.
      const tracksPickerNamespaces = runtimeConfig.codexAccountPickerEnabled !== undefined;
      if (tracksPickerNamespaces && runtimeConfig.codexAccountNamespaces) {
        runtimeConfig.codexAccountNamespaces = { ...runtimeConfig.codexAccountNamespaces };
      }
      const namespaceAdded = tracksPickerNamespaces
        && appendDefaultCodexAccountNamespace(runtimeConfig, addedAccount);
      pickerVisibilityChanged = namespaceAdded || retainedPickerBindingRestored;
      saveRuntimeConfig(sourceConfig, runtimeConfig);
    } catch (error) {
      for (const key of Object.keys(runtimeConfig) as Array<keyof OcxConfig>) {
        delete runtimeConfig[key];
      }
      Object.assign(runtimeConfig, previousConfig);
      throw error;
    }

    try {
      saveCodexAccountCredential(addedAccount.id, staged.credential);
      markCodexAccountValidated(addedAccount.id, staged.validatedAt);
      clearAccountNeedsReauth(addedAccount.id);
    } catch {
      // Config is already durable. Return the failure outcome through the coordinator so its
      // generation commit is not rolled back while config.json remains changed.
      return { status: "publication-failed" as const, pickerVisibilityChanged };
    }
    return { status: "committed" as const, pickerVisibilityChanged };
  });
}

/** Bounded catalog-convergence callback supplied by the management dispatcher. */
export type CodexAuthCatalogConvergence = () => Promise<CatalogDisposition>;

interface AccountNamespaceCatalogRefresh {
  catalogRefreshPending: boolean;
}

/** Collapse post-persistence convergence into the one public recovery bit. */
async function convergeAccountNamespaceCatalog(
  config: OcxConfig,
  changed: boolean,
  convergeCodexCatalog?: CodexAuthCatalogConvergence,
): Promise<AccountNamespaceCatalogRefresh> {
  if (!changed || !codexAccountPickerEnabled(config)) {
    return { catalogRefreshPending: false };
  }
  if (!convergeCodexCatalog) return { catalogRefreshPending: true };

  try {
    const catalogRefresh = normalizeCatalogDisposition(await convergeCodexCatalog());
    if (!catalogRefresh) return { catalogRefreshPending: true };
    return { catalogRefreshPending: catalogRefreshIsPending(catalogRefresh) };
  } catch {
    return { catalogRefreshPending: true };
  }
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  mapper: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await mapper(items[index]!);
    }
  });
  await Promise.all(workers);
  return results;
}

const MAIN_TERMINAL_AUTH_CODES = new Set([
  "invalid_workspace_selected",
  "invalid_refresh_token",
]);

/**
 * A WHAM 401 is not itself proof the local credential died. Upstream edges can
 * transiently reject a still-valid access token (region/anti-abuse/rotation
 * races), and fail-closing on every bare 401 makes a healthy main account flip
 * needs-reauth on the next GUI quota poll. Only treat the response as terminal
 * when the body carries a known terminal code or the local access token is not
 * verifiably live (`accessTokenLive`). Liveness must be strict: a JWT whose
 * `exp` cannot be decoded is NOT live — an undecodable token that vouched for
 * itself would make a real 401 permanently transient.
 */
async function isTerminalMainAuthResponse(resp: Response, accessTokenLive: boolean): Promise<boolean> {
  if (resp.status === 401) {
    if (!accessTokenLive) return true;
    const code = await readMainAuthErrorCode(resp);
    return typeof code === "string" && MAIN_TERMINAL_AUTH_CODES.has(code);
  }
  if (resp.status !== 403) return false;
  const code = await readMainAuthErrorCode(resp);
  return typeof code === "string" && MAIN_TERMINAL_AUTH_CODES.has(code);
}

async function readMainAuthErrorCode(resp: Response): Promise<unknown> {
  try {
    const body = await readBoundedResponseBody(resp, { totalTimeoutMs: 1_000, inactivityTimeoutMs: 1_000 });
    if (!body.displaySafe) return undefined;
    const parsed = JSON.parse(body.text) as {
      detail?: { code?: unknown } | string;
      error?: { code?: unknown } | string;
      code?: unknown;
    };
    const code = typeof parsed.detail === "object" && parsed.detail !== null
      ? parsed.detail.code
      : typeof parsed.error === "object" && parsed.error !== null
        ? parsed.error.code
        : parsed.code;
    return code;
  } catch {
    return undefined;
  }
}

interface MainAccountInfoFetchResult {
  info: MainAccountInfo;
  /** Whether this attempt safely inspected the physical native-main credential. */
  credentialChecked: boolean;
  /** Meaningful only when credentialChecked is true. */
  hasCredential: boolean;
  /** Main identity generation captured while the native-main claim was held. */
  identityGeneration?: number;
  /** Present only when this call freshly parsed a WHAM usage response. */
  freshQuota?: Omit<StoredAccountQuota, "updatedAt">;
  /** Present only when this call's WHAM response included `rate_limit_reset_credits.available_count`. */
  freshResetCredits?: number;
}

export interface MainAccountInfoSnapshot {
  info: MainAccountInfo;
  mainIdentityGeneration: number;
}

export async function fetchMainAccountInfoSnapshot(forceRefresh = false): Promise<MainAccountInfoSnapshot> {
  const result = await fetchMainAccountInfoAttempt(forceRefresh, 1);
  return {
    info: result.info,
    mainIdentityGeneration: result.identityGeneration ?? captureMainAccountIdentityGeneration(),
  };
}

export async function fetchMainAccountInfo(forceRefresh = false): Promise<MainAccountInfo> {
  return (await fetchMainAccountInfoSnapshot(forceRefresh)).info;
}

const EMPTY_MAIN_ACCOUNT_INFO: MainAccountInfo = { email: null, plan: null, quota: null };

async function retryMainAccountInfoIfIdentityChanged(
  requestAccountId: string | null,
  retriesRemaining: number,
  nativeMainLease: AdmissionLease,
  explicitRefresh: boolean,
): Promise<MainAccountInfoFetchResult | null> {
  const currentAccountId = getMainChatgptAccountId();
  if (currentAccountId === null || currentAccountId === requestAccountId) return null;
  reconcileMainCodexAccountRuntimeState();
  return retriesRemaining > 0
    ? fetchMainAccountInfoWhileOwned(true, retriesRemaining - 1, nativeMainLease, explicitRefresh)
    : { info: EMPTY_MAIN_ACCOUNT_INFO, credentialChecked: true, hasCredential: true };
}

async function fetchMainAccountInfoAttempt(
  forceRefresh: boolean,
  retriesRemaining: number,
  existingNativeMainLease?: AdmissionLease,
  nativeMainSharedClaimHeld = false,
): Promise<MainAccountInfoFetchResult> {
  const nativeMainLease = existingNativeMainLease ?? tryAcquireNativeMainProfileClaim();
  if (!nativeMainLease) {
    return {
      info: EMPTY_MAIN_ACCOUNT_INFO,
      credentialChecked: false,
      hasCredential: false,
      identityGeneration: captureMainAccountIdentityGeneration(),
    };
  }
  try {
    const operation = async () => ({
      ...await fetchMainAccountInfoWhileOwned(forceRefresh, retriesRemaining, nativeMainLease),
      identityGeneration: captureMainAccountIdentityGeneration(),
    });
    if (nativeMainSharedClaimHeld) return await operation();
    try {
      return await withNativeMainCredentialClaim(operation);
    } catch (error) {
      if (isNativeMainClaimUnavailable(error)) {
        return {
          info: EMPTY_MAIN_ACCOUNT_INFO,
          credentialChecked: false,
          hasCredential: false,
          identityGeneration: captureMainAccountIdentityGeneration(),
        };
      }
      throw error;
    }
  } finally {
    if (!existingNativeMainLease) nativeMainLease.release();
  }
}

async function fetchMainAccountInfoWhileOwned(
  forceRefresh: boolean,
  retriesRemaining: number,
  nativeMainLease: AdmissionLease,
  /**
   * Whether the *caller* asked for this refresh. `forceRefresh` also means "bypass the
   * cache", and `retryMainAccountInfoIfIdentityChanged` re-enters with it set purely to
   * re-read after the identity changed. Keeping the two apart stops that retry from
   * promoting a background poll into operator intent below.
   */
  explicitRefresh: boolean = forceRefresh,
): Promise<MainAccountInfoFetchResult> {
  const writerGeneration = captureConfigGeneration();
  reconcileMainCodexAccountRuntimeState();
  const tokenRead = readCodexTokensResult();
  setMainAccountCredentialPresence(tokenRead.status === "ok");
  if (tokenRead.status !== "ok") {
    // A local read failure is NOT proof of sign-out: a missing file can be a non-atomic rewrite
    // gap, and malformed JSON can be a half-written file. Clearing the cache and marking the
    // account for reauth here destroyed healthy email/plan/quota state and pinned a working
    // account as unusable. Preserve what we already know and let the caller retry; request
    // routing stays fail-closed because getMainAccountToken() re-reads the file itself, and the
    // account DTO still reports hasCredential=false while the file is unreadable.
    const preserved = getMainAccountInfoCache();
    return { info: preserved ?? EMPTY_MAIN_ACCOUNT_INFO, credentialChecked: true, hasCredential: false };
  }
  const tokens = tokenRead.tokens;
  const requestAccountId = extractAccountId(tokens.id_token, tokens.access_token) ?? (tokens.account_id || null);
  const cached = getMainAccountInfoCache();
  if (!forceRefresh && cached && Date.now() - cached.ts < MAIN_CACHE_TTL) {
    return { info: cached, credentialChecked: true, hasCredential: true };
  }
  try {
    const resp = await fetch("https://chatgpt.com/backend-api/wham/usage", {
      headers: { Authorization: `Bearer ${tokens.access_token}`, "ChatGPT-Account-Id": tokens.account_id },
      signal: AbortSignal.timeout(8000),
    });
    if (!resp.ok) {
      const terminalAuthFailure = await isTerminalMainAuthResponse(resp, isMainAccountTokenVerifiablyLive());
      const retried = await retryMainAccountInfoIfIdentityChanged(requestAccountId, retriesRemaining, nativeMainLease, explicitRefresh);
      if (retried) return retried;
      if (terminalAuthFailure) {
        clearMainAccountInfoCache();
        markAccountNeedsReauth(MAIN_CODEX_ACCOUNT_ID, writerGeneration);
      }
      return { info: EMPTY_MAIN_ACCOUNT_INFO, credentialChecked: true, hasCredential: true };
    }
    const data = (await resp.json()) as WhamUsageResponse;
    const retried = await retryMainAccountInfoIfIdentityChanged(requestAccountId, retriesRemaining, nativeMainLease, explicitRefresh);
    if (retried) return retried;
    const plan = nonEmptyPlan(data.plan_type) ?? nonEmptyPlan(cached?.plan) ?? nonEmptyPlan(getMainAccountPlan());
    const quota = parseUsageQuota({ ...data, ...(plan ? { plan_type: plan } : {}) });
    const freshResetCredits = quota?.resetCredits;
    const result = {
      email: data.email ?? null,
      plan,
      quota,
      ts: Date.now(),
    };
    setMainAccountInfoCache(result);
    // Only an explicit refresh may retract a reauth quarantine. A 200 from
    // /wham/usage proves the token authenticates to the usage endpoint; it does not
    // prove the account can serve Responses traffic, which is a different backend path
    // and still answers 403 for a workspace the token may no longer select (#327).
    // Letting the background poll clear the flag put such an account straight back into
    // rotation: the next request failed the same way and re-marked it, so needsReauth
    // never settled and the dashboard kept showing nothing — the symptom #327 reported.
    // An explicit refresh is an operator asking to re-evaluate, normally right after
    // signing in again, so it stays authoritative.
    if (explicitRefresh) clearAccountNeedsReauth(MAIN_CODEX_ACCOUNT_ID);
    // Mirror main quota + plan into the shared stores so the rotation engine can
    // score and auto-switch the main account exactly like a pool account (Option A).
    setMainAccountPlan(result.plan);
    if (result.quota) {
      setAccountQuotaFromParsed(MAIN_CODEX_ACCOUNT_ID, result.quota, writerGeneration);
    }
    return {
      info: result,
      credentialChecked: true,
      hasCredential: true,
      ...(quota ? { freshQuota: quota } : {}),
      ...(freshResetCredits !== undefined ? { freshResetCredits } : {}),
    };
  } catch {
    const retried = await retryMainAccountInfoIfIdentityChanged(requestAccountId, retriesRemaining, nativeMainLease, explicitRefresh);
    return retried ?? { info: EMPTY_MAIN_ACCOUNT_INFO, credentialChecked: true, hasCredential: true };
  }
}

interface PoolQuotaResult {
  quota: StoredAccountQuota | null;
  needsReauth: boolean;
  /** Credential generation whose cache or network result this DTO state belongs to. */
  credentialGeneration?: number;
  /** Present only when this call freshly parsed a WHAM usage response. */
  freshQuota?: Omit<StoredAccountQuota, "updatedAt">;
  /** Present only when this call's WHAM response included a non-empty `plan_type`. */
  freshPlan?: string;
  /** Credential generation used by this fresh quota request. */
  freshCredentialGeneration?: number;
  /** Present only when this call's WHAM response included `rate_limit_reset_credits.available_count`. */
  freshResetCredits?: number;
  quotaProbeSkipped?: true;
}

interface PoolQuotaRefreshFlight {
  state: {
    startCredentialGeneration?: number;
    resolvedCredentialGeneration?: number;
  };
  promise: Promise<PoolQuotaResult>;
}

const poolQuotaRefreshInFlight = new Map<string, Set<PoolQuotaRefreshFlight>>();
const MAX_POOL_QUOTA_FLIGHTS = 16;

export class PoolQuotaProbeBusyError extends ResourceAdmissionError {
  constructor() {
    super("pool_quota_flights", MAX_POOL_QUOTA_FLIGHTS);
    this.name = "PoolQuotaProbeBusyError";
  }
}

function poolQuotaFlightCount(): number {
  let count = 0;
  for (const flights of poolQuotaRefreshInFlight.values()) count += flights.size;
  return count;
}

/** Focused admission tests only; returns cleanup for the synthetic owners it inserts. */
export function seedCodexAuthAdmissionForTests(options: { loginFlows?: number; quotaFlights?: number }): () => void {
  const prefix = `admission-test-${crypto.randomUUID()}`;
  for (let index = 0; index < (options.loginFlows ?? 0); index++) {
    codexAuthLoginState.set(`${prefix}-login-${index}`, { status: "starting", startedAt: Date.now() });
  }
  for (let index = 0; index < (options.quotaFlights ?? 0); index++) {
    poolQuotaRefreshInFlight.set(`${prefix}-quota-${index}`, new Set([{
      state: {},
      promise: new Promise<PoolQuotaResult>(() => {}),
    }]));
  }
  return () => {
    for (const key of [...codexAuthLoginState.keys()]) if (key.startsWith(prefix)) codexAuthLoginState.delete(key);
    for (const key of [...poolQuotaRefreshInFlight.keys()]) if (key.startsWith(prefix)) poolQuotaRefreshInFlight.delete(key);
  };
}

export interface CodexAuthAccountDto {
  id: string;
  alias?: string;
  email: string;
  plan?: string | null;
  logLabel?: string;
  isMain: boolean;
  paused: boolean;
  /** Selection order; higher is used earlier. Always present, 0 when unset. */
  priority: number;
  quota: (StoredAccountQuota | (Omit<StoredAccountQuota, "updatedAt"> & { updatedAt: number })) | null;
  needsReauth?: boolean;
  hasCredential: boolean;
  health: OAuthAccountHealth;
  healthLabel: OAuthHealthLabel;
  healthSummary: string;
  healthAction?: string;
  quotaProbeSkipped?: true;
}

interface FreshPoolPlanUpdate {
  accountId: string;
  plan: string;
  credentialGeneration: number;
}

/**
 * Persist only validated plan leaves against the latest disk snapshot. A quota GET must not save
 * the long-lived runtime object wholesale: unrelated manual/provider writes may have landed while
 * WHAM requests were in flight. Missing or malformed files fail closed: a read path must not
 * recreate a deleted config from the server's older in-memory snapshot.
 */
function reconcileFreshPoolAccountPlans(runtimeConfig: OcxConfig, updates: FreshPoolPlanUpdate[]): void {
  if (updates.length === 0) return;
  let outcome: ReturnType<typeof mutatePersistedConfig<FreshPoolPlanUpdate[]>>;
  try {
    outcome = mutatePersistedConfig(persistedConfig => {
      const accepted: FreshPoolPlanUpdate[] = [];
      let changed = false;
      for (const update of updates) {
        if (!isCodexAccountGenerationLive(update.accountId, update.credentialGeneration)) continue;
        const liveAccount = configuredPoolAccount(runtimeConfig, update.accountId);
        const persistedAccount = configuredPoolAccount(persistedConfig, update.accountId);
        if (!liveAccount || !persistedAccount) continue;
        accepted.push(update);
        if (persistedAccount.plan !== update.plan) {
          persistedAccount.plan = update.plan;
          // WHAM is the authoritative plan source: stamp provenance so a later JWT
          // reconcile cannot overwrite this observation within the same credential
          // generation (src/codex/plan-from-token.ts jwtMayWritePlan). Stamped only
          // alongside a real plan change: a steady-state refresh whose plan is
          // unchanged must stay write-free (no-config-write contract), and an
          // unchanged value needs no fence — a JWT rewrite to the same text is a
          // no-op under the caller's own equality check.
          persistedAccount.planSource = "wham";
          persistedAccount.planCredentialGeneration = update.credentialGeneration;
          changed = true;
        }
      }
      return { changed, value: accepted };
    });
  } catch (error) {
    // Plan persistence is derived metadata on a read route. Contention must fail closed without
    // turning account listing into a 500; a later refresh can retry against the latest files.
    if (error instanceof ConfigMutationLockError) return;
    throw error;
  }
  if (outcome.status === "unavailable") return;
  for (const update of outcome.value) {
    // A replacement immediately after the durable commit is allowed to supersede the result, but
    // the long-lived object must never be updated from that stale generation.
    if (!isCodexAccountGenerationLive(update.accountId, update.credentialGeneration)) continue;
    const liveAccount = configuredPoolAccount(runtimeConfig, update.accountId);
    if (liveAccount) {
      liveAccount.plan = update.plan;
      liveAccount.planSource = "wham";
      liveAccount.planCredentialGeneration = update.credentialGeneration;
    }
  }
}

async function fetchFreshPoolAccountQuota(
  accountId: string,
  existing: StoredAccountQuota | null,
  configuredPlan?: string,
  onCredentialGeneration?: (generation: number) => void,
): Promise<PoolQuotaResult> {
  const writerGeneration = captureConfigGeneration();
  let requestCredentialGeneration = readCodexAccountRecord(accountId)?.generation;
  try {
    const { accessToken, chatgptAccountId, generation } = await getValidCodexToken(accountId);
    requestCredentialGeneration = generation;
    onCredentialGeneration?.(generation);
    const resp = await fetch("https://chatgpt.com/backend-api/wham/usage", {
      headers: { Authorization: `Bearer ${accessToken}`, "ChatGPT-Account-Id": chatgptAccountId },
      signal: AbortSignal.timeout(8000),
    });
    if (!resp.ok) {
      return {
        quota: existing ?? null,
        needsReauth: resp.status === 401,
        credentialGeneration: generation,
      };
    }
    const data = (await resp.json()) as WhamUsageResponse;
    const freshPlan = nonEmptyPlan(data.plan_type) ?? undefined;
    const quota = parseUsageQuota({ ...data, plan_type: freshPlan ?? configuredPlan });
    const freshResetCredits = quota?.resetCredits;
    if (!quota) {
      return {
        quota: isCodexAccountGenerationLive(accountId, generation) ? existing ?? null : getAccountQuota(accountId),
        needsReauth: false,
        credentialGeneration: generation,
        ...(freshPlan !== undefined
          ? { freshPlan, freshCredentialGeneration: generation }
          : {}),
      };
    }
    if (!isCodexAccountGenerationLive(accountId, generation)) {
      return { quota: null, needsReauth: false, credentialGeneration: generation };
    }
    setAccountQuotaFromParsed(accountId, quota, writerGeneration);
    return {
      quota: getAccountQuota(accountId),
      needsReauth: false,
      credentialGeneration: generation,
      freshQuota: quota,
      freshCredentialGeneration: generation,
      ...(freshPlan !== undefined ? { freshPlan } : {}),
      ...(freshResetCredits !== undefined ? { freshResetCredits } : {}),
    };
  } catch (e) {
    if (e instanceof CodexCredentialGenerationConflictError || e instanceof CodexCredentialRefreshLockTimeoutError
      || e instanceof CodexCredentialRefreshBusyError || e instanceof CodexCredentialRefreshStaleError) {
      return {
        quota: existing ?? null,
        needsReauth: false,
        credentialGeneration: requestCredentialGeneration,
        ...(e instanceof CodexCredentialRefreshBusyError || e instanceof CodexCredentialRefreshStaleError
          ? { quotaProbeSkipped: true as const }
          : {}),
      };
    }
    if (e instanceof TokenRefreshError) {
      return { quota: existing ?? null, needsReauth: true, credentialGeneration: requestCredentialGeneration };
    }
    return { quota: existing ?? null, needsReauth: false, credentialGeneration: requestCredentialGeneration };
  }
}

async function fetchPoolAccountQuota(accountId: string, forceRefresh = false, configuredPlan?: string): Promise<PoolQuotaResult> {
  const existing = getAccountQuota(accountId);
  if (!forceRefresh && existing && Date.now() - existing.updatedAt < POOL_CACHE_TTL) {
    return {
      quota: existing,
      needsReauth: false,
      credentialGeneration: readCodexAccountRecord(accountId)?.generation,
    };
  }
  // A token refresh may increment the generation (and rotate the refresh token) before WHAM
  // completes. Join a flight whose starting or resolved generation is still current, but let a
  // replacement credential with the same pool id start its own request.
  const record = readCodexAccountRecord(accountId);
  const flights = poolQuotaRefreshInFlight.get(accountId);
  const current = flights && [...flights].find(flight => {
    const generation = flight.state.resolvedCredentialGeneration
      ?? flight.state.startCredentialGeneration;
    return generation !== undefined && isCodexAccountGenerationLive(accountId, generation);
  });
  if (current) return current.promise;
  if (poolQuotaFlightCount() >= MAX_POOL_QUOTA_FLIGHTS) throw new PoolQuotaProbeBusyError();

  const state: PoolQuotaRefreshFlight["state"] = {
    startCredentialGeneration: record?.generation,
  };
  const refresh = fetchFreshPoolAccountQuota(
    accountId,
    existing,
    configuredPlan,
    generation => { state.resolvedCredentialGeneration = generation; },
  );
  const flight: PoolQuotaRefreshFlight = { state, promise: refresh };
  const activeFlights = flights ?? new Set<PoolQuotaRefreshFlight>();
  activeFlights.add(flight);
  if (!flights) poolQuotaRefreshInFlight.set(accountId, activeFlights);
  try {
    return await refresh;
  } finally {
    activeFlights.delete(flight);
    if (activeFlights.size === 0 && poolQuotaRefreshInFlight.get(accountId) === activeFlights) {
      poolQuotaRefreshInFlight.delete(accountId);
    }
  }
}

let primeInFlight: Promise<void> | null = null;
let cooldownRecoveryInFlight: Promise<void> | null = null;

export async function runCodexCooldownRecoveryProbes(config: OcxConfig, now = Date.now()): Promise<void> {
  const openai = config.providers[OPENAI_CODEX_PROVIDER_ID];
  if (!openai
    || openai.disabled === true
    || !isCanonicalOpenAiForwardProvider(openai)
    || providerCodexAccountMode(OPENAI_CODEX_PROVIDER_ID, openai) !== "pool") return;
  if (cooldownRecoveryInFlight) return cooldownRecoveryInFlight;
  cooldownRecoveryInFlight = (async () => {
    const claims = claimDueCodexQuotaRecoveryProbes(config, POOL_QUOTA_REFRESH_CONCURRENCY, now);
    await mapWithConcurrency(claims, POOL_QUOTA_REFRESH_CONCURRENCY, async claim => {
      const account = configuredPoolAccount(config, claim.accountId);
      if (!account) {
        settleCodexQuotaRecoveryProbe(claim, false, {}, now);
        return;
      }
      try {
        const result = await fetchPoolAccountQuota(claim.accountId, true, account.plan);
        // Defence in depth: `spark` is already excluded at the claim site, since generic WHAM
        // cannot prove a spark recovery. Keep the settle-side guard so a future claim change
        // cannot silently start clearing spark on generic evidence.
        const recovered = claim.scope !== "spark"
          && isCompleteCodexQuotaRecoverySnapshot(result.freshQuota ?? null, result.freshPlan ?? account.plan);
        settleCodexQuotaRecoveryProbe(claim, recovered, {
          credentialGeneration: result.freshCredentialGeneration,
        }, now);
      } catch {
        settleCodexQuotaRecoveryProbe(claim, false, {}, now);
      }
    });
  })().catch(() => {
    // Background recovery is best-effort; routing keeps the cooldown on failure.
  }).finally(() => { cooldownRecoveryInFlight = null; });
  return cooldownRecoveryInFlight;
}

export function registerCodexCooldownRecoveryProbeWorker(config: OcxConfig): void {
  registerStateSweepAfterTick({
    name: "codex-cooldown-recovery",
    afterTick: () => { void runCodexCooldownRecoveryProbes(config); },
  });
}

export interface PrimeCodexPoolQuotasOptions {
  /** Test seams for proving fenced/recovery priming performs no native-main work. */
  reconcileMainAccount?: typeof reconcileMainCodexAccountRuntimeState;
  readMainTokens?: typeof readCodexTokens;
  fetchMainInfo?: typeof fetchMainAccountInfo;
}

function tryAcquireNativeMainPrimeLease(): AdmissionLease | null {
  return tryAcquireNativeMainProfileClaim();
}

/**
 * Best-effort prime of pool-account (and main) quota so the rotation engine has
 * real usage scores instead of leaving every account at the unknown sentinel.
 *
 * Quota is otherwise populated only from live upstream headers (an idle pool
 * account never serves traffic, so it never gets scored) or from the dashboard
 * WHAM fetch (a CLI-only user never opens it). Without priming, every account
 * stays unknown and auto-switch cannot move (see Phase 10). This runs at startup
 * and lazily before routing when the active account is unknown.
 *
 * Single-flight: concurrent callers share one pass instead of stampeding N WHAM
 * fetches. Per-fetch 8s timeouts and the 5-minute POOL_CACHE_TTL already bound
 * cost, so the worst case is one WHAM call per account per TTL window. Failures
 * are swallowed: a blocked WSL network must never crash startup or a request.
 */
export async function primeCodexPoolQuotas(
  config: OcxConfig,
  reason: string,
  options: PrimeCodexPoolQuotasOptions = {},
): Promise<void> {
  const openai = config.providers[OPENAI_CODEX_PROVIDER_ID];
  if (
    !openai
    || openai.disabled === true
    || !isCanonicalOpenAiForwardProvider(openai)
    || providerCodexAccountMode(OPENAI_CODEX_PROVIDER_ID, openai) !== "pool"
  ) return;
  if (primeInFlight) return primeInFlight;
  primeInFlight = (async () => {
    const runtimeConfig = getRuntimeConfig(config);
    const pool = (runtimeConfig.codexAccounts ?? []).filter(isSelectableCodexPoolAccount);
    const stale = pool.filter(a => {
      const q = getAccountQuota(a.id);
      return !q || Date.now() - q.updatedAt >= POOL_CACHE_TTL;
    });
    const primeMain = async () => {
      const mainLease = tryAcquireNativeMainPrimeLease();
      if (!mainLease) return;
      try {
        try {
          await withNativeMainCredentialClaim(async () => {
            // Keep one local owner and one cross-process reader from physical
            // identity reconciliation through WHAM and all quota publication.
            (options.reconcileMainAccount ?? reconcileMainCodexAccountRuntimeState)();
            if (getAccountQuota(MAIN_CODEX_ACCOUNT_ID)) return;
            if (!(options.readMainTokens ?? readCodexTokens)()) return;
            if (options.fetchMainInfo) await options.fetchMainInfo(false);
            else await fetchMainAccountInfoAttempt(false, 1, mainLease, true);
          });
        } catch (error) {
          if (!isNativeMainClaimUnavailable(error)) throw error;
        }
      } finally {
        mainLease.release();
      }
    };
    try {
      await Promise.allSettled([
        primeMain(),
        mapWithConcurrency(stale, POOL_QUOTA_REFRESH_CONCURRENCY, async a => {
          if (!getCodexAccountCredential(a.id)) return;
          await fetchPoolAccountQuota(a.id, false, a.plan);
        }),
      ]);
    } catch {
      // Priming is best-effort; never propagate.
    }
    if (process.env.OPENCODEX_DEBUG_QUOTA === "1") {
      console.warn(`[codex-quota] prime done (reason=${reason}, pool=${pool.length}, refreshed=${stale.length})`);
    }
  })().finally(() => { primeInFlight = null; });
  return primeInFlight;
}

/** Test-only: drop any in-flight prime pass so a leaked single-flight promise
 * from another suite cannot coalesce into the next prime. */
export function clearCodexQuotaPrimeState(): void {
  primeInFlight = null;
}

/** Test-only reset for the worker-level single-flight. */
export function clearCodexCooldownRecoveryProbeState(): void {
  cooldownRecoveryInFlight = null;
}

export function effectiveCodexAuthAccountId(config: OcxConfig): string {
  return getEffectiveActiveCodexAccountId(config) ?? MAIN_CODEX_ACCOUNT_ID;
}

export interface CodexAuthAccountsSnapshot {
  accounts: CodexAuthAccountDto[];
  mainIdentityGeneration: number;
}

export async function listCodexAuthAccountsSnapshot(
  config: OcxConfig,
  forceRefresh = false,
): Promise<CodexAuthAccountsSnapshot> {
  const runtimeConfig = getRuntimeConfig(config);
  const poolAccounts = (runtimeConfig.codexAccounts ?? []).filter(isSelectableCodexPoolAccount);
  const mainResult = await fetchMainAccountInfoAttempt(forceRefresh, 1);
  const refreshedPool = await mapWithConcurrency(poolAccounts, POOL_QUOTA_REFRESH_CONCURRENCY, async account => {
    const cred = getCodexAccountCredential(account.id);
    let quotaResult: PoolQuotaResult;
    if (!cred) {
      quotaResult = { quota: null, needsReauth: true };
    } else {
      try {
        quotaResult = await fetchPoolAccountQuota(account.id, forceRefresh, account.plan);
      } catch (error) {
        if (!(error instanceof PoolQuotaProbeBusyError)) throw error;
        quotaResult = {
          quota: getAccountQuota(account.id),
          needsReauth: false,
          credentialGeneration: readCodexAccountRecord(account.id)?.generation,
          quotaProbeSkipped: true,
        };
      }
    }
    return { accountId: account.id, quotaResult };
  });

  // WHAM plan_type is authoritative only for the credential generation that fetched it. Collect
  // changes after every parallel read settles, then apply one narrow disk patch for the batch.
  const planUpdates = refreshedPool.flatMap(({ accountId, quotaResult }): FreshPoolPlanUpdate[] => {
    const plan = quotaResult.freshPlan;
    const credentialGeneration = quotaResult.freshCredentialGeneration;
    return plan && credentialGeneration !== undefined
      ? [{ accountId, plan, credentialGeneration }]
      : [];
  });
  reconcileFreshPoolAccountPlans(runtimeConfig, planUpdates);

  const withQuota = refreshedPool.flatMap(({ accountId, quotaResult }) => {
    const currentAccount = configuredPoolAccount(runtimeConfig, accountId);
    if (!currentAccount) return [];
    const currentCredential = getCodexAccountCredential(accountId);
    if (!currentCredential) {
      return [poolAccountDto(
        currentAccount,
        { quota: null, needsReauth: true },
        false,
        isCodexAccountPaused(runtimeConfig, accountId),
        getCodexAccountPriority(runtimeConfig, accountId),
      )];
    }
    const resultGeneration = quotaResult.credentialGeneration ?? quotaResult.freshCredentialGeneration;
    const generationLive = resultGeneration === undefined
      || isCodexAccountGenerationLive(accountId, resultGeneration);
    const effectiveQuotaResult = !generationLive
      ? { quota: null, needsReauth: false }
      : quotaResult;
    // Response DTO can show the WHAM plan even when disk persistence fails closed (lock busy /
    // missing config). Persistence still remains generation-gated via reconcileFreshPoolAccountPlans.
    const dtoAccount = generationLive && quotaResult.freshPlan
      ? { ...currentAccount, plan: quotaResult.freshPlan }
      : currentAccount;
    return [poolAccountDto(
      dtoAccount,
      effectiveQuotaResult,
      true,
      isCodexAccountPaused(runtimeConfig, accountId),
      getCodexAccountPriority(runtimeConfig, accountId),
    )];
  });
  const fetchedMainGeneration = mainResult.identityGeneration ?? captureMainAccountIdentityGeneration();
  const mainSnapshotLive = isMainAccountIdentityGenerationLive(fetchedMainGeneration);
  const mainInfo = mainSnapshotLive ? mainResult.info : EMPTY_MAIN_ACCOUNT_INFO;
  const hasMainCredential = mainSnapshotLive && mainResult.credentialChecked
    ? mainResult.hasCredential
    : getMainAccountCredentialPresence() ?? false;
  const mainNeedsReauth = (mainSnapshotLive && mainResult.credentialChecked && !hasMainCredential)
    || isAccountNeedsReauth(MAIN_CODEX_ACCOUNT_ID);
  const mainHealth = projectCodexAccountHealth({
    accountId: MAIN_CODEX_ACCOUNT_ID,
    needsReauth: mainNeedsReauth,
  });
  const main: CodexAuthAccountDto = {
    id: MAIN_CODEX_ACCOUNT_ID,
    email: maskEmail(mainInfo.email) ?? "Codex App login",
    plan: mainInfo.plan,
    logLabel: "main",
    isMain: true,
    paused: isCodexAccountPaused(runtimeConfig, MAIN_CODEX_ACCOUNT_ID),
    priority: getCodexAccountPriority(runtimeConfig, MAIN_CODEX_ACCOUNT_ID),
    hasCredential: hasMainCredential,
    needsReauth: mainNeedsReauth,
    quota: mainInfo.quota ? {
      ...quotaForPlan({
        ...mainInfo.quota,
        updatedAt: getAccountQuota(MAIN_CODEX_ACCOUNT_ID)?.updatedAt ?? Date.now(),
      }, mainInfo.plan),
    } : null,
    ...oauthAccountHealthFields("codex", MAIN_CODEX_ACCOUNT_ID, mainHealth),
  };
  return {
    accounts: [main, ...withQuota],
    mainIdentityGeneration: mainSnapshotLive
      ? fetchedMainGeneration
      : captureMainAccountIdentityGeneration(),
  };
}

export async function listCodexAuthAccounts(config: OcxConfig, forceRefresh = false): Promise<CodexAuthAccountDto[]> {
  return (await listCodexAuthAccountsSnapshot(config, forceRefresh)).accounts;
}

interface PauseExhaustedResult {
  pausedAccountIds: string[];
  checkedAccountCount: number;
  failedAccountCount: number;
}

function selectFallbackAfterPause(config: OcxConfig, pausedActiveId: string): void {
  reconcileCodexActiveAfterExclusion(config, pausedActiveId);
}

async function pauseExhaustedCodexAccounts(
  config: OcxConfig,
  persistPausedAccounts: () => void,
): Promise<PauseExhaustedResult> {
  const poolAccounts = (config.codexAccounts ?? []).filter(account => !account.isMain);
  const nativeMainLease = tryAcquireNativeMainProfileClaim();
  try {
    const performPause = async (mainLease?: AdmissionLease): Promise<PauseExhaustedResult> => {
      const mainWork = async (): Promise<{
        shouldPause: boolean;
        checkedAccountCount: number;
        failedAccountCount: number;
      }> => {
        if (!mainLease) return { shouldPause: false, checkedAccountCount: 0, failedAccountCount: 1 };
        const mainResult = await fetchMainAccountInfoAttempt(true, 1, mainLease, true);
        if (!mainResult.credentialChecked || !mainResult.hasCredential) {
          return { shouldPause: false, checkedAccountCount: 0, failedAccountCount: 0 };
        }
        if (!mainResult.freshQuota || !mainResult.info.plan) {
          return { shouldPause: false, checkedAccountCount: 0, failedAccountCount: 1 };
        }
        return {
          shouldPause: !isCodexAccountPaused(config, MAIN_CODEX_ACCOUNT_ID)
            && isCodexQuotaExhausted(mainResult.freshQuota, mainResult.info.plan),
          checkedAccountCount: 1,
          failedAccountCount: 0,
        };
      };
      const [mainResult, poolResults] = await Promise.all([
        mainWork(),
        mapWithConcurrency(poolAccounts, POOL_QUOTA_REFRESH_CONCURRENCY, async account => {
          if (!getCodexAccountCredential(account.id)) return { account, quotaResult: null };
          try {
            return {
              account,
              quotaResult: await fetchPoolAccountQuota(account.id, true, account.plan),
            };
          } catch {
            // Settle each pool probe independently so a busy/failing account cannot
            // abandon an already-confirmed main decision before atomic publication.
            return { account, quotaResult: null };
          }
        }),
      ]);

      let checkedAccountCount = mainResult.checkedAccountCount;
      let failedAccountCount = mainResult.failedAccountCount;
      const exhaustedIds: string[] = mainResult.shouldPause ? [MAIN_CODEX_ACCOUNT_ID] : [];
      for (const { account, quotaResult } of poolResults) {
        const currentAccount = (config.codexAccounts ?? []).find(candidate => candidate.id === account.id && !candidate.isMain);
        if (!currentAccount) continue;
        const generation = quotaResult?.freshCredentialGeneration;
        const plan = quotaResult?.freshPlan ?? currentAccount.plan;
        if (!quotaResult?.freshQuota || generation === undefined || !isCodexAccountGenerationLive(account.id, generation) || !plan) {
          failedAccountCount += 1;
          continue;
        }
        checkedAccountCount += 1;
        if (!isCodexAccountPaused(config, account.id) && isCodexQuotaExhausted(quotaResult.freshQuota, plan)) {
          exhaustedIds.push(account.id);
        }
      }

      for (const id of exhaustedIds) {
        setCodexAccountPaused(config, id, true);
        clearThreadAccountMapForAccount(id);
      }
      for (const id of exhaustedIds) selectFallbackAfterPause(config, id);
      const result = {
        pausedAccountIds: exhaustedIds,
        checkedAccountCount,
        failedAccountCount,
      };
      // Persist while both the in-process admission and cross-process shared
      // claim still own the physical-main identity used for the decision.
      if (result.pausedAccountIds.length > 0) persistPausedAccounts();
      return result;
    };

    if (!nativeMainLease) return await performPause();
    try {
      return await withNativeMainCredentialClaim(() => performPause(nativeMainLease));
    } catch (error) {
      if (isNativeMainClaimUnavailable(error)) return await performPause();
      throw error;
    }
  } finally {
    nativeMainLease?.release();
  }
}

export async function handleCodexAuthAPI(
  req: Request,
  url: URL,
  config: OcxConfig,
  convergeCodexCatalog?: CodexAuthCatalogConvergence,
): Promise<Response | null> {

  if (url.pathname === "/api/codex-auth/accounts" && req.method === "GET") {
    const forceRefresh = url.searchParams.get("refresh") === "1" || url.searchParams.get("refresh") === "true";
    return jsonResponse({ accounts: await listCodexAuthAccounts(config, forceRefresh) });
  }

  if (url.pathname === "/api/codex-auth/accounts" && req.method === "POST") {
    return manualImportDisabledResponse();
  }

  if (url.pathname === "/api/codex-auth/accounts" && req.method === "DELETE") {
    const id = url.searchParams.get("id");
    if (!id) return jsonResponse({ error: "Missing id" }, 400);
    const runtimeConfig = getRuntimeConfig(config);
    const isLegacyPoolAccount = CODEX_ACCOUNT_ID_RE.test(id)
      && (runtimeConfig.codexAccounts ?? []).some(account => !account.isMain && account.id === id);
    if (!isValidCodexAccountId(id) && !isLegacyPoolAccount) {
      return jsonResponse({ error: "Invalid account id format" }, 400);
    }
    const pickerVisibilityChanged = deleteCodexAccount(runtimeConfig, id);
    saveRuntimeConfig(config, runtimeConfig);
    reconcileLiveStateStores();
    const catalogRefresh = await convergeAccountNamespaceCatalog(
      runtimeConfig,
      pickerVisibilityChanged,
      convergeCodexCatalog,
    );
    return jsonResponse({ ok: true, ...catalogRefresh });
  }

  if (url.pathname === "/api/codex-auth/accounts/alias" && req.method === "PUT") {
    const body = await req.json().catch(() => ({})) as { id?: unknown; alias?: unknown };
    const id = typeof body.id === "string" ? body.id.trim() : "";
    const alias = typeof body.alias === "string" ? body.alias.trim() : "";
    if (id === MAIN_CODEX_ACCOUNT_ID) return jsonResponse({ error: "Main Codex account alias is not configurable" }, 400);
    if (!isValidCodexAccountId(id)) return jsonResponse({ error: "Invalid account id format" }, 400);
    if (typeof body.alias !== "string" || alias.length > 80 || /[\x00-\x1f\x7f]/.test(alias)) {
      return jsonResponse({ error: "Alias must be a string of at most 80 printable characters" }, 400);
    }
    const runtimeConfig = getRuntimeConfig(config);
    const account = (runtimeConfig.codexAccounts ?? []).find(candidate => candidate.id === id && !candidate.isMain);
    if (!account) return jsonResponse({ error: "Account not found" }, 404);
    if (alias) account.alias = alias;
    else delete account.alias;
    saveRuntimeConfig(config, runtimeConfig);
    return jsonResponse({ ok: true, id, alias: alias || null });
  }

  if (url.pathname === "/api/codex-auth/accounts/pause" && req.method === "PUT") {
    const body = await req.json().catch(() => ({})) as { id?: unknown; paused?: unknown };
    const id = typeof body.id === "string" ? body.id.trim() : "";
    if (id !== MAIN_CODEX_ACCOUNT_ID && !isValidCodexAccountId(id)) {
      return jsonResponse({ error: "Invalid account id format" }, 400);
    }
    if (typeof body.paused !== "boolean") return jsonResponse({ error: "paused must be a boolean" }, 400);

    const runtimeConfig = getRuntimeConfig(config);
    const exists = id === MAIN_CODEX_ACCOUNT_ID
      || (runtimeConfig.codexAccounts ?? []).some(account => isSelectableCodexPoolAccount(account) && account.id === id);
    if (!exists) return jsonResponse({ error: "Account not found" }, 404);

    setCodexAccountPaused(runtimeConfig, id, body.paused);
    if (body.paused) {
      clearThreadAccountMapForAccount(id);
      selectFallbackAfterPause(runtimeConfig, id);
    }
    saveRuntimeConfig(config, runtimeConfig);
    return jsonResponse({
      ok: true,
      id,
      paused: body.paused,
      activeCodexAccountId: getEffectiveActiveCodexAccountId(runtimeConfig) ?? null,
      appliesImmediately: true,
    });
  }

  // Deliberately a route of its own rather than a field on the alias PATCH: aliases
  // are display-only and reject __main__, while selection order is routing metadata
  // that the Desktop account must be able to carry. Re-ordering never kicks a live
  // thread, so there is no affinity clearing and no appliesImmediately here.
  if (url.pathname === "/api/codex-auth/accounts/priority" && req.method === "PUT") {
    let parsedBody: unknown;
    try { parsedBody = await req.json(); } catch { return jsonResponse({ error: "Invalid JSON" }, 400); }
    if (typeof parsedBody !== "object" || parsedBody === null || Array.isArray(parsedBody)) {
      return jsonResponse({ error: "body must be an object" }, 400);
    }
    const body = parsedBody as { id?: unknown; priority?: unknown };
    const id = typeof body.id === "string" ? body.id.trim() : "";
    if (!isCodexAccountPriorityKey(id)) {
      return jsonResponse({ error: "Invalid account id format" }, 400);
    }

    let priority = DEFAULT_ACCOUNT_PRIORITY;
    if (body.priority !== null) {
      const parsed = parseAccountPriority(body.priority);
      if (parsed === null) {
        return jsonResponse({
          error: `priority must be null or an integer ${MIN_ACCOUNT_PRIORITY}-${MAX_ACCOUNT_PRIORITY}`,
        }, 400);
      }
      priority = parsed;
    }

    const runtimeConfig = getRuntimeConfig(config);
    const exists = id === MAIN_CODEX_ACCOUNT_ID
      || (runtimeConfig.codexAccounts ?? []).some(account => isSelectableCodexPoolAccount(account) && account.id === id);
    if (!exists) return jsonResponse({ error: "Account not found" }, 404);

    setCodexAccountPriority(runtimeConfig, id, priority);
    // Both a pin and an order are the operator saying which account to use, so the newer
    // statement wins. Without this a pin made before any order existed — an ordinary
    // account switch — would outrank the order forever: it blocks preemption and caps
    // every eligibility list at its own tier until that account drains or is paused.
    clearCodexAccountPin(runtimeConfig);
    saveRuntimeConfig(config, runtimeConfig);
    return jsonResponse({
      ok: true,
      id,
      priority,
      activeCodexAccountId: getEffectiveActiveCodexAccountId(runtimeConfig) ?? null,
    });
  }

  if (url.pathname === "/api/codex-auth/accounts/pause-exhausted" && req.method === "PUT") {
    const runtimeConfig = getRuntimeConfig(config);
    const result = await pauseExhaustedCodexAccounts(
      runtimeConfig,
      () => saveRuntimeConfig(config, runtimeConfig),
    );
    const { pausedAccountIds, checkedAccountCount, failedAccountCount } = result;
    if (checkedAccountCount === 0 && failedAccountCount > 0) {
      return jsonResponse({
        ok: false,
        error: "Failed to refresh any Codex account quota",
        checkedAccountCount,
        failedAccountCount,
      }, 502);
    }
    return jsonResponse({
      ok: true,
      pausedAccountIds,
      pausedCount: pausedAccountIds.length,
      checkedAccountCount,
      failedAccountCount,
      complete: failedAccountCount === 0,
      activeCodexAccountId: getEffectiveActiveCodexAccountId(runtimeConfig) ?? null,
      appliesImmediately: true,
    });
  }

  // Manual escape from a quota cooldown. Injected Codex routing makes this proxy the only
  // model path for Codex Desktop, so a cooldown that outlives the real upstream limit
  // otherwise leaves editing config.toml as the user's only recovery.
  //
  // Existence is deliberately NOT disclosed: an unknown id returns 200 with cleared:false
  // exactly like an account that simply had no live cooldown, so this route cannot be used
  // to enumerate configured accounts. Cooldown state is runtime-only and independent of the
  // account list, so 404 would carry no useful meaning anyway.
  if (url.pathname === "/api/codex-auth/accounts/clear-cooldown" && req.method === "POST") {
    const body = await req.json().catch(() => ({})) as { id?: unknown };
    const id = typeof body.id === "string" ? body.id.trim() : "";
    if (id !== MAIN_CODEX_ACCOUNT_ID && !isValidCodexAccountId(id)) {
      return jsonResponse({ error: "Invalid account id format" }, 400);
    }
    return jsonResponse({ ok: true, id, cleared: clearCodexAccountCooldown(id) });
  }

  if (url.pathname === "/api/codex-auth/active" && req.method === "PUT") {
    let body: { accountId: string | null };
    try { body = (await req.json()) as typeof body; } catch { return jsonResponse({ error: "Invalid JSON" }, 400); }
    const runtimeConfig = getRuntimeConfig(config);
    const targetAccountId = body.accountId ?? MAIN_CODEX_ACCOUNT_ID;
    if (body.accountId === MAIN_CODEX_ACCOUNT_ID && hasLegacyMainCodexPoolAccount(runtimeConfig.codexAccounts)) {
      return jsonResponse({ error: "Remove the legacy __main__ pool row before selecting the Desktop account" }, 409);
    }
    if (isCodexAccountPaused(runtimeConfig, targetAccountId)) {
      return jsonResponse({ error: "Account is paused" }, 409);
    }
    if (body.accountId != null && body.accountId !== MAIN_CODEX_ACCOUNT_ID) {
      if (!isValidCodexAccountId(body.accountId)) return jsonResponse({ error: "Invalid account id format" }, 400);
      const exists = (runtimeConfig.codexAccounts ?? [])
        .some(account => isSelectableCodexPoolAccount(account) && account.id === body.accountId);
      if (!exists) return jsonResponse({ error: "Account not found" }, 400);
    }
    runtimeConfig.activeCodexAccountId = body.accountId ?? undefined;
    // "Use this account now" outranks selection order until the account is spent:
    // persisted here rather than in resetCodexRoutingForManualSelection, which is
    // runtime state only. A null id clears the selection instead of making one, so it
    // must release the pin rather than record one: pinning the `targetAccountId`
    // fallback would leave a pin that no effective active account matches, which
    // `isEffectiveCodexAccountPinned` reports as unpinned while the tier filter still
    // honours it as a ceiling — invisibly capping the pool at the main account's tier.
    if (body.accountId == null) clearCodexAccountPin(runtimeConfig);
    else setCodexAccountPin(runtimeConfig, targetAccountId);
    resetCodexRoutingForManualSelection(targetAccountId);
    saveRuntimeConfig(config, runtimeConfig);
    return jsonResponse({ ok: true, activeCodexAccountId: body.accountId, appliesImmediately: true });
  }

  if (url.pathname === "/api/codex-auth/active" && req.method === "GET") {
    const runtimeConfig = getRuntimeConfig(config);
    return jsonResponse({
      activeCodexAccountId: getEffectiveActiveCodexAccountId(runtimeConfig) ?? null,
      pinned: isEffectiveCodexAccountPinned(runtimeConfig),
      // Which account carries the pin, not just whether the active one does. Under
      // round-robin or fill-first the pin caps the tier ceiling at its own tier while the
      // strategy cursor moves freely inside that tier, so `pinned` alone goes false on a
      // sibling's turn even though the pin is still suppressing every higher tier. The id
      // lets a surface mark the account the operator actually chose.
      pinnedAccountId: pinnedCodexAccountId(runtimeConfig) ?? null,
      autoSwitchThreshold: runtimeConfig.autoSwitchThreshold ?? 80,
      upstreamFailoverThreshold: runtimeConfig.upstreamFailoverThreshold ?? 3,
      accountPoolStrategy: normalizeAccountPoolStrategy(runtimeConfig.accountPoolStrategy),
      accountPoolStickyLimit: normalizeAccountPoolStickyLimit(runtimeConfig.accountPoolStickyLimit),
    });
  }

  if (url.pathname === "/api/codex-auth/auto-switch" && req.method === "PUT") {
    let body: { threshold: number };
    try { body = (await req.json()) as typeof body; } catch { return jsonResponse({ error: "Invalid JSON" }, 400); }
    if (typeof body.threshold !== "number" || !Number.isInteger(body.threshold) || body.threshold < 0 || body.threshold > 100) {
      return jsonResponse({ error: "Threshold must be an integer 0-100" }, 400);
    }
    const runtimeConfig = getRuntimeConfig(config);
    runtimeConfig.autoSwitchThreshold = body.threshold;
    saveRuntimeConfig(config, runtimeConfig);
    return jsonResponse({ ok: true });
  }

  if (
    url.pathname === "/api/codex-auth/pool-strategy"
    && (req.method === "PUT" || req.method === "PATCH")
  ) {
    let parsedBody: unknown;
    try { parsedBody = await req.json(); } catch { return jsonResponse({ error: "Invalid JSON" }, 400); }
    if (typeof parsedBody !== "object" || parsedBody === null || Array.isArray(parsedBody)) {
      return jsonResponse({ error: "body must be an object" }, 400);
    }
    const body = parsedBody as { strategy?: unknown; stickyLimit?: unknown };
    if (body.strategy === undefined && body.stickyLimit === undefined) {
      return jsonResponse({ error: "strategy or stickyLimit required" }, 400);
    }
    const runtimeConfig = getRuntimeConfig(config);
    let nextStrategy: NonNullable<ReturnType<typeof parseAccountPoolStrategy>> | undefined;
    let nextSticky: NonNullable<ReturnType<typeof parseAccountPoolStickyLimit>> | undefined;
    if (body.strategy !== undefined) {
      const parsed = parseAccountPoolStrategy(body.strategy);
      if (parsed === null) {
        return jsonResponse({ error: 'strategy must be one of: quota, round-robin, fill-first' }, 400);
      }
      nextStrategy = parsed;
    }
    if (body.stickyLimit !== undefined) {
      const parsed = parseAccountPoolStickyLimit(body.stickyLimit);
      if (parsed === null) {
        return jsonResponse({ error: "stickyLimit must be an integer 1-100" }, 400);
      }
      nextSticky = parsed;
    }
    if (nextStrategy !== undefined) runtimeConfig.accountPoolStrategy = nextStrategy;
    if (nextSticky !== undefined) runtimeConfig.accountPoolStickyLimit = nextSticky;
    saveRuntimeConfig(config, runtimeConfig);
    return jsonResponse({
      ok: true,
      accountPoolStrategy: normalizeAccountPoolStrategy(runtimeConfig.accountPoolStrategy),
      accountPoolStickyLimit: normalizeAccountPoolStickyLimit(runtimeConfig.accountPoolStickyLimit),
    });
  }

  if (url.pathname === "/api/codex-auth/failover" && req.method === "PUT") {
    let body: { threshold: number };
    try { body = (await req.json()) as typeof body; } catch { return jsonResponse({ error: "Invalid JSON" }, 400); }
    if (typeof body.threshold !== "number" || !Number.isInteger(body.threshold) || body.threshold < 0 || body.threshold > 20) {
      return jsonResponse({ error: "Threshold must be an integer 0-20" }, 400);
    }
    const runtimeConfig = getRuntimeConfig(config);
    runtimeConfig.upstreamFailoverThreshold = body.threshold;
    saveRuntimeConfig(config, runtimeConfig);
    return jsonResponse({ ok: true });
  }

  if (url.pathname === "/api/codex-auth/quota" && req.method === "GET") {
    const quotas: Record<string, unknown> = {};
    for (const [id, q] of listAccountQuotas()) quotas[id] = q;
    return jsonResponse({ quotas });
  }

  if (url.pathname === "/api/codex-auth/reset-credits" && req.method === "GET") {
    const accountId = url.searchParams.get("accountId");
    if (!accountId) return jsonResponse({ error: "accountId required" }, 400);

    try {
      const result = await withResetCreditAuth(getRuntimeConfig(config), accountId, async auth => {
        const linkedSignal = signalWithTimeout(8000, req.signal);
        let detachBodyAbort = () => {};
        try {
          let resp: Response;
          try {
            resp = await fetch(
              "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits",
              {
                headers: {
                  Authorization: `Bearer ${auth.accessToken}`,
                  "ChatGPT-Account-Id": auth.chatgptAccountId,
                },
                signal: linkedSignal.signal,
              },
            );
          } catch (error) {
            if (linkedSignal.signal.aborted) {
              return jsonResponse({ error: "Invalid upstream reset-credit response" }, 502);
            }
            throw error;
          }
          // Own the response body before the bounded reader attaches. If the client
          // disconnects in that narrow window, Bun otherwise tears down the native
          // body off the awaited path and can report an unhandled rejection.
          detachBodyAbort = cancelBodyOnAbort(resp.body, linkedSignal.signal);
          if (!resp.ok) {
            await resp.body?.cancel().catch(() => {});
            return jsonResponse({ error: `Upstream error ${resp.status}` }, resp.status);
          }
          const parsed = await readResetCreditJson(resp, linkedSignal.signal);
          if (!parsed.ok) {
            return jsonResponse({ error: "Invalid upstream reset-credit response" }, 502);
          }
          return jsonResponse(safeResetCreditsDto(parsed.value));
        } finally {
          detachBodyAbort();
          linkedSignal.cleanup();
        }
      });
      return result.ok ? result.value : result.response;
    } catch (e) {
      return jsonResponse({ error: e instanceof Error ? e.message : "Reset credit lookup failed" }, 500);
    }
  }

  if (url.pathname === "/api/codex-auth/reset-credits/consume" && req.method === "POST") {
    const body = (await req.json().catch(() => ({}))) as { accountId?: string };
    if (!body.accountId) return jsonResponse({ error: "accountId required" }, 400);
    const accountId = body.accountId;

    try {
      const operation = await withResetCreditAuth(getRuntimeConfig(config), accountId, async auth => {
        const idempotencyKey = crypto.randomUUID();
        const resp = await fetch(
          "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits/consume",
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${auth.accessToken}`,
              "ChatGPT-Account-Id": auth.chatgptAccountId,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ redeem_request_id: idempotencyKey }),
            signal: AbortSignal.timeout(10_000),
          },
        );
        if (!resp.ok) {
          await resp.body?.cancel().catch(() => {});
          return jsonResponse({ error: `Upstream error ${resp.status}` }, resp.status);
        }
        const result = safeResetCreditConsumeDto(await resp.json());
        // After a successful redeem (or an idempotent already_redeemed), refresh WHAM usage
        // and return remaining only when that refresh freshly parsed available_count.
        // Do not fall back to a preserved cached resetCredits (failed/omitted refresh).
        if (result.code === "reset" || result.code === "already_redeemed") {
          let freshResetCredits: number | undefined;
          if (auth.isMain) {
            ({ freshResetCredits } = await fetchMainAccountInfoAttempt(
              true,
              1,
              auth.nativeMainLease,
              auth.nativeMainSharedClaimHeld === true,
            ));
          } else {
            const account = configuredPoolAccount(getRuntimeConfig(config), accountId);
            ({ freshResetCredits } = await fetchPoolAccountQuota(accountId, true, account?.plan));
          }
          return jsonResponse({
            code: result.code,
            ...(typeof freshResetCredits === "number" && Number.isFinite(freshResetCredits)
              ? { remaining: freshResetCredits }
              : {}),
          });
        }
        return jsonResponse(result);
      });
      return operation.ok ? operation.value : operation.response;
    } catch (e) {
      if (e instanceof PoolQuotaProbeBusyError) {
        const response = jsonResponse({ error: "server_busy", code: "server_busy" }, 503);
        response.headers.set("Retry-After", "1");
        return response;
      }
      return jsonResponse({ error: e instanceof Error ? e.message : "Reset credit consume failed" }, 500);
    }
  }

  if (url.pathname === "/api/codex-auth/login" && req.method === "POST") {
    const body = (await req.json().catch(() => ({}))) as { id?: string; reauth?: boolean; openBrowser?: unknown };
    const requestedAccountId = body.id?.trim();
    const reauth = body.reauth === true;
    if (requestedAccountId && !isValidCodexAccountId(requestedAccountId)) {
      return jsonResponse({ error: "Invalid account id format" }, 400);
    }
    const accountId = requestedAccountId || `chatgpt-${Date.now()}`;
    const runtimeConfig = getRuntimeConfig(config);
    const preflightConflict = !reauth
      ? codexAccountPersistenceConflict(runtimeConfig, accountId, "create")
      : undefined;
    if (preflightConflict) return jsonResponse({ error: preflightConflict }, 400);
    if (reauth) {
      if (!requestedAccountId) return jsonResponse({ error: "id required for reauth" }, 400);
      if (!configuredPoolAccount(runtimeConfig, accountId)) {
        return jsonResponse({ error: "Unknown pool account for reauth" }, 404);
      }
    }
    pruneCodexLoginState();
    if (codexAuthLoginState.size >= MAX_CODEX_LOGIN_STATE_ROWS) {
      const busy = new CodexLoginStateBusyError();
      const response = jsonResponse({ error: busy.message, code: busy.code }, 503);
      response.headers.set("Retry-After", "1");
      return response;
    }
    const flowId = `flow-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const loginOwner: CodexLoginStateRow = { status: "starting", startedAt: Date.now() };
    codexAuthLoginState.set(flowId, loginOwner);
    try {
      const { startLoginFlow, getLoginStatus, publicOAuthAuthenticationErrorMessage } = await import("../oauth");
      const result = await startLoginFlow("chatgpt", { forceLogin: true });

      // Open the browser server-side (same pattern as /api/oauth/login in management-api.ts).
      // The GUI's window.open is popup-blocked because it runs after an await, not a direct click.
      // Both login routes share one resolver so this surface cannot drift from the other.
      const { shouldOpenBrowserForLogin } = await import("../oauth/open-browser-choice");
      if (result.url && shouldOpenBrowserForLogin(body.openBrowser, runtimeConfig)) {
        const { openUrl } = await import("../lib/open-url");
        openUrl(result.url);
      }

      (async () => {
        try {
          let completed = false;
          for (let i = 0; i < 150; i++) {
            await new Promise(r => setTimeout(r, 2000));
            const st = getLoginStatus("chatgpt");
            if (st.done && st.loggedIn) {
              const { getCredential } = await import("../oauth/store");
              const cred = getCredential("chatgpt");
              if (cred) {
                const oauthAccountId = cred.accountId;
                if (!oauthAccountId) {
                  setCodexLoginState(flowId, {
                    status: "error",
                    error: "Could not determine account identity from OAuth tokens. Please retry OAuth login.",
                    doneAt: Date.now(),
                  });
                  completed = true;
                  break;
                }

                let email = cred.email || accountId;
                let plan: string | undefined;
                let quota: Omit<StoredAccountQuota, "updatedAt"> | null = null;
                try {
                  const tokens = { access_token: cred.access, account_id: oauthAccountId };
                  const resp = await fetch("https://chatgpt.com/backend-api/wham/usage", {
                    headers: { Authorization: `Bearer ${tokens.access_token}`, "ChatGPT-Account-Id": tokens.account_id },
                    signal: AbortSignal.timeout(8000),
                  });
                  if (resp.ok) {
                    const data = (await resp.json()) as WhamUsageResponse;
                    email = data.email ?? email;
                    plan = nonEmptyPlan(data.plan_type) ?? undefined;
                    quota = parseUsageQuota(data);
                  }
                } catch { /* wham fetch is non-blocking */ }
                // Reauth must refresh the same ChatGPT identity already bound to this pool slot.
                // Otherwise a different login would silently overwrite credentials under a trusted id.
                if (reauth) {
                  const existingCred = getCodexAccountCredential(accountId);
                  const poolAccount = configuredPoolAccount(getRuntimeConfig(config), accountId);
                  const expectedChatgptId = existingCred?.chatgptAccountId?.trim();
                  const expectedEmail = poolAccount?.email?.trim().toLowerCase();
                  const gotEmail = email.trim().toLowerCase();
                  if (expectedChatgptId) {
                    if (expectedChatgptId !== oauthAccountId) {
                      setCodexLoginState(flowId, {
                        status: "error",
                        error: "Signed-in ChatGPT account does not match this pool account. Sign in with the same account, or remove it and add a new one.",
                        doneAt: Date.now(),
                      });
                      completed = true;
                      break;
                    }
                  } else if (expectedEmail) {
                    if (!gotEmail || gotEmail !== expectedEmail) {
                      setCodexLoginState(flowId, {
                        status: "error",
                        error: "Signed-in ChatGPT account does not match this pool account. Sign in with the same account, or remove it and add a new one.",
                        doneAt: Date.now(),
                      });
                      completed = true;
                      break;
                    }
                  } else {
                    // No chatgptAccountId and no pool email — refuse silent identity replacement
                    // (including empty credential slots that still have a pool row).
                    setCodexLoginState(flowId, {
                      status: "error",
                      error: "Cannot verify account identity for reauth. Remove this account and add it again.",
                      doneAt: Date.now(),
                    });
                    completed = true;
                    break;
                  }
                }

                // 1.2: Duplicate check is scoped by personal vs workspace plan bucket.
                const collision = checkAccountIdCollision(oauthAccountId, email, plan, reauth ? accountId : undefined);
                if (collision.collision) {
                  setCodexLoginState(flowId, {
                    status: "error", error: collision.reason, doneAt: Date.now(),
                  });
                  completed = true;
                  break;
                }

                const warmup = await verifyCodexAccountWarmup(accountId, cred.access, oauthAccountId);
                if (!warmup.ok) {
                  const body = await warmup.response.json().catch(() => ({})) as { error?: string; reason?: string };
                  setCodexLoginState(flowId, {
                    status: "error",
                    error: body.reason ? `${body.error ?? "Codex account warmup failed"} (${body.reason})` : body.error ?? "Codex account warmup failed",
                    doneAt: Date.now(),
                  });
                  completed = true;
                  break;
                }

                const latestConfig = getRuntimeConfig(config);
                const accounts = latestConfig.codexAccounts ?? [];
                const existingIdx = accounts.findIndex(account => account.id === accountId);
                let pickerVisibilityChanged = false;
                let newAccountPersistence: PersistNewCodexAccountOutcome | null = null;
                const commitConflict = codexAccountPersistenceConflict(
                  latestConfig,
                  accountId,
                  reauth ? "reauth" : "create",
                );
                if (commitConflict) {
                  setCodexLoginState(flowId, {
                    status: "error",
                    error: commitConflict,
                    doneAt: Date.now(),
                  });
                  completed = true;
                  break;
                }

                const credential: CodexAccountCredentials = {
                  accessToken: cred.access,
                  refreshToken: cred.refresh,
                  expiresAt: cred.expires,
                  chatgptAccountId: oauthAccountId,
                };

                if (existingIdx >= 0) {
                  saveCodexAccountCredential(accountId, credential);
                  // A successful reauthentication replaces the credential generation. Do not let a
                  // failed optional WHAM probe make the replacement inherit quota from the old record.
                  if (reauth) clearAccountQuota(accountId);
                  markCodexAccountValidated(accountId, warmup.validatedAt);
                  clearAccountNeedsReauth(accountId);
                  if (quota) setAccountQuotaFromParsed(accountId, quota);
                  // Keep the pool id stable; refresh display metadata after a successful login/reauth.
                  accounts[existingIdx] = withCodexAccountLogLabel({
                    ...accounts[existingIdx],
                    email,
                    plan: plan ?? accounts[existingIdx].plan,
                    isMain: false,
                  }, accounts);
                  latestConfig.codexAccounts = accounts;
                  saveRuntimeConfig(config, latestConfig);
                } else {
                  const addedAccount = withCodexAccountLogLabel({ id: accountId, email, plan, isMain: false }, accounts);
                  newAccountPersistence = persistNewCodexAccount(
                    config,
                    latestConfig,
                    addedAccount,
                    {
                      credential,
                      validatedAt: warmup.validatedAt,
                    },
                  );
                  pickerVisibilityChanged = newAccountPersistence.pickerVisibilityChanged;
                }
                reconcileLiveStateStores();
                if (newAccountPersistence?.status === "publication-failed") {
                  markAccountNeedsReauth(accountId);
                }
                // A new quota row is generation-gated by live account ownership. Reconcile the
                // durable config owner first so a partial prior sweep cannot reject this write.
                if (newAccountPersistence?.status === "committed" && quota) {
                  setAccountQuotaFromParsed(accountId, quota);
                }
                const { catalogRefreshPending } = await convergeAccountNamespaceCatalog(
                  latestConfig,
                  pickerVisibilityChanged,
                  convergeCodexCatalog,
                );
                if (newAccountPersistence?.status === "publication-failed") {
                  setCodexLoginState(flowId, {
                    status: "error",
                    ...codexCredentialPersistenceFailure(accountId, catalogRefreshPending),
                    doneAt: Date.now(),
                  });
                  completed = true;
                } else {
                  setCodexLoginState(flowId, {
                    status: "done",
                    accountId,
                    email,
                    ...(catalogRefreshPending ? { catalogRefreshPending: true } : {}),
                    doneAt: Date.now(),
                  });
                  completed = true;
                }
              }
              break;
            }
            if (st.done && st.error) {
              setCodexLoginState(flowId, {
                status: "error",
                // startLoginFlow projects background failures before storing login status, so
                // fixed actionable OAuth messages retain their type-derived remediation here.
                error: st.error,
                doneAt: Date.now(),
              });
              completed = true;
              break;
            }
          }
          if (!completed) {
            setCodexLoginState(flowId, {
              status: "error",
              error: "Login timed out before OAuth completed.",
              doneAt: Date.now(),
            });
          }
        } catch (error) {
          const message = error instanceof ConfigMutationLockError
            || error instanceof CodexCredentialRefreshLockTimeoutError
            ? "Configuration is busy; retry login shortly."
            : error instanceof CodexCredentialRefreshBusyError || error instanceof CodexCredentialRefreshStaleError
              ? "Credential refresh is busy; retry login shortly."
            : publicOAuthAuthenticationErrorMessage(error);
          setCodexLoginState(flowId, {
            status: "error",
            error: message,
            doneAt: Date.now(),
          });
        } finally {
          // TTL: keep completed flow state available for clients that miss a short polling window.
          setTimeout(() => { if (codexAuthLoginState.get(flowId) === loginOwner) codexAuthLoginState.delete(flowId); }, CODEX_LOGIN_TERMINAL_TTL_MS);
        }
      })();

      setCodexLoginState(flowId, { status: "pending" });
      return jsonResponse({ ok: true, flowId, url: result.url, instructions: result.instructions });
    } catch (e) {
      if (codexAuthLoginState.get(flowId) === loginOwner) codexAuthLoginState.delete(flowId);
      const msg = e instanceof Error ? e.message : String(e);
      if (msg === "A login for chatgpt is already in progress") {
        return jsonResponse({ error: msg, status: "pending" }, 409);
      }
      if (e instanceof CodexCredentialRefreshBusyError || e instanceof CodexCredentialRefreshStaleError) {
        const response = jsonResponse({ error: "server_busy", code: "server_busy" }, 503);
        response.headers.set("Retry-After", "1");
        return response;
      }
      const { publicOAuthAuthenticationErrorMessage } = await import("../oauth");
      return jsonResponse({ error: publicOAuthAuthenticationErrorMessage(e) }, 500);
    }
  }

  if (url.pathname === "/api/codex-auth/login/code" && req.method === "POST") {
    const body = (await req.json().catch(() => ({}))) as { flowId?: unknown; input?: unknown };
    const flowId = typeof body.flowId === "string" ? body.flowId.trim() : "";
    const input = typeof body.input === "string" ? body.input : "";
    if (!flowId) return jsonResponse({ error: "flowId required" }, 400);
    if (input.length > 4096) return jsonResponse({ error: "input too long" }, 400);

    // Import may yield; validate afterwards so cancel/replace cannot race a stale flow through.
    const { submitManualLoginCode } = await import("../oauth");
    const flow = codexAuthLoginState.get(flowId);
    if (!flow) return jsonResponse({ error: "login flow expired or unknown" }, 400);
    if (flow.status !== "pending") return jsonResponse({ error: "login flow is not pending" }, 400);

    const result = submitManualLoginCode("chatgpt", input);
    if (!result.ok) return jsonResponse({ error: result.error }, 400);
    return jsonResponse({ ok: true }, 202);
  }

  if (url.pathname === "/api/codex-auth/login/cancel" && req.method === "POST") {
    const body = (await req.json().catch(() => ({}))) as { flowId?: string };
    const { cancelLoginFlow } = await import("../oauth");
    const cancelled = cancelLoginFlow("chatgpt");
    expireCodexAuthFlow(body.flowId ?? null);
    return jsonResponse({ ok: true, cancelled });
  }

  if (url.pathname === "/api/codex-auth/login-status" && req.method === "GET") {
    const flowId = url.searchParams.get("flowId");
    const accountId = url.searchParams.get("accountId")?.trim();
    // Reauth always has a pre-existing credential; never treat "credential exists" as success
    // when the flow map entry is gone (would false-complete on lost/expired flow state).
    const reauthStatus = url.searchParams.get("reauth") === "1";
    if (flowId) {
      const st = codexAuthLoginState.get(flowId);
      if (
        !st
        && accountId
        && !reauthStatus
        && !isAccountNeedsReauth(accountId)
        && getCodexAccountCredential(accountId)
      ) {
        return jsonResponse({ status: "done", accountId });
      }
      return jsonResponse(st ? { ...st, email: maskEmail(st.email) ?? undefined } : { status: "expired" });
    }
    // Legacy fallback: return latest pending flow
    for (const [, st] of codexAuthLoginState) {
      if (st.status === "pending") return jsonResponse({ ...st, email: maskEmail(st.email) ?? undefined });
    }
    return jsonResponse({ status: "idle" });
  }

  return null;
}
