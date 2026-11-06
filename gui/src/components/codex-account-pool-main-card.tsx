import type { ReactNode } from "react";
import { IconLock, IconPause, IconPlay, IconPlus, IconRefresh } from "../icons";
import AccountPriorityControl, { AccountPriorityBadge } from "./AccountPriorityControl";
import AccountAutoSwitchControl from "./AccountAutoSwitchControl";
import { AccountCreditsToggle, CreditsOnBadge } from "./CodexCreditSpend";
import CodexCreditsRow from "./CodexCreditsRow";
import { useI18n } from "../i18n/shared";
import { CodexPauseToggleLabel, CodexPinnedBadge, CodexTicketBadge } from "./codex-account-pool-helpers";
import type { CodexAccountEntry, CodexAccountLoadState } from "./codex-account-pool-types";
import type { CodexAccountModeState } from "../codex-multi-state";
import type { TFn } from "../i18n/shared";
import type { MainDeviceReauthState } from "./use-main-device-reauth";
import { LoginHint } from "./login-url-block";
import type { NoticeTone } from "../ui";
import { navigateHash } from "../hash-routing";
import { hardLockThresholds } from "../hooks/useCodexAccountPool";
import QuotaBars from "./QuotaBars";
import { AccountMore, AccountRow, AccountSetting } from "./v2-accounts/account-row";
import { InlineBanner } from "./v2-accounts/surface";
import { cn } from "@/lib/utils";
import {
  doctorCopyButtonLabel,
  formatOAuthHealthLabel,
  formatOAuthHealthSummary,
  oauthHealthBadgeClass,
  oauthHealthIsCooldown,
  oauthHealthShowsDoctor,
  oauthHealthShowsReauth,
} from "../oauth-health-display";

