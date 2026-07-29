import type { ReactNode } from "react";
import { IconLock, IconPause, IconPlay, IconRefresh } from "../icons";
import QuotaBars from "./QuotaBars";
import { CodexTicketBadge } from "./codex-account-pool-helpers";
import type { CodexAccountEntry } from "./codex-account-pool-types";
import type { CodexAccountModeState } from "../codex-multi-state";
import type { TFn } from "../i18n/shared";
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
          {main?.paused && <span className="badge badge-muted">{t("codexAuth.paused")}</span>}
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
        {!main?.paused && !isMainActive && !showReauth && !inCooldown && (
          <button type="button" className="btn btn-ghost btn-sm codex-account-switch" onClick={() => onSwitch(mainSwitchEntry)}>
            {switchActionLabel}
          </button>
        )}
        {onCopyDoctor && oauthHealthShowsDoctor(main?.health?.status) && (
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => onCopyDoctor(mainId)}>
            <span aria-live="polite">{doctorCopyButtonLabel(t, doctorCopyOutcomeFor?.(mainId))}</span>
          </button>
        )}
        {main && (
          <button
            type="button"
            className={`btn btn-sm ${main.paused ? "btn-primary" : "btn-ghost"}`}
            onClick={() => onTogglePause(mainSwitchEntry)}
            disabled={pauseBusy}
          >
            {main.paused ? <IconPlay width={14} /> : <IconPause width={14} />}
            {pauseUpdatingId === "__main__" ? t("common.saving") : t(main.paused ? "codexAuth.resume" : "codexAuth.pause")}
          </button>
        )}
        <span className="card-right"><IconLock width={14} /> {t("codexAuth.appLogin")}</span>
      </div>
      <div className="card-sub">{main?.email || t("codexAuth.appLogin")}{main?.plan ? ` · ${main.plan}` : ""}</div>
      {healthSummary && (
        <div className="card-sub faint">{healthSummary}</div>
      )}
      {main?.paused && <div className="card-sub faint">{t("codexAuth.pausedHint")}</div>}
      {inCooldown && (
        <div className="card-sub faint">{t("pws.healthCooldownHint")}</div>
      )}
      {showReauth
        ? <div className="card-sub faint">{t("codexAuth.mainTokenExpired")}</div>
        : !inCooldown && main?.quota && <QuotaBars quota={main.quota} plan={main.plan} threshold={threshold} t={t} />}
    </div>
  );
}

export function CodexAccountPoolPageHead({
  t,
  embedded,
  refreshingQuota,
  pausingExhausted,
  pauseBusy,
  onRefresh,
  onPauseExhausted,
}: {
  t: TFn;
  embedded: boolean;
  refreshingQuota: boolean;
  pausingExhausted: boolean;
  pauseBusy?: boolean;
  onRefresh: () => void;
  onPauseExhausted: () => void;
}) {
  return (
    <div
      className={embedded ? "row" : "page-head"}
      style={embedded ? { justifyContent: "flex-end", marginBottom: 8 } : undefined}
    >
      {!embedded && <h2 className="page-title">{t("nav.codexAuth")}</h2>}
      <div className="row">
        <button
          type="button"
          className="btn btn-sm btn-ghost"
          onClick={onPauseExhausted}
          disabled={refreshingQuota || pausingExhausted || !!pauseBusy}
        >
          <IconPause width={14} /> {pausingExhausted ? t("codexAuth.pausingExhausted") : t("codexAuth.pauseExhausted")}
        </button>
        <button
          type="button"
          className="btn btn-sm btn-ghost"
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
  return (
    <>
      {loadState === "loading" && accountsCount === 0 && (
        <div className="pwi-auth-state" role="status">{t("pws.accountsLoading")}</div>
      )}
      {loadState === "error" && (
        <div className="pwi-auth-state pwi-auth-state--error" role="alert">
          <span>{t("codexAuth.loadFailed")}</span>
          <button type="button" className="btn btn-ghost btn-sm" onClick={onRetry}>{t("pws.retryAccounts")}</button>
        </div>
      )}
    </>
  );
}
