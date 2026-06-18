import { useEffect, useState } from "react";

interface HealthData {
  status: string;
  version: string;
  uptime: number;
}

interface ProviderInfo {
  name: string;
  adapter: string;
  baseUrl: string;
  defaultModel?: string;
  hasApiKey: boolean;
}

export default function Dashboard({ apiBase }: { apiBase: string }) {
  const [health, setHealth] = useState<HealthData | null>(null);
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [error, setError] = useState("");

  useEffect(() => {
    const fetchData = async () => {
      try {
        const [hRes, pRes] = await Promise.all([
          fetch(`${apiBase}/healthz`),
          fetch(`${apiBase}/api/providers`),
        ]);
        setHealth(await hRes.json());
        setProviders(await pRes.json());
        setError("");
      } catch {
        setError("Cannot connect to proxy. Is it running?");
      }
    };
    fetchData();
    const interval = setInterval(fetchData, 5000);
    return () => clearInterval(interval);
  }, [apiBase]);

  const card = (title: string, value: string, color = "#111") => (
    <div style={{ background: "#f9fafb", borderRadius: 8, padding: 16, flex: 1 }}>
      <div style={{ fontSize: 12, color: "#888", marginBottom: 4 }}>{title}</div>
      <div style={{ fontSize: 24, fontWeight: 700, color }}>{value}</div>
    </div>
  );

  if (error) {
    return (
      <div style={{ textAlign: "center", padding: 40 }}>
        <div style={{ fontSize: 40, marginBottom: 12 }}>⚠️</div>
        <div style={{ color: "#ef4444", fontWeight: 600 }}>{error}</div>
        <div style={{ color: "#888", fontSize: 13, marginTop: 8 }}>Run <code>ocx start</code> to start the proxy</div>
      </div>
    );
  }

  return (
    <div>
      <div style={{ display: "flex", gap: 16, marginBottom: 24 }}>
        {card("Status", health?.status === "ok" ? "Online" : "Offline", health?.status === "ok" ? "#22c55e" : "#ef4444")}
        {card("Version", health?.version ?? "—")}
        {card("Uptime", health ? `${Math.floor(health.uptime)}s` : "—")}
        {card("Providers", String(providers.length))}
      </div>

      <h3 style={{ fontSize: 16, marginBottom: 12 }}>Active Providers</h3>
      {providers.length === 0 ? (
        <div style={{ color: "#888", fontSize: 13 }}>No providers configured. Run <code>ocx init</code>.</div>
      ) : (
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
          <thead>
            <tr style={{ borderBottom: "1px solid #e5e7eb" }}>
              <th style={{ textAlign: "left", padding: 8 }}>Name</th>
              <th style={{ textAlign: "left", padding: 8 }}>Adapter</th>
              <th style={{ textAlign: "left", padding: 8 }}>Base URL</th>
              <th style={{ textAlign: "left", padding: 8 }}>Model</th>
              <th style={{ textAlign: "left", padding: 8 }}>Auth</th>
            </tr>
          </thead>
          <tbody>
            {providers.map(p => (
              <tr key={p.name} style={{ borderBottom: "1px solid #f3f4f6" }}>
                <td style={{ padding: 8, fontWeight: 600 }}>{p.name}</td>
                <td style={{ padding: 8 }}><code>{p.adapter}</code></td>
                <td style={{ padding: 8, fontSize: 12, color: "#666" }}>{p.baseUrl}</td>
                <td style={{ padding: 8 }}>{p.defaultModel ?? "—"}</td>
                <td style={{ padding: 8 }}>{p.hasApiKey ? "✅" : "❌"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
