import { useEffect, useMemo, useRef, useState } from "react";
import { useKeyedClientResource } from "../client-resource";
import { useI18n } from "../i18n/shared";
import {
  PROJECT_CONFIG_DIAGNOSTICS_POLL_MS,
  seedStartupHealthFromSettings,
  type StartupHealthStatus,
} from "../startup-health-ui";
import {
  fetchDashboardCore,
  fetchDashboardUsage,
  fetchDashboardModels,
  fetchProjectConfigDiagnostics,
  fetchStartupHealth,
  normalizeInjectionSelection,
  type DashboardEpochRefs,
} from "./dashboard-core-poll";
import {
  type DashboardSection,
  type HealthData,
  type ModelInfo,
  type ProjectCodexConfigGroup,
  type ProviderInfo,
  type SettingsData,
  type ShadowCallData,
  type SidecarData,
  type SidecarPatch,
  type SyncResult,
  type UpdateChannel,
  type UpdateCheckData,
  type UpdateJob,
  type UsageSummary30d,
  UPDATE_CHECK_MAX_AUTO_RETRIES,
  UPDATE_CHECK_RETRY_BASE_MS,
  defaultUpdateChannel,
  mergeSidecarSetting,
  readDashboardSectionFromHash,
  requireJson,
  sidecarModelOptions,
  useModalDialog,
} from "./dashboard-shared";

