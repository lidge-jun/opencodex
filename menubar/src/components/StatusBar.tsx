interface StatusBarProps {
  online: boolean;
  version: string | null;
  uptime: number | null;
}

function formatUptime(seconds: number): string {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

export function StatusBar({ online, version, uptime }: StatusBarProps) {
  const dotClass = online ? "online" : "offline";

  return (
    <div className="status-bar">
      <span className={`status-dot ${dotClass}`} />
      <span>OpenCodex</span>
      {version && <span style={{ color: "#888" }}>v{version}</span>}
      <span style={{ flex: 1 }} />
      {online && uptime != null && (
        <span style={{ color: "#888" }}>{formatUptime(uptime)}</span>
      )}
      {!online && <span style={{ color: "#8e8e93" }}>Offline</span>}
    </div>
  );
}
