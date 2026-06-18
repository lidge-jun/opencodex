import { useEffect, useState } from "react";

interface LogEntry {
  timestamp: number;
  model: string;
  provider: string;
  status: number;
  durationMs: number;
}

export default function Logs({ apiBase }: { apiBase: string }) {
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [autoRefresh, setAutoRefresh] = useState(true);

  useEffect(() => {
    const fetchLogs = async () => {
      try {
        const res = await fetch(`${apiBase}/api/logs`);
        setLogs(await res.json());
      } catch { /* ignore */ }
    };
    fetchLogs();
    if (!autoRefresh) return;
    const interval = setInterval(fetchLogs, 2000);
    return () => clearInterval(interval);
  }, [apiBase, autoRefresh]);

  const statusColor = (s: number) => s >= 200 && s < 300 ? "#22c55e" : s >= 400 ? "#ef4444" : "#f59e0b";

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
        <h3 style={{ fontSize: 16, margin: 0 }}>Request Logs</h3>
        <label style={{ fontSize: 13, color: "#666", cursor: "pointer" }}>
          <input type="checkbox" checked={autoRefresh} onChange={e => setAutoRefresh(e.target.checked)} style={{ marginRight: 4 }} />
          Auto-refresh
        </label>
      </div>
      {logs.length === 0 ? (
        <div style={{ textAlign: "center", padding: 40, color: "#888" }}>No requests yet</div>
      ) : (
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
          <thead>
            <tr style={{ borderBottom: "1px solid #e5e7eb" }}>
              <th style={{ textAlign: "left", padding: 8 }}>Time</th>
              <th style={{ textAlign: "left", padding: 8 }}>Model</th>
              <th style={{ textAlign: "left", padding: 8 }}>Provider</th>
              <th style={{ textAlign: "left", padding: 8 }}>Status</th>
              <th style={{ textAlign: "right", padding: 8 }}>Duration</th>
            </tr>
          </thead>
          <tbody>
            {[...logs].reverse().map((log, i) => (
              <tr key={i} style={{ borderBottom: "1px solid #f3f4f6" }}>
                <td style={{ padding: 8 }}>{new Date(log.timestamp).toLocaleTimeString()}</td>
                <td style={{ padding: 8 }}>{log.model}</td>
                <td style={{ padding: 8 }}>{log.provider}</td>
                <td style={{ padding: 8 }}>
                  <span style={{ color: statusColor(log.status), fontWeight: 600 }}>{log.status}</span>
                </td>
                <td style={{ padding: 8, textAlign: "right" }}>{log.durationMs}ms</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
