import { useEffect, useMemo, useRef, useState } from "react";
import { formatUptime } from "../formatUptime";
import { IconAlert, IconExternal, IconInfo, IconRefresh, IconX } from "../icons";
import { useI18n, Trans } from "../i18n";
import { formatTokens } from "../format-tokens";
import { EmptyState, Select } from "../ui";

interface HealthData { status: string; version: string; uptime: number }
interface ProviderInfo { name: string; adapter: string; baseUrl: string; defaultModel?: string; hasApiKey: boolean }
interface ModelInfo { id: string; provider: string; owned_by?: string }
interface SettingsData { codexAutoStart: boolean; port: number; hostname: string }
interface SidecarData { webSearch: { model: string; reasoning: string }; vision: { model: string } }
interface UsageSummary30d { summary: { requests: number; totalTokens: number; coverageRatio: number } }
type UpdateChannel = "latest" | "preview";
type Installer = "npm" | "bun" | "source";
type UpdateJobStatus = "running" | "restarting" | "succeeded" | "failed";
interface SyncResult {
  ok: boolean;
  added: number;
  catalogPath: string | null;
  catalogExists: boolean;
  cacheSynced: boolean;
  message: string;
  warning?: string;
  staleAppServerHint?: string;
  projectConfigWarnings?: ProjectCodexConfigWarning[];
}
interface ProjectCodexConfigWarning {
  path: string;
  code: string;
  detail: string;
  message: string;
}
interface ProjectCodexConfigGroup {
  path: string;
  issues: string[];
  bypass: string;
}
interface UpdateCheckData {
  currentVersion: string;
  latestVersion: string | null;
  channel: UpdateChannel;
  installer: Installer;
  updateAvailable: boolean;
  canUpdate: boolean;
  command: string;
  releaseNotesUrl: string;
  reason?: string;
}
interface UpdateJob {
  id: string;
  status: UpdateJobStatus;
  currentVersion: string;
  latestVersion: string | null;
  channel: UpdateChannel;
  installer: Installer;
  restart: boolean;
  command: string;
  log: string[];
  error?: string;
  restarted?: boolean;
}

import { modelLabel } from "../model-display";

const SEARCH_SIDECAR_MODELS = ["gpt-5.6-luna", "gpt-5.4-mini", "gpt-5.4", "gpt-5.5", "gpt-5.3-codex-spark", "gpt-5.6-sol", "gpt-5.6-terra"];
const VISION_SIDECAR_MODELS = ["gpt-5.6-luna", "gpt-5.4-mini", "gpt-5.4", "gpt-5.5", "gpt-5.6-sol", "gpt-5.6-terra"];
const REASONING_LEVELS = ["low", "medium", "high"];
const UPDATE_CHECK_MAX_AUTO_RETRIES = 2;
const UPDATE_CHECK_RETRY_BASE_MS = 800;

function defaultUpdateChannel(version: string | undefined): UpdateChannel {
  return version?.includes("-preview.") ? "preview" : "latest";
}

function updateReasonLabel(reason: string | undefined, t: (key: import("../i18n").TKey) => string): string {
  switch (reason) {
    case "source_checkout": return t("dash.updateReason.source_checkout");
    case "latest_unavailable": return t("dash.updateReason.latest_unavailable");
    case "already_latest": return t("dash.updateReason.already_latest");
    default: return t("dash.updateReason.unknown");
  }
}

