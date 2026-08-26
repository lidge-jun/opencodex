import type { ReactNode } from "react";
import { IconLock, IconPause, IconPlay, IconPlus, IconRefresh, IconTicket } from "../icons";
import AccountPriorityControl, { AccountPriorityBadge } from "./AccountPriorityControl";
import QuotaBars from "./QuotaBars";
import { CodexPauseToggleLabel, CodexTicketBadge } from "./codex-account-pool-helpers";
import type { CodexAccountEntry } from "./codex-account-pool-types";
import type { CodexAccountModeState } from "../codex-multi-state";
import type { TFn } from "../i18n/shared";
import type { NoticeTone } from "../ui";
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
  switchingId,
  pinnedId = null,
  onOpenReset,
  onCopyDoctor,
  doctorCopyOutcomeFor,
}: {
  t: TFn;
  main: CodexAccountEntry | undefined;
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
  /** In-flight manual switch, which writes the same pin an order write clears. */
  switchingId: string | null;
  /**
   * The account carrying the pin, which is not always the one routing is on: the pin caps
   * selection at its own tier, and under round-robin or fill-first the cursor still moves
   * within that tier. Badge the account the operator chose, not wherever routing landed.
   */
  pinnedId?: string | null;
  onOpenReset: (account: CodexAccountEntry) => void;
  onCopyDoctor?: (accountId: string) => void;
  doctorCopyOutcomeFor?: (accountId: string) => "copied" | "unavailable" | null;
}) {
  const mainFallbackLabel = t("codexAuth.codexApp");
  const mainId = main?.id ?? "__main__";
  const mainSwitchEntry: CodexAccountEntry = {
    id: "__main__",
    email: main?.email || mainFallbackLabel,
    plan: main?.plan,
    isMain: true,
    paused: main?.paused ?? false,
    priority: main?.priority ?? 0,
    hasCredential: true,
    quota: main?.quota ?? null,
  };
  const showReauth = Boolean(main?.needsReauth) || oauthHealthShowsReauth(main?.health?.status);
  const inCooldown = oauthHealthIsCooldown(main?.health?.status);
  const healthLabel = formatOAuthHealthLabel(t, main?.health);
  const healthSummary = main
    ? formatOAuthHealthSummary(t, "codex", mainId, main.health)
    : null;

  return (
    <div className={`card ${isMainActive ? "card-active" : ""}`} style={{ marginBottom: 12 }}>
      <div className="card-head">
        <span className={`dot ${showReauth ? "dot-amber" : "dot-green"}`} />
        <strong>{t("codexAuth.mainAccount")}</strong>
        <span className="card-badges">
          {main && <CodexTicketBadge t={t} account={{ ...main, id: "__main__" } as CodexAccountEntry} onClick={() => onOpenReset({ ...main, id: "__main__" } as CodexAccountEntry)} />}
          {main?.paused && (
            <span className="badge badge-muted" title={t("codexAuth.pausedHint")}>
              {t("codexAuth.paused")}
            </span>
          )}
          <AccountPriorityBadge value={mainSwitchEntry.priority} />
          {pinnedId === "__main__" && !main?.paused && <span className="badge badge-muted">{t("codexAuth.pinned")}</span>}
          {healthLabel && (
            <span className={oauthHealthBadgeClass(main?.health?.status)}>{healthLabel}</span>
          )}
          {showReauth && !healthLabel && <span className="badge badge-amber">{t("codexAuth.needsReauth")}</span>}
          {!main?.paused && (
            <span className={`badge ${isMainActive ? "badge-primary" : "badge-muted"}`}>
              {isMainActive
                ? t(accountModeState === "direct" ? "codexAuth.poolPrepared" : "codexAuth.nextSession")
                : t("codexAuth.current")}
            </span>
          )}
        </span>
        {!main?.paused && (!isMainActive || pinnedId !== "__main__") && !showReauth && !inCooldown && (
          <button type="button" className="btn btn-ghost btn-sm codex-account-switch" onClick={() => onSwitch(mainSwitchEntry)}>
            {switchActionLabel}
          </button>
        )}
        {onCopyDoctor && oauthHealthShowsDoctor(main?.health?.status) && (
          <button type="button" className="btn btn-ghost btn-sm codex-auth-action-btn" onClick={() => onCopyDoctor(mainId)}>
            <span aria-live="polite">{doctorCopyButtonLabel(t, doctorCopyOutcomeFor?.(mainId))}</span>
          </button>
        )}
        {main && (
          <button
            type="button"
            className="btn btn-sm btn-ghost codex-auth-action-btn"
            onClick={() => onTogglePause(mainSwitchEntry)}
            disabled={pauseBusy}
            title={main.paused ? t("codexAuth.pausedHint") : undefined}
            aria-label={main.paused ? `${t("codexAuth.resume")}. ${t("codexAuth.pausedHint")}` : t("codexAuth.pause")}
          >
            {main.paused ? <IconPlay width={14} /> : <IconPause width={14} />}
            <CodexPauseToggleLabel
              t={t}
              paused={!!main.paused}
              saving={pauseUpdatingId === "__main__"}
            />
          </button>
        )}
        <span className="card-right"><IconLock width={14} /> {t("codexAuth.appLogin")}</span>
      </div>
      <div className="codex-account-identity">
        <div className="codex-account-identity-copy">{main?.email || t("codexAuth.appLogin")}{main?.plan ? ` · ${main.plan}` : ""}</div>
        {main && (
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
        )}
      </div>
      {healthSummary && (
        <div className="card-sub faint">{healthSummary}</div>
      )}
      {inCooldown && (
        <div className="card-sub faint">{t("pws.healthCooldownHint")}</div>
      )}
      {showReauth
        ? <div className="card-sub faint">{t("codexAuth.mainTokenExpired")}</div>
        : !inCooldown && (
          <QuotaBars
            quota={main?.quota ?? null}
            plan={main?.plan}
            threshold={threshold}
            t={t}
            pending={main != null && main.quota == null}
          />
        )}
    </div>
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
  sparkVisible,
  sparkBusy,
  onToggleSpark,
}: {
  t: TFn;
  embedded: boolean;
  refreshingQuota: boolean;
  pausingExhausted: boolean;
  pauseBusy?: boolean;
  actionFeedback?: string | null;
  actionFeedbackTone?: NoticeTone | null;
  onRefresh: () => void;
  onPauseExhausted: () => void;
  /** undefined until the preference has loaded, so the switch never renders a guessed state. */
  sparkVisible?: boolean;
  sparkBusy?: boolean;
  onToggleSpark?: () => void;
}) {
  return (
    <div
      className={embedded ? "row" : "page-head codex-auth-page-head"}
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
        {sparkVisible !== undefined && onToggleSpark && (
          <span className="codex-auth-spark-toggle">
            <span className="codex-auth-spark-toggle__label">{t("codexAuth.sparkQuota")}</span>
            <button
              type="button"
              className={`toggle ${sparkVisible ? "on" : ""}`}
              onClick={onToggleSpark}
              disabled={!!sparkBusy}
              aria-pressed={sparkVisible}
              aria-label={t("codexAuth.sparkQuota")}
              title={t("codexAuth.sparkQuotaHint")}
            >
              <span className="toggle-knob" />
            </button>
          </span>
        )}
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
          <IconRefresh width={14} /> {refreshingQuota ? t("codexAuth.refreshingQuota") : t("codexAuth.refreshQuota")}
        </button>
      </div>
    </div>
  );
}

