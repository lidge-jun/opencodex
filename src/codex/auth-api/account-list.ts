import { codexAccountLogLabel } from "../account-label";
import { getCodexAccountCredential, getValidCodexToken, isCodexAccountGenerationLive, readCodexAccountRecord } from "../account-store";
import { getAccountQuota, isCodexQuotaExhausted, setAccountQuotaFromParsed, withoutRetiredCodexQuota } from "../quota";
import type { StoredAccountQuota } from "../quota";
import { ConfigMutationLockError, mutatePersistedConfig } from "../../config";
import { reconcileMainCodexAccountRuntimeState } from "../account-lifecycle";
import { isCodexAccountPaused, setCodexAccountPaused } from "../account-pause";
import { getCodexAccountPriority } from "../account-priority";
import { clearThreadAccountMapForAccount, isCodexAccountPlanExcluded, reconcileCodexActiveAfterExclusion } from "../routing";
import { codexPlanValue, isThirtyDayOnlyCodexPlan } from "../plan";
import { isAccountNeedsReauth, markAccountNeedsReauth } from "../account-runtime-state";
import { getValidMainAccountToken, MainAccountTokenRefreshError, MAIN_CODEX_ACCOUNT_ID } from "../main-account";
import { captureConfigGeneration } from "../../lib/state-store-sweeper";
import { captureMainAccountIdentityGeneration, getMainAccountCredentialPresence, isMainAccountIdentityGenerationLive } from "../main-account-cache";
import type { CodexQuotaRefreshOutcome } from "../quota-refresh-outcome";
import { getMainAccountHardLockStatus } from "../main-account-hard-lock";
import type { MainAccountHardLockStatus } from "../main-account-hard-lock";
import { emailMaskingEnabled, projectEmail } from "../../lib/privacy";
import type { CodexAccount, OcxConfig } from "../../types";
import { oauthAccountHealthFields, projectCodexAccountHealth } from "../../oauth/health";
import type { OAuthAccountHealth, OAuthHealthLabel } from "../../oauth/health";
import { isSelectableCodexPoolAccount } from "../account-id";
import type { AdmissionLease } from "../../lib/admission";
import { tryAcquireNativeMainProfileClaim } from "../native-main-admission";
import { withNativeMainCredentialClaim, isNativeMainClaimUnavailable } from "./http";
import { fetchMainAccountInfoAttempt, EMPTY_MAIN_ACCOUNT_INFO, mainResetCreditsForCurrentIdentity } from "./main-account-probe";
import { fetchPoolAccountQuota, PoolQuotaProbeBusyError, POOL_QUOTA_REFRESH_CONCURRENCY } from "./pool-quota-probe";
import type { PoolQuotaResult } from "./pool-quota-probe";
import { getRuntimeConfig, configuredPoolAccount, mapWithConcurrency } from "./runtime-config";

