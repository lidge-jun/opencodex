/**
 * ProviderAccountCard.tsx — Presentation card for one OAuth account with detailed or
 * compact view, displaying full Gemini and Claude quota windows, unclipped login,
 * one-click copy, brand headroom badges, and active account pulse indicator.
 */
import { useState } from "react";
import { copyTextToClipboard } from "../../oauth-health-display";
import { useT, useI18n } from "../../i18n/shared";
import { IconPencil, IconRefresh, IconTrash } from "../../icons";
import { formatResetFuture } from "../QuotaBars";
import type {
  AnalyzedAccountQuota,
  AccountDisplayKey,
  AccountViewModeKey,
} from "./account-quota-analysis";
import type { OAuthAccountRow } from "./types";
import { displayAccountId } from "../../lib/privacy";

export interface ProviderAccountCardProps {
  analyzed: AnalyzedAccountQuota;
  viewMode: AccountViewModeKey;
  titleMode: AccountDisplayKey;
  switching: boolean;
  disabled: boolean;
  refreshing: boolean;
  onSwitch: (account: OAuthAccountRow) => void;
  onRefreshSingle?: (account: OAuthAccountRow) => void;
  onEditAlias: (account: OAuthAccountRow) => void;
  onRemove: (account: OAuthAccountRow) => void;
  onReauth?: (account: OAuthAccountRow) => void;
}

