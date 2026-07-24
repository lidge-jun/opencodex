import { usePolling } from "../hooks/usePolling";
import { fetchHealth, stopProxy } from "../api";
import { useState } from "react";

function formatUptime(seconds: number): string {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

export default function Status() {
  const { data, loading, error } = usePolling(fetchHealth, 15000);
  const [stopping, setStopping] = useState(false);
  const [stopResult, setStopResult] = useState<string | null>(null);

  const handleStop = async () => {
    setStopping(true);
    setStopResult(null);
    const ok = await stopProxy();
    setStopResult(ok ? "Proxy stopped" : "Stop failed");
    setTimeout(() => {
      setStopping(false);
      setStopResult(null);
    }, 5000);
  };

  if (loading && !data) return <div className="section-loading">Loading status…</div>;
  if (error && !data) return <div className="section-error">Proxy appears to be offline</div>;
  if (!data) return null;

  return (
    <div className="section status-section">
      <div className="stat-grid">
        <div className="stat-card">
          <span className="stat-value status-ok">●</span>
          <span className="stat-label">Status: {data.status}</span>
        </div>
        <div className="stat-card">
          <span className="stat-value">{data.version}</span>
          <span className="stat-label">Version</span>
        </div>
        <div className="stat-card">
          <span className="stat-value">{formatUptime(data.uptime)}</span>
          <span className="stat-label">Uptime</span>
        </div>
      </div>
      <div className="actions-row">
        <button className="action-btn restart" onClick={handleStop} disabled={stopping}>
          {stopping ? "Stopping…" : "Stop Proxy"}
        </button>
        {stopResult && <span className="action-result">{stopResult}</span>}
      </div>
    </div>
  );
}
