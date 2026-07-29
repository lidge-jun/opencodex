import { loadConfig, saveConfigPreservingClaudeCode } from "../config";
import { withCodexAccountLogLabel } from "./account-label";
import {
  getCodexAccountCredential,
  getValidCodexToken,
  isCodexAccountGenerationLive,
  markCodexAccountValidated,
  saveCodexAccountCredential,
  CodexCredentialGenerationConflictError,
  CodexCredentialRefreshLockTimeoutError,
  TokenRefreshError,
} from "./account-store";
import { deleteCodexAccount, reconcileMainCodexAccountRuntimeState } from "./account-lifecycle";
import { isCodexAccountPaused, setCodexAccountPaused } from "./account-pause";
import {
  clearCodexAccountCooldown,
  clearThreadAccountMapForAccount,
  getEffectiveActiveCodexAccountId,
  reconcileCodexActiveAfterExclusion,
  resetCodexRoutingForManualSelection,
} from "./routing";
import {
  normalizeAccountPoolStickyLimit,
  normalizeAccountPoolStrategy,
  parseAccountPoolStickyLimit,
  parseAccountPoolStrategy,
} from "./pool-rotation";
import { checkAccountIdCollision, getMainChatgptAccountId, readCodexTokens, readCodexTokensResult } from "./auth-collision";
export { checkAccountIdCollision, getMainChatgptAccountId } from "./auth-collision";
export { clearAccountNeedsReauth, isAccountNeedsReauth, markAccountNeedsReauth } from "./account-runtime-state";
import { clearAccountNeedsReauth, isAccountNeedsReauth, markAccountNeedsReauth } from "./account-runtime-state";
import {
  clearAccountQuota,
  getAccountQuota,
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
import { extractAccountId, decodeJwtPayload } from "../oauth/chatgpt";
import { getMainAccountPlan, MAIN_CODEX_ACCOUNT_ID, setMainAccountPlan } from "./main-account";
import {
  clearMainAccountInfoCache,
  getMainAccountInfoCache,
  setMainAccountInfoCache,
  type MainAccountInfo,
} from "./main-account-cache";
export { clearMainAccountInfoCache } from "./main-account-cache";
import { maskEmail } from "../lib/privacy";
import { CodexWarmupError, codexWarmupFailureReason, warmCodexAccount } from "./warmup";
export { maskEmail } from "../lib/privacy";
import type { CodexAccount, OcxConfig } from "../types";
import { isCanonicalOpenAiForwardProvider, OPENAI_CODEX_PROVIDER_ID } from "../providers/openai-tiers";
import { providerCodexAccountMode } from "../providers/registry";
import { readBoundedResponseBody } from "../lib/bounded-body";
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

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const MANUAL_IMPORT_ENV = "OPENCODEX_ENABLE_UNVERIFIED_CODEX_IMPORT";

const codexAuthLoginState = new Map<string, { status: string; accountId?: string; email?: string; error?: string; doneAt?: number }>();

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

function isThirtyDayOnlyPlan(plan: string | null | undefined): boolean {
  const normalized = plan?.trim().toLowerCase();
  return normalized === "go" || normalized === "free";
}

function quotaForPlan<T extends Omit<StoredAccountQuota, "updatedAt"> | StoredAccountQuota | null>(
  quota: T,
  plan: string | null | undefined,
): T {
  if (!quota || !isThirtyDayOnlyPlan(plan)) return quota;
  return {
    ...(quota.monthlyPercent !== undefined ? { monthlyPercent: quota.monthlyPercent } : {}),
    ...(quota.monthlyResetAt !== undefined ? { monthlyResetAt: quota.monthlyResetAt } : {}),
    ...(quota.resetCredits !== undefined ? { resetCredits: quota.resetCredits } : {}),
    ...("updatedAt" in quota ? { updatedAt: quota.updatedAt } : {}),
  } as T;
}

function poolAccountDto(
  account: CodexAccount,
  quotaResult: PoolQuotaResult,
  hasCredential: boolean,
  paused: boolean,
): CodexAuthAccountDto {
  const quota = quotaForPlan(quotaResult.quota, account.plan);
  const needsReauth = !hasCredential || quotaResult.needsReauth || isAccountNeedsReauth(account.id);
  const health = projectCodexAccountHealth({ accountId: account.id, needsReauth });
  return {
    id: account.id,
    email: maskEmail(account.email) ?? account.email,
    ...(account.alias !== undefined ? { alias: account.alias } : {}),
    ...(account.plan !== undefined ? { plan: account.plan } : {}),
    ...(account.logLabel !== undefined ? { logLabel: account.logLabel } : {}),
    isMain: false,
    paused,
    quota: quota ? { ...quota } : null,
    needsReauth,
    hasCredential,
    ...oauthAccountHealthFields("codex", account.id, health),
  };
}

async function resolveResetCreditAuth(
  runtimeConfig: OcxConfig,
  accountId: string,
): Promise<
  | { ok: true; isMain: boolean; accessToken: string; chatgptAccountId: string }
  | { ok: false; response: Response }
> {
  if (accountId === MAIN_CODEX_ACCOUNT_ID) {
    if (hasLegacyMainCodexPoolAccount(runtimeConfig.codexAccounts)) {
      return { ok: false, response: jsonResponse({ error: "Remove the legacy __main__ pool row before using the Desktop account" }, 409) };
    }
    const tokens = readCodexTokens();
    if (!tokens) return { ok: false, response: jsonResponse({ error: "Main Codex account not logged in" }, 401) };
    return { ok: true, isMain: true, accessToken: tokens.access_token, chatgptAccountId: tokens.account_id };
  }
  if (!isValidCodexAccountId(accountId)) {
    return { ok: false, response: jsonResponse({ error: "Invalid account id format" }, 400) };
  }
  if (!configuredPoolAccount(runtimeConfig, accountId)) {
    return { ok: false, response: jsonResponse({ error: "Unknown Codex account" }, 404) };
  }
  const cred = await getValidCodexToken(accountId);
  return { ok: true, isMain: false, accessToken: cred.accessToken, chatgptAccountId: cred.chatgptAccountId };
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

export function isUnverifiedCodexImportEnabled(): boolean {
  return process.env[MANUAL_IMPORT_ENV] === "1";
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
    const upstream = err instanceof CodexWarmupError ? err.upstreamDetail : undefined;
    return {
      ok: false,
      response: jsonResponse({
        error: upstream
          ? `Codex account warmup failed: ${upstream}`
          : "Codex account warmup failed. Reauthenticate the account and try again.",
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
    codexAuthLoginState.set(id, { status: "error", error, doneAt: Date.now() });
    setTimeout(() => codexAuthLoginState.delete(id), 30_000);
  }
}

const MAIN_CACHE_TTL = 5 * 60_000;
const POOL_CACHE_TTL = 5 * 60_000;
const POOL_QUOTA_REFRESH_CONCURRENCY = 4;

function nonEmptyPlan(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
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

async function isTerminalMainAuthResponse(resp: Response): Promise<boolean> {
  if (resp.status === 401) return true;
  if (resp.status !== 403) return false;
  try {
    const body = await readBoundedResponseBody(resp, { totalTimeoutMs: 1_000, inactivityTimeoutMs: 1_000 });
    if (!body.displaySafe) return false;
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
    return typeof code === "string" && MAIN_TERMINAL_AUTH_CODES.has(code);
  } catch {
    return false;
  }
}

interface MainAccountInfoFetchResult {
  info: MainAccountInfo;
  /** Present only when this call freshly parsed a WHAM usage response. */
  freshQuota?: Omit<StoredAccountQuota, "updatedAt">;
  /** Present only when this call's WHAM response included `rate_limit_reset_credits.available_count`. */
  freshResetCredits?: number;
}

export async function fetchMainAccountInfo(forceRefresh = false): Promise<MainAccountInfo> {
  const { info } = await fetchMainAccountInfoAttempt(forceRefresh, 1);
  return info;
}

const EMPTY_MAIN_ACCOUNT_INFO: MainAccountInfo = { email: null, plan: null, quota: null };

async function retryMainAccountInfoIfIdentityChanged(
  requestAccountId: string | null,
  retriesRemaining: number,
): Promise<MainAccountInfoFetchResult | null> {
  const currentAccountId = getMainChatgptAccountId();
  if (currentAccountId === null || currentAccountId === requestAccountId) return null;
  reconcileMainCodexAccountRuntimeState();
  return retriesRemaining > 0
    ? fetchMainAccountInfoAttempt(true, retriesRemaining - 1)
    : { info: EMPTY_MAIN_ACCOUNT_INFO };
}

async function fetchMainAccountInfoAttempt(forceRefresh: boolean, retriesRemaining: number): Promise<MainAccountInfoFetchResult> {
  reconcileMainCodexAccountRuntimeState();
  const tokenRead = readCodexTokensResult();
  if (tokenRead.status !== "ok") {
    // A local read failure is NOT proof of sign-out: a missing file can be a non-atomic rewrite
    // gap, and malformed JSON can be a half-written file. Clearing the cache and marking the
    // account for reauth here destroyed healthy email/plan/quota state and pinned a working
    // account as unusable. Preserve what we already know and let the caller retry; request
    // routing stays fail-closed because getMainAccountToken() re-reads the file itself, and the
    // account DTO still reports hasCredential=false while the file is unreadable.
    const preserved = getMainAccountInfoCache();
    return { info: preserved ?? EMPTY_MAIN_ACCOUNT_INFO };
  }
  const tokens = tokenRead.tokens;
  const requestAccountId = extractAccountId(tokens.id_token, tokens.access_token) ?? (tokens.account_id || null);
  const cached = getMainAccountInfoCache();
  if (!forceRefresh && cached && Date.now() - cached.ts < MAIN_CACHE_TTL) {
    return { info: cached };
  }
  try {
    const resp = await fetch("https://chatgpt.com/backend-api/wham/usage", {
      headers: { Authorization: `Bearer ${tokens.access_token}`, "ChatGPT-Account-Id": tokens.account_id },
      signal: AbortSignal.timeout(8000),
    });
    if (!resp.ok) {
      const terminalAuthFailure = await isTerminalMainAuthResponse(resp);
      const retried = await retryMainAccountInfoIfIdentityChanged(requestAccountId, retriesRemaining);
      if (retried) return retried;
      if (terminalAuthFailure) {
        clearMainAccountInfoCache();
        markAccountNeedsReauth(MAIN_CODEX_ACCOUNT_ID);
      }
      return { info: EMPTY_MAIN_ACCOUNT_INFO };
    }
    const data = (await resp.json()) as WhamUsageResponse;
    const retried = await retryMainAccountInfoIfIdentityChanged(requestAccountId, retriesRemaining);
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
    clearAccountNeedsReauth(MAIN_CODEX_ACCOUNT_ID);
    // Mirror main quota + plan into the shared stores so the rotation engine can
    // score and auto-switch the main account exactly like a pool account (Option A).
    setMainAccountPlan(result.plan);
    if (result.quota) {
      setAccountQuotaFromParsed(MAIN_CODEX_ACCOUNT_ID, result.quota);
    }
    return {
      info: result,
      ...(quota ? { freshQuota: quota } : {}),
      ...(freshResetCredits !== undefined ? { freshResetCredits } : {}),
    };
  } catch {
    const retried = await retryMainAccountInfoIfIdentityChanged(requestAccountId, retriesRemaining);
    return retried ?? { info: EMPTY_MAIN_ACCOUNT_INFO };
  }
}

interface PoolQuotaResult {
  quota: StoredAccountQuota | null;
  needsReauth: boolean;
  /** Present only when this call freshly parsed a WHAM usage response. */
  freshQuota?: Omit<StoredAccountQuota, "updatedAt">;
  /** Present only when this call's WHAM response included a non-empty `plan_type`. */
  freshPlan?: string;
  /** Credential generation used by this fresh quota request. */
  freshCredentialGeneration?: number;
  /** Present only when this call's WHAM response included `rate_limit_reset_credits.available_count`. */
  freshResetCredits?: number;
}

export interface CodexAuthAccountDto {
  id: string;
  alias?: string;
  email: string;
  plan?: string | null;
  logLabel?: string;
  isMain: boolean;
  paused: boolean;
  quota: (StoredAccountQuota | (Omit<StoredAccountQuota, "updatedAt"> & { updatedAt: number })) | null;
  needsReauth?: boolean;
  hasCredential: boolean;
  health: OAuthAccountHealth;
  healthLabel: OAuthHealthLabel;
  healthSummary: string;
  healthAction?: string;
}

async function fetchPoolAccountQuota(accountId: string, forceRefresh = false, configuredPlan?: string): Promise<PoolQuotaResult> {
  const existing = getAccountQuota(accountId);
  if (!forceRefresh && existing && Date.now() - existing.updatedAt < POOL_CACHE_TTL) {
    return { quota: existing, needsReauth: false };
  }
  try {
    const { accessToken, chatgptAccountId, generation } = await getValidCodexToken(accountId);
    const resp = await fetch("https://chatgpt.com/backend-api/wham/usage", {
      headers: { Authorization: `Bearer ${accessToken}`, "ChatGPT-Account-Id": chatgptAccountId },
      signal: AbortSignal.timeout(8000),
    });
    if (!resp.ok) return { quota: existing ?? null, needsReauth: resp.status === 401 };
    const data = (await resp.json()) as WhamUsageResponse;
    const freshPlan = nonEmptyPlan(data.plan_type) ?? undefined;
    const quota = parseUsageQuota({ ...data, plan_type: freshPlan ?? configuredPlan });
    const freshResetCredits = quota?.resetCredits;
    if (!quota) return { quota: existing ?? null, needsReauth: false };
    if (!isCodexAccountGenerationLive(accountId, generation)) {
      return { quota: getAccountQuota(accountId), needsReauth: false };
    }
    setAccountQuotaFromParsed(accountId, quota);
    return {
      quota: getAccountQuota(accountId),
      needsReauth: false,
      freshQuota: quota,
      freshCredentialGeneration: generation,
      ...(freshPlan !== undefined ? { freshPlan } : {}),
      ...(freshResetCredits !== undefined ? { freshResetCredits } : {}),
    };
  } catch (e) {
    if (e instanceof CodexCredentialGenerationConflictError || e instanceof CodexCredentialRefreshLockTimeoutError) return { quota: existing ?? null, needsReauth: false };
    if (e instanceof TokenRefreshError) return { quota: existing ?? null, needsReauth: true };
    return { quota: existing ?? null, needsReauth: false };
  }
}

let primeInFlight: Promise<void> | null = null;

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
export async function primeCodexPoolQuotas(config: OcxConfig, reason: string): Promise<void> {
  const openai = config.providers[OPENAI_CODEX_PROVIDER_ID];
  if (
    !openai
    || openai.disabled === true
    || !isCanonicalOpenAiForwardProvider(openai)
    || providerCodexAccountMode(OPENAI_CODEX_PROVIDER_ID, openai) !== "pool"
  ) return;
  if (primeInFlight) return primeInFlight;
  // Seed the observed physical main identity before startup/lazy priming can populate quota or
  // plan state. Otherwise the first post-startup account switch sees no previous identity and
  // skips the purge that protects the stable __main__ alias.
  reconcileMainCodexAccountRuntimeState();
  primeInFlight = (async () => {
    const runtimeConfig = getRuntimeConfig(config);
    const pool = (runtimeConfig.codexAccounts ?? []).filter(isSelectableCodexPoolAccount);
    const stale = pool.filter(a => {
      const q = getAccountQuota(a.id);
      return !q || Date.now() - q.updatedAt >= POOL_CACHE_TTL;
    });
    const primeMain = !!readCodexTokens() && !getAccountQuota(MAIN_CODEX_ACCOUNT_ID);
    try {
      await Promise.allSettled([
        primeMain ? fetchMainAccountInfo(false) : Promise.resolve(),
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

export async function listCodexAuthAccounts(config: OcxConfig, forceRefresh = false): Promise<CodexAuthAccountDto[]> {
  const runtimeConfig = getRuntimeConfig(config);
  const poolAccounts = (runtimeConfig.codexAccounts ?? []).filter(isSelectableCodexPoolAccount);
  const mainInfo = await fetchMainAccountInfo(forceRefresh);
  const withQuota = await mapWithConcurrency(poolAccounts, POOL_QUOTA_REFRESH_CONCURRENCY, async a => {
    const cred = getCodexAccountCredential(a.id);
    const quotaResult = cred
      ? await fetchPoolAccountQuota(a.id, forceRefresh, a.plan)
      : { quota: null, needsReauth: true };
    return poolAccountDto(a, quotaResult, !!cred, isCodexAccountPaused(runtimeConfig, a.id));
  });
  const hasMainCredential = readCodexTokens() !== null;
  const mainNeedsReauth = !hasMainCredential || isAccountNeedsReauth(MAIN_CODEX_ACCOUNT_ID);
  const mainHealth = projectCodexAccountHealth({
    accountId: MAIN_CODEX_ACCOUNT_ID,
    needsReauth: mainNeedsReauth,
  });
  const main: CodexAuthAccountDto = {
    id: MAIN_CODEX_ACCOUNT_ID,
    email: maskEmail(mainInfo.email) ?? "Codex App login",
    plan: mainInfo.plan,
    isMain: true,
    paused: isCodexAccountPaused(runtimeConfig, MAIN_CODEX_ACCOUNT_ID),
    hasCredential: hasMainCredential,
    needsReauth: mainNeedsReauth,
    quota: mainInfo.quota ? { ...quotaForPlan({ ...mainInfo.quota, updatedAt: Date.now() }, mainInfo.plan) } : null,
    ...oauthAccountHealthFields("codex", MAIN_CODEX_ACCOUNT_ID, mainHealth),
  };
  return [main, ...withQuota];
}

interface PauseExhaustedResult {
  pausedAccountIds: string[];
  checkedAccountCount: number;
  failedAccountCount: number;
}

function selectFallbackAfterPause(config: OcxConfig, pausedActiveId: string): void {
  reconcileCodexActiveAfterExclusion(config, pausedActiveId);
}

async function pauseExhaustedCodexAccounts(config: OcxConfig): Promise<PauseExhaustedResult> {
  const poolAccounts = (config.codexAccounts ?? []).filter(account => !account.isMain);
  const mainAttempted = readCodexTokens() !== null;
  const [mainResult, poolResults] = await Promise.all([
    fetchMainAccountInfoAttempt(true, 1),
    mapWithConcurrency(poolAccounts, POOL_QUOTA_REFRESH_CONCURRENCY, async account => {
      if (!getCodexAccountCredential(account.id)) return { account, quotaResult: null };
      return {
        account,
        quotaResult: await fetchPoolAccountQuota(account.id, true, account.plan),
      };
    }),
  ]);

  let checkedAccountCount = 0;
  let failedAccountCount = 0;
  const exhaustedIds: string[] = [];
  if (mainAttempted) {
    if (mainResult.freshQuota && mainResult.info.plan) {
      checkedAccountCount += 1;
      if (
        !isCodexAccountPaused(config, MAIN_CODEX_ACCOUNT_ID)
        && isCodexQuotaExhausted(mainResult.freshQuota, mainResult.info.plan)
      ) {
        exhaustedIds.push(MAIN_CODEX_ACCOUNT_ID);
      }
    } else {
      failedAccountCount += 1;
    }
  }
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
  return { pausedAccountIds: exhaustedIds, checkedAccountCount, failedAccountCount };
}

export async function handleCodexAuthAPI(
  req: Request,
  url: URL,
  config: OcxConfig,
): Promise<Response | null> {

  if (url.pathname === "/api/codex-auth/accounts" && req.method === "GET") {
    const forceRefresh = url.searchParams.get("refresh") === "1" || url.searchParams.get("refresh") === "true";
    return jsonResponse({ accounts: await listCodexAuthAccounts(config, forceRefresh) });
  }

  if (url.pathname === "/api/codex-auth/accounts" && req.method === "POST") {
    if (!isUnverifiedCodexImportEnabled()) return manualImportDisabledResponse();

    let body: { id: string; email: string; plan?: string; accessToken: string; refreshToken: string; chatgptAccountId: string };
    try { body = (await req.json()) as typeof body; } catch { return jsonResponse({ error: "Invalid JSON" }, 400); }
    if (!body.id || !body.email || !body.accessToken || !body.refreshToken || !body.chatgptAccountId) {
      return jsonResponse({ error: "Missing required fields" }, 400);
    }
    if (!isValidCodexAccountId(body.id)) {
      return jsonResponse({ error: "Invalid account id format" }, 400);
    }
    if (body.accessToken.length > 10_000 || body.refreshToken.length > 10_000) {
      return jsonResponse({ error: "Input too large" }, 400);
    }
    const runtimeConfig = getRuntimeConfig(config);
    const preflightConflict = codexAccountPersistenceConflict(runtimeConfig, body.id, "create");
    if (preflightConflict) return jsonResponse({ error: preflightConflict }, 400);
    // 1.1: Duplicate check is scoped by personal vs workspace plan bucket.
    const derivedAccountId = extractAccountId(undefined, body.accessToken) ?? body.chatgptAccountId;
    const collision = checkAccountIdCollision(derivedAccountId, body.email, body.plan);
    if (collision.collision) {
      return jsonResponse({ error: collision.reason }, 400);
    }
    // 4.2: use JWT exp for expiresAt instead of hardcoded 1 hour
    const payload = decodeJwtPayload(body.accessToken);
    const exp = typeof payload?.exp === "number" ? payload.exp * 1000 : Date.now() + 3600_000;
    const warmup = await verifyCodexAccountWarmup(body.id, body.accessToken, derivedAccountId);
    if (!warmup.ok) return warmup.response;
    const latestConfig = getRuntimeConfig(config);
    const commitConflict = codexAccountPersistenceConflict(latestConfig, body.id, "create");
    if (commitConflict) return jsonResponse({ error: commitConflict }, 400);
    saveCodexAccountCredential(body.id, {
      accessToken: body.accessToken,
      refreshToken: body.refreshToken,
      expiresAt: exp,
      chatgptAccountId: derivedAccountId,
    });
    markCodexAccountValidated(body.id, warmup.validatedAt);
    clearAccountNeedsReauth(body.id);
    const accounts = latestConfig.codexAccounts ?? [];
    accounts.push(withCodexAccountLogLabel({ id: body.id, email: body.email, plan: body.plan, isMain: false }, accounts));
    latestConfig.codexAccounts = accounts;
    saveRuntimeConfig(config, latestConfig);
    return jsonResponse({ ok: true });
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
    deleteCodexAccount(runtimeConfig, id);
    saveRuntimeConfig(config, runtimeConfig);
    return jsonResponse({ ok: true });
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

  if (url.pathname === "/api/codex-auth/accounts/pause-exhausted" && req.method === "PUT") {
    const runtimeConfig = getRuntimeConfig(config);
    const result = await pauseExhaustedCodexAccounts(runtimeConfig);
    const { pausedAccountIds, checkedAccountCount, failedAccountCount } = result;
    if (checkedAccountCount === 0 && failedAccountCount > 0) {
      return jsonResponse({
        ok: false,
        error: "Failed to refresh any Codex account quota",
        checkedAccountCount,
        failedAccountCount,
      }, 502);
    }
    if (pausedAccountIds.length > 0) saveRuntimeConfig(config, runtimeConfig);
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
    resetCodexRoutingForManualSelection(targetAccountId);
    saveRuntimeConfig(config, runtimeConfig);
    return jsonResponse({ ok: true, activeCodexAccountId: body.accountId, appliesImmediately: true });
  }

  if (url.pathname === "/api/codex-auth/active" && req.method === "GET") {
    const runtimeConfig = getRuntimeConfig(config);
    return jsonResponse({
      activeCodexAccountId: getEffectiveActiveCodexAccountId(runtimeConfig) ?? null,
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
      const auth = await resolveResetCreditAuth(getRuntimeConfig(config), accountId);
      if (!auth.ok) return auth.response;

      const resp = await fetch(
        "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits",
        {
          headers: {
            Authorization: `Bearer ${auth.accessToken}`,
            "ChatGPT-Account-Id": auth.chatgptAccountId,
          },
          signal: AbortSignal.timeout(8000),
        },
      );
      if (!resp.ok) {
        await resp.body?.cancel().catch(() => {});
        return jsonResponse({ error: `Upstream error ${resp.status}` }, resp.status);
      }
      return jsonResponse(safeResetCreditsDto(await resp.json()));
    } catch (e) {
      return jsonResponse({ error: e instanceof Error ? e.message : "Reset credit lookup failed" }, 500);
    }
  }

  if (url.pathname === "/api/codex-auth/reset-credits/consume" && req.method === "POST") {
    const body = (await req.json().catch(() => ({}))) as { accountId?: string };
    if (!body.accountId) return jsonResponse({ error: "accountId required" }, 400);

    try {
      const auth = await resolveResetCreditAuth(getRuntimeConfig(config), body.accountId);
      if (!auth.ok) return auth.response;

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
          ({ freshResetCredits } = await fetchMainAccountInfoAttempt(true, 1));
        } else {
          const account = configuredPoolAccount(getRuntimeConfig(config), body.accountId);
          ({ freshResetCredits } = await fetchPoolAccountQuota(body.accountId, true, account?.plan));
        }
        return jsonResponse({
          code: result.code,
          ...(typeof freshResetCredits === "number" && Number.isFinite(freshResetCredits)
            ? { remaining: freshResetCredits }
            : {}),
        });
      }
      return jsonResponse(result);
    } catch (e) {
      return jsonResponse({ error: e instanceof Error ? e.message : "Reset credit consume failed" }, 500);
    }
  }

  if (url.pathname === "/api/codex-auth/login" && req.method === "POST") {
    const body = (await req.json().catch(() => ({}))) as { id?: string; reauth?: boolean };
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
    const flowId = `flow-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    try {
      const { startLoginFlow, getLoginStatus } = await import("../oauth");
      const result = await startLoginFlow("chatgpt", { forceLogin: true });

      // Open the browser server-side (same pattern as /api/oauth/login in management-api.ts).
      // The GUI's window.open is popup-blocked because it runs after an await, not a direct click.
      if (result.url) {
        const { openUrl } = await import("../lib/open-url");
        openUrl(result.url);
      }

      (async () => {
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
                codexAuthLoginState.set(flowId, {
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
                  plan = data.plan_type ?? undefined;
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
                    codexAuthLoginState.set(flowId, {
                      status: "error",
                      error: "Signed-in ChatGPT account does not match this pool account. Sign in with the same account, or remove it and add a new one.",
                      doneAt: Date.now(),
                    });
                    completed = true;
                    break;
                  }
                } else if (expectedEmail) {
                  if (!gotEmail || gotEmail !== expectedEmail) {
                    codexAuthLoginState.set(flowId, {
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
                  codexAuthLoginState.set(flowId, {
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
                codexAuthLoginState.set(flowId, {
                  status: "error", error: collision.reason, doneAt: Date.now(),
                });
                completed = true;
                break;
              }

              const warmup = await verifyCodexAccountWarmup(accountId, cred.access, oauthAccountId);
              if (!warmup.ok) {
                const body = await warmup.response.json().catch(() => ({})) as { error?: string; reason?: string };
                codexAuthLoginState.set(flowId, {
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
              const commitConflict = codexAccountPersistenceConflict(
                latestConfig,
                accountId,
                reauth ? "reauth" : "create",
              );
              if (commitConflict) {
                codexAuthLoginState.set(flowId, {
                  status: "error",
                  error: commitConflict,
                  doneAt: Date.now(),
                });
                completed = true;
                break;
              }

              saveCodexAccountCredential(accountId, {
                accessToken: cred.access,
                refreshToken: cred.refresh,
                expiresAt: cred.expires,
                chatgptAccountId: oauthAccountId,
              });
              markCodexAccountValidated(accountId, warmup.validatedAt);
              clearAccountNeedsReauth(accountId);
              if (quota) {
                setAccountQuotaFromParsed(accountId, quota);
              }

              if (existingIdx >= 0) {
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
                accounts.push(withCodexAccountLogLabel({ id: accountId, email, plan, isMain: false }, accounts));
                latestConfig.codexAccounts = accounts;
                saveRuntimeConfig(config, latestConfig);
              }
              codexAuthLoginState.set(flowId, { status: "done", accountId, email, doneAt: Date.now() });
              completed = true;
            }
            break;
          }
          if (st.done && st.error) {
            codexAuthLoginState.set(flowId, { status: "error", error: st.error, doneAt: Date.now() });
            completed = true;
            break;
          }
        }
        if (!completed) {
          codexAuthLoginState.set(flowId, {
            status: "error",
            error: "Login timed out before OAuth completed.",
            doneAt: Date.now(),
          });
        }
        // TTL: keep completed flow state available for clients that miss a short polling window.
        setTimeout(() => codexAuthLoginState.delete(flowId), 300_000);
      })();

      codexAuthLoginState.set(flowId, { status: "pending" });
      return jsonResponse({ ok: true, flowId, url: result.url, instructions: result.instructions });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes("already in progress")) {
        return jsonResponse({ error: msg, status: "pending" }, 409);
      }
      return jsonResponse({ error: msg }, 500);
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
      if (!st && accountId && !reauthStatus && getCodexAccountCredential(accountId)) {
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