export function useDashboardData(apiBase: string) {
  const { locale, t } = useI18n();
  // The hash is the source of truth for the active section (#dashboard, …).
  const [selectedSection, setSelectedSection] = useState<DashboardSection>(readDashboardSectionFromHash);
  const [modelQuery, setModelQuery] = useState("");
  const [expandedProviders, setExpandedProviders] = useState<Set<string>>(new Set());
  const [health, setHealth] = useState<HealthData | null>(null);
  const [startupHealth, setStartupHealth] = useState<StartupHealthStatus | null>(null);
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [settings, setSettings] = useState<SettingsData | null>(null);
  const [sidecar, setSidecar] = useState<SidecarData | null>(null);
  const [shadowCall, setShadowCall] = useState<ShadowCallData | null>(null);
  const [usage30d, setUsage30d] = useState<UsageSummary30d | null>(null);
  const [sidecarSaving, setSidecarSaving] = useState(false);
  const [shadowCallSaving, setShadowCallSaving] = useState(false);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [settingsSaving, setSettingsSaving] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [maMode, setMaMode] = useState<"v1" | "default" | "v2">("default");
  const [maModeResolved, setMaModeResolved] = useState(false);
  const [maBusy, setMaBusy] = useState(false);
  const [maHelpOpen, setMaHelpOpen] = useState(false);
  const [effortCapHelpOpen, setEffortCapHelpOpen] = useState(false);
  const [shadowCallHelpOpen, setShadowCallHelpOpen] = useState(false);
  const [injectionModel, setInjectionModel] = useState<string>("");
  const [injectionEffort, setInjectionEffort] = useState<string>("");
  const [injectionEfforts, setInjectionEfforts] = useState<string[]>([]);
  const [injectionAvailable, setInjectionAvailable] = useState<Array<{ provider: string; model: string; namespaced: string }>>([]);
  const [injectionSaving, setInjectionSaving] = useState(false);
  const [multiAgentGuidanceEnabled, setMultiAgentGuidanceEnabled] = useState(true);
  const [syncCodexSubagentDefaults, setSyncCodexSubagentDefaults] = useState(false);
  const [effortCap, setEffortCap] = useState<string>("");
  const [subagentEffortCap, setSubagentEffortCap] = useState<string>("");
  const [effortCapSaving, setEffortCapSaving] = useState(false);
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
  const settingsRequestEpochRef = useRef(0);
  const settingsMutationEpochRef = useRef(0);
  const settingsMutationInFlightRef = useRef(false);
  const shadowCallRequestEpochRef = useRef(0);
  const shadowCallMutationEpochRef = useRef(0);
  const shadowCallMutationInFlightRef = useRef(false);
  const [updateCheck, setUpdateCheck] = useState<UpdateCheckData | null>(null);
  const [updateError, setUpdateError] = useState<string | null>(null);
  const [updateJob, setUpdateJob] = useState<UpdateJob | null>(null);
  const [reconnecting, setReconnecting] = useState(false);
  const [error, setError] = useState(false);
  const effortCapHelpTriggerRef = useRef<HTMLButtonElement>(null);
  const updateTriggerRef = useRef<HTMLButtonElement>(null);
  const maHelpTriggerRef = useRef<HTMLButtonElement>(null);
  const shadowCallHelpTriggerRef = useRef<HTMLButtonElement>(null);
  const effortCapHelpDialogRef = useModalDialog(effortCapHelpOpen, effortCapHelpTriggerRef);
  const updateDialogRef = useModalDialog(updateOpen, updateTriggerRef);
  const maHelpDialogRef = useModalDialog(maHelpOpen, maHelpTriggerRef);
  const shadowCallHelpDialogRef = useModalDialog(shadowCallHelpOpen, shadowCallHelpTriggerRef);

  useEffect(() => {
    const onHash = () => setSelectedSection(readDashboardSectionFromHash());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  useEffect(() => () => {
    updateRequestEpochRef.current += 1;
    if (updateRetryTimerRef.current !== null) {
      window.clearTimeout(updateRetryTimerRef.current);
      updateRetryTimerRef.current = null;
    }
  }, []);

  const startupHealthRef = useRef<StartupHealthStatus | null>(null);
  /** Bumped whenever the dedicated startup-health poll commits; core polls ignore older generations. */
  const startupHealthGenerationRef = useRef(0);
  const epochRefs = useRef<DashboardEpochRefs>({
    settingsRequestEpochRef,
    settingsMutationEpochRef,
    settingsMutationInFlightRef,
    shadowCallRequestEpochRef,
    shadowCallMutationEpochRef,
    shadowCallMutationInFlightRef,
  }).current;

  const startupHealthPoll = useKeyedClientResource(
    `dashboard-startup-health:${apiBase}`,
    [apiBase],
    (signal) => fetchStartupHealth(apiBase, signal),
    { pollMs: 30_000 },
  );

  const corePoll = useKeyedClientResource(
    `dashboard-core:${apiBase}`,
    [apiBase],
    async (signal) => {
      // Capture generation at fetch start so a newer probe can win at commit time.
      const startupHealthGeneration = startupHealthGenerationRef.current;
      const data = await fetchDashboardCore(apiBase, signal, epochRefs);
      return { ...data, startupHealthGeneration };
    },
    { pollMs: 5000 },
  );

  const usagePoll = useKeyedClientResource(
    `dashboard-usage:${apiBase}`,
    [apiBase],
    (signal) => fetchDashboardUsage(apiBase, signal),
    { pollMs: 60_000 },
  );

  const diagnosticsPoll = useKeyedClientResource(
    `dashboard-diagnostics:${apiBase}`,
    [apiBase],
    (signal) => fetchProjectConfigDiagnostics(apiBase, signal),
    { pollMs: PROJECT_CONFIG_DIAGNOSTICS_POLL_MS },
  );

  const modelsPoll = useKeyedClientResource(
    `dashboard-models:${apiBase}`,
    [apiBase, error],
    (signal) => fetchDashboardModels(apiBase, signal),
    { enabled: !error },
  );

  /* eslint-disable react-hooks/set-state-in-effect -- mirror client-resource snapshots into mutable dashboard UI state that handlers also update */
  useEffect(() => {
    if (startupHealthPoll.data !== undefined) {
      startupHealthGenerationRef.current += 1;
      setStartupHealth(startupHealthPoll.data);
      startupHealthRef.current = startupHealthPoll.data;
    }
  }, [startupHealthPoll.data]);

  useEffect(() => {
    const data = corePoll.data;
    if (!data) return;
    if (data.health) setHealth(data.health);
    setProviders(data.providers);
    if (data.settings) setSettings(data.settings);
    // Latest-wins: only seed from settings when no newer dedicated probe has committed
    // while this core poll was in flight. Always merge against the live ref.
    if (
      data.startupHealthSeed !== undefined
      && data.startupHealthGeneration === startupHealthGenerationRef.current
    ) {
      const merged = seedStartupHealthFromSettings(startupHealthRef.current, data.startupHealthSeed);
      setStartupHealth(merged);
      startupHealthRef.current = merged;
    }
    if (data.sidecar) setSidecar(data.sidecar);
    if (data.shadowCall !== undefined) setShadowCall(data.shadowCall);
    setMaMode(data.maMode);
    setMaModeResolved(data.maModeResolved);
    if (data.injection) {
      setMultiAgentGuidanceEnabled(data.injection.multiAgentGuidanceEnabled);
      setSyncCodexSubagentDefaults(data.injection.syncCodexSubagentDefaults);
      setInjectionModel(data.injection.injectionModel);
      setInjectionEffort(data.injection.injectionEffort);
      setInjectionEfforts(data.injection.injectionEfforts);
      setInjectionAvailable(data.injection.injectionAvailable);
    }
    if (data.effortCaps) {
      setEffortCap(data.effortCaps.effortCap);
      setSubagentEffortCap(data.effortCaps.subagentEffortCap);
    }
    setError(data.error);
  }, [corePoll.data]);

  useEffect(() => {
    if (usagePoll.data !== undefined) setUsage30d(usagePoll.data);
  }, [usagePoll.data]);

  useEffect(() => {
    if (diagnosticsPoll.data) setProjectConfigWarnings(diagnosticsPoll.data);
  }, [diagnosticsPoll.data]);

  useEffect(() => {
    if (modelsPoll.data) setModels(modelsPoll.data);
    setModelsLoading(modelsPoll.loading);
  }, [modelsPoll.data, modelsPoll.loading]);
  /* eslint-enable react-hooks/set-state-in-effect */

  useEffect(() => () => {
    settingsRequestEpochRef.current += 1;
    shadowCallRequestEpochRef.current += 1;
  }, []);

  const updatePoll = useKeyedClientResource(
    updateJob?.id && updateJob.restart ? `update-job:${apiBase}:${updateJob.id}` : `update-job:idle:${apiBase}`,
    [apiBase, updateJob?.id, updateJob?.restart, updateJob?.latestVersion],
    async (signal) => {
      if (!updateJob?.id || !updateJob.restart) return { reconnecting: false as const };
      const targetVersion = updateJob.latestVersion;
      try {
        const res = await fetch(`${apiBase}/api/update/status?jobId=${encodeURIComponent(updateJob.id)}`, { signal });
        const statusData = await requireJson<{ job?: UpdateJob }>(res);
        if (statusData.job) {
          if (statusData.job.status === "failed") return { job: statusData.job, reconnecting: false as const };
          if (targetVersion) {
            try {
              const healthRes = await fetch(`${apiBase}/healthz`, { cache: "no-store", signal });
              const healthData = await requireJson<HealthData>(healthRes);
              if (healthData.version === targetVersion) {
                return { job: statusData.job, reconnecting: false as const, reload: true as const };
              }
            } catch {
              return { job: statusData.job, reconnecting: true as const };
            }
          }
          return { job: statusData.job, reconnecting: false as const };
        }
      } catch {
        return { reconnecting: true as const };
      }
      return { reconnecting: false as const };
    },
    { pollMs: 1500, enabled: !!(updateJob?.id && updateJob.restart) },
  );

  /* eslint-disable react-hooks/set-state-in-effect -- mirror update-job client-resource snapshot into local job UI state */
  useEffect(() => {
    const data = updatePoll.data;
    if (!data) return;
    if ("job" in data && data.job) setUpdateJob(data.job);
    setReconnecting(data.reconnecting);
    if ("reload" in data && data.reload) window.location.reload();
  }, [updatePoll.data]);
  /* eslint-enable react-hooks/set-state-in-effect */

  const grouped = useMemo(() => {
    const g: Record<string, ModelInfo[]> = {};
    for (const m of models) (g[m.provider] ??= []).push(m);
    return Object.entries(g).sort(([a], [b]) => a.localeCompare(b));
  }, [models]);
  const filteredGroups = useMemo(() => {
    const q = modelQuery.trim().toLowerCase();
    if (!q) return grouped;
    const out: Array<[string, ModelInfo[]]> = [];
    for (const [provider, rows] of grouped) {
      const hits = rows.filter(m => m.id.toLowerCase().includes(q) || provider.toLowerCase().includes(q));
      if (hits.length > 0) out.push([provider, hits]);
    }
    return out;
  }, [grouped, modelQuery]);
  const sidecarModels = useMemo(() => sidecarModelOptions(models), [models]);

  const saveSidecar = async (patch: SidecarPatch) => {
    if (!sidecar || sidecarSaving) return;
    const previous = sidecar;
    const next = {
      webSearch: mergeSidecarSetting(sidecar.webSearch, patch.webSearch),
      vision: mergeSidecarSetting(sidecar.vision, patch.vision),
    };
    setSidecarSaving(true);
    setSidecar(next);
    try {
      const res = await fetch(`${apiBase}/api/sidecar-settings`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      const data = await requireJson<SidecarData>(res, "save failed");
      setSidecar({ webSearch: data.webSearch, vision: data.vision });
    } catch {
      setSidecar(previous);
    } finally {
      setSidecarSaving(false);
    }
  };

  async function saveShadowCall(patch: Partial<ShadowCallData>) {
    if (!shadowCall || shadowCallSaving) return;
    const previous = shadowCall;
    const updated = { ...shadowCall, ...patch };
    setShadowCallSaving(true);
    shadowCallMutationInFlightRef.current = true;
    setShadowCall(updated);
    try {
      const res = await fetch(`${apiBase}/api/shadow-call-settings`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      if (!res.ok) throw new Error("shadow-call save failed");
      shadowCallMutationEpochRef.current += 1;
    } catch {
      setShadowCall(previous);
    } finally {
      shadowCallMutationInFlightRef.current = false;
      setShadowCallSaving(false);
    }
  }

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

  const saveInjection = async (patch: {
    multiAgentGuidanceEnabled?: boolean;
    syncCodexSubagentDefaults?: boolean;
    model?: string | null;
    effort?: string | null;
  }) => {
    if (injectionSaving) return;
    setInjectionSaving(true);
    try {
      const res = await fetch(`${apiBase}/api/injection-model`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      if (!res.ok) throw new Error("injection save failed");
      const getRes = await fetch(`${apiBase}/api/injection-model`);
      const data = await requireJson<{
        multiAgentGuidanceEnabled?: boolean;
        syncCodexSubagentDefaults?: boolean;
        model?: string | null;
        effort?: string | null;
        efforts?: string[];
        available?: Array<{ provider: string; model: string; namespaced: string }>;
      }>(getRes);
      const normalized = normalizeInjectionSelection(data);
      setMultiAgentGuidanceEnabled(normalized.multiAgentGuidanceEnabled);
      setSyncCodexSubagentDefaults(normalized.syncCodexSubagentDefaults);
      setInjectionModel(normalized.injectionModel);
      setInjectionEffort(normalized.injectionEffort);
      if (Array.isArray(data.efforts)) setInjectionEfforts(data.efforts);
      if (Array.isArray(data.available)) setInjectionAvailable(data.available);
    } catch { /* keep the last committed UI state */ }
    finally { setInjectionSaving(false); }
  };

  const toggleCodexAutoStart = async () => {
    if (!settings || settingsSaving) return;
    const next = !settings.codexAutoStart;
    setSettingsSaving(true);
    settingsMutationInFlightRef.current = true;
    setSettings({ ...settings, codexAutoStart: next });
    try {
      const res = await fetch(`${apiBase}/api/settings`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ codexAutoStart: next }),
      });
      const data = await requireJson<{ codexAutoStart: boolean; startupHealth?: SettingsData["startupHealth"] }>(res, "save failed");
      settingsMutationEpochRef.current += 1;
      setSettings(prev => prev ? { ...prev, codexAutoStart: data.codexAutoStart, startupHealth: data.startupHealth ?? prev.startupHealth } : prev);
    } catch {
      setSettings(prev => prev ? { ...prev, codexAutoStart: !next } : prev);
      setError(true);
    } finally {
      settingsMutationInFlightRef.current = false;
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
      const data = await requireJson<SyncResult & { projectConfigGrouped?: ProjectCodexConfigGroup[] }>(res, "sync failed");
      setSyncResult(data);
      if (data.projectConfigGrouped) setProjectConfigWarnings(data.projectConfigGrouped);
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
      const check = await requireJson<UpdateCheckData>(res, "update check failed");
      if (requestEpoch !== updateRequestEpochRef.current) return;

      setUpdateCheck(check);
      if (
        check.reason === "latest_unavailable"
        && updateRetryRef.current < UPDATE_CHECK_MAX_AUTO_RETRIES
      ) {
        const retry = ++updateRetryRef.current;
        // Keep loading through scheduled retries — do not clear here.
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
      const data = await requireJson<{ job?: UpdateJob }>(res, "update failed to start");
      if (!data.job) throw new Error("update failed to start");
      setUpdateJob(data.job);
      setReconnecting(false);
      closeUpdateDialog();
    } catch (err) {
      setUpdateError(err instanceof Error ? err.message : String(err));
    }
  };

  return {
    apiBase,
    locale, t,
    selectedSection, setSelectedSection,
    modelQuery, setModelQuery,
    expandedProviders, setExpandedProviders,
    health, startupHealth, providers, models, settings, sidecar, shadowCall, usage30d,
    sidecarSaving, shadowCallSaving, modelsLoading, settingsSaving, syncing,
    maMode, maModeResolved, maBusy, setMaHelpOpen, maHelpOpen,
    effortCapHelpOpen, setEffortCapHelpOpen, shadowCallHelpOpen, setShadowCallHelpOpen,
    injectionModel, injectionEffort, injectionEfforts, injectionAvailable, injectionSaving,
    multiAgentGuidanceEnabled, syncCodexSubagentDefaults, saveInjection,
    effortCap, subagentEffortCap, effortCapSaving, setEffortCap, setSubagentEffortCap, setEffortCapSaving,
    syncResult, syncError, projectConfigWarnings,
    updateOpen, updateChannel, setUpdateRestart, updateRestart, updateLoading,
    updateCheck, updateError, updateJob, reconnecting, error,
    effortCapHelpTriggerRef, updateTriggerRef, maHelpTriggerRef, shadowCallHelpTriggerRef,
    effortCapHelpDialogRef, updateDialogRef, maHelpDialogRef, shadowCallHelpDialogRef,
    filteredGroups, sidecarModels,
    saveSidecar, saveShadowCall, switchMaMode, toggleCodexAutoStart, runSync,
    fetchUpdateCheck, closeUpdateDialog, openUpdateDialog, changeUpdateChannel, runUpdate,
  };
}
