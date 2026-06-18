import { useEffect, useState } from "react";

interface Config {
  port: number;
  defaultProvider: string;
  providers: Record<string, { adapter: string; baseUrl: string; apiKey?: string; defaultModel?: string }>;
}

export default function Providers({ apiBase }: { apiBase: string }) {
  const [config, setConfig] = useState<Config | null>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [status, setStatus] = useState("");

  const fetchConfig = async () => {
    try {
      const res = await fetch(`${apiBase}/api/config`);
      const data = await res.json();
      setConfig(data);
      setDraft(JSON.stringify(data, null, 2));
    } catch {
      setStatus("Failed to load config");
    }
  };

  useEffect(() => { fetchConfig(); }, [apiBase]);

  const saveConfig = async () => {
    try {
      const parsed = JSON.parse(draft);
      const res = await fetch(`${apiBase}/api/config`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(parsed),
      });
      if (res.ok) {
        setStatus("Saved! Restart proxy to apply.");
        setEditing(false);
        fetchConfig();
      } else {
        setStatus("Save failed");
      }
    } catch {
      setStatus("Invalid JSON");
    }
  };

  if (!config) return <div>Loading...</div>;

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
        <h3 style={{ fontSize: 16, margin: 0 }}>Provider Configuration</h3>
        <div style={{ display: "flex", gap: 8 }}>
          {editing ? (
            <>
              <button onClick={saveConfig} style={btnStyle("#3b82f6")}>Save</button>
              <button onClick={() => { setEditing(false); setDraft(JSON.stringify(config, null, 2)); }} style={btnStyle("#888")}>Cancel</button>
            </>
          ) : (
            <button onClick={() => setEditing(true)} style={btnStyle("#3b82f6")}>Edit JSON</button>
          )}
        </div>
      </div>
      {status && <div style={{ fontSize: 13, color: status.includes("Saved") ? "#22c55e" : "#ef4444", marginBottom: 12 }}>{status}</div>}
      {editing ? (
        <textarea
          value={draft}
          onChange={e => setDraft(e.target.value)}
          style={{ width: "100%", height: 400, fontFamily: "monospace", fontSize: 13, padding: 12, borderRadius: 8, border: "1px solid #e5e7eb", resize: "vertical" }}
        />
      ) : (
        <div>
          <div style={{ fontSize: 13, color: "#888", marginBottom: 8 }}>Port: {config.port} · Default: {config.defaultProvider}</div>
          {Object.entries(config.providers).map(([name, prov]) => (
            <div key={name} style={{ background: "#f9fafb", borderRadius: 8, padding: 16, marginBottom: 8 }}>
              <div style={{ fontWeight: 600, marginBottom: 4 }}>{name}</div>
              <div style={{ fontSize: 13, color: "#666" }}>
                Adapter: <code>{prov.adapter}</code> · URL: {prov.baseUrl}
                {prov.defaultModel && <> · Model: {prov.defaultModel}</>}
                {prov.apiKey && <> · Key: {prov.apiKey}</>}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

const btnStyle = (bg: string) => ({
  padding: "6px 14px", borderRadius: 6, border: "none", background: bg,
  color: "#fff", fontSize: 13, cursor: "pointer" as const,
});
