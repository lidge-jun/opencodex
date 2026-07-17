import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useReducer, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { formatUptime } from "../formatUptime";
import { IconAlert, IconExternal, IconInfo, IconRefresh, IconX } from "../icons";
import { useI18n } from "../i18n/shared";
import { Trans } from "../i18n/provider";
import type { TKey, Locale } from "../i18n/shared";
import { formatTokens } from "../format-tokens";
import { EmptyState, Select } from "../ui";

interface HealthData { status: string; version: string; uptime: number }
interface ProviderInfo { name: string; adapter: string; baseUrl: string; defaultModel?: string; hasApiKey: boolean }
interface ModelInfo { id: string; provider: string; owned_by?: string }
interface SettingsData { codexAutoStart: boolean; port: number; hostname: string }
type SidecarBackend = "openai" | "anthropic";
interface SidecarSetting { backend?: SidecarBackend; model: string }
interface SidecarData { webSearch: SidecarSetting; vision: SidecarSetting }
interface SidecarPatch {
  webSearch?: { backend?: SidecarBackend | null; model?: string };
  vision?: { backend?: SidecarBackend | null; model?: string };
}
interface ShadowCallData { enabled: boolean; model: string }
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


const EFFORT_CAP_LEVELS = ["low", "medium", "high", "xhigh"];
const UPDATE_CHECK_MAX_AUTO_RETRIES = 2;
const UPDATE_CHECK_RETRY_BASE_MS = 800;

function defaultUpdateChannel(version: string | undefined): UpdateChannel {
  return version?.includes("-preview.") ? "preview" : "latest";
}

function updateReasonLabel(reason: string | undefined, t: (key: TKey) => string): string {
  switch (reason) {
    case "source_checkout": return t("dash.updateReason.source_checkout");
    case "latest_unavailable": return t("dash.updateReason.latest_unavailable");
    case "already_latest": return t("dash.updateReason.already_latest");
    default: return t("dash.updateReason.unknown");
  }
}

type UpdateUiState = {
  open: boolean;
  channel: UpdateChannel;
  restart: boolean;
  loading: boolean;
  check: UpdateCheckData | null;
  error: string | null;
  job: UpdateJob | null;
};

type UpdateUiAction =
  | { type: "open"; channel: UpdateChannel }
  | { type: "close" }
  | { type: "setChannel"; channel: UpdateChannel }
  | { type: "setRestart"; restart: boolean }
  | { type: "checkBegin" }
  | { type: "checkDone"; check: UpdateCheckData }
  | { type: "checkFail"; error: string }
  | { type: "setLoading"; loading: boolean }
  | { type: "setJob"; job: UpdateJob | null };

const initialUpdateUi: UpdateUiState = {
  open: false,
  channel: "latest",
  restart: true,
  loading: false,
  check: null,
  error: null,
  job: null,
};

function updateUiReducer(state: UpdateUiState, action: UpdateUiAction): UpdateUiState {
  switch (action.type) {
    case "open":
      return { ...state, open: true, channel: action.channel, restart: true, error: null, check: null, loading: false };
    case "close":
      return { ...state, open: false, loading: false };
    case "setChannel":
      return { ...state, channel: action.channel };
    case "setRestart":
      return { ...state, restart: action.restart };
    case "checkBegin":
      return { ...state, loading: true, error: null, check: null };
    case "checkDone":
      return { ...state, loading: false, check: action.check };
    case "checkFail":
      return { ...state, loading: false, error: action.error };
    case "setLoading":
      return { ...state, loading: action.loading };
    case "setJob":
      return { ...state, job: action.job };
    default: {
      const _exhaustive: never = action;
      return _exhaustive;
    }
  }
}

type InjectionUiState = {
  model: string;
  effort: string;
  efforts: string[];
  available: Array<{ provider: string; model: string; namespaced: string }>;
  saving: boolean;
};

type InjectionUiAction =
  | { type: "setAll"; model: string; effort: string; efforts: string[]; available: InjectionUiState["available"] }
  | { type: "setModel"; model: string; effort: string }
  | { type: "setSaving"; saving: boolean };

function injectionUiReducer(state: InjectionUiState, action: InjectionUiAction): InjectionUiState {
  switch (action.type) {
    case "setAll":
      return { ...state, model: action.model, effort: action.effort, efforts: action.efforts, available: action.available };
    case "setModel":
      return { ...state, model: action.model, effort: action.effort };
    case "setSaving":
      return { ...state, saving: action.saving };
    default: {
      const _exhaustive: never = action;
      return _exhaustive;
    }
  }
}

type EffortCapUiState = {
  effortCap: string;
  subagentEffortCap: string;
  saving: boolean;
};

type EffortCapUiAction =
  | { type: "setCaps"; effortCap: string; subagentEffortCap: string }
  | { type: "setSaving"; saving: boolean };

function effortCapUiReducer(state: EffortCapUiState, action: EffortCapUiAction): EffortCapUiState {
  switch (action.type) {
    case "setCaps":
      return { ...state, effortCap: action.effortCap, subagentEffortCap: action.subagentEffortCap };
    case "setSaving":
      return { ...state, saving: action.saving };
    default: {
      const _exhaustive: never = action;
      return _exhaustive;
    }
  }
}

type SyncUiState = {
  syncing: boolean;
  result: SyncResult | null;
  error: string | null;
};

type SyncUiAction =
  | { type: "begin" }
  | { type: "done"; result: SyncResult }
  | { type: "fail"; error: string };

const initialSyncUi: SyncUiState = { syncing: false, result: null, error: null };

function syncUiReducer(state: SyncUiState, action: SyncUiAction): SyncUiState {
  switch (action.type) {
    case "begin":
      return { ...state, syncing: true, result: null, error: null };
    case "done":
      return { ...state, syncing: false, result: action.result, error: null };
    case "fail":
      return { ...state, syncing: false, result: null, error: action.error };
    default: {
      const _exhaustive: never = action;
      return _exhaustive;
    }
  }
}

type MaUiState = {
  mode: "v1" | "default" | "v2";
  busy: boolean;
};