export function CodexAccountPoolMainCard({
  t,
  main,
  isMainActive,
  accountModeState,
  threshold,
  switchActionLabel,
  onSwitch,
  onTogglePause,
  pauseUpdatingId,
  pauseBusy,
  onPriorityChange,
  priorityUpdatingId,
  onAutoSwitchThresholdChange,
  autoSwitchDisabled,
  switchingId,
  pinnedId = null,
  onUnpin,
  onOpenReset,
  onCopyDoctor,
  doctorCopyOutcomeFor,
  onManageMainHardLock,
  mainReauth,
  onToggleCreditsAfterLimit,
  creditsAfterLimitUpdatingId = null,
  creditsVisible,
  loading = false,
}: {
  t: TFn;
  main: CodexAccountEntry | undefined;
  creditsVisible?: boolean;
  loading?: boolean;
  isMainActive: boolean;
  accountModeState: CodexAccountModeState | null;
  threshold: number;
  switchActionLabel: string;
  onSwitch: (entry: CodexAccountEntry) => void;
  onTogglePause: (entry: CodexAccountEntry) => void;
  pauseUpdatingId: string | null;
  pauseBusy: boolean;
  onPriorityChange: (entry: CodexAccountEntry, priority: number) => void;
  priorityUpdatingId: string | null;
  onAutoSwitchThresholdChange: (entry: CodexAccountEntry, threshold: number | null) => Promise<boolean>;
  autoSwitchDisabled: boolean;
  /** In-flight manual switch, which writes the same pin an order write clears. */
  switchingId: string | null;
  /**
   * The account carrying the pin, which is not always the one routing is on: the pin caps
   * selection at its own tier, and under round-robin or fill-first the cursor still moves
   * within that tier. Badge the account the operator chose, not wherever routing landed.
   */
  pinnedId?: string | null;
  /** Opens the release confirm when the pinned badge is selected again. */
  onUnpin: (account: CodexAccountEntry) => void;
  onOpenReset: (account: CodexAccountEntry) => void;
  /** Writes the main login's "use credits after limit" switch, shown in its "more" disclosure. */
  onToggleCreditsAfterLimit?: (entry: CodexAccountEntry, enabled: boolean) => void;
  creditsAfterLimitUpdatingId?: string | null;
  onCopyDoctor?: (accountId: string) => void;
  doctorCopyOutcomeFor?: (accountId: string) => "copied" | "unavailable" | null;
  onManageMainHardLock?: () => void;
  /** #3898: native-main device reauth flow state and controls (dedicated namespace). */
  mainReauth?: {
    state: MainDeviceReauthState;
    start: () => Promise<void>;
    cancel: () => Promise<void>;
  } | undefined;
}) {
  const { locale } = useI18n();
  const showCredits = creditsVisible === true && main?.credits !== undefined;
  const mainFallbackLabel = t("codexAuth.codexApp");
  const mainId = main?.id ?? "__main__";
  const mainSwitchEntry: CodexAccountEntry = {
    id: "__main__",
    email: main?.email || mainFallbackLabel,
    plan: main?.plan,
    isMain: true,
    paused: main?.paused ?? false,
    priority: main?.priority ?? 0,
    autoSwitchThresholdOverride: main?.autoSwitchThresholdOverride ?? null,
    hasCredential: true,
    quota: main?.quota ?? null,
    quotaAutoRefresh: main?.quotaAutoRefresh ?? {
      fiveHourAvailable: false,
      weeklyAvailable: false,
      fiveHourEnabled: false,
      weeklyEnabled: false,
    },
  };
  const showReauth = Boolean(main?.needsReauth) || oauthHealthShowsReauth(main?.health?.status);
  const inCooldown = oauthHealthIsCooldown(main?.health?.status);
  const policy = main?.mainAccountHardLock;
  const hardLocked = policy?.enabled === true && policy.state === "blocked";
  const healthLabel = formatOAuthHealthLabel(t, main?.health);
  const healthSummary = main
    ? formatOAuthHealthSummary(t, "codex", mainId, main.health)
    : null;
  const showDoctor = onCopyDoctor && oauthHealthShowsDoctor(main?.health?.status);
  const mainLabel = main?.alias ?? (main?.email || t("codexAuth.mainAccount"));
  const doctorButton = showDoctor ? (
    <button type="button" className="link-btn codex-auth-action-btn" onClick={() => onCopyDoctor(mainId)}>
      <span aria-live="polite">{doctorCopyButtonLabel(t, doctorCopyOutcomeFor?.(mainId))}</span>
    </button>
  ) : null;

  return (
    <AccountRow
      active={isMainActive && !hardLocked}
      paused={main?.paused}
      dot={showReauth || hardLocked ? "warn" : main?.paused ? "idle" : isMainActive ? "active" : "ok"}
      name={main?.email || t("codexAuth.appLogin")}
      chips={<>
        {!main?.paused && !hardLocked && isMainActive && (
          <span className="badge badge-primary">
            {t(accountModeState === "direct" ? "codexAuth.poolPrepared" : "codexAuth.nextSession")}
          </span>
        )}
        <span className="badge badge-plan acc-main-tag" title={t("codexAuth.appLogin")}>
          <IconLock width={11} aria-hidden="true" /> {t("codexAuth.mainAccount")}
        </span>
        {main?.plan && <span className="badge badge-plan">{main.plan}</span>}
        {main?.paused && (
          <span className="badge badge-muted" title={t("codexAuth.pausedHint")}>
            {t("codexAuth.paused")}
          </span>
        )}
        <AccountPriorityBadge value={mainSwitchEntry.priority} />
        <CreditsOnBadge enabled={main?.creditsAfterLimit} />
        {pinnedId === "__main__" && !main?.paused && <CodexPinnedBadge t={t} onUnpin={() => onUnpin(mainSwitchEntry)} />}
        {main && <CodexTicketBadge t={t} account={{ ...main, id: "__main__" } as CodexAccountEntry} onClick={() => onOpenReset({ ...main, id: "__main__" } as CodexAccountEntry)} />}
        {healthLabel && (
          <span className={oauthHealthBadgeClass(main?.health?.status)}>{healthLabel}</span>
        )}
        {showReauth && !healthLabel && <span className="badge badge-amber">{t("codexAuth.needsReauth")}</span>}
        {!main?.paused && !hardLocked && !isMainActive && (
          <span className="badge badge-muted">{t("codexAuth.current")}</span>
        )}
      </>}
      actions={<>
        {!main?.paused && !hardLocked && (!isMainActive || pinnedId !== "__main__") && !showReauth && !inCooldown && (
          <button type="button" className="btn btn-ghost btn-sm codex-account-switch" onClick={() => onSwitch(mainSwitchEntry)}>
            {switchActionLabel}
          </button>
        )}
        {main && (
          <button
            type="button"
            className="acc-icon-btn codex-auth-action-btn"
            onClick={() => onTogglePause(mainSwitchEntry)}
            disabled={pauseBusy}
            aria-busy={pauseUpdatingId === "__main__" || undefined}
            title={main.paused ? t("codexAuth.pausedHint") : t("codexAuth.pause")}
            aria-label={main.paused ? `${t("codexAuth.resume")}. ${t("codexAuth.pausedHint")}` : t("codexAuth.pause")}
          >
            {main.paused ? <IconPlay width={15} /> : <IconPause width={15} />}
            <span className="sr-only">
              <CodexPauseToggleLabel
                t={t}
                paused={!!main.paused}
                saving={pauseUpdatingId === "__main__"}
              />
            </span>
          </button>
        )}
      </>}
      more={main ? (
        // Same disclosure as the pool rows. The order select and the threshold override stay
        // mounted here (the main row has no on-demand mount), the credits switch joins them
        // once the main login carries a credential.
        <AccountMore
          label={`${t("codexAuth.moreActions")} — ${t("codexAuth.mainAccount")}`}
          title={t("codexAuth.moreActions")}
        >
          <AccountSetting>
            <AccountPriorityControl
              value={mainSwitchEntry.priority}
              // Derived from the synthesized id rather than hardcoded as "-main": a pool account
              // may legitimately be named `main` (the id pattern allows it), and that account's
              // control would then claim the same DOM id, pointing this label at its dropdown.
              selectId={`codex-account-priority-${mainSwitchEntry.id}`}
              // Any in-flight order write, not just this card's: order writes share one mutation
              // ref, so a pick made during another card's write returns "busy" and is dropped
              // silently. Mirrors pauseBusy. A pending switch counts too — it writes the same
              // pin this clears, so the controller refuses to overlap them, just as silently.
              disabled={priorityUpdatingId !== null || switchingId !== null}
              onChange={(priority) => onPriorityChange(mainSwitchEntry, priority)}
            />
          </AccountSetting>
          <AccountSetting>
            <AccountAutoSwitchControl
              key={mainSwitchEntry.id}
              accountLabel={mainSwitchEntry.email}
              globalThreshold={threshold}
              override={mainSwitchEntry.autoSwitchThresholdOverride}
              inputId={`codex-account-auto-switch-${mainSwitchEntry.id}`}
              disabled={autoSwitchDisabled}
              onChange={(next) => onAutoSwitchThresholdChange(mainSwitchEntry, next)}
            />
          </AccountSetting>
          {main.hasCredential && onToggleCreditsAfterLimit && (
            <AccountSetting>
              <AccountCreditsToggle
                accountLabel={mainLabel}
                enabled={main.creditsAfterLimit}
                saving={creditsAfterLimitUpdatingId === "__main__"}
                disabled={creditsAfterLimitUpdatingId !== null}
                hint={t("codexAuth.creditsAfterLimitMainHint")}
                onChange={enabled => onToggleCreditsAfterLimit(mainSwitchEntry, enabled)}
              />
            </AccountSetting>
          )}
        </AccountMore>
      ) : undefined}
    >
      {(policy?.enabled || policy?.externalUsage || healthSummary || inCooldown || showReauth || showDoctor) && (
        <div className="acc-row__notes">
          {policy?.enabled && (
            <div className={`codex-main-hard-lock-status${hardLocked ? " is-blocked" : ""}`}>
              <p role="status">{t(hardLocked ? "codexAuth.mainHardLockBlocked"
                : policy.state === "ready" ? "codexAuth.mainHardLockMonitoring" : "codexAuth.mainHardLockUnknown", hardLockThresholds(policy.thresholds))}</p>
              {onManageMainHardLock
                ? <button type="button" className="link-btn" onClick={onManageMainHardLock}>{t("codexAuth.mainHardLockManage")}</button>
                : <button type="button" className="link-btn" onClick={() => navigateHash("codex-set")}>{t("codexAuth.mainHardLockManage")}</button>}
            </div>
          )}
          {policy?.externalUsage && <div className="codex-main-hard-lock-status is-blocked"><p role="status">{t("codexAuth.mainExternalUsageWarning")}</p></div>}
          {healthSummary && (
            <div className="card-sub faint"><span>{healthSummary}</span>{doctorButton}</div>
          )}
          {!healthSummary && doctorButton && <div className="card-sub faint">{doctorButton}</div>}
          {inCooldown && (
            <div className="card-sub faint">{t("pws.healthCooldownHint")}</div>
          )}
          {showReauth && (
            <div className="card-sub faint acc-reauth">
              <p role="status">{t("codexAuth.mainTokenExpired")}</p>
              {mainReauth && (mainReauth.state.phase === "idle" || mainReauth.state.phase === "failed" || mainReauth.state.phase === "cancelled") && (
                <>
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm codex-auth-action-btn"
                    onClick={() => { void mainReauth.start(); }}
                  >
                    {t("codexAuth.mainReauthDevice")}
                  </button>
                  {mainReauth.state.phase === "failed" && (
                    <span className="badge badge-amber">{t("codexAuth.mainReauthFailed")}: {mainReauth.state.code}</span>
                  )}
                </>
              )}
              {mainReauth && mainReauth.state.phase === "starting" && (
                <span className="faint">{t("codexAuth.mainReauthPending")}</span>
              )}
              {mainReauth && (mainReauth.state.phase === "pending" || mainReauth.state.phase === "committing") && (
                <span className="codex-main-reauth-pending">
                  {/* The shared renderer every other login surface uses: a copyable code, a
                      selectable and copyable URL, and one click to copy the code and open the
                      page. Plain text here left the user retyping both by hand. */}
                  <LoginHint hint={{ url: mainReauth.state.verificationUrl, deviceCode: mainReauth.state.deviceCode }} />
                  <span className="faint">{t("codexAuth.mainReauthPending")}</span>
                  {mainReauth.state.cancelFailed && (
                    <span role="status" className="badge badge-amber">{t("codexAuth.mainReauthFailed")}</span>
                  )}
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm codex-auth-action-btn"
                    onClick={() => { void mainReauth.cancel(); }}
                  >
                    {t("codexAuth.mainReauthCancel")}
                  </button>
                </span>
              )}
              {mainReauth && mainReauth.state.phase === "succeeded" && (
                <span className="badge badge-primary">{t("codexAuth.mainReauthSucceeded")}</span>
              )}
            </div>
          )}
        </div>
      )}
      {!showReauth && !inCooldown && (
        <div className="acc-row__meters">
          <QuotaBars
            quota={main?.quota ?? null}
            plan={main?.plan}
            threshold={mainSwitchEntry.autoSwitchThresholdOverride ?? threshold}
            t={t}
            pending={main != null && main.quota == null && (loading || !showCredits)}
            afterWeekly={showCredits && !loading ? <CodexCreditsRow credits={main?.credits} t={t} locale={locale} /> : undefined}
          />
        </div>
      )}
    </AccountRow>
  );
}

