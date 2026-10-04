import { useCallback, useEffect, useState, useMemo } from "react";
import { useI18n } from "../i18n/shared";
import { formatProviderDisplayName, providerIconSrc, providerIconPaint } from "../provider-icons";
import { IconRefresh, IconSearch, IconActivity, IconAlert, IconCheck, IconExternal, IconGrid, IconList } from "../icons";
import { readJsonOrThrow } from "../fetch-json";
import { buildQuotaSummary, formatQuotaPercent, type QuotaSummaryRow, type QuotaSummarySeverity } from "../quota-summary";
import { freshQuotaReportsFromResponse, type ProviderQuotaReportView } from "../provider-workspace/report";
import { EmptyState, Notice } from "../ui";

interface QuotaPageProps {
  apiBase: string;
  active?: boolean;
}

export default function QuotaPage({ apiBase, active = true }: QuotaPageProps) {
  const { t } = useI18n();
  const tr = (k: string, fb: string) => (t as unknown as (key: string) => string)(k) || fb;
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reports, setReports] = useState<Record<string, ProviderQuotaReportView>>({});
  const [viewMode, setViewMode] = useState<"cards" | "table">("cards");
  const [search, setSearch] = useState("");
  const [severityFilter, setSeverityFilter] = useState<"all" | "critical" | "warn" | "normal">("all");

  const loadQuotas = useCallback(async (force = false) => {
    if (force) setRefreshing(true);
    setError(null);
    try {
      const url = `${apiBase}/api/provider-quotas${force ? "?refresh=1" : ""}`;
      const res = await fetch(url);
      const data = await readJsonOrThrow(res);
      const parsed = freshQuotaReportsFromResponse(data);
      setReports(parsed);
    } catch (err: unknown) {
      setError((err as Error).message || "Failed to load provider quotas");
    } finally {
      setRefreshing(false);
    }
  }, [apiBase]);

  useEffect(() => {
    if (active) {
      void loadQuotas(false);
      const interval = setInterval(() => {
        void loadQuotas(false);
      }, 60_000);
      return () => clearInterval(interval);
    }
  }, [active, loadQuotas]);

  const summaryRows: QuotaSummaryRow[] = useMemo(() => {
    return buildQuotaSummary(reports, provider => formatProviderDisplayName(provider, t));
  }, [reports, t]);

  const stats = useMemo(() => {
    const total = summaryRows.length;
    let normal = 0;
    let warn = 0;
    let critical = 0;
    for (const row of summaryRows) {
      if (row.severity === "critical") critical += 1;
      else if (row.severity === "warn") warn += 1;
      else normal += 1;
    }
    return { total, normal, warn, critical };
  }, [summaryRows]);

  const filteredRows = useMemo(() => {
    return summaryRows.filter(row => {
      if (severityFilter !== "all" && row.severity !== severityFilter) return false;
      if (search.trim()) {
        const query = search.trim().toLowerCase();
        const displayName = formatProviderDisplayName(row.provider, t).toLowerCase();
        return row.provider.toLowerCase().includes(query) || displayName.includes(query);
      }
      return true;
    });
  }, [summaryRows, severityFilter, search, t]);

  const formatResetTime = (timestamp?: number): string => {
    if (!timestamp || !Number.isFinite(timestamp)) return "-";
    const now = Date.now();
    const diffMs = timestamp - now;
    if (diffMs <= 0) return tr("quota.resetsSoon", "Resetting soon");
    const diffHours = Math.floor(diffMs / 3_600_000);
    const diffMins = Math.floor((diffMs % 3_600_000) / 60_000);
    if (diffHours < 24) {
      return `${diffHours}h ${diffMins}m remaining`;
    }
    const days = Math.floor(diffHours / 24);
    return `in ${days}d ${diffHours % 24}h`;
  };

  const getSeverityColor = (sev: QuotaSummarySeverity): string => {
    if (sev === "critical") return "var(--red, #ef4444)";
    if (sev === "warn") return "var(--amber, #f59e0b)";
    return "var(--green, #10b981)";
  };

  return (
    <div style={{ padding: "24px 32px", maxWidth: 1200, margin: "0 auto", display: "flex", flexDirection: "column", gap: 24 }}>
      {/* Top Header */}
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", flexWrap: "wrap", gap: 16 }}>
        <div>
          <h1 style={{ margin: 0, fontSize: "1.6rem", fontWeight: 700, display: "flex", alignItems: "center", gap: 10 }}>
            <IconActivity width={24} height={24} style={{ color: "var(--accent)" }} />
            {tr("quota.title", "Quota & Provider Limits")}
          </h1>
          <p className="muted" style={{ margin: "4px 0 0", fontSize: "0.9rem" }}>
            {tr("quota.subtitle", "Track rolling utilization, credit balances, and reset countdowns across all upstream providers.")}
          </p>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <div style={{ display: "inline-flex", background: "var(--raised)", borderRadius: 8, padding: 3, border: "1px solid var(--border)" }}>
            <button
              type="button"
              className={`btn btn-sm ${viewMode === "cards" ? "btn-primary" : "btn-ghost"}`}
              style={{ padding: "4px 10px" }}
              onClick={() => setViewMode("cards")}
              title="Cards View"
            >
              <IconGrid width={14} height={14} />
            </button>
            <button
              type="button"
              className={`btn btn-sm ${viewMode === "table" ? "btn-primary" : "btn-ghost"}`}
              style={{ padding: "4px 10px" }}
              onClick={() => setViewMode("table")}
              title="Table View"
            >
              <IconList width={14} height={14} />
            </button>
          </div>

          <button
            type="button"
            className="btn btn-ghost"
            onClick={() => void loadQuotas(true)}
            disabled={refreshing}
            style={{ display: "inline-flex", alignItems: "center", gap: 6 }}
          >
            <IconRefresh width={14} height={14} style={{ animation: refreshing ? "spin 1s linear infinite" : undefined }} />
            {refreshing ? tr("codexAuth.refreshingQuota", "Refreshing...") : tr("quota.refresh", "Refresh Quotas")}
          </button>
        </div>
      </div>

      {error && <Notice tone="err">{error}</Notice>}

      {/* Summary KPI Cards */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 16 }}>
        <div style={{ background: "var(--raised)", padding: "16px 20px", borderRadius: 10, border: "1px solid var(--border)" }}>
          <div className="muted" style={{ fontSize: "0.8rem", fontWeight: 600, textTransform: "uppercase" }}>
            {tr("quota.monitoredProviders", "Monitored Providers")}
          </div>
          <div style={{ fontSize: "1.8rem", fontWeight: 700, marginTop: 4 }}>{stats.total}</div>
        </div>

        <div style={{ background: "var(--raised)", padding: "16px 20px", borderRadius: 10, border: "1px solid var(--border)" }}>
          <div style={{ color: "var(--green, #10b981)", fontSize: "0.8rem", fontWeight: 600, textTransform: "uppercase", display: "flex", alignItems: "center", gap: 6 }}>
            <IconCheck width={14} height={14} /> {tr("quota.normalStatus", "Healthy (<70%)")}
          </div>
          <div style={{ fontSize: "1.8rem", fontWeight: 700, marginTop: 4 }}>{stats.normal}</div>
        </div>

        <div style={{ background: "var(--raised)", padding: "16px 20px", borderRadius: 10, border: "1px solid var(--border)" }}>
          <div style={{ color: "var(--amber, #f59e0b)", fontSize: "0.8rem", fontWeight: 600, textTransform: "uppercase", display: "flex", alignItems: "center", gap: 6 }}>
            <IconAlert width={14} height={14} /> {tr("quota.warnStatus", "Warning (70-90%)")}
          </div>
          <div style={{ fontSize: "1.8rem", fontWeight: 700, marginTop: 4 }}>{stats.warn}</div>
        </div>

        <div style={{ background: "var(--raised)", padding: "16px 20px", borderRadius: 10, border: "1px solid var(--border)" }}>
          <div style={{ color: "var(--red, #ef4444)", fontSize: "0.8rem", fontWeight: 600, textTransform: "uppercase", display: "flex", alignItems: "center", gap: 6 }}>
            <IconAlert width={14} height={14} /> {tr("quota.criticalStatus", "Critical (>90%)")}
          </div>
          <div style={{ fontSize: "1.8rem", fontWeight: 700, marginTop: 4 }}>{stats.critical}</div>
        </div>
      </div>

      {/* Filter and Search Bar */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 12 }}>
        <div style={{ position: "relative", minWidth: 260 }}>
          <IconSearch width={14} height={14} style={{ position: "absolute", left: 10, top: 11, color: "var(--muted)" }} />
          <input
            className="input"
            type="search"
            placeholder={tr("pws.searchPlaceholder", "Search providers...")}
            style={{ paddingLeft: 32, width: "100%" }}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          {(["all", "normal", "warn", "critical"] as const).map(sev => (
            <button
              key={sev}
              type="button"
              className={`btn btn-sm ${severityFilter === sev ? "btn-primary" : "btn-ghost"}`}
              style={{ textTransform: "capitalize", fontSize: "0.82rem" }}
              onClick={() => setSeverityFilter(sev)}
            >
              {sev === "all" ? tr("quota.allFilters", "All") : sev}
            </button>
          ))}
        </div>
      </div>

      {/* Main Content Area */}
      {filteredRows.length === 0 ? (
        <EmptyState
          icon={<IconActivity width={48} height={48} />}
          title={tr("quota.noQuotasTitle", "No provider quotas to display")}
        >
          <p className="muted" style={{ margin: "8px 0 0", fontSize: "0.88rem" }}>
            {tr("quota.noQuotasDesc", "Add accounts or providers that report quota metrics (like OpenAI/Codex, Claude, Kimi, Z.AI) to track them here.")}
          </p>
        </EmptyState>
      ) : viewMode === "cards" ? (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(340px, 1fr))", gap: 18 }}>
          {filteredRows.map(row => {
            const iconSrc = providerIconSrc(row.provider);
            const paint = providerIconPaint(iconSrc);
            const displayName = formatProviderDisplayName(row.provider, t);

            return (
              <div
                key={row.provider}
                style={{
                  background: "var(--raised)",
                  borderRadius: 12,
                  border: `1px solid ${row.severity === "critical" ? "var(--red, #ef4444)" : "var(--border)"}`,
                  padding: "18px 20px",
                  display: "flex",
                  flexDirection: "column",
                  gap: 16,
                  boxShadow: "0 2px 8px rgba(0,0,0,0.04)",
                }}
              >
                {/* Provider Card Header */}
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                    {iconSrc ? (
                      <div
                        style={{
                          width: 28,
                          height: 28,
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "center",
                          borderRadius: 6,
                          background: paint === "plate" ? "#fff" : paint === "dark-plate" ? "#1e1e1e" : "transparent",
                        }}
                      >
                        <img src={iconSrc} alt={displayName} style={{ width: 22, height: 22, objectFit: "contain" }} />
                      </div>
                    ) : (
                      <div style={{ width: 28, height: 28, borderRadius: 6, background: "var(--accent)", color: "#fff", display: "flex", alignItems: "center", justifyContent: "center", fontWeight: 700, fontSize: "0.85rem" }}>
                        {displayName.slice(0, 1).toUpperCase()}
                      </div>
                    )}
                    <div>
                      <div style={{ fontWeight: 600, fontSize: "1rem" }}>{displayName}</div>
                      <div className="muted" style={{ fontSize: "0.75rem" }}>{row.provider}</div>
                    </div>
                  </div>

                  <span
                    style={{
                      fontSize: "0.75rem",
                      fontWeight: 600,
                      padding: "2px 8px",
                      borderRadius: 12,
                      background: row.severity === "critical" ? "rgba(239,68,68,0.15)" : row.severity === "warn" ? "rgba(245,158,11,0.15)" : "rgba(16,185,129,0.15)",
                      color: getSeverityColor(row.severity),
                      textTransform: "capitalize",
                    }}
                  >
                    {row.severity}
                  </span>
                </div>

                {/* Progress Bars for Windows */}
                <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                  {row.windows.map(win => {
                    const label = win.labelKey ? t(win.labelKey) : win.label || win.id;
                    const percent = win.percent ?? 0;
                    const sevColor = getSeverityColor(win.severity);

                    return (
                      <div key={win.id} style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                        <div style={{ display: "flex", justifyContent: "space-between", fontSize: "0.82rem" }}>
                          <span style={{ fontWeight: 500 }}>{label}</span>
                          <span style={{ fontWeight: 600, color: sevColor }}>{formatQuotaPercent(win.percent)}</span>
                        </div>
                        <div style={{ width: "100%", height: 7, borderRadius: 4, background: "var(--border)", overflow: "hidden" }}>
                          <div
                            style={{
                              width: `${Math.min(100, Math.max(0, percent))}%`,
                              height: "100%",
                              background: sevColor,
                              borderRadius: 4,
                              transition: "width 0.3s ease",
                            }}
                          />
                        </div>
                        {win.resetAt && (
                          <div className="muted" style={{ fontSize: "0.72rem", textAlign: "right" }}>
                            {formatResetTime(win.resetAt)}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>

                {/* Card Footer Link */}
                <div style={{ paddingTop: 8, borderTop: "1px solid var(--border)", display: "flex", justifyContent: "flex-end" }}>
                  <a
                    href={`#providers?provider=${row.provider}&tab=accounts`}
                    style={{ fontSize: "0.8rem", color: "var(--accent)", display: "inline-flex", alignItems: "center", gap: 4, textDecoration: "none" }}
                  >
                    {tr("quota.manageAccounts", "Manage Accounts")}
                    <IconExternal width={12} height={12} />
                  </a>
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        /* Table View */
        <div style={{ background: "var(--raised)", borderRadius: 10, border: "1px solid var(--border)", overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.88rem" }}>
            <thead>
              <tr style={{ borderBottom: "1px solid var(--border)", textAlign: "left", background: "rgba(0,0,0,0.02)" }}>
                <th style={{ padding: "12px 16px" }}>{tr("quota.provider", "Provider")}</th>
                <th style={{ padding: "12px 16px" }}>{tr("quota.window", "Window / Metric")}</th>
                <th style={{ padding: "12px 16px", minWidth: 200 }}>{tr("quota.utilization", "Utilization")}</th>
                <th style={{ padding: "12px 16px" }}>{tr("quota.resets", "Resets")}</th>
                <th style={{ padding: "12px 16px" }}>{tr("quota.status", "Status")}</th>
                <th style={{ padding: "12px 16px", textAlign: "right" }}>{tr("quota.action", "Action")}</th>
              </tr>
            </thead>
            <tbody>
              {filteredRows.flatMap(row => {
                const displayName = formatProviderDisplayName(row.provider, t);
                const iconSrc = providerIconSrc(row.provider);

                return row.windows.map((win, winIdx) => {
                  const label = win.labelKey ? t(win.labelKey) : win.label || win.id;
                  const percent = win.percent ?? 0;
                  const sevColor = getSeverityColor(win.severity);

                  return (
                    <tr key={`${row.provider}-${win.id}`} style={{ borderBottom: "1px solid var(--border)" }}>
                      <td style={{ padding: "12px 16px", fontWeight: winIdx === 0 ? 600 : 400 }}>
                        {winIdx === 0 ? (
                          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                            {iconSrc && <img src={iconSrc} alt="" style={{ width: 18, height: 18 }} />}
                            {displayName}
                          </div>
                        ) : (
                          <span className="muted" style={{ paddingLeft: 26 }}>↳</span>
                        )}
                      </td>
                      <td style={{ padding: "12px 16px" }}>{label}</td>
                      <td style={{ padding: "12px 16px" }}>
                        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                          <div style={{ flex: 1, height: 6, borderRadius: 3, background: "var(--border)", overflow: "hidden" }}>
                            <div
                              style={{
                                width: `${Math.min(100, Math.max(0, percent))}%`,
                                height: "100%",
                                background: sevColor,
                                borderRadius: 3,
                              }}
                            />
                          </div>
                          <span style={{ fontWeight: 600, color: sevColor, minWidth: 40, textAlign: "right", fontSize: "0.82rem" }}>
                            {formatQuotaPercent(win.percent)}
                          </span>
                        </div>
                      </td>
                      <td style={{ padding: "12px 16px", color: "var(--muted)", fontSize: "0.82rem" }}>
                        {formatResetTime(win.resetAt)}
                      </td>
                      <td style={{ padding: "12px 16px" }}>
                        <span
                          style={{
                            fontSize: "0.75rem",
                            fontWeight: 600,
                            padding: "2px 8px",
                            borderRadius: 12,
                            background: win.severity === "critical" ? "rgba(239,68,68,0.15)" : win.severity === "warn" ? "rgba(245,158,11,0.15)" : "rgba(16,185,129,0.15)",
                            color: sevColor,
                            textTransform: "capitalize",
                          }}
                        >
                          {win.severity}
                        </span>
                      </td>
                      <td style={{ padding: "12px 16px", textAlign: "right" }}>
                        <a
                          href={`#providers?provider=${row.provider}&tab=accounts`}
                          className="btn btn-ghost btn-sm"
                          style={{ textDecoration: "none" }}
                        >
                          {tr("quota.manage", "Manage")}
                        </a>
                      </td>
                    </tr>
                  );
                });
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