type MaUiAction =
  | { type: "setMode"; mode: MaUiState["mode"] }
  | { type: "setBusy"; busy: boolean };

function maUiReducer(state: MaUiState, action: MaUiAction): MaUiState {
  switch (action.type) {
    case "setMode":
      return { ...state, mode: action.mode };
    case "setBusy":
      return { ...state, busy: action.busy };
    default: {
      const _exhaustive: never = action;
      return _exhaustive;
    }
  }
}

function useModalDialog(open: boolean) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (open && !el.open) el.showModal();
    else if (!open && el.open) el.close();
  }, [open]);
  return ref;
}

function sidecarModelOptions(models: ModelInfo[]) {
  const options: { value: string; label: string }[] = [];
  for (const m of models) {
    if (m.provider === "openai" || m.provider === "anthropic") {
      options.push({ value: m.id, label: `${m.provider}/${m.id}` });
    }
  }
  return options;
}

interface DashboardPollData {
  health: HealthData;
  providers: ProviderInfo[];
  settings: SettingsData;
  sidecar: SidecarData;
  shadowCall: ShadowCallData | null;
  usage30d: UsageSummary30d | null;
  multiAgentMode: "v1" | "v2" | "default";
  injection: {
    model?: string | null;
    effort?: string | null;
    efforts?: string[];
    available?: Array<{ provider: string; model: string; namespaced: string }>;
  } | null;
  effortCaps: {
    effortCap?: string | null;
    subagentEffortCap?: string | null;
    efforts?: string[];
  } | null;
}

async function fetchDashboardPoll(apiBase: string): Promise<DashboardPollData> {
  const [hRes, pRes, sRes, scRes, shRes, uRes] = await Promise.all([
    fetch(`${apiBase}/healthz`),
    fetch(`${apiBase}/api/providers`),
    fetch(`${apiBase}/api/settings`),
    fetch(`${apiBase}/api/sidecar-settings`),
    fetch(`${apiBase}/api/shadow-call-settings`),
    fetch(`${apiBase}/api/usage?range=30d`),
  ]);
  const health = await hRes.json() as HealthData;
  const providers = await pRes.json() as ProviderInfo[];
  const settings = await sRes.json() as SettingsData;
  const sidecar = await scRes.json() as SidecarData;
  let shadowCall: ShadowCallData | null = null;
  try { if (shRes.ok) shadowCall = await shRes.json() as ShadowCallData; } catch { shadowCall = null; }
  let usage30d: UsageSummary30d | null = null;
  try { usage30d = uRes.ok ? await uRes.json() as UsageSummary30d : null; } catch { usage30d = null; }

  let multiAgentMode: DashboardPollData["multiAgentMode"] = "default";
  try {
    const v2Res = await fetch(`${apiBase}/api/v2`);
    if (v2Res.ok) {
      const v2Data = await v2Res.json() as { multiAgentMode?: string };
      if (v2Data.multiAgentMode === "v1" || v2Data.multiAgentMode === "v2") multiAgentMode = v2Data.multiAgentMode;
    }
  } catch { /* old server */ }

  let injection: DashboardPollData["injection"] = null;
  try {
    const imRes = await fetch(`${apiBase}/api/injection-model`);
    if (imRes.ok) injection = await imRes.json() as DashboardPollData["injection"];
  } catch { /* old server */ }

  let effortCaps: DashboardPollData["effortCaps"] = null;
  try {
    const ecRes = await fetch(`${apiBase}/api/effort-caps`);
    if (ecRes.ok) effortCaps = await ecRes.json() as DashboardPollData["effortCaps"];
  } catch { /* old server */ }

  return { health, providers, settings, sidecar, shadowCall, usage30d, multiAgentMode, injection, effortCaps };
}