export function CodexAccountPoolPageHead({
  t,
  embedded,
  refreshingQuota,
  pausingExhausted,
  pauseBusy,
  actionFeedback,
  actionFeedbackTone,
  onRefresh,
  onPauseExhausted,
  creditsVisible,
  creditsBusy,
  onToggleCredits,
  creditSpendControl,
}: {
  t: TFn;
  embedded: boolean;
  /** Undefined until settings loads. */
  creditsVisible?: boolean;
  creditsBusy?: boolean;
  onToggleCredits?: () => void;
  /** The global "use credits" switch, rendered beside the credits display switch. */
  creditSpendControl?: ReactNode;
  refreshingQuota: boolean;
  pausingExhausted: boolean;
  pauseBusy?: boolean;
  actionFeedback?: string | null;
  actionFeedbackTone?: NoticeTone | null;
  onRefresh: () => void;
  onPauseExhausted: () => void;
}) {
  return (
    <div
      className={embedded ? "row acc-head acc-head--embedded" : "page-head codex-auth-page-head acc-head"}
      style={embedded ? { justifyContent: "flex-end", marginBottom: 8 } : undefined}
    >
      {!embedded && <h2 className="page-title">{t("nav.codexAuth")}</h2>}
      <div className={embedded ? "row" : "codex-auth-page-head__actions"}>
        <span
          className={`codex-auth-page-head__feedback${actionFeedbackTone === "ok" ? " is-ok" : ""}${actionFeedbackTone === "warn" ? " is-warn" : ""}${actionFeedbackTone === "err" ? " is-err" : ""}`}
          role="status"
          aria-live="polite"
        >
          {actionFeedback ?? ""}
        </span>
        {creditsVisible !== undefined && onToggleCredits && (
          <span className="codex-auth-credits-toggle">
            <span className="codex-auth-credits-toggle__label">{t("codexAuth.creditsToggle")}</span>
            <button
              type="button"
              className={`toggle ${creditsVisible ? "on" : ""}`}
              onClick={onToggleCredits}
              disabled={!!creditsBusy}
              aria-pressed={creditsVisible}
              aria-label={t("codexAuth.creditsToggle")}
              title={t("codexAuth.creditsToggleHint")}
            >
              <span className="toggle-knob" />
            </button>
          </span>
        )}
        {creditSpendControl}
        {/* The standalone pause/refresh row sits on the accounts panel. Embedded
            surfaces keep those actions beside feedback because there is no page title. */}
        {embedded && (
          <CodexAccountPoolActionButtons
            t={t}
            refreshingQuota={refreshingQuota}
            pausingExhausted={pausingExhausted}
            pauseBusy={pauseBusy}
            onRefresh={onRefresh}
            onPauseExhausted={onPauseExhausted}
          />
        )}
      </div>
    </div>
  );
}

