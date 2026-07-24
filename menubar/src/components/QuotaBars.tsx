export interface QuotaReport {
  provider: string;
  label: string;
  quota: {
    fiveHourPercent?: number;
    weeklyPercent?: number;
    monthlyPercent?: number;
  };
}

interface QuotaBarsProps {
  reports: QuotaReport[];
  onRefresh: () => void;
  refreshing: boolean;
  stale: boolean;
}

function quotaLevel(percent: number): string {
  if (percent >= 80) return "critical";
  if (percent >= 60) return "warning";
  return "ok";
}

export function QuotaBars({ reports, onRefresh, refreshing, stale }: QuotaBarsProps) {
  return (
    <div className="section">
      <div className="section-title" style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <span>
          Quota {stale && <span className="stale-badge">stale</span>}
        </span>
        <button
          className="btn"
          style={{ flex: "none", padding: "2px 8px", fontSize: 10 }}
          onClick={onRefresh}
          disabled={refreshing}
        >
          {refreshing ? "…" : "↻"}
        </button>
      </div>
      {reports.length === 0 && (
        <div style={{ color: "#888", fontSize: 11 }}>No quota data</div>
      )}
      {reports.map((report) => {
        const percent = report.quota.fiveHourPercent ?? report.quota.weeklyPercent ?? 0;
        const windowLabel = report.quota.fiveHourPercent != null ? "5h" : "wk";
        return (
          <div key={report.provider} className="quota-item">
            <div className="quota-header">
              <span>{report.label}</span>
              <span>{Math.round(percent)}% ({windowLabel})</span>
            </div>
            <div className="quota-bar">
              <div
                className={`quota-fill ${quotaLevel(percent)}`}
                style={{ width: `${Math.min(percent, 100)}%` }}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}