function useDashboardController(apiBase: string) {
  const { locale, t } = useI18n();
  const [health, setHealth] = useState<HealthData | null>(null);
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [settings, setSettings] = useState<SettingsData | null>(null);
  const [sidecar, setSidecar] = useState<SidecarData | null>(null);
  const [shadowCall, setShadowCall] = useState<ShadowCallData | null>(null);
  const [usage30d, setUsage30d] = useState<UsageSummary30d | null>(null);
  const [sidecarSaving, setSidecarSaving] = useState(false);
  const [shadowCallSaving, setShadowCallSaving] = useState(false);
  const [settingsSaving, setSettingsSaving] = useState(false);
  const [syncUi, dispatchSync] = useReducer(syncUiReducer, initialSyncUi);
  const [maUi, dispatchMa] = useReducer(maUiReducer, { mode: "default", busy: false });
  const [maHelpOpen, setMaHelpOpen] = useState(false);
  const [effortCapHelpOpen, setEffortCapHelpOpen] = useState(false);
  const [injectionUi, dispatchInjection] = useReducer(injectionUiReducer, {
    model: "",
    effort: "",
    efforts: [] as string[],
    available: [] as InjectionUiState["available"],
    saving: false,
  });
  const [effortCapUi, dispatchEffortCap] = useReducer(effortCapUiReducer, {
    effortCap: "",
    subagentEffortCap: "",
    saving: false,
  });
  const [projectConfigWarnings, setProjectConfigWarnings] = useState<ProjectCodexConfigGroup[]>([]);
  const [updateUi, dispatchUpdate] = useReducer(updateUiReducer, initialUpdateUi);
  const updateRetryRef = useRef(0);
  const updateRetryTimerRef = useRef<number | null>(null);
  const updateRequestEpochRef = useRef(0);
  const [reconnecting, setReconnecting] = useState(false);
  const [error, setError] = useState(false);

  const { data: dashboardData, isError: dashboardError } = useQuery({
    queryKey: ["dashboard", apiBase],
    queryFn: () => fetchDashboardPoll(apiBase),
    refetchInterval: 5000,
    retry: false,
  });

  const { data: diagnosticsData } = useQuery({
    queryKey: ["project-config-diagnostics", apiBase],
    queryFn: async () => {
      const pcRes = await fetch(`${apiBase}/api/diagnostics/project-config`);
      if (!pcRes.ok) return [] as ProjectCodexConfigGroup[];
      const pcData = await pcRes.json() as { grouped?: ProjectCodexConfigGroup[] };
      return pcData?.grouped ?? [];
    },
    refetchInterval: 30_000,
    retry: false,
  });

  const { data: modelsData, isFetching: modelsLoading } = useQuery({
    queryKey: ["models", apiBase],
    queryFn: async () => {
      const response = await fetch(`${apiBase}/api/models`);
      if (!response.ok) throw new Error("models fetch failed");
      return response.json() as Promise<ModelInfo[]>;
    },
    enabled: !error,
    retry: false,
  });

  useEffect(() => () => {
    updateRequestEpochRef.current += 1;
    if (updateRetryTimerRef.current !== null) {
      window.clearTimeout(updateRetryTimerRef.current);
      updateRetryTimerRef.current = null;
    }
  }, []);

  useEffect(() => {
    setError(dashboardError);
  }, [dashboardError]);

  useEffect(() => {
    if (!dashboardData) return;
    setHealth(dashboardData.health);
    setProviders(dashboardData.providers);
    setSettings(dashboardData.settings);
    setSidecar(dashboardData.sidecar);
    setShadowCall(dashboardData.shadowCall);
    setUsage30d(dashboardData.usage30d);
    dispatchMa({ type: "setMode", mode: dashboardData.multiAgentMode });
    if (dashboardData.injection) {
      dispatchInjection({
        type: "setAll",
        model: dashboardData.injection.model ?? "",
        effort: dashboardData.injection.effort ?? "",
        efforts: dashboardData.injection.efforts ?? [],
        available: dashboardData.injection.available ?? [],
      });
    }
    if (dashboardData.effortCaps) {
      dispatchEffortCap({
        type: "setCaps",
        effortCap: dashboardData.effortCaps.effortCap ?? "",
        subagentEffortCap: dashboardData.effortCaps.subagentEffortCap ?? "",
      });
    }
  }, [dashboardData]);

  useEffect(() => {
    setProjectConfigWarnings(diagnosticsData ?? []);
  }, [diagnosticsData]);

  useEffect(() => {
    if (modelsData) setModels(modelsData);
  }, [modelsData]);

  const updateJobId = updateUi.job?.id;
  const updateJobRestart = updateUi.job?.restart;
  const updateTargetVersion = updateUi.job?.latestVersion;

  const { data: updatePoll } = useQuery({
    queryKey: ["update-status", apiBase, updateJobId, updateTargetVersion],
    enabled: Boolean(updateJobId && updateJobRestart),
    refetchInterval: 1500,
    retry: false,
    queryFn: async () => {
      let job: UpdateJob | undefined;
      let reconnectingNext = false;
      let shouldReload = false;
      try {
        const res = await fetch(`${apiBase}/api/update/status?jobId=${encodeURIComponent(updateJobId!)}`);
        if (res.ok) {
          const data = await res.json() as { job?: UpdateJob };
          job = data.job;
        }
      } catch {
        reconnectingNext = true;
      }
      if (updateTargetVersion) {
        try {
          const healthRes = await fetch(`${apiBase}/healthz`, { cache: "no-store" });
          if (!healthRes.ok) throw new Error("health failed");
          const data = await healthRes.json() as HealthData;
          if (data.version === updateTargetVersion) shouldReload = true;
        } catch {
          reconnectingNext = true;
        }
      }
      return {
        job,
        reconnecting: reconnectingNext,
        shouldReload,
        failed: job?.status === "failed",
      };
    },
  });

  useEffect(() => {
    if (!updatePoll) return;
    if (updatePoll.job) dispatchUpdate({ type: "setJob", job: updatePoll.job });
    if (updatePoll.failed || updatePoll.shouldReload) setReconnecting(false);
    else if (updatePoll.reconnecting) setReconnecting(true);
    if (updatePoll.shouldReload) window.location.reload();
  }, [updatePoll]);

  const sidecarModels = useMemo(() => sidecarModelOptions(models), [models]);
  const grouped = useMemo(() => {
    const g: Record<string, ModelInfo[]> = {};
    for (const m of models) (g[m.provider] ??= []).push(m);
    return Object.entries(g).sort(([a], [b]) => a.localeCompare(b));
  }, [models]);

  const online = health?.status === "ok";

  const saveSidecar = async (patch: SidecarPatch) => {
    if (!sidecar || sidecarSaving) return;
    const mergeSetting = (current: SidecarSetting, update?: { backend?: SidecarBackend | null; model?: string }): SidecarSetting => {
      const merged = { ...current };
      if (update?.model !== undefined) merged.model = update.model;
      if (update?.backend === null) delete merged.backend;
      else if (update?.backend !== undefined) merged.backend = update.backend;
      return merged;
    };
    const next = {
      webSearch: mergeSetting(sidecar.webSearch, patch.webSearch),
      vision: mergeSetting(sidecar.vision, patch.vision),
    };
    setSidecarSaving(true);
    setSidecar(next);
    try {
      const res = await fetch(`${apiBase}/api/sidecar-settings`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
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

  const saveShadowCall = async (patch: Partial<ShadowCallData>) => {
    if (!shadowCall || shadowCallSaving) return;
    setShadowCallSaving(true);
    setShadowCall({ ...shadowCall, ...patch });
    try {
      await fetch(`${apiBase}/api/shadow-call-settings`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
    } finally {
      setShadowCallSaving(false);
    }
  };

  const switchMaMode = async (mode: "v1" | "default" | "v2") => {
    if (maUi.busy || maUi.mode === mode) return;
    dispatchMa({ type: "setBusy", busy: true });
    try {
      const r = await fetch(`${apiBase}/api/v2`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ multiAgentMode: mode }),
      });
      if (r.ok) dispatchMa({ type: "setMode", mode });
    } catch { /* ignore */ }
    finally { dispatchMa({ type: "setBusy", busy: false }); }
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
    if (syncUi.syncing) return;
    dispatchSync({ type: "begin" });
    try {
      const res = await fetch(`${apiBase}/api/sync`, { method: "POST" });
      const data = await res.json() as SyncResult | { error?: string };
      if (!res.ok) throw new Error("error" in data && data.error ? data.error : "sync failed");
      dispatchSync({ type: "done", result: data as SyncResult });
      const groupedWarnings = (data as SyncResult & { projectConfigGrouped?: ProjectCodexConfigGroup[] }).projectConfigGrouped;
      if (groupedWarnings) setProjectConfigWarnings(groupedWarnings);
    } catch (err) {
      dispatchSync({ type: "fail", error: err instanceof Error ? err.message : String(err) });
    }
  };

  const fetchUpdateCheck = async (channel: UpdateChannel, resetRetry = false) => {
    if (resetRetry) updateRetryRef.current = 0;
    if (updateRetryTimerRef.current !== null) {
      window.clearTimeout(updateRetryTimerRef.current);
      updateRetryTimerRef.current = null;
    }
    const requestEpoch = ++updateRequestEpochRef.current;
    dispatchUpdate({ type: "checkBegin" });
    try {
      const res = await fetch(`${apiBase}/api/update/check?tag=${channel}`);
      const data = await res.json() as UpdateCheckData | { error?: string };
      if (!res.ok) throw new Error("error" in data && data.error ? data.error : "update check failed");
      if (requestEpoch !== updateRequestEpochRef.current) return;
      const check = data as UpdateCheckData;
      dispatchUpdate({ type: "checkDone", check });
      if (check.reason === "latest_unavailable" && updateRetryRef.current < UPDATE_CHECK_MAX_AUTO_RETRIES) {
        const retry = ++updateRetryRef.current;
        updateRetryTimerRef.current = window.setTimeout(() => {
          if (requestEpoch !== updateRequestEpochRef.current) return;
          updateRetryTimerRef.current = null;
          void fetchUpdateCheck(channel);
        }, UPDATE_CHECK_RETRY_BASE_MS * retry);
        return;
      }
      if (check.reason !== "latest_unavailable") updateRetryRef.current = 0;
      dispatchUpdate({ type: "setLoading", loading: false });
    } catch (err) {
      if (requestEpoch !== updateRequestEpochRef.current) return;
      dispatchUpdate({ type: "checkFail", error: err instanceof Error ? err.message : String(err) });
    }
  };

  const closeUpdateDialog = () => {
    updateRequestEpochRef.current += 1;
    if (updateRetryTimerRef.current !== null) {
      window.clearTimeout(updateRetryTimerRef.current);
      updateRetryTimerRef.current = null;
    }
    dispatchUpdate({ type: "close" });
  };

  const openUpdateDialog = () => {
    const channel = defaultUpdateChannel(health?.version);
    dispatchUpdate({ type: "open", channel });
    void fetchUpdateCheck(channel, true);
  };

  const changeUpdateChannel = (channel: UpdateChannel) => {
    dispatchUpdate({ type: "setChannel", channel });
    void fetchUpdateCheck(channel, true);
  };

  const runUpdate = async () => {
    if (!updateUi.check?.canUpdate) return;
    try {
      const res = await fetch(`${apiBase}/api/update/run`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tag: updateUi.channel, restart: updateUi.restart }),
      });
      const data = await res.json() as { job?: UpdateJob; error?: string };
      if (!res.ok || !data.job) throw new Error(data.error ?? "update failed to start");
      dispatchUpdate({ type: "setJob", job: data.job });
      setReconnecting(false);
      closeUpdateDialog();
    } catch (err) {
      dispatchUpdate({ type: "checkFail", error: err instanceof Error ? err.message : String(err) });
    }
  };

  const updateJobLabel = (status: UpdateJobStatus): string => {
    switch (status) {
      case "running": return t("dash.updateStatus.running");
      case "restarting": return t("dash.updateStatus.restarting");
      case "succeeded": return t("dash.updateStatus.succeeded");
      case "failed": return t("dash.updateStatus.failed");
      default: {
        const _exhaustive: never = status;
        return _exhaustive;
      }
    }
  };

  return {
    apiBase, locale, t, error, health, providers, models, settings, sidecar, shadowCall, usage30d,
    sidecarSaving, shadowCallSaving, modelsLoading, settingsSaving, syncUi, maUi, maHelpOpen, setMaHelpOpen,
    effortCapHelpOpen, setEffortCapHelpOpen, injectionUi, dispatchInjection, effortCapUi, dispatchEffortCap,
    projectConfigWarnings, updateUi, dispatchUpdate, reconnecting, sidecarModels, grouped, online,
    saveSidecar, saveShadowCall, switchMaMode, toggleCodexAutoStart, runSync,
    closeUpdateDialog, openUpdateDialog, changeUpdateChannel, runUpdate, fetchUpdateCheck, updateJobLabel,
    setShadowCall,
  };
}

