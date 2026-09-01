import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useKeyedClientResource } from "../client-resource";
import { replaceHash } from "../hash-routing";
import { useI18n } from "../i18n/shared";
import { readSessionListCache, writeSessionListCache } from "../session-list-cache";
import {
  PROJECT_CONFIG_DIAGNOSTICS_POLL_MS,
  STARTUP_HEALTH_STALE_RETRY_MS,
  probeNeedsFastRetry,
  seedStartupHealthFromSettings,
  type StartupHealthStatus,
} from "../startup-health-ui";
import {
  fetchDashboardMaMode,
  fetchDashboardModels,
  fetchDashboardMultiAgent,
  fetchDashboardOverview,
  fetchDashboardSettings,
  fetchDashboardSidecars,
  fetchDashboardUsage,
  fetchProjectConfigDiagnostics,
  fetchStartupHealth,
  normalizeInjectionSelection,
  type DashboardEpochRefs,
} from "./dashboard-core-poll";
import { usageSummary30dResourceKey } from "../usage-summary-resource";
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
  hashRequestsUpdateDialog,
  mergeSidecarSetting,
  readDashboardSectionFromHash,
  requireJson,
  webSearchModelOptionsForPicker,
  visionModelOptions,
  useModalDialog,
} from "./dashboard-shared";

const CONTROLS_CACHE_PREFIX = "ocx.dash.controls.v1:";
const OVERVIEW_CACHE_PREFIX = "ocx.dash.overview.v1:";
const USAGE_CACHE_PREFIX = "ocx.dash.usage30d.v1:";
const STARTUP_CACHE_PREFIX = "ocx.dash.startup.v1:";
const MA_MODE_CACHE_PREFIX = "ocx.dash.maMode.v1:";

type CachedControls = {
  settings?: SettingsData | null;
  sidecar?: SidecarData | null;
  shadowCall?: ShadowCallData | null;
};

type CachedOverview = {
  health: HealthData;
  providers: ProviderInfo[];
};

type MaMode = "v1" | "default" | "v2";

export function groupDashboardModels(models: ModelInfo[]): Array<[string, ModelInfo[]]> {
  const groups = new Map<string, ModelInfo[]>();
  for (const model of models) {
    const rows = groups.get(model.provider);
    if (rows) rows.push(model);
    else groups.set(model.provider, [model]);
  }
  return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b));
}

function controlsCacheKey(apiBase: string): string {
  return `${CONTROLS_CACHE_PREFIX}${apiBase}`;
}

