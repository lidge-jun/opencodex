import { useState } from "react";
import { formatAccountPauseTooltip } from "../account-pause-display";
import { useT, useI18n } from "../i18n/shared";
import { useCopyFeedback } from "./use-copy-feedback";
import { IconPause, IconPlay, IconX } from "../icons";
import { displayAccountId } from "../lib/privacy";
import AccountPriorityControl, { AccountPriorityBadge } from "./AccountPriorityControl";
import { DEFAULT_ACCOUNT_PRIORITY, normalizeAccountPriority } from "../account-priority";
import AccountAutoSwitchControl from "./AccountAutoSwitchControl";
import { AccountCreditsToggle, CreditsOnBadge } from "./CodexCreditSpend";
import type { CodexAccountEntry } from "./codex-account-pool-types";
import type { CodexAccountModeState } from "../codex-multi-state";
import QuotaBars from "./QuotaBars";
import { weeklyWindowConflictText } from "../codex-weekly-conflict";
import { AccountMore, AccountRow, AccountSetting } from "./v2-accounts/account-row";
import { InlineBanner } from "./v2-accounts/surface";
import CodexCreditsRow from "./CodexCreditsRow";
import { CodexPauseToggleLabel, CodexPinnedBadge, CodexTicketBadge } from "./codex-account-pool-helpers";
import {
  doctorCopyButtonLabel,
  formatOAuthHealthLabel,
  formatOAuthHealthSummary,
  oauthHealthBadgeClass,
  oauthHealthIsCooldown,
  oauthHealthShowsDoctor,
  oauthHealthShowsReauth,
} from "../oauth-health-display";

