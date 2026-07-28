import type { ReactNode } from "react";
import { IconLock, IconRefresh } from "../icons";
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
          {healthLabel && (
            <span className={oauthHealthBadgeClass(main?.health?.status)}>{healthLabel}</span>
          )}
          {showReauth && !healthLabel && <span className="badge badge-amber">{t("codexAuth.needsReauth")}</span>}
          <span className={`badge ${isMainActive ? "badge-primary" : "badge-muted"}`}>
            {isMainActive
              ? t(accountModeState === "direct" ? "codexAuth.poolPrepared" : "codexAuth.nextSession")
              : t("codexAuth.current")}
          </span>
        </span>
        {!isMainActive && !showReauth && !inCooldown && (
          <button type="button" className="btn btn-ghost btn-sm codex-account-switch" onClick={() => onSwitch(mainSwitchEntry)}>
            {switchActionLabel}
          </button>
        )}
        {onCopyDoctor && oauthHealthShowsDoctor(main?.health?.status) && (
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => onCopyDoctor(mainId)}>
            <span aria-live="polite">{doctorCopyButtonLabel(t, doctorCopyOutcomeFor?.(mainId))}</span>
          </button>
        )}
        <span className="card-right"><IconLock width={14} /> {t("codexAuth.appLogin")}</span>
      </div>
      <div className="card-sub">{main?.email || t("codexAuth.appLogin")}{main?.plan ? ` · ${main.plan}` : ""}</div>
      {healthSummary && (
        <div className="card-sub faint">{healthSummary}</div>
      )}
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
  onRefresh,
}: {
  t: TFn;
  embedded: boolean;
  refreshingQuota: boolean;
  onRefresh: () => void;
}) {
  if (embedded) return null;
  return (
    <div className="page-head">
      <h2 className="page-title">{t("nav.codexAuth")}</h2>
      <button type="button" className="btn btn-sm btn-ghost" onClick={onRefresh} disabled={refreshingQuota}>
        <IconRefresh width={14} /> {refreshingQuota ? t("codexAuth.refreshingQuota") : t("codexAuth.refreshQuota")}
      </button>
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