export function quotaForPlan<T extends Omit<StoredAccountQuota, "updatedAt"> | StoredAccountQuota | null>(
  quota: T,
  plan: unknown,
): T | null {
  const visible = withoutRetiredCodexQuota(quota);
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

/**
 * The main account is the only account whose DTO quota comes from the raw WHAM parse
 * result instead of the merged store: `poolAccountDto` serializes what
 * `commitPoolQuotaResponse` read back out of `getAccountQuota()`, while the main DTO
 * spreads `mainInfo.quota` directly. `/wham/usage` carries `rate_limit_reset_credits`
 * only intermittently, and the store exists to bridge that gap
 * (`setAccountQuotaFromParsed` carries an existing `resetCredits` forward when the new
 * snapshot omits it), so the main card lost its ticket badge on every response that
 * happened to omit the summary while pool cards kept theirs.
 *
 * Only `resetCredits` is carried, deliberately, and only from an identity-tagged
 * in-process observation rather than the alias-keyed store. The window fields have
 * *clearing* semantics — a monthly-only snapshot must drop a stale weekly value (#382) —
 * so reinstating the whole stored object would resurrect a window the parse meant to
 * clear whenever the store write was refused by generation gating. A freshly parsed value
 * always wins, including `0`: zero is defined, so it never takes the fill branch.
 */
export function mainQuotaWithCarriedResetCredits(
  parsed: Omit<StoredAccountQuota, "updatedAt">,
): StoredAccountQuota {
  const carried = parsed.resetCredits === undefined
    ? mainResetCreditsForCurrentIdentity()
    : undefined;
  return {
    ...parsed,
    ...(carried !== undefined ? { resetCredits: carried } : {}),
    updatedAt: getAccountQuota(MAIN_CODEX_ACCOUNT_ID)?.updatedAt ?? Date.now(),
  };
}

/**
 * Why an account needs the operator. `missing_credential`, `refresh_failed`, and
 * `quota_unauthorized` are the three causes this surface tells apart on its own. `unauthorized`
 * and `forbidden` come from the shared health projection: `projectCodexAccountHealth` maps a
 * stored verification failure's `http_status:401`/`http_status:403` to them, so the union has
 * to accept every reason the projection can emit rather than silently dropping one.
 */
export type CodexAccountReauthReason =
  | "missing_credential"
  | "refresh_failed"
  | "quota_unauthorized"
  | "unauthorized"
  | "forbidden";

export function poolAccountDto(
  config: OcxConfig,
  account: CodexAccount,
  quotaResult: PoolQuotaResult,
  hasCredential: boolean,
  paused: boolean,
  priority: number,
  maskEmails: boolean,
): CodexAuthAccountDto {
  const plan = codexPlanValue(account.plan);
  const quota = quotaForPlan(quotaResult.quota, plan);
  const runtimeReauth = isAccountNeedsReauth(account.id);
  const rawReauthReason: CodexAccountReauthReason | undefined = !hasCredential
    ? "missing_credential"
    : quotaResult.reauthReason;
  const needsReauth = !hasCredential || quotaResult.needsReauth || runtimeReauth;
  // An in-memory reauth mark carries no cause of its own, so it must not name one: passing
  // a caller reason here would outrank the stored verdict's http_status inside the
  // projection and hide unauthorized/forbidden until the mark is gone. With no caller
  // reason the projection falls back to the persisted cause, then to refresh_failed.
  const healthReason = rawReauthReason === "quota_unauthorized" || rawReauthReason === "missing_credential"
    ? "unauthorized"
    : rawReauthReason;
  const health = projectCodexAccountHealth({
    accountId: account.id,
    needsReauth,
    reauthReason: needsReauth ? healthReason : undefined,
  });
  // `needsReauth` is an OR of three independent causes plus a persisted verdict resolved inside the
  // health projection. Emitting only the boolean is what left #4212's reporter guessing which
  // account took their model away and why, so name the cause they actually have to act on.
  const reauthReason: CodexAccountReauthReason | undefined = rawReauthReason ?? (health.status === "reauth_required" ? health.reason : undefined);
  return {
    id: account.id,
    email: projectEmail(account.email, maskEmails) ?? account.email,
    ...(account.alias !== undefined ? { alias: account.alias } : {}),
    ...(plan !== undefined ? { plan } : {}),
    logLabel: codexAccountLogLabel(account),
    isMain: false,
    paused,
    priority,
    quota: quota ? { ...quota } : null,
    needsReauth: needsReauth || health.status === "reauth_required",
    ...(reauthReason !== undefined ? { reauthReason } : {}),
    ...(isCodexAccountPlanExcluded(config, account.id) ? {
      selectionExcludedReason: "plan_excluded" as const,
      selectionExcludedPlan: codexPlanValue(config.codexAccounts?.find(row => row.id === account.id)?.plan),
    } : {}),
    hasCredential,
    ...(quotaResult.quotaProbeSkipped ? { quotaProbeSkipped: true as const } : {}),
    ...oauthAccountHealthFields("codex", account.id, health),
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
  /**
   * Which of the independent causes behind `needsReauth` fired. Present only when the account
   * needs the operator; `/api/oauth/accounts` already carries the same field name.
   */
  reauthReason?: CodexAccountReauthReason;
  /** Automatic selection policy only; explicit routes retain their usual auth checks. */
  selectionExcludedReason?: "plan_excluded";
  selectionExcludedPlan?: string;
  hasCredential: boolean;
  health: OAuthAccountHealth;
  healthLabel: OAuthHealthLabel;
  healthSummary: string;
  healthAction?: string;
  quotaProbeSkipped?: true;
  quotaRefresh?: CodexQuotaRefreshOutcome;
  mainAccountHardLock?: MainAccountHardLockStatus;
}

export interface FreshPoolPlanUpdate {
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
export function reconcileFreshPoolAccountPlans(runtimeConfig: OcxConfig, updates: FreshPoolPlanUpdate[]): void {
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

export interface CodexAuthAccountsSnapshot {
  accounts: CodexAuthAccountDto[];
  mainIdentityGeneration: number;
}

export async function listCodexAuthAccountsSnapshot(
  config: OcxConfig,
  forceRefresh = false,
  options: { validatePending?: boolean } = {},
): Promise<CodexAuthAccountsSnapshot> {
  const runtimeConfig = getRuntimeConfig(config);
  const poolAccounts = (runtimeConfig.codexAccounts ?? []).filter(isSelectableCodexPoolAccount);
  // One redaction decision for the whole snapshot, read once from the operator's config (#3859).
  const maskEmails = emailMaskingEnabled(runtimeConfig);
  const mainResult = await fetchMainAccountInfoAttempt(forceRefresh, 1);
  const refreshedPool = await mapWithConcurrency(poolAccounts, POOL_QUOTA_REFRESH_CONCURRENCY, async account => {
    const cred = getCodexAccountCredential(account.id);
    let quotaResult: PoolQuotaResult;
    if (!cred) {
      quotaResult = { quota: null, needsReauth: true };
    } else {
      try {
        quotaResult = await fetchPoolAccountQuota(account.id, forceRefresh, account.plan, getValidCodexToken, options.validatePending === true);
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
        runtimeConfig,
        currentAccount,
        { quota: null, needsReauth: true },
        false,
        isCodexAccountPaused(runtimeConfig, accountId),
        getCodexAccountPriority(runtimeConfig, accountId),
        maskEmails,
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
      runtimeConfig,
      dtoAccount,
      effectiveQuotaResult,
      true,
      isCodexAccountPaused(runtimeConfig, accountId),
      getCodexAccountPriority(runtimeConfig, accountId),
      maskEmails,
    )];
  });
  const fetchedMainGeneration = mainResult.identityGeneration ?? captureMainAccountIdentityGeneration();
  const mainSnapshotLive = isMainAccountIdentityGenerationLive(fetchedMainGeneration);
  const mainInfo = mainSnapshotLive ? mainResult.info : EMPTY_MAIN_ACCOUNT_INFO;
  const hasMainCredential = mainSnapshotLive && mainResult.credentialChecked
    ? mainResult.hasCredential
    : getMainAccountCredentialPresence() ?? false;
  const mainMissingCredential = mainSnapshotLive && mainResult.credentialChecked && !hasMainCredential;
  const mainNeedsReauth = mainMissingCredential || isAccountNeedsReauth(MAIN_CODEX_ACCOUNT_ID);
  const mainHealth = projectCodexAccountHealth({
    accountId: MAIN_CODEX_ACCOUNT_ID,
    needsReauth: mainNeedsReauth,
  });
  // The main row carries the same attribution as a pool row. Reaching this point without
  // `mainMissingCredential` means the runtime reauth flag is what set `mainNeedsReauth`, so the
  // cause is a refresh that did not complete.
  const mainReauthReason: CodexAccountReauthReason | undefined = mainMissingCredential
    ? "missing_credential"
    : mainNeedsReauth
      ? "refresh_failed"
      : mainHealth.status === "reauth_required" ? mainHealth.reason : undefined;
  const main: CodexAuthAccountDto = {
    id: MAIN_CODEX_ACCOUNT_ID,
    email: projectEmail(mainInfo.email, maskEmails) ?? "Codex App login",
    plan: mainInfo.plan,
    ...(mainSnapshotLive && mainResult.quotaRefresh && mainResult.quotaRefreshGeneration !== undefined
      && isMainAccountIdentityGenerationLive(mainResult.quotaRefreshGeneration)
      ? { quotaRefresh: mainResult.quotaRefresh } : {}),
    logLabel: "main",
    isMain: true,
    paused: isCodexAccountPaused(runtimeConfig, MAIN_CODEX_ACCOUNT_ID),
    mainAccountHardLock: getMainAccountHardLockStatus(runtimeConfig),
    priority: getCodexAccountPriority(runtimeConfig, MAIN_CODEX_ACCOUNT_ID),
    hasCredential: hasMainCredential,
    needsReauth: mainNeedsReauth,
    ...(mainReauthReason !== undefined ? { reauthReason: mainReauthReason } : {}),
    quota: mainInfo.quota
      ? quotaForPlan(mainQuotaWithCarriedResetCredits(mainInfo.quota), mainInfo.plan)
      : null,
    ...oauthAccountHealthFields("codex", MAIN_CODEX_ACCOUNT_ID, mainHealth),
  };
  return {
    accounts: [main, ...withQuota],
    mainIdentityGeneration: mainSnapshotLive
      ? fetchedMainGeneration
      : captureMainAccountIdentityGeneration(),
  };
}

/** One opted-in account's metadata; reuse the bounded WHAM 401 recovery and generation fence. */
export async function refreshCodexQuotaForActivation(config: OcxConfig, accountId: string): Promise<void> {
  if (accountId === MAIN_CODEX_ACCOUNT_ID) {
    const lease = tryAcquireNativeMainProfileClaim();
    if (!lease) return;
    try {
      reconcileMainCodexAccountRuntimeState();
      if (isAccountNeedsReauth(accountId)) return;
      const identityGeneration = captureMainAccountIdentityGeneration();
      const writerGeneration = captureConfigGeneration();
      try {
        // Refresh may need an exclusive claim; prepare before WHAM takes its shared claim.
        if (!await getValidMainAccountToken({ preserveReauth: true })) return;
      } catch (error) {
        if (error instanceof MainAccountTokenRefreshError && error.reason === "reauth"
          && isMainAccountIdentityGenerationLive(identityGeneration)) {
          markAccountNeedsReauth(accountId, writerGeneration);
        }
        return;
      }
      if (isAccountNeedsReauth(accountId)) return;
      await fetchMainAccountInfoAttempt(true, 1, lease, false, false);
    } finally {
      lease.release();
    }
    return;
  }
  const account = configuredPoolAccount(config, accountId);
  if (!account) return;
  const writerGeneration = captureConfigGeneration();
  const result = await fetchPoolAccountQuota(accountId, true, account.plan);
  if (result.needsReauth && result.credentialGeneration !== undefined) {
    markAccountNeedsReauth(accountId, writerGeneration, result.credentialGeneration);
  }
}

export async function listCodexAuthAccounts(
  config: OcxConfig,
  forceRefresh = false,
  options: { validatePending?: boolean } = {},
): Promise<CodexAuthAccountDto[]> {
  return (await listCodexAuthAccountsSnapshot(config, forceRefresh, options)).accounts;
}

export interface PauseExhaustedResult {
  pausedAccountIds: string[];
  checkedAccountCount: number;
  failedAccountCount: number;
}

export function selectFallbackAfterPause(config: OcxConfig, pausedActiveId: string): void {
  reconcileCodexActiveAfterExclusion(config, pausedActiveId);
}

export async function pauseExhaustedCodexAccounts(
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
