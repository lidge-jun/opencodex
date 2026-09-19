/**
 * ProviderAccountsToolbar.tsx — Top statistics summary, global quota refresh,
 * unified single dropdown filter button, email/alias/masked toggle, card/compact
 * view switch, and sorting control.
 */
import { useState, useRef, useEffect } from "react";
import { useT } from "../../i18n/shared";
import { IconRefresh, IconSearch, IconX } from "../../icons";
import type {
  AccountDisplayKey,
  AccountFilterKey,
  AccountSortKey,
  AccountViewModeKey,
  AnalyzedAccountQuota,
} from "./account-quota-analysis";

export interface ProviderAccountsToolbarProps {
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
}

export default function ProviderAccountsToolbar({
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
}: ProviderAccountsToolbarProps) {
  const t = useT();
  const [limitsMenuOpen, setLimitsMenuOpen] = useState(false);
  const limitsMenuRef = useRef<HTMLDivElement>(null);
  const [sortMenuOpen, setSortMenuOpen] = useState(false);
  const sortMenuRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);

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
  const fullyExhaustedCount = analyzedList.filter(a => a.fullyExhausted).length;

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
        <div className="pwi-stats-items-row">
          <div className="pwi-stat-unit">
            <span className="pwi-stat-lbl">{t("pws.statsTotal")}</span>
            <div className="pwi-stat-val-line">
              <span className="pwi-stat-num">{totalCount}</span>
              <span className="pwi-stat-subtag">{t("pws.statsInPool")}</span>
            </div>
          </div>

          <div className="pwi-stat-sep" />

          {showModelFamilies ? (
            <>
              <div className="pwi-stat-unit">
                <span className="pwi-stat-lbl">{t("pws.statsClaudeAvailable")}</span>
                <div className="pwi-stat-val-line">
                  <span className="pwi-stat-num pwi-text-orange">{withLimitsClaudeCount}</span>
                  <span className="pwi-stat-tag-orange">✓ {t("pws.statsReady")}</span>
                </div>
              </div>

              <div className="pwi-stat-sep" />

              <div className="pwi-stat-unit">
                <span className="pwi-stat-lbl">{t("pws.statsGeminiAvailable")}</span>
                <div className="pwi-stat-val-line">
                  <span className="pwi-stat-num pwi-text-blue">{withLimitsGeminiCount}</span>
                  <span className="pwi-stat-tag-blue">✓ {t("pws.statsReady")}</span>
                </div>
              </div>
            </>
          ) : (
            <div className="pwi-stat-unit">
              <span className="pwi-stat-lbl">{t("pws.statsAvailable")}</span>
              <div className="pwi-stat-val-line">
                <span className="pwi-stat-num pwi-text-orange">{withLimitsCount}</span>
                <span className="pwi-stat-tag-orange">✓ {t("pws.statsReady")}</span>
              </div>
            </div>
          )}

          <div className="pwi-stat-sep" />

          <div className="pwi-stat-unit">
            <span className="pwi-stat-lbl">{t("pws.statsExhausted")}</span>
            <div className="pwi-stat-val-line">
              <span className="pwi-stat-num pwi-text-warn">{fullyExhaustedCount}</span>
              <span className="pwi-stat-tag-warn">{t("pws.statsAwaitingReset")}</span>
            </div>
          </div>
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
              <IconRefresh width={14} height={14} className={refreshingAll ? "pwi-spin-inline" : ""} aria-hidden="true" />
              {" "}
              {refreshingAll ? t("codexAuth.refreshingQuota") : t("pws.refreshAllQuotas")}
            </button>
          </div>
        )}
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

                    {analyzedList.some(a => Boolean(a.generic5h || a.gemini5h || a.claude5h)) && (
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
