import { usePolling } from "../hooks/usePolling";
import { fetchProviders, toggleProvider, type ProviderInfo } from "../api";
import { useState } from "react";

export default function Health() {
  const { data, loading, error, refresh } = usePolling(fetchProviders, 15000);
  const [toggling, setToggling] = useState<string | null>(null);

  if (loading && !data) return <div className="section-loading">Loading providers…</div>;
  if (error && !data) return <div className="section-error">Unable to fetch provider health</div>;
  if (!data) return null;

  const handleToggle = async (p: ProviderInfo) => {
    setToggling(p.name);
    const newDisabled = !p.disabled;
    const ok = await toggleProvider(p.name, newDisabled);
    if (ok) refresh();
    setToggling(null);
  };

  return (
    <div className="section health-section">
      <div className="provider-list">
        {data.map((p) => (
          <div key={p.name} className={`provider-card ${p.disabled ? "disabled" : ""}`}>
            <div className="provider-info">
              <span className="provider-name">{p.name}</span>
              <span className="provider-adapter">{p.adapter}</span>
            </div>
            <div className="provider-status">
              <span className={`status-dot ${p.disabled ? "off" : p.hasApiKey ? "ok" : "warn"}`} />
              <button
                className="toggle-btn"
                disabled={toggling === p.name}
                onClick={() => handleToggle(p)}
                title={p.disabled ? "Enable provider" : "Disable provider"}
              >
                {toggling === p.name ? "…" : p.disabled ? "Enable" : "Disable"}
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
