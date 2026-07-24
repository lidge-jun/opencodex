interface StatsRowProps {
  requests: number;
  totalTokens: number;
  estimatedCost: number;
  stale: boolean;
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

export function StatsRow({ requests, totalTokens, estimatedCost, stale }: StatsRowProps) {
  return (
    <div className="section">
      <div className="section-title">
        Today {stale && <span className="stale-badge">stale</span>}
      </div>
      <div className="stats-row">
        <div className="stat-item">
          <span className="stat-value">{requests.toLocaleString()}</span>
          <span className="stat-label">requests</span>
        </div>
        <div className="stat-item">
          <span className="stat-value">{formatTokens(totalTokens)}</span>
          <span className="stat-label">tokens</span>
        </div>
        <div className="stat-item">
          <span className="stat-value">${estimatedCost.toFixed(2)}</span>
          <span className="stat-label">est. cost</span>
        </div>
      </div>
    </div>
  );
}