/** The pause/refresh pair, shared by the embedded head and the standalone action row. */
export function CodexAccountPoolActionButtons({
  t,
  refreshingQuota,
  pausingExhausted,
  pauseBusy,
  onRefresh,
  onPauseExhausted,
}: {
  t: TFn;
  refreshingQuota: boolean;
  pausingExhausted: boolean;
  pauseBusy?: boolean;
  onRefresh: () => void;
  onPauseExhausted: () => void;
}) {
  return (
    <>
      <button
        type="button"
        className="btn btn-sm btn-ghost codex-auth-action-btn"
        onClick={onPauseExhausted}
        disabled={refreshingQuota || pausingExhausted || !!pauseBusy}
      >
        <IconPause width={14} /> {pausingExhausted ? t("codexAuth.pausingExhausted") : t("codexAuth.pauseExhausted")}
      </button>
      <button
        type="button"
        className="btn btn-sm btn-ghost codex-auth-action-btn"
        onClick={onRefresh}
        disabled={refreshingQuota || pausingExhausted || !!pauseBusy}
      >
        <span className={cn("inline-flex", refreshingQuota && "animate-spin")}><IconRefresh width={14} /></span> {refreshingQuota ? t("codexAuth.refreshingQuota") : t("codexAuth.refreshQuota")}
      </button>
    </>
  );
}

