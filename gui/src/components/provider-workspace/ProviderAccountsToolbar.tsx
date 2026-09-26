import { usePoolTokensEstimate } from "./account-tokens-estimate";
/**
 * ProviderAccountsToolbar.tsx — Top statistics summary, global quota refresh,
 * unified single dropdown filter button, email/alias/masked toggle, card/compact
 * view switch, and sorting control.
 */
import { useState, useRef, useEffect } from "react";
import { useT } from "../../i18n/shared";
import { IconRefresh, IconSearch, IconX } from "../../icons";
import type { AccountPoolStrategy } from "../../account-pool-strategy";
import { DEFAULT_ACCOUNT_POOL_STRATEGY } from "../../account-pool-strategy";
import type {
  AccountDisplayKey,
  AccountFilterKey,
  AccountSortKey,
  AccountViewModeKey,
  AnalyzedAccountQuota,
} from "./account-quota-analysis";

export interface ProviderAccountsToolbarProps {
  apiBase?: string;
  providerName?: string;
  analyzedList: AnalyzedAccountQuota[];
  showModelFamilies?: boolean;
  filter: AccountFilterKey;
  onFilterChange: (next: AccountFilterKey) => void;
  sortKey: AccountSortKey;
  onSortChange: (next: AccountSortKey) => void;
  titleMode: AccountDisplayKey;
  onTitleModeChange: (next: AccountDisplayKey) => void;
  viewMode: AccountViewModeKey;
  onViewModeChange: (next: AccountViewModeKey) => void;
  searchQuery: string;
  onSearchQueryChange: (next: string) => void;
  refreshingAll: boolean;
  onRefreshAll?: () => void;
  quotaRefreshResultText?: string | null;
  quotaRefreshResultOk?: boolean;
  poolSupported?: boolean;
  poolEnabled?: boolean;
  onTogglePoolEnabled?: () => void;
  poolStrategy?: AccountPoolStrategy;
  onSelectPoolStrategy?: (strategy: AccountPoolStrategy) => void;
}