export function useDashboardData(apiBase: string) {
  const { locale, t } = useI18n();
  // The hash is the source of truth for the active section (#dashboard, …).
  const [selectedSection, setSelectedSection] = useState<DashboardSection>(readDashboardSectionFromHash);
  const [modelQuery, setModelQuery] = useState("");
  const [expandedProviders, setExpandedProviders] = useState<Set<string>>(new Set());
  const cachedControls = useMemo(
    () => readSessionListCache<CachedControls>(controlsCacheKey(apiBase)),
    [apiBase],
  );
  const cachedOverview = useMemo(
    () => readSessionListCache<CachedOverview>(`${OVERVIEW_CACHE_PREFIX}${apiBase}`),
    [apiBase],
  );
  const cachedUsage = useMemo(
    () => readSessionListCache<UsageSummary30d>(`${USAGE_CACHE_PREFIX}${apiBase}`),
    [apiBase],
  );
  const cachedStartup = useMemo(() => {
    const cached = readSessionListCache<StartupHealthStatus>(`${STARTUP_CACHE_PREFIX}${apiBase}`);
    return cached === "error" ? null : cached;
  }, [apiBase]);
  const cachedMaMode = useMemo(
    () => readSessionListCache<MaMode>(`${MA_MODE_CACHE_PREFIX}${apiBase}`),
    [apiBase],
  );
  const [health, setHealth] = useState<HealthData | null>(() => cachedOverview?.health ?? null);
  const [startupHealth, setStartupHealth] = useState<StartupHealthStatus | null>(() => cachedStartup);
  const [providers, setProviders] = useState<ProviderInfo[]>(() => cachedOverview?.providers ?? []);
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [settings, setSettings] = useState<SettingsData | null>(() => cachedControls?.settings ?? null);
  const [sidecar, setSidecar] = useState<SidecarData | null>(() => cachedControls?.sidecar ?? null);
  const [shadowCall, setShadowCall] = useState<ShadowCallData | null>(() => cachedControls?.shadowCall ?? null);
  const [usage30d, setUsage30d] = useState<UsageSummary30d | null>(() => cachedUsage);
  const [sidecarSaving, setSidecarSaving] = useState(false);
  const [shadowCallSaving, setShadowCallSaving] = useState(false);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [settingsSaving, setSettingsSaving] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [maMode, setMaMode] = useState<MaMode>(() => cachedMaMode ?? "default");
 const [maBusy, setMaBusy] = useState(false);
  const [maError, setMaError] = useState<string | null>(null);
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

  const startupHealthRef = useRef<StartupHealthStatus | null>(cachedStartup);
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

  /*
   * `/api/startup-health` answers instantly from a 30s cache and resolves the real probe in the
   * background, so a cold answer is a conservative placeholder. Waiting for the next 30s tick is
   * what made the chip look stuck until an unrelated action (refresh quota, tab hop) remounted it.
   * Re-ask in ~2s while the server says it is still working.
   */
  const startupHealthStale = probeNeedsFastRetry(startupHealthPoll.data);
  const refreshStartupHealth = startupHealthPoll.refresh;
  useEffect(() => {
    if (!startupHealthStale) return;
    const timer = window.setTimeout(() => { void refreshStartupHealth(); }, STARTUP_HEALTH_STALE_RETRY_MS);
    return () => window.clearTimeout(timer);
  }, [startupHealthStale, refreshStartupHealth]);

  // Wave 1: status/uptime/providers must not wait on injection-model / usage.
  const overviewPoll = useKeyedClientResource(
    `dashboard-overview:${apiBase}`,
    [apiBase],
    (signal) => fetchDashboardOverview(apiBase, signal),
    { pollMs: 5000 },
  );
  const overviewReady = health !== null || overviewPoll.data !== undefined;

  // Preferences that are just config — never gate on overview or injection.
  const maModePoll = useKeyedClientResource(
    `dashboard-ma-mode:${apiBase}`,
    [apiBase],
    (signal) => fetchDashboardMaMode(apiBase, signal),
    { pollMs: 5000 },
  );

  const sidecarPoll = useKeyedClientResource(
    `dashboard-sidecars:${apiBase}`,
    [apiBase],
    async (signal) => {
      const startupHealthGeneration = startupHealthGenerationRef.current;
      const data = await fetchDashboardSidecars(apiBase, signal, epochRefs);
      return { ...data, startupHealthGeneration };
    },
    { pollMs: 5000 },
  );

  const settingsPoll = useKeyedClientResource(
    `dashboard-settings:${apiBase}`,
    [apiBase],
    async (signal) => {
      const startupHealthGeneration = startupHealthGenerationRef.current;
      const data = await fetchDashboardSettings(apiBase, signal, epochRefs);
      return { ...data, startupHealthGeneration };
    },
    { pollMs: 5000 },
  );

  // Wave 2: heavier peers start after overview commits (or session seed) to cut contention.
  const multiAgentPoll = useKeyedClientResource(
    `dashboard-multi-agent:${apiBase}`,
    [apiBase],
    (signal) => fetchDashboardMultiAgent(apiBase, signal),
    { pollMs: 5000, enabled: overviewReady },
  );

  const usagePoll = useKeyedClientResource(
    usageSummary30dResourceKey(apiBase),
    [apiBase],
    (signal) => fetchDashboardUsage(apiBase, signal),
    // 30d usage is documented ~5s cold; this shared key has four subscribers, so
    // every one of them carries the same raised deadline (mount-order independent).
    { enabled: overviewReady, pollMs: 60_000, deadlineMs: 60_000 },
  );

  const diagnosticsPoll = useKeyedClientResource(
    `dashboard-diagnostics:${apiBase}`,
    [apiBase],
    (signal) => fetchProjectConfigDiagnostics(apiBase, signal),
    { pollMs: PROJECT_CONFIG_DIAGNOSTICS_POLL_MS, enabled: overviewReady },
  );

  const modelsPoll = useKeyedClientResource(
    `dashboard-models:${apiBase}`,
    [apiBase, error],
    (signal) => fetchDashboardModels(apiBase, signal),
    { enabled: overviewReady && !error },
  );

  /* oxlint-disable react/react-compiler -- mirror client-resource snapshots into mutable dashboard UI state that handlers also update */
  /* eslint-disable react-hooks/set-state-in-effect -- mirror client-resource snapshots into mutable dashboard UI state that handlers also update */
  useEffect(() => {
    if (startupHealthPoll.data !== undefined) {
      const probe = startupHealthPoll.data;
      startupHealthGenerationRef.current += 1;
      setStartupHealth(probe.status);
      startupHealthRef.current = probe.status;
      // Never persist hard errors — a cold SWR miss used to poison revisits.
      // A stale answer is a placeholder too: caching it makes the next visit start from
      // the server's guess instead of asking again.
      if (probe.status !== "error" && !probe.stale) {
        writeSessionListCache(`${STARTUP_CACHE_PREFIX}${apiBase}`, probe.status);
      }
    }
  }, [startupHealthPoll.data, apiBase]);

  useEffect(() => {
    const data = overviewPoll.data;
    if (!data) return;
    if (data.health) {
      setHealth(data.health);
      setProviders(data.providers);
      writeSessionListCache(`${OVERVIEW_CACHE_PREFIX}${apiBase}`, {
        health: data.health,
        providers: data.providers,
      });
    }
    setError(data.error);
  }, [overviewPoll.data, apiBase]);

  useEffect(() => {
    if (maModePoll.data === undefined) return;
    setMaMode(maModePoll.data.maMode);
    writeSessionListCache(`${MA_MODE_CACHE_PREFIX}${apiBase}`, maModePoll.data.maMode);
  }, [maModePoll.data, apiBase]);

  // Derived — avoids setState-on-prop-change for the resolved flag. Cache / poll / optimistic
  // save (which writes the same cache key) all count as resolved for MA UI.
  const maModeResolved = maModePoll.data !== undefined || cachedMaMode !== null;

  useEffect(() => {
    const data = multiAgentPoll.data;
    if (!data) return;
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
  }, [multiAgentPoll.data]);

  useEffect(() => {
    const data = sidecarPoll.data;
    if (!data) return;
    setSidecar(data.sidecar);
    if (data.shadowCall !== undefined) setShadowCall(data.shadowCall);
    const prev = readSessionListCache<CachedControls>(controlsCacheKey(apiBase)) ?? {};
    writeSessionListCache(controlsCacheKey(apiBase), {
      ...prev,
      sidecar: data.sidecar,
      ...(data.shadowCall !== undefined ? { shadowCall: data.shadowCall } : {}),
    });
  }, [sidecarPoll.data, apiBase]);

  useEffect(() => {
    const data = settingsPoll.data;
    if (!data) return;
    if (data.settings !== undefined) setSettings(data.settings);
    // Latest-wins: only seed from settings when no newer dedicated probe has committed
    // while this settings poll was in flight. Always merge against the live ref.
    if (
      data.startupHealthSeed !== undefined
      && data.startupHealthGeneration === startupHealthGenerationRef.current
    ) {
      const merged = seedStartupHealthFromSettings(startupHealthRef.current, data.startupHealthSeed);
      setStartupHealth(merged);
      startupHealthRef.current = merged;
      if (merged) writeSessionListCache(`${STARTUP_CACHE_PREFIX}${apiBase}`, merged);
    }
    if (data.settings !== undefined) {
      const prev = readSessionListCache<CachedControls>(controlsCacheKey(apiBase)) ?? {};
      writeSessionListCache(controlsCacheKey(apiBase), {
        ...prev,
        settings: data.settings,
      });
    }
  }, [settingsPoll.data, apiBase]);

  useEffect(() => {
    if (usagePoll.data !== undefined) {
      setUsage30d(usagePoll.data);
      writeSessionListCache(`${USAGE_CACHE_PREFIX}${apiBase}`, usagePoll.data);
    }
  }, [usagePoll.data, apiBase]);

  useEffect(() => {
    if (diagnosticsPoll.data) setProjectConfigWarnings(diagnosticsPoll.data);
  }, [diagnosticsPoll.data]);

  useEffect(() => {
    if (modelsPoll.data) setModels(modelsPoll.data);
    setModelsLoading(modelsPoll.loading);
  }, [modelsPoll.data, modelsPoll.loading]);
  /* eslint-enable react-hooks/set-state-in-effect */
  /* oxlint-enable react/react-compiler */

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
    {
      pollMs: 1500,
      enabled: !!(updateJob?.id && updateJob.restart),
      // This poll exists to notice a restarted server coming back. Pausing it while the
      // tab is hidden is exactly when it would be missed, so it opts out of the gate.
      pauseWhenHidden: false,
    },
  );

  /* oxlint-disable react/react-compiler -- mirror update poll snapshot into mutable dashboard UI state */
  useEffect(() => {
    const data = updatePoll.data;
    if (!data) return;
    if ("job" in data && data.job) setUpdateJob(data.job);
    setReconnecting(data.reconnecting);
    if ("reload" in data && data.reload) window.location.reload();
  }, [updatePoll.data]);
  /* oxlint-enable react/react-compiler */

  const grouped = useMemo(() => groupDashboardModels(models), [models]);
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
  const sidecarModels = useMemo(() => {
    // Server-computed runnable set when present (#2188); legacy union otherwise.
    // The shared SidecarSetting type admits vision's "routed", which the
    // web-search picker cannot carry — narrow it away for this card.
    const webBackend = sidecar?.webSearch.backend;
    return webSearchModelOptionsForPicker(
      sidecar?.webSearchModels,
      models,
      sidecar?.webSearch.model,
      webBackend === "routed" ? undefined : webBackend,
    );
  }, [models, sidecar?.webSearchModels, sidecar?.webSearch]);
  const visionModels = useMemo(
    () => visionModelOptions(sidecar?.visionModels, models, sidecar?.vision?.model, sidecar?.vision?.backend),
    [sidecar?.visionModels, models, sidecar?.vision],
  );

  const saveSidecar = async (patch: SidecarPatch) => {
    if (!sidecar || sidecarSaving) return;
    const previous = sidecar;
    const next = {
      webSearch: mergeSidecarSetting(sidecar.webSearch, patch.webSearch),
      vision: mergeSidecarSetting(sidecar.vision, patch.vision),
      ...(sidecar.visionModels ? { visionModels: sidecar.visionModels } : {}),
      ...(sidecar.webSearchModels ? { webSearchModels: sidecar.webSearchModels } : {}),
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
      setSidecar({
        webSearch: data.webSearch,
        vision: data.vision,
        ...(data.visionModels ? { visionModels: data.visionModels } : {}),
        ...(data.webSearchModels ? { webSearchModels: data.webSearchModels } : {}),
      });
      const prev = readSessionListCache<CachedControls>(controlsCacheKey(apiBase)) ?? {};
      writeSessionListCache(controlsCacheKey(apiBase), {
        ...prev,
        sidecar: {
          webSearch: data.webSearch,
          vision: data.vision,
          ...(data.visionModels ? { visionModels: data.visionModels } : {}),
          ...(data.webSearchModels ? { webSearchModels: data.webSearchModels } : {}),
        },
      });
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
    setMaError(null);
   try {
     const r = await fetch(`${apiBase}/api/v2`, {
       method: "PUT",
       headers: { "Content-Type": "application/json" },
       body: JSON.stringify({ multiAgentMode: mode }),
     });
     if (r.ok) {
       setMaMode(mode);
       writeSessionListCache(`${MA_MODE_CACHE_PREFIX}${apiBase}`, mode);
      } else {
        let message = t("dash.maSwitchFailed", { status: String(r.status) });
        try {
          const body = await r.json() as { error?: string; message?: string };
          message = (typeof body.error === "string" && body.error) || (typeof body.message === "string" && body.message) || message;
        } catch { /* non-JSON error body */ }
        setMaError(message);
     }
    } catch (e) {
      setMaError(e instanceof Error ? e.message : t("dash.maNetworkError"));
    }
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

  // Clears the sync result/error in this hook. The dashboard toast owns its own dismissal
  // timer but must publish the dismissal here: syncResult/syncError live above the dashboard
  // tabs, so a component-local flag alone would let a stale result remount as a fresh toast
  // after the Overview panel unmounts and comes back.
  const clearSyncFeedback = useCallback(() => {
    setSyncResult(null);
    setSyncError(null);
  }, []);

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

  /**
   * Sidebar update button deep link (`#dashboard/update`). Opening happens straight from
   * the hashchange listener — an external event, not a render-time effect — so no
   * intermediate state or ref hand-off is needed. The hash is normalized back to
   * `#dashboard` before opening, so Back never re-triggers the dialog.
   *
   * `openUpdateDialogRef` keeps the listener registration stable while still calling the
   * latest handler; it is only ever written inside an effect.
   */
  const openUpdateDialogRef = useRef(openUpdateDialog);
  useEffect(() => {
    openUpdateDialogRef.current = openUpdateDialog;
  });
  useEffect(() => {
    const consume = () => {
      if (!hashRequestsUpdateDialog()) return;
      replaceHash("dashboard");
      openUpdateDialogRef.current();
    };
    // A cold load straight onto the deep link: defer past mount so the open is not a
    // render-phase side effect.
    const initial = hashRequestsUpdateDialog() ? window.setTimeout(consume, 0) : null;
    window.addEventListener("hashchange", consume);
    return () => {
      if (initial !== null) window.clearTimeout(initial);
      window.removeEventListener("hashchange", consume);
    };
  }, []);

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
    usageLoading: usagePoll.loading && !usage30d,
    healthLoading: overviewPoll.loading && !health,
    sidecarSaving, shadowCallSaving, modelsLoading, settingsSaving, syncing,
   maMode, maModeResolved, maBusy, setMaHelpOpen, maHelpOpen,
    maError,
   effortCapHelpOpen, setEffortCapHelpOpen, shadowCallHelpOpen, setShadowCallHelpOpen,
    injectionModel, injectionEffort, injectionEfforts, injectionAvailable, injectionSaving,
    multiAgentGuidanceEnabled, syncCodexSubagentDefaults, saveInjection,
    effortCap, subagentEffortCap, effortCapSaving, setEffortCap, setSubagentEffortCap, setEffortCapSaving,
    syncResult, syncError, projectConfigWarnings,
    updateOpen, updateChannel, setUpdateRestart, updateRestart, updateLoading,
    updateCheck, updateError, updateJob, reconnecting, error,
    effortCapHelpTriggerRef, updateTriggerRef, maHelpTriggerRef, shadowCallHelpTriggerRef,
    effortCapHelpDialogRef, updateDialogRef, maHelpDialogRef, shadowCallHelpDialogRef,
    filteredGroups, sidecarModels, visionModels,
    saveSidecar, saveShadowCall, switchMaMode, toggleCodexAutoStart, runSync, clearSyncFeedback,
    fetchUpdateCheck, closeUpdateDialog, openUpdateDialog, changeUpdateChannel, runUpdate,
  };
}
