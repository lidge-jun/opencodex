import { usePolling } from "../hooks/usePolling";
import { fetchUsage } from "../api";

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

export default function Usage() {
  const { data, loading, error } = usePolling(() => fetchUsage("7d"), 30000);

  if (loading && !data) return <div className="section-loading">Loading usage…</div>;
  if (error && !data) return <div className="section-error">Unable to fetch usage data</div>;
  if (!data) return null;

  const s = data.summary;

  return (
    <div className="section usage-section">
      <div className="stat-grid">
        <div className="stat-card">
          <span className="stat-value">{formatTokens(s.totalTokens)}</span>
          <span className="stat-label">Total Tokens (7d)</span>
        </div>
        <div className="stat-card">
          <span className="stat-value">{s.requests}</span>
          <span className="stat-label">Requests</span>
        </div>
        <div className="stat-card">
          <span className="stat-value">
            {s.estimatedCostUsd != null ? `$${s.estimatedCostUsd.toFixed(2)}` : "—"}
          </span>
          <span className="stat-label">Est. Cost</span>
        </div>
        <div className="stat-card">
          <span className="stat-value">{(s.coverageRatio * 100).toFixed(0)}%</span>
          <span className="stat-label">Coverage</span>
        </div>
      </div>
      {(s.inputTokens != null || s.outputTokens != null) && (
        <div className="token-breakdown">
          {s.inputTokens != null && <span>↓ {formatTokens(s.inputTokens)} in</span>}
          {s.outputTokens != null && <span>↑ {formatTokens(s.outputTokens)} out</span>}
        </div>
      )}
    </div>
  );
}