export default function ProviderAccountsToolbar({
  apiBase = "",
  providerName = "google-antigravity",
  analyzedList,
  showModelFamilies = false,
  filter,
  onFilterChange,
  sortKey,
  onSortChange,
  titleMode,
  onTitleModeChange,
  viewMode,
  onViewModeChange,
  searchQuery,
  onSearchQueryChange,
  refreshingAll,
  onRefreshAll,
  quotaRefreshResultText,
  quotaRefreshResultOk,
  poolSupported = false,
  poolEnabled = false,
  onTogglePoolEnabled,
  poolStrategy = DEFAULT_ACCOUNT_POOL_STRATEGY,
  onSelectPoolStrategy,
}: ProviderAccountsToolbarProps) {
  const t = useT();

  const tokensEstimate = usePoolTokensEstimate({
    apiBase,
    providerName,
    analyzedList,
    showModelFamilies,
    refreshingAll,
  });

  const [limitsMenuOpen, setLimitsMenuOpen] = useState(false);
  const limitsMenuRef = useRef<HTMLDivElement>(null);
  const [sortMenuOpen, setSortMenuOpen] = useState(false);
  const sortMenuRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const [tooltipOpen, setTooltipOpen] = useState(false);

  const activeItem = analyzedList.find(a => a.account.active);
  const activeAccountTitle = activeItem ? (
    titleMode === "login" ? activeItem.emailLogin
    : titleMode === "masked" ? (activeItem.maskedLogin || activeItem.emailLogin)
    : (activeItem.account.alias?.trim() || activeItem.emailLogin)
  ) : null;

  const hasSearch = searchQuery.trim().length > 0;

  useEffect(() => {
    if (searchInputRef.current) {
      searchInputRef.current.style.setProperty("padding-left", "32px", "important");
      searchInputRef.current.style.setProperty(
        "padding-right",
        hasSearch ? "28px" : "10px",
        "important"
      );
    }
  }, [hasSearch]);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (limitsMenuRef.current && !limitsMenuRef.current.contains(event.target as Node)) {
        setLimitsMenuOpen(false);
      }
      if (sortMenuRef.current && !sortMenuRef.current.contains(event.target as Node)) {
        setSortMenuOpen(false);
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setLimitsMenuOpen(false);
        setSortMenuOpen(false);
      }
    };
    if (limitsMenuOpen || sortMenuOpen) {
      document.addEventListener("mousedown", handleClickOutside);
      window.addEventListener("keydown", handleKeyDown);
      return () => {
        document.removeEventListener("mousedown", handleClickOutside);
        window.removeEventListener("keydown", handleKeyDown);
      };
    }
  }, [limitsMenuOpen, sortMenuOpen]);

  let activeSortLabel: string;
  let activeSortIcon: string;
  switch (sortKey) {
    case "less_headroom":
      activeSortLabel = t("pws.sortLessHeadroom");
      activeSortIcon = "🔻";
      break;
    case "reset_5h_soonest":
      activeSortLabel = t("pws.sortReset5h");
      activeSortIcon = "⏱️";
      break;
    case "reset_7d_soonest":
      activeSortLabel = t("pws.sortReset7d");
      activeSortIcon = "📅";
      break;
    case "more_headroom":
    default:
      activeSortLabel = t("pws.sortMoreHeadroom");
      activeSortIcon = "⚡";
      break;
  }

  const totalCount = analyzedList.length;
  const withLimitsCount = analyzedList.filter(a => a.hasAnyLimitsLeft).length;
  const withLimitsGeminiCount = analyzedList.filter(a => Boolean(a.gemini5h || a.geminiWeekly) && !a.geminiExhausted).length;
  const withLimitsClaudeCount = analyzedList.filter(a => Boolean(a.claude5h || a.claudeWeekly) && !a.claudeExhausted).length;
  const geminiExhaustedCount = analyzedList.filter(a => a.geminiExhausted).length;
  const claudeExhaustedCount = analyzedList.filter(a => a.claudeExhausted).length;

  // Detailed 5h and Weekly counts for Claude & Gemini
  const claude5hAvailable = analyzedList.filter(a => (a.claude5h?.percent ?? 0) < 99.5 && !a.account.needsReauth).length;
  const claude5hExhausted = analyzedList.filter(a => (a.claude5h?.percent ?? 0) >= 99.5).length;
  const claudeWeeklyAvailable = analyzedList.filter(a => (a.claudeWeekly?.percent ?? 0) < 99.5 && !a.account.needsReauth).length;
  const claudeWeeklyExhausted = analyzedList.filter(a => (a.claudeWeekly?.percent ?? 0) >= 99.5).length;

  const gemini5hAvailable = analyzedList.filter(a => (a.gemini5h?.percent ?? 0) < 99.5 && !a.account.needsReauth).length;
  const gemini5hExhausted = analyzedList.filter(a => (a.gemini5h?.percent ?? 0) >= 99.5).length;
  const geminiWeeklyAvailable = analyzedList.filter(a => (a.geminiWeekly?.percent ?? 0) < 99.5 && !a.account.needsReauth).length;
  const geminiWeeklyExhausted = analyzedList.filter(a => (a.geminiWeekly?.percent ?? 0) >= 99.5).length;

  const fullyExhaustedCount = analyzedList.filter(a => a.fullyExhausted || (!a.hasAnyLimitsLeft && !a.account.needsReauth)).length;
  const needsReauthCount = analyzedList.filter(a => Boolean(a.account.needsReauth) || a.account.health?.status === "reauth_required").length;
  const readyCount = analyzedList.filter(a => a.hasAnyLimitsLeft && !a.account.needsReauth).length;

  let activeFilterLabel: string;
  let activeFilterIcon: string;
  let activeFilterCount: number;

  switch (filter) {
    case "with_limits_gemini":
      activeFilterLabel = t("pws.filterWithLimitsGemini");
      activeFilterIcon = "⚡";
      activeFilterCount = withLimitsGeminiCount;
      break;
    case "with_limits_claude":
      activeFilterLabel = t("pws.filterWithLimitsClaude");
      activeFilterIcon = "⚡";
      activeFilterCount = withLimitsClaudeCount;
      break;
    case "all":
      activeFilterLabel = t("pws.filterAllAccounts");
      activeFilterIcon = "📋";
      activeFilterCount = totalCount;
      break;
    case "gemini_exhausted":
      activeFilterLabel = t("pws.filterGeminiExhausted");
      activeFilterIcon = "⚠️";
      activeFilterCount = geminiExhaustedCount;
      break;
    case "claude_exhausted":
      activeFilterLabel = t("pws.filterClaudeExhausted");
      activeFilterIcon = "⚠️";
      activeFilterCount = claudeExhaustedCount;
      break;
    case "fully_exhausted":
      activeFilterLabel = t("pws.filterFullyExhausted");
      activeFilterIcon = "⛔";
      activeFilterCount = fullyExhaustedCount;
      break;
    case "with_limits":
    default:
      activeFilterLabel = t("pws.filterWithLimits");
      activeFilterIcon = "⚡";
      activeFilterCount = withLimitsCount;
      break;
  }

  return (
    <div className="pwi-accounts-controls-wrapper">
      {/* 1. Summary Stats Hub */}
      <div className="pwi-accounts-stats-card">
        {/* 1a. Account Availability Hub (3-Column Grid) */}
        <div className="pwi-tokens-section">
          <div className="pwi-tokens-header-bar">
            <div style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
              <span className="pwi-stat-lbl">{t("pws.availableAccounts")}:</span>
              <strong style={{ fontSize: "14px", fontWeight: 700 }}>{totalCount}</strong>
              <span className="pwi-stat-subtag">{t("pws.statsInPool")}</span>
              <span className="pwi-stat-tag-green">✓ {readyCount} {t("pws.statsInService")}</span>
              {needsReauthCount > 0 && (
                <span className="pwi-stat-tag-warn">⚠️ {needsReauthCount} {t("pws.reauthNeededShort")}</span>
              )}
            </div>

            {onRefreshAll && (
              <div className="pwi-global-refresh-box">
                {quotaRefreshResultText && (
                  <span className={quotaRefreshResultOk ? "pws-status-ok" : "pws-status-warn"}>
                    {quotaRefreshResultText}
                  </span>
                )}
                <button
                  type="button"
                  className="btn btn-ghost btn-sm pwi-btn-refresh-all"
                  disabled={refreshingAll}
                  onClick={onRefreshAll}
                >
                  <IconRefresh width={13} height={13} className={refreshingAll ? "pwi-spin-inline" : ""} aria-hidden="true" />
                  {" "}
                  {refreshingAll ? t("codexAuth.refreshingQuota") : t("pws.refreshAllQuotas")}
                </button>
              </div>
            )}
          </div>

          <div className={showModelFamilies ? "pwi-tokens-grid" : "pwi-tokens-grid pwi-tokens-grid--dual"}>
            {showModelFamilies ? (
              <>
                {/* Column 1: Claude availability */}
                <div className="pwi-tokens-card pwi-tokens-card--claude">
                  <div className="pwi-tokens-card-head">
                    <span className="pwi-tokens-dot pwi-tokens-dot--orange">●</span>
                    <span className="pwi-tokens-card-title">{t("pws.tokensColClaude")}</span>
                    <span className="pwi-stat-subtag" style={{ marginLeft: "auto" }}>
                      {claudeWeeklyAvailable} / {totalCount}
                    </span>
                  </div>
                  <div className="pwi-tokens-card-metrics">
                    <div className="pwi-tokens-metric-row">
                      <span className="pwi-tokens-metric-label">{t("pws.tokensLabel5h")}:</span>
                      <span className="pwi-tokens-metric-value pwi-text-orange">{claude5hAvailable} {t("pws.statsAvailShort")}</span>
                      {claude5hExhausted > 0 ? (
                        <span className="pwi-stat-tag-warn">{claude5hExhausted} {t("pws.statsExhaustShort")}</span>
                      ) : (
                        <span className="pwi-stat-tag-orange">✓ {t("pws.statsReady")}</span>
                      )}
                    </div>
                    <div className="pwi-tokens-metric-row">
                      <span className="pwi-tokens-metric-label">{t("pws.tokensLabel7d")}:</span>
                      <span className="pwi-tokens-metric-value pwi-text-orange">{claudeWeeklyAvailable} {t("pws.statsAvailShort")}</span>
                      {claudeWeeklyExhausted > 0 ? (
                        <span className="pwi-stat-tag-warn">{claudeWeeklyExhausted} {t("pws.statsExhaustShort")}</span>
                      ) : (
                        <span className="pwi-stat-tag-orange">✓ {t("pws.statsReady")}</span>
                      )}
                    </div>
                  </div>
                </div>

                {/* Column 2: Gemini availability */}
                <div className="pwi-tokens-card pwi-tokens-card--gemini">
                  <div className="pwi-tokens-card-head">
                    <span className="pwi-tokens-dot pwi-tokens-dot--blue">●</span>
                    <span className="pwi-tokens-card-title">{t("pws.tokensColGemini")}</span>
                    <span className="pwi-stat-subtag" style={{ marginLeft: "auto" }}>
                      {geminiWeeklyAvailable} / {totalCount}
                    </span>
                  </div>
                  <div className="pwi-tokens-card-metrics">
                    <div className="pwi-tokens-metric-row">
                      <span className="pwi-tokens-metric-label">{t("pws.tokensLabel5h")}:</span>
                      <span className="pwi-tokens-metric-value pwi-text-blue">{gemini5hAvailable} {t("pws.statsAvailShort")}</span>
                      {gemini5hExhausted > 0 ? (
                        <span className="pwi-stat-tag-warn">{gemini5hExhausted} {t("pws.statsExhaustShort")}</span>
                      ) : (
                        <span className="pwi-stat-tag-blue">✓ {t("pws.statsReady")}</span>
                      )}
                    </div>
                    <div className="pwi-tokens-metric-row">
                      <span className="pwi-tokens-metric-label">{t("pws.tokensLabel7d")}:</span>
                      <span className="pwi-tokens-metric-value pwi-text-blue">{geminiWeeklyAvailable} {t("pws.statsAvailShort")}</span>
                      {geminiWeeklyExhausted > 0 ? (
                        <span className="pwi-stat-tag-warn">{geminiWeeklyExhausted} {t("pws.statsExhaustShort")}</span>
                      ) : (
                        <span className="pwi-stat-tag-blue">✓ {t("pws.statsReady")}</span>
                      )}
                    </div>
                  </div>
                </div>

                {/* Column 3: Pool Status */}
                <div className="pwi-tokens-card pwi-tokens-card--total">
                  <div className="pwi-tokens-card-head">
                    <span className="pwi-tokens-dot pwi-tokens-dot--green">●</span>
                    <span className="pwi-tokens-card-title">{t("pws.statsPoolSummary")}</span>
                    <span className="pwi-stat-subtag" style={{ marginLeft: "auto" }}>
                      {readyCount} / {totalCount}
                    </span>
                  </div>
                  <div className="pwi-tokens-card-metrics">
                    <div className="pwi-tokens-metric-row">
                      <span className="pwi-tokens-metric-label" style={{ width: "auto" }}>{t("pws.statsFullyExhausted")}:</span>
                      <span className={`pwi-tokens-metric-value ${fullyExhaustedCount > 0 ? "pwi-text-warn" : "pwi-text-green"}`}>
                        {fullyExhaustedCount}
                      </span>
                      <span className={fullyExhaustedCount > 0 ? "pwi-stat-tag-warn" : "pwi-stat-tag-green"}>
                        {fullyExhaustedCount > 0 ? t("pws.statsAwaitingReset") : "0 " + t("pws.statsExhaustShort")}
                      </span>
                    </div>
                    <div className="pwi-tokens-metric-row">
                      <span className="pwi-tokens-metric-label" style={{ width: "auto" }}>{t("pws.statsReauthStatus")}:</span>
                      <span className={`pwi-tokens-metric-value ${needsReauthCount > 0 ? "pwi-text-warn" : "pwi-text-green"}`}>
                        {needsReauthCount}
                      </span>
                      <span className={needsReauthCount > 0 ? "pwi-stat-tag-warn" : "pwi-stat-tag-green"}>
                        {needsReauthCount > 0 ? t("pws.reauthNeededShort") : "0"}
                      </span>
                    </div>
                  </div>
                </div>
              </>
            ) : (
              <>
                <div className="pwi-tokens-card pwi-tokens-card--claude">
                  <div className="pwi-tokens-card-head">
                    <span className="pwi-tokens-dot pwi-tokens-dot--orange">●</span>
                    <span className="pwi-tokens-card-title">{t("pws.statsAvailable")}</span>
                  </div>
                  <div className="pwi-tokens-card-metrics">
                    <div className="pwi-tokens-metric-row">
                      <span className="pwi-tokens-metric-value pwi-text-orange">{withLimitsCount} {t("pws.statsAvailShort")}</span>
                      <span className="pwi-stat-tag-orange">✓ {t("pws.statsReady")}</span>
                    </div>
                  </div>
                </div>

                <div className="pwi-tokens-card pwi-tokens-card--total">
                  <div className="pwi-tokens-card-head">
                    <span className="pwi-tokens-dot pwi-tokens-dot--green">●</span>
                    <span className="pwi-tokens-card-title">{t("pws.statsFullyExhausted")}</span>
                  </div>
                  <div className="pwi-tokens-card-metrics">
                    <div className="pwi-tokens-metric-row">
                      <span className="pwi-tokens-metric-value pwi-text-warn">{fullyExhaustedCount}</span>
                      <span className="pwi-stat-tag-warn">{t("pws.statsAwaitingReset")}</span>
                    </div>
                  </div>
                </div>
              </>
            )}
          </div>
        </div>

        {/* 1b. Remaining Tokens 3-Column Grid */}
        <div className="pwi-stats-divider" />
        <div className="pwi-tokens-section">
          <div className="pwi-tokens-header-bar">
            <span className="pwi-stat-lbl">{t("pws.tokensEstimateTitle")}</span>
            <a
              href="#logs"
              className="pwi-stat-hint-link"
              title={t("pws.tokensCalibratedTooltip")}
            >
              ⚡ {t(tokensEstimate.isCalibratedFromLogs ? "pws.tokensCalibratedFromLogs" : "pws.tokensEstimatedBaseline")}
            </a>
          </div>

          <div className={showModelFamilies ? "pwi-tokens-grid" : "pwi-tokens-grid pwi-tokens-grid--dual"}>
            {showModelFamilies ? (
              <>
                {/* Column 1: Claude */}
                <div className="pwi-tokens-card pwi-tokens-card--claude">
                  <div className="pwi-tokens-card-head">
                    <span className="pwi-tokens-dot pwi-tokens-dot--orange">●</span>
                    <span className="pwi-tokens-card-title">{t("pws.tokensColClaude")}</span>
                  </div>
                  <div className="pwi-tokens-card-metrics">
                    <div className="pwi-tokens-metric-row">
                      <span className="pwi-tokens-metric-label">{t("pws.tokensLabel5h")}:</span>
                      <span className="pwi-tokens-metric-value pwi-text-orange">{tokensEstimate.claude5h?.smart ?? "0M"}</span>
                    </div>
                    <div className="pwi-tokens-metric-row">
                      <span className="pwi-tokens-metric-label">{t("pws.tokensLabel7d")}:</span>
                      <span className="pwi-tokens-metric-value pwi-text-orange">{tokensEstimate.claudeWeekly?.smart ?? "0M"}</span>
                    </div>
                  </div>
                </div>

                {/* Column 2: Gemini */}
                <div className="pwi-tokens-card pwi-tokens-card--gemini">
                  <div className="pwi-tokens-card-head">
                    <span className="pwi-tokens-dot pwi-tokens-dot--blue">●</span>
                    <span className="pwi-tokens-card-title">{t("pws.tokensColGemini")}</span>
                  </div>
                  <div className="pwi-tokens-card-metrics">
                    <div className="pwi-tokens-metric-row">
                      <span className="pwi-tokens-metric-label">{t("pws.tokensLabel5h")}:</span>
                      <span className="pwi-tokens-metric-value pwi-text-blue">{tokensEstimate.gemini5h?.smart ?? "0M"}</span>
                    </div>
                    <div className="pwi-tokens-metric-row">
                      <span className="pwi-tokens-metric-label">{t("pws.tokensLabel7d")}:</span>
                      <span className="pwi-tokens-metric-value pwi-text-blue">{tokensEstimate.geminiWeekly?.smart ?? "0M"}</span>
                    </div>
                  </div>
                </div>

                {/* Column 3: Total */}
                <div className="pwi-tokens-card pwi-tokens-card--total">
                  <div className="pwi-tokens-card-head">
                    <span className="pwi-tokens-dot pwi-tokens-dot--green">●</span>
                    <span className="pwi-tokens-card-title">{t("pws.tokensColTotal")}</span>
                  </div>
                  <div className="pwi-tokens-card-metrics">
                    <div className="pwi-tokens-metric-row">
                      <span className="pwi-tokens-metric-label">{t("pws.tokensLabel5h")}:</span>
                      <span className="pwi-tokens-metric-value pwi-text-green">{tokensEstimate.total5h.smart}</span>
                    </div>
                    <div className="pwi-tokens-metric-row">
                      <span className="pwi-tokens-metric-label">{t("pws.tokensLabel7d")}:</span>
                      <span className="pwi-tokens-metric-value pwi-text-green">{tokensEstimate.totalWeekly.smart}</span>
                    </div>
                  </div>
                </div>
              </>
            ) : (
              <>
                <div className="pwi-tokens-card pwi-tokens-card--claude">
                  <div className="pwi-tokens-card-head">
                    <span className="pwi-tokens-dot pwi-tokens-dot--orange">●</span>
                    <span className="pwi-tokens-card-title">{t("pws.tokensGeneric5h")}</span>
                  </div>
                  <div className="pwi-tokens-card-metrics">
                    <div className="pwi-tokens-metric-row">
                      <span className="pwi-tokens-metric-value pwi-text-orange">{tokensEstimate.total5h.smart}</span>
                    </div>
                  </div>
                </div>

                <div className="pwi-tokens-card pwi-tokens-card--total">
                  <div className="pwi-tokens-card-head">
                    <span className="pwi-tokens-dot pwi-tokens-dot--green">●</span>
                    <span className="pwi-tokens-card-title">{t("pws.tokensGenericWeekly")}</span>
                  </div>
                  <div className="pwi-tokens-card-metrics">
                    <div className="pwi-tokens-metric-row">
                      <span className="pwi-tokens-metric-value pwi-text-green">{tokensEstimate.totalWeekly.smart}</span>
                    </div>
                  </div>
                </div>
              </>
            )}
          </div>
        </div>
      </div>

      {/* 2. Balanced 2-Row Controls Panel */}
      <div className="pwi-toolbar-card">
        {/* Row 1: Data Selection (Filter + Sort + Search) */}
        <div className="pwi-toolbar-row-top">
          {/* Left: Filter and Sort side by side */}
          <div className="pwi-toolbar-cluster">
            {/* Filter */}
            <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
              <span className="pwi-filter-caption" style={{ fontSize: "11.5px", fontWeight: 700, color: "var(--muted)", textTransform: "uppercase", letterSpacing: "0.5px", whiteSpace: "nowrap" }}>{t("pws.filterLabel")}:</span>
              <div className="pwi-dropdown-filter-wrap" ref={limitsMenuRef} style={{ position: "relative", display: "inline-block" }}>
                <button
                  type="button"
                  className="pwi-filter-btn pwi-filter-btn--natural active"
                  onClick={() => setLimitsMenuOpen(prev => !prev)}
                  aria-haspopup="true"
                  aria-expanded={limitsMenuOpen}
                  style={{
                    height: "32px",
                    display: "inline-flex",
                    alignItems: "center",
                    gap: "8px",
                    boxSizing: "border-box",
                    padding: "0 12px",
                    whiteSpace: "nowrap",
                  }}
                >
                  <span style={{ display: "inline-flex", alignItems: "center", gap: "6px" }}>
                    <span>{activeFilterIcon}</span>
                    <span>{activeFilterLabel}</span>
                  </span>
                  <span className="pwi-filter-count" style={{ marginLeft: "4px" }}>{activeFilterCount}</span>
                  <span className="pwi-filter-chevron" style={{ marginLeft: "4px" }}>▾</span>
                </button>

                {limitsMenuOpen && (
                  <div
                    className="pwi-filter-dropdown-menu"
                  >
                    <button
                      type="button"

                      className={`pwi-dropdown-item${filter === "with_limits" ? " active" : ""}`}
                      onClick={() => { onFilterChange("with_limits"); setLimitsMenuOpen(false); }}
                      style={{
                        display: "flex", width: "100%", justifyContent: "space-between", alignItems: "center",
                        padding: "8px 12px", borderRadius: "6px", border: "none", cursor: "pointer",
                        backgroundColor: filter === "with_limits" ? "rgba(78, 203, 157, 0.18)" : "transparent",
                        color: filter === "with_limits" ? "#4ecb9d" : "#ececec",
                      }}
                    >
                      <span className="pwi-dropdown-item-left" style={{ display: "inline-flex", alignItems: "center", gap: "9px" }}>
                        <span className="pwi-dropdown-item-icon">⚡</span>
                        <span style={{ fontWeight: filter === "with_limits" ? "700" : "500" }}>{t("pws.filterWithLimits")}</span>
                      </span>
                      <span className="pwi-dropdown-badge" style={{ padding: "2px 7px", borderRadius: "999px", background: "rgba(255,255,255,0.08)", fontSize: "11px", fontWeight: "700" }}>{withLimitsCount}</span>
                    </button>

                    <button
                      type="button"

                      className={`pwi-dropdown-item${filter === "all" ? " active" : ""}`}
                      onClick={() => { onFilterChange("all"); setLimitsMenuOpen(false); }}
                      style={{
                        display: "flex", width: "100%", justifyContent: "space-between", alignItems: "center",
                        padding: "8px 12px", borderRadius: "6px", border: "none", cursor: "pointer",
                        backgroundColor: filter === "all" ? "rgba(255, 255, 255, 0.12)" : "transparent",
                        color: filter === "all" ? "#ffffff" : "#ececec",
                      }}
                    >
                      <span className="pwi-dropdown-item-left" style={{ display: "inline-flex", alignItems: "center", gap: "9px" }}>
                        <span className="pwi-dropdown-item-icon">📋</span>
                        <span style={{ fontWeight: filter === "all" ? "700" : "500" }}>{t("pws.filterAllAccounts")}</span>
                      </span>
                      <span className="pwi-dropdown-badge" style={{ padding: "2px 7px", borderRadius: "999px", background: "rgba(255,255,255,0.08)", fontSize: "11px", fontWeight: "700" }}>{totalCount}</span>
                    </button>

                    {showModelFamilies && (
                    <>
                    <div className="pwi-dropdown-divider" />

                    <button
                      type="button"

                      className={`pwi-dropdown-item${filter === "with_limits_gemini" ? " active" : ""}`}
                      onClick={() => { onFilterChange("with_limits_gemini"); setLimitsMenuOpen(false); }}
                      style={{
                        display: "flex", width: "100%", justifyContent: "space-between", alignItems: "center",
                        padding: "8px 12px", borderRadius: "6px", border: "none", cursor: "pointer",
                        backgroundColor: filter === "with_limits_gemini" ? "rgba(96, 165, 250, 0.18)" : "transparent",
                        color: filter === "with_limits_gemini" ? "#93c5fd" : "#ececec",
                      }}
                    >
                      <span className="pwi-dropdown-item-left" style={{ display: "inline-flex", alignItems: "center", gap: "9px" }}>
                        <span className="pwi-dropdown-item-icon" style={{ color: "#60a5fa" }}>●</span>
                        <span style={{ fontWeight: filter === "with_limits_gemini" ? "700" : "500" }}>{t("pws.filterWithLimitsGemini")}</span>
                      </span>
                      <span className="pwi-dropdown-badge" style={{ padding: "2px 7px", borderRadius: "999px", background: "rgba(255,255,255,0.08)", fontSize: "11px", fontWeight: "700" }}>{withLimitsGeminiCount}</span>
                    </button>

                    <button
                      type="button"

                      className={`pwi-dropdown-item${filter === "with_limits_claude" ? " active" : ""}`}
                      onClick={() => { onFilterChange("with_limits_claude"); setLimitsMenuOpen(false); }}
                      style={{
                        display: "flex", width: "100%", justifyContent: "space-between", alignItems: "center",
                        padding: "8px 12px", borderRadius: "6px", border: "none", cursor: "pointer",
                        backgroundColor: filter === "with_limits_claude" ? "rgba(192, 132, 252, 0.18)" : "transparent",
                        color: filter === "with_limits_claude" ? "#e9d5ff" : "#ececec",
                      }}
                    >
                      <span className="pwi-dropdown-item-left" style={{ display: "inline-flex", alignItems: "center", gap: "9px" }}>
                        <span className="pwi-dropdown-item-icon" style={{ color: "#f97316" }}>●</span>
                        <span style={{ fontWeight: filter === "with_limits_claude" ? "700" : "500" }}>{t("pws.filterWithLimitsClaude")}</span>
                      </span>
                      <span className="pwi-dropdown-badge" style={{ padding: "2px 7px", borderRadius: "999px", background: "rgba(255,255,255,0.08)", fontSize: "11px", fontWeight: "700" }}>{withLimitsClaudeCount}</span>
                    </button>

                    <div className="pwi-dropdown-divider" />

                    <button
                      type="button"

                      className={`pwi-dropdown-item${filter === "gemini_exhausted" ? " active" : ""}`}
                      onClick={() => { onFilterChange("gemini_exhausted"); setLimitsMenuOpen(false); }}
                      style={{
                        display: "flex", width: "100%", justifyContent: "space-between", alignItems: "center",
                        padding: "8px 12px", borderRadius: "6px", border: "none", cursor: "pointer",
                        backgroundColor: filter === "gemini_exhausted" ? "rgba(96, 165, 250, 0.18)" : "transparent",
                        color: filter === "gemini_exhausted" ? "#93c5fd" : "#ececec",
                      }}
                    >
                      <span className="pwi-dropdown-item-left" style={{ display: "inline-flex", alignItems: "center", gap: "9px" }}>
                        <span className="pwi-dropdown-item-icon">⚠️</span>
                        <span style={{ fontWeight: filter === "gemini_exhausted" ? "700" : "500" }}>{t("pws.filterGeminiExhausted")}</span>
                      </span>
                      <span className="pwi-dropdown-badge" style={{ padding: "2px 7px", borderRadius: "999px", background: "rgba(96,165,250,0.15)", color: "#93c5fd", fontSize: "11px", fontWeight: "700" }}>{geminiExhaustedCount}</span>
                    </button>

                    <button
                      type="button"

                      className={`pwi-dropdown-item${filter === "claude_exhausted" ? " active" : ""}`}
                      onClick={() => { onFilterChange("claude_exhausted"); setLimitsMenuOpen(false); }}
                      style={{
                        display: "flex", width: "100%", justifyContent: "space-between", alignItems: "center",
                        padding: "8px 12px", borderRadius: "6px", border: "none", cursor: "pointer",
                        backgroundColor: filter === "claude_exhausted" ? "rgba(192, 132, 252, 0.18)" : "transparent",
                        color: filter === "claude_exhausted" ? "#e9d5ff" : "#ececec",
                      }}
                    >
                      <span className="pwi-dropdown-item-left" style={{ display: "inline-flex", alignItems: "center", gap: "9px" }}>
                        <span className="pwi-dropdown-item-icon">⚠️</span>
                        <span style={{ fontWeight: filter === "claude_exhausted" ? "700" : "500" }}>{t("pws.filterClaudeExhausted")}</span>
                      </span>
                      <span className="pwi-dropdown-badge" style={{ padding: "2px 7px", borderRadius: "999px", background: "rgba(249, 115, 22, 0.15)", color: "#f97316", fontSize: "11px", fontWeight: "700" }}>{claudeExhaustedCount}</span>
                    </button>

                    </>
                    )}

                    <div className="pwi-dropdown-divider" />

                    <button
                      type="button"

                      className={`pwi-dropdown-item${filter === "fully_exhausted" ? " active" : ""}`}
                      onClick={() => { onFilterChange("fully_exhausted"); setLimitsMenuOpen(false); }}
                      style={{
                        display: "flex", width: "100%", justifyContent: "space-between", alignItems: "center",
                        padding: "8px 12px", borderRadius: "6px", border: "none", cursor: "pointer",
                        backgroundColor: filter === "fully_exhausted" ? "rgba(251, 191, 36, 0.18)" : "transparent",
                        color: filter === "fully_exhausted" ? "#fbbf24" : "#ececec",
                      }}
                    >
                      <span className="pwi-dropdown-item-left" style={{ display: "inline-flex", alignItems: "center", gap: "9px" }}>
                        <span className="pwi-dropdown-item-icon">⛔</span>
                        <span style={{ fontWeight: filter === "fully_exhausted" ? "700" : "500" }}>{t("pws.filterFullyExhausted")}</span>
                      </span>
                      <span className="pwi-dropdown-badge" style={{ padding: "2px 7px", borderRadius: "999px", background: "rgba(251,191,36,0.15)", color: "#fbbf24", fontSize: "11px", fontWeight: "700" }}>{fullyExhaustedCount}</span>
                    </button>
                  </div>
                )}
              </div>
            </div>

            {/* Sort with custom dropdown matching filter */}
            <div className="pwi-sort-wrapper" style={{ display: "flex", alignItems: "center", gap: "8px", flexShrink: 0 }}>
              <span className="pwi-filter-caption">{t("pws.sortLabel")}:</span>
              <div className="pwi-dropdown-filter-wrap" ref={sortMenuRef}>
                <button
                  type="button"
                  className="pwi-filter-btn pwi-filter-btn--natural active"
                  onClick={() => setSortMenuOpen(prev => !prev)}
                  aria-haspopup="true"
                  aria-expanded={sortMenuOpen}
                >
                  <span style={{ display: "inline-flex", alignItems: "center", gap: "6px" }}>
                    <span>{activeSortIcon}</span>
                    <span>{activeSortLabel}</span>
                  </span>
                  <span className="pwi-filter-chevron">▾</span>
                </button>

                {sortMenuOpen && (
                  <div className="pwi-filter-dropdown-menu" >
                    <button
                      type="button"

                      className={`pwi-dropdown-item${sortKey === "more_headroom" ? " active" : ""}`}
                      onClick={() => { onSortChange("more_headroom"); setSortMenuOpen(false); }}
                    >
                      <span className="pwi-dropdown-item-left">
                        <span className="pwi-dropdown-item-icon">⚡</span>
                        <span>{t("pws.sortMoreHeadroom")}</span>
                      </span>
                    </button>

                    <button
                      type="button"

                      className={`pwi-dropdown-item${sortKey === "less_headroom" ? " active" : ""}`}
                      onClick={() => { onSortChange("less_headroom"); setSortMenuOpen(false); }}
                    >
                      <span className="pwi-dropdown-item-left">
                        <span className="pwi-dropdown-item-icon">🔻</span>
                        <span>{t("pws.sortLessHeadroom")}</span>
                      </span>
                    </button>

                    <div className="pwi-dropdown-divider" />

                    {(sortKey === "reset_5h_soonest"
                      || analyzedList.some(a => Boolean(a.generic5h || a.gemini5h || a.claude5h))) && (
                    <button
                      type="button"

                      className={`pwi-dropdown-item${sortKey === "reset_5h_soonest" ? " active" : ""}`}
                      onClick={() => { onSortChange("reset_5h_soonest"); setSortMenuOpen(false); }}
                    >
                      <span className="pwi-dropdown-item-left">
                        <span className="pwi-dropdown-item-icon">⏱️</span>
                        <span>{t("pws.sortReset5h")}</span>
                      </span>
                    </button>
                    )}

                    <button
                      type="button"

                      className={`pwi-dropdown-item${sortKey === "reset_7d_soonest" ? " active" : ""}`}
                      onClick={() => { onSortChange("reset_7d_soonest"); setSortMenuOpen(false); }}
                    >
                      <span className="pwi-dropdown-item-left">
                        <span className="pwi-dropdown-item-icon">📅</span>
                        <span>{t("pws.sortReset7d")}</span>
                      </span>
                    </button>
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* Right: Prominent Search Box */}
          <div className="pwi-prominent-search-box">
            <IconSearch className="pwi-search-prominent-icon" width={14} height={14} aria-hidden="true" />
            <input
              ref={searchInputRef}
              type="text"
              role="searchbox"
              inputMode="search"
              className="input input-sm pwi-search-prominent-input"
              placeholder={t("pws.searchAccountField")}
              value={searchQuery}
              onChange={e => onSearchQueryChange(e.target.value)}
              onKeyDown={e => {
                if (e.key === "Escape" && hasSearch) {
                  e.preventDefault();
                  e.stopPropagation();
                  onSearchQueryChange("");
                }
              }}
              aria-label={t("pws.searchAccountField")}
            />
            {hasSearch && (
              <button
                type="button"
                className="pwi-search-clear-btn"
                onClick={() => {
                  onSearchQueryChange("");
                  searchInputRef.current?.focus();
                }}
                aria-label={t("usage.range.clear")}
                title={t("usage.range.clear")}
                style={{
                  position: "absolute",
                  right: "6px",
                  top: "50%",
                  transform: "translateY(-50%)",
                  width: "20px",
                  height: "20px",
                  display: "inline-flex",
                  alignItems: "center",
                  justifyContent: "center",
                  background: "transparent",
                  border: "none",
                  borderRadius: "4px",
                  padding: 0,
                  color: "#a0a0a0",
                  cursor: "pointer",
                }}
              >
                <IconX width={12} height={12} aria-hidden="true" />
              </button>
            )}
          </div>
        </div>

        {/* Row 2: Display Presentation (Title Mode + View Mode) */}
        <div className="pwi-toolbar-row-bottom">
          {/* Title Mode */}
          <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
            <span className="pwi-filter-caption" style={{ fontSize: "11.5px", fontWeight: 700, color: "var(--muted)", textTransform: "uppercase", letterSpacing: "0.5px", whiteSpace: "nowrap" }}>{t("pws.titleModeLabel")}:</span>
            <div className="pwi-segmented">
              <button
                type="button"
                className={`pwi-seg-opt${titleMode === "login" ? " active" : ""}`}
                onClick={() => onTitleModeChange("login")}
              >
                ✉️ {t("pws.loginShort")}
              </button>
              <button
                type="button"
                className={`pwi-seg-opt${titleMode === "masked" ? " active" : ""}`}
                onClick={() => onTitleModeChange("masked")}
              >
                🔒 {t("pws.maskedShort")}
              </button>
              <button
                type="button"
                className={`pwi-seg-opt${titleMode === "alias" ? " active" : ""}`}
                onClick={() => onTitleModeChange("alias")}
              >
                👤 {t("pws.aliasShort")}
              </button>
            </div>
          </div>

          {/* Center: Integrated Pool Cluster */}
          {poolSupported && (
            <div className="pwi-pool-integrated-cluster">
              <span className="pwi-pool-label">⚡ {t("genericPool.title")}</span>
              {activeAccountTitle && (
                <span className="pwi-pool-active-chip" title={t("prov.accountActive")}>
                  <span className="pwi-pool-dot-live" />
                  {activeAccountTitle}
                </span>
              )}
              {onTogglePoolEnabled && (
                <button
                  type="button"
                  className={`toggle ${poolEnabled ? "on" : ""}`}
                  style={{ width: "32px", height: "18px" }}
                  onClick={onTogglePoolEnabled}
                  title={poolEnabled ? t("anthropicPool.on") : t("anthropicPool.off")}
                  aria-pressed={poolEnabled}
                >
                  <span className="toggle-knob" style={{ width: "12px", height: "12px", top: "2px", left: poolEnabled ? "16px" : "2px" }} />
                </button>
              )}
              {poolEnabled && onSelectPoolStrategy && (
                <select
                  className="pwi-pool-select"
                  value={poolStrategy}
                  onChange={e => onSelectPoolStrategy(e.target.value as AccountPoolStrategy)}
                  aria-label={t("accountPool.strategy")}
                >
                  <option value="reset-first">📅 {t("accountPool.strategyResetFirst")}</option>
                  <option value="quota">⚡ {t("accountPool.strategyQuota")}</option>
                  <option value="round-robin">🔄 {t("accountPool.strategyRoundRobin")}</option>
                  <option value="fill-first">🎯 {t("accountPool.strategyFillFirst")}</option>
                </select>
              )}
              <div className={`pwi-pool-tooltip-wrap${tooltipOpen ? " is-open" : ""}`}>
                <button
                  type="button"
                  className="pwi-pool-tooltip-btn"
                  onClick={() => setTooltipOpen(prev => !prev)}
                  aria-label={t("accountPool.strategyDesc")}
                >
                  ?
                </button>
                <div className="pwi-pool-popover" role="tooltip">
                  <strong>⚡ {t("genericPool.title")} — {t("accountPool.strategy")}:</strong>
                  <div className="pwi-pool-mode-desc">
                    <span style={{ color: "var(--green, #4ecb9d)", fontWeight: 600 }}>📅 {t("accountPool.strategyResetFirst")}:</span> {t("genericPool.visualResetFirst")}
                  </div>
                  <div className="pwi-pool-mode-desc">
                    <span style={{ color: "var(--blue, #60a5fa)", fontWeight: 600 }}>⚡ {t("accountPool.strategyQuota")}:</span> {t("accountPool.strategyHintQuota")}
                  </div>
                  <div className="pwi-pool-mode-desc">
                    <span style={{ color: "var(--orange, #f97316)", fontWeight: 600 }}>🔄 {t("accountPool.strategyRoundRobin")}:</span> {t("accountPool.strategyHintRoundRobin")}
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* View Mode */}
          <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
            <span className="pwi-filter-caption" style={{ fontSize: "11.5px", fontWeight: 700, color: "var(--muted)", textTransform: "uppercase", letterSpacing: "0.5px", whiteSpace: "nowrap" }}>{t("pws.viewModeLabel")}:</span>
            <div className="pwi-segmented">
              <button
                type="button"
                className={`pwi-seg-opt${viewMode === "cards" ? " active" : ""}`}
                onClick={() => onViewModeChange("cards")}
              >
                ▦ {t("pws.viewCards")}
              </button>
              <button
                type="button"
                className={`pwi-seg-opt${viewMode === "compact" ? " active" : ""}`}
                onClick={() => onViewModeChange("compact")}
              >
                ≡ {t("pws.viewCompact")}
              </button>
            </div>
          </div>

        </div>
      </div>
    </div>
  );
}