export default function Dashboard({ apiBase }: { apiBase: string }) {
  const { locale, t } = useI18n();
  const [health, setHealth] = useState<HealthData | null>(null);
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [settings, setSettings] = useState<SettingsData | null>(null);
  const [sidecar, setSidecar] = useState<SidecarData | null>(null);
  const [usage30d, setUsage30d] = useState<UsageSummary30d | null>(null);
  const [sidecarSaving, setSidecarSaving] = useState(false);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [settingsSaving, setSettingsSaving] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [maMode, setMaMode] = useState<"v1" | "default" | "v2">("default");
  const [maBusy, setMaBusy] = useState(false);
  const [maHelpOpen, setMaHelpOpen] = useState(false);
  const [injectionModel, setInjectionModel] = useState<string>("");
  const [injectionEffort, setInjectionEffort] = useState<string>("");
  const [injectionEfforts, setInjectionEfforts] = useState<string[]>([]);
  const [injectionAvailable, setInjectionAvailable] = useState<Array<{ provider: string; model: string; namespaced: string }>>([]);
  const [injectionSaving, setInjectionSaving] = useState(false);
  const [syncResult, setSyncResult] = useState<SyncResult | null>(null);
  const [syncError, setSyncError] = useState<string | null>(null);
  const [projectConfigWarnings, setProjectConfigWarnings] = useState<ProjectCodexConfigGroup[]>([]);
  const [updateOpen, setUpdateOpen] = useState(false);
  const [updateChannel, setUpdateChannel] = useState<UpdateChannel>("latest");
  const [updateRestart, setUpdateRestart] = useState(true);
  const [updateLoading, setUpdateLoading] = useState(false);
  const updateRetryRef = useRef(0);
  const updateRetryTimerRef = useRef<number | null>(null);
  const updateRequestEpochRef = useRef(0);
  const [updateCheck, setUpdateCheck] = useState<UpdateCheckData | null>(null);
  const [updateError, setUpdateError] = useState<string | null>(null);
  const [updateJob, setUpdateJob] = useState<UpdateJob | null>(null);
  const [reconnecting, setReconnecting] = useState(false);
  const [error, setError] = useState(false);

  useEffect(() => () => {
    updateRequestEpochRef.current += 1;
    if (updateRetryTimerRef.current !== null) {
      window.clearTimeout(updateRetryTimerRef.current);
      updateRetryTimerRef.current = null;
    }
  }, []);

  useEffect(() => {
    const fetchData = async () => {
      try {
        const [hRes, pRes, sRes, scRes, uRes] = await Promise.all([
          fetch(`${apiBase}/healthz`),
          fetch(`${apiBase}/api/providers`),
          fetch(`${apiBase}/api/settings`),
          fetch(`${apiBase}/api/sidecar-settings`),
          fetch(`${apiBase}/api/usage?range=30d`),
        ]);
        setHealth(await hRes.json());
        setProviders(await pRes.json());
        setSettings(await sRes.json());
        setSidecar(await scRes.json());
        try { setUsage30d(uRes.ok ? await uRes.json() : null); } catch { setUsage30d(null); }
        setError(false);
        // Best-effort v2 mode fetch (independent of core health)
        try {
          const v2Res = await fetch(`${apiBase}/api/v2`);
          if (v2Res.ok) {
            const v2Data = await v2Res.json();
            if (v2Data.multiAgentMode === "v1" || v2Data.multiAgentMode === "v2") setMaMode(v2Data.multiAgentMode);
            else setMaMode("default");
          }
        } catch { /* old server */ }
        try {
          const imRes = await fetch(`${apiBase}/api/injection-model`);
          if (imRes.ok) {
            const imData = await imRes.json() as { model?: string | null; effort?: string | null; efforts?: string[]; available?: Array<{ provider: string; model: string; namespaced: string }> };
            setInjectionModel(imData.model ?? "");
            setInjectionEffort(imData.effort ?? "");
            setInjectionEfforts(imData.efforts ?? []);
            setInjectionAvailable(imData.available ?? []);
          }
        } catch { /* old server */ }
      } catch {
        setError(true);
      }
    };
    fetchData();
    const interval = setInterval(fetchData, 5000);
    return () => clearInterval(interval);
  }, [apiBase]);

  useEffect(() => {
    const fetchDiagnostics = async () => {
      try {
        const pcRes = await fetch(`${apiBase}/api/diagnostics/project-config`);
        const pcData = pcRes.ok ? await pcRes.json() as { grouped?: ProjectCodexConfigGroup[] } : null;
        setProjectConfigWarnings(pcData?.grouped ?? []);
      } catch {
        setProjectConfigWarnings([]);
      }
    };
    void fetchDiagnostics();
    const interval = setInterval(() => void fetchDiagnostics(), 30_000);
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

  useEffect(() => {
    if (!updateJob?.id || !updateJob.restart) return;
    let cancelled = false;
    const targetVersion = updateJob.latestVersion;
    const poll = async () => {
      try {
        const res = await fetch(`${apiBase}/api/update/status?jobId=${encodeURIComponent(updateJob.id)}`);
        if (res.ok) {
          const data = await res.json() as { job?: UpdateJob };
          if (!cancelled && data.job) {
            setUpdateJob(data.job);
            if (data.job.status === "failed") {
              setReconnecting(false);
              return;
            }
          }
        }
      } catch {
        if (!cancelled) setReconnecting(true);
      }

      if (!targetVersion) return;
      try {
        const healthRes = await fetch(`${apiBase}/healthz`, { cache: "no-store" });
        if (!healthRes.ok) throw new Error("health failed");
        const data = await healthRes.json() as HealthData;
        if (!cancelled && data.version === targetVersion) {
          setReconnecting(false);
          window.location.reload();
        }
      } catch {
        if (!cancelled) setReconnecting(true);
      }
    };
    poll();
    const interval = setInterval(poll, 1500);
    return () => { cancelled = true; clearInterval(interval); };
  }, [apiBase, updateJob?.id, updateJob?.latestVersion, updateJob?.restart]);

  // Group models by provider so the list reads as provider → its models, not one flat wall of cards.
  const grouped = useMemo(() => {
    const g: Record<string, ModelInfo[]> = {};
    for (const m of models) (g[m.provider] ??= []).push(m);
    return Object.entries(g).sort(([a], [b]) => a.localeCompare(b));
  }, [models]);

  if (error) {
    return (
      <EmptyState style={{ marginTop: 40 }} icon={<IconAlert />}
        title={<span style={{ color: "var(--red)" }}>{t("dash.cannotConnect")}</span>}>
        <Trans k="dash.runStart" cmd="ocx start" />
      </EmptyState>
    );
  }

  const online = health?.status === "ok";

  const saveSidecar = async (patch: Partial<SidecarData>) => {
    if (!sidecar || sidecarSaving) return;
    const next = {
      webSearch: { ...sidecar.webSearch, ...patch.webSearch },
      vision: { ...sidecar.vision, ...patch.vision },
    };
    setSidecarSaving(true);
    setSidecar(next);
    try {
      const res = await fetch(`${apiBase}/api/sidecar-settings`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(next),
      });
      if (!res.ok) throw new Error("save failed");
      const data = await res.json();
      setSidecar({ webSearch: data.webSearch, vision: data.vision });
    } catch {
      setSidecar(sidecar);
    } finally {
      setSidecarSaving(false);
    }
  };

  const switchMaMode = async (mode: "v1" | "default" | "v2") => {
    if (maBusy || maMode === mode) return;
    setMaBusy(true);
    try {
      const r = await fetch(`${apiBase}/api/v2`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ multiAgentMode: mode }),
      });
      if (r.ok) setMaMode(mode);
    } catch { /* ignore */ }
    finally { setMaBusy(false); }
  };

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
      setError(true);
    } finally {
      setSettingsSaving(false);
    }
  };

  const runSync = async () => {
    if (syncing) return;
    setSyncing(true);
    setSyncResult(null);
    setSyncError(null);
    try {
      const res = await fetch(`${apiBase}/api/sync`, { method: "POST" });
      const data = await res.json() as SyncResult | { error?: string };
      if (!res.ok) throw new Error("error" in data && data.error ? data.error : "sync failed");
      setSyncResult(data as SyncResult);
      const grouped = (data as SyncResult & { projectConfigGrouped?: ProjectCodexConfigGroup[] }).projectConfigGrouped;
      if (grouped) setProjectConfigWarnings(grouped);
    } catch (err) {
      setSyncError(err instanceof Error ? err.message : String(err));
    } finally {
      setSyncing(false);
    }
  };

  const fetchUpdateCheck = async (channel: UpdateChannel, resetRetry = false) => {
    if (resetRetry) updateRetryRef.current = 0;
    if (updateRetryTimerRef.current !== null) {
      window.clearTimeout(updateRetryTimerRef.current);
      updateRetryTimerRef.current = null;
    }
    const requestEpoch = ++updateRequestEpochRef.current;
    setUpdateLoading(true);
    setUpdateError(null);
    setUpdateCheck(null);
    try {
      const res = await fetch(`${apiBase}/api/update/check?tag=${channel}`);
      const data = await res.json() as UpdateCheckData | { error?: string };
      if (!res.ok) throw new Error("error" in data && data.error ? data.error : "update check failed");
      if (requestEpoch !== updateRequestEpochRef.current) return;

      const check = data as UpdateCheckData;
      setUpdateCheck(check);
      if (
        check.reason === "latest_unavailable"
        && updateRetryRef.current < UPDATE_CHECK_MAX_AUTO_RETRIES
      ) {
        const retry = ++updateRetryRef.current;
        updateRetryTimerRef.current = window.setTimeout(() => {
          if (requestEpoch !== updateRequestEpochRef.current) return;
          updateRetryTimerRef.current = null;
          void fetchUpdateCheck(channel);
        }, UPDATE_CHECK_RETRY_BASE_MS * retry);
        return;
      }

      if (check.reason !== "latest_unavailable") updateRetryRef.current = 0;
      setUpdateLoading(false);
    } catch (err) {
      if (requestEpoch !== updateRequestEpochRef.current) return;
      setUpdateError(err instanceof Error ? err.message : String(err));
      setUpdateLoading(false);
    }
  };

  const closeUpdateDialog = () => {
    updateRequestEpochRef.current += 1;
    if (updateRetryTimerRef.current !== null) {
      window.clearTimeout(updateRetryTimerRef.current);
      updateRetryTimerRef.current = null;
    }
    setUpdateLoading(false);
    setUpdateOpen(false);
  };

  const openUpdateDialog = () => {
    const channel = defaultUpdateChannel(health?.version);
    setUpdateChannel(channel);
    setUpdateRestart(true);
    setUpdateOpen(true);
    void fetchUpdateCheck(channel, true);
  };

  const changeUpdateChannel = (channel: UpdateChannel) => {
    setUpdateChannel(channel);
    void fetchUpdateCheck(channel, true);
  };

  const runUpdate = async () => {
    if (!updateCheck?.canUpdate) return;
    setUpdateError(null);
    try {
      const res = await fetch(`${apiBase}/api/update/run`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tag: updateChannel, restart: updateRestart }),
      });
      const data = await res.json() as { job?: UpdateJob; error?: string };
      if (!res.ok || !data.job) throw new Error(data.error ?? "update failed to start");
      setUpdateJob(data.job);
      setReconnecting(false);
      closeUpdateDialog();
    } catch (err) {
      setUpdateError(err instanceof Error ? err.message : String(err));
    }
  };

  const updateJobLabel = (status: UpdateJobStatus): string => {
    switch (status) {
      case "running": return t("dash.updateStatus.running");
      case "restarting": return t("dash.updateStatus.restarting");
      case "succeeded": return t("dash.updateStatus.succeeded");
      case "failed": return t("dash.updateStatus.failed");
    }
  };

  return (
    <>
      <div className="page-head"><h2>{t("nav.dashboard")}</h2></div>
      <p className="page-sub">{t("dash.subtitle")}</p>

      <div className="stat-row">
        <div className="stat">
          <div className="label" style={{ display: "flex", alignItems: "center", gap: 6 }}>
            {t("dash.multiAgent")}
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              style={{ width: 24, height: 24, minWidth: 24, flex: "0 0 24px", padding: 0, borderRadius: 999, color: "var(--muted)" }}
              onClick={() => setMaHelpOpen(true)}
              aria-label={t("dash.multiAgent")}
              aria-haspopup="dialog"
            >
              <IconInfo width={14} height={14} aria-hidden="true" />
            </button>
          </div>
          <div className="value" style={{ display: "flex", alignItems: "center", justifyContent: "center" }}>
            <div role="radiogroup" aria-label={t("dash.multiAgent")} style={{ display: "inline-flex", borderRadius: 999, background: "var(--surface-soft, var(--raised))", padding: 3, gap: 2 }}>
              {(["v1", "default", "v2"] as const).map(mode => (
                <button
                  key={mode}
                  type="button"
                  role="radio"
                  aria-checked={maMode === mode}
                  className={`btn btn-sm${maMode === mode ? " btn-primary" : " btn-ghost"}`}
                  style={{ borderRadius: 999, minWidth: 36, fontSize: 11, padding: "5px 10px", border: "none", background: maMode === mode ? undefined : "transparent", color: maMode === mode ? undefined : "var(--muted)" }}
                  disabled={maBusy}
                  onClick={() => void switchMaMode(mode)}
                >{mode === "default" ? "base" : mode}</button>
              ))}
            </div>
          </div>
        </div>
        <div className="stat">
          <div className="label">{t("dash.status")}</div>
          <div className="value" style={{ display: "flex", alignItems: "center", gap: 9, color: online ? "var(--green)" : "var(--red)" }}>
            <span className={`dot ${online ? "dot-green" : "dot-red"}`} />{online ? t("dash.online") : t("dash.offline")}
          </div>
        </div>
        <div className="stat"><div className="label">{t("dash.version")}</div><div className="value mono">{health?.version ?? "—"}</div></div>
        <div className="stat"><div className="label">{t("dash.uptime")}</div><div className="value mono">{health ? formatUptime(health.uptime, locale) : "—"}</div></div>
        <div className="stat"><div className="label">{t("dash.providers")}</div><div className="value">{providers.length}</div></div>
        <div className="stat">
          <div className="label">{t("dash.tokens30d")}</div>
          <div className="value mono">{usage30d && usage30d.summary.requests > 0 ? formatTokens(usage30d.summary.totalTokens, locale) : "—"}</div>
          {usage30d && usage30d.summary.requests > 0 && (
            <div className="muted" style={{ fontSize: 12, marginTop: 2 }}>
              {t("dash.coverage").replace("{pct}", `${Math.round(usage30d.summary.coverageRatio * 100)}%`)}
            </div>
          )}
        </div>
      </div>

      {projectConfigWarnings.length > 0 && (
        <div className="notice notice-err maintenance-notice" style={{ marginBottom: 24 }} role="alert">
          <IconAlert />
          <div>
            <div style={{ fontWeight: 650 }}>{t("dash.projectConfigTitle")}</div>
            <div className="muted" style={{ fontSize: 13, marginTop: 4 }}>{t("dash.projectConfigHint")}</div>
            <ul style={{ margin: "10px 0 0", paddingLeft: 18, fontSize: 13 }}>
              {projectConfigWarnings.map(g => (
                <li key={g.path} style={{ marginBottom: 8 }}>
                  <code>{g.path}</code> — {g.issues.join(", ")}
                  <div className="muted" style={{ marginTop: 2 }}>{g.bypass}</div>
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}

      <div className="panel" style={{ marginBottom: 24 }}>
        <div className="injection-head">
          <span className="injection-label">{t("dash.injectionLabel")}</span>
          <Select
            value={injectionModel}
            options={[
              { value: "", label: t("dash.injectionNone") },
              ...injectionAvailable.map(m => ({ value: m.namespaced, label: `${m.provider} / ${m.model}` })),
            ]}
            onChange={async (v) => {
              if (injectionSaving) return;
              setInjectionSaving(true);
              try {
                const res = await fetch(`${apiBase}/api/injection-model`, {
                  method: "PUT",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ model: v || null, effort: injectionEffort || null }),
                });
                if (res.ok) {
                  const data = await res.json() as { model?: string | null; effort?: string | null };
                  setInjectionModel(data.model ?? "");
                  setInjectionEffort(data.effort ?? "");
                }
              } catch { /* ignore */ }
              finally { setInjectionSaving(false); }
            }}
            disabled={injectionSaving}
            label={t("dash.injectionLabel")}
          />
          {injectionModel && injectionEfforts.length > 0 && (
            <Select
              value={injectionEffort}
              options={[
                { value: "", label: t("dash.injectionEffortNone") },
                ...injectionEfforts.map(e => ({ value: e, label: e })),
              ]}
              onChange={async (v) => {
                if (injectionSaving) return;
                setInjectionSaving(true);
                try {
                  const res = await fetch(`${apiBase}/api/injection-model`, {
                    method: "PUT",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ model: injectionModel || null, effort: v || null }),
                  });
                  if (res.ok) {
                    const data = await res.json() as { model?: string | null; effort?: string | null };
                    setInjectionModel(data.model ?? "");
                    setInjectionEffort(data.effort ?? "");
                  }
                } catch { /* ignore */ }
                finally { setInjectionSaving(false); }
              }}
              disabled={injectionSaving}
              label={t("dash.injectionEffortLabel")}
            />
          )}
          {injectionModel && <span className="badge badge-green" style={{ fontSize: 10 }}>{t("dash.injectionActive")}</span>}
        </div>
        <div className="muted" style={{ fontSize: 13, marginTop: 6 }}>{t("dash.injectionHint")}</div>
      </div>

      <div className="panel maintenance-panel" style={{ marginBottom: 24 }}>
        <div className="spread maintenance-head">
          <div>
            <div style={{ fontWeight: 650 }}>{t("dash.maintenance")}</div>
            <div className="muted" style={{ fontSize: 13, marginTop: 3 }}>{t("dash.maintenanceHint")}</div>
          </div>
          <div className="maintenance-actions">
            <button type="button" className="btn btn-ghost" onClick={runSync} disabled={syncing}>
              <IconRefresh /> {syncing ? t("dash.syncing") : t("dash.syncModels")}
            </button>
            <button type="button" className="btn btn-primary" onClick={openUpdateDialog} disabled={updateLoading}>
              <IconExternal /> {t("dash.checkUpdate")}
            </button>
          </div>
        </div>
        {syncResult && (
          <div className="notice notice-ok maintenance-notice" role="status">
            <IconRefresh />
            <span>
              {t("dash.syncOk", { count: syncResult.added })}
              {syncResult.warning ? ` ${syncResult.warning}` : ""}
              {syncResult.staleAppServerHint ? ` ${t("dash.syncStaleHint")}` : ""}
            </span>
          </div>
        )}
        {syncError && (
          <div className="notice notice-err maintenance-notice" role="status">
            <IconAlert /><span>{t("dash.syncFailed", { error: syncError })}</span>
          </div>
        )}
        {updateJob && (
          <div className={`notice ${updateJob.status === "failed" ? "notice-err" : "notice-ok"} maintenance-notice`} role="status">
            {updateJob.status === "failed" ? <IconAlert /> : <IconRefresh />}
            <span>
              {updateJobLabel(updateJob.status)}
              {updateJob.latestVersion ? ` ${updateJob.currentVersion} -> ${updateJob.latestVersion}.` : ""}
              {reconnecting ? ` ${t("dash.updateReconnecting")}` : ""}
              {updateJob.error ? ` ${updateJob.error}` : ""}
            </span>
          </div>
        )}
      </div>

      <div className="panel" style={{ marginBottom: 24 }}>
        <div className="spread">
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontWeight: 650 }}>{t("dash.codexAutoStart")}</div>
            <div className="muted setting-hint">{t("dash.codexAutoStartHint")}</div>
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

      <div className="panel" style={{ marginBottom: 12 }}>
        <div className="spread setting-row" style={{ alignItems: "flex-start" }}>
          <div className="setting-copy" style={{ flex: 1 }}>
            <div style={{ fontWeight: 650 }}>{t("dash.searchModel")}</div>
            <div className="muted setting-hint">{t("dash.searchModelHint")}</div>
          </div>
          <div className="setting-controls" style={{ display: "flex", gap: 8 }}>
            <Select
              value={sidecar?.webSearch.model ?? "gpt-5.6-luna"}
              options={SEARCH_SIDECAR_MODELS.map(m => ({ value: m, label: modelLabel(m) }))}
              onChange={v => saveSidecar({ webSearch: { model: v, reasoning: sidecar!.webSearch.reasoning } })}
              disabled={!sidecar || sidecarSaving}
              label={t("dash.searchModel")}
            />
            <Select
              value={sidecar?.webSearch.reasoning ?? "low"}
              options={REASONING_LEVELS.map(r => ({ value: r, label: r }))}
              onChange={v => saveSidecar({ webSearch: { model: sidecar!.webSearch.model, reasoning: v } })}
              disabled={!sidecar || sidecarSaving}
              label={t("dash.searchReasoning")}
            />
          </div>
        </div>
      </div>

      <div className="panel" style={{ marginBottom: 24 }}>
        <div className="spread setting-row">
          <div className="setting-copy" style={{ flex: 1 }}>
            <div style={{ fontWeight: 650 }}>{t("dash.visionModel")}</div>
            <div className="muted setting-hint">{t("dash.visionModelHint")}</div>
          </div>
          <Select
            value={sidecar?.vision.model ?? "gpt-5.6-luna"}
            options={VISION_SIDECAR_MODELS.map(m => ({ value: m, label: modelLabel(m) }))}
            onChange={v => saveSidecar({ vision: { model: v } })}
            disabled={!sidecar || sidecarSaving}
            label={t("dash.visionModel")}
          />
        </div>
      </div>

      <div className="h-section">{t("dash.activeProviders")} <span className="count">{providers.length}</span></div>
      {providers.length === 0 ? (
        <EmptyState title={<Trans k="dash.noProviders" cmd="ocx init" />} />
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
        <EmptyState title={t("dash.noModels")} />
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

      {updateOpen && (
        <div className="modal-overlay" role="dialog" aria-modal="true" aria-labelledby="update-title">
          <div className="modal-card">
            <div className="modal-head">
              <h3 id="update-title">{t("dash.updateTitle")}</h3>
              <button type="button" className="btn btn-ghost btn-icon" onClick={closeUpdateDialog} aria-label={t("common.cancel")}>
                <IconX />
              </button>
            </div>
            <div className="modal-desc">{t("dash.updateDesc")}</div>
            <div className="update-row">
              <label className="field-label" htmlFor="update-channel">{t("dash.updateChannel")}</label>
              <Select
                value={updateChannel}
                options={[{ value: "latest", label: "latest" }, { value: "preview", label: "preview" }]}
                onChange={v => changeUpdateChannel(v as UpdateChannel)}
                disabled={updateLoading}
                label={t("dash.updateChannel")}
              />
            </div>
            {updateLoading && <EmptyState className="update-empty" icon={<span className="spin" />} title={t("dash.updateChecking")} />}
            {updateError && (
              <div className="notice notice-err" role="status"><IconAlert /><span>{updateError}</span></div>
            )}
            {updateCheck && !updateLoading && (
              <div className="update-box">
                <div className="spread">
                  <div>
                    <div className="muted" style={{ fontSize: 12 }}>{t("dash.updateInstalled")}</div>
                    <div className="mono">{updateCheck.currentVersion}</div>
                  </div>
                  <div>
                    <div className="muted" style={{ fontSize: 12 }}>{t("dash.updateLatest")}</div>
                    <div className="mono">{updateCheck.latestVersion ?? "—"}</div>
                  </div>
                  <span className={`badge ${updateCheck.updateAvailable ? "badge-green" : "badge-muted"}`}>
                    {updateCheck.updateAvailable ? t("dash.updateAvailable") : t("dash.updateCurrent")}
                  </span>
                </div>
                <div className="muted update-command">{t("dash.updateCommand")} <code className="chip">{updateCheck.command}</code></div>
                {updateCheck.reason === "source_checkout" && (
                  <div className="notice-warn" role="status"><IconAlert /> {t("dash.updateSource")}</div>
                )}
                {updateCheck.reason === "latest_unavailable" && (
                  <div className="notice-warn" role="status">
                    <IconAlert /> {t("dash.updateUnavailable")}
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      disabled={updateLoading}
                      onClick={() => { void fetchUpdateCheck(updateChannel, true); }}
                      style={{ marginLeft: 12 }}
                    >
                      <IconRefresh /> {t("dash.updateRetry")}
                    </button>
                  </div>
                )}
                {!updateCheck.canUpdate && updateCheck.reason !== "latest_unavailable" && updateCheck.reason !== "source_checkout" && (
                  <div className="update-recheck">
                    <span className="muted update-recheck-reason">
                      {t("dash.updateCannotAuto", { reason: updateReasonLabel(updateCheck.reason, t) })}
                    </span>
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      disabled={updateLoading}
                      onClick={() => { void fetchUpdateCheck(updateChannel, true); }}
                    >
                      <IconRefresh /> {updateLoading ? t("dash.updateChecking") : t("dash.updateRecheck")}
                    </button>
                  </div>
                )}
                {updateCheck.canUpdate && (
                  <div className="spread update-restart">
                    <div>
                      <div style={{ fontWeight: 600 }}>{t("dash.updateRestart")}</div>
                      <div className="muted" style={{ fontSize: 12 }}>{t("dash.updateRestartHint")}</div>
                    </div>
                    <button
                      type="button"
                      className={`switch ${updateRestart ? "on" : ""}`}
                      onClick={() => setUpdateRestart(v => !v)}
                      aria-label={t("dash.updateRestart")}
                      aria-pressed={updateRestart}
                    >
                      <span className="knob" />
                    </button>
                  </div>
                )}
              </div>
            )}
            <div className="modal-actions">
              <button type="button" className="btn btn-ghost" onClick={closeUpdateDialog}>{t("common.cancel")}</button>
              <button
                type="button"
                className="btn btn-primary"
                onClick={runUpdate}
                disabled={!updateCheck?.canUpdate || updateLoading}
              >
                {t("dash.runUpdate")}
              </button>
            </div>
          </div>
        </div>
      )}

      {maHelpOpen && (
        <div className="modal-overlay" role="dialog" aria-modal="true" aria-label={t("dash.multiAgent")} onClick={() => setMaHelpOpen(false)} onKeyDown={e => { if (e.key === "Escape") setMaHelpOpen(false); }}>
          <div className="modal-card" onClick={e => e.stopPropagation()}>
            <div className="modal-head">
              <h3>{t("dash.multiAgent")}</h3>
              <button type="button" className="btn btn-ghost btn-icon" onClick={() => setMaHelpOpen(false)} aria-label="Close"><IconX /></button>
            </div>
            <div className="modal-desc" style={{ whiteSpace: "pre-line", lineHeight: 1.6 }}>
              {t("models.v2Help")}
            </div>
            <div style={{ marginTop: 12 }}>
              <a href="https://lidge-jun.github.io/opencodex/guides/sub-agent-surface/" target="_blank" rel="noreferrer" style={{ fontSize: 13, color: "var(--accent)" }}>
                {t("models.v2DocsLink")}
              </a>
            </div>
            <div className="modal-actions">
              <button type="button" className="btn btn-primary" onClick={() => setMaHelpOpen(false)}>OK</button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