export function CodexAccountPoolCards({
  pool,
  creditsVisible,
  loading = false,
  activeId,
  accountModeState,
  switchActionLabel,
  threshold,
  onOpenReset,
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
  onReauth,
  onEditAlias,
  onRemove,
  onToggleCreditsAfterLimit,
  creditsAfterLimitUpdatingId = null,
  onCopyDoctor,
  doctorCopyOutcomeFor,
}: {
  pool: CodexAccountEntry[];
  creditsVisible?: boolean;
  loading?: boolean;
  activeId: string | null;
  accountModeState: CodexAccountModeState | null;
  switchActionLabel: string;
  threshold: number;
  onOpenReset: (account: CodexAccountEntry) => void;
  onSwitch: (account: CodexAccountEntry) => void;
  onTogglePause: (account: CodexAccountEntry) => void;
  pauseUpdatingId: string | null;
  pauseBusy: boolean;
  onPriorityChange: (account: CodexAccountEntry, priority: number) => void;
  priorityUpdatingId: string | null;
  onAutoSwitchThresholdChange: (account: CodexAccountEntry, threshold: number | null) => Promise<boolean>;
  autoSwitchDisabled: boolean;
  /** In-flight manual switch, which writes the same pin an order write clears. */
  switchingId: string | null;
  /**
   * The account an operator pinned by hand, which is not always the selected one: under
   * round-robin and fill-first the pin caps selection at its own tier while the cursor
   * moves inside that tier. Marking the pinned card rather than the selected one keeps the
   * badge on the account the operator actually chose.
   */
  pinnedId?: string | null;
  /** Opens the release confirm for the pinned card: selecting the badge again unpins. */
  onUnpin: (account: CodexAccountEntry) => void;
  onReauth: (id: string) => void;
  onEditAlias: (account: CodexAccountEntry) => void;
  onRemove: (id: string) => void;
  /** Writes one account's "use credits after limit" switch, shown in its "more" disclosure. */
  onToggleCreditsAfterLimit?: (account: CodexAccountEntry, enabled: boolean) => void;
  creditsAfterLimitUpdatingId?: string | null;
  onCopyDoctor?: (accountId: string) => void;
  doctorCopyOutcomeFor?: (accountId: string) => "copied" | "unavailable" | null;
}) {
  const t = useT();
  const { locale } = useI18n();
  const isNext = (account: CodexAccountEntry) => !account.paused && activeId === account.id;
  const idCopy = useCopyFeedback<string>();
  // Which rows have their ⋯ disclosure open; the order select mounts inside it on demand
  // unless the account already carries a non-default order (then it stays mounted, and the
  // order chip on the row says so).
  const [moreOpen, setMoreOpen] = useState<ReadonlySet<string>>(new Set());

  return (
    <>
      {pool.map(a => {
        const showCredits = creditsVisible === true && a.credits !== undefined;
        const healthStatus = a.health?.status;
        const planExcluded = a.selectionExcludedReason === "plan_excluded";
        const showReauth = Boolean(a.needsReauth) || oauthHealthShowsReauth(healthStatus);
        const inCooldown = oauthHealthIsCooldown(healthStatus);
        const weeklyConflictNote = weeklyWindowConflictText(a.weeklyQuotaConflicts, t, locale);
        const validationPending = a.health?.reason === "validation_pending";
        const healthLabel = formatOAuthHealthLabel(t, a.health);
        const healthSummary = formatOAuthHealthSummary(t, "codex", a.id, a.health);
        const next = isNext(a);
        const label = a.alias ?? a.email;
        const showDoctor = onCopyDoctor && oauthHealthShowsDoctor(healthStatus);
        return (
          <AccountRow
            key={a.id}
            active={next}
            paused={a.paused}
            dot={showReauth ? "warn" : a.paused ? "idle" : next ? "active" : "ok"}
            name={label}
            sub={a.alias ? a.email : undefined}
            chips={<>
              {next && !planExcluded && !showReauth && !inCooldown && !validationPending && (
                <span className="badge badge-primary">
                  {t(accountModeState === "direct" ? "codexAuth.poolPrepared" : "codexAuth.nextSession")}
                </span>
              )}
              {a.plan && <span className="badge badge-plan">{a.plan}</span>}
              {planExcluded && (
                <span className="badge badge-muted" title={t("codexAuth.planExcludedHint", { plan: a.selectionExcludedPlan ?? a.plan ?? "" })}>
                  {t("codexAuth.planExcluded")}
                </span>
              )}
              {a.paused && (
                <span className="badge badge-muted" title={a.pauseDetails ? formatAccountPauseTooltip(t, locale, a.pauseDetails) : t("codexAuth.pausedHint")}>
                  {t("codexAuth.paused")}
                </span>
              )}
              <AccountPriorityBadge value={a.priority} />
              <CreditsOnBadge enabled={a.creditsAfterLimit} />
              {a.id === pinnedId && !a.paused && <CodexPinnedBadge t={t} onUnpin={() => onUnpin(a)} />}
              <CodexTicketBadge t={t} account={a} onClick={() => onOpenReset(a)} />
              {healthLabel && (
                <span className={oauthHealthBadgeClass(healthStatus)}>{healthLabel}</span>
              )}
              {showReauth && !healthLabel && <span className="badge badge-amber">{t("codexAuth.needsReauth")}</span>}
            </>}
            actions={<>
              {!a.paused && !planExcluded && (!next || pinnedId !== a.id) && !showReauth && !inCooldown && !validationPending && (
                <button type="button" className="btn btn-ghost btn-sm codex-account-switch" onClick={() => onSwitch(a)}>
                  {switchActionLabel}
                </button>
              )}
              {showReauth && (
                <button type="button" className="btn btn-primary btn-sm" onClick={() => onReauth(a.id)}>
                  {t("codexAuth.reauthenticate")}
                </button>
              )}
              <button
                type="button"
                className="acc-icon-btn codex-auth-action-btn"
                onClick={() => onTogglePause(a)}
                disabled={pauseBusy}
                aria-busy={pauseUpdatingId === a.id || undefined}
                title={a.paused ? t("codexAuth.pausedHint") : t("codexAuth.pause")}
                aria-label={a.paused ? `${t("codexAuth.resume")}. ${t("codexAuth.pausedHint")}` : t("codexAuth.pause")}
              >
                {a.paused ? <IconPlay width={15} /> : <IconPause width={15} />}
                <span className="sr-only">
                  <CodexPauseToggleLabel t={t} paused={a.paused} saving={pauseUpdatingId === a.id} />
                </span>
              </button>
            </>}
            more={
              /*
                Rarely used settings fold into a labelled disclosure (aria-expanded from the
                native details; controls revealed inline, DOM tab order — not a menu role).
                Switch/pause/reauth stay on the row: those are the daily decisions.
              */
              <AccountMore
                label={`${t("codexAuth.moreActions")} — ${a.email}`}
                title={t("codexAuth.moreActions")}
                open={moreOpen.has(a.id)}
                onToggle={open => setMoreOpen(prev => { const nextSet = new Set(prev); if (open) nextSet.add(a.id); else nextSet.delete(a.id); return nextSet; })}
              >
                {(normalizeAccountPriority(a.priority) !== DEFAULT_ACCOUNT_PRIORITY || moreOpen.has(a.id)) && (
                  <AccountSetting>
                    <AccountPriorityControl
                      value={a.priority}
                      selectId={`codex-account-priority-${a.id}`}
                      // Every row, not just the one being written: the controller serializes order
                      // writes behind one mutation ref, so a second row's pick would come back "busy"
                      // and be dropped with no toast. Same global lock the pause button uses.
                      // A pending switch counts too — it writes the same pin this clears, so the
                      // controller refuses to overlap them, and that refusal is equally silent.
                      disabled={priorityUpdatingId !== null || switchingId !== null}
                      onChange={(priority) => onPriorityChange(a, priority)}
                    />
                  </AccountSetting>
                )}
                <AccountSetting>
                  <AccountAutoSwitchControl
                    key={a.id}
                    accountLabel={label}
                    globalThreshold={threshold}
                    override={a.autoSwitchThresholdOverride}
                    inputId={`codex-account-auto-switch-${a.id}`}
                    disabled={autoSwitchDisabled}
                    onChange={(next) => onAutoSwitchThresholdChange(a, next)}
                  />
                </AccountSetting>
                {onToggleCreditsAfterLimit && (
                  <AccountSetting>
                    <AccountCreditsToggle
                      accountLabel={label}
                      enabled={a.creditsAfterLimit}
                      saving={creditsAfterLimitUpdatingId === a.id}
                      disabled={creditsAfterLimitUpdatingId !== null}
                      onChange={enabled => onToggleCreditsAfterLimit(a, enabled)}
                    />
                  </AccountSetting>
                )}
                <AccountSetting label={<span className="mono">{t("prov.accountId")}: {displayAccountId(a.id)}</span>}>
                  <button type="button" className="btn btn-ghost btn-sm" onClick={() => idCopy.copy(a.id, a.id)}>
                    {idCopy.outcomeFor(a.id) === "copied" ? t("startup.copied") : t("codexAuth.copyId")}
                  </button>
                  <button type="button" className="btn btn-ghost btn-sm" onClick={() => void onEditAlias(a)}>
                    {t("prov.editAlias")}
                  </button>
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm acc-danger-btn"
                    aria-label={`${t("common.remove")} — ${a.email}`}
                    title={`${t("common.remove")} — ${a.email}`}
                    onClick={e => { e.stopPropagation(); void onRemove(a.id); }}
                  >
                    <IconX width={14} /> {t("common.remove")}
                  </button>
                </AccountSetting>
              </AccountMore>
            }
          >
            {(healthSummary || inCooldown || showReauth) && (
              <div className="acc-row__notes">
                {healthSummary && (
                  <div className="card-sub faint">
                    <span>{healthSummary}</span>
                    {showDoctor && (
                      <button type="button" className="link-btn codex-auth-action-btn" onClick={() => onCopyDoctor(a.id)}>
                        <span aria-live="polite">{doctorCopyButtonLabel(t, doctorCopyOutcomeFor?.(a.id))}</span>
                      </button>
                    )}
                  </div>
                )}
                {!healthSummary && showDoctor && (
                  <div className="card-sub faint">
                    <button type="button" className="link-btn codex-auth-action-btn" onClick={() => onCopyDoctor(a.id)}>
                      <span aria-live="polite">{doctorCopyButtonLabel(t, doctorCopyOutcomeFor?.(a.id))}</span>
                    </button>
                  </div>
                )}
                {inCooldown && <div className="card-sub faint">{t("pws.healthCooldownHint")}</div>}
                {showReauth && <div className="card-sub faint">{t("codexAuth.tokenExpired")}</div>}
              </div>
            )}
            {!showReauth && !inCooldown && (
              <div className="acc-row__meters">
                <QuotaBars
                  quota={a.quota}
                  plan={a.plan}
                  threshold={a.autoSwitchThresholdOverride ?? threshold}
                  t={t}
                  pending={a.quota == null && (loading || !showCredits)}
                  afterWeekly={showCredits && !loading ? <CodexCreditsRow credits={a.credits} t={t} locale={locale} /> : undefined}
                />
                {weeklyConflictNote && <div className="card-sub text-warning" role="note">{weeklyConflictNote}</div>}
              </div>
            )}
          </AccountRow>
        );
      })}
    </>
  );
}

export function CodexAccountPoolReauthBanner({
  onReauth,
}: {
  onReauth: () => void;
}) {
  const t = useT();
  return (
    <InlineBanner tone="warn" className="acc-row-banner" action={
      <button type="button" className="btn btn-primary btn-sm" onClick={onReauth}>
        {t("codexAuth.reauthenticate")}
      </button>
    }>
      {t("codexAuth.tokenExpired")}
    </InlineBanner>
  );
}