/**
 * Standalone-page action row: the pause/refresh pair, moved out of the page head and
 * placed on the accounts panel they operate on.
 */
export function CodexAccountPoolActions(props: {
  t: TFn;
  refreshingQuota: boolean;
  pausingExhausted: boolean;
  pauseBusy?: boolean;
  onRefresh: () => void;
  onPauseExhausted: () => void;
}) {
  return (
    <div className="codex-auth-actions-row">
      <CodexAccountPoolActionButtons {...props} />
    </div>
  );
}

export function CodexAccountPoolLoadStates({
  t,
  loadState,
  refreshFailed,
  accountsCount,
  onRetry,
}: {
  t: TFn;
  loadState: CodexAccountLoadState;
  refreshFailed: boolean;
  accountsCount: number;
  onRetry: () => void;
}): ReactNode {
  // Cold start with no seeded accounts: one skeleton row where the main login will land,
  // inside the same panel body, so nothing below jumps when the real rows mount.
  if (loadState === "loading" && accountsCount === 0) {
    return (
      <div className="codex-auth-load-skeleton acc-row-skeleton" role="status" aria-live="polite" aria-busy="true">
        <div className="card acc-row" aria-hidden="true">
          <div className="acc-row__head flex items-center gap-3">
            <span className="inline-block size-2 rounded-full bg-fg-subtle" />
            <span className="acc-skel h-3.5 w-48 rounded-full" />
            <span className="acc-skel h-4 w-16 rounded-full" />
          </div>
          <div className="acc-row__meters">
            <QuotaBars quota={null} threshold={0} t={t} pending />
          </div>
        </div>
        <span className="sr-only">{t("pws.accountsLoading")}</span>
      </div>
    );
  }
  if (loadState === "error") {
    return (
      <InlineBanner tone="err" role="alert" className="pwi-auth-state pwi-auth-state--error acc-row-banner"
        action={<button type="button" className="btn btn-ghost btn-sm" onClick={onRetry}>{t("pws.retryAccounts")}</button>}>
        {t("codexAuth.loadFailed")}
      </InlineBanner>
    );
  }
  // Rows survived a failed refresh, so they are still worth showing — but they are the ones from
  // before it, and an account added since is simply not among them. A status rather than an alert:
  // nothing on screen is wrong, it is just older than it looks.
  if (refreshFailed && accountsCount > 0) {
    return (
      <InlineBanner tone="warn" role="status" className="pwi-auth-state pwi-auth-state--stale acc-row-banner"
        action={<button type="button" className="btn btn-ghost btn-sm" onClick={onRetry}>{t("pws.retryAccounts")}</button>}>
        {t("codexAuth.accountsRefreshFailed")}
      </InlineBanner>
    );
  }
  return null;
}

/** The "+ Add" for the accounts panel header. */
export function CodexAccountPoolAddButton({ t, onAdd }: { t: TFn; onAdd: () => void }) {
  return (
    <button type="button" className="btn btn-ghost btn-sm acc-add-btn" onClick={onAdd}>
      <IconPlus width={14} /> {t("codexAuth.add")}
    </button>
  );
}
