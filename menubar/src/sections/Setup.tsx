import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";

interface SetupProps {
  onComplete: () => void;
}

export default function Setup({ onComplete }: SetupProps) {
  const [url, setUrl] = useState("http://localhost:8787");
  const [token, setToken] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    try {
      await invoke("set_proxy_url", { url: url.trim() });
      if (token.trim()) {
        await invoke("set_token", { token: token.trim() });
      }
      onComplete();
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="section setup-section">
      <h2 className="setup-title">Connect to OpenCodex</h2>
      <p className="setup-hint">Enter your proxy URL and API token to get started.</p>
      <div className="setup-form">
        <label className="setup-label">
          Proxy URL
          <input
            className="setup-input"
            type="text"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="http://localhost:8787"
          />
        </label>
        <label className="setup-label">
          API Token
          <input
            className="setup-input"
            type="password"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            placeholder="X-OpenCodex-API-Key"
          />
        </label>
        {error && <p className="setup-error">{error}</p>}
        <button className="action-btn setup-btn" onClick={handleSave} disabled={saving}>
          {saving ? "Saving…" : "Connect"}
        </button>
      </div>
    </div>
  );
}