export default function Dashboard({ apiBase }: { apiBase: string }) {
  const c = useDashboardController(apiBase);

  if (c.error) {
    return (
      <EmptyState style={{ marginTop: 40 }} icon={<IconAlert />}
        title={<span style={{ color: "var(--red)" }}>{c.t("dash.cannotConnect")}</span>}>
        <Trans k="dash.runStart" cmd="ocx start" />
      </EmptyState>
    );
  }

  return (
    <>
      <div className="page-head"><h2>{c.t("nav.dashboard")}</h2></div>
      <p className="page-sub">{c.t("dash.subtitle")}</p>

      <DashboardStats
        t={c.t}
        locale={c.locale}
        health={c.health}
        online={c.online}
        providersCount={c.providers.length}
        usage30d={c.usage30d}
        maMode={c.maUi.mode}
        maBusy={c.maUi.busy}
        onOpenMaHelp={() => c.setMaHelpOpen(true)}
        onSwitchMaMode={c.switchMaMode}
      />

      <ProjectConfigNotice warnings={c.projectConfigWarnings} t={c.t} />

      {c.maUi.mode !== "v1" && (
        <EffortCapPanel
          apiBase={c.apiBase}
          effortCapUi={c.effortCapUi}
          effortCapHelpOpen={c.effortCapHelpOpen}
          dispatchEffortCap={c.dispatchEffortCap}
          setEffortCapHelpOpen={c.setEffortCapHelpOpen}
          t={c.t}
        />
      )}

      <InjectionPanel apiBase={c.apiBase} injectionUi={c.injectionUi} dispatchInjection={c.dispatchInjection} t={c.t} />

      <DashboardMaintenance
        t={c.t}
        syncing={c.syncUi.syncing}
        syncResult={c.syncUi.result}
        syncError={c.syncUi.error}
        updateUi={c.updateUi}
        reconnecting={c.reconnecting}
        updateJobLabel={c.updateJobLabel}
        onRunSync={c.runSync}
        onOpenUpdate={c.openUpdateDialog}
      />

      <CodexAutoStartPanel t={c.t} settings={c.settings} settingsSaving={c.settingsSaving} onToggle={c.toggleCodexAutoStart} />

      <SidecarPanels
        t={c.t}
        sidecar={c.sidecar}
        sidecarSaving={c.sidecarSaving}
        sidecarModels={c.sidecarModels}
        models={c.models}
        onSaveSidecar={c.saveSidecar}
      />

      <ShadowCallPanel
        t={c.t}
        shadowCall={c.shadowCall}
        shadowCallSaving={c.shadowCallSaving}
        models={c.models}
        onSaveShadowCall={c.saveShadowCall}
        onPatchShadowCall={patch => c.setShadowCall(s => s ? { ...s, ...patch } : s)}
      />

      <ProvidersTable providers={c.providers} t={c.t} />
      <ModelsGrid grouped={c.grouped} modelsLoading={c.modelsLoading} modelsCount={c.models.length} t={c.t} />

      <UpdateDialog
        open={c.updateUi.open}
        updateUi={c.updateUi}
        t={c.t}
        onClose={c.closeUpdateDialog}
        onChangeChannel={c.changeUpdateChannel}
        onRetry={() => { void c.fetchUpdateCheck(c.updateUi.channel, true); }}
        onToggleRestart={() => c.dispatchUpdate({ type: "setRestart", restart: !c.updateUi.restart })}
        onRunUpdate={c.runUpdate}
      />

      <MaHelpDialog open={c.maHelpOpen} t={c.t} onClose={() => c.setMaHelpOpen(false)} />
    </>
  );
}