export default function ProviderAccountCard({
  analyzed,
  viewMode,
  titleMode,
  switching,
  disabled,
  refreshing,
  onSwitch,
  onRefreshSingle,
  onEditAlias,
  onRemove,
  onReauth,
}: ProviderAccountCardProps) {
  const t = useT();
  const { locale } = useI18n();
  const { account } = analyzed;
  const active = account.active;
  const showReauth = Boolean(account.needsReauth) || account.health?.status === "reauth_required";

  const [copied, setCopied] = useState(false);

  const maskedId = displayAccountId(account.id);
  const primaryTitle = titleMode === "login"
    ? analyzed.emailLogin
    : titleMode === "masked"
      ? (analyzed.maskedLogin || analyzed.emailLogin)
      : (account.alias?.trim() || analyzed.emailLogin);

  const hasCustomAlias = Boolean(
    account.alias &&
    account.alias.trim() !== "" &&
    account.alias.trim() !== analyzed.emailLogin &&
    account.alias.trim() !== account.email
  );

  const secondarySub = titleMode === "masked"
    ? `${t("prov.accountId")}: ${maskedId}`
    : titleMode === "login"
      ? (hasCustomAlias ? `${account.alias} · ${t("prov.accountId")}: ${maskedId}` : `${t("prov.accountId")}: ${maskedId}`)
      : (hasCustomAlias ? `${analyzed.emailLogin} · ${t("prov.accountId")}: ${maskedId}` : `${t("prov.accountId")}: ${maskedId}`);

  const handleCopy = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (primaryTitle) {
      void copyTextToClipboard(primaryTitle).then(success => {
        if (!success) return;
        setCopied(true);
        setTimeout(() => setCopied(false), 1400);
      });
    }
  };

  const renderSingleQuotaBar = (label: string, percent: number | undefined, resetAt: number | undefined) => {
    if (percent === undefined) return null;
    const rounded = Math.round(percent);
    const isFull = rounded >= 100 || percent >= 99.5;
    const resetText = resetAt ? formatResetFuture(resetAt, t, locale) : "";
    const freeText = isFull
      ? t("pws.limitExhaustedBadge")
      : t("pws.freeHeadroom", { percent: Math.max(0, 100 - rounded) });

    return (
      <div className="pwi-quota-item">
        <div className="pwi-quota-item-head">
          <span className={`pwi-quota-title${isFull ? " pwi-quota-warn" : ""}`}>
            {label}
          </span>
          {resetText && <span className="pwi-quota-reset">{resetText}</span>}
        </div>
        <div className="pwi-quota-track">
          <div
            className={`pwi-quota-fill${isFull ? " pwi-fill-warn" : ""}`}
            style={{ width: `${Math.min(100, percent)}%` }}
          />
        </div>
        <div className="pwi-quota-item-foot">
          <span className="pwi-quota-used">{t("quota.usedPercent", { pct: rounded })}</span>
          <span className={`pwi-quota-free${isFull ? " pwi-quota-warn" : ""}`}>
            {freeText}
          </span>
        </div>
      </div>
    );
  };

  if (viewMode === "compact") {
    return (
      <div className={`pwi-card-dense${active ? " pwi-card-dense--active" : ""}`}>
        <div className="pwi-dense-top">
          <div className="pwi-dense-id-group">
            <button
              type="button"
              className="pwi-dense-select-btn"
              disabled={disabled || active}
              onClick={() => onSwitch(account)}
              title={active ? t("prov.accountActive") : t("pws.switchToAccount")}
            >
              <span className={`pwi-auth-dot ${active ? "pwi-auth-dot--ok pwi-auth-dot--active-pulse" : "pwi-auth-dot--off"}`} aria-hidden="true" />
              <span className="pwi-dense-title">{primaryTitle}</span>
              <span className="pwi-dense-click-target-fill" aria-hidden="true" />
            </button>
            <button
              type="button"
              className="pwi-copy-mini-btn"
              onClick={handleCopy}
              title={copied ? t("startup.copied") : t("startup.copy")}
              aria-label={t("startup.copy")}
            >
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>
            </button>
            {copied && <span className="pwi-copied-mini-badge">{t("startup.copied")}</span>}
          </div>

          <div className="pwi-dense-actions">
            {showReauth && onReauth && (
              <button type="button" className="btn btn-primary btn-xs" onClick={() => onReauth(account)}>
                {t("pws.reauthenticate")}
              </button>
            )}
            {onRefreshSingle && (
              <button
                type="button"
                className="btn btn-ghost btn-xs pwi-icon-btn"
                title={t("pws.refreshAccountQuota")}
                disabled={refreshing || disabled}
                onClick={() => onRefreshSingle(account)}
              >
                <IconRefresh width={12} height={12} className={refreshing ? "pwi-spin-inline" : ""} aria-hidden="true" />
              </button>
            )}
            <button
              type="button"
              className="btn btn-ghost btn-xs pwi-icon-btn"
              onClick={() => onEditAlias(account)}
              title={t("prov.editAlias")}
              aria-label={t("prov.editAlias")}
            >
              <IconPencil width={11} height={11} aria-hidden="true" />
            </button>
            <button
              type="button"
              className="btn btn-ghost btn-xs pwi-remove-btn"
              title={t("pws.removeAccountTooltip")}
              onClick={() => onRemove(account)}
            >
              <IconTrash width={12} height={12} aria-hidden="true" />
            </button>
          </div>
        </div>

        {/* Compact Bar Columns: Clean Gemini/Claude headers & round % */}
        <div className="pwi-dense-bars-grid">
          {/* Gemini */}
          {(analyzed.gemini5h || analyzed.geminiWeekly) && (
            <div className="pwi-dense-col">
              <div className="pwi-dense-col-title">
                <span className="pwi-brand-badge-title">
                  <span className="pwi-brand-dot blue">●</span>
                  <span>{t("pws.modelGemini")}</span>
                </span>
                <span className={`pwi-headroom-pill-mini ${analyzed.geminiExhausted ? "warn" : "ok"}`}>
                  {analyzed.geminiExhausted ? t("pws.limitExhaustedBadge") : t("pws.freeHeadroom", { percent: Math.max(0, 100 - analyzed.geminiUsedMax) })}
                </span>
              </div>
              {analyzed.gemini5h && (
                <div className="pwi-dense-mini-row">
                  <div className="pwi-dense-mini-label">
                    <span className="pwi-dense-window-name">{t("pws.gemini5hLabel")} ({Math.round(analyzed.gemini5h.percent)}%)</span>
                    <span className="pwi-dense-reset-time">{analyzed.gemini5h.resetAt ? formatResetFuture(analyzed.gemini5h.resetAt, t, locale) : ""}</span>
                  </div>
                  <div className="pwi-dense-mini-track">
                    <div className={`pwi-dense-mini-fill${Math.round(analyzed.gemini5h.percent) >= 100 ? " pwi-fill-warn" : ""}`} style={{ width: `${Math.min(100, Math.round(analyzed.gemini5h.percent))}%` }} />
                  </div>
                </div>
              )}
              {analyzed.geminiWeekly && (
                <div className="pwi-dense-mini-row">
                  <div className="pwi-dense-mini-label">
                    <span className="pwi-dense-window-name">{t("pws.geminiWeeklyLabel")} ({Math.round(analyzed.geminiWeekly.percent)}%)</span>
                    <span className="pwi-dense-reset-time">{analyzed.geminiWeekly.resetAt ? formatResetFuture(analyzed.geminiWeekly.resetAt, t, locale) : ""}</span>
                  </div>
                  <div className="pwi-dense-mini-track">
                    <div className={`pwi-dense-mini-fill${Math.round(analyzed.geminiWeekly.percent) >= 100 ? " pwi-fill-warn" : ""}`} style={{ width: `${Math.min(100, Math.round(analyzed.geminiWeekly.percent))}%` }} />
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Claude */}
          {(analyzed.claude5h || analyzed.claudeWeekly) && (
            <div className="pwi-dense-col">
              <div className="pwi-dense-col-title">
                <span className="pwi-brand-badge-title">
                  <span className="pwi-brand-dot orange">●</span>
                  <span>{t("pws.modelClaude")}</span>
                </span>
                <span className={`pwi-headroom-pill-mini ${analyzed.claudeExhausted ? "warn" : "ok"}`}>
                  {analyzed.claudeExhausted ? t("pws.limitExhaustedBadge") : t("pws.freeHeadroom", { percent: Math.max(0, 100 - analyzed.claudeUsedMax) })}
                </span>
              </div>
              {analyzed.claude5h && (
                <div className="pwi-dense-mini-row">
                  <div className="pwi-dense-mini-label">
                    <span className="pwi-dense-window-name">{t("pws.claude5hLabel")} ({Math.round(analyzed.claude5h.percent)}%)</span>
                    <span className="pwi-dense-reset-time">{analyzed.claude5h.resetAt ? formatResetFuture(analyzed.claude5h.resetAt, t, locale) : ""}</span>
                  </div>
                  <div className="pwi-dense-mini-track">
                    <div className={`pwi-dense-mini-fill${Math.round(analyzed.claude5h.percent) >= 100 ? " pwi-fill-warn" : ""}`} style={{ width: `${Math.min(100, Math.round(analyzed.claude5h.percent))}%` }} />
                  </div>
                </div>
              )}
              {analyzed.claudeWeekly && (
                <div className="pwi-dense-mini-row">
                  <div className="pwi-dense-mini-label">
                    <span className="pwi-dense-window-name">{t("pws.claudeWeeklyLabel")} ({Math.round(analyzed.claudeWeekly.percent)}%)</span>
                    <span className="pwi-dense-reset-time">{analyzed.claudeWeekly.resetAt ? formatResetFuture(analyzed.claudeWeekly.resetAt, t, locale) : ""}</span>
                  </div>
                  <div className="pwi-dense-mini-track">
                    <div className={`pwi-dense-mini-fill${Math.round(analyzed.claudeWeekly.percent) >= 100 ? " pwi-fill-warn" : ""}`} style={{ width: `${Math.min(100, Math.round(analyzed.claudeWeekly.percent))}%` }} />
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Generic fallback */}
          {!analyzed.gemini5h && !analyzed.geminiWeekly && !analyzed.claude5h && !analyzed.claudeWeekly && (
            <div className="pwi-dense-col" style={{ gridColumn: "span 2" }}>
              {renderSingleQuotaBar(t("pws.window5hLabel"), analyzed.generic5h?.percent, analyzed.generic5h?.resetAt)}
              {renderSingleQuotaBar(t("pws.windowWeeklyLabel"), analyzed.genericWeekly?.percent, analyzed.genericWeekly?.resetAt)}
            </div>
          )}
        </div>
      </div>
    );
  }

  // Cards view
  return (
    <div className={`pwi-account-card${active ? " pwi-account-card--active" : ""}${analyzed.fullyExhausted ? " pwi-account-card--exhausted" : ""}`}>
      <div className="pwi-card-header">
        <div className="pwi-card-id-row">
          <button
            type="button"
            className="pwi-card-select-trigger"
            disabled={disabled || active}
            onClick={() => onSwitch(account)}
            title={active ? t("prov.accountActive") : t("pws.switchToAccount")}
          >
            <span className={`pwi-auth-dot ${active ? "pwi-auth-dot--ok pwi-auth-dot--active-pulse" : "pwi-auth-dot--off"}`} aria-hidden="true" />
            <div className="pwi-card-title-block">
              <div className="pwi-card-title-line">
                <span className="pwi-card-title">{primaryTitle}</span>
                {switching && <span className="badge badge-muted">{t("pws.accountSwitching")}</span>}
              </div>
              <span className="pwi-card-sub">{secondarySub}</span>
            </div>
          </button>
          <button
            type="button"
            className="pwi-copy-mini-btn"
            onClick={handleCopy}
            title={copied ? t("startup.copied") : t("startup.copy")}
            aria-label={t("startup.copy")}
          >
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>
          </button>
          {copied && <span className="pwi-copied-mini-badge">{t("startup.copied")}</span>}
        </div>

        <div className="pwi-card-controls">
          {showReauth && onReauth && (
            <button type="button" className="btn btn-primary btn-sm" onClick={() => onReauth(account)}>
              {t("pws.reauthenticate")}
            </button>
          )}
          {onRefreshSingle && (
            <button
              type="button"
              className="btn btn-ghost btn-sm pwi-icon-btn"
              title={t("pws.refreshAccountQuota")}
              disabled={refreshing || disabled || switching}
              onClick={() => onRefreshSingle(account)}
            >
              <IconRefresh width={13} height={13} className={refreshing ? "pwi-spin-inline" : ""} aria-hidden="true" />
            </button>
          )}
          <button
            type="button"
            className="btn btn-ghost btn-sm pwi-action-alias"
            onClick={() => onEditAlias(account)}
            title={t("prov.editAlias")}
            aria-label={t("prov.editAlias")}
            style={{ display: "inline-flex", alignItems: "center", gap: "6px" }}
          >
            <IconPencil width={12} height={12} aria-hidden="true" />
            <span className="pwi-action-alias-text">{t("pws.aliasShort")}</span>
          </button>
          <button
            type="button"
            className="btn btn-ghost btn-sm pwi-remove-btn"
            title={t("pws.removeAccountTooltip")}
            disabled={disabled || switching}
            onClick={() => onRemove(account)}
          >
            <IconTrash width={13} height={13} aria-hidden="true" />
          </button>
        </div>
      </div>



      {/* 2-Column Quotas for Gemini and Claude */}
      <div className="pwi-card-quotas-grid">
        {(analyzed.gemini5h || analyzed.geminiWeekly) && (
          <div className="pwi-quota-col">
            <div className="pwi-quota-col-head">
              <span className="pwi-brand-badge-title">
                <span className="pwi-brand-dot blue">●</span>
                <span>{t("pws.modelGemini")}</span>
              </span>
              <span className={`pwi-headroom-pill ${analyzed.geminiExhausted ? "warn" : "ok"}`}>
                {analyzed.geminiExhausted ? t("pws.limitExhaustedBadge") : t("pws.freeHeadroom", { percent: Math.max(0, 100 - analyzed.geminiUsedMax) })}
              </span>
            </div>
            {analyzed.gemini5h && renderSingleQuotaBar(t("pws.gemini5hLabel"), analyzed.gemini5h.percent, analyzed.gemini5h.resetAt)}
            {analyzed.geminiWeekly && renderSingleQuotaBar(t("pws.geminiWeeklyLabel"), analyzed.geminiWeekly.percent, analyzed.geminiWeekly.resetAt)}
          </div>
        )}

        {(analyzed.claude5h || analyzed.claudeWeekly) && (
          <div className="pwi-quota-col">
            <div className="pwi-quota-col-head">
              <span className="pwi-brand-badge-title">
                <span className="pwi-brand-dot orange">●</span>
                <span>{t("pws.modelClaude")}</span>
              </span>
              <span className={`pwi-headroom-pill ${analyzed.claudeExhausted ? "warn" : "ok"}`}>
                {analyzed.claudeExhausted ? t("pws.limitExhaustedBadge") : t("pws.freeHeadroom", { percent: Math.max(0, 100 - analyzed.claudeUsedMax) })}
              </span>
            </div>
            {analyzed.claude5h && renderSingleQuotaBar(t("pws.claude5hLabel"), analyzed.claude5h.percent, analyzed.claude5h.resetAt)}
            {analyzed.claudeWeekly && renderSingleQuotaBar(t("pws.claudeWeeklyLabel"), analyzed.claudeWeekly.percent, analyzed.claudeWeekly.resetAt)}
          </div>
        )}

        {!analyzed.gemini5h && !analyzed.geminiWeekly && !analyzed.claude5h && !analyzed.claudeWeekly && (
          <div className="pwi-quota-col" style={{ gridColumn: "span 2" }}>
            {renderSingleQuotaBar("5-Hour", analyzed.generic5h?.percent, analyzed.generic5h?.resetAt)}
            {renderSingleQuotaBar(t("pws.windowWeeklyLabel"), analyzed.genericWeekly?.percent, analyzed.genericWeekly?.resetAt)}
          </div>
        )}
      </div>
    </div>
  );
}
