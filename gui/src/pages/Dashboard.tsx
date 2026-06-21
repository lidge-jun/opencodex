import { useEffect, useMemo, useState } from "react";
import { IconAlert } from "../icons";
import { useT, Trans } from "../i18n";

interface HealthData { status: string; version: string; uptime: number }
interface ProviderInfo { name: string; adapter: string; baseUrl: string; defaultModel?: string; hasApiKey: boolean }
interface ModelInfo { id: string; provider: string; owned_by?: string }
interface SettingsData { codexAutoStart: boolean; port: number; hostname: string }

export default function Dashboard({ apiBase }: { apiBase: string }) {
  const t = useT();
  const [health, setHealth] = useState<HealthData | null>(null);
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [settings, setSettings] = useState<SettingsData | null>(null);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [settingsSaving, setSettingsSaving] = useState(false);
  const [error, setError] = useState(false);

  useEffect(() => {
    const fetchData = async () => {
      try {
        const [hRes, pRes, sRes] = await Promise.all([
          fetch(`${apiBase}/healthz`),
          fetch(`${apiBase}/api/providers`),
          fetch(`${apiBase}/api/settings`),
        ]);
        setHealth(await hRes.json());
        setProviders(await pRes.json());
        setSettings(await sRes.json());
        setError(false);
      } catch {
        setError(true);
      }
    };
    fetchData();
    const interval = setInterval(fetchData, 5000);
    return () => clearInterval(interval);
  }, [apiBase]);

  useEffect(() => {
    if (error) return;
    setModelsLoading(true);
    fetch(`${apiBase}/api/models`)
      .then(r => r.json())
      .then((data: ModelInfo[]) => { setModels(data); setModelsLoading(false); })
      .catch(() => setModelsLoading(false));
  }, [apiBase, error]);

  // Group models by provider so the list reads as provider → its models, not one flat wall of cards.
  const grouped = useMemo(() => {
    const g: Record<string, ModelInfo[]> = {};
    for (const m of models) (g[m.provider] ??= []).push(m);
    return Object.entries(g).sort(([a], [b]) => a.localeCompare(b));
  }, [models]);

  if (error) {
    return (
      <div className="empty" style={{ marginTop: 40 }}>
        <IconAlert />
        <div className="title" style={{ color: "var(--red)" }}>{t("dash.cannotConnect")}</div>
        <div style={{ fontSize: 13 }}><Trans k="dash.runStart" cmd="ocx start" /></div>
      </div>
    );
  }

  const online = health?.status === "ok";

  const toggleCodexAutoStart = async () => {
    if (!settings || settingsSaving) return;
    const next = !settings.codexAutoStart;
    setSettingsSaving(true);
    setSettings({ ...settings, codexAutoStart: next });
    try {
      const res = await fetch(`${apiBase}/api/settings`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ codexAutoStart: next }),
      });
      if (!res.ok) throw new Error("save failed");
      const data = await res.json();
      setSettings(prev => prev ? { ...prev, codexAutoStart: data.codexAutoStart } : prev);
    } catch {
      setSettings(prev => prev ? { ...prev, codexAutoStart: !next } : prev);
    } finally {
      setSettingsSaving(false);
    }
  };

  return (
    <>
      <div className="page-head"><h2>{t("nav.dashboard")}</h2></div>
      <p className="page-sub">{t("dash.subtitle")}</p>

      <div className="stat-row">
        <div className="stat">
          <div className="label">{t("dash.status")}</div>
          <div className="value" style={{ display: "flex", alignItems: "center", gap: 9, color: online ? "var(--green)" : "var(--red)" }}>
            <span className={`dot ${online ? "dot-green" : "dot-red"}`} />{online ? t("dash.online") : t("dash.offline")}
          </div>
        </div>
        <div className="stat"><div className="label">{t("dash.version")}</div><div className="value mono">{health?.version ?? "—"}</div></div>
        <div className="stat"><div className="label">{t("dash.uptime")}</div><div className="value mono">{health ? `${Math.floor(health.uptime)}s` : "—"}</div></div>
        <div className="stat"><div className="label">{t("dash.providers")}</div><div className="value">{providers.length}</div></div>
      </div>

      <div className="panel" style={{ marginBottom: 24 }}>
        <div className="spread">
          <div>
            <div style={{ fontWeight: 650 }}>{t("dash.codexAutoStart")}</div>
            <div className="muted" style={{ fontSize: 13, marginTop: 3 }}>{t("dash.codexAutoStartHint")}</div>
          </div>
          <button
            className={`switch ${settings?.codexAutoStart ?? true ? "on" : ""}`}
            onClick={toggleCodexAutoStart}
            disabled={!settings || settingsSaving}
            aria-label={t("dash.codexAutoStart")}
            aria-pressed={settings?.codexAutoStart ?? true}
          >
            <span className="knob" />
          </button>
        </div>
      </div>

      <div className="h-section">{t("dash.activeProviders")} <span className="count">{providers.length}</span></div>
      {providers.length === 0 ? (
        <div className="empty"><Trans k="dash.noProviders" cmd="ocx init" /></div>
      ) : (
        <div className="tbl-wrap">
          <table className="tbl">
            <thead><tr><th>{t("dash.col.name")}</th><th>{t("dash.col.adapter")}</th><th>{t("dash.col.baseUrl")}</th><th>{t("dash.col.model")}</th></tr></thead>
            <tbody>
              {providers.map(p => (
                <tr key={p.name}>
                  <td style={{ fontWeight: 600 }}>{p.name}</td>
                  <td><span className="chip">{p.adapter}</span></td>
                  <td className="muted mono" style={{ fontSize: 12 }}>{p.baseUrl}</td>
                  <td className="muted">{p.defaultModel ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="h-section">
        {t("dash.availableModels")} <span className="count">{models.length}</span>
        {modelsLoading && <span className="spin" style={{ marginLeft: 4 }} />}
      </div>
      {models.length === 0 && !modelsLoading ? (
        <div className="empty">{t("dash.noModels")}</div>
      ) : (
        <div className="stack" style={{ gap: 16 }}>
          {grouped.map(([provider, rows]) => (
            <div key={provider} className="model-group">
              <div className="model-group-head">{provider}<span className="count">{rows.length}</span></div>
              <div className="model-grid">
                {rows.map(m => (
                  <div key={`${m.provider}/${m.id}`} className="model-card">
                    <div className="id">{m.id}</div>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </>
  );
}