function DashboardStats({
  t, locale, health, online, providersCount, usage30d, maMode, maBusy, onOpenMaHelp, onSwitchMaMode,
}: {
  t: (key: TKey) => string;
  locale: Locale;
  health: HealthData | null;
  online: boolean;
  providersCount: number;
  usage30d: UsageSummary30d | null;
  maMode: "v1" | "default" | "v2";
  maBusy: boolean;
  onOpenMaHelp: () => void;
  onSwitchMaMode: (mode: "v1" | "default" | "v2") => void;
}) {
  return (
    <div className="stat-row">
      <div className="stat">
        <div className="label" style={{ display: "flex", alignItems: "center", gap: 6 }}>
          {t("dash.multiAgent")}
          <button type="button" className="btn btn-ghost btn-sm dash-info-btn" onClick={onOpenMaHelp} aria-label={t("dash.multiAgent")} aria-haspopup="dialog">
            <IconInfo width={14} height={14} aria-hidden="true" />
          </button>
        </div>
        <div className="value" style={{ display: "flex", alignItems: "center", justifyContent: "center" }}>
          <div role="radiogroup" aria-label={t("dash.multiAgent")} className="dash-mode-toggle">
            {(["v1", "default", "v2"] as const).map(mode => (
              <button key={mode} type="button" role="radio" aria-checked={maMode === mode}
                className={`btn btn-sm text-caption${maMode === mode ? " btn-primary" : " btn-ghost"}`}
                style={{ borderRadius: "var(--radius-pill)", minWidth: 36, padding: "5px 10px", border: "none", background: maMode === mode ? undefined : "transparent", color: maMode === mode ? undefined : "var(--muted)" }}
                disabled={maBusy} onClick={() => void onSwitchMaMode(mode)}
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
      <div className="stat"><div className="label">{t("dash.providers")}</div><div className="value">{providersCount}</div></div>
      <div className="stat">
        <div className="label">{t("dash.tokens30d")}</div>
        <div className="value mono">{usage30d && usage30d.summary.requests > 0 ? formatTokens(usage30d.summary.totalTokens, locale) : "—"}</div>
        {usage30d && usage30d.summary.requests > 0 && (
          <div className="muted text-label" style={{ marginTop: 2 }}>
            {t("dash.coverage").replace("{pct}", `${Math.round(usage30d.summary.coverageRatio * 100)}%`)}
          </div>
        )}
      </div>
    </div>
  );
}

function ProjectConfigNotice({ warnings, t }: { warnings: ProjectCodexConfigGroup[]; t: (key: TKey) => string }) {
  if (warnings.length === 0) return null;
  return (
    <div className="notice notice-err maintenance-notice" style={{ marginBottom: 24 }} role="alert">
      <IconAlert />
      <div>
        <div className="font-semibold">{t("dash.projectConfigTitle")}</div>
        <div className="muted text-control" style={{ marginTop: 4 }}>{t("dash.projectConfigHint")}</div>
        <ul className="text-control" style={{ margin: "10px 0 0", paddingLeft: 18 }}>
          {warnings.map(g => (
            <li key={g.path} style={{ marginBottom: 8 }}>
              <code>{g.path}</code> — {g.issues.join(", ")}
              <div className="muted" style={{ marginTop: 2 }}>{g.bypass}</div>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

function DashboardMaintenance({
  t, syncing, syncResult, syncError, updateUi, reconnecting, updateJobLabel, onRunSync, onOpenUpdate,
}: {
  t: (key: TKey, vars?: Record<string, string | number>) => string;
  syncing: boolean;
  syncResult: SyncResult | null;
  syncError: string | null;
  updateUi: UpdateUiState;
  reconnecting: boolean;
  updateJobLabel: (status: UpdateJobStatus) => string;
  onRunSync: () => void;
  onOpenUpdate: () => void;
}) {
  return (
    <div className="panel maintenance-panel" style={{ marginBottom: 24 }}>
      <div className="spread maintenance-head">
        <div>
          <div className="font-semibold">{t("dash.maintenance")}</div>
          <div className="muted text-control" style={{ marginTop: 3 }}>{t("dash.maintenanceHint")}</div>
        </div>
        <div className="maintenance-actions">
          <button type="button" className="btn btn-ghost" onClick={onRunSync} disabled={syncing}>
            <IconRefresh /> {syncing ? t("dash.syncing") : t("dash.syncModels")}
          </button>
          <button type="button" className="btn btn-primary" onClick={onOpenUpdate} disabled={updateUi.loading}>
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
      {updateUi.job && (
        <div className={`notice ${updateUi.job.status === "failed" ? "notice-err" : "notice-ok"} maintenance-notice`} role="status">
          {updateUi.job.status === "failed" ? <IconAlert /> : <IconRefresh />}
          <span>
            {updateJobLabel(updateUi.job.status)}
            {updateUi.job.latestVersion ? ` ${updateUi.job.currentVersion} -> ${updateUi.job.latestVersion}.` : ""}
            {reconnecting ? ` ${t("dash.updateReconnecting")}` : ""}
            {updateUi.job.error ? ` ${updateUi.job.error}` : ""}
          </span>
        </div>
      )}
    </div>
  );
}

function CodexAutoStartPanel({ t, settings, settingsSaving, onToggle }: {
  t: (key: TKey) => string;
  settings: SettingsData | null;
  settingsSaving: boolean;
  onToggle: () => void;
}) {
  return (
    <div className="panel" style={{ marginBottom: 24 }}>
      <div className="spread">
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="font-semibold">{t("dash.codexAutoStart")}</div>
          <div className="muted setting-hint">{t("dash.codexAutoStartHint")}</div>
        </div>
        <button type="button" className={`switch ${settings?.codexAutoStart ?? true ? "on" : ""}`} onClick={onToggle}
          disabled={!settings || settingsSaving} aria-label={t("dash.codexAutoStart")} aria-pressed={settings?.codexAutoStart ?? true}>
          <span className="knob" />
        </button>
      </div>
    </div>
  );
}

function SidecarPanels({ t, sidecar, sidecarSaving, sidecarModels, models, onSaveSidecar }: {
  t: (key: TKey) => string;
  sidecar: SidecarData | null;
  sidecarSaving: boolean;
  sidecarModels: { value: string; label: string }[];
  models: ModelInfo[];
  onSaveSidecar: (patch: SidecarPatch) => void;
}) {
  const pickBackend = (modelId: string) => (models.find(m => m.id === modelId)?.provider === "anthropic" ? "anthropic" : "openai") as SidecarBackend;
  return (
    <>
      <div className="panel" style={{ marginBottom: 12 }}>
        <div className="spread setting-row" style={{ alignItems: "flex-start" }}>
          <div className="setting-copy" style={{ flex: 1 }}>
            <div className="font-semibold">{t("dash.webSearchSidecar")}</div>
            <div className="muted setting-hint">{t("dash.webSearchSidecarHint")}</div>
          </div>
          <div className="setting-controls">
            <Select value={sidecar?.webSearch.model ?? "gpt-5.6-luna"} options={sidecarModels}
              onChange={v => onSaveSidecar({ webSearch: { model: v, backend: pickBackend(v) } })}
              disabled={!sidecar || sidecarSaving} label={t("dash.sidecarModel")} />
          </div>
        </div>
      </div>
      <div className="panel" style={{ marginBottom: 24 }}>
        <div className="spread setting-row">
          <div className="setting-copy" style={{ flex: 1 }}>
            <div className="font-semibold">{t("dash.visionSidecar")}</div>
            <div className="muted setting-hint">{t("dash.visionSidecarHint")}</div>
          </div>
          <div className="setting-controls">
            <Select value={sidecar?.vision.model ?? "gpt-5.6-luna"} options={sidecarModels}
              onChange={v => onSaveSidecar({ vision: { model: v, backend: pickBackend(v) } })}
              disabled={!sidecar || sidecarSaving} label={t("dash.sidecarModel")} />
          </div>
        </div>
      </div>
    </>
  );
}

function ShadowCallPanel({ t, shadowCall, shadowCallSaving, models, onSaveShadowCall, onPatchShadowCall }: {
  t: (key: TKey) => string;
  shadowCall: ShadowCallData | null;
  shadowCallSaving: boolean;
  models: ModelInfo[];
  onSaveShadowCall: (patch: Partial<ShadowCallData>) => void;
  onPatchShadowCall: (patch: Partial<ShadowCallData>) => void;
}) {
  return (
    <div className="panel" style={{ marginBottom: 12 }}>
      <div className="spread setting-row" style={{ alignItems: "center" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span className="font-semibold">{t("dash.shadowCallIntercept")}</span>
          <span title={t("dash.shadowCallTooltip")} style={{ cursor: "help", opacity: 0.5 }}>ⓘ</span>
          <code className="muted text-caption">⚠ 5.4-mini</code>
        </div>
        <div className="setting-controls" style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <button type="button" className={`switch ${shadowCall?.enabled ? "on" : ""}`}
            onClick={() => onSaveShadowCall({ enabled: !shadowCall?.enabled })}
            disabled={!shadowCall || shadowCallSaving} aria-label={t("dash.shadowCallIntercept")} aria-pressed={shadowCall?.enabled ?? false}>
            <span className="knob" />
          </button>
          <Select value={shadowCall?.model ?? ""}
            options={[{ value: "", label: "—" }, ...models.map(m => ({ value: m.id, label: `${m.provider}/${m.id}` }))]}
            onChange={v => { onPatchShadowCall({ model: v }); onSaveShadowCall({ model: v }); }}
            disabled={!shadowCall || shadowCallSaving || !shadowCall?.enabled} label={t("dash.shadowCallModel")} />
        </div>
      </div>
    </div>
  );
}

function ProvidersTable({ providers, t }: { providers: ProviderInfo[]; t: (key: TKey) => string }) {
  return (
    <>
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
                  <td className="font-semibold">{p.name}</td>
                  <td><span className="chip">{p.adapter}</span></td>
                  <td className="muted mono text-label">{p.baseUrl}</td>
                  <td className="muted">{p.defaultModel ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

function ModelsGrid({ grouped, modelsLoading, modelsCount, t }: {
  grouped: [string, ModelInfo[]][];
  modelsLoading: boolean;
  modelsCount: number;
  t: (key: TKey) => string;
}) {
  return (
    <>
      <div className="h-section">
        {t("dash.availableModels")} <span className="count">{modelsCount}</span>
        {modelsLoading && <span className="spin" style={{ marginLeft: 4 }} />}
      </div>
      {modelsCount === 0 && !modelsLoading ? (
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
    </>
  );
}

function EffortCapPanel({
  apiBase, effortCapUi, effortCapHelpOpen, dispatchEffortCap, setEffortCapHelpOpen, t,
}: {
  apiBase: string;
  effortCapUi: EffortCapUiState;
  effortCapHelpOpen: boolean;
  dispatchEffortCap: Dispatch<EffortCapUiAction>;
  setEffortCapHelpOpen: Dispatch<SetStateAction<boolean>>;
  t: (key: TKey) => string;
}) {
  const helpDialogRef = useModalDialog(effortCapHelpOpen);
  const saveCap = async (patch: { effortCap?: string | null; subagentEffortCap?: string | null }) => {
    if (effortCapUi.saving) return;
    dispatchEffortCap({ type: "setSaving", saving: true });
    try {
      const res = await fetch(`${apiBase}/api/effort-caps`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      if (res.ok) {
        const data = await res.json() as { ok: boolean; effortCap?: string | null; subagentEffortCap?: string | null };
        dispatchEffortCap({ type: "setCaps", effortCap: data.effortCap ?? "", subagentEffortCap: data.subagentEffortCap ?? "" });
      }
    } catch { /* ignore */ }
    finally { dispatchEffortCap({ type: "setSaving", saving: false }); }
  };

  return (
    <div className="panel" style={{ marginBottom: 24 }}>
      <div className="injection-head">
        <span className="injection-label" style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
          {t("dash.effortCapLabel")}
          <span className="help-popup-anchor">
            <button
              type="button"
              className="btn btn-ghost btn-sm help-popup-trigger"
              onClick={() => setEffortCapHelpOpen(open => !open)}
              aria-label={t("dash.effortCapLabel")}
              aria-expanded={effortCapHelpOpen}
              aria-haspopup="dialog"
            >
              <IconInfo width={13} height={13} aria-hidden="true" />
            </button>
            {effortCapHelpOpen && (
              <dialog
                ref={helpDialogRef}
                className="help-popup text-control font-regular leading-body"
                aria-label={t("dash.effortCapLabel")}
                onCancel={e => { e.preventDefault(); setEffortCapHelpOpen(false); }}
              >
                <button
                  type="button"
                  className="btn btn-ghost btn-icon help-popup-close"
                  onClick={() => setEffortCapHelpOpen(false)}
                  aria-label={t("common.close")}
                >
                  <IconX width={14} height={14} />
                </button>
                <div className="help-popup-body">{t("dash.effortCapHelp")}</div>
              </dialog>
            )}
          </span>
        </span>
        <Select
          value={effortCapUi.effortCap}
          options={[{ value: "", label: t("dash.effortCapNone") }, ...EFFORT_CAP_LEVELS.map(e => ({ value: e, label: e }))]}
          onChange={v => { void saveCap({ effortCap: v || null }); }}
          disabled={effortCapUi.saving}
          label={t("dash.effortCapLabel")}
        />
        <Select
          value={effortCapUi.subagentEffortCap}
          options={[{ value: "", label: t("dash.effortCapNone") }, ...EFFORT_CAP_LEVELS.map(e => ({ value: e, label: e }))]}
          onChange={v => { void saveCap({ subagentEffortCap: v || null }); }}
          disabled={effortCapUi.saving}
          label={t("dash.subagentEffortCapLabel")}
        />
      </div>
    </div>
  );
}

function InjectionPanel({
  apiBase, injectionUi, dispatchInjection, t,
}: {
  apiBase: string;
  injectionUi: InjectionUiState;
  dispatchInjection: Dispatch<InjectionUiAction>;
  t: (key: TKey) => string;
}) {
  const saveInjection = async (model: string | null, effort: string | null) => {
    if (injectionUi.saving) return;
    dispatchInjection({ type: "setSaving", saving: true });
    try {
      const res = await fetch(`${apiBase}/api/injection-model`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model, effort }),
      });
      if (res.ok) {
        const data = await res.json() as { model?: string | null; effort?: string | null };
        dispatchInjection({ type: "setModel", model: data.model ?? "", effort: data.effort ?? "" });
      }
    } catch { /* ignore */ }
    finally { dispatchInjection({ type: "setSaving", saving: false }); }
  };

  return (
    <div className="panel" style={{ marginBottom: 24 }}>
      <div className="injection-head">
        <span className="injection-label">{t("dash.injectionLabel")}</span>
        <Select
          value={injectionUi.model}
          options={[
            { value: "", label: t("dash.injectionNone") },
            ...injectionUi.available.map(m => ({ value: m.namespaced, label: `${m.provider} / ${m.model}` })),
          ]}
          onChange={v => { void saveInjection(v || null, injectionUi.effort || null); }}
          disabled={injectionUi.saving}
          label={t("dash.injectionLabel")}
        />
        {injectionUi.model && injectionUi.efforts.length > 0 && (
          <Select
            value={injectionUi.effort}
            options={[
              { value: "", label: t("dash.injectionEffortNone") },
              ...injectionUi.efforts.map(e => ({ value: e, label: e })),
            ]}
            onChange={v => { void saveInjection(injectionUi.model || null, v || null); }}
            disabled={injectionUi.saving}
            label={t("dash.injectionEffortLabel")}
          />
        )}
        {injectionUi.model && <span className="badge badge-green text-micro">{t("dash.injectionActive")}</span>}
      </div>
      <div className="muted text-control" style={{ marginTop: 6 }}>{t("dash.injectionHint")}</div>
    </div>
  );
}

function UpdateDialog({
  open, updateUi, t, onClose, onChangeChannel, onRetry, onToggleRestart, onRunUpdate,
}: {
  open: boolean;
  updateUi: UpdateUiState;
  t: (key: TKey, vars?: Record<string, string | number>) => string;
  onClose: () => void;
  onChangeChannel: (channel: UpdateChannel) => void;
  onRetry: () => void;
  onToggleRestart: () => void;
  onRunUpdate: () => void;
}) {
  const dialogRef = useModalDialog(open);
  if (!open) return null;
  return (
    <dialog
      ref={dialogRef}
      className="modal-overlay"
      aria-labelledby="update-title"
      onCancel={e => { e.preventDefault(); onClose(); }}
    >
      <div className="modal-card">
        <div className="modal-head">
          <h3 id="update-title">{t("dash.updateTitle")}</h3>
          <button type="button" className="btn btn-ghost btn-icon" onClick={onClose} aria-label={t("common.cancel")}>
            <IconX />
          </button>
        </div>
        <div className="modal-desc">{t("dash.updateDesc")}</div>
        <div className="update-row">
          <label className="field-label" htmlFor="update-channel">{t("dash.updateChannel")}</label>
          <Select
            value={updateUi.channel}
            options={[{ value: "latest", label: "latest" }, { value: "preview", label: "preview" }]}
            onChange={v => onChangeChannel(v as UpdateChannel)}
            disabled={updateUi.loading}
            label={t("dash.updateChannel")}
          />
        </div>
        {updateUi.loading && <EmptyState className="update-empty" icon={<span className="spin" />} title={t("dash.updateChecking")} />}
        {updateUi.error && (
          <div className="notice notice-err" role="status"><IconAlert /><span>{updateUi.error}</span></div>
        )}
        {updateUi.check && !updateUi.loading && (
          <div className="update-box">
            <div className="spread">
              <div>
                <div className="muted text-label">{t("dash.updateInstalled")}</div>
                <div className="mono">{updateUi.check.currentVersion}</div>
              </div>
              <div>
                <div className="muted text-label">{t("dash.updateLatest")}</div>
                <div className="mono">{updateUi.check.latestVersion ?? "—"}</div>
              </div>
              <span className={`badge ${updateUi.check.updateAvailable ? "badge-green" : "badge-muted"}`}>
                {updateUi.check.updateAvailable ? t("dash.updateAvailable") : t("dash.updateCurrent")}
              </span>
            </div>
            <div className="muted update-command">{t("dash.updateCommand")} <code className="chip">{updateUi.check.command}</code></div>
            {updateUi.check.reason === "source_checkout" && (
              <div className="notice-warn" role="status"><IconAlert /> {t("dash.updateSource")}</div>
            )}
            {updateUi.check.reason === "latest_unavailable" && (
              <div className="notice-warn" role="status">
                <IconAlert /> {t("dash.updateUnavailable")}
                <button type="button" className="btn btn-ghost btn-sm" disabled={updateUi.loading} onClick={onRetry} style={{ marginLeft: 12 }}>
                  <IconRefresh /> {t("dash.updateRetry")}
                </button>
              </div>
            )}
            {!updateUi.check.canUpdate && updateUi.check.reason !== "latest_unavailable" && updateUi.check.reason !== "source_checkout" && (
              <div className="update-recheck">
                <span className="muted update-recheck-reason">
                  {t("dash.updateCannotAuto", { reason: updateReasonLabel(updateUi.check.reason, t) })}
                </span>
                <button type="button" className="btn btn-ghost btn-sm" disabled={updateUi.loading} onClick={onRetry}>
                  <IconRefresh /> {updateUi.loading ? t("dash.updateChecking") : t("dash.updateRecheck")}
                </button>
              </div>
            )}
            {updateUi.check.canUpdate && (
              <div className="spread update-restart">
                <div>
                  <div className="font-semibold">{t("dash.updateRestart")}</div>
                  <div className="muted text-label">{t("dash.updateRestartHint")}</div>
                </div>
                <button
                  type="button"
                  className={`switch ${updateUi.restart ? "on" : ""}`}
                  onClick={onToggleRestart}
                  aria-label={t("dash.updateRestart")}
                  aria-pressed={updateUi.restart}
                >
                  <span className="knob" />
                </button>
              </div>
            )}
          </div>
        )}
        <div className="modal-actions">
          <button type="button" className="btn btn-ghost" onClick={onClose}>{t("common.cancel")}</button>
          <button type="button" className="btn btn-primary" onClick={onRunUpdate} disabled={!updateUi.check?.canUpdate || updateUi.loading}>
            {t("dash.runUpdate")}
          </button>
        </div>
      </div>
    </dialog>
  );
}

function MaHelpDialog({ open, t, onClose }: { open: boolean; t: (key: TKey) => string; onClose: () => void }) {
  const dialogRef = useModalDialog(open);
  if (!open) return null;
  return (
    <dialog
      ref={dialogRef}
      className="modal-overlay"
      aria-label={t("dash.multiAgent")}
      onCancel={e => { e.preventDefault(); onClose(); }}
    >
      <div className="modal-card">
        <div className="modal-head">
          <h3>{t("dash.multiAgent")}</h3>
          <button type="button" className="btn btn-ghost btn-icon" onClick={onClose} aria-label={t("common.close")}><IconX /></button>
        </div>
        <div className="modal-desc leading-relaxed" style={{ whiteSpace: "pre-line" }}>
          {t("models.v2Help")}
        </div>
        <div style={{ marginTop: 12 }}>
          <a className="text-control" href="https://lidge-jun.github.io/opencodex/guides/sub-agent-surface/" target="_blank" rel="noreferrer" style={{ color: "var(--accent)" }}>
            {t("models.v2DocsLink")}
          </a>
        </div>
        <div className="modal-actions">
          <button type="button" className="btn btn-primary" onClick={onClose}>{t("common.ok")}</button>
        </div>
      </div>
    </dialog>
  );
}
