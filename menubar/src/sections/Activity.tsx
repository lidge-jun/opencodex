import { usePolling } from "../hooks/usePolling";
import { fetchRequestLog } from "../api";

function timeAgo(ts: number): string {
  const diff = Date.now() - ts;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function statusColor(code: number): string {
  if (code >= 200 && code < 300) return "ok";
  if (code >= 400 && code < 500) return "warn";
  return "error";
}

export default function Activity() {
  const { data, loading, error } = usePolling(() => fetchRequestLog(20), 10000);

  if (loading && !data) return <div className="section-loading">Loading activity…</div>;
  if (error && !data) return <div className="section-error">Unable to fetch request log</div>;
  if (!data || data.length === 0) return <div className="section-empty">No recent requests</div>;

  // Show newest first (API returns oldest-first)
  const entries = [...data].reverse();

  return (
    <div className="section activity-section">
      <div className="request-list">
        {entries.map((r, i) => (
          <div key={r.requestId ?? i} className="request-row">
            <span className={`req-status ${statusColor(r.status)}`}>{r.status}</span>
            <span className="req-model" title={r.model}>{r.model}</span>
            <span className="req-provider">{r.provider}</span>
            <span className="req-latency">
              {r.firstOutputMs != null ? `${r.firstOutputMs}ms` : r.durationMs != null ? `${r.durationMs}ms` : "—"}
            </span>
            <span className="req-time">{timeAgo(r.timestamp)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