export function CodexAccountPoolLoadStates({
  t,
  loadState,
  accountsCount,
  onRetry,
}: {
  t: TFn;
  loadState: "loading" | "ready" | "error";
  accountsCount: number;
  onRetry: () => void;
}): ReactNode {
  // Cold start with no seeded accounts: mirror the ready layout (main card + pool
  // section + empty) so Auto-switch / strategy do not jump when real nodes mount.
  // Caller places this below the stable account-mode banner.
  if (loadState === "loading" && accountsCount === 0) {
    return (
      <div className="codex-auth-load-skeleton" role="status" aria-live="polite" aria-busy="true">
        {/* Match ready MainCard chrome (badge + pause + app-login) so head height does not jump. */}
        <div className="card codex-auth-load-skeleton__main" style={{ marginBottom: 12 }} aria-hidden="true">
          <div className="card-head">
            <span className="dot dot-muted" />
            <strong>{t("codexAuth.mainAccount")}</strong>
            <span className="card-badges">
              <span className="badge badge-muted codex-ticket-badge-slot" aria-hidden="true">
                <IconTicket width={12} />0
              </span>
              <span className="badge badge-primary">{t("codexAuth.nextSession")}</span>
            </span>
            <button type="button" className="btn btn-sm btn-ghost" tabIndex={-1} disabled>
              <IconPause width={14} /> {t("codexAuth.pause")}
            </button>
            <span className="card-right"><IconLock width={14} /> {t("codexAuth.appLogin")}</span>
          </div>
          <div className="card-sub">
            {/* Strut keeps the sub line-box equal to ready email/plan text; shimmer is visual only. */}
            <span className="codex-auth-load-skeleton__strut">{t("codexAuth.appLogin")}</span>
            <span className="codex-auth-load-skeleton__line codex-auth-load-skeleton__line--sub" />
          </div>
          <QuotaBars quota={null} threshold={0} t={t} pending />
        </div>
        <div className="section-sep" aria-hidden="true">
          <span className="section-label">{t("codexAuth.accountPool")}</span>
          <div className="sep-line" />
          {/* Same Add control as ready section-sep (inert) so the row height matches. */}
          <button type="button" className="btn btn-sm btn-ghost" tabIndex={-1} disabled>
            <IconPlus width={14} /> {t("codexAuth.add")}
          </button>
        </div>
        <div className="empty codex-auth-pool-empty codex-auth-load-skeleton__empty" aria-hidden="true">
          <div className="title">{t("codexAuth.noPool")}</div>
        </div>
        <span className="sr-only">{t("pws.accountsLoading")}</span>
      </div>
    );
  }
  if (loadState === "error") {
    return (
      <div className="pwi-auth-state pwi-auth-state--error" role="alert">
        <span>{t("codexAuth.loadFailed")}</span>
        <button type="button" className="btn btn-ghost btn-sm" onClick={onRetry}>{t("pws.retryAccounts")}</button>
      </div>
    );
  }
  return null;
}
