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
import { GrokCouponBadge } from "./GrokResetCoupons";
import type { GrokCouponEntry } from "../../hooks/useGrokResetCoupons";
import { AnthropicGrantBadge } from "./AnthropicResetGrants";
import type { AnthropicGrantEntry } from "../../hooks/useAnthropicResetGrants";
import ProviderAccountQuota from "./ProviderAccountQuota";

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
  grokCouponEntry?: GrokCouponEntry | undefined;
  onGrokCouponClick?: (account: OAuthAccountRow) => void;
  grantEntry?: AnthropicGrantEntry | undefined;
  onGrantClick?: (account: OAuthAccountRow) => void;
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
  grokCouponEntry,
  onGrokCouponClick,
  grantEntry,
  onGrantClick,
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

  const isAntigravity = analyzed.isAntigravity;
  const gemini5hPercent = analyzed.gemini5h?.percent;
  const geminiWeeklyPercent = analyzed.geminiWeekly?.percent;
  const claude5hPercent = analyzed.claude5h?.percent;
  const claudeWeeklyPercent = analyzed.claudeWeekly?.percent;
  const geminiHasData = gemini5hPercent !== undefined || geminiWeeklyPercent !== undefined;
  const claudeHasData = claude5hPercent !== undefined || claudeWeeklyPercent !== undefined;

  const plan = account.plan;
  const planTier = !plan
    ? null
    : plan.includes("Ultra") ? "ultra"
      : plan.includes("Pro") ? "pro"
        : plan.includes("Enterprise") ? "enterprise"
          : "other";
  const planBadge = plan && planTier ? (
    <span className={`pwi-account-plan-badge pwi-plan--${planTier}`} title={plan}>
      {planTier === "ultra" ? `👑 ${t("pws.plan.ultra")}`
        : planTier === "pro" ? `⭐ ${t("pws.plan.pro")}`
          : planTier === "enterprise" ? `🏢 ${t("pws.plan.enterprise")}`
            : plan}
    </span>
  ) : null;

  const geminiExhaustedLabel = !geminiHasData
    ? "—"
    : (gemini5hPercent !== undefined && gemini5hPercent >= 99.5 && geminiWeeklyPercent !== undefined && geminiWeeklyPercent >= 99.5)
      ? t("pws.limitExhaustedBadge")
      : (geminiWeeklyPercent !== undefined && geminiWeeklyPercent >= 99.5)
        ? t("pws.limitWeeklyExhaustedBadge")
        : (gemini5hPercent !== undefined && gemini5hPercent >= 99.5)
          ? t("pws.limit5hExhaustedBadge")
          : t("pws.freeHeadroom", { percent: Math.max(0, 100 - analyzed.geminiUsedMax) });

  const claudeExhaustedLabel = !claudeHasData
    ? "—"
    : (claude5hPercent !== undefined && claude5hPercent >= 99.5 && claudeWeeklyPercent !== undefined && claudeWeeklyPercent >= 99.5)
      ? t("pws.limitExhaustedBadge")
      : (claudeWeeklyPercent !== undefined && claudeWeeklyPercent >= 99.5)
        ? t("pws.limitWeeklyExhaustedBadge")
        : (claude5hPercent !== undefined && claude5hPercent >= 99.5)
          ? t("pws.limit5hExhaustedBadge")
          : t("pws.freeHeadroom", { percent: Math.max(0, 100 - analyzed.claudeUsedMax) });

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
    if (percent === undefined) {
      return (
        <div className="pwi-quota-item" style={{ opacity: 0.45 }}>
          <div className="pwi-quota-item-head">
            <span className="pwi-quota-title">{label}</span>
            <span className="pwi-quota-reset">—</span>
          </div>
          <div className="pwi-quota-track">
            <div className="pwi-quota-fill" style={{ width: "0%" }} />
          </div>
          <div className="pwi-quota-item-foot">
            <span className="pwi-quota-used">—</span>
            <span className="pwi-quota-free">—</span>
          </div>
        </div>
      );
    }
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
      <div className={`pwi-card-dense${active ? " pwi-card-dense--active pwi-auth-acct--active" : ""}`}>
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
              {planBadge}
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
            {!showReauth && onGrokCouponClick && (
              <GrokCouponBadge entry={grokCouponEntry} t={t} onClick={() => onGrokCouponClick(account)} />
            )}
            {!showReauth && onGrantClick && (
              <AnthropicGrantBadge entry={grantEntry} t={t} onClick={() => onGrantClick(account)} />
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
          {showReauth && (
            <div style={{ gridColumn: "span 2", display: "flex", justifyContent: "space-between", alignItems: "center", padding: "4px 8px", background: "color-mix(in srgb, var(--amber) 10%, var(--surface))", borderRadius: "4px" }}>
              <span style={{ fontSize: "11px", color: "var(--amber)", fontWeight: 600 }}>⚠️ {t("pws.healthLabel.reauthRequired")}</span>
              {onReauth && <button type="button" className="btn btn-primary btn-sm" style={{ height: "22px", padding: "0 8px", fontSize: "11px" }} onClick={() => onReauth(account)}>{t("pws.reauthenticate")}</button>}
            </div>
          )}

          {/* Gemini */}
          {isAntigravity && (
            <div className="pwi-dense-col">
              <div className="pwi-dense-col-title">
                <span className="pwi-brand-badge-title">
                  <span className="pwi-brand-dot blue">●</span>
                  <span>{t("pws.modelGemini")}</span>
                </span>
                <span className={`pwi-headroom-pill-mini ${analyzed.geminiExhausted ? "warn" : geminiHasData ? "ok" : "muted"}`}>
                  {geminiExhaustedLabel}
                </span>
              </div>
              <div className="pwi-dense-mini-row">
                <div className="pwi-dense-mini-label">
                  <span className="pwi-dense-window-name">{t("pws.gemini5hLabel")} {gemini5hPercent !== undefined ? `(${Math.round(gemini5hPercent)}%)` : "—"}</span>
                  <span className="pwi-dense-reset-time">{analyzed.gemini5h?.resetAt ? formatResetFuture(analyzed.gemini5h.resetAt, t, locale) : (gemini5hPercent === undefined ? "—" : "")}</span>
                </div>
                <div className="pwi-dense-mini-track">
                  <div className={`pwi-dense-mini-fill${(gemini5hPercent ?? 0) >= 100 ? " pwi-fill-warn" : ""}`} style={{ width: `${Math.min(100, Math.round(gemini5hPercent ?? 0))}%` }} />
                </div>
              </div>
              <div className="pwi-dense-mini-row">
                <div className="pwi-dense-mini-label">
                  <span className="pwi-dense-window-name">{t("pws.geminiWeeklyLabel")} {geminiWeeklyPercent !== undefined ? `(${Math.round(geminiWeeklyPercent)}%)` : "—"}</span>
                  <span className="pwi-dense-reset-time">{analyzed.geminiWeekly?.resetAt ? formatResetFuture(analyzed.geminiWeekly.resetAt, t, locale) : (geminiWeeklyPercent === undefined ? "—" : "")}</span>
                </div>
                <div className="pwi-dense-mini-track">
                  <div className={`pwi-dense-mini-fill${(geminiWeeklyPercent ?? 0) >= 100 ? " pwi-fill-warn" : ""}`} style={{ width: `${Math.min(100, Math.round(geminiWeeklyPercent ?? 0))}%` }} />
                </div>
              </div>
            </div>
          )}

          {/* Claude */}
          {isAntigravity && (
            <div className="pwi-dense-col">
              <div className="pwi-dense-col-title">
                <span className="pwi-brand-badge-title">
                  <span className="pwi-brand-dot orange">●</span>
                  <span>{t("pws.modelClaude")}</span>
                </span>
                <span className={`pwi-headroom-pill-mini ${analyzed.claudeExhausted ? "warn" : claudeHasData ? "ok" : "muted"}`}>
                  {claudeExhaustedLabel}
                </span>
              </div>
              <div className="pwi-dense-mini-row">
                <div className="pwi-dense-mini-label">
                  <span className="pwi-dense-window-name">{t("pws.claude5hLabel")} {claude5hPercent !== undefined ? `(${Math.round(claude5hPercent)}%)` : "—"}</span>
                  <span className="pwi-dense-reset-time">{analyzed.claude5h?.resetAt ? formatResetFuture(analyzed.claude5h.resetAt, t, locale) : (claude5hPercent === undefined ? "—" : "")}</span>
                </div>
                <div className="pwi-dense-mini-track">
                  <div className={`pwi-dense-mini-fill${(claude5hPercent ?? 0) >= 100 ? " pwi-fill-warn" : ""}`} style={{ width: `${Math.min(100, Math.round(claude5hPercent ?? 0))}%` }} />
                </div>
              </div>
              <div className="pwi-dense-mini-row">
                <div className="pwi-dense-mini-label">
                  <span className="pwi-dense-window-name">{t("pws.claudeWeeklyLabel")} {claudeWeeklyPercent !== undefined ? `(${Math.round(claudeWeeklyPercent)}%)` : "—"}</span>
                  <span className="pwi-dense-reset-time">{analyzed.claudeWeekly?.resetAt ? formatResetFuture(analyzed.claudeWeekly.resetAt, t, locale) : (claudeWeeklyPercent === undefined ? "—" : "")}</span>
                </div>
                <div className="pwi-dense-mini-track">
                  <div className={`pwi-dense-mini-fill${(claudeWeeklyPercent ?? 0) >= 100 ? " pwi-fill-warn" : ""}`} style={{ width: `${Math.min(100, Math.round(claudeWeeklyPercent ?? 0))}%` }} />
                </div>
              </div>
            </div>
          )}

          {/* Generic fallback */}
          {!analyzed.gemini5h && !analyzed.geminiWeekly && !analyzed.claude5h && !analyzed.claudeWeekly && (
            <div className="pwi-dense-col" style={{ gridColumn: "span 2" }}>
              {(analyzed.generic5h || analyzed.genericWeekly) ? (
                <>
                  {renderSingleQuotaBar(t("pws.window5hLabel"), analyzed.generic5h?.percent, analyzed.generic5h?.resetAt)}
                  {renderSingleQuotaBar(t("pws.windowWeeklyLabel"), analyzed.genericWeekly?.percent, analyzed.genericWeekly?.resetAt)}
                </>
              ) : (
                <ProviderAccountQuota quotaMode={account.quotaMode} quota={account.quota}
                  quotaUnavailable={account.quotaUnavailable} quotaPending={account.quotaPending} quotaFailure={account.quotaFailure} />
              )}
            </div>
          )}
        </div>
      </div>
    );
  }

  // Cards view
  return (
    <div className={`pwi-account-card${active ? " pwi-account-card--active pwi-auth-acct--active" : ""}${analyzed.fullyExhausted ? " pwi-account-card--exhausted" : ""}`}>
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
                {planBadge}
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
          {!showReauth && onGrokCouponClick && (
            <GrokCouponBadge entry={grokCouponEntry} t={t} onClick={() => onGrokCouponClick(account)} />
          )}
          {!showReauth && onGrantClick && (
            <AnthropicGrantBadge entry={grantEntry} t={t} onClick={() => onGrantClick(account)} />
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
        {isAntigravity && (
          <div className="pwi-quota-col">
            <div className="pwi-quota-col-head">
              <span className="pwi-brand-badge-title">
                <span className="pwi-brand-dot blue">●</span>
                <span>{t("pws.modelGemini")}</span>
              </span>
              <span className={`pwi-headroom-pill ${analyzed.geminiExhausted ? "warn" : geminiHasData ? "ok" : "muted"}`}>
                {geminiExhaustedLabel}
              </span>
            </div>
            {renderSingleQuotaBar(t("pws.gemini5hLabel"), gemini5hPercent, analyzed.gemini5h?.resetAt)}
            {renderSingleQuotaBar(t("pws.geminiWeeklyLabel"), geminiWeeklyPercent, analyzed.geminiWeekly?.resetAt)}
          </div>
        )}

        {isAntigravity && (
          <div className="pwi-quota-col">
            <div className="pwi-quota-col-head">
              <span className="pwi-brand-badge-title">
                <span className="pwi-brand-dot orange">●</span>
                <span>{t("pws.modelClaude")}</span>
              </span>
              <span className={`pwi-headroom-pill ${analyzed.claudeExhausted ? "warn" : claudeHasData ? "ok" : "muted"}`}>
                {claudeExhaustedLabel}
              </span>
            </div>
            {renderSingleQuotaBar(t("pws.claude5hLabel"), claude5hPercent, analyzed.claude5h?.resetAt)}
            {renderSingleQuotaBar(t("pws.claudeWeeklyLabel"), claudeWeeklyPercent, analyzed.claudeWeekly?.resetAt)}
          </div>
        )}

        {showReauth && (
          <div style={{ gridColumn: "span 2", padding: "12px 14px", background: "color-mix(in srgb, var(--amber) 10%, var(--surface))", border: "1px solid color-mix(in srgb, var(--amber) 30%, transparent)", borderRadius: "6px", display: "flex", alignItems: "center", justifyContent: "space-between", gap: "10px" }}>
            <span style={{ fontSize: "12px", color: "var(--amber)", fontWeight: 600 }}>⚠️ {t("pws.healthLabel.reauthRequired")}</span>
            {onReauth && <button type="button" className="btn btn-primary btn-sm" onClick={() => onReauth(account)}>{t("pws.reauthenticate")}</button>}
          </div>
        )}

        {!isAntigravity && !showReauth && (
          <div className="pwi-quota-col" style={{ gridColumn: "span 2" }}>
            {(analyzed.generic5h || analyzed.genericWeekly) ? (
              <>
                {renderSingleQuotaBar(t("pws.window5hLabel"), analyzed.generic5h?.percent, analyzed.generic5h?.resetAt)}
                {renderSingleQuotaBar(t("pws.windowWeeklyLabel"), analyzed.genericWeekly?.percent, analyzed.genericWeekly?.resetAt)}
              </>
            ) : (
              <ProviderAccountQuota quotaMode={account.quotaMode} quota={account.quota}
                quotaUnavailable={account.quotaUnavailable} quotaPending={account.quotaPending} quotaFailure={account.quotaFailure} />
            )}
          </div>
        )}
      </div>
    </div>
  );
}
